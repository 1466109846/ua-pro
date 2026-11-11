import { siteRoot } from '../lib/ua-protocol.mjs'
import { boundedResponse, credential } from './ua-runtime.mjs'

const localErrors = new WeakSet()
const fail = (message, code = 'response') => { const error = Object.assign(new Error(message), { code }); localErrors.add(error); return error }
const money = value => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
const quota = value => Number.isSafeInteger(value)
const unavailable = message => ({ signIn: 'kept', error: message, windows: [{ name: 'Key 用量', aside: true, display: `${message}；需签到请绑定站点账号，模型 key 不替代登录凭据` }] })

export function createKeyUsage({ fetchImpl = globalThis.fetch, readAuth } = {}) {
  async function request(url, headers) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail('Key 用量查询超时，请稍后手动重试', 'timeout')) }, 15000) })
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal })
        const stop = (message, code) => { void response.body?.cancel().catch(() => {}); throw fail(message, code) }
        if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== new URL(url).origin) stop('站点重定向已阻止，未向其他地址发送凭据', 'redirect')
        if (response.status === 401 || response.status === 403) stop('Key 用量查询未获授权，请核对 Key 或绑定站点账号', 'auth')
        if (response.status === 404 || response.status === 405) stop('站点未提供此 Key 用量接口', 'unsupported')
        if (!response.ok) stop('Key 用量查询失败，请检查站点服务', 'http')
        const body = await boundedResponse(response, { limit: 1024 * 1024, signal: controller.signal })
        let result
        try { result = JSON.parse(body) } catch { throw fail('站点返回的 Key 用量数据无效') }
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.success === false || result.code === false) throw fail('站点未确认 Key 用量查询成功')
        return result
      })()])
    } catch (error) {
      if (localErrors.has(error)) throw error
      throw fail('Key 用量查询未完成，请检查站点地址与网络', 'network')
    } finally { clearTimeout(timer) }
  }
  return async connection => {
    try {
      const root = siteRoot(connection.baseURL)
      const auth = await credential(connection, readAuth)
      const key = ['api-key', 'bearer'].includes(auth.mode) ? auth.key : auth.mode === 'custom' ? /^Bearer\s+([^\s]+)$/i.exec(auth.value ?? '')?.[1] : null
      if (!key) return unavailable('此认证方式不提供模型 Key 的只读用量查询')
      const headers = { accept: 'application/json', authorization: `Bearer ${key}` }
      let result
      try { result = await request(root + '/api/usage/token/', headers) }
      catch (error) {
        if (error.code !== 'unsupported') throw error
        const billing = await request(root + '/v1/dashboard/billing/usage', headers)
        const spent = billing.total_usage ?? billing.data?.total_usage
        if (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0) throw fail('站点未返回可确认的 Key 累计消耗')
        return { plan: 'Key 累计消耗', user: connection.name, signIn: 'kept', windows: [{ name: 'Key 用量', aside: true, amount: spent / 100, unit: 'usd', display: `累计消耗 ${money(spent / 100)}；余额未知。签到需绑定站点账号` }] }
      }
      const data = result.data
      if (result.code !== true || data?.object !== 'token_usage' || !quota(data.total_granted) || data.total_granted < 0 || !quota(data.total_used) || data.total_used < 0 || !quota(data.total_available) || typeof data.unlimited_quota !== 'boolean' || !quota(data.expires_at) || data.expires_at < 0) throw fail('站点返回的 Key 额度字段无效')
      let scale = 500000, estimated = true
      try {
        const status = await request(root + '/api/status', { accept: 'application/json' })
        if (status.success === true && typeof status.data?.quota_per_unit === 'number' && Number.isFinite(status.data.quota_per_unit) && status.data.quota_per_unit > 0) { scale = status.data.quota_per_unit; estimated = false }
      } catch { /* The token reading remains valid; label the default conversion as estimated. */ }
      const available = data.total_available / scale, used = data.total_used / scale, total = data.total_granted / scale
      if (![available, used, total].every(Number.isFinite)) throw fail('站点额度换算超出允许范围')
      const user = data.user_quota
      const userAvailable = quota(user?.total_available) && quota(user?.total_used) && user.total_used >= 0 ? user.total_available / scale : null
      const suffix = estimated ? '（估算）' : ''
      const balance = Number.isFinite(userAvailable) ? money(userAvailable) + suffix : data.unlimited_quota ? 'Key 不限额（账号余额未知）' : money(available) + suffix
      let until
      if (data.expires_at > 0) { const date = new Date(data.expires_at * 1000); if (!Number.isFinite(date.getTime())) throw fail('Key 过期时间无效'); until = date.toISOString() }
      return { plan: Number.isFinite(userAvailable) ? 'New API 账号余额（Key 已授权查询）' : 'New API Key 额度', user: connection.name, signIn: 'kept', balance,
        ...(until ? { until } : {}),
        windows: [{ name: 'Key 额度', aside: true, amount: used, unit: 'usd',
          ...(!data.unlimited_quota ? { limit: total, used: total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0 } : {}),
          display: `${data.unlimited_quota ? 'Key 不限额' : `Key 剩余 ${money(available)}`}；累计消耗 ${money(used)}${Number.isFinite(userAvailable) ? `；账号余额 ${money(userAvailable)}` : '；这是 Key 额度，不等于账号总余额'}${estimated ? '；额度倍率未确认，按 500000 quota/USD 估算' : ''}；签到需绑定站点账号` }],
      }
    } catch (error) { return unavailable(localErrors.has(error) ? error.message : 'Key 用量读取未完成，请核对连接凭据与地址') }
  }
}
