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
  return {
    async usage(getAuth, provider = {}) {
      try {
        const selection = await selected(getAuth, provider)
        if (selection.accountId) {
          const account = await boundAccount(selection)
          if (!account.enabled) return { signIn: 'kept', windows: [{ name: account.name, display: '余额与签到账号已停用；聊天不受影响', aside: true }] }
          return accountUsage(await accountManager.refresh(selection.accountId))
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
