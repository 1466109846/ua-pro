import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
const nativeWrites = new Map();
const unscopedQueue = Symbol('native-account-writes');
import { AUTH_MARKER, connectionProfile } from './connection.mjs';
import { createDefaultProfile, mergeProfileSecrets, ProfileValidationError, redactProfile, VARIABLE_DEFINITIONS } from './profile.mjs';
function requireNativeAuth(auth) {
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim() || auth.key.trim() === AUTH_MARKER) throw new ProfileValidationError({ 'upstream.apiKey': '请先选择已配置密钥的原生 API 账号' });
}
/** Session-only drafts; writes are confined to the injected native account slot. */
export function createAccountProfileStore({ auth, savedProfile = null, provider = {}, defaults, path, readAuth, writeAuth }) {
  requireNativeAuth(auth);
  let currentAuth = structuredClone(auth);
  let profile = connectionProfile(savedProfile, currentAuth, provider, defaults);
  const queueKey = typeof path === 'string' ? (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)) : unscopedQueue;
  async function load() { return structuredClone(profile); }
  function getAuth() { return structuredClone(currentAuth); }
  async function verifyCurrentAuth() {
    if (!readAuth) return;
    let latest;
    try { latest = await readAuth(); }
    catch { throw new Error('无法读取当前账号，请重新打开配置后重试'); }
    if (!isDeepStrictEqual(latest, currentAuth)) throw new Error('当前账号已发生变化，请重新打开配置后重试');
  }
  async function prepareFromUi(raw, clearSecrets = []) {
    await verifyCurrentAuth();
    const draft = mergeProfileSecrets(raw, profile, clearSecrets);
    requireNativeAuth({ type: 'api', key: draft.upstream.apiKey });
    if (draft.upstream.apiKey !== profile.upstream.apiKey) {
      // Changing the host key starts a new credential scope; old endpoint-specific extras cannot follow silently.
      const old = profile.headers.extra.filter(item => item.enabled !== false);
      const retained = draft.headers.extra.some(item => item.enabled !== false && old.some(entry => entry.name.toLowerCase() === item.name.toLowerCase() && entry.value === item.value));
      if (retained) throw new ProfileValidationError({ 'headers.extra': 'API key 已改变，请移除旧凭据的附加请求头' });
      const baseline = createDefaultProfile().headers;
      const fields = {};
      for (const [field, value] of Object.entries(draft.headers)) {
        if (typeof value === 'string' && value.trim() && value !== baseline[field] && value === profile.headers[field]) {
          fields[`headers.${field}`] = 'API key 已改变，请移除旧凭据的专用请求头';
        }
      }
      if (Object.keys(fields).length) throw new ProfileValidationError(fields);
      if (draft.upstream.authorizationValue && draft.upstream.authorizationValue === profile.upstream.authorizationValue) {
        throw new ProfileValidationError({ 'upstream.authorizationValue': 'API key 已改变，请重新填写对应的 Authorization 或切换授权模式' });
      }
    }
    return draft;
  }
  async function saveFromUi(raw, clearSecrets = []) {
    const input = structuredClone(raw); const clears = structuredClone(clearSecrets);
    const result = (nativeWrites.get(queueKey) ?? Promise.resolve()).then(async () => {
      const nextProfile = await prepareFromUi(input, clears);
      const nextAuth = structuredClone(currentAuth);
      nextAuth.key = nextProfile.upstream.apiKey;
      nextAuth.metadata = { ...nextAuth.metadata, baseURL: nextProfile.upstream.baseUrl, endpoint: nextProfile.upstream.baseUrl, claudeProfile: structuredClone(nextProfile) };
      nextAuth.metadata.claudeProfile.upstream.apiKey = '';
      await verifyCurrentAuth();
      try { await writeAuth(structuredClone(nextAuth)); }
      catch { throw new Error('账号配置保存失败，请重试；当前会话配置保留'); }
      currentAuth = nextAuth; profile = nextProfile;
      return structuredClone(profile);
    });
    const next = result.catch(() => {});
    nativeWrites.set(queueKey, next);
    next.finally(() => { if (nativeWrites.get(queueKey) === next) nativeWrites.delete(queueKey); });
    return result;
  }
  async function publicInfo() {
    return { profile: redactProfile(profile), configured: true,
      secrets: { apiKey: Boolean(profile.upstream.apiKey), authorizationValue: Boolean(profile.upstream.authorizationValue) },
      variables: VARIABLE_DEFINITIONS, storagePath: path };
  }
  return { path, load, prepareFromUi, saveFromUi, publicInfo, getAuth };
}
