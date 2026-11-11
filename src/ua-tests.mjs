import { performance } from 'node:perf_hooks'
import { prepareUpstream, protocolForModel, lookupUAModels, readModelCatalog } from './ua-runtime.mjs'
import { createTestPlan, createTestSample, validateTestSample } from '../lib/ua-test-plan.mjs'
import { createUAModelCatalog } from './ua-model-catalog.mjs'
import { validateTemplate } from './ua-transform.mjs'

const sensitive = /^(?:authorization|proxy-authorization|api[-_]?key|x-api-key|x-goog-api-key|key|value|access[_-]?token|refresh[_-]?token|token|secret|cookie|set-cookie|credential|password)$/i
const error = message => Object.assign(new Error(message), { status: 400 })

function safeValue(value, secrets = [], depth = 0) {
  if (depth > 24) return '[depth limited]'
  if (typeof value === 'string') {
    let text = value
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
    return text.length > 32000 ? text.slice(0, 32000) + '…' : text
  }
  if (Array.isArray(value)) return value.map(item => safeValue(item, secrets, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : safeValue(item, secrets, depth + 1)]))
  return value
}

function responseDiagnostic(status, text, plan) {
  let message = ''
  try {
    const data = JSON.parse(text)
    message = typeof data.error?.message === 'string' ? data.error.message : typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : ''
  } catch { /* HTML bodies remain in the bounded response details. */ }
  message = message.slice(0, 800)
  if (status === 404) return { title: '上游接口或模型未找到', message: `本次已请求 ${plan.url}。填写站点地址不表示支持 ${plan.protocol} 接口。${message ? ` 上游说明：${message}` : ''}`, suggestions: ['核对该站点支持的协议及当前模型的接口。', '若站点使用专用部署前缀，可在本次协议路径中填写根路径后重新确认。', '不要把本地模板冲突、旧结果或模型列表成功等同于此接口可用。'] }
  if ([401,403].includes(status)) return { title: '上游认证或权限拒绝', message: message || '站点拒绝了当前连接凭据或模型权限。', suggestions: ['核对当前连接的 key 与该协议所需认证方式；不自动更换账号。'] }
  if (status === 429 || status >= 500) return { title: '上游暂时不可用', message: message || `上游返回 HTTP ${status}，不是模型目录为空。`, suggestions: ['查看上游限流、负载或服务状态；本次不自动重试或改模型。'] }
  if (status >= 400) return { title: '上游拒绝请求格式', message: message || `上游返回 HTTP ${status}。`, suggestions: ['核对本次协议样例和上游要求；用户自定义正文不会被自动改写。'] }
  return null
}

export function createUATestRunner({ store, fetchImpl = globalThis.fetch, readAuth, modelFetchFor } = {}) {
  return async function run(raw, { signal } = {}) {
    if (!raw || !['preview', 'check', 'infer'].includes(raw.kind)) throw error('请选择预览、连接检查或实际请求测试')
    if (raw.kind !== 'preview' && raw.confirmNetwork !== true) throw error('网络测试需要明确确认')
    const snapshot = await store.snapshot({ secrets: true })
    const connection = snapshot.connections.find(item => item.id === raw.connectionId)
    if (raw.expectedGeneration !== undefined && raw.expectedGeneration !== snapshot.generation) throw Object.assign(error('配置已在确认后改变，请重新读取并核对本次请求'), { status: 409 })
    if (connection && raw.expectedConnectionRevision !== undefined && raw.expectedConnectionRevision !== connection.revision) throw Object.assign(error('当前连接已改变，请重新读取后测试'), { status: 409 })
    if (raw.kind !== 'preview' && !connection) throw error('请选择要直测的连接')
    const selected = connection ?? { id: 'preview-only', name: '本地预览', enabled: true, baseURL: 'https://preview.invalid', protocol: raw.protocol ?? 'anthropic', apiPaths: {}, modelProtocols: {}, models: [], auth: { source: 'stored', mode: 'none', key: '', value: '' }, binding: { mode: 'auto', resolvedVersions: { responses: { id: 'builtin.codex', revision: 1 }, anthropic: { id: 'builtin.claude-code', revision: 1 } } }, modelBindings: {} }
    let suppliedModel
    try {
      const supplied = typeof raw.request?.body === 'string' ? JSON.parse(raw.request.body) : raw.request?.body
      suppliedModel = typeof supplied?.model === 'string' ? supplied.model.trim() : ''
    } catch { suppliedModel = '' }
    let model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : suppliedModel || selected.models[0] || ''
    if (!model && connection && raw.kind !== 'check') {
      const catalog = await readModelCatalog(connection, { catalog: createUAModelCatalog(store.path), readAuth })
      model = catalog?.models[0]?.id ?? ''
    }
    if (!model && raw.kind !== 'check') throw error('此连接暂无可测试模型，请先获取模型或明确输入模型 ID')
    const protocol = raw.protocol ?? protocolForModel(selected, model)
    const operation = raw.operation ?? (protocol === 'responses' ? 'responses' : protocol === 'anthropic' ? 'messages' : protocol === 'gemini' ? raw.stream ? 'streamGenerateContent' : 'generateContent' : 'chat/completions')
    const template = raw.template === null ? null : raw.template ? validateTemplate(raw.template) : undefined
    const plan = createTestPlan({ snapshot, connection: selected, kind: raw.kind, protocol, operation, model, stream: raw.stream === true, templateMode: raw.templateMode ?? 'binding', template, templateRef: raw.templateRef, apiPath: raw.apiPath })
    const safeConnection = raw.apiPath ? { ...selected, apiPaths: { ...selected.apiPaths, [plan.protocol]: raw.apiPath } } : selected
    const started = performance.now()
    const testedAt = new Date().toISOString()
    const timeout = AbortSignal.timeout(raw.kind === 'infer' ? 60000 : 15000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const secrets = [selected.auth?.key, selected.auth?.value].filter(Boolean)
    if (raw.kind === 'check') {
      const info = { kind: raw.kind, connectionId: selected.id, connectionName: selected.name, model: '', protocol: plan.protocol, testedAt,
        request: { url: plan.url, method: 'GET' }, generation: snapshot.generation, resolution: plan.resolution }
      try {
        const result = await lookupUAModels(safeConnection, { readAuth, fetchImpl, modelFetchFor, signal: combined, allowCached: false })
        return { ...info, status: 'passed', models: result.models, httpStatus: 200, durationMs: Math.round(performance.now() - started), message: '只读取模型列表，实际生成尚未验证' }
      } catch (cause) {
        return { ...info, status: 'failed', durationMs: Math.round(performance.now() - started), error: combined.aborted ? signal?.aborted ? '用户已取消连接检查' : '连接检查超时' : ['dns', 'connection-refused', 'connection-reset', 'timeout', 'tls', 'network', 'invalid-model-response'].includes(cause.code) ? cause.message : cause.status ? `模型列表返回 HTTP ${cause.status}` : '模型列表检查未完成', httpStatus: cause.code === 'upstream-http' ? cause.status : undefined }
      }
    }
    const provided = raw.request?.body ?? createTestSample(protocol, model, raw.stream === true, operation)
    if (typeof provided !== 'string' && (!provided || typeof provided !== 'object' || Array.isArray(provided))) throw error('测试正文必须是 JSON 对象或字符串')
    const body = typeof provided === 'string' ? provided : JSON.stringify(provided)
    if (Buffer.byteLength(body) > 192 * 1024) throw error('测试样例最多 192 KiB')
    let parsed
    try { parsed = JSON.parse(body) } catch { throw error('测试正文必须是有效的 JSON 对象') }
    validateTestSample(parsed, plan)
    let url = plan.url
    if (protocol === 'gemini' && raw.stream) url += '?alt=sse'
    const prepared = await prepareUpstream({ snapshot, connection: safeConnection, input: url,
      init: { method: 'POST', headers: { 'content-type': 'application/json', ...(raw.request?.headers ?? {}) }, body, signal: combined },
      context: { model, sessionID: 'ua-pro-test-session', requestId: 'ua-pro-test-request' }, readAuth,
      template: plan.template, protocol, operation, model })
    secrets.push(...prepared.credentialValues)
    const outgoing = Object.fromEntries(new Headers(prepared.init.headers))
    // Final credential values are removed even when supplied by a host callback.
    for (const [name, value] of Object.entries(outgoing)) if (sensitive.test(name)) secrets.push(value)
    const report = { kind: raw.kind, status: 'passed', scope: raw.kind === 'preview' ? 'local-preview' : 'direct-connection', protocol,
      connectionId: selected.id, connectionName: selected.name, model, operation, testedAt, resolution: plan.resolution,
      generation: snapshot.generation, templateId: prepared.summary?.templateId ?? null, revision: prepared.summary?.revision ?? null,
      callerIdentity: prepared.summary?.callerIdentity, sourceAvailability: prepared.summary?.sourceAvailability,
      request: { url: String(prepared.input instanceof Request ? prepared.input.url : prepared.input), method: prepared.init.method ?? 'POST', headers: safeValue(outgoing, secrets), body: safeValue(prepared.init.body, secrets) },
      changes: prepared.summary?.changes ?? [], durationMs: Math.round(performance.now() - started) }
    if (raw.kind === 'preview') return report
    try {
      const response = await fetchImpl(prepared.input, prepared.init)
      report.httpStatus = response.status
      report.responseHeaders = safeValue(Object.fromEntries(response.headers), secrets)
      report.firstChunkMs = null
      const reader = response.body?.getReader()
      const chunks = []
      let size = 0
      const cancel = () => { void reader?.cancel().catch(() => {}) }
      combined.addEventListener('abort', cancel, { once: true })
      try {
        if (reader) for (;;) {
          combined.throwIfAborted()
          const { done, value } = await reader.read()
          combined.throwIfAborted()
          if (done) break
          if (report.firstChunkMs === null) report.firstChunkMs = Math.round(performance.now() - started)
          size += value.byteLength
          if (size > 1024 * 1024) throw error('测试响应超过 1 MiB')
          chunks.push(Buffer.from(value))
        }
      } finally { combined.removeEventListener('abort', cancel); cancel(); reader?.releaseLock() }
      const text = Buffer.concat(chunks).toString('utf8')
      report.responseText = safeValue(text, secrets)
      const type = response.headers.get('content-type') ?? ''
      if (raw.stream) {
        const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(value => value && value !== '[DONE]')
        report.protocolValid = type.includes('text/event-stream') && data.length > 0 && data.every(value => { try { const event = JSON.parse(value); return !event.error && event.type !== 'error' && event.type !== 'response.failed' } catch { return false } })
        const last = data.map(value => { try { return JSON.parse(value) } catch { return {} } }).reverse().find(value => value.usage || value.usageMetadata || value.response?.usage || value.message?.usage)
        if (last) report.usage = last.usage ?? last.usageMetadata ?? last.response?.usage ?? last.message?.usage
      } else {
        try {
          const data = JSON.parse(text)
          const shape = operation === 'count_tokens' ? Number.isFinite(data.input_tokens) && data.input_tokens >= 0
            : operation === 'countTokens' ? Number.isFinite(data.totalTokens) && data.totalTokens >= 0
            : protocol === 'anthropic' ? data.type === 'message' && Array.isArray(data.content)
            : protocol === 'responses' ? Array.isArray(data.output) && data.status !== 'failed'
            : protocol === 'chat-completions' ? Array.isArray(data.choices) : Array.isArray(data.candidates)
          report.protocolValid = Boolean(shape && !data.error && data.success !== false)
          report.usage = data.usage ?? data.usageMetadata
        } catch { report.protocolValid = false }
      }
      report.status = response.ok && report.protocolValid ? 'passed' : 'failed'
      if (!response.ok) { report.error = `上游返回 HTTP ${response.status}`; report.diagnostic = responseDiagnostic(response.status, text, plan) }
      else if (!report.protocolValid) report.error = '响应不是预期的 JSON 或 SSE 格式'
    } catch {
      report.status = 'failed'
      report.error = combined.aborted ? signal?.aborted ? '用户已取消测试；若请求已到上游，仍可能计费，不自动重试' : '本次测试超时，不自动重试' : '请求或响应读取失败，不自动重试'
    }
    report.durationMs = Math.round(performance.now() - started)
    return safeValue(report, secrets)
  }
}
