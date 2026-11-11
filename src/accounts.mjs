import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { AccountValidationError, createNewApiClient, NewApiError, normalizeAccountConfig, safeNewApiMessage } from './newapi.mjs';
import { scheduleOccurrence } from './schedule.mjs';

export { AccountValidationError } from './newapi.mjs';
const MAX_ACCOUNTS = 100;
const MAX_HISTORY = 90;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// All managers sharing a file share the transaction queue and network deduplication.
const sessions = new Map();
const freshStatus = () => ({ stale: false, error: null, lastAttemptAt: null });
const freshCheckin = () => ({ date: null, checkedAt: null, rewardQuota: null, state: 'unknown', message: '' });
const identity = a => JSON.stringify([a.siteUrl, a.userId]);
const missing = () => new AccountValidationError('账号不存在。', 404);
const own = (state, id) => { const account = state.accounts.find(a => a.id === id); if (!account) throw missing(); return account; };
const successful = result => ['success', 'already', 'already_checked'].includes(result?.state);
const day = value => new Date(value).toISOString().slice(0, 10);
const amount = (quota, divisor) => quota === null || quota === undefined || !Number.isFinite(quota / divisor) ? null : quota / divisor;

function projectSnapshot(snapshot, divisor) {
  if (!snapshot) return null;
  return { at: snapshot.at, quota: snapshot.quota, usedQuota: snapshot.usedQuota, requestCount: snapshot.requestCount,
    remaining: amount(snapshot.quota, divisor), used: amount(snapshot.usedQuota, divisor),
    deltaBalance: amount(snapshot.deltaQuota, divisor), deltaUsed: amount(snapshot.deltaUsedQuota, divisor),
    deltaRequests: snapshot.deltaRequests, reset: snapshot.reset };
}

function publicAccount(account) {
  const config = normalizeAccountConfig(account);
  return { id: account.id, revision: account.revision, ...config, accessToken: '', cookie: '', secrets: { accessToken: Boolean(account.accessToken), cookie: Boolean(account.cookie) },
    snapshot: projectSnapshot(account.snapshot, account.quotaPerUnit),
    history: account.history.map(item => projectSnapshot(item, account.quotaPerUnit)),
    status: { ...account.status },
    checkin: { date: account.checkin.date, checkedAt: account.checkin.checkedAt, rewardQuota: account.checkin.rewardQuota,
      reward: amount(account.checkin.rewardQuota, account.quotaPerUnit), state: account.checkin.state, message: account.checkin.message } };
}

function totalsFor(accounts) {
  const groups = new Map();
  for (const account of accounts) {
    if (!groups.has(account.unit)) groups.set(account.unit, []);
    groups.get(account.unit).push(account);
  }
  return Object.fromEntries([...groups].map(([unit, configured]) => {
    const unique = new Map();
    for (const account of configured) {
      const previous = unique.get(identity(account));
      // Prefer a current successful snapshot; aliases never multiply money.
      if (!previous || !previous.snapshot && account.snapshot || previous.status.stale && !account.status.stale && account.snapshot || previous.status.stale === account.status.stale && (account.snapshot?.at ?? '') > (previous.snapshot?.at ?? '')) unique.set(identity(account), account);
    }
    const entries = [...unique.values()];
    const available = entries.filter(a => a.snapshot);
    const total = key => {
      if (!available.length || available.some(a => a.snapshot[key] === null)) return null;
      const value = available.reduce((sum, a) => sum + a.snapshot[key], 0);
      return Number.isFinite(value) ? value : null;
    };
    const delta = key => available.length === entries.length && entries.every(a => !a.status.stale && a.snapshot[key] !== null) ? total(key) : null;
    return [unit, { remaining: total('remaining'), used: total('used'), deltaBalance: delta('deltaBalance'), deltaUsed: delta('deltaUsed'),
      accountCount: entries.length, configuredCount: configured.length, availableCount: available.length, staleCount: entries.filter(a => a.status.stale).length }];
  }));
}

/** Independent accounts.json; all methods are async, and no network occurs on CRUD. */
export function createAccountManager({ path, fetchImpl, now = () => new Date(), uuid = randomUUID, client } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new AccountValidationError('账号文件必须使用绝对路径。');
  path = resolve(path);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  if (!sessions.has(key)) sessions.set(key, { tail: Promise.resolve(), refreshes: new Map(), checkins: new Map() });
  const session = sessions.get(key);
  const api = client ?? createNewApiClient({ fetchImpl, now });
  const timestamp = () => new Date(now()).toISOString();
  const locked = task => {
    const result = session.tail.then(task, task);
    session.tail = result.catch(() => {});
    return result;
  };

  async function read() {
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error();
      const state = JSON.parse(await readFile(path, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.accounts) || state.accounts.length > MAX_ACCOUNTS) throw new Error();
      const ids = new Set();
      for (const account of state.accounts) {
        if (!account || typeof account.id !== 'string' || !account.id || ids.has(account.id) || typeof account.revision !== 'string' || !Array.isArray(account.history) || account.history.length > MAX_HISTORY || !account.status || !account.checkin) throw new Error();
        Object.assign(account, normalizeAccountConfig(account));
        ids.add(account.id);
      }
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, accounts: [] };
      throw new AccountValidationError('账号文件无法读取。', 500);
    }
  }

  async function write(state) {
    let temporary; let handle;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      temporary = `${path}.${randomUUID()}.tmp`;
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state, null, 2), 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, path); temporary = null;
    } catch { throw new AccountValidationError('账号文件无法保存。', 500); }
    finally { if (handle) await handle.close().catch(() => {}); if (temporary) await unlink(temporary).catch(() => {}); }
  }

  async function list() {
    return locked(async () => { const accounts = (await read()).accounts.map(publicAccount); return { accounts, totals: totalsFor(accounts) }; });
  }
  async function get(id) { return locked(async () => publicAccount(own(await read(), id))); }

  async function save(raw, clearSecrets = []) {
    if (!Array.isArray(clearSecrets) || clearSecrets.some(name => !['accessToken', 'cookie'].includes(name))) throw new AccountValidationError('清除凭据的字段无效。');
    const config = normalizeAccountConfig(raw);
    return locked(async () => {
      const state = await read();
      const previous = raw.id === undefined ? null : own(state, raw.id);
      if (!previous && state.accounts.length >= MAX_ACCOUNTS) throw new AccountValidationError('最多保存 100 个账号。', 409);
      if (config.schedule.enabled && state.accounts.some(account => account !== previous
        && identity(account) === identity(config) && account.schedule.enabled)) {
        throw new AccountValidationError('自动签到设置冲突。', 400, {
          'schedule.enabled': '同一站点账号的别名只能设置一份自动签到，请先关闭另一份',
        });
      }
      const unchangedIdentity = previous && identity(previous) === identity(config);
      for (const secret of ['accessToken', 'cookie']) config[secret] = config[secret] || (!unchangedIdentity || clearSecrets.includes(secret) ? '' : previous?.[secret] ?? '');
      const account = { ...config, id: previous?.id ?? uuid(), revision: randomUUID(),
        snapshot: unchangedIdentity ? previous.snapshot : null,
        history: unchangedIdentity ? previous.history : [],
        status: unchangedIdentity ? previous.status : freshStatus(),
        checkin: unchangedIdentity ? previous.checkin : freshCheckin() };
      if (typeof account.id !== 'string' || !account.id || state.accounts.some(a => a.id === account.id && a !== previous)) throw new AccountValidationError('无法创建唯一账号 ID。', 409);
      if (previous) state.accounts[state.accounts.indexOf(previous)] = account;
      else state.accounts.push(account);
      await write(state);
      return publicAccount(account);
    });
  }

  async function remove(id) {
    return locked(async () => { const state = await read(); own(state, id); state.accounts = state.accounts.filter(a => a.id !== id); await write(state); return { removed: true }; });
  }

  async function performRefresh(captured) {
    const at = timestamp();
    let reading; let failure;
    try {
      reading = await api.balance({ ...captured });
      if (!reading || !Number.isSafeInteger(reading.quota) || !Number.isSafeInteger(reading.usedQuota) || reading.usedQuota < 0 || !Number.isSafeInteger(reading.requestCount) || reading.requestCount < 0) throw new NewApiError('response');
    } catch (error) { failure = safeNewApiMessage(error); }
    return locked(async () => {
      const state = await read(); const current = own(state, captured.id);
      if (current.revision !== captured.revision || identity(current) !== identity(captured)) return publicAccount(current);
      current.status = { lastAttemptAt: at, stale: Boolean(failure), error: failure ?? null };
      if (!failure) {
        const prior = current.snapshot;
        const usedReset = Boolean(prior && reading.usedQuota < prior.usedQuota);
        const requestReset = Boolean(prior && reading.requestCount < prior.requestCount);
        current.snapshot = { at: reading.at && Number.isFinite(Date.parse(reading.at)) ? new Date(reading.at).toISOString() : at,
          quota: reading.quota, usedQuota: reading.usedQuota, requestCount: reading.requestCount,
          deltaQuota: prior ? reading.quota - prior.quota : null,
          deltaUsedQuota: prior && !usedReset ? reading.usedQuota - prior.usedQuota : null,
          deltaRequests: prior && !requestReset ? reading.requestCount - prior.requestCount : null,
          reset: usedReset || requestReset };
        current.history = [...current.history, current.snapshot].slice(-MAX_HISTORY);
      }
      await write(state);
      return publicAccount(current);
    });
  }

  async function refresh(id) {
    const captured = await locked(async () => structuredClone(own(await read(), id)));
    if (!captured.enabled) return publicAccount(captured);
    const requestKey = `${id}:${captured.revision}`;
    if (!session.refreshes.has(requestKey)) {
      const pending = performRefresh(captured).finally(() => { if (session.refreshes.get(requestKey) === pending) session.refreshes.delete(requestKey); });
      session.refreshes.set(requestKey, pending);
    }
    return session.refreshes.get(requestKey);
  }

  function checkinResult(result, at) {
    const states = ['success', 'already', 'disabled', 'requires_verification', 'unknown', 'error'];
    const state = result?.state === 'already_checked' ? 'already' : states.includes(result?.state) ? result.state : 'error';
    const validDate = /^\d{4}-\d{2}-\d{2}$/u.test(result?.date ?? '') && Number.isFinite(Date.parse(result.date)) && day(result.date) === result.date;
    const messages = { success: '签到成功。', already: '今日已签到。', disabled: '站点未启用签到。', requires_verification: '请前往站点完成验证码后签到。', unknown: '签到结果未确认，请在站点确认记录；不会自动重试。', error: '签到未完成，请前往站点检查。' };
    return { date: successful({ state }) ? validDate ? result.date : day(at) : null,
      checkedAt: successful({ state }) ? at : null,
      rewardQuota: successful({ state }) && Number.isSafeInteger(result.rewardQuota) && result.rewardQuota >= 0 ? result.rewardQuota : null,
      state, message: messages[state],
      // Returned site dates are authoritative; UTC is the explicit fallback when absent.
      dedupeDay: successful({ state }) ? day(at) : null };
  }

  async function performCheckin(captured, aliases, options) {
    const at = timestamp(); let result;
    try { result = checkinResult(await api.checkin({ ...captured }, options), at); }
    catch (error) {
      const code = error instanceof NewApiError ? error.code : null;
      const state = code === 'turnstile' ? 'requires_verification' : code === 'ambiguous' ? 'unknown' : 'error';
      result = { ...checkinResult({ state }, at), message: safeNewApiMessage(error) };
    }
    const updated = await locked(async () => {
      const state = await read(); const initiator = state.accounts.find(a => a.id === captured.id);
      if (!initiator || initiator.revision !== captured.revision) return false;
      for (const alias of aliases) {
        const current = state.accounts.find(a => a.id === alias.id);
        if (current && current.revision === alias.revision && identity(current) === identity(captured)) current.checkin = { ...result };
      }
      await write(state); return true;
    });
    if (updated && successful(result)) {
      // A later refresh failure only marks the balance stale, never changes checkin success.
      for (const alias of aliases) {
        try {
          const current = await locked(async () => own(await read(), alias.id));
          if (current.revision === alias.revision) await refresh(alias.id);
        } catch { /* A removed alias or a failed refresh cannot undo a confirmed checkin. */ }
      }
    }
  }

  async function checkin(id, { turnstileToken, expectedRevision } = {}) {
    const selection = await locked(async () => {
      const state = await read(); const captured = own(state, id);
      if (expectedRevision !== undefined) {
        if (expectedRevision !== captured.revision) throw new AccountValidationError('账号配置已更改，本次自动签到已取消。', 409);
        if (!captured.schedule.enabled || !scheduleOccurrence(captured.schedule, new Date(now()))) {
          throw new AccountValidationError('自动签到已关闭或已错过指定时间，本次未执行。', 409);
        }
      }
      if (!captured.enabled || !captured.checkinEnabled) return { skip: publicAccount(captured) };
      // Check the current id/revision before joining; identity, not revision, deduplicates POSTs.
      const requestKey = identity(captured);
      if (session.checkins.has(requestKey)) return { pending: session.checkins.get(requestKey) };
      const sameIdentity = state.accounts.filter(a => identity(a) === identity(captured));
      const known = sameIdentity.find(a => successful(a.checkin) && (a.checkin.dedupeDay ?? a.checkin.date) === day(timestamp()));
      if (known && !api.authoritativeCheckinDay) {
        if (captured !== known) { captured.checkin = { ...known.checkin }; await write(state); }
        return { skip: publicAccount(captured) };
      }
      const aliases = sameIdentity.filter(a => a.enabled && a.checkinEnabled).map(a => ({ id: a.id, revision: a.revision }));
      const pending = performCheckin(structuredClone(captured), aliases, { turnstileToken }).finally(() => {
        if (session.checkins.get(requestKey) === pending) session.checkins.delete(requestKey);
      });
      session.checkins.set(requestKey, pending);
      // Do not await network while holding the file transaction queue.
      return { pending };
    });
    if (selection.skip) return selection.skip;
    await selection.pending;
    return get(id);
  }

  async function refreshAll() {
    const { accounts } = await list();
    for (const account of accounts.filter(a => a.enabled)) {
      try { await refresh(account.id); } catch { /* Isolate deletion and individual account failures. */ }
    }
    return list();
  }
  async function checkinAll() {
    const { accounts } = await list();
    const attempted = new Set();
    for (const account of accounts.filter(a => a.enabled && a.checkinEnabled)) {
      const key = identity(account);
      if (attempted.has(key)) continue;
      attempted.add(key);
      try { await checkin(account.id); } catch { /* Continue the explicitly requested batch. */ }
    }
    return list();
  }
  return { list, get, save, remove, refresh, checkin, refreshAll, checkinAll };
}
