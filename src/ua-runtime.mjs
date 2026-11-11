import { createHash, randomUUID } from 'node:crypto'
import { transformRequest } from './ua-transform.mjs'
import { resolveTemplate } from './ua-store.mjs'

import { SDK_BY_PROTOCOL, PATHS, protocolForModel, siteRoot, apiBase, operationURL } from '../lib/ua-protocol.mjs'
export { SDK_BY_PROTOCOL, protocolForModel, siteRoot, apiBase, operationURL } from '../lib/ua-protocol.mjs'
const authHeaders = ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'cookie', 'proxy-authorization']
const err = (message, status = 400) => Object.assign(new Error(message), { status })

export function operationForURL(input) {
  const path = new URL(input instanceof Request ? input.url : input).pathname
  if (/\/messages\/count_tokens$/.test(path)) return { protocol: 'anthropic', operation: 'count_tokens' }
  if (/\/messages$/.test(path)) return { protocol: 'anthropic', operation: 'messages' }
  if (/\/responses$/.test(path)) return { protocol: 'responses', operation: 'responses' }
  if (/\/chat\/completions$/.test(path)) return { protocol: 'chat-completions', operation: 'chat/completions' }
  const gemini = /\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(path)
  if (gemini) return { protocol: 'gemini', operation: gemini[2], model: decodeURIComponent(gemini[1]) }
  throw err('请求路径不是支持的模型操作')
}

async function credential(connection, readAuth) {
  let auth = connection.auth ?? {}
  if (auth.source === 'host') {
    const current = await readAuth?.(auth.provider, auth.account)
    if (current?.type !== 'api' || typeof current.key !== 'string' || !current.key.trim()) throw err('当前宿主账号缺少 API key，请重新登录', 401)
    const endpoint = current.metadata?.baseURL ?? current.metadata?.endpoint
    if (!endpoint || new URL(endpoint).href.replace(/\/+$/, '') !== new URL(connection.baseURL).href.replace(/\/+$/, '')) throw err('宿主账号地址已改变，此旧连接不能使用当前凭据', 409)
    auth = { ...auth, key: current.key }
  }
  if (['api-key', 'bearer'].includes(auth.mode) && !auth.key?.trim()) throw err('此连接缺少 API key', 400)
  if (auth.mode === 'custom' && !auth.value?.trim()) throw err('此连接缺少自定义 Authorization', 400)
  return auth
}

export function addAuthentication(headers, auth, protocol) {
  const output = new Headers(headers)
  for (const name of authHeaders) output.delete(name)
  for (const name of [...output.keys()]) if (name.startsWith('x-magpie-')) output.delete(name)
  if (auth.mode === 'bearer') output.set('authorization', `Bearer ${auth.key}`)
  else if (auth.mode === 'custom') output.set('authorization', auth.value)
  else if (auth.mode === 'api-key') output.set(protocol === 'anthropic' ? 'x-api-key' : protocol === 'gemini' ? 'x-goog-api-key' : 'authorization', ['responses', 'chat-completions'].includes(protocol) ? `Bearer ${auth.key}` : auth.key)
  return output
}

function bodyModel(init) {
  try {
    const value = typeof init.body === 'string' ? JSON.parse(init.body) : ArrayBuffer.isView(init.body) && init.body.byteLength <= 2 * 1024 * 1024 ? JSON.parse(new TextDecoder().decode(init.body)) : undefined
    return typeof value?.model === 'string' ? value.model : ''
  } catch { return '' }
}

export async function prepareUpstream({ snapshot, connection, input, init = {}, context = {}, readAuth, template, templateRef, protocol: forcedProtocol, operation: forcedOperation, model: chosenModel }) {
  if (!connection || connection.enabled === false) throw err('连接不存在或已停用', 404)
  const incoming = new URL(input instanceof Request ? input.url : input)
  const root = new URL(siteRoot(connection.baseURL))
  const prefixes = [...new Set(Object.values(PATHS).concat(Object.values(connection.apiPaths ?? {})))].map(path => new URL(root.href.replace(/\/$/, '') + path.replace(/\/$/, '') + '/'))
  if (incoming.origin !== root.origin || incoming.username || incoming.password || incoming.hash || !prefixes.some(prefix => incoming.pathname.startsWith(prefix.pathname))) throw err('拒绝发送凭据到此连接以外的路径')
  const detected = operationForURL(input)
  const protocol = forcedProtocol ?? detected.protocol
  const operation = forcedOperation ?? detected.operation
  if (detected.protocol !== protocol || detected.operation !== operation) throw err('请求协议与选定测试协议不匹配')
  const model = chosenModel || context.model || bodyModel(init) || detected.model || ''
  const target = new URL(operationURL(connection, protocol, operation, model || detected.model || ''))
  target.search = incoming.search
  if (protocol === 'gemini') target.searchParams.delete('key')
  const selected = template !== undefined ? template : templateRef ? snapshot.templates.find(item => item.id === templateRef.id && item.revision === templateRef.revision) : resolveTemplate(snapshot, connection, protocol, model)
  if (templateRef && !selected) throw err('指定模板版本不存在', 404)
  const auth = await credential(connection, readAuth)
  const scope = createHash('sha256').update(JSON.stringify([connection.baseURL, auth.mode, auth.key ?? '', auth.value ?? ''])).digest('hex')
  const destination = target.href === incoming.href ? input : input instanceof Request ? new Request(target.href, input) : target.href
  const transformed = await transformRequest({ template: selected, protocol, operation, input: destination, init,
    context: { ...context, baseURL: connection.baseURL, credentialScope: scope, model: model || detected.model || '', requestId: context.requestId ?? randomUUID() } })
  transformed.init = { ...transformed.init, headers: addAuthentication(transformed.init.headers, auth, protocol), redirect: 'manual' }
  const result = { ...transformed, protocol, operation, model, generation: snapshot.generation, connectionId: connection.id }
  Object.defineProperty(result, 'credentialValues', { value: [auth.key, auth.value].filter(Boolean), enumerable: false })
  return result
}

export function createUATransport({ getSnapshot, getConnection, readAuth, fetchImpl = globalThis.fetch, getContext = () => ({}), observe = () => {} }) {
  return async (input, init = {}) => {
    const snapshot = await getSnapshot()
    const connection = await getConnection(snapshot)
    const prepared = await prepareUpstream({ snapshot, connection, input, init, context: await getContext(input, init), readAuth })
    observe({ connectionId: connection.id, generation: snapshot.generation, templateId: prepared.summary?.templateId, revision: prepared.summary?.revision })
    return fetchImpl(prepared.input, prepared.init)
  }
}

export async function boundedResponse(response, { limit = 1024 * 1024, signal } = {}) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw err('响应超过允许大小') }
  const reader = response.body?.getReader()
  if (!reader) return ''
  let size = 0
  const chunks = []
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > limit) throw err('响应超过允许大小')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    signal?.removeEventListener('abort', stop)
    stop()
    reader.releaseLock()
  }
}

export async function discoverUA(connection, options = {}) {
  if (connection.models?.length) return connection.models.map(id => ({ id, name: id }))
  return queryUAModels(connection, options)
}

export async function modelQueryScope(connection, readAuth) {
  return (await prepareModelQuery(connection, readAuth)).scope
}

async function prepareModelQuery(connection, readAuth) {
  const auth = await credential(connection, readAuth)
  const protocol = protocolForModel(connection)
  const headers = addAuthentication({ accept: 'application/json', 'anthropic-version': '2023-06-01' }, auth, protocol)
  const url = apiBase(connection, protocol) + '/models'
  // Scope the discovery record to the actual request, including the credential.
  // Responses and auto may share a list only when URL and authentication agree.
  const scope = createHash('sha256').update(JSON.stringify([url, [...headers], auth.source, auth.provider ?? '', auth.account ?? ''])).digest('hex')
  return { url, headers, protocol, scope, secrets: [auth.key, auth.value].filter(Boolean) }
}

function catalogResult(entry) {
  return { models: entry.models, count: entry.models.length, checkedAt: entry.checkedAt, source: `${entry.source}-cache`, cached: true, stale: true }
}

export async function readModelCatalog(connection, { catalog, readAuth } = {}) {
  if (!catalog) return null
  try {
    const query = await prepareModelQuery(connection, readAuth)
    const entry = await catalog.read(query.scope)
    return entry ? catalogResult(entry) : null
  } catch { return null }
}

function modelNetworkError(cause) {
  const codes = []
  for (let current = cause, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (typeof current.code === 'string') codes.push(current.code)
  }
  const known = [
    ['dns', ['ENOTFOUND', 'EAI_AGAIN', 'DNSLookupError'], '无法解析上游域名，请检查地址、DNS 或代理设置'],
    ['connection-refused', ['ECONNREFUSED', 'ConnectionRefused'], '上游或代理拒绝连接，请检查服务地址和代理设置'],
    ['connection-reset', ['ECONNRESET', 'EPIPE', 'ConnectionClosed', 'UND_ERR_SOCKET'], '上游或代理中断了连接，请检查网络和代理设置'],
    ['timeout', ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'], '连接上游超时，请检查网络和代理设置'],
    ['tls', ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE'], '上游 TLS 证书验证失败，请检查证书或代理配置'],
  ]
  const [code, , message] = known.find(([, matches]) => codes.some(value => matches.includes(value))) ?? ['network', [], '无法连接上游，请检查网络或代理设置']
  return Object.assign(err(message), { code, catalogFallback: true })
}

async function fetchModelList(query, fetchImpl, signal) {
  let response
  try { response = await fetchImpl(query.url, { method: 'GET', headers: query.headers, signal, redirect: 'manual' }) }
  catch (error) { signal.throwIfAborted(); throw modelNetworkError(error) }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    const error = Object.assign(err(`模型列表返回 HTTP ${response.status}`, response.status), { code: 'upstream-http', catalogFallback: response.status >= 500 })
    if (response.status === 401) error.signIn = 'expired'
    throw error
  }
  let text
  try { text = await boundedResponse(response, { signal }) }
  catch (error) { signal.throwIfAborted(); if (error.status) throw error; throw modelNetworkError(error) }
  let data
  try { data = JSON.parse(text) } catch { throw Object.assign(err('模型列表不是有效的 JSON'), { code: 'invalid-model-response' }) }
  const list = query.protocol === 'gemini' && Array.isArray(data?.models)
    ? data.models.map(item => ({ id: typeof item?.name === 'string' ? item.name.replace(/^models\//, '') : '', display_name: item?.displayName, limit: { context: item?.inputTokenLimit, output: item?.outputTokenLimit } }))
    : data?.data
  if (!Array.isArray(list)) throw Object.assign(err('模型列表格式无效'), { code: 'invalid-model-response' })
  const models = new Map()
  const safeText = (value, limit = 512) => typeof value === 'string' && value.trim() && value.trim().length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value) && !query.secrets.some(secret => value.includes(secret))
  for (const item of list) {
    if (!safeText(item?.id, 256)) continue
    const id = item.id.trim()
    if (models.has(id)) continue
    const name = item.display_name ?? item.name
    models.set(id, { id, name: safeText(name) ? name.trim() : id, ...(item.limit && typeof item.limit === 'object' ? { limit: item.limit } : {}) })
    if (models.size > 2048) throw Object.assign(err('模型列表超过 2048 个，请使用手填模型缩小范围'), { code: 'invalid-model-response' })
  }
  return [...models.values()]
}

export async function lookupUAModels(connection, { readAuth, fetchImpl = globalThis.fetch, modelFetchFor, signal = AbortSignal.timeout(15000), catalog, source = 'management', allowCached = false } = {}) {
  signal.throwIfAborted()
  const query = await prepareModelQuery(connection, readAuth)
  let models
  try {
    const send = await modelFetchFor?.(query.scope) ?? fetchImpl
    signal.throwIfAborted()
    models = await fetchModelList(query, send, signal)
    signal.throwIfAborted()
  }
  catch (error) {
    const timedOut = signal.aborted && signal.reason?.name === 'TimeoutError'
    if (signal.aborted && !timedOut) signal.throwIfAborted()
    if (timedOut) error = Object.assign(err('模型列表读取超时，请检查网络和代理设置', 408), { code: 'timeout', catalogFallback: true })
    if (allowCached && error.catalogFallback && catalog) {
      const entry = await catalog.read(query.scope).catch(() => null)
      if (signal.aborted && !timedOut) signal.throwIfAborted()
      if (entry) return { ...catalogResult(entry), refreshError: { code: error.code, message: error.message } }
    }
    throw error
  }
  const checkedAt = new Date().toISOString()
  let catalogWarning
  if (catalog) {
    try { await catalog.write(query.scope, { models: models.map(({ id, name }) => ({ id, name })), checkedAt, source }) }
    catch { catalogWarning = '模型目录未能保存，其他管理会话暂时无法共享本次结果；请检查目录权限或缓存文件' }
  }
  return { models, count: models.length, checkedAt, source: 'upstream', cached: false, stale: false, ...(catalogWarning ? { catalogWarning } : {}) }
}

export async function queryUAModels(connection, options = {}) {
  const result = await lookupUAModels(connection, { ...options, allowCached: false })
  return result.models
}
