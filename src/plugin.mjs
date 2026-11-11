import { createProfileStore } from './store.mjs';
import { startSetupServer } from './setup-server.mjs';
import { resolveProfilePath } from './runtime.mjs';
import { createUAStore } from './ua-store.mjs';
import { createUAService } from './ua-service.mjs';
import { createTransport } from './transport.mjs';
import { normalizeProfile } from './profile.mjs';
import { connectionProfile, createModelDiscovery, modelRecords, AUTH_MARKER } from './connection.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAccountManager } from './accounts.mjs';
import { ensureCheckinScheduler } from './scheduler.mjs';
import { createConnectionDiagnostics } from './diagnostics.mjs';
import { createAccountProfileStore } from './account-profile.mjs';
import { isDeepStrictEqual } from 'node:util';
import { pluginOptions, optionProfile } from './options.mjs';

export const PROVIDER_ID = 'claude-code-ua';
function modelsFor(profile) {
  return modelRecords(profile);
}

function npmFor(profile) {
  return '@ai-sdk/anthropic';
}

function waitForSetup(session, signal) {
  if (signal?.aborted) return Promise.resolve({ status: 'cancelled' });
  if (!signal) return session.finished;
  return new Promise((resolve, reject) => {
    const abort = () => resolve({ status: 'cancelled' });
    signal.addEventListener('abort', abort, { once: true });
    session.finished.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function createPlugin(input, rawOptions, dependencies = {}) {
  const options = pluginOptions(rawOptions);
  const store = dependencies.store ?? createProfileStore(resolveProfilePath({ configPath: options.profileFile }));
  const startSetup = dependencies.startSetup ?? startSetupServer;
  const accountManager = dependencies.accountManager ?? createAccountManager({ path: join(dirname(store.path), 'accounts.json'), fetchImpl: dependencies.accountFetch ?? globalThis.fetch });
  const seed = optionProfile(options);
  if (input?.magpie) {
    const startScheduler = dependencies.startScheduler ?? ensureCheckinScheduler;
    startScheduler({ accountManager, stateDirectory: join(dirname(store.path), 'schedule-claims'),
      onError: (message) => input.client?.app?.log?.({ body: { service: 'claude-code-ua', level: 'warn', message } }),
    });
  }
  const discoverModels = createModelDiscovery({ fetchImpl: dependencies.fetchImpl ?? globalThis.fetch });
  const checkConnection = createConnectionDiagnostics({ fetchImpl: dependencies.fetchImpl ?? globalThis.fetch });
  const readProfile = async () => {
    const profile = await store.load();
    return profile ? normalizeProfile(profile) : null;
  };
  let declaredProvider = options.baseURL ? { api: seed.upstream.baseUrl } : {};
  let hostModelsExplicit = false;
  let generatedModels = {};
  let activeSetup;
  let startingSetup;
  const contextHeader = `x-magpie-profile-context-${randomBytes(12).toString('hex')}`;
  const contexts = new Map();

  function extractHostContext(headers) {
    const token = headers.get(contextHeader);
    headers.delete(contextHeader);
    const saved = contexts.get(token);
    contexts.delete(token);
    return saved?.value ?? {};
  }

  async function recordConfigured() {
    if (!input?.client?.auth?.set) return;
    await input.client.auth.set({ path: { id: PROVIDER_ID }, body: { type: 'api', key: AUTH_MARKER, metadata: { profileFile: store.path } } });
  }

  async function boundAccount(getAuth) {
    const auth = typeof getAuth === 'function' ? await getAuth() : null;
    const fromAuth = auth?.metadata?.newApiAccountId;
    if (typeof fromAuth === 'string') return fromAuth.trim() || null;
    const slot = input?.magpie?.account?.(PROVIDER_ID);
    return typeof slot === 'string' && Object.hasOwn(options.accountBindings, slot) ? options.accountBindings[slot] : null;
  }

  async function currentHostAuth(account = input?.magpie?.account?.(PROVIDER_ID) ?? PROVIDER_ID) {
    try {
      const all = dependencies.readHostAuth ? await dependencies.readHostAuth() : input?.directory ? JSON.parse(await readFile(join(input.directory, 'plugin-auth.json'), 'utf8')) : {};
      return all[account] ? structuredClone(all[account]) : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('无法读取当前登录信息，已停止操作以保留原凭据');
    }
  }

  async function ensureAuthMarker() {
    if (!input?.client?.auth?.set) return;
    let auth;
    try {
      if (dependencies.readHostAuth) auth = await dependencies.readHostAuth();
      else {
        if (!input.directory) throw new Error();
        auth = JSON.parse(await readFile(join(input.directory, 'plugin-auth.json'), 'utf8'));
      }
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error();
    } catch (error) {
      if (error.code === 'ENOENT') auth = {};
      else throw new Error('无法检查宿主认证记录；拒绝启用 Provider，避免使用 SDK 默认上游');
    }
    if (!Object.hasOwn(auth, PROVIDER_ID)) await recordConfigured();
  }

  const uaStore = dependencies.uaStore ?? createUAStore(join(dirname(store.path), 'ua-pro.json'));
  const uaService = dependencies.uaService ?? createUAService({
    store: uaStore, legacyStore: store,
    readAuth: (provider, account) => currentHostAuth(account || provider),
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });

  async function setupSession() {
    if (activeSetup) return activeSetup;
    if (startingSetup) return startingSetup;
    startingSetup = startSetup({ store, accountManager, checkConnection, uaService, finishOnSave: false }).then((session) => {
      activeSetup = session;
      session.finished.finally(() => {
        if (activeSetup === session) activeSetup = undefined;
      }).catch(() => {});
      return session;
    }).finally(() => { startingSetup = undefined; });
    return startingSetup;
  }

  // The retired first-load option remains accepted, but setup is now explicit.
  // Opening management must never manufacture a signed-in legacy account.

  return {
    async config(config) {
      const profile = await readProfile();
      if (profile) await ensureAuthMarker();
      config.provider ??= {};
      hostModelsExplicit = Object.hasOwn(config.provider[PROVIDER_ID] ?? {}, 'models');
      generatedModels = options.models ? structuredClone(options.models) : profile ? modelsFor(profile) : {};
      const defaults = {
        name: 'Claude Code Profile',
        npm: npmFor(profile),
        searches: options.searches ?? false,
        models: structuredClone(generatedModels),
        ...(profile ? { api: profile.upstream.baseUrl } : options.baseURL ? { api: seed.upstream.baseUrl } : {}),
      };
      config.provider[PROVIDER_ID] ??= {};
      for (const [key, value] of Object.entries(defaults)) config.provider[PROVIDER_ID][key] ??= value;
      declaredProvider = config.provider[PROVIDER_ID];
    },
    auth: {
      provider: PROVIDER_ID,
      options: [
        { key: 'open-setup-on-first-load', label: '首次自动设置（已停用）', description: '兼容旧选项；请手动打开 UA PRO 统一管理。原生 API key 登录继续可用。', default: false },
      ],
      methods: [
        {
          type: 'api',
          label: 'API key 连接（推荐）',
          placeholder: '粘贴服务提供的 API key',
          prompts: [{
            type: 'text', key: 'baseURL', message: 'API 基础地址（已在 Provider 配置时可留空）', placeholder: '粘贴服务方提供的 Base URL',
            validate(value) {
              if (!String(value ?? '').trim()) return undefined;
              try { connectionProfile(null, { type: 'api', key: 'validation-only', metadata: { endpoint: String(value) } }); return undefined; }
              catch { return '请填写有效的 API 基础地址，不要填写 API key 或具体请求路径'; }
            },
          }],
        },
        {
          type: 'oauth',
          label: 'UA PRO 统一管理与旧配置迁移',
          async authorize() {
            const account = input?.magpie?.account?.(PROVIDER_ID) ?? PROVIDER_ID;
            const originalAuth = await currentHostAuth(account);
            const native = originalAuth?.type === 'api' && typeof originalAuth.key === 'string' && originalAuth.key.trim() && originalAuth.key !== AUTH_MARKER;
            const accountStore = native ? createAccountProfileStore({
              auth: originalAuth,
              savedProfile: await readProfile(),
              defaults: seed,
              provider: declaredProvider,
              path: input?.directory ? join(input.directory, 'plugin-auth.json') : store.path,
              readAuth: () => currentHostAuth(account),
              writeAuth: async (body) => {
                if (!input?.client?.auth?.set) throw new Error('当前宿主不支持保存账号配置');
                const response = await input.client.auth.set({ path: { id: account }, body });
                if (response?.data !== true || !isDeepStrictEqual(await currentHostAuth(account), body)) throw new Error('宿主未确认账号配置已保存');
              },
            }) : null;
            // The account store remains available only for backend compatibility clients.
            const session = accountStore ? await startSetup({ store: accountStore, accountManager, checkConnection, uaService, finishOnSave: false }) : await setupSession();
            return {
              url: session.url,
              method: 'auto',
              opened: false,
              instructions: '在 UA PRO 统一管理连接与模板；旧独立 Claude 配置可在“设置”中预览迁移。原生 API key 登录继续可用。管理页保存独立的 UA PRO 配置，完成后请返回 UA PRO 供应商并重载核对。Docker 或远程宿主请使用同端口 SSH 隧道访问。',
              async callback(_code, options = {}) {
                try {
                  const result = await waitForSetup(session, options.signal);
                  if (result.status === 'timeout') return { type: 'failed', error: 'UA PRO 管理已超时，已保存的配置仍保留' };
                  if (options.signal?.aborted || !['saved', 'managed', 'cancelled'].includes(result.status)) return { type: 'failed', error: 'UA PRO 管理已取消，原账号凭据保留' };
                  const expectedAuth = accountStore ? accountStore.getAuth() : originalAuth;
                  if (!isDeepStrictEqual(await currentHostAuth(account), expectedAuth)) return { type: 'failed', error: '账号已在其他位置变更，请重新打开配置；不会恢复旧凭据' };
                  // Management never returns a key: host save() would otherwise rebuild the record.
                  if (expectedAuth) return { type: 'success' };
                  return { type: 'failed', error: 'UA PRO 管理已关闭，已保存的更改保留；请使用 UA PRO 供应商。当前 Claude 兼容账号尚未登录，请使用 API key 连接。' };
                } finally {
                  await new Promise((resolve) => setTimeout(resolve, 150));
                  if (session.retire) await session.retire();
                  else await session.close();
                }
              },
            };
          },
        },
        {
          type: 'oauth',
          label: '管理 New API 账号、余额与签到（可选）',
          async authorize() {
            const account = input?.magpie?.account?.(PROVIDER_ID) ?? PROVIDER_ID;
            const originalAuth = await currentHostAuth(account);
            const hostBinding = originalAuth ? { account, selected: originalAuth.metadata?.newApiAccountId ?? null, changed: false } : undefined;
            const session = await startSetup({ store, accountManager, hostBinding, checkConnection, uaService });
            return {
              url: new URL('accounts', session.url).href,
              method: 'auto',
              instructions: '在账号管理页添加站点账号，刷新余额或签到。账号独立保存，完成后点击“完成并关闭”。这不会修改模型路由凭据。',
              async callback(_code, options = {}) {
                try {
                  const result = await waitForSetup(session, options.signal);
                  if (!['managed', 'saved'].includes(result.status)) return { type: 'failed', error: '账号管理已取消或超时，已保存的账号仍保留' };
                  let latest;
                  try { latest = await currentHostAuth(account); }
                  catch { return { type: 'failed', error: '无法读取当前账号，原凭据保留；请重新打开页面' }; }
                  if (!isDeepStrictEqual(latest, originalAuth)) {
                    return { type: 'failed', error: '当前账号已发生变化，请重新打开页面；不会覆盖现有凭据' };
                  }
                  if (!originalAuth) {
                    if (await readProfile()) return { type: 'success', key: AUTH_MARKER, metadata: { profileFile: store.path } };
                    return { type: 'failed', error: '站点账号已保存；聊天连接尚未设置，请使用 API key 连接' };
                  }
                  if (hostBinding.changed) {
                    if (!input?.client?.auth?.set) return { type: 'failed', error: '当前宿主不支持保存账号配置，绑定未保存' };
                    const nextAuth = { ...latest, metadata: { ...latest.metadata, newApiAccountId: hostBinding.selected ?? '' } };
                    let response;
                    try {
                      response = await input.client.auth.set({ path: { id: account }, body: structuredClone(nextAuth) });
                    } catch {
                      return { type: 'failed', error: '账号配置保存失败，请重试；原凭据保留' };
                    }
                    if (response?.data !== true) return { type: 'failed', error: '宿主未确认账号配置已保存，请重试' };
                    let confirmed;
                    try { confirmed = await currentHostAuth(account); }
                    catch { return { type: 'failed', error: '无法确认账号配置已保存，请重试' }; }
                    if (!isDeepStrictEqual(confirmed, nextAuth)) return { type: 'failed', error: '宿主未确认账号配置已保存，请重试' };
                  }
                  // The account already exists. Returning a key would make the host save() rebuild it.
                  return { type: 'success' };
                } finally {
                  await new Promise((resolve) => setTimeout(resolve, 150));
                  if (session.retire) await session.retire();
                  else await session.close();
                }
              },
            };
          },
        },
      ],
      async usage(getAuth) {
        const id = await boundAccount(getAuth);
        if (!id) return { signIn: 'kept', windows: [{ name: '可选余额', display: '当前宿主账号未绑定站点账号；聊天不受影响', aside: true }] };
        let account;
        try { account = await accountManager.refresh(id); }
        catch { return { signIn: 'kept', windows: [{ name: '可选余额', display: '绑定的站点账号不可用，请检查账号管理', aside: true }] }; }
        return {
          plan: 'New API',
          user: account.name,
          signIn: 'kept',
          windows: [account].map((account) => {
            const snapshot = account.snapshot;
            const amount = (value) => value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 });
            return {
              name: account.name,
              aside: true,
              unit: account.unit,
              ...(snapshot ? { balance: snapshot.remaining } : {}),
              display: snapshot
                ? `余额 ${amount(snapshot.remaining)} ${account.unit}；累计消耗 ${amount(snapshot.used)}；消耗增量 ${amount(snapshot.deltaUsed)}；余额变化 ${amount(snapshot.deltaBalance)}${account.status.stale ? '（缓存）' : ''}${account.status.error ? `；${account.status.error}` : ''}`
                : account.status.error || '尚未读取余额',
            };
          }),
        };
      },
      async checkin(getAuth) {
        const id = await boundAccount(getAuth);
        if (!id) return { outcome: 'inactive', message: '当前宿主账号未绑定站点账号，未发起签到' };
        let account;
        try {
          const configured = await accountManager.get?.(id);
          if (configured?.schedule?.enabled) return { outcome: 'inactive', message: `此账号由插件按每天 ${configured.schedule.time}（${configured.schedule.timeZone}）自动签到；如需现在执行，请在账号管理页手动签到` };
          account = await accountManager.checkin(id);
        } catch { return { outcome: 'failed', message: '绑定的站点账号签到未完成，请检查账号管理' }; }
        const active = [account].filter((account) => account.enabled && account.checkinEnabled);
        if (!active.length) return { outcome: 'inactive', message: '当前账号未启用签到' };
        const success = new Set(['success', 'claimed']);
        const done = new Set(['already', 'already_checked', 'checked', 'done']);
        const captcha = new Set(['requires_verification', 'verification_required', 'captcha']);
        const failed = active.some((account) => !success.has(account.checkin.state) && !done.has(account.checkin.state) && !captcha.has(account.checkin.state) && account.checkin.state !== 'disabled');
        const needsCaptcha = active.some((account) => captcha.has(account.checkin.state));
        const claimed = active.some((account) => success.has(account.checkin.state));
        return {
          outcome: failed ? 'failed' : needsCaptcha ? 'captcha' : claimed ? 'claimed' : active.every((account) => account.checkin.state === 'disabled') ? 'inactive' : 'done',
          ...(claimed && Number.isFinite(account.checkin.reward) ? { credit: account.checkin.reward } : {}),
          message: active.map((account) => `${account.name}：${success.has(account.checkin.state) ? `签到成功${account.checkin.reward == null ? '' : `，奖励 ${account.checkin.reward} ${account.unit}`}` : done.has(account.checkin.state) ? '今日已签到' : captcha.has(account.checkin.state) ? '需要在站点完成验证' : account.checkin.state === 'disabled' ? '站点未开启签到' : `签到失败（${account.checkin.message || '未完成'}）`}`).join('；'),
        };
      },
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) return {};
        const getProfile = async () => {
          const current = await getAuth();
          if (current?.type !== 'api' || typeof current.key !== 'string' || !current.key.trim()) throw new Error('No API key available; sign in again');
          return connectionProfile(await readProfile(), current, { ...declaredProvider, ...provider }, seed);
        };
        const profile = await getProfile();
        return {
          baseURL: profile.upstream.baseUrl,
          apiKey: ['api-key', 'bearer'].includes(profile.upstream.authorizationMode) ? profile.upstream.apiKey : AUTH_MARKER,
          fetch: createTransport({ getProfile, extractHostContext, fetchImpl: dependencies.fetchImpl ?? globalThis.fetch }),
        };
      },
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider = {}, { auth } = {}) {
        const saved = await readProfile();
        if (!saved && !auth) return provider.models ?? {};
        if (hostModelsExplicit) return provider.models ?? {};
        const profile = connectionProfile(saved, auth, { ...declaredProvider, ...provider }, seed);
        const models = await discoverModels(profile);
        const records = modelRecords(profile, Object.keys(models), { ...models, ...options.models, ...provider.models });
        const scopedUrl = auth?.metadata?.claudeProfile?.upstream?.baseUrl;
        let scopedTarget = false;
        try {
          scopedTarget = auth?.type === 'api' && auth.key !== AUTH_MARKER && Boolean(auth.key) &&
            new URL(scopedUrl).href.replace(/\/+$/, '') === new URL(profile.upstream.baseUrl).href.replace(/\/+$/, '');
        } catch { /* No matching account-scoped configuration. */ }
        for (const [id, model] of Object.entries(records)) {
          const generated = generatedModels[id];
          const generatedRoute = generated && model.api.url === generated.api?.url && model.api.npm === generated.api?.npm &&
            model.provider.api === generated.provider?.api && model.provider.npm === generated.provider?.npm;
          if (scopedTarget || generatedRoute) {
            model.api = { ...model.api, url: profile.upstream.baseUrl, npm: npmFor(profile) };
            model.provider = { ...model.provider, api: profile.upstream.baseUrl, npm: npmFor(profile) };
          }
        }
        return records;
      },
    },
    async 'chat.headers'(context, output) {
      if (context?.model?.providerID !== PROVIDER_ID && context?.provider?.info?.id !== PROVIDER_ID) return;
      const now = Date.now();
      for (const [token, saved] of contexts) {
        if (now - saved.created > 60000) contexts.delete(token);
      }
      if (contexts.size >= 2048) contexts.delete(contexts.keys().next().value);
      const token = randomUUID();
      contexts.set(token, { created: now, value: { sessionID: context.sessionID, model: context.model } });
      output.headers[contextHeader] = token;
    },
  };
}
