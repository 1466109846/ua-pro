// Shared URL/routing primitives. Keep runtime and browser test plans on one path contract.
export const SDK_BY_PROTOCOL = Object.freeze({ anthropic: '@ai-sdk/anthropic', responses: '@ai-sdk/openai', 'chat-completions': '@ai-sdk/openai-compatible', gemini: '@ai-sdk/google' })
export const PATHS = { anthropic: '/v1', responses: '/v1', 'chat-completions': '/v1', gemini: '/v1beta' }
const err = (message, status = 400) => Object.assign(new Error(message), { status })

export function protocolForModel(connection, model = '') {
  const configured = connection.modelProtocols?.[model] ?? connection.protocol ?? 'auto'
  if (configured !== 'auto') {
    if (!Object.hasOwn(SDK_BY_PROTOCOL, configured)) throw err('不支持的上游协议')
    return configured
  }
  const name = model.toLowerCase().split('/').at(-1)
  if (name === 'gpt-6-astra-cc-format') return 'anthropic'
  if (/^claude[-.]/.test(name) || model.startsWith('anthropic/')) return 'anthropic'
  if (/^(gpt-|o\d|codex-|chatgpt-)/.test(name)) return 'responses'
  if (/^gemini[-.]/.test(name)) return 'gemini'
  return 'chat-completions'
}

export function siteRoot(baseURL) {
  let url
  try { url = new URL(baseURL) } catch { throw err('请配置有效的上游地址') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw err('上游地址不能包含凭据、查询或片段')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw err('远程上游必须使用 HTTPS')
  return url.href.replace(/\/+$/, '').replace(/\/(v1|v1beta)$/, '')
}

export function matchesAccountSite(baseURL, account) {
  const modelRoot = siteRoot(baseURL)
  const accountRoot = siteRoot(account.siteUrl)
  if (modelRoot === accountRoot) return true
  const agentRouterSites = ['https://agentrouter.org', 'https://ps.air-outer.com']
  return account.siteType === 'agentrouter' && agentRouterSites.includes(modelRoot) && agentRouterSites.includes(accountRoot)
}

export function apiBase(connection, protocol) {
  const path = connection.apiPaths?.[protocol] ?? PATHS[protocol]
  if (typeof path !== 'string' || !/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path)) throw err('协议根路径无效')
  return siteRoot(connection.baseURL) + path.replace(/\/+$/, '')
}

export function operationURL(connection, protocol, operation, model) {
  let suffix = operation
  if (protocol === 'anthropic' && operation === 'count_tokens') suffix = 'messages/count_tokens'
  if (protocol === 'gemini') {
    if (!['generateContent', 'streamGenerateContent', 'countTokens'].includes(operation)) throw err('Gemini 操作无效')
    suffix = `models/${encodeURIComponent(model)}:${operation}`
  }
  const allowed = { anthropic: ['messages', 'count_tokens'], responses: ['responses'], 'chat-completions': ['chat/completions'], gemini: ['generateContent', 'streamGenerateContent', 'countTokens'] }
  if (!allowed[protocol]?.includes(operation)) throw err('操作与上游协议不匹配')
  return apiBase(connection, protocol) + '/' + suffix
}
