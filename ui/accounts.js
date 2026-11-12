export function formatAmount(value, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  return signed && value > 0 ? `+${text}` : text;
}

function formatConnectionTime(value) {
  if (!value) return '尚未查询';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '尚未查询' : date.toLocaleString('zh-CN');
}

/** Classify a connection reading without ever borrowing site-account totals. */
export function connectionBalanceSource(result) {
  if (!result) return 'unknown';
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : null;
  if (!usage) return result.error ? 'error' : 'unknown';
  if (typeof usage.error === 'string' && usage.error.trim()) return 'error';
  if (typeof usage.balance === 'string' && usage.balance.trim()) return 'key';
  if (Array.isArray(usage.windows) && usage.windows.some(window => typeof window?.display === 'string' && window.display.trim())) return 'key';
  return 'unknown';
}

/** Format one configured connection row; bindings are shown, never auto-selected. */
export function connectionBalanceView(connection = {}, result = null, accounts = []) {
  const usage = result?.usage && typeof result.usage === 'object' ? result.usage : null;
  const windows = Array.isArray(usage?.windows) ? usage.windows : [];
  const windowsText = windows
    .map(item => typeof item?.display === 'string' ? item.display.trim() : '')
    .filter(Boolean)
    .join(' ');
  const balance = typeof usage?.balance === 'string' && usage.balance.trim() ? usage.balance.trim() : '余额未知';
  const source = connectionBalanceSource(result);
  const accountId = connection.newApiAccountId ?? '';
  const bound = accountId ? (Array.isArray(accounts) ? accounts : []).find(account => account.id === accountId) : null;
  const boundAccount = !accountId
    ? '未绑定签到账号'
    : bound ? `签到账号：${bound.name}` : '绑定的签到账号已失效';
  return {
    name: String(connection.name ?? '').trim() || '未命名连接',
    root: String(connection.baseURL ?? '').trim() || '—',
    balance,
    windows: windowsText,
    source,
    sourceLabel: source === 'key' ? '已配置连接 Key 用量' : source === 'error' ? '查询失败' : '尚未查询',
    boundAccount,
    lastAt: formatConnectionTime(result?.at),
    error: typeof usage?.error === 'string' && usage.error.trim()
      ? usage.error
      : typeof result?.error === 'string' ? result.error : '',
  };
}

/** A reading is valid only for the exact id, Key revision and address it came from. */
export function connectionResultMatches(connection = {}, result = null) {
  return Boolean(connection && result
    && result.connectionId === connection.id
    && result.revision === connection.revision
    && result.baseURL === connection.baseURL);
}

/** Drop readings after a list reload changes the Key revision or address. */
export function pruneConnectionResults(connections = [], results = {}) {
  const kept = {};
  for (const connection of Array.isArray(connections) ? connections : []) {
    const result = results?.[connection.id];
    if (connectionResultMatches(connection, result)) kept[connection.id] = result;
  }
  return kept;
}

/** Explicit same-origin refresh; the network is never touched by the initial list load. */
export async function requestConnectionUsage(fetcher, connection = {}) {
  let response;
  try {
    response = await fetcher('./api/accounts/connection-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id, confirmNetwork: true }),
    });
  } catch {
    return { ok: false, error: 'Key 用量查询未完成，请检查站点地址与网络' };
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    return { ok: false, error: data && typeof data.error === 'string' && data.error ? data.error : 'Key 用量查询未完成' };
  }
  if (!data || typeof data !== 'object' || data.connectionId !== connection.id
    || !data.usage || typeof data.usage !== 'object') {
    return { ok: false, error: 'Key 用量响应无法确认，请稍后重试' };
  }
  return { ok: true, data };
}


export function accountValues(account = {}) {
  return {
    id: account.id, name: account.name ?? '', siteType: account.siteType === 'agentrouter' ? 'agentrouter' : 'newapi',
    siteUrl: account.siteUrl ?? '', userId: account.userId ?? '', username: account.username ?? '',
    authMode: account.authMode ?? 'token', accessToken: '', cookie: '', password: '',
    quotaPerUnit: account.quotaPerUnit ?? 500000, unit: account.unit ?? 'USD',
    enabled: account.enabled ?? true, checkinEnabled: account.checkinEnabled ?? true,
    scheduleEnabled: account.schedule?.enabled ?? false,
    scheduleTime: account.schedule?.time ?? '09:00',
    scheduleTimeZone: account.schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    clearAccessToken: false, clearCookie: false, clearPassword: false,
  };
}

export function accountPayload(values) {
  const { clearAccessToken, clearCookie, clearPassword, scheduleEnabled = false, scheduleTime = '09:00', scheduleTimeZone = 'UTC', ...raw } = values;
  const account = { ...raw, siteType: raw.siteType === 'agentrouter' ? 'agentrouter' : 'newapi', username: String(raw.username ?? '').trim(), quotaPerUnit: Number(raw.quotaPerUnit), schedule: { enabled: scheduleEnabled, time: scheduleTime, timeZone: scheduleTimeZone } };
  if (!account.password) delete account.password;
  const clearSecrets = [];
  if (clearAccessToken) { clearSecrets.push('accessToken'); account.accessToken = ''; }
  if (clearCookie) { clearSecrets.push('cookie'); account.cookie = ''; }
  if (clearPassword) { clearSecrets.push('password'); account.password = ''; }
  if (!account.id) delete account.id;
  return { account, clearSecrets };
}

export function accountSummary(account) {
  const snapshot = account.snapshot;
  const unit = account.unit ?? '';
  const amount = (value, signed = false) => value === null || value === undefined ? '—' : `${formatAmount(value, signed)} ${unit}`.trim();
  const labels = { success: '已签到', checked: '已签到', already: '今日已签到',
    already_checked: '今日已签到', disabled: '未启用签到', verification_required: '需要验证',
    requires_verification: '需要验证', error: '签到失败', failed: '签到失败', unknown: '尚未签到' };
  return {
    remaining: amount(snapshot?.remaining), used: amount(snapshot?.used),
    deltaBalance: amount(snapshot?.deltaBalance, true), deltaUsed: amount(snapshot?.deltaUsed, true),
    deltaRequests: snapshot?.deltaRequests == null ? '—' : String(snapshot.deltaRequests),
    state: !account.enabled ? '已停用' : account.status?.stale ? '缓存读数' : snapshot ? '已更新' : '尚未查询',
    error: account.status?.error ?? '',
    checkin: account.checkin?.state === 'unknown' && account.checkin.lastAttemptAt ? '结果未确认' : labels[account.checkin?.state] ?? account.checkin?.state ?? '尚未签到',
    schedule: !account.schedule?.enabled ? '自动签到未开启' : !account.enabled || !account.checkinEnabled
      ? '自动签到已暂停（账号或签到已停用）' : `每天 ${account.schedule.time} · ${account.schedule.timeZone}`,
    reward: amount(account.checkin?.reward), reset: snapshot?.reset ?? false,
    at: snapshot?.at ? new Date(snapshot.at).toLocaleString('zh-CN') : '—',
  };
}

export function secretIntent(values = {}, valueKey = 'accessToken', clearKey = 'clearAccessToken', existing = false) {
  if (values[clearKey]) return 'clear';
  if (typeof values[valueKey] === 'string' && values[valueKey].length > 0) return 'replace';
  return existing ? 'keep' : 'empty';
}

/** A comparable, normalized draft. Secrets never enter the draft as plaintext. */
export function normalizedAccountDraft(values = {}, secrets = {}) {
  const text = (value) => value === null || value === undefined ? '' : String(value).trim();
  const number = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    id: text(values.id),
    name: text(values.name),
    siteType: values.siteType === 'agentrouter' ? 'agentrouter' : 'newapi',
    siteUrl: text(values.siteUrl),
    userId: text(values.userId),
    username: text(values.username),
    authMode: values.authMode === 'cookie' ? 'cookie' : 'token',
    quotaPerUnit: number(values.quotaPerUnit),
    unit: text(values.unit),
    enabled: Boolean(values.enabled),
    checkinEnabled: Boolean(values.checkinEnabled),
    scheduleEnabled: Boolean(values.scheduleEnabled),
    scheduleTime: text(values.scheduleTime),
    scheduleTimeZone: text(values.scheduleTimeZone),
    accessToken: secretIntent(values, 'accessToken', 'clearAccessToken', Boolean(secrets.accessToken)),
    cookie: secretIntent(values, 'cookie', 'clearCookie', Boolean(secrets.cookie)),
    password: secretIntent(values, 'password', 'clearPassword', Boolean(secrets?.password)),
  };
}

/** Client-side field validation; the backend repeats it authoritatively. */
export function accountFieldErrors(values = {}, secrets = {}) {
  const text = (value) => value === null || value === undefined ? '' : String(value).trim();
  const errors = {};
  if (!text(values.name)) errors.name = '请填写账号名称';
  if (!text(values.siteUrl)) errors.siteUrl = '请填写站点地址';
  const siteType = values.siteType === 'agentrouter' ? 'agentrouter' : 'newapi';
  const userId = text(values.userId);
  if (siteType === 'newapi') {
    if (!/^[1-9]\d*$/.test(userId)) errors.userId = '请填写正整数用户 ID';
  } else {
    if (userId && !/^[1-9]\d*$/.test(userId)) errors.userId = '用户 ID 必须为正整数，或留空由登录结果确定';
    if (!text(values.username)) errors.username = '请填写 AgentRouter 登录用户名';
    if (!text(values.password) && !values.clearPassword && !secrets?.password) {
      errors.password = '请填写登录密码；已保存的密码可留空保留';
    }
  }
  return errors;
}

export function accountDraftDirty(baseline, draft) {
  if (!baseline || !draft) return false;
  return JSON.stringify(baseline) !== JSON.stringify(draft);
}

export function bulkEligibility(accounts = [], connections = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  const refresh = list.some((account) => account?.enabled === true) || (Array.isArray(connections) && connections.some(connection => connection?.enabled === true));
  const checkin = list.some((account) => account?.enabled === true && account?.checkinEnabled === true);
  return {
    refresh,
    checkin,
    refreshReason: refresh ? '' : '没有启用且可刷新的账号',
    checkinReason: checkin ? '' : '没有启用且允许签到的账号',
  };
}

const ACTION_LABELS = Object.freeze({ save: '保存', refresh: '刷新', checkin: '签到', bind: '绑定', remove: '删除', done: '完成并关闭' });

export function reconciliationMessage(action) {
  return `已重新读取账号列表；原${ACTION_LABELS[action] ?? '操作'}结果仍需核对，不要直接重复提交。`;
}

export function loadFailureMessage({ loaded = false, at } = {}) {
  if (!loaded) return '首次读取失败：尚未加载任何账号数据。';
  const date = at === undefined ? null : new Date(at);
  const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN') : '';
  return when
    ? `重新读取失败：仍显示上次成功读取的数据（${when}）。`
    : '重新读取失败：仍显示上次成功读取的数据。';
}

export async function requestAccountAction(fetcher, action, payload) {
  let response;
  try {
    response = await fetcher(`./api/accounts/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false, unknown: true,
      error: '操作结果未知：请求可能已提交但未收到确认。请重新读取账号列表确认结果，不要直接重复提交。',
    };
  }
  let data = {};
  let confirmed = true;
  try { data = await response.json(); } catch { data = {}; confirmed = false; }
  if (!response.ok) return { ok: false, unknown: false, error: data.error || '账号操作未完成', fields: data.fields };
  if (!confirmed) {
    return {
      ok: false, unknown: true,
      error: '操作结果未知：服务响应无法确认，请求可能已提交。请重新读取账号列表确认结果，不要直接重复提交。',
    };
  }
  return { ok: true, data };
}

export async function initializeAccounts() {
  const get = (id) => document.getElementById(id);
  const editor = get('account-editor');
  const history = get('account-history');
  const controls = { name: 'account-name', siteType: 'site-type', siteUrl: 'site-url', userId: 'user-id', username: 'agent-username', authMode: 'auth-mode', accessToken: 'access-token', cookie: 'account-cookie', password: 'agent-password', quotaPerUnit: 'quota-per-unit', unit: 'unit', enabled: 'account-enabled', checkinEnabled: 'checkin-enabled', scheduleEnabled: 'schedule-enabled', scheduleTime: 'schedule-time', scheduleTimeZone: 'schedule-timezone', clearAccessToken: 'clear-token', clearCookie: 'clear-cookie', clearPassword: 'clear-password' };
  const checks = new Set(['enabled', 'checkinEnabled', 'scheduleEnabled', 'clearAccessToken', 'clearCookie', 'clearPassword']);
  const fieldIds = { name: 'account-name', siteUrl: 'site-url', userId: 'user-id', username: 'agent-username',
    authMode: 'auth-mode', accessToken: 'access-token', cookie: 'account-cookie', password: 'agent-password',
    quotaPerUnit: 'quota-per-unit', unit: 'unit',
    'schedule.enabled': 'schedule-enabled', 'schedule.time': 'schedule-time', 'schedule.timeZone': 'schedule-timezone' };
  const actionStatus = { refresh: '正在刷新账号余额…', checkin: '正在签到并刷新余额…',
    bind: '正在更新当前连接绑定…', remove: '正在删除账号…' };
  let accounts = [];
  let binding = null;
  let connections = [];
  let connectionResults = {};
  let editing;
  let running = false;
  let unknownOutcome = null;
  let reconciled = false;
  let loading = true;
  let hasLoaded = false;
  let lastLoadedAt = 0;
  let loadErrorShown = false;
  let editorBaseline;
  let allowUnload = false;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function error(message, form = false) {
    const target = get(form ? 'account-form-error' : 'accounts-error');
    target.textContent = message; target.hidden = !message;
    if (message) target.focus();
  }
  function clearFieldErrors() {
    for (const node of get('account-form').querySelectorAll('[aria-invalid]')) {
      node.removeAttribute('aria-invalid');
      node.removeAttribute('aria-errormessage');
    }
    get('account-form').querySelectorAll('.account-field-error').forEach(node => node.remove());
  }
  function markFieldErrors(fields = {}) {
    clearFieldErrors();
    let first;
    for (const [key, message] of Object.entries(fields)) {
      const node = get(fieldIds[key]);
      if (!node) continue;
      first ||= node;
      const note = element('p', typeof message === 'string' ? message : '请填写有效的值', 'account-field-error');
      note.id = `${node.id}-error`;
      node.insertAdjacentElement('afterend', note);
      node.setAttribute('aria-invalid', 'true');
      node.setAttribute('aria-errormessage', note.id);
    }
    if (first) { first.scrollIntoView({ block: 'center' }); first.focus({ preventScroll: true }); }
  }
  function fields() {
    const values = { id: editing?.id };
    for (const [key, id] of Object.entries(controls)) values[key] = checks.has(key) ? get(id).checked : get(id).value;
    return values;
  }
  function currentDraft() {
    return normalizedAccountDraft(fields(), editing?.secrets ?? {});
  }
  function isEditorDirty() {
    return Boolean(editor.open && editorBaseline && accountDraftDirty(editorBaseline, currentDraft()));
  }
  function updateEditorDirty() {
    const dirty = isEditorDirty();
    const state = get('editor-dirty-state');
    state.textContent = editor.open
      ? dirty ? '有未保存的修改；关闭或按 Esc 会先确认。' : '没有未保存的修改。'
      : '';
    state.classList.toggle('dirty', dirty);
  }
  function confirmDiscard() {
    return window.confirm('有未保存的账号修改。确定放弃修改并继续吗？选择“取消”可返回继续编辑。');
  }
  function syncControls() {
    const bulk = bulkEligibility(accounts, connections);
    const blocked = running || Boolean(unknownOutcome);
    get('refresh-all').disabled = blocked || loading || !bulk.refresh;
    get('checkin-all').disabled = blocked || loading || !bulk.checkin;
    get('connection-refresh-all').disabled = blocked || loading || connections.length === 0;
    get('account-new').disabled = blocked;
    get('accounts-done').disabled = blocked;
    get('account-save').disabled = blocked;
    get('editor-close').disabled = running;
    get('account-fields').disabled = running;
    for (const button of get('accounts-table').querySelectorAll('button')) button.disabled = blocked;
    const ack = get('accounts-ack');
    ack.hidden = !(unknownOutcome && reconciled);
    ack.disabled = running;
    const recheck = get('editor-recheck');
    recheck.hidden = unknownOutcome?.action !== 'save' || reconciled;
    recheck.disabled = running || loading;
    const editorAck = get('editor-ack');
    editorAck.hidden = !(unknownOutcome?.action === 'save' && reconciled);
    editorAck.disabled = running;
    const unread = !loading && !hasLoaded ? '账号数据尚未读取，请先重新读取账号列表' : '';
    const reasons = [];
    if (unread) reasons.push(unread);
    else if (!loading) {
      if (!bulk.refresh) reasons.push(bulk.refreshReason);
      if (!bulk.checkin) reasons.push(bulk.checkinReason);
    }
    const reason = get('bulk-reason');
    reason.textContent = reasons.join('；');
    reason.hidden = loading || reasons.length === 0;
    const reasonFor = { 'refresh-all': unread || bulk.refreshReason, 'checkin-all': unread || bulk.checkinReason };
    for (const id of ['refresh-all', 'checkin-all']) {
      const button = get(id);
      const why = reasonFor[id];
      if (!loading && why) {
        button.title = why;
        button.setAttribute('aria-describedby', 'bulk-reason');
      } else {
        button.removeAttribute('title');
        button.removeAttribute('aria-describedby');
      }
    }
    const retry = get('accounts-retry');
    retry.disabled = running || loading;
    if (unknownOutcome) {
      for (const id of ['refresh-all', 'checkin-all', 'account-new', 'accounts-done', 'account-save']) {
        get(id).title = '操作结果未知；请先重新读取账号列表确认。';
      }
    }
  }
  function busy(value) {
    running = value;
    syncControls();
  }
  function confirmUnknownLeave() {
    const label = ACTION_LABELS[unknownOutcome?.action] ?? '操作';
    return window.confirm(`“${label}”结果仍需核对。确定关闭并稍后重新打开页面核对吗？`);
  }
  function acknowledgeUnknown() {
    if (!unknownOutcome || !reconciled || running) return;
    const label = ACTION_LABELS[unknownOutcome.action] ?? '操作';
    if (!window.confirm(`请确认已核对“${label}”结果，并且不会重复提交。继续操作？`)) return;
    unknownOutcome = null;
    reconciled = false;
    error('');
    error('', true);
    get('editor-reconciliation').hidden = true;
    get('accounts-status').textContent = statusSummary();
    syncControls();
  }
  function credentialFields() {
    const agentRouter = get('site-type').value === 'agentrouter';
    get('agentrouter-fields').hidden = !agentRouter;
    get('user-id').required = !agentRouter;
    get('token-field').hidden = get('auth-mode').value !== 'token' && !editing?.secrets?.accessToken;
    get('cookie-field').hidden = get('auth-mode').value !== 'cookie' && !editing?.secrets?.cookie;
  }
  function scheduleFields() {
    get('schedule-settings').hidden = !get('schedule-enabled').checked;
  }
  function edit(account) {
    editing = account;
    get('editor-reconciliation').hidden = true;
    const values = accountValues(account);
    for (const [key, id] of Object.entries(controls)) {
      if (checks.has(key)) get(id).checked = values[key];
      else get(id).value = values[key];
    }
    get('editor-title').textContent = account ? '编辑站点账号' : '添加站点账号';
    get('token-state').textContent = account?.secrets?.accessToken ? '已保存；留空保留原令牌' : '尚未保存系统访问令牌';
    get('cookie-state').textContent = account?.secrets?.cookie ? '已保存；留空保留原 Cookie' : '尚未保存 Cookie';
    get('agent-password-state').textContent = account?.secrets?.password ? '已保存；留空保留原密码' : '尚未保存登录密码';
    error('', true);
    clearFieldErrors();
    credentialFields(); scheduleFields();
    editorBaseline = currentDraft();
    editor.showModal();
    updateEditorDirty();
    get('account-name').focus();
  }
  function showHistory(account) {
    get('history-title').textContent = `${account.name} · 额度变化`;
    get('history-list').replaceChildren(...[...(account.history ?? [])].reverse().map((snapshot) => {
      const row = element('tr');
      for (const value of [new Date(snapshot.at).toLocaleString('zh-CN'), formatAmount(snapshot.remaining), formatAmount(snapshot.used), formatAmount(snapshot.deltaBalance, true), formatAmount(snapshot.deltaUsed, true), snapshot.deltaRequests ?? '—']) row.append(element('td', String(value)));
      return row;
    }));
    history.showModal();
  }
  async function perform(action, id) {
    if (running || unknownOutcome) return;
    if (action === 'remove' && !window.confirm('删除这个账号及其本地历史记录？不会注销站点账号。')) return;
    if (action === 'checkin' && !window.confirm(id ? '确认向这个账号的站点提交签到？' : '确认向全部启用且允许签到的账号提交签到？')) return;
    if (action === 'bind' && !window.confirm('把这个站点账号用于当前 Magpie 连接的余额和签到？点击“完成并关闭”后保存绑定，不更改 API key。')) return;
    busy(true); error('');
    get('accounts-status').textContent = actionStatus[action] ?? '正在处理账号…';
    const result = await requestAccountAction(fetch.bind(globalThis), action, id ? { id } : {});
    if (!result.ok && result.unknown) {
      unknownOutcome = { action, id: id ?? null };
      reconciled = false;
      error(result.error);
      get('accounts-status').textContent = `操作结果未知：请求可能已提交。请先重新读取账号列表核对“${ACTION_LABELS[action] ?? '操作'}”结果，不要重复提交。`;
      get('accounts-retry').hidden = false;
      busy(false);
      return;
    }
    if (!result.ok) error(result.error);
    await load();
    try {
      if (action === 'refresh' && !id) await refreshConnections();
    } finally {
      busy(false);
    }
  }
  function statusSummary() {
    if (accounts.length === 0) return '尚未添加站点账号。添加后可刷新余额或签到。';
    return `${accounts.length} 个账号，${accounts.filter((account) => account.enabled).length} 个启用。${binding ? `当前连接 ${binding.account}；绑定需点击完成后保存。` : '签到账号绑定请在连接与模型选择中操作。'}`;
  }
  function renderConnections() {
    connectionResults = pruneConnectionResults(connections, connectionResults);
    const list = get('connection-balance-list');
    const empty = connections.length === 0;
    list.hidden = empty;
    get('connection-balance-rows').replaceChildren(...connections.map((connection) => {
      const result = connectionResults[connection.id] ?? null;
      const view = connectionBalanceView(connection, result, accounts);
      const row = element('tr');
      const identity = element('td');
      identity.append(element('strong', view.name), element('div', view.root, 'detail'), element('div', view.boundAccount, 'detail'));
      const balance = element('td');
      balance.append(element('div', view.balance, 'primary-value'), element('div', view.sourceLabel, 'detail'));
      const usage = element('td');
      usage.append(element('div', view.windows || '—', 'detail'));
      if (view.error && !view.windows.includes(view.error)) usage.append(element('div', view.error, 'detail'));
      const last = element('td');
      last.append(element('div', view.lastAt, 'detail'));
      for (const [cell, label] of [[identity, '连接 / 站点'], [balance, 'Key 余额'], [usage, 'Key 用量'], [last, '最近查询']]) cell.dataset.label = label;
      row.append(identity, balance, usage, last);
      return row;
    }));
    if (empty) {
      get('connection-balance-status').textContent = '尚未读取到已配置连接；请先在连接与模型选择中保存连接。';
    } else if (Object.keys(connectionResults).length === 0) {
      get('connection-balance-status').textContent = `已读取 ${connections.length} 个连接，Key 余额尚未查询；请手动刷新。`;
    }
  }
  async function refreshConnections() {
    const targets = connections.slice();
    if (targets.length === 0) {
      get('connection-balance-status').textContent = '尚未读取到已配置连接；没有可刷新的 Key 用量。';
      return;
    }
    get('connection-balance-status').textContent = `正在刷新 ${targets.length} 个连接的 Key 用量…`;
    let completed = 0;
    let failed = 0;
    let discarded = 0;
    for (const target of targets) {
      const current = connections.find((connection) => connection.id === target.id);
      if (!current || current.revision !== target.revision || current.baseURL !== target.baseURL) continue;
      const result = await requestConnectionUsage(fetch.bind(globalThis), current);
      const latest = connections.find((connection) => connection.id === current.id);
      if (!latest || latest.revision !== current.revision || latest.baseURL !== current.baseURL) { discarded++; continue; }
      if (result.ok && result.data.revision !== current.revision) { discarded++; continue; }
      connectionResults[current.id] = result.ok
        ? { connectionId: current.id, revision: current.revision, baseURL: current.baseURL, usage: result.data.usage, at: result.data.at || new Date().toISOString() }
        : { connectionId: current.id, revision: current.revision, baseURL: current.baseURL, error: result.error, at: new Date().toISOString() };
      if (result.ok) completed++;
      else failed++;
      renderConnections();
      get('connection-balance-status').textContent = `正在刷新连接 Key 用量…（${completed + failed}/${targets.length}）`;
    }
    renderConnections();
    get('connection-balance-status').textContent = discarded
      ? `已刷新 ${completed + failed} 个连接；${discarded} 个结果因 Key 或站点已变化而丢弃，请重新读取列表。`
      : failed
        ? `已刷新 ${completed + failed} 个连接；${failed} 个查询失败，详见各行站点返回的安全提示。`
        : `已刷新 ${completed} 个连接的 Key 用量；不与站点账号汇总合并。`;
  }
  function render(data) {
    accounts = Array.isArray(data.accounts) ? data.accounts : [];
    connections = Array.isArray(data.connections) ? data.connections : [];
    connectionResults = pruneConnectionResults(connections, connectionResults);
    binding = data.binding ?? null;
    const empty = accounts.length === 0;
    get('account-empty').hidden = !empty;
    get('accounts-table-scroll').hidden = empty;
    get('accounts-table').hidden = empty;
    get('accounts-status').textContent = statusSummary();
    get('account-totals').replaceChildren(...Object.entries(data.totals ?? {}).map(([unit, total]) => {
      const node = element('section', undefined, 'unit-total'); node.append(element('h2', `${unit} 站点账号汇总`));
      const metrics = element('div', undefined, 'total-values');
      for (const [name, value] of [['剩余额度', total.remaining], ['累计消耗', total.used], ['消耗增量', total.deltaUsed]]) {
        const metric = element('div', undefined, 'total-metric'); metric.append(element('small', name), element('strong', formatAmount(value))); metrics.append(metric);
      }
      node.append(metrics, element('p', `${total.accountCount} 个独立身份，${total.staleCount ?? 0} 个缓存/异常读数；${total.availableCount ?? 0} 个已有读数。别名去重，不同单位不合并。`)); return node;
    }));
    get('account-list').replaceChildren(...accounts.map((account) => {
      const row = element('tr'); const view = accountSummary(account);
      const identity = element('td'); identity.append(element('strong', account.name), element('div', `${account.siteType === 'agentrouter' ? 'AgentRouter' : 'New API'} · ${account.siteUrl} · ID ${account.userId || (account.siteType === 'agentrouter' ? '登录后确定' : '—')}`, 'detail'), element('span', view.state, `account-state${account.status?.stale ? ' stale' : ''}`));
      if (view.error) identity.append(element('div', view.error, 'detail'));
      if (data.binding?.selected === account.id) identity.append(element('span', '已选为当前连接', 'account-state'));
      const remaining = element('td'); remaining.append(element('div', view.remaining, 'primary-value'), element('div', view.at, 'detail'));
      const used = element('td'); used.append(element('div', view.used, 'primary-value'), element('div', `累计请求 ${account.snapshot?.requestCount ?? '—'}`, 'detail'));
      const delta = element('td'); delta.append(element('div', `消耗 ${view.deltaUsed}`), element('div', `余额 ${view.deltaBalance}`, 'detail'), element('div', `请求 ${view.deltaRequests === '—' ? '—' : `+${view.deltaRequests}`}`, 'detail'));
      if (view.reset) delta.append(element('div', '累计计数回退，已重建基线', 'detail'));
      const checkin = element('td'); checkin.append(element('div', view.checkin), element('div', view.schedule, 'detail'), element('div', `奖励 ${view.reward}`, 'detail'), element('div', account.checkin?.message ?? '', 'detail'));
      const actions = element('td'); const bar = element('div', undefined, 'row-actions');
      for (const [label, action] of [['刷新', 'refresh'], ['签到', 'checkin'], ['记录', 'history'], ['编辑', 'edit'], ['删除', 'remove']]) {
        const button = element('button', label, `secondary${action === 'remove' ? ' danger' : ''}`); button.type = 'button';
        button.setAttribute('aria-label', `${label} ${account.name}`);
        button.addEventListener('click', () => action === 'edit' ? edit(account) : action === 'history' ? showHistory(account) : perform(action, account.id));
        bar.append(button);
      }
      if (data.binding) {
        const bind = element('button', data.binding.selected === account.id ? '解除绑定' : '用于当前连接', 'secondary');
        bind.type = 'button';
        bind.addEventListener('click', () => perform('bind', data.binding.selected === account.id ? undefined : account.id));
        bar.append(bind);
      }
      actions.append(bar); row.append(identity, remaining, used, delta, checkin, actions);
      // 窄屏下表格转为卡片，用单元格标签代替隐藏的表头。
      for (const [cell, label] of [[identity, '账号 / 站点'], [remaining, '剩余额度'], [used, '累计消耗'], [delta, '相较上次成功刷新'], [checkin, '签到'], [actions, '操作']]) cell.dataset.label = label;
      return row;
    }));
    renderConnections();
    syncControls();
  }
  async function load() {
    loading = true; syncControls();
    try {
      const response = await fetch('./api/accounts', { cache: 'no-store' });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok || !data || !Array.isArray(data.accounts)) {
        const failure = new Error(data?.error || '无法读取本地账号列表。配置会话可能已超时，请重新打开配置页或检查账号文件权限。');
        failure.safe = true;
        throw failure;
      }
      const hadUnknown = Boolean(unknownOutcome);
      const recovered = loadErrorShown;
      render(data);
      hasLoaded = true;
      lastLoadedAt = Date.now();
      loadErrorShown = false;
      get('accounts-retry').hidden = true;
      if (hadUnknown) {
        reconciled = true;
        const note = `${reconciliationMessage(unknownOutcome.action)} 确认无误后点击“已核对结果，继续操作”。`;
        error('');
        if (unknownOutcome.action === 'save' && editor.open) {
          error(note, true);
          const current = fields();
          const found = accounts.find(account => account.id === unknownOutcome.id)
            || accounts.find(account => account.name === current.name.trim() && account.siteUrl === current.siteUrl.trim() && String(account.userId) === current.userId.trim());
          const summary = get('editor-reconciliation'); summary.hidden = false;
          summary.textContent = found
            ? `本次读到：${found.name} · ${found.siteUrl} · ID ${found.userId} · ${accountSummary(found).schedule}。凭据只显示是否保存，不回显；这次读取不证明原请求已经结束。`
            : '本次列表中未找到匹配账号；原请求仍可能在处理中。请稍后再读，不要直接重复保存。';
        } else get('accounts-status').textContent = note;
      } else if (recovered) {
        error('');
      }
    } catch (cause) {
      loadErrorShown = true;
      get('accounts-status').textContent = loadFailureMessage({ loaded: hasLoaded, at: hasLoaded ? lastLoadedAt : undefined });
      error(cause?.safe && cause.message ? cause.message : '无法读取本地账号列表。配置会话可能已超时，请重新打开配置页或检查账号文件权限。');
      get('accounts-retry').hidden = false;
      if (!hasLoaded) {
        accounts = [];
        connections = [];
        connectionResults = {};
        get('account-empty').hidden = true;
        get('accounts-table-scroll').hidden = true;
        get('accounts-table').hidden = true;
        get('account-totals').replaceChildren();
        renderConnections();
        get('connection-balance-status').textContent = '连接列表尚未读取；请先重新读取账号列表。';
      }
    } finally {
      loading = false;
      syncControls();
    }
  }

  get('account-new').addEventListener('click', () => edit());
  get('editor-close').addEventListener('click', () => {
    if (running) return;
    if (unknownOutcome) {
      if (!confirmUnknownLeave()) return;
      editor.close();
      return;
    }
    if (isEditorDirty() && !confirmDiscard()) return;
    editor.close();
  });
  get('history-close').addEventListener('click', () => history.close());
  get('auth-mode').addEventListener('change', credentialFields);
  get('site-type').addEventListener('change', credentialFields);
  get('schedule-enabled').addEventListener('change', scheduleFields);
  get('accounts-retry').addEventListener('click', () => { if (!running && !loading) void load(); });
  get('editor-recheck').addEventListener('click', () => { if (!running && !loading) void load(); });
  get('accounts-ack').addEventListener('click', acknowledgeUnknown);
  get('editor-ack').addEventListener('click', acknowledgeUnknown);
  get('refresh-all').addEventListener('click', () => perform('refresh'));
  get('checkin-all').addEventListener('click', () => perform('checkin'));
  get('connection-refresh-all').addEventListener('click', async () => {
    if (running || unknownOutcome) return;
    busy(true); error('');
    try {
      await refreshConnections();
    } catch {
      error('连接 Key 用量刷新未完成，请稍后重试。');
    } finally {
      busy(false);
    }
  });
  get('account-form').addEventListener('input', (event) => {
    const target = event.target;
    if (target && typeof target.matches === 'function' && target.matches('[aria-invalid]')) {
      target.removeAttribute('aria-invalid');
      target.removeAttribute('aria-errormessage');
      get(`${target.id}-error`)?.remove();
    }
    updateEditorDirty();
  });
  get('account-form').addEventListener('change', updateEditorDirty);
  editor.addEventListener('cancel', (event) => {
    if (running) {
      event.preventDefault();
      error('正在处理，完成后才能关闭账号编辑。', true);
      return;
    }
    if (unknownOutcome) {
      if (!confirmUnknownLeave()) event.preventDefault();
      return;
    }
    if (isEditorDirty() && !confirmDiscard()) event.preventDefault();
  });
  editor.addEventListener('close', () => {
    editing = undefined;
    editorBaseline = undefined;
    get('access-token').value = '';
    get('account-cookie').value = '';
    clearFieldErrors();
    error('', true);
    updateEditorDirty();
    syncControls();
  });
  document.addEventListener('click', (event) => {
    const link = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[href]') : null;
    if (!link) return;
    if (running) {
      event.preventDefault();
      get('accounts-status').textContent = '操作进行中，完成后才能离开此页面。';
      return;
    }
    if (unknownOutcome) {
      if (!confirmUnknownLeave()) { event.preventDefault(); return; }
      allowUnload = true;
      window.setTimeout(() => { allowUnload = false; }, 1000);
      return;
    }
    if (isEditorDirty()) {
      if (!confirmDiscard()) { event.preventDefault(); return; }
      allowUnload = true;
      window.setTimeout(() => { allowUnload = false; }, 1000);
    }
  }, true);
  window.addEventListener('beforeunload', (event) => {
    if (allowUnload || (!running && !unknownOutcome && !isEditorDirty())) return;
    event.preventDefault();
    event.returnValue = '';
  });
  get('account-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running || unknownOutcome) return;
    const values = fields();
    const missing = accountFieldErrors(values, editing?.secrets ?? {});
    if (Object.keys(missing).length) {
      error('请补充或修正标记的字段。', true);
      markFieldErrors(missing);
      return;
    }
    busy(true); error('', true); clearFieldErrors();
    const result = await requestAccountAction(fetch.bind(globalThis), 'save', accountPayload(values));
    if (result.ok) {
      editor.close();
      await load();
      busy(false);
      return;
    }
    error(result.fields ? Object.values(result.fields).join('；') : result.error, true);
    if (result.fields) markFieldErrors(result.fields);
    if (result.unknown) {
      unknownOutcome = { action: 'save', id: editing?.id ?? null };
      reconciled = false;
      error(`${result.error} 请点击“重新读取账号列表”核对结果，不要直接重复保存。`, true);
      get('accounts-retry').hidden = false;
    }
    busy(false);
  });
  get('accounts-done').addEventListener('click', async () => {
    if (running || unknownOutcome) return;
    busy(true); error('');
    get('accounts-status').textContent = '正在完成并关闭…';
    const result = await requestAccountAction(fetch.bind(globalThis), 'done', {});
    if (result.ok) {
      busy(false);
      allowUnload = true;
      get('accounts-shell').hidden = true;
      get('accounts-completion').hidden = false;
      setTimeout(() => { try { window.close(); } catch {} }, 250);
      return;
    }
    error(result.error);
    if (result.unknown) {
      unknownOutcome = { action: 'done', id: null };
      reconciled = false;
      get('accounts-status').textContent = '关闭结果未知：配置可能已经结束。请重新读取账号列表核对，确认后再关闭页面。';
      get('accounts-retry').hidden = false;
    }
    busy(false);
  });
  busy(false);
  await load();
}

if (typeof document !== 'undefined') void initializeAccounts();