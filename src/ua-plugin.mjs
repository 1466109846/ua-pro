import { createHash, randomUUID } from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUAStore } from './ua-store.mjs'
import { createUAService } from './ua-service.mjs'
import { createUAModelCatalog } from './ua-model-catalog.mjs'
import { createUATransport, protocolForModel, SDK_BY_PROTOCOL, apiBase, discoverUA, siteRoot, modelQueryScope } from './ua-runtime.mjs'
import { startSetupServer } from './setup-server.mjs'
import { createProfileStore } from './store.mjs'
import { createAccountManager } from './accounts.mjs'
import { ensureCheckinScheduler } from './scheduler.mjs'
import { isDeepStrictEqual } from 'node:util'
import { createUAUsage } from './ua-usage.mjs'
import { createKeyUsage } from './key-usage.mjs'
import { resolveProfilePath } from './runtime.mjs'

const PREFIX = 'ua-pro:connection:'
const observed = new Map()
const stores = new Map()
const modelRoutes = new Map()
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
export function uaStorePath(options = {}, env = process.env) {
  const path = options.uaFile ?? env.UA_PRO_FILE ?? fileURLToPath(new URL('../runtime/ua-pro.json', import.meta.url))
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('UA PRO 配置路径必须为绝对路径')
  return path
}
function sharedStore(path) {
  if (!stores.has(path)) stores.set(path, createUAStore(path))
  return stores.get(path)
}
function providerOf(connection) { return connection.independent && connection.siteId ? `ua-pro-${connection.siteId}` : 'ua-pro' }
function safeModel(model) { return typeof model === 'string' && model && !/[\x00-\x1f\x7f]/.test(model) }

export async function createUAPlugin(input = {}, options = {}, dependencies = {}, siteId = '') {
  const allowed = ['uaFile', 'profileFile', 'accountBindings', 'baseURL', 'userAgent', 'headers', 'models', 'parameters', 'searches']
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.includes(key))) throw new Error('UA PRO 插件选项无效')
  const path = uaStorePath(options)
  const store = dependencies.uaStore ?? sharedStore(path)
  await store.initialize()
  const id = siteId ? `ua-pro-${siteId}` : 'ua-pro'
  const legacyStore = dependencies.legacyStore ?? createProfileStore(resolveProfilePath({ configPath: options.profileFile }))
  const accountManager = dependencies.accountManager ?? createAccountManager({ path: join(dirname(path), 'accounts.json') })
  if (input.magpie && !siteId) (dependencies.startScheduler ?? ensureCheckinScheduler)({ accountManager, stateDirectory: join(dirname(path), 'schedule-claims'), onError: () => {} })
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const modelCatalog = dependencies.modelCatalog ?? createUAModelCatalog(store.path)
  const contexts = new Map()
  const contextHeader = `x-magpie-ua-pro-context-${randomUUID()}`
  const auths = async () => {
    if (dependencies.readHostAuth) return dependencies.readHostAuth()
    if (!input.directory) return {}
    try { const value = JSON.parse(await readFile(join(input.directory, 'plugin-auth.json'), 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('无法读取宿主账号，停止操作以保护已有凭据') }
  }
  const readAuth = async (provider, account) => (await auths())[account || provider]
  const register = async connection => {
    if (!input.client?.auth?.set || connection.auth?.source === 'host') return
    const provider = providerOf(connection)
    const account = `${provider}#${digest(connection.id)}`
    const existing = (await auths())[account]
    const key = PREFIX + connection.id
    if (existing && existing.key !== key) throw new Error('目标宿主账号已被其他凭据占用')
    if (existing) return
    const response = await input.client.auth.set({ path: { id: account }, body: { type: 'api', key, accountId: connection.name, metadata: { uaConnectionId: connection.id } } })
    if (response?.data !== true) throw new Error('宿主未确认连接注册，请重载并核对')
  }
  const routeKey = scope => `${store.path}:${scope}`
  const modelFetchFor = scope => {
    const key = routeKey(scope)
    const saved = modelRoutes.get(key)
    if (saved && Date.now() - saved.at <= 15 * 60 * 1000) return saved.fetch
    modelRoutes.delete(key)
    return fetchImpl
  }
  const service = createUAService({ store, legacyStore, accountManager, fetchImpl, readAuth, modelCatalog, modelFetchFor, onConnectionSaved: input.client?.auth?.set ? register : undefined,
    runtime: () => ({ mode: input.magpie ? 'host' : 'standalone', observed: [...observed.values()].filter(item => item.provider === id) }) })
  let declared = {}
  const getNativeConnection = async (auth, provider = {}) => {
    if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) return null
    const snapshot = await store.snapshot({ secrets: true })
    const selected = auth.metadata?.uaConnectionId ?? (auth.key.startsWith(PREFIX) ? auth.key.slice(PREFIX.length) : null)
    if (selected) {
      const connection = snapshot.connections.find(item => item.id === selected)
      if (!connection || providerOf(connection) !== id || connection.enabled === false) throw new Error('此连接已移除、停用或属于其他站点')
      return connection
    }
    const configuredSite = siteId ? snapshot.connections.find(item => item.siteId === siteId && item.independent) : null
    const baseURL = configuredSite?.baseURL ?? auth.metadata?.baseURL ?? auth.metadata?.endpoint ?? provider.options?.baseURL ?? provider.api ?? declared.api ?? options.baseURL
    if (!baseURL) throw new Error('请为当前账号填写上游 Base URL')
    siteRoot(baseURL)
    const connectionId = `host.${digest([id, baseURL, auth.key])}`
    let connection = snapshot.connections.find(item => item.id === connectionId)
    if (!connection) {
      const all = await auths()
      const scope = input.magpie?.account?.(id)
      const matches = Object.entries(all).filter(([slot, saved]) => (slot === id || slot.startsWith(id + '#')) && saved.type === 'api' && saved.key === auth.key
        && (saved.metadata?.baseURL ?? saved.metadata?.endpoint ?? baseURL) === (auth.metadata?.baseURL ?? auth.metadata?.endpoint ?? baseURL))
      const account = scope && all[scope]?.key === auth.key ? scope : matches.length === 1 ? matches[0][0] : matches.length === 0 && !Object.keys(all).length ? id : null
      if (!account) throw new Error('无法唯一识别当前宿主账号，请从明确的账号入口重新打开')
      const result = await store.saveConnection({ connection: { id: connectionId, name: auth.accountId ?? `${id} 账号`, enabled: true, siteId, independent: Boolean(siteId),
        baseURL, protocol: auth.metadata?.protocol ?? 'auto', apiPaths: {}, modelProtocols: {}, models: [],
        auth: { source: 'host', mode: 'api-key', provider: id, account, key: '', value: '' }, modelBindings: {} } })
      connection = result.connection
    }
    return connection
  }
  const executeWithAuth = (auth, connection, fallback = readAuth) => async (provider, account) => connection.auth.source === 'host' && connection.auth.provider === provider && connection.auth.account === account
    ? { ...auth, metadata: { baseURL: connection.baseURL, ...auth.metadata } } : fallback(provider, account)
  const management = async () => {
    const account = input.magpie?.account?.(id)
    const originalAuth = account ? (await auths())[account] : undefined
    const hostBinding = originalAuth ? { account, selected: originalAuth.metadata?.newApiAccountId ?? null, changed: false } : undefined
    const session = await (dependencies.startSetup ?? startSetupServer)({ store: legacyStore, accountManager, hostBinding, uaService: service, finishOnSave: false })
    return { url: new URL('pro', session.url).href, method: 'auto', instructions: '在 UA PRO 中管理连接和模板；保存版本与应用连接分开。完成后关闭页面返回 Magpie。',
      async callback(_code, { signal } = {}) {
        let stop
        try {
          const result = await (signal ? Promise.race([session.finished, new Promise(resolve => { stop = () => resolve({ status: 'cancelled' }); if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }) })]) : session.finished)
          if (result.status === 'timeout') return { type: 'failed', error: '配置会话已超时；已保存的更改保留' }
          if (signal?.aborted) return { type: 'failed', error: '配置已取消；此前保存的更改保留' }
          if (hostBinding?.changed) {
            const current = (await auths())[account]
            if (!isDeepStrictEqual(current, originalAuth)) return { type: 'failed', error: '宿主账号已改变，余额绑定未写入；请重新打开核对' }
            const updated = { ...current, metadata: { ...current.metadata, newApiAccountId: hostBinding.selected ?? '' } }
            const written = await input.client?.auth?.set?.({ path: { id: account }, body: updated })
            if (written?.data !== true || !isDeepStrictEqual((await auths())[account], updated)) return { type: 'failed', error: '宿主未确认余额绑定保存' }
          }
          return { type: 'success' }
        } finally { if (stop) signal.removeEventListener('abort', stop); await session.close() }
      } }
  }
  const resolveAccount = async auth => {
    const matches = Object.entries(await auths()).filter(([slot, saved]) => (slot === id || slot.startsWith(id + '#')) && isDeepStrictEqual(saved, auth))
    return matches.length === 1 ? matches[0][0] : null
  }
  const usageHooks = createUAUsage({ providerId: id, input, options, accountManager, getConnection: getNativeConnection, resolveAccount,
    queryKeyUsage: (connection, auth) => createKeyUsage({ fetchImpl, readAuth: executeWithAuth(auth, connection) })(connection) })
  return {
    async config(config) {
      const snapshot = await store.snapshot({ secrets: true })
      for (const connection of snapshot.connections.filter(item => item.enabled && providerOf(item) === id)) await register(connection)
      config.provider ??= {}
      config.provider[id] ??= { name: siteId ? `UA PRO · ${siteId}` : 'UA PRO', npm: '@ai-sdk/openai-compatible', models: {} }
      declared = config.provider[id]
    },
    auth: {
      provider: id,
      methods: [{ type: 'api', label: '连接上游 API key', placeholder: '此上游的模型 API key', prompts: [{ type: 'text', key: 'baseURL', message: '上游 Base URL', placeholder: 'https://your-service.example', validate(value) { try { siteRoot(value); return undefined } catch { return '请填写有效的 HTTPS Base URL（本机可用 HTTP）' } } }] },
        { type: 'oauth', label: '打开 UA PRO 管理', authorize: management }],
      async loader(getAuth, provider) {
        const auth = await getAuth()
        const connection = await getNativeConnection(auth, provider)
        if (!connection) return {}
        return { baseURL: siteRoot(connection.baseURL) + '/v1', apiKey: '',
          fetch: async (url, init = {}) => {
            const current = await getAuth()
            const bound = await getNativeConnection(current, provider)
            if (!bound) throw new Error('当前账号未登录')
            const headers = new Headers(init.headers)
            const token = headers.get(contextHeader)
            const host = contexts.get(token)?.value ?? {}
            contexts.delete(token)
            headers.delete(contextHeader)
            const transport = createUATransport({ getSnapshot: () => store.snapshot({ secrets: true }), getConnection: snapshot => snapshot.connections.find(item => item.id === bound.id),
              readAuth: executeWithAuth(current, bound), fetchImpl, getContext: () => host,
              observe: value => { observed.set(`${id}:${bound.id}`, { ...value, provider: id, at: new Date().toISOString() }); if (observed.size > 256) observed.delete(observed.keys().next().value) } })
            return transport(url, { ...init, headers })
          } }
      },
      usage: usageHooks.usage,
      checkin: usageHooks.checkin,
    },
    provider: { id, async models(provider = {}, { auth } = {}) {
      const connection = await getNativeConnection(auth, provider)
      if (!connection) return provider.models ?? {}
      const queryAuth = executeWithAuth(auth, connection)
      if (input.magpie) {
        const key = routeKey(await modelQueryScope(connection, queryAuth))
        // Keep the host's account proxy context for management callbacks. Never
        // bind credentials here; queryUAModels resolves them for each request.
        modelRoutes.delete(key)
        modelRoutes.set(key, { at: Date.now(), fetch: AsyncResource.bind((url, init) => fetchImpl(url, init)) })
        if (modelRoutes.size > 128) modelRoutes.delete(modelRoutes.keys().next().value)
      }
      const list = await discoverUA(connection, { fetchImpl, readAuth: queryAuth, catalog: modelCatalog, source: 'host' })
      return Object.fromEntries(list.filter(item => safeModel(item.id)).map(item => {
        const protocol = protocolForModel(connection, item.id)
        const existing = provider.models?.[item.id] ?? {}
        return [item.id, { ...existing, ...item, api: { ...(existing.api ?? {}), id: existing.api?.id ?? item.id, url: apiBase(connection, protocol), npm: SDK_BY_PROTOCOL[protocol] },
          provider: { api: apiBase(connection, protocol), npm: SDK_BY_PROTOCOL[protocol] } }]
      }))
    } },
    async 'chat.headers'(context, output) {
      if (context?.model?.providerID !== id && context?.provider?.info?.id !== id) return
      const now = Date.now()
      for (const [key, item] of contexts) if (now - item.at > 60000) contexts.delete(key)
      if (contexts.size >= 2048) contexts.delete(contexts.keys().next().value)
      const token = randomUUID()
      contexts.set(token, { at: now, value: { sessionID: context.sessionID, model: context.model?.id ?? context.model?.api?.id } })
      output.headers[contextHeader] = token
    },
  }
}

export async function createUASite(input, options, slot) {
  const store = sharedStore(uaStorePath(options))
  await store.initialize()
  const state = await store.snapshot()
  const ids = [...new Set(state.connections.filter(item => item.independent && item.siteId).map(item => item.siteId))]
  const id = ids[slot]
  return id ? createUAPlugin(input, options, { uaStore: store }, id) : {}
}
