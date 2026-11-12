import { createHash, randomUUID } from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { uaStorePath, prepareUAStorage } from './ua-storage.mjs'
export { uaStorePath, prepareUAStorage } from './ua-storage.mjs'
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
const loadedProviders = new Map()
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
const authFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function sharedStore(path) {
  if (!stores.has(path)) stores.set(path, createUAStore(path))
  return stores.get(path)
}
function providerOf(connection) { return connection.independent && connection.siteId ? `ua-pro-${connection.siteId}` : 'ua-pro' }
function safeModel(model) { return typeof model === 'string' && model && !/[\x00-\x1f\x7f]/.test(model) }

export async function createUAPlugin(input = {}, options = {}, dependencies = {}, siteId = '') {
  const allowed = ['uaFile', 'profileFile', 'accountBindings', 'baseURL', 'userAgent', 'headers', 'models', 'parameters', 'searches']
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.includes(key))) throw new Error('UA PRO 插件选项无效')
  const storage = dependencies.uaStore ? { path: dependencies.uaStore.path, imported: false } : await prepareUAStorage({ input, options })
  const path = storage.path
  const store = dependencies.uaStore ?? sharedStore(path)
  const hostAuthSet = input.client?.auth?.set ? AsyncResource.bind(input.client.auth.set.bind(input.client.auth)) : null
  const hostAuthRemove = input.client?.auth?.remove ? AsyncResource.bind(input.client.auth.remove.bind(input.client.auth)) : null
  await store.initialize()
  const id = siteId ? `ua-pro-${siteId}` : 'ua-pro'
  if (!loadedProviders.has(store.path)) loadedProviders.set(store.path, new Set())
  loadedProviders.get(store.path).add(id)
  const legacyStore = dependencies.legacyStore ?? createProfileStore(resolveProfilePath({ configPath: options.profileFile ?? (input.directory ? join(dirname(path), 'profile.json') : undefined) }))
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
  const connectionStatus = async (connection, all = {}) => {
    const provider = providerOf(connection)
    const account = connection.auth?.source === 'host' ? connection.auth.account : `${provider}#${digest(connection.id)}`
    const base = { connectionId: connection.id, provider, account, name: connection.name }
    if (!connection.enabled) return { ...base, status: 'disabled' }
    if (!loadedProviders.get(store.path)?.has(provider)) return { ...base, status: 'reload-required', message: '新增独立站点需要在 Magpie 重载此插件后载入' }
    if (connection.auth?.source === 'host') {
      const saved = all[account]
      const endpoint = saved?.metadata?.baseURL ?? saved?.metadata?.endpoint
      if (saved?.type !== 'api' || !saved.key || !endpoint || siteRoot(endpoint) !== siteRoot(connection.baseURL)) return { ...base, status: 'unregistered', message: '该连接引用的宿主账号尚未确认，请重新打开账号配置' }
      return { ...base, status: 'registered' }
    }
    const saved = all[account]
    if (saved && (saved.type !== 'api' || saved.key !== PREFIX + connection.id)) return { ...base, status: 'conflict', message: '目标宿主账号已被其他凭据占用，未覆盖' }
    return { ...base, status: saved ? 'registered' : 'unregistered' }
  }
  const register = async (connection, { syncBinding = false } = {}) => {
    const all = await auths()
    const current = await connectionStatus(connection, all)
    if (current.status === 'conflict') throw new Error(current.message)
    if (['disabled', 'reload-required'].includes(current.status) || connection.auth?.source === 'host' && !syncBinding) return current
    if (!hostAuthSet) return { ...current, status: 'host-unavailable', message: '请从 Magpie 打开管理页后同步连接' }
    const existing = all[current.account]
    const metadata = { ...existing?.metadata }
    if (syncBinding && typeof connection.newApiAccountId === 'string') metadata.newApiAccountId = connection.newApiAccountId
    let body
    if (connection.auth?.source === 'host') {
      if (current.status !== 'registered') return current
      body = { ...existing, accountId: connection.name, metadata }
    } else {
      body = { ...existing, type: 'api', key: PREFIX + connection.id, accountId: connection.name,
        metadata: { ...metadata, uaConnectionId: connection.id, baseURL: connection.baseURL } }
    }
    if (isDeepStrictEqual(existing, body)) return current
    const response = await hostAuthSet({ path: { id: current.account }, body })
    const confirmed = (await auths())[current.account]
    if (response?.data !== true || !isDeepStrictEqual(confirmed, body)) throw new Error('宿主未确认连接注册，请重载并核对')
    return { ...current, status: 'registered' }
  }
  const syncConnections = async () => {
    const snapshot = await store.snapshot()
    const connections = []
    for (const connection of snapshot.connections) {
      try { connections.push(await register(connection)) }
      catch { connections.push({ connectionId: connection.id, provider: providerOf(connection), status: 'failed', message: '宿主同步未完成；配置和凭据保留，请重载插件后核对' }) }
    }
    return { connections, message: connections.some(item => item.status === 'reload-required') ? '已同步可用账号；新增独立站点需要重载 UA PRO 插件' : '宿主同步结果已核对' }
  }
  const removeAuthReference = async (account, original) => {
    if (!hostAuthRemove) throw new Error('宿主不支持账号移除；连接和凭据保留')
    const current = (await auths())[account]
    if (!isDeepStrictEqual(current, original)) throw new Error('宿主账号已变化，未移除；请重新读取')
    const response = await hostAuthRemove({ path: { id: account } })
    if (response?.data !== true || (await auths())[account] !== undefined) throw new Error('宿主未确认账号移除；本地连接和凭据保留')
  }
  const unregister = async connection => {
    const provider = providerOf(connection)
    const all = await auths()
    const marker = PREFIX + connection.id
    const matches = Object.entries(all).filter(([slot, auth]) => (slot === provider || slot.startsWith(provider + '#')) &&
      (connection.auth.source === 'host' ? slot === connection.auth.account : auth.type === 'api' && auth.key === marker))
    for (const [slot, auth] of matches) {
      if (connection.auth.source !== 'host' && auth.metadata?.uaConnectionId && auth.metadata.uaConnectionId !== connection.id) throw new Error('宿主账号映射冲突，未移除')
      await removeAuthReference(slot, auth)
    }
  }
  const removeHostAccount = async data => {
    const account = data.account
    if (data.confirmRemoval !== true || typeof account !== 'string' || typeof data.expectedFingerprint !== 'string') throw new Error('移除失效宿主账号需要明确确认并重新核对状态')
    if (!['ua-pro', ...[...loadedProviders.get(store.path) ?? []]].some(provider => account === provider || account.startsWith(provider + '#'))) throw new Error('此账号不属于当前 UA PRO 供应商')
    const current = (await auths())[account]
    if (!current || authFingerprint(current) !== data.expectedFingerprint) throw new Error('宿主账号已变化，未移除；请重新读取')
    if (current.type !== 'api' || typeof current.key !== 'string' || !current.key.startsWith(PREFIX)) throw new Error('只允许移除本插件的失效连接标记，不移除原生凭据')
    const selected = current.key.slice(PREFIX.length)
    const snapshot = await store.snapshot()
    if (snapshot.connections.some(connection => connection.id === selected && connection.enabled && account.split('#')[0] === providerOf(connection))) throw new Error('此宿主账号仍有可用连接，不能作为失效引用移除')
    await removeAuthReference(account, current)
    return { removed: true, account, message: '失效宿主账号引用已移除；其他连接、模板和站点账号保留' }
  }
  const routeKey = scope => `${store.path}:${scope}`
  const modelFetchFor = scope => {
    const key = routeKey(scope)
    const saved = modelRoutes.get(key)
    if (saved && Date.now() - saved.at <= 15 * 60 * 1000) return saved.fetch
    modelRoutes.delete(key)
    return fetchImpl
  }
  const service = createUAService({ store, legacyStore, accountManager, fetchImpl, readAuth, modelCatalog, modelFetchFor, prepareState: () => prepareState(), onConnectionSaved: input.client?.auth?.set ? connection => register(connection, { syncBinding: true }) : undefined,
    onConnectionRemoving: input.magpie ? unregister : undefined,
    removeHostAccount: input.client?.auth?.remove ? removeHostAccount : undefined,
    syncConnections: input.client?.auth?.set ? syncConnections : undefined,
    runtime: async snapshot => {
      const all = await auths()
      return { mode: input.magpie ? 'host' : 'standalone', storagePath: store.path, storage,
        hostAccounts, hostAccountErrors,
        connections: await Promise.all((snapshot?.connections ?? []).map(connection => connectionStatus(connection, all))),
        observed: [...observed.values()].filter(item => item.provider === id) }
    } })
  let declared = {}
  const getNativeConnection = async (auth, provider = {}, accountHint) => {
    if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) return null
    const snapshot = await store.snapshot({ secrets: true })
    const marker = auth.key.startsWith(PREFIX) ? auth.key.slice(PREFIX.length) : null
    const selected = auth.metadata?.uaConnectionId ?? marker
    if (marker && selected !== marker) throw new Error('宿主账号引用与连接标记不一致，请核对账号')
    if (selected) {
      const connection = snapshot.connections.find(item => item.id === selected)
      if (!connection || providerOf(connection) !== id || connection.enabled === false) throw new Error('此连接已移除、停用或属于其他站点')
      return connection
    }
    const configuredSite = siteId ? snapshot.connections.find(item => item.siteId === siteId && item.independent) : null
    const configuredBase = configuredSite?.baseURL ?? auth.metadata?.baseURL ?? auth.metadata?.endpoint ?? provider.options?.baseURL ?? provider.api ?? declared.api ?? options.baseURL
    if (!configuredBase) throw new Error('请为当前账号填写上游 Base URL')
    siteRoot(configuredBase)
    const baseURL = new URL(configuredBase).href.replace(/\/+$/, '')
    const all = await auths()
    const owned = slot => typeof slot === 'string' && (slot === id || slot.startsWith(id + '#'))
    const scope = accountHint ?? input.magpie?.account?.(id)
    const matches = Object.entries(all).filter(([slot, saved]) => owned(slot) && isDeepStrictEqual(saved, auth))
    const account = owned(scope) && isDeepStrictEqual(all[scope], auth) ? scope : matches.length === 1 ? matches[0][0] : matches.length === 0 && !Object.keys(all).length ? id : null
    if (!account) throw new Error('无法唯一识别当前宿主账号，请从明确的账号入口重新打开')
    let connection = snapshot.connections.find(item => providerOf(item) === id && item.auth.source === 'host' && item.auth.account === account && item.baseURL === baseURL)
    if (!connection) {
      const connectionId = `host.${digest([id, account, baseURL])}`
      const existing = snapshot.connections.find(item => item.id === connectionId)
      if (existing) throw new Error('宿主连接身份冲突，未覆盖已有配置')
      const result = await store.saveConnection({ connection: { id: connectionId, name: auth.accountId ?? `${id} 账号`, enabled: true, siteId, independent: Boolean(siteId),
        baseURL, protocol: auth.metadata?.protocol ?? 'auto', apiPaths: {}, modelProtocols: {}, models: [],
        auth: { source: 'host', mode: 'api-key', provider: id, account, key: '', value: '' }, modelBindings: {},
        ...(typeof auth.metadata?.newApiAccountId === 'string' ? { newApiAccountId: auth.metadata.newApiAccountId } : {}) } })
      connection = result.connection
    }
    if (connection.enabled === false) throw new Error('此连接已停用，请在管理页明确启用后再使用')
    return connection
  }
  let hostAccounts = [], hostAccountErrors = []
  const prepareState = async () => {
    const all = await auths()
    const next = [], errors = []
    for (const [account, auth] of Object.entries(all).filter(([slot]) => slot === id || slot.startsWith(id + '#'))) {
      const entry = { account, name: auth.accountId || `${id} 账号`, fingerprint: authFingerprint(auth), removable: false }
      try {
        const connection = await getNativeConnection(auth, declared, account)
        next.push({ ...entry, ...(connection ? { connectionId: connection.id, status: 'mapped' } : { status: 'unsupported' }) })
      } catch {
        next.push({ ...entry, status: 'unresolved', removable: auth.type === 'api' && typeof auth.key === 'string' && auth.key.startsWith(PREFIX), message: '宿主账号缺少可用的连接配置；原凭据未改动，请核对存储路径或重新关联' })
        errors.push(account)
      }
    }
    hostAccounts = next
    hostAccountErrors = errors
  }
  const executeWithAuth = (auth, connection, fallback = readAuth) => async (provider, account) => connection.auth.source === 'host' && connection.auth.provider === provider && connection.auth.account === account
    ? { ...auth, metadata: { baseURL: connection.baseURL, ...auth.metadata } } : fallback(provider, account)
  const management = async () => {
    await prepareState()
    const all = await auths()
    const scope = input.magpie?.account?.(id)
    const owned = Object.keys(all).filter(slot => slot === id || slot.startsWith(id + '#'))
    const account = typeof scope === 'string' && (scope === id || scope.startsWith(id + '#')) ? scope : owned.length === 1 ? owned[0] : null
    const originalAuth = account ? all[account] : undefined
    const connection = originalAuth ? await getNativeConnection(originalAuth, declared, account).catch(() => null) : null
    const hostBinding = originalAuth && connection ? { account, selected: originalAuth.metadata?.newApiAccountId ?? connection.newApiAccountId ?? null, changed: false } : undefined
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
            const bound = (await store.snapshot()).connections.find(item => item.id === connection.id)
            if (!bound) return { type: 'failed', error: '连接已移除，余额绑定未写入' }
            try {
              const saved = await service.execute('connections/save', { connection: { ...bound, newApiAccountId: hostBinding.selected ?? '' }, expectedRevision: bound.revision })
              if (saved.registration !== 'registered') return { type: 'failed', error: '绑定已保存在连接中，宿主尚未确认；请重新打开管理页同步' }
            } catch { return { type: 'failed', error: '余额与签到绑定未保存，请重新打开并核对站点与账号' } }
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
      config.provider ??= {}
      config.provider[id] ??= { name: siteId ? `UA PRO · ${siteId}` : 'UA PRO', npm: '@ai-sdk/openai-compatible', models: {} }
      declared = config.provider[id]
      const snapshot = await store.snapshot({ secrets: true })
      for (const connection of snapshot.connections.filter(item => item.enabled && providerOf(item) === id)) {
        try { await register(connection) }
        catch { /* A failed account registration must not hide the provider or other accounts. */ }
      }
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
  const storage = await prepareUAStorage({ input, options })
  const store = sharedStore(storage.path)
  await store.initialize()
  const state = await store.snapshot()
  const ids = [...new Set(state.connections.filter(item => item.independent && item.siteId).map(item => item.siteId))]
  const id = ids[slot]
  return id ? createUAPlugin(input, options, { uaStore: store }, id) : {}
}
