import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createDefaultProfile, normalizeProfile, redactProfile, mergeProfileSecrets, VARIABLE_DEFINITIONS } from './profile.mjs';
const MAX_CONFIG_BYTES = 256 * 1024;
const writes = new Map();
export function createProfileStore(path, { io = fs } = {}) {
  if (!isAbsolute(path)) throw new Error('配置文件必须使用绝对路径');
  const queueKey = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  async function load() {
    try {
      const info = await io.lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('配置文件必须是普通文件，不能使用符号链接');
      if (info.size > MAX_CONFIG_BYTES) throw new Error('配置文件过大');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.message === '配置文件过大' || error.message.includes('普通文件')) throw error;
      throw new Error('无法读取配置文件，请检查文件权限');
    }
    let content;
    try { content = await io.readFile(path, 'utf8'); }
    catch { throw new Error('无法读取配置文件，请检查文件权限'); }
    try {
      if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new Error();
      return normalizeProfile(JSON.parse(content));
    } catch { throw new Error('配置文件内容无效，请检查 JSON 和配置格式；原文件未被修改'); }
  }
  function enqueue(action) {
    const result = (writes.get(queueKey) ?? Promise.resolve()).then(action);
    const next = result.catch(() => {}); writes.set(queueKey, next);
    next.finally(() => { if (writes.get(queueKey) === next) writes.delete(queueKey); });
    return result;
  }
  async function persist(profile) {
    const normalized = normalizeProfile(profile);
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new Error('配置文件过大');
    const folder = dirname(path); const temporary = join(folder, `.profile-${randomUUID()}.tmp`);
    let handle;
    try {
      await io.mkdir(folder, { recursive: true, mode: 0o700 });
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await io.rename(temporary, path); return normalized;
    } catch { throw new Error('配置保存失败，请检查目录权限与可用空间；原配置保留'); }
    finally { if (handle) await handle.close().catch(() => {}); await io.unlink(temporary).catch(() => {}); }
  }
  async function save(profile) { return enqueue(async () => { await load(); return persist(profile); }); }
  async function prepareFromUi(raw, clearSecrets = []) { return mergeProfileSecrets(raw, await load() ?? createDefaultProfile(), clearSecrets); }
  async function saveFromUi(raw, clearSecrets = []) { return enqueue(async () => persist(await prepareFromUi(raw, clearSecrets))); }
  async function publicInfo() {
    const saved = await load(); const profile = saved ?? createDefaultProfile();
    return { profile: redactProfile(profile), configured: Boolean(saved),
      secrets: { apiKey: Boolean(profile.upstream.apiKey), authorizationValue: Boolean(profile.upstream.authorizationValue) },
      variables: VARIABLE_DEFINITIONS, storagePath: path };
  }
  return { path, load, save, prepareFromUi, saveFromUi, publicInfo };
}
