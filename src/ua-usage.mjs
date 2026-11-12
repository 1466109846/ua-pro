import { matchesAccountSite } from '../lib/ua-protocol.mjs'
import { accountUsage, accountCheckin } from './account-usage.mjs'

export function createUAUsage({ providerId, input = {}, options = {}, accountManager, getConnection, resolveAccount, queryKeyUsage }) {
  async function selected(getAuth, provider) {
    const auth = typeof getAuth === 'function' ? await getAuth() : null
    const connection = auth ? await getConnection(auth, provider) : null
    if (!connection) return { accountId: null, connection, auth }
    if (typeof auth?.metadata?.newApiAccountId === 'string') return { accountId: auth.metadata.newApiAccountId.trim() || null, connection, auth }
    const slot = input.magpie?.account?.(providerId) ?? await resolveAccount?.(auth, connection)
    if (typeof slot === 'string' && Object.hasOwn(options.accountBindings ?? {}, slot)) return { accountId: options.accountBindings[slot], connection, auth }
    return { accountId: connection.newApiAccountId?.trim() || null, connection, auth }
  }
  async function boundAccount(selection) {
    const account = await accountManager.get(selection.accountId)
    if (selection.connection && !matchesAccountSite(selection.connection.baseURL, account)) throw new Error('站点绑定不匹配')
    return account
  }
  const unavailable = message => ({ signIn: 'kept', error: message, windows: [{ name: '站点账号状态', aside: true, display: message }] })
  async function keyFallback(selection, usage, message) {
    if (selection.connection && queryKeyUsage) {
      try {
        const keyUsage = await queryKeyUsage(selection.connection, selection.auth)
        if (keyUsage.balance !== undefined || keyUsage.windows?.some(window => Number.isFinite(window.amount))) {
          return { ...keyUsage, error: `${message}；显示已配置连接的 Key 用量，签到凭据需单独核对`,
            windows: [...(keyUsage.windows ?? []), { name: '站点账号状态', aside: true, display: message }] }
        }
      } catch { /* An optional Key reading must not discard the known account snapshot. */ }
    }
    return usage
  }
  return {
    async usage(getAuth, provider = {}) {
      try {
        const selection = await selected(getAuth, provider)
        if (selection.accountId) {
          let account
          try { account = await accountManager.get(selection.accountId) }
          catch { return keyFallback(selection, unavailable('绑定的站点账号无法读取'), '绑定的站点账号无法读取') }
          if (!matchesAccountSite(selection.connection.baseURL, account)) throw new Error('站点绑定不匹配')
          if (!account.enabled) return keyFallback(selection, unavailable('余额与签到账号已停用；聊天不受影响'), '站点账号已停用')
          let refreshed
          try { refreshed = await accountManager.refresh(selection.accountId) }
          catch { return keyFallback(selection, unavailable('站点账号余额未更新'), '站点账号余额未更新') }
          const usage = accountUsage(refreshed)
          return !refreshed.snapshot || refreshed.status?.stale
            ? keyFallback(selection, usage, `站点账号余额未更新：${refreshed.status?.error || '尚无账号读数'}`) : usage
        }
        const connection = selection.connection ?? (selection.auth ? await getConnection(selection.auth, provider) : null)
        if (connection && queryKeyUsage) return queryKeyUsage(connection, selection.auth)
        return { signIn: 'kept', windows: [{ name: '可选余额', display: '当前宿主账号未绑定站点账号；聊天不受影响', aside: true }] }
      } catch { return { signIn: 'kept', error: '余额读取未完成，请检查站点账号或连接设置', windows: [{ name: '可选余额', display: '余额读取未完成；模型 API key 不受影响', aside: true }] } }
    },
    async checkin(getAuth, provider = {}) {
      try {
        const selection = await selected(getAuth, provider)
        if (!selection.accountId) return { outcome: 'inactive', message: '请先在 UA PRO 中绑定同站点的余额与签到账号；模型 API key 不替代登录凭据' }
        const account = await boundAccount(selection)
        if (!account.enabled || !account.checkinEnabled) return accountCheckin(account)
        return accountCheckin(await accountManager.checkin(selection.accountId))
      } catch { return { outcome: 'failed', message: '绑定的站点账号签到未完成，请检查账号管理；模型 API key 未改变' } }
    },
  }
}
