import { createHash } from 'node:crypto';
import { createDefaultProfile, normalizeProfile, targetOf } from './profile.mjs';
import { buildHeaders } from './headers.mjs';

export const AUTH_MARKER = 'magpie-claude-profile-configured';
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const sameTarget = (left, right) => targetOf(left) !== null && targetOf(left) === targetOf(right);

/** defaults contains explicit global options only; credentials always come from the account or same-target saved profile. */
export function connectionProfile(saved, auth, provider = {}, defaults) {
  const key = auth?.type === 'api' && text(auth.key) !== AUTH_MARKER ? text(auth.key) : undefined;
  const endpoint = text(auth?.metadata?.baseURL) ?? text(auth?.metadata?.endpoint) ?? text(auth?.endpoint) ??
    text(provider.options?.baseURL) ?? text(provider.api) ?? text(provider.api?.url) ?? text(saved?.upstream?.baseUrl) ?? text(defaults?.upstream?.baseUrl);
  const candidate = key ? auth?.metadata?.claudeProfile : undefined;
  const scoped = candidate && sameTarget(endpoint, candidate.upstream?.baseUrl) ? candidate : undefined;
  // A native key change is a separate connection, even at the same host and path.
  const inherit = saved && sameTarget(endpoint, saved.upstream?.baseUrl) && (!key || saved.upstream?.apiKey === key);
  const source = scoped ?? (inherit ? saved : undefined);
  const base = createDefaultProfile();
  const global = defaults ? normalizeProfile(defaults, { allowBlank: true }) : undefined;
  const profile = structuredClone(source ?? global ?? base);
  if (source && global) {
    profile.client = { ...global.client, ...source.client };
    profile.headers = { ...global.headers, ...source.headers, extra: [...global.headers.extra, ...(source.headers?.extra ?? [])] };
    profile.parameters = { ...global.parameters, ...source.parameters };
    profile.models = source.models ?? global.models;
  }
  profile.upstream = { ...base.upstream, ...(source?.upstream ?? {}), baseUrl: endpoint ?? '' };
  if (key) {
    profile.upstream.apiKey = key;
    // Only account-scoped modes are explicit for native auth. Native default is x-api-key.
    profile.upstream.authorizationMode = scoped?.upstream?.authorizationMode ?? 'api-key';
    profile.upstream.authorizationValue = scoped?.upstream?.authorizationValue ?? '';
  }
  return normalizeProfile(profile);
}

export function modelRecords(profile, ids = profile.models, existing = {}) {
  const npm = '@ai-sdk/anthropic';
  return Object.fromEntries([...new Set(ids)].map(id => [id, {
    ...(existing[id] ?? {}), name: existing[id]?.name ?? id,
    api: { id: existing[id]?.api?.id ?? existing[id]?.id ?? id, url: profile.upstream.baseUrl, npm, ...(existing[id]?.api ?? {}) },
    provider: { npm, api: profile.upstream.baseUrl, ...(existing[id]?.provider ?? {}) },
  }]));
}
export class ModelDiscoveryError extends Error {
  constructor(code, httpStatus) {
    super(code === 'unauthorized' ? '模型列表拒绝了当前 API key，请重新登录' : '无法自动获取模型，请检查地址和 API key；也可在可选高级设置中填写模型 ID');
    this.name = 'ModelDiscoveryError'; this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (code === 'unauthorized') this.signIn = 'expired';
  }
}
function responseErrorCode(status) {
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 405) return 'unsupported-list';
  if (status === 429) return 'rate-limited';
  if (status >= 500 && status < 600) return 'upstream-error';
  return status >= 200 && status < 300 ? 'invalid-response' : 'http-error';
}
async function requestModelRecords(profile, { fetchImpl, timeoutMs, requireStatus200 }) {
  const url = `${profile.upstream.baseUrl.replace(/\/+$/, '')}/models`;
  const headers = buildHeaders({ profile, stream: false });
  for (const name of ['x-claude-code-session-id', 'session-id', 'x-client-request-id', 'x-request-id', 'request-id']) headers.delete(name);
  headers.set('accept', 'application/json');
  const controller = new AbortController();
  let timeout, response, httpStatus, reader, cancelled = false;
  const cancel = () => {
    const body = reader ?? response?.body;
    if (!body || cancelled) return;
    cancelled = true;
    try { void Promise.resolve(body.cancel()).catch(() => {}); } catch {}
  };
  const release = () => { try { reader?.releaseLock(); } catch {} reader = undefined; };
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => { reject(new ModelDiscoveryError('timeout', httpStatus)); controller.abort(); cancel(); release(); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      try { response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal }); }
      catch { throw new ModelDiscoveryError('network'); }
      if (controller.signal.aborted) { cancel(); throw new ModelDiscoveryError('timeout'); }
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) httpStatus = response.status;
      if (response.redirected || (response.url && response.url !== url)) throw new ModelDiscoveryError('redirect', httpStatus);
      if (!response.ok || (requireStatus200 && response.status !== 200)) throw new ModelDiscoveryError(responseErrorCode(response.status), httpStatus);
      if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new ModelDiscoveryError('too-large', httpStatus);
      reader = response.body?.getReader();
      if (!reader) throw new ModelDiscoveryError('invalid-shape', httpStatus);
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new ModelDiscoveryError('timeout', httpStatus);
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new ModelDiscoveryError('too-large', httpStatus);
        chunks.push(Buffer.from(value));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ModelDiscoveryError('invalid-json', httpStatus); }
      if (!Array.isArray(data?.data)) throw new ModelDiscoveryError('invalid-shape', httpStatus);
      const entries = data.data.filter(item => typeof item?.id === 'string' && item.id.trim() && !/[\u0000-\u001f\u007f]/.test(item.id)).slice(0, 2000);
      if (!entries.length) throw new ModelDiscoveryError('empty-model-list', httpStatus);
      const existing = Object.fromEntries(entries.map(item => {
        const model = { name: text(item.display_name) ?? text(item.name) ?? item.id };
        const context = item.limit?.context ?? item.context_window ?? item.context_length ?? item.max_context_tokens;
        const output = item.limit?.output ?? item.max_output_tokens;
        const limit = {};
        if (Number.isSafeInteger(context) && context > 0) limit.context = context;
        if (Number.isSafeInteger(output) && output > 0) limit.output = output;
        if (Object.keys(limit).length) model.limit = limit;
        return [item.id, model];
      }));
      return modelRecords(profile, entries.map(item => item.id), existing);
    })()]);
  } catch (error) {
    cancel();
    if (error instanceof ModelDiscoveryError) throw error;
    throw new ModelDiscoveryError('network', httpStatus);
  } finally { clearTimeout(timeout); release(); }
}
export function createModelDiscovery({ fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 60000, timeoutMs = 15000 } = {}) {
  const cache = new Map(); const pending = new Map();
  return async function discover(raw, { force = false, ignoreConfigured = false, requireStatus200 = false } = {}) {
    const profile = normalizeProfile(raw);
    if (!ignoreConfigured && profile.models.length) return modelRecords(profile);
    if (force) return requestModelRecords(profile, { fetchImpl, timeoutMs, requireStatus200 });
    const key = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return structuredClone(hit.models);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    if (pending.size >= 32) throw new ModelDiscoveryError('rate-limited');
    const task = (async () => {
      const models = await requestModelRecords(profile, { fetchImpl, timeoutMs, requireStatus200 });
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), models }); return models;
    })();
    pending.set(key, task);
    try { return structuredClone(await task); }
    finally { pending.delete(key); }
  };
}
