import { compileParameters, isObject } from '../lib/parameters.mjs';

export const HEADER_LIMIT_BYTES = 16 * 1024;
export const PROTECTED_HEADER_NAMES = Object.freeze([
  'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'set-cookie',
  'host', 'content-length', 'content-encoding', 'connection', 'transfer-encoding',
  'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer',
  'x-openai-actor-authorization',
]);
export const VARIABLE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'session.id', description: '真实宿主会话 ID；缺失时省略' }),
  Object.freeze({ name: 'request.id', description: '本次上游请求 ID；由插件生成' }),
  Object.freeze({ name: 'client.version', description: '配置中的客户端版本' }),
  Object.freeze({ name: 'model.id', description: '真实请求或宿主提供的模型 ID' }),
  Object.freeze({ name: 'reasoning.effort', description: 'Messages output_config.effort 提供的推理强度' }),
  Object.freeze({ name: 'timestamp', description: '本次请求的 Unix 毫秒时间戳' }),
]);
export const DEFAULT_METADATA_TEMPLATES = Object.freeze({});
const BETA = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31';
const vscodeUA = 'claude-cli/2.1.316 (external, claude-vscode, agent-sdk/0.3.316)';
const presetHeaders = Object.freeze({
  accept: 'application/json',
  'anthropic-beta': BETA,
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-version': '2023-06-01',
  'user-agent': vscodeUA,
  'x-app': 'cli',
  'x-stainless-arch': 'x64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Windows',
  'x-stainless-package-version': '0.128.0',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.12.1',
  'x-stainless-timeout': '300',
});
export const CLIENT_PRESETS = Object.freeze({
  'claude-vscode': Object.freeze({ label: 'Claude Code VS Code', version: '2.1.316', userAgent: vscodeUA, headers: presetHeaders }),
  'claude-cli': Object.freeze({ label: 'Claude Code CLI', version: '2.1.316', userAgent: 'claude-cli/2.1.316 (external, cli)', headers: Object.freeze({ ...presetHeaders, 'user-agent': 'claude-cli/2.1.316 (external, cli)' }) }),
  none: Object.freeze({ label: '无预设', version: '', userAgent: '', headers: Object.freeze({}) }),
});
export class ProfileValidationError extends Error {
  constructor(fields, message = '配置验证失败') {
    super(message); this.name = 'ProfileValidationError'; this.code = 'PROFILE_VALIDATION_ERROR'; this.fields = fields;
  }
}
const protectedNames = new Set(PROTECTED_HEADER_NAMES);
const variables = new Set(VARIABLE_DEFINITIONS.map(v => v.name));
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export function isProtectedHeader(name) {
  return protectedNames.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-magpie-');
}
export function isSafeHeaderText(value) {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]|[^\u0020-\u00ff]/u.test(value);
}
export function validateHeaderTemplate(value) {
  if (!isSafeHeaderText(value) || value.length > HEADER_LIMIT_BYTES) return false;
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('{{', cursor); const close = value.indexOf('}}', cursor);
    if (open < 0 && close < 0) return true;
    if (open < 0 || (close >= 0 && close < open)) return false;
    const end = value.indexOf('}}', open + 2);
    if (end < 0 || !variables.has(value.slice(open + 2, end))) return false;
    cursor = end + 2;
  }
  return true;
}
export function targetOf(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}
export function createDefaultProfile() {
  return {
    version: 1,
    upstream: { baseUrl: '', apiMode: 'anthropic', apiKey: '', authorizationMode: 'api-key', authorizationValue: '' },
    models: [], client: { preset: 'claude-vscode', version: '' },
    headers: { userAgent: '', acceptMode: 'json', acceptValue: '', contentType: '', anthropicVersion: '', anthropicBeta: '', sessionId: '{{session.id}}', clientRequestId: '{{request.id}}', extra: [] },
    parameters: { defaults: {}, overrides: {}, remove: [] },
  };
}

/** allowBlank is for an unconfigured UI/config draft only; transport/store use strict validation. */
export function normalizeProfile(raw, { allowBlank = false } = {}) {
  if (!isObject(raw)) throw new ProfileValidationError({ profile: '配置必须是对象' });
  const fields = {}; const output = createDefaultProfile();
  const error = (path, message) => { fields[path] ??= message; };
  const known = (value, keys, path) => {
    if (isObject(value) && Object.keys(value).some(key => !keys.includes(key))) error(path, '包含未知配置字段，请检查字段名称');
  };
  known(raw, ['version', 'upstream', 'models', 'client', 'headers', 'parameters'], 'profile');
  known(raw.upstream, Object.keys(output.upstream), 'upstream');
  known(raw.client, Object.keys(output.client), 'client');
  known(raw.headers, Object.keys(output.headers), 'headers');
  if (raw.version !== undefined && raw.version !== 1) error('version', '仅支持配置版本 1');
  const upstream = raw.upstream;
  if (upstream !== undefined && !isObject(upstream)) error('upstream', 'upstream 必须是对象');
  const source = isObject(upstream) ? upstream : {};
  const base = source.baseUrl ?? '';
  if (typeof base !== 'string') error('upstream.baseUrl', '上游 Base URL 必须是字符串');
  else if (!base.trim()) { if (!allowBlank) error('upstream.baseUrl', '上游 Base URL 不能为空'); }
  else {
    try {
      const value = base.trim(); const url = new URL(value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!/^https?:\/\/[^/?#]+/i.test(value) || !['http:', 'https:'].includes(url.protocol) ||
        (url.protocol === 'http:' && !loopback) || url.username || url.password || value.includes('@') ||
        value.includes('?') || value.includes('#') || /[\u0000-\u0020\u007f{}\\]/.test(value) ||
        /\/(messages|responses|chat\/completions)\/?$/i.test(url.pathname)) throw new Error();
      output.upstream.baseUrl = url.href.replace(/\/+$/, '');
    } catch { error('upstream.baseUrl', '请填写 HTTPS Base URL（回环地址可用 HTTP），不要包含凭据、查询、片段或具体请求路径'); }
  }
  if (source.apiMode !== undefined && source.apiMode !== 'anthropic') error('upstream.apiMode', 'apiMode 必须是 anthropic');
  for (const name of ['apiKey', 'authorizationValue']) {
    if (source[name] === undefined) continue;
    if (!isSafeHeaderText(source[name]) || source[name].length > HEADER_LIMIT_BYTES) error(`upstream.${name}`, '凭据必须是不含控制字符的 HTTP 头文本');
    else output.upstream[name] = source[name];
  }
  if (source.authorizationMode !== undefined) {
    if (!['api-key', 'bearer', 'custom', 'none'].includes(source.authorizationMode)) error('upstream.authorizationMode', '授权模式必须是 api-key、bearer、custom 或 none');
    else output.upstream.authorizationMode = source.authorizationMode;
  }
  if (!allowBlank && ['api-key', 'bearer'].includes(output.upstream.authorizationMode) && !output.upstream.apiKey.trim()) error('upstream.apiKey', '当前授权模式必须填写 API key');
  if (!allowBlank && output.upstream.authorizationMode === 'custom' && !output.upstream.authorizationValue.trim()) error('upstream.authorizationValue', 'custom 模式必须填写完整的 Authorization 值');
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) error('models', 'models 必须是字符串数组');
    else {
      const models = [];
      raw.models.forEach((id, index) => {
        if (typeof id !== 'string' || !id.trim() || /[\u0000-\u001f\u007f]/.test(id)) error(`models[${index}]`, '模型 ID 必须是不含控制字符的非空字符串');
        else models.push(id.trim());
      });
      output.models = [...new Set(models)];
    }
  }
  if (raw.client !== undefined && !isObject(raw.client)) error('client', 'client 必须是对象');
  if (isObject(raw.client)) {
    if (raw.client.preset !== undefined) {
      if (typeof raw.client.preset !== 'string' || !Object.hasOwn(CLIENT_PRESETS, raw.client.preset)) error('client.preset', '请选择 claude-vscode、claude-cli 或 none');
      else output.client.preset = raw.client.preset;
    }
    if (raw.client.version !== undefined) {
      if (!isSafeHeaderText(raw.client.version)) error('client.version', '版本必须是不含控制字符的 HTTP 头文本');
      else output.client.version = raw.client.version;
    }
  }
  if (raw.headers !== undefined && !isObject(raw.headers)) error('headers', 'headers 必须是对象');
  const headers = isObject(raw.headers) ? raw.headers : {};
  for (const name of ['userAgent', 'acceptValue', 'contentType', 'anthropicVersion', 'anthropicBeta', 'sessionId', 'clientRequestId']) {
    if (headers[name] === undefined) continue;
    if (!validateHeaderTemplate(headers[name])) error(`headers.${name}`, '请求头文本或模板变量无效');
    else output.headers[name] = headers[name];
  }
  if (headers.acceptMode !== undefined) {
    if (!['json', 'auto', 'sse', 'custom'].includes(headers.acceptMode)) error('headers.acceptMode', 'Accept 模式必须是 json、auto、sse 或 custom');
    else output.headers.acceptMode = headers.acceptMode;
  }
  if (output.headers.acceptMode === 'custom' && !output.headers.acceptValue.trim()) error('headers.acceptValue', 'custom 模式必须填写 Accept 值');
  if (headers.extra !== undefined) {
    if (!Array.isArray(headers.extra)) error('headers.extra', '附加请求头必须是数组');
    else headers.extra.forEach((item, index) => {
      const path = `headers.extra[${index}]`;
      if (!isObject(item)) { error(path, '附加请求头必须是对象'); return; }
      known(item, ['name', 'value', 'enabled'], path);
      if (typeof item.name !== 'string' || !token.test(item.name) || isProtectedHeader(item.name)) error(`${path}.name`, '该请求头名称无效或受到保护');
      if (item.value !== null && !validateHeaderTemplate(item.value)) error(`${path}.value`, '请求头值必须是有效文本、模板或 null');
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') error(`${path}.enabled`, 'enabled 必须是布尔值');
      output.headers.extra.push({ name: item.name, value: item.value, enabled: item.enabled ?? true });
    });
  }
  try {
    const plan = compileParameters(raw.parameters);
    output.parameters = { defaults: plan.defaults, overrides: plan.overrides, remove: plan.remove.map(path => path.join('.')) };
  } catch { error('parameters', 'Messages 参数设置无效，不能修改受保护字段或使用 Responses 参数'); }
  if (Object.keys(fields).length) throw new ProfileValidationError(fields);
  return output;
}

export function redactProfile(profile) {
  let output;
  try { output = normalizeProfile(profile, { allowBlank: true }); }
  catch { output = createDefaultProfile(); }
  output.upstream.apiKey = ''; output.upstream.authorizationValue = '';
  return output;
}

export function mergeProfileSecrets(nextRaw, previousProfile, clearSecrets = []) {
  if (!Array.isArray(clearSecrets) || clearSecrets.some(field => !['apiKey', 'authorizationValue'].includes(field))) throw new ProfileValidationError({ clearSecrets: 'clearSecrets 包含未知字段或格式无效' });
  if (!isObject(nextRaw)) throw new ProfileValidationError({ profile: '配置必须是对象' });
  const nextTarget = targetOf(nextRaw.upstream?.baseUrl); const oldTarget = targetOf(previousProfile?.upstream?.baseUrl);
  const same = nextTarget !== null && nextTarget === oldTarget;
  const draft = { ...nextRaw, upstream: isObject(nextRaw.upstream) ? { ...nextRaw.upstream } : nextRaw.upstream };
  if (isObject(draft.upstream)) {
    for (const field of ['apiKey', 'authorizationValue']) {
      const value = draft.upstream[field];
      if ((value === undefined || (typeof value === 'string' && !value.trim()))) draft.upstream[field] = same && !clearSecrets.includes(field) ? previousProfile?.upstream?.[field] ?? '' : '';
      else if (!same && oldTarget && value === previousProfile?.upstream?.[field]) throw new ProfileValidationError({ [`upstream.${field}`]: '服务地址已改变，请重新填写该服务的凭据' });
      if (clearSecrets.includes(field) && (value === undefined || value === '')) draft.upstream[field] = '';
    }
  }
  const normalized = normalizeProfile(draft);
  if (nextTarget && oldTarget && !same) {
    const fields = {}; const defaults = createDefaultProfile().headers; const old = previousProfile?.headers ?? {};
    for (const [key, value] of Object.entries(normalized.headers)) {
      if (key === 'extra' || typeof value !== 'string' || value === defaults[key] || !value.trim()) continue;
      if (typeof old[key] === 'string' && value.trim() === old[key].trim()) fields[`headers.${key}`] = '服务地址已改变，请移除旧服务的专用设置';
    }
    normalized.headers.extra.forEach((item, index) => {
      if ((old.extra ?? []).some(entry => typeof entry?.name === 'string' && entry.name.toLowerCase() === item.name.toLowerCase() && entry.value === item.value)) fields[`headers.extra[${index}].value`] = '服务地址已改变，请移除旧服务的附加请求头';
    });
    if (Object.keys(fields).length) throw new ProfileValidationError(fields);
  }
  return normalized;
}
