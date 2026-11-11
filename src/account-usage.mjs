const success = new Set(['success', 'claimed'])
const done = new Set(['already', 'already_checked', 'checked', 'done'])
const captcha = new Set(['requires_verification', 'verification_required', 'captcha'])
const amount = value => Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '—'

export function accountUsage(account) {
  const snapshot = account.snapshot
  const unit = account.unit ?? 'USD'
  const currency = unit.toLowerCase() === 'usd'
  const stale = account.status?.stale === true
  const remaining = snapshot?.remaining
  const used = snapshot?.used
  const total = Number.isFinite(remaining) && Number.isFinite(used) ? remaining + used : null
  return {
    plan: account.siteType === 'agentrouter' ? 'AgentRouter' : 'New API', user: account.name, signIn: 'kept',
    ...(Number.isFinite(remaining) ? { balance: `${currency ? '$' : ''}${amount(remaining)}${currency ? '' : ` ${unit}`}${stale ? '（缓存）' : ''}` } : {}),
    ...(account.status?.error ? { error: account.status.error } : {}),
    windows: [{ name: account.name, aside: true, unit: currency ? 'usd' : unit,
      ...(Number.isFinite(used) ? { amount: used } : {}),
      ...(Number.isFinite(total) && total >= 0 ? { limit: total, used: total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0 } : {}),
      display: snapshot ? `余额 ${amount(remaining)} ${unit}；累计消耗 ${amount(used)}；消耗增量 ${amount(snapshot.deltaUsed)}；余额变化 ${amount(snapshot.deltaBalance)}${stale ? '（缓存）' : ''}${account.status?.error ? `；${account.status.error}` : ''}` : account.status?.error || '尚未读取余额' }],
  }
}

export function accountCheckin(account) {
  if (!account?.enabled || !account.checkinEnabled) return { outcome: 'inactive', message: '当前账号未启用签到' }
  const state = account.checkin?.state
  const claimed = success.has(state)
  const outcome = claimed ? 'claimed' : done.has(state) ? 'done' : captcha.has(state) ? 'captcha' : state === 'disabled' ? 'inactive' : 'failed'
  const reward = account.checkin?.reward
  return { outcome, ...(claimed && Number.isFinite(reward) ? { credit: reward } : {}),
    message: `${account.name}：${claimed ? `签到成功${reward == null ? '' : `，奖励 ${reward} ${account.unit}`}` : done.has(state) ? '今日已签到' : captcha.has(state) ? '需要在站点完成验证' : state === 'disabled' ? '站点未开启签到' : `签到失败（${account.checkin?.message || '未完成'}）`}` }
}
