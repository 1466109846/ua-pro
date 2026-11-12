import { createHash } from 'node:crypto'
import { createUATestRunner } from './ua-tests.mjs'
import { validateTemplate } from './ua-transform.mjs'
import { lookupUAModels, readModelCatalog, modelQueryScope } from './ua-runtime.mjs'
import { createUAModelCatalog } from './ua-model-catalog.mjs'
import { matchesAccountSite } from '../lib/ua-protocol.mjs'
import { createKeyUsage } from './key-usage.mjs'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failure = (message, status = 400) => Object.assign(new Error(message), { status })

export function createUAService({ store, legacyStore, accountManager, readAuth, fetchImpl, modelFetchFor, modelCatalog = createUAModelCatalog(store.path), onConnectionSaved, syncConnections, runtime = () => ({ mode: 'standalone', observed: [] }) }) {
  const test = createUATestRunner({ store, readAuth, fetchImpl, modelFetchFor })
  const initialized = () => store.initialize()
  return {
    async state() {
      await initialized()
      const snapshot = await store.snapshot({ secrets: true })
      const modelCatalogs = {}
      for (const connection of snapshot.connections) {
        const entry = await readModelCatalog(connection, { catalog: modelCatalog, readAuth })
        if (entry) modelCatalogs[connection.id] = entry
        connection.auth.key = ''
        connection.auth.value = ''
      }
      const siteAccounts = accountManager ? (await accountManager.list()).accounts.map(account => ({ id: account.id, name: account.name,
        siteUrl: account.siteUrl, siteType: account.siteType ?? 'newapi', userId: account.userId, enabled: account.enabled,
        checkinEnabled: account.checkinEnabled, schedule: account.schedule })) : []
      return { ...snapshot, modelCatalogs, siteAccounts, runtime: await runtime(snapshot) }
    },
    async accountConnections() {
      await initialized()
      return (await store.snapshot()).connections.map(connection => ({ id: connection.id, name: connection.name, baseURL: connection.baseURL,
        revision: connection.revision, enabled: connection.enabled, newApiAccountId: connection.newApiAccountId ?? '' }))
    },
    async execute(action, data, { signal } = {}) {
      await initialized()
      if (action === 'templates/validate') return { template: validateTemplate(data.template) }
      if (action === 'templates/save') return store.saveTemplate(data)
      if (action === 'templates/archive') return store.archiveTemplate(data)
      if (action === 'templates/remove') return store.removeTemplate(data)
      if (action === 'connections/usage') {
        if (data.confirmNetwork !== true) throw failure('读取连接余额需要明确确认')
        const snapshot = await store.snapshot({ secrets: true })
        const connection = snapshot.connections.find(item => item.id === data.connectionId)
        if (!connection || !connection.enabled) throw failure('连接不存在或已停用', 404)
        const usageFetch = modelFetchFor ? modelFetchFor(await modelQueryScope(connection, readAuth)) : fetchImpl
        const usage = await createKeyUsage({ fetchImpl: usageFetch, readAuth })(connection)
        return { connectionId: connection.id, revision: connection.revision, usage, at: new Date().toISOString() }
      }
      if (action === 'connections/models') {
        if (data.confirmNetwork !== true) throw failure('获取模型需要明确确认')
        const connection = await store.prepareConnection(data)
        const timeout = AbortSignal.timeout(15000)
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
        try {
          const result = await lookupUAModels(connection, { readAuth, fetchImpl, modelFetchFor, signal: combined, catalog: modelCatalog, source: 'management', allowCached: true })
          signal?.throwIfAborted()
          if (!result.cached) combined.throwIfAborted()
          return { ...result, models: result.models.map(({ id, name }) => ({ id, name })), message: result.cached ? '刷新失败，显示此前发现的模型；连接尚未保存' : '模型列表已读取，连接尚未保存；未发送生成请求' }
        } catch (error) {
          if (combined.aborted) throw Object.assign(failure('获取模型已取消或超时，手填内容保留', 408), { code: signal?.aborted ? 'cancelled' : 'timeout' })
          if (error.code === 'upstream-http') throw Object.assign(failure(`${error.message}，请检查地址、协议和凭据`), { code: error.code })
          if ([400, 409].includes(error.status)) {
            if (['dns', 'connection-refused', 'connection-reset', 'timeout', 'tls', 'network'].includes(error.code)) {
              const route = (await runtime()).mode === 'host' ? '当前管理会话的代理可能与宿主账号代理不同。' : '独立工具不继承 Magpie 的账号代理；可从 Magpie 打开 UA PRO 管理后核对。'
              error.message += `。${route}`
            }
            throw error
          }
          throw failure('模型列表读取未完成，请重新打开管理页后重试', 400)
        }
      }
      if (action === 'connections/sync') {
        if (!syncConnections) throw failure('独立工具不能直接写入 Magpie；请从宿主打开 UA PRO 管理后同步', 409)
        return syncConnections()
      }
      if (action === 'connections/save') {
        if (data.connection?.newApiAccountId) {
          if (!accountManager) throw failure('站点账号管理尚未初始化', 409)
          const account = await accountManager.get(data.connection.newApiAccountId)
          if (!matchesAccountSite(data.connection.baseURL, account)) throw Object.assign(failure('余额与签到只能绑定同一站点的账号'), { fields: { newApiAccountId: '所选账号属于其他站点' } })
        }
        const result = await store.saveConnection(data)
        if (onConnectionSaved) {
          try {
            const host = await onConnectionSaved(result.connection)
            if (host?.status === 'reload-required') return { ...result, registration: 'pending-reload', activation: 'pending-reload', host, message: host.message }
            if (host && host.status !== 'registered') return { ...result, registration: 'pending-reload', activation: 'pending-reload', host, message: host.message || '连接已保存，宿主账号尚未确认，请同步或重载后核对' }
            return { ...result, registration: 'registered', activation: 'pending-runtime-observation', ...(host ? { host } : {}) }
          } catch { return { ...result, registration: 'pending-reload', activation: 'pending-reload', message: '连接已保存，宿主注册未确认，请重载插件后核对' } }
        }
        return { ...result, registration: 'pending-host-load', activation: 'pending-runtime-observation' }
      }
      if (action === 'connections/remove') return store.removeConnection(data)
      if (action === 'bindings/apply') return { ...await store.applyBinding(data), activation: 'pending-runtime-observation' }
      if (action === 'routes/apply') return { ...await store.applyModelRoute(data), activation: 'pending-reload', message: '模型上游协议和模板已保存；请在 Magpie 重新获取模型或重载插件后使用' }
      if (action === 'test') return { result: await test(data, { signal }) }
      if (action === 'migration/preview') {
        const profile = await legacyStore?.load()
        if (!profile) return { available: false, message: '没有可迁移的独立 Claude 配置；原生账号继续使用兼容入口' }
        return { available: true, fingerprint: digest(profile), connection: { name: '原 Claude 连接', baseURL: profile.upstream.baseUrl, models: profile.models, secrets: { key: Boolean(profile.upstream.apiKey), value: Boolean(profile.upstream.authorizationValue) } }, template: { name: '原 Claude 配置副本', basedOn: 'custom.claude-vscode-2316', parameters: profile.parameters }, message: '只复制为 UA PRO 新连接，不修改原配置或停用原供应商' }
      }
      if (action === 'migration/apply') {
        if (typeof data.fingerprint !== 'string') throw failure('请先预览迁移')
        const profile = await legacyStore?.load()
        if (!profile || digest(profile) !== data.fingerprint) throw failure('旧配置已改变，请重新预览', 409)
        const snapshot = await store.snapshot()
        const id = `migration.${digest({ base: profile.upstream.baseUrl, key: profile.upstream.apiKey }).slice(0, 16)}`
        if (snapshot.connections.some(connection => connection.id === id)) throw failure('此配置已经迁移，请在连接列表中核对', 409)
        const baseline = structuredClone(snapshot.templates.find(item => item.id === 'custom.claude-vscode-2316' && item.revision === 1))
        delete baseline.id
        baseline.name = '原 Claude 配置副本'
        baseline.kind = 'custom'
        baseline.basedOn = { id: 'custom.claude-vscode-2316', revision: 1 }
        baseline.body.parameters = structuredClone(profile.parameters)
        const map = { userAgent: 'user-agent', anthropicVersion: 'anthropic-version', anthropicBeta: 'anthropic-beta', contentType: 'content-type' }
        for (const [field, name] of Object.entries(map)) if (profile.headers[field]) baseline.headers.push({ name, action: 'set', value: profile.headers[field], enabled: true, when: 'always' })
        for (const extra of profile.headers.extra) baseline.headers.push({ name: extra.name, action: extra.value === null ? 'delete' : 'set', ...(extra.value === null ? {} : { value: extra.value }), enabled: extra.enabled, when: 'always' })
        const saved = await store.saveTemplate({ template: baseline })
        return this.execute('connections/save', { connection: { id, name: '原 Claude 连接', enabled: true, baseURL: profile.upstream.baseUrl,
          protocol: 'anthropic', models: profile.models, apiPaths: {}, modelProtocols: {}, siteId: '', independent: false,
          auth: { source: 'stored', mode: profile.upstream.authorizationMode, key: profile.upstream.apiKey, value: profile.upstream.authorizationValue },
          binding: { mode: 'template', id: saved.template.id, revision: saved.template.revision }, modelBindings: {} } })
      }
      throw failure('未知的 UA PRO 操作', 404)
    },
  }
}
