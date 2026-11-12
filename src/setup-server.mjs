import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnectionDiagnostics } from './diagnostics.mjs';
import { CLIENT_PRESETS, DEFAULT_METADATA_TEMPLATES, VARIABLE_DEFINITIONS, redactProfile } from './profile.mjs';

const application = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const MAX_BODY_BYTES = 256 * 1024;
// Fetch/browser bad-port list: a random listener must still be browser reachable.
const BLOCKED_PORTS = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
const MAX_SAVE_OPERATIONS = 128;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validOperationId(value) {
  return typeof value === 'string' && OPERATION_ID.test(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function saveDigest(data) {
  return createHash('sha256').update(stableJson({ profile: data.profile, clearSecrets: data.clearSecrets ?? [] })).digest('hex');
}
const ASSETS = {
  '': ['pro.html', 'text/html; charset=utf-8'],
  'theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  'icon.svg': ['../assets/icon.svg', 'image/svg+xml; charset=utf-8'],
  accounts: ['accounts.html', 'text/html; charset=utf-8'],
  'accounts.js': ['accounts.js', 'text/javascript; charset=utf-8'],
  'accounts.css': ['accounts.css', 'text/css; charset=utf-8'],
  pro: ['pro.html', 'text/html; charset=utf-8'],
  'pro.js': ['pro.js', 'text/javascript; charset=utf-8'],
  'ui/pro.js': ['pro.js', 'text/javascript; charset=utf-8'],
  'ui/accounts.js': ['accounts.js', 'text/javascript; charset=utf-8'],
  'lib/ua-protocol.mjs': ['../lib/ua-protocol.mjs', 'text/javascript; charset=utf-8'],
  'lib/ua-test-plan.mjs': ['../lib/ua-test-plan.mjs', 'text/javascript; charset=utf-8'],
  'pro.css': ['pro.css', 'text/css; charset=utf-8'],
};

function securityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
    request.resume();
    const error = new Error('请求内容过大');
    error.status = 413;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求内容过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    const error = new Error('请求必须是有效的 JSON 对象');
    error.status = 400;
    throw error;
  }
}

export async function startSetupServer({
  store,
  accountManager,
  hostBinding,
  uaService,
  // Deprecated proDefault is accepted in the options object but has no effect.
  checkConnection = createConnectionDiagnostics(),
  host = '127.0.0.1',
  port = 0,
  timeoutMs = 15 * 60 * 1000,
  operationGraceMs = 30000,
  shutdownDelayMs = 2000,
  saveRecoveryGraceMs = 30000,
  finishOnSave = true,
} = {}) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('配置服务只能监听回环地址，请使用 SSH 隧道访问远程宿主');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('配置服务端口无效');
  if (BLOCKED_PORTS.has(port)) throw new Error('此端口被浏览器禁止访问，请选择其他端口或使用随机端口');
  if (![timeoutMs, operationGraceMs, shutdownDelayMs, saveRecoveryGraceMs].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('配置服务超时时间无效');
  if (typeof finishOnSave !== 'boolean') throw new Error('配置服务会话模式无效');
  const token = randomBytes(32).toString('base64url');
  const prefix = `/${token}/`;
  let origin;
  let timer;
  let shutdownTimer;
  let saveRecoveryDeadline = 0;
  let hardDeadline;
  let settled = false;
  let sessionState = 'active';
  let savedAt = null;
  let saving = false;
  let closing;
  let resolveFinished;
  const operations = new Map();
  const proOperations = new Map();
  const proControllers = new Map();
  const finished = new Promise((resolve) => { resolveFinished = resolve; });

  function sessionInfo() {
    return { mode: finishOnSave ? 'authorization' : 'editor', state: sessionState, savedAt, saveStatus: true };
  }

  function publicConfig(info) {
    return { ...info, clientPresets: CLIENT_PRESETS, metadataTemplates: DEFAULT_METADATA_TEMPLATES, session: sessionInfo() };
  }

  function ended(response, status = 410) {
    return json(response, status, { error: '配置会话已结束，请重新打开设置检查保存结果', code: 'session-ended', state: sessionState, session: sessionInfo() });
  }

  function busy(response) {
    return json(response, 409, { error: '其他操作正在进行，请等待结果后重试', code: 'busy' });
  }

  function operationInfo(operation) {
    return { ...publicConfig(operation.info), session: { ...sessionInfo(), savedAt: operation.savedAt } };
  }

  function failedOperation(operation, status, error) {
    if (operation) Object.assign(operation, { state: 'failed', status, error });
  }

  function persistedInfo(profile) {
    return {
      profile: redactProfile(profile), configured: true,
      secrets: {
        apiKey: Boolean(profile?.upstream?.apiKey),
        authorizationValue: Boolean(profile?.upstream?.authorizationValue),
        actorAuthorization: false,
      },
      variables: VARIABLE_DEFINITIONS, storagePath: store.path,
    };
  }

  function scheduleClose(delay) {
    clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => { void close(); }, delay);
    shutdownTimer.unref?.();
  }

  function complete(result) {
    if (settled) return;
    settled = true;
    sessionState = result.status === 'managed' ? 'cancelled' : result.status;
    clearTimeout(timer);
    if ([...operations.values(), ...proOperations.values()].some((operation) => operation.state === 'saved')) {
      saveRecoveryDeadline = Date.now() + saveRecoveryGraceMs;
    }
    scheduleClose(Math.max(shutdownDelayMs, saveRecoveryDeadline - Date.now()));
    resolveFinished(result);
  }

  function retire() {
    if (closing) return closing;
    const remaining = saveRecoveryDeadline - Date.now();
    if (remaining <= 0) return close();
    // Native auth may return now; the server owns the remaining, bounded recovery lifetime.
    scheduleClose(remaining);
  }

  function expire() {
    if (saving && Date.now() < hardDeadline) {
      timer = setTimeout(expire, Math.min(1000, Math.max(1, hardDeadline - Date.now())));
      timer.unref?.();
      return;
    }
    complete({ status: 'timeout' });
  }

  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      if (request.headers.host !== new URL(origin).host) return json(response, 403, { error: '配置服务拒绝此 Host' });
      const url = new URL(request.url, origin);
      if (url.origin === origin && url.pathname === '/favicon.ico' && (request.method === 'GET' || request.method === 'HEAD')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.origin !== origin || !url.pathname.startsWith(prefix)) return json(response, 404, { error: '配置页面不存在或链接已失效' });
      const route = url.pathname.slice(prefix.length);
      const isApi = route.startsWith('api/');
      if (isApi && (request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin && request.headers.origin !== origin))) {
        return json(response, 403, { error: '只允许从当前配置页面访问' });
      }

      if (route === 'legacy') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: '不支持此请求方法' });
        response.writeHead(308, { Location: `${prefix}pro` });
        return response.end();
      }
      if (Object.hasOwn(ASSETS, route)) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: '不支持此请求方法' });
        const [name, type] = ASSETS[route];
        const content = await readFile(new URL(`../ui/${name}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': type });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      if (route.startsWith('api/pro/')) {
        if (!uaService) return json(response, 503, { error: 'UA PRO 管理尚未初始化' });
        const action = route.slice('api/pro/'.length);
        if (action === 'operations' && request.method === 'GET') {
          const id = url.searchParams.get('id');
          if (!validOperationId(id)) return json(response, 400, { error: '操作标识无效' });
          const operation = proOperations.get(id);
          return json(response, 200, operation ? { state: operation.state, result: operation.result, error: operation.error } : { state: 'unknown' });
        }
        if (settled) return ended(response);
        if (action === 'state') {
          if (request.method !== 'GET') return json(response, 405, { error: '不支持此请求方法' });
          const state = await uaService.state();
          if (settled) return ended(response);
          return json(response, 200, { ...state, application: { name: 'UA PRO', version: application.version, provider: 'ua-pro' }, session: sessionInfo() });
        }
        if (request.method !== 'POST') return json(response, 405, { error: '不支持此请求方法' });
        if (request.headers.origin !== origin) return json(response, 403, { error: '操作必须从当前配置页面发起' });
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: '请使用 JSON 提交' });
        const data = await readJson(request);
        if (action === 'cancel-test') {
          proControllers.get(data.operationId)?.abort();
          return json(response, 200, { cancelled: true });
        }
        if (saving) return busy(response);
        if (!validOperationId(data.operationId)) return json(response, 400, { error: '请提供有效的操作标识' });
        const signature = createHash('sha256').update(stableJson({ action, data })).digest('hex');
        const existing = proOperations.get(data.operationId);
        if (existing) {
          if (existing.signature !== signature) return json(response, 409, { error: '操作标识已用于不同内容' });
          if (existing.state === 'pending') return json(response, 409, { error: '操作仍在进行，请查询结果', code: 'save-pending' });
          return json(response, existing.state === 'saved' ? 200 : existing.status, existing.state === 'saved' ? existing.result : existing.error);
        }
        if (proOperations.size >= MAX_SAVE_OPERATIONS) return json(response, 429, { error: '本次操作数量已达上限，请重新打开配置页' });
        const operation = { state: 'pending', signature };
        proOperations.set(data.operationId, operation);
        const controller = new AbortController();
        proControllers.set(data.operationId, controller);
        const disconnected = () => { if (!response.writableEnded && ['test', 'connections/models'].includes(action)) controller.abort(); };
        response.once('close', disconnected);
        const blocksSave = action !== 'connections/models';
        if (blocksSave) saving = true;
        try {
          const result = await uaService.execute(action, data, { signal: controller.signal });
          operation.state = 'saved';
          operation.result = result;
          if (settled) return ended(response);
          return json(response, 200, result);
        } catch (error) {
          operation.state = 'failed';
          operation.status = [400, 401, 403, 404, 408, 409, 413, 422].includes(error.status) ? error.status : 500;
          operation.error = { error: operation.status === 500 ? 'UA PRO 操作未完成，请核对配置与存储状态' : error.message, ...(error.fields ? { fields: error.fields } : {}), ...(['dns', 'connection-refused', 'connection-reset', 'timeout', 'tls', 'network', 'upstream-http', 'invalid-model-response', 'cancelled'].includes(error.code) ? { code: error.code } : {}) };
          return json(response, operation.status, operation.error);
        } finally {
          response.removeListener('close', disconnected);
          proControllers.delete(data.operationId);
          if (blocksSave) saving = false;
        }
      }
      if (route === 'api/save-status') {
        if (request.method !== 'GET') return json(response, 405, { error: '不支持此请求方法' });
        const ids = url.searchParams.getAll('operationId');
        if (ids.length !== 1 || !validOperationId(ids[0])) return json(response, 400, { error: '保存操作标识无效', code: 'invalid-operation-id' });
        const operation = operations.get(ids[0]);
        return json(response, 200, {
          state: operation?.state ?? 'unknown',
          ...(operation?.state === 'saved' ? { info: operationInfo(operation) } : {}),
        });
      }
      if (route === 'api/config') {
        if (request.method !== 'GET') return json(response, 405, { error: '不支持此请求方法' });
        if (settled) return ended(response);
        const info = await store.publicInfo();
        if (settled) return ended(response);
        return json(response, 200, publicConfig(info));
      }
      if (route === 'api/accounts') {
        if (request.method !== 'GET') return json(response, 405, { error: '不支持此请求方法' });
        if (settled) return ended(response);
        if (!accountManager) return json(response, 503, { error: '账号管理尚未初始化' });
        const accounts = await accountManager.list();
        const connections = uaService?.accountConnections ? await uaService.accountConnections() : [];
        if (settled) return ended(response);
        return json(response, 200, { ...accounts, connections, ...(hostBinding ? { binding: { account: hostBinding.account, selected: hostBinding.selected } } : {}) });
      }
      const accountAction = route.startsWith('api/accounts/') ? route.slice('api/accounts/'.length) : null;
      if (accountAction && !['save', 'remove', 'refresh', 'checkin', 'bind', 'done', 'connection-usage'].includes(accountAction)) return json(response, 404, { error: '账号接口不存在' });
      if (!accountAction && !['api/save', 'api/check', 'api/cancel'].includes(route)) return json(response, 404, { error: '配置接口不存在' });
      if (request.method !== 'POST') return json(response, 405, { error: '不支持此请求方法' });
      if (request.headers.origin !== origin) return json(response, 403, { error: '保存必须从当前配置页面发起' });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: '请使用 JSON 提交配置' });
      if (route !== 'api/save') {
        if (settled) return ended(response, 409);
        if (saving) return busy(response);
      }
      const data = await readJson(request);
      let operation;
      if (route === 'api/save' && Object.hasOwn(data, 'operationId')) {
        if (!validOperationId(data.operationId)) return json(response, 400, { error: '保存操作标识无效', code: 'invalid-operation-id' });
        const digest = saveDigest(data);
        operation = operations.get(data.operationId);
        if (operation) {
          if (operation.digest !== digest) return json(response, 409, { error: '此保存操作标识已用于其他内容，请使用新的标识', code: 'operation-conflict' });
          if (operation.state === 'pending') return json(response, 409, { error: '此保存操作仍在进行，请查询保存结果', code: 'save-pending' });
          if (operation.state === 'saved') return json(response, 200, { saved: true, operationId: data.operationId, info: operationInfo(operation) });
          return json(response, operation.status, operation.error);
        }
        operation = { digest, state: 'pending' };
      }
      if (settled) return ended(response, 409);
      if (saving) return busy(response);
      if (accountAction) {
        if (accountAction === 'connection-usage') {
          if (!uaService) return json(response, 503, { error: '连接余额查询尚未初始化' });
          try {
            const result = await uaService.execute('connections/usage', data);
            if (settled) return ended(response);
            return json(response, 200, result);
          } catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            return json(response, status, { error: status === 500 ? '连接余额读取未完成，请核对连接状态' : error.message });
          }
        }
        if (!accountManager) return json(response, 503, { error: '账号管理尚未初始化' });
        if (accountAction === 'done') {
          json(response, 200, { done: true });
          complete({ status: 'managed' });
          return;
        }
        if ((data.id !== undefined && (typeof data.id !== 'string' || !data.id)) ||
          (accountAction === 'remove' && !data.id) ||
          (accountAction === 'save' && (!data.account || typeof data.account !== 'object' || Array.isArray(data.account))) ||
          (data.clearSecrets !== undefined && (!Array.isArray(data.clearSecrets) || !data.clearSecrets.every((key) => typeof key === 'string')))) {
          return json(response, 400, { error: '账号参数无效，请检查表单' });
        }
        saving = true;
        try {
          let result;
          if (accountAction === 'bind') {
            if (!hostBinding) return json(response, 409, { error: '请从 Magpie 当前账号的管理入口打开页面后绑定' });
            if (data.id) await accountManager.get(data.id);
            hostBinding.selected = data.id ?? null;
            hostBinding.changed = true;
            result = { bound: true, selected: hostBinding.selected };
          }
          else if (accountAction === 'save') result = { account: await accountManager.save(data.account, data.clearSecrets ?? []) };
          else if (accountAction === 'remove') result = await accountManager.remove(data.id);
          else if (data.id) result = { account: await accountManager[accountAction](data.id) };
          else result = await accountManager[`${accountAction}All`]();
          if (settled) return ended(response);
          json(response, 200, result);
        } catch (error) {
          const status = [400, 404, 409].includes(error.status) ? error.status : 500;
          json(response, status, { error: status === 404 ? '账号不存在' : status === 409 ? '账号状态已变更，请刷新后重试' : '账号操作未完成，请检查配置或网络后重试', ...(error.name === 'AccountValidationError' ? { fields: error.fields ?? {} } : {}) });
        } finally { saving = false; }
        return;
      }
      if (route === 'api/cancel') {
        complete({ status: 'cancelled' });
        json(response, 200, { cancelled: true, session: sessionInfo() });
        return;
      }
      if (operation) {
        // Keep every accepted ID until shutdown; evicting one could allow a repeated write.
        if (operations.size >= MAX_SAVE_OPERATIONS) return json(response, 429, { error: '本次会话的保存操作已达上限，请重新打开设置', code: 'operation-limit' });
        operations.set(data.operationId, operation);
      }
      if (!data.profile || typeof data.profile !== 'object' || Array.isArray(data.profile) ||
        (data.clearSecrets !== undefined && (!Array.isArray(data.clearSecrets) || !data.clearSecrets.every((key) => typeof key === 'string')))) {
        const error = { error: '配置格式无效，请检查表单' };
        failedOperation(operation, 400, error);
        return json(response, 400, error);
      }
      saving = true;
      try {
        if (route === 'api/check') {
          const profile = await store.prepareFromUi(data.profile, data.clearSecrets ?? []);
          if (settled) return ended(response);
          const result = await checkConnection(profile);
          if (settled) return ended(response);
          json(response, 200, { result });
          return;
        }
        const profile = await store.saveFromUi(data.profile, data.clearSecrets ?? []);
        savedAt = new Date().toISOString();
        if (operation) {
          // Record success before reading or returning anything else: the client may lose its response.
          Object.assign(operation, { state: 'saved', savedAt, info: persistedInfo(profile) });
          if (settled && !closing) {
            saveRecoveryDeadline = Date.now() + saveRecoveryGraceMs;
            scheduleClose(Math.max(shutdownDelayMs, saveRecoveryGraceMs));
          }
          try { operation.info = await store.publicInfo(); }
          catch { /* The safe persisted snapshot still confirms a successful write. */ }
        }
        if (settled) return ended(response);
        if (finishOnSave) complete({ status: 'saved', profile });
        json(response, 200, operation ? { saved: true, operationId: data.operationId, info: operationInfo(operation) } : { saved: true });
      } catch (error) {
        const status = error.name === 'ProfileValidationError' ? 400 : 500;
        const body = status === 400
          ? { error: '请检查标记的配置字段', fields: error.fields ?? {} }
          : { error: route === 'api/check' ? '连接检查未完成，请检查配置与网络后重试；当前设置未保存' : '配置保存失败，请检查目录权限与可用空间；表单尚未关闭' };
        failedOperation(operation, status, body);
        json(response, status, body);
      } finally {
        saving = false;
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error.status ?? 500, { error: error.status ? error.message : '无法读取配置，请检查配置文件与权限' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;

  async function close() {
    if (closing) return closing;
    clearTimeout(timer);
    clearTimeout(shutdownTimer);
    for (const controller of proControllers.values()) controller.abort();
    if (!settled) {
      settled = true;
      sessionState = 'cancelled';
      resolveFinished({ status: 'cancelled' });
    }
    closing = new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    return closing;
  }

  let bound;
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(port, host, () => { server.removeListener('error', failed); resolve(); });
    });
    bound = server.address();
    if (!BLOCKED_PORTS.has(bound.port)) break;
    await new Promise(resolve => server.close(resolve));
    bound = undefined;
  }
  if (!bound) throw new Error('无法分配浏览器可访问的本地端口');
  origin = `http://${host === '::1' ? '[::1]' : host}:${bound.port}`;
  hardDeadline = Date.now() + timeoutMs + operationGraceMs;
  timer = setTimeout(expire, timeoutMs);
  timer.unref?.();
  return { url: `${origin}${prefix}`, origin, port: bound.port, finished, close, retire };
}
