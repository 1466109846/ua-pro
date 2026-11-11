import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { scheduleOccurrence, scheduleDate } from './schedule.mjs';

const schedulers = new Map();

function identityOf(account) {
  const url = new URL(account.siteUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}\n${account.userId}`;
}

export function createCheckinScheduler({
  accountManager,
  stateDirectory,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onError = () => {},
  io = fs,
} = {}) {
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory)) throw new Error('签到调度记录必须使用绝对路径');
  let timer;
  let active;

  async function claim(identity, occurrence, at) {
    await io.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const info = await io.lstat(stateDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('签到调度目录无效');
    const digest = createHash('sha256').update(identity).digest('hex');
    const path = join(stateDirectory, `${occurrence.date}-${digest}.json`);
    const lockPath = join(stateDirectory, `${digest}.lock`);
    const lastPath = join(stateDirectory, `${digest}.last.json`);
    const temporary = join(stateDirectory, `${digest}-${randomUUID()}.tmp`);
    let lock, file;
    try {
      lock = await io.open(lockPath, 'wx', 0o600);
      try {
        const stat = await io.lstat(lastPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new Error('调度状态无效');
        const last = JSON.parse(await io.readFile(lastPath, 'utf8'));
        const previousAt = Date.parse(last.at);
        if (!Number.isFinite(previousAt) || typeof last.timeZone !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(last.date) || scheduleDate(previousAt, last.timeZone) !== last.date) throw new Error('调度状态无效');
        if (previousAt > at || scheduleDate(previousAt, occurrence.timeZone) === occurrence.date ||
          scheduleDate(at, last.timeZone) === last.date) return false;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      file = await io.open(path, 'wx', 0o600);
      const content = JSON.stringify({ at: new Date(at).toISOString(), ...occurrence });
      await file.writeFile(content, 'utf8');
      await file.sync();
      await file.close(); file = undefined;
      await io.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await io.rename(temporary, lastPath);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      await file?.close();
      if (lock) {
        await lock.close();
        await io.unlink(lockPath);
        await io.unlink(temporary).catch(() => {});
      }
    }
  }

  async function run() {
    const attempted = [], errors = [];
    let accounts;
    try { ({ accounts } = await accountManager.list()); }
    catch { return { attempted, error: '无法读取账号，未执行定时签到' }; }
    const identities = new Set();
    const due = accounts.filter((account) => {
      if (!account.enabled || !account.checkinEnabled || !account.schedule?.enabled) return false;
      try {
        const occurrence = scheduleOccurrence(account.schedule, Number(now()));
        if (!occurrence) return false;
        const identity = identityOf(account);
        if (accounts.some((other) => {
          const checkedAt = Date.parse(other.checkin?.checkedAt);
          return Number.isFinite(checkedAt) && identityOf(other) === identity && scheduleDate(checkedAt, occurrence.timeZone) === occurrence.date;
        })) return false;
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
      } catch { errors.push(account.id); return false; }
    });
    let next = 0;
    async function worker() {
      while (next < due.length) {
        const account = due[next++];
        const at = Number(now());
        try {
          const occurrence = scheduleOccurrence(account.schedule, at);
          if (!occurrence || !await claim(identityOf(account), occurrence, at)) continue;
          attempted.push(account.id);
          const result = await accountManager.checkin(account.id, { expectedRevision: account.revision });
          if (['error', 'failed'].includes(result?.checkin?.state)) errors.push(account.id);
        } catch { errors.push(account.id); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, due.length) }, worker));
    return { attempted, ...(errors.length ? { error: '部分自动签到未执行或未完成，请检查账号记录与调度目录权限；不会自动重试', accounts: errors } : {}) };
  }

  function tick() {
    if (active) return active;
    active = run().finally(() => { active = undefined; });
    return active;
  }

  function start() {
    if (timer !== undefined) return;
    timer = setIntervalImpl(async () => {
      try {
        const result = await tick();
        if (result.error) await onError(result.error);
      } catch { /* A reporting failure must not repeat a check-in. */ }
    }, 15000);
    timer.unref?.();
  }

  function stop() {
    if (timer !== undefined) clearIntervalImpl(timer);
    timer = undefined;
  }

  return { start, stop, tick };
}

export function ensureCheckinScheduler(options) {
  const path = resolve(options.stateDirectory);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  if (!schedulers.has(key)) {
    const scheduler = createCheckinScheduler(options);
    schedulers.set(key, scheduler);
    scheduler.start();
  }
  return schedulers.get(key);
}
