import { normalizeSchedule, ScheduleValidationError } from './schedule.mjs';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const RESPONSE_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 15000;

export class AccountValidationError extends Error {
  constructor(message = '账号配置无效。', status = 400, fields = {}) {
    super(message);
    this.name = 'AccountValidationError';
    this.status = status;
    this.fields = fields;
  }
}

const ERRORS = Object.freeze({
  timeout: '站点请求超时，请稍后手动重试。',
  network: '无法连接站点，请检查地址与网络。',
  redirect: '站点返回了重定向；为保护凭据，已停止请求。',
  auth: '站点认证失败，请检查系统访问令牌、Cookie 和用户 ID。',
  http: '站点请求失败，请在站点确认服务状态。',
  response: '站点返回了无效的数据。',
  size: '站点响应超过允许大小。',
  identity: '站点返回的用户 ID 与配置不一致，已停止操作。',
  credentials: '请填写所选认证方式对应的系统访问令牌或 Cookie。',
  login_credentials: '请填写 AgentRouter 用户名和密码。',
  disabled: '该账号或签到功能未启用。',
  checkin: '签到未完成，请前往站点检查签到条件。',
  cookie_required: '当前令牌缺少签到权限或站点要求登录 Cookie，请检查令牌权限或改用 Cookie。',
  turnstile: '站点要求验证码，请前往站点完成验证后签到。',
  ambiguous: '签到结果未确认；不会自动重试，请在站点确认记录。',
});

export class NewApiError extends Error {
  constructor(code = 'network', status = null) {
    super(ERRORS[code] ?? ERRORS.network);
    this.name = 'NewApiError';
    this.code = Object.hasOwn(ERRORS, code) ? code : 'network';
    this.status = Number.isInteger(status) ? status : null;
  }
}

/** Only fixed local messages cross the network/client boundary. */
export function safeNewApiMessage(error) {
  return error instanceof NewApiError ? ERRORS[error.code] ?? ERRORS.network : ERRORS.network;
}

/** Keep only the site's session cookie pair; never persist unrelated Set-Cookie values. */
function sessionCookie(headers) {
  const combined = headers.get('set-cookie');
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : combined ? combined.split(/,(?=\s*[^;=,\s]+=)/u) : [];
  for (const value of values) {
    const pair = String(value).split(';')[0].trim();
    const separator = pair.indexOf('=');
    if (separator <= 0 || pair.slice(0, separator).trim().toLowerCase() !== 'session') continue;
    if (CONTROL.test(pair) || pair.length > 32768) continue;
    return pair;
  }
  return null;
}

/** Whitelist the account config; no model-router headers are accepted here. */
export function normalizeAccountConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AccountValidationError();
  const fields = {};
  function text(key, fallback = '', limit = 256) {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'string' || CONTROL.test(value) || value.length > limit) {
      fields[key] = '请输入不含控制字符且长度合理的文本。';
      return '';
    }
    return value.trim();
  }
  function flag(key) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fields[key] = '必须为开关值。';
    return raw[key] === undefined ? true : raw[key] === true;
  }
  const siteType = text('siteType', 'newapi', 16);
  if (!['newapi', 'agentrouter'].includes(siteType)) fields.siteType = '请选择 New API 或 AgentRouter。';
  let siteUrl = text('siteUrl', '', 2048);
  try {
    const url = new URL(siteUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || siteUrl.includes('?') || siteUrl.includes('#') || siteUrl.includes('\\') || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(siteUrl)) throw new Error();
    const loopback = /^127(?:\.\d{1,3}){3}$/u.test(url.hostname) || ['localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
    siteUrl = url.href.replace(/\/+$/u, '');
    if (siteType === 'agentrouter' && url.protocol === 'http:' && !loopback) fields.siteUrl = 'AgentRouter 必须使用 HTTPS 或本机回环地址。';
  } catch { fields.siteUrl = '请输入不含账号、密码、查询参数或片段的 HTTP(S) 站点地址。'; }
  const userId = text('userId', '', 32);
  if (siteType === 'newapi' && !/^[1-9]\d*$/u.test(userId) || siteType === 'agentrouter' && userId && !/^[1-9]\d*$/u.test(userId)) fields.userId = '用户 ID 必须为正整数字符串。';
  const name = text('name', siteType === 'agentrouter' ? 'AgentRouter' : 'New API', 100);
  if (!name) fields.name = '请输入账号名称。';
  const authMode = text('authMode', 'token', 16);
  if (!['token', 'cookie'].includes(authMode)) fields.authMode = '请选择令牌或 Cookie 认证。';
  const username = text('username', '', 256);
  const password = raw.password ?? '';
  if (typeof password !== 'string' || CONTROL.test(password) || password.length > 4096) fields.password = '请输入不含控制字符且长度合理的密钥。';
  const accessToken = text('accessToken', '', 16384);
  const cookie = text('cookie', '', 32768);
  const quotaPerUnit = raw.quotaPerUnit ?? 500000;
  if (typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) fields.quotaPerUnit = '额度倍率必须为有限正数。';
  const unit = text('unit', 'USD', 32);
  if (!unit) fields.unit = '请输入单位标签。';
  const enabled = flag('enabled');
  const checkinEnabled = flag('checkinEnabled');
  let schedule;
  try { schedule = normalizeSchedule(raw.schedule); }
  catch (error) {
    if (!(error instanceof ScheduleValidationError)) throw error;
    const messages = {
      schedule: '请填写有效的自动签到设置。',
      'schedule.enabled': '自动签到必须为开关值。',
      'schedule.time': '请输入 HH:mm 格式的时间，范围为 00:00 至 23:59。',
      'schedule.timeZone': '请选择有效的时区，例如 Asia/Shanghai 或 UTC。',
    };
    for (const field of Object.keys(error.fields)) fields[field] = messages[field] ?? messages.schedule;
  }
  if (Object.keys(fields).length) throw new AccountValidationError('账号配置无效。', 400, fields);
  return { name, enabled, siteUrl, siteType, userId, username, password, authMode, accessToken, cookie, quotaPerUnit, unit, checkinEnabled, schedule };
}

export function createNewApiClient({ fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (typeof fetchImpl !== 'function') throw new AccountValidationError('缺少网络请求实现。');
  const timestamp = () => new Date(now()).toISOString();

  async function request(account, endpoint, { method = 'GET', body, accountAuth = true, cookieJar } = {}) {
    const url = new URL(`${account.siteUrl}${endpoint}`);
    if (url.origin !== new URL(account.siteUrl).origin) throw new NewApiError('redirect');
    const headers = { Accept: 'application/json' };
    if (accountAuth) {
      if (account.siteType === 'agentrouter') {
        if (account.userId) headers['New-Api-User'] = account.userId;
        if (account.authMode === 'token') {
          if (!account.accessToken) throw new NewApiError('credentials');
          headers.Authorization = account.accessToken;
        } else {
          if (!account.cookie) throw new NewApiError('credentials');
          headers.Cookie = account.cookie;
        }
      } else {
        headers['New-Api-User'] = account.userId;
        if (account.authMode === 'token') {
          if (!account.accessToken) throw new NewApiError('credentials');
          headers.Authorization = `Bearer ${account.accessToken}`;
        } else {
          if (!account.cookie) throw new NewApiError('credentials');
          headers.Cookie = account.cookie;
        }
      }
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    let timer;
    let reader;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new NewApiError('timeout'));
      }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url.href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        const rejectResponse = (code, status = response.status) => { void response.body?.cancel().catch(() => {}); throw new NewApiError(code, status); };
        if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== url.origin) rejectResponse('redirect');
        if (response.status === 401 || response.status === 403) rejectResponse('auth');
        if (!response.ok) rejectResponse('http');
        if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) rejectResponse('size');
        if (cookieJar && typeof cookieJar === 'object') {
          const cookie = sessionCookie(response.headers);
          if (cookie) cookieJar.cookie = cookie;
        }
        if (!response.body?.getReader) throw new NewApiError('response');
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) { void reader.cancel().catch(() => {}); throw new NewApiError('size'); }
          chunks.push(Buffer.from(value));
        }
        let result;
        try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
        catch { throw new NewApiError('response'); }
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new NewApiError('response');
        return result;
      })()]);
    } catch (error) {
      if (error instanceof NewApiError) throw error;
      throw new NewApiError(controller.signal.aborted ? 'timeout' : 'network');
    } finally { clearTimeout(timer); }
  }

  async function agentRouterBalance(account) {
    if (!/^[1-9]\d*$/u.test(account.userId)) throw new NewApiError('identity');
    if (account.authMode === 'token' ? !account.accessToken : !account.cookie) throw new NewApiError('credentials');
    const result = await request(account, '/api/user/self');
    if (result.success !== true || !result.data || typeof result.data !== 'object') throw new NewApiError('response');
    const data = result.data;
    const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) ? String(data.id)
      : typeof data.id === 'string' && /^[1-9]\d*$/u.test(data.id) ? data.id : null;
    if (!id || id !== account.userId) throw new NewApiError('identity');
    if (!Number.isSafeInteger(data.quota) || !Number.isSafeInteger(data.used_quota) || data.used_quota < 0) throw new NewApiError('response');
    const requestCount = data.request_count === undefined || data.request_count === null ? 0 : data.request_count;
    if (!Number.isSafeInteger(requestCount) || requestCount < 0) throw new NewApiError('response');
    return { at: timestamp(), quota: data.quota, usedQuota: data.used_quota, requestCount };
  }

  async function balance(raw) {
    const account = normalizeAccountConfig(raw);
    if (account.siteType === 'agentrouter') return agentRouterBalance(account);
    const result = await request(account, '/api/user/self');
    if (result.success !== true || !result.data || typeof result.data !== 'object') throw new NewApiError('response');
    const data = result.data;
    const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) ? String(data.id) : data.id;
    if (typeof id !== 'string' || id !== account.userId) throw new NewApiError('identity');
    if (!Number.isSafeInteger(data.quota) || !Number.isSafeInteger(data.used_quota) || data.used_quota < 0 || !Number.isSafeInteger(data.request_count) || data.request_count < 0) throw new NewApiError('response');
    return { at: timestamp(), quota: data.quota, usedQuota: data.used_quota, requestCount: data.request_count };
  }

  async function agentRouterCheckin(account) {
    if (!account.username || !account.password) throw new NewApiError('login_credentials');
    const cookieJar = {};
    let result;
    try {
      result = await request(account, '/api/user/login', {
        method: 'POST',
        body: { username: account.username, password: account.password },
        accountAuth: false,
        cookieJar,
      });
    } catch (error) {
      if (!(error instanceof NewApiError)) throw new NewApiError('ambiguous');
      if (['credentials', 'identity', 'redirect', 'auth'].includes(error.code)) throw error;
      // A 4xx response is a definite rejection; a 5xx/body/transport failure may
      // have happened after the site completed the login.
      if (error.code === 'http' && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        throw new NewApiError('checkin', error.status);
      }
      throw new NewApiError('ambiguous', error.status);
    }
    if (result.success === false) throw new NewApiError('checkin');
    if (result.success !== true) throw new NewApiError('ambiguous');
    if (!result.data || typeof result.data !== 'object') throw new NewApiError('ambiguous');
    const data = result.data;
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0) throw new NewApiError('identity');
    const discovered = String(data.id);
    if (account.userId && account.userId !== discovered) throw new NewApiError('identity');
    if (data.checked_in !== undefined && data.checked_in !== true && data.checked_in !== false) throw new NewApiError('ambiguous');
    return { state: data.checked_in === true ? 'success' : 'already', date: null, rewardQuota: null,
      userId: discovered, cookie: cookieJar.cookie, authenticated: true };
  }

  async function checkin(raw, { turnstileToken } = {}) {
    const account = normalizeAccountConfig(raw);
    if (!account.enabled || !account.checkinEnabled) throw new NewApiError('disabled');
    if (account.siteType === 'agentrouter') return agentRouterCheckin(account);
    if (turnstileToken !== undefined && (typeof turnstileToken !== 'string' || CONTROL.test(turnstileToken) || turnstileToken.length > 4096)) throw new AccountValidationError('验证码参数无效。');
    await balance(account);
    const site = await request(account, '/api/status');
    if (site.success !== true || !site.data || typeof site.data.turnstile_check !== 'boolean') throw new NewApiError('response');
    if (site.data.checkin_enabled === false) return { state: 'disabled', date: null, rewardQuota: null, checkedAt: null };
    const current = await checkinStatus(account);
    if (current.state !== 'unchecked') return current;
    if (site.data.turnstile_check && !turnstileToken) return { state: 'requires_verification', date: null, rewardQuota: null, checkedAt: null };
    const query = turnstileToken ? `?turnstile=${encodeURIComponent(turnstileToken)}` : '';
    let result;
    try { result = await request(account, `/api/user/checkin${query}`, { method: 'POST', body: {} }); }
    catch (error) {
      if (error.code === 'auth') throw new NewApiError(account.authMode === 'token' ? 'cookie_required' : 'auth');
      if (error.code === 'redirect') throw error;
      // A transport/body/5xx failure can happen after the server committed the POST.
      throw new NewApiError('ambiguous');
    }
    if (result.success === true) return claimed('success', result.data);
    if (result.success === false) {
      // Do not trust translated error text to mean already checked: confirm with GET.
      const confirmed = await checkinStatus(account);
      if (confirmed.state === 'already') return confirmed;
      if (site.data.turnstile_check) return { state: 'requires_verification', date: null, rewardQuota: null, checkedAt: null };
      throw new NewApiError(account.authMode === 'token' ? 'cookie_required' : 'checkin');
    }
    throw new NewApiError('ambiguous');
  }

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }

  function claimed(state, data = {}) {
    const at = timestamp();
    return { state, date: validDate(data?.checkin_date) ? data.checkin_date : at.slice(0, 10),
      checkedAt: at, rewardQuota: Number.isSafeInteger(data?.quota_awarded) && data.quota_awarded >= 0 ? data.quota_awarded : null };
  }

  async function checkinStatus(account) {
    const at = timestamp();
    async function monthStatus(month) {
      let result;
      try { result = await request(account, `/api/user/checkin?month=${month}`); }
      catch (error) { if (error.code === 'auth' && account.authMode === 'token') throw new NewApiError('cookie_required'); throw error; }
      if (result.success !== true) throw new NewApiError(account.authMode === 'token' ? 'cookie_required' : 'checkin');
      if (typeof result.data?.enabled !== 'boolean') throw new NewApiError('response');
      if (result.data.enabled === false) return result.data;
      if (typeof result.data.stats?.checked_in_today !== 'boolean' || !Array.isArray(result.data.stats.records)) throw new NewApiError('response');
      return result.data;
    }
    const status = await monthStatus(at.slice(0, 7));
    if (!status.enabled) return { state: 'disabled', date: null, checkedAt: null, rewardQuota: null };
    if (!status.stats.checked_in_today) return { state: 'unchecked', date: null, checkedAt: null, rewardQuota: null };
    // Site-local days can differ from UTC by a day. Fetch the adjacent month only
    // at a UTC month boundary; the server's checked_in_today remains authoritative.
    const nearbyDates = [-1, 0, 1].map(offset => new Date(Date.parse(at) + offset * 86400000).toISOString().slice(0, 10));
    let records = status.stats.records;
    for (const month of new Set(nearbyDates.map(date => date.slice(0, 7)))) {
      if (month === at.slice(0, 7)) continue;
      const adjacent = await monthStatus(month);
      records = [...records, ...(adjacent.stats?.records ?? [])];
    }
    const todayRecord = records.filter(record => validDate(record?.checkin_date) && nearbyDates.includes(record.checkin_date)).sort((a, b) => b.checkin_date.localeCompare(a.checkin_date))[0];
    // No returned calendar date: document UTC fallback, with unknown reward.
    return claimed('already', todayRecord);
  }

  // The manager must not short-circuit this client's authoritative day check.
  return { balance, checkin, authoritativeCheckinDay: true };
}
