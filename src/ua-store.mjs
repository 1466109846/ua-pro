import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { builtinTemplates, validateTemplate } from './ua-transform.mjs';

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const PROTOCOLS = ['anthropic', 'responses', 'chat-completions', 'gemini'];
const OPERATIONS = ['messages', 'count_tokens', 'responses', 'chat/completions', 'generateContent', 'streamGenerateContent', 'countTokens'];
const AUTH_MODES = ['api-key', 'bearer', 'custom', 'none'];
const AUTH_SOURCES = ['stored', 'host'];
const BUILTIN_IDS = ['builtin.codex', 'builtin.claude-code'];
const SEED_CUSTOM_IDS = ['custom.claude-vscode-2316'];
const PROTECTED_SEED_VERSIONS = new Set(['custom.claude-vscode-2316@1']);
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TEMPLATE_ID = /^(?:builtin|custom)\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_AUTO_RESOLVED = {
  responses: { id: 'builtin.codex', revision: 1 },
  anthropic: { id: 'builtin.claude-code', revision: 1 },
};
const writes = new Map();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const text = (value) => (typeof value === 'string' ? value.trim() : '');

function fail(message, status = 400, field) {
  const error = new Error(message);
  error.status = status;
  if (field) error.fields = { [field]: message };
  return error;
}

function onlyKeys(value, allowed, field) {
  if (isObject(value) && Object.keys(value).some((key) => !allowed.includes(key))) {
    throw fail('包含未知字段，请检查字段名称', 400, field);
  }
}

function targetOf(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function normalizeBaseURL(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('站点地址不能为空', 400, 'baseURL');
  const raw = value.trim();
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!/^https?:\/\/[^/?#]+/i.test(raw) || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !loopback) || url.username || url.password || raw.includes('@') ||
      raw.includes('?') || raw.includes('#') || /[\u0000-\u0020\u007f{}\\]/.test(raw) ||
      /\/(messages|responses|chat\/completions)\/?$/i.test(url.pathname)) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw fail('请填写 HTTPS 站点地址（回环地址可用 HTTP），不要包含凭据、查询、片段或具体请求路径', 400, 'baseURL');
  }
}

function safePath(value) {
  return isText(value) && !/[\u0000-\u0020\u007f\\]/.test(value) && !value.includes('://') && !/(^|\/)\.\.(\/|$)/.test(value);
}

/** Store governance (id/kind/revision/archived) around the single validation source in ua-transform. */
function governTemplate(raw, { id, revision } = {}) {
  if (!isObject(raw)) throw fail('模板必须是对象', 400, 'template');
  const archived = raw.archived ?? false;
  if (typeof archived !== 'boolean') throw fail('模板归档状态无效', 400, 'archived');
  const cleaned = { ...raw };
  delete cleaned.archived;
  if (id !== undefined) cleaned.id = id;
  if (revision !== undefined) cleaned.revision = revision;
  if (!isText(cleaned.id)) throw fail('模板 id 缺失', 400, 'id');
  if (!isText(cleaned.kind)) cleaned.kind = cleaned.id.startsWith('builtin.') ? 'builtin' : 'custom';
  const template = validateTemplate(cleaned);
  if (!TEMPLATE_ID.test(template.id)) throw fail('模板 id 无效', 400, 'id');
  const builtin = template.id.startsWith('builtin.');
  if (builtin !== (template.kind === 'builtin')) throw fail('模板类型与 id 不一致', 400, 'kind');
  if (builtin && !BUILTIN_IDS.includes(template.id)) throw fail('未知内置模板', 400, 'id');
  template.archived = archived;
  return template;
}

/** Governance-only field; false is omitted so transform inputs stay schema clean. */
function publicTemplate(template) {
  const output = structuredClone(template);
  if (!output.archived) delete output.archived;
  return output;
}

/** Resolution hands transform a schema-clean template; archive is store governance only. */
function resolvedTemplate(template) {
  const output = structuredClone(template);
  delete output.archived;
  return output;
}

function assertTemplateRef(templates, id, revision) {
  if (!templates.some((item) => item.id === id && item.revision === revision)) {
    throw fail('基线模板版本不存在', 400, 'basedOn');
  }
}

function normalizeBinding(raw) {
  if (!isObject(raw)) throw fail('模板绑定必须是对象', 400, 'binding');
  onlyKeys(raw, ['mode', 'id', 'revision', 'resolvedVersions'], 'binding');
  if (!['auto', 'template', 'passthrough'].includes(raw.mode)) throw fail('模板绑定模式无效', 400, 'binding');
  if (raw.mode === 'passthrough') {
    if (raw.id !== undefined || raw.revision !== undefined || raw.resolvedVersions !== undefined) throw fail('passthrough 绑定不能包含模板字段', 400, 'binding');
    return { mode: 'passthrough' };
  }
  if (raw.mode === 'auto') {
    if (raw.id !== undefined || raw.revision !== undefined) throw fail('auto 绑定不能包含模板 id', 400, 'binding');
    const resolved = raw.resolvedVersions ?? DEFAULT_AUTO_RESOLVED;
    if (!isObject(resolved)) throw fail('auto 绑定版本无效', 400, 'binding');
    const output = {};
    for (const [protocol, ref] of Object.entries(resolved)) {
      if (!['responses', 'anthropic'].includes(protocol)) throw fail('auto 绑定仅支持 responses 和 anthropic 固定版本', 400, 'binding');
      if (!isObject(ref)) throw fail('auto 绑定版本无效', 400, 'binding');
      onlyKeys(ref, ['id', 'revision'], 'binding');
      if (!isText(ref.id) || !TEMPLATE_ID.test(ref.id.trim())) throw fail('auto 绑定版本无效', 400, 'binding');
      if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw fail('auto 绑定必须指定有效版本', 400, 'binding');
      output[protocol] = { id: ref.id.trim(), revision: ref.revision };
    }
    if (!output.responses || !output.anthropic) throw fail('auto 绑定必须固定 responses 和 anthropic 版本', 400, 'binding');
    return { mode: 'auto', resolvedVersions: output };
  }
  if (!isText(raw.id) || !TEMPLATE_ID.test(raw.id.trim())) throw fail('绑定模板 id 无效', 400, 'binding');
  if (!Number.isInteger(raw.revision) || raw.revision < 1) throw fail('绑定模板 revision 必须是正整数', 400, 'binding');
  return { mode: 'template', id: raw.id.trim(), revision: raw.revision };
}

function normalizeModelBindings(raw) {
  if (!isObject(raw)) throw fail('模型绑定必须是对象', 400, 'modelBindings');
  const output = {};
  for (const [model, binding] of Object.entries(raw)) {
    if (!isText(model) || BAD_KEYS.has(model)) throw fail('模型绑定名称无效', 400, 'modelBindings');
    output[model] = normalizeBinding(binding);
  }
  return output;
}

function normalizeConnectionShape(raw) {
  if (!isObject(raw)) throw fail('连接必须是对象', 400, 'connection');
  onlyKeys(raw, ['id', 'name', 'enabled', 'revision', 'siteId', 'independent', 'baseURL', 'protocol', 'apiPaths', 'modelProtocols', 'models', 'auth', 'binding', 'modelBindings', 'secrets', 'newApiAccountId'], 'connection');
  let id;
  if (raw.id !== undefined && raw.id !== '') {
    if (!isText(raw.id) || !STABLE_ID.test(raw.id.trim())) throw fail('连接 id 无效', 400, 'id');
    id = raw.id.trim();
  }
  if (!isText(raw.name) || raw.name.trim().length > 200) throw fail('连接名称不能为空且不能超过 200 字符', 400, 'name');
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== 'boolean') throw fail('连接启用状态无效', 400, 'enabled');
  const revision = raw.revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) throw fail('连接 revision 必须是正整数', 400, 'revision');
  let siteId = raw.siteId ?? '';
  if (typeof siteId !== 'string' || (siteId && !STABLE_ID.test(siteId))) throw fail('站点 id 无效', 400, 'siteId');
  siteId = siteId.trim();
  const independent = raw.independent ?? false;
  if (typeof independent !== 'boolean') throw fail('独立站点标记无效', 400, 'independent');
  if (independent && !siteId) throw fail('独立站点必须设置站点 id', 400, 'siteId');
  const baseURL = normalizeBaseURL(raw.baseURL);
  const protocol = raw.protocol ?? 'auto';
  if (!['auto', ...PROTOCOLS].includes(protocol)) throw fail('连接协议无效', 400, 'protocol');

  const apiPathsRaw = raw.apiPaths ?? {};
  if (!isObject(apiPathsRaw)) throw fail('连接 API 路径必须是对象', 400, 'apiPaths');
  const apiPaths = {};
  for (const [operation, path] of Object.entries(apiPathsRaw)) {
    if (BAD_KEYS.has(operation) || !PROTOCOLS.includes(operation)) throw fail('连接 API 路径包含未知协议', 400, 'apiPaths');
    if (typeof path !== 'string' || !/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path)) throw fail('连接 API 路径无效', 400, 'apiPaths');
    apiPaths[operation] = path;
  }

  const modelProtocolsRaw = raw.modelProtocols ?? {};
  if (!isObject(modelProtocolsRaw)) throw fail('连接模型协议必须是对象', 400, 'modelProtocols');
  const modelProtocols = {};
  for (const [model, value] of Object.entries(modelProtocolsRaw)) {
    if (!isText(model) || BAD_KEYS.has(model)) throw fail('连接模型协议名称无效', 400, 'modelProtocols');
    if (!PROTOCOLS.includes(value)) throw fail('连接模型协议无效', 400, 'modelProtocols');
    modelProtocols[model] = value;
  }

  const modelsRaw = raw.models ?? [];
  if (!Array.isArray(modelsRaw) || modelsRaw.some((item) => !isText(item)) || new Set(modelsRaw).size !== modelsRaw.length) throw fail('连接模型列表无效', 400, 'models');

  const authRaw = raw.auth ?? {};
  if (!isObject(authRaw)) throw fail('连接认证配置必须是对象', 400, 'auth');
  onlyKeys(authRaw, ['mode', 'key', 'value', 'source', 'provider', 'account'], 'auth');
  const mode = authRaw.mode ?? 'api-key';
  if (!AUTH_MODES.includes(mode)) throw fail('连接认证方式无效', 400, 'auth');
  const source = authRaw.source ?? 'stored';
  if (!AUTH_SOURCES.includes(source)) throw fail('连接认证来源无效', 400, 'auth');
  for (const key of ['key', 'value', 'provider', 'account']) {
    if (authRaw[key] !== undefined && typeof authRaw[key] !== 'string') throw fail('连接认证字段无效', 400, 'auth');
  }
  for (const key of ['key', 'value']) {
    const value = authRaw[key] ?? '';
    if (/[\r\n\u0000]/.test(value) || value.length > 16384) throw fail('连接凭据格式无效', 400, 'auth');
  }
  let auth;
  if (source === 'host') {
    auth = { mode, key: '', value: '', source, provider: text(authRaw.provider), account: text(authRaw.account) };
  } else {
    auth = { mode, key: authRaw.key ?? '', value: authRaw.value ?? '', source };
  }

  const binding = raw.binding === undefined ? undefined : normalizeBinding(raw.binding);
  const modelBindings = raw.modelBindings === undefined ? {} : normalizeModelBindings(raw.modelBindings);
  const newApiAccountId = raw.newApiAccountId;
  if (newApiAccountId !== undefined && (typeof newApiAccountId !== 'string' || newApiAccountId.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(newApiAccountId))) throw fail('余额与签到账号绑定无效', 400, 'newApiAccountId');

  return {
    id, name: raw.name.trim(), enabled, revision, siteId, independent, baseURL, protocol,
    apiPaths, modelProtocols, models: [...modelsRaw], auth, binding, modelBindings,
    ...(newApiAccountId !== undefined ? { newApiAccountId: newApiAccountId.trim() } : {}),
  };
}

function mergeAuth(existing, incoming, clearSecrets) {
  const auth = { ...incoming.auth };
  // Host login owns the credential. provider/account are an identity reference,
  // so changing them never carries a stored key forward.
  if (auth.source === 'host') return { ...auth, key: '', value: '' };
  const sameTarget = Boolean(existing) && existing.auth?.source === 'stored' &&
    targetOf(existing.baseURL) !== null && targetOf(existing.baseURL) === targetOf(incoming.baseURL);
  for (const field of ['key', 'value']) {
    if (clearSecrets.includes(field)) auth[field] = '';
    else if (!auth[field] && sameTarget) auth[field] = existing.auth?.[field] ?? '';
  }
  if (auth.mode === 'api-key' || auth.mode === 'bearer') auth.value = '';
  else if (auth.mode === 'custom') auth.key = '';
  else { auth.key = ''; auth.value = ''; }
  if (auth.source === 'stored') {
    if (['api-key', 'bearer'].includes(auth.mode) && !auth.key) throw fail('当前认证方式必须填写 key 凭据', 400, 'auth');
    if (auth.mode === 'custom' && !auth.value) throw fail('该认证方式必须填写凭据', 400, 'auth');
  }
  return auth;
}

function publicConnection(connection, secrets) {
  const output = structuredClone(connection);
  const key = Boolean(output.auth?.key);
  const value = Boolean(output.auth?.value);
  output.secrets = { key, value };
  if (!secrets && output.auth) {
    output.auth.key = '';
    output.auth.value = '';
  }
  return output;
}

function bindingProtocol(connection, model) {
  if (model && connection.modelProtocols?.[model]) return connection.modelProtocols[model];
  return connection.protocol === 'auto' ? undefined : connection.protocol;
}

function assertBindingResolvable(state, binding, protocol, { allowArchived = true } = {}) {
  const checkTemplate = (id, revision, expectedProtocol) => {
    const matches = state.templates.filter((item) => item.id === id && item.revision === revision);
    if (matches.length !== 1) throw fail('模板版本不存在', 400, 'binding');
    const template = matches[0];
    if (template.archived && !allowArchived) throw fail('已归档模板不能应用', 400, 'binding');
    if (expectedProtocol && !template.protocols.includes(expectedProtocol)) throw fail('模板协议与连接不匹配', 400, 'binding');
  };
  if (binding.mode === 'template') checkTemplate(binding.id, binding.revision, protocol);
  else if (binding.mode === 'auto') {
    const entries = Object.entries(binding.resolvedVersions);
    for (const [name, ref] of entries) checkTemplate(ref.id, ref.revision, name);
  } else if (binding.mode !== 'passthrough') throw fail('模板绑定模式无效', 400, 'binding');
}

function validateConnectionBindings(state, connection) {
  if (!connection.binding) throw fail('连接缺少模板绑定', 400, 'binding');
  assertBindingResolvable(state, connection.binding, bindingProtocol(connection));
  for (const [model, binding] of Object.entries(connection.modelBindings ?? {})) {
    assertBindingResolvable(state, binding, bindingProtocol(connection, model));
  }
}

function validateSites(connections) {
  const bases = new Map();
  for (const connection of connections) {
    if (!connection.siteId) continue;
    const target = targetOf(connection.baseURL);
    if (bases.has(connection.siteId) && bases.get(connection.siteId) !== target) throw fail('同一站点的 Base URL 必须一致', 400, 'siteId');
    bases.set(connection.siteId, target);
  }
  const independent = new Set(connections.filter((item) => item.independent).map((item) => item.siteId));
  if (independent.size > 8) throw fail('独立站点最多 8 个', 400, 'independent');
}

function normalizeState(raw) {
  try {
    if (!isObject(raw)) throw new Error();
    onlyKeys(raw, ['schemaVersion', 'generation', 'templates', 'connections'], 'store');
    if (raw.schemaVersion !== SCHEMA_VERSION) throw new Error();
    if (!Number.isInteger(raw.generation) || raw.generation < 0) throw new Error();
    if (!Array.isArray(raw.templates) || !Array.isArray(raw.connections)) throw new Error();
    const templates = raw.templates.map((item) => governTemplate(item));
    const versions = new Set();
    for (const template of templates) {
      const key = `${template.id}@${template.revision}`;
      if (versions.has(key)) throw new Error();
      versions.add(key);
    }
    const connections = raw.connections.map((item) => normalizeConnectionShape(item));
    const ids = new Set();
    for (const connection of connections) {
      if (!connection.id || ids.has(connection.id)) throw new Error();
      ids.add(connection.id);
      validateConnectionBindings({ templates, connections }, connection);
    }
    validateSites(connections);
    return { schemaVersion: SCHEMA_VERSION, generation: raw.generation, templates, connections };
  } catch {
    throw fail('状态文件内容无效，原文件未被修改', 500, 'store');
  }
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, generation: 0, templates: [], connections: [] };
}

export function createUAStore(path, { io = fs, uuid = randomUUID } = {}) {
  if (!isAbsolute(path)) throw new Error('UA PRO 状态文件必须使用绝对路径');
  const queueKey = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

  function enqueue(action) {
    const result = (writes.get(queueKey) ?? Promise.resolve()).then(action);
    const next = result.catch(() => {});
    writes.set(queueKey, next);
    next.finally(() => { if (writes.get(queueKey) === next) writes.delete(queueKey); });
    return result;
  }

  async function load() {
    let info;
    try {
      info = await io.lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw fail('无法读取状态文件，请检查文件权限', 500, 'store');
    }
    if (!info.isFile() || info.isSymbolicLink()) throw fail('状态文件必须是普通文件，不能使用符号链接', 500, 'store');
    if (info.size > MAX_STORE_BYTES) throw fail('状态文件过大', 500, 'store');
    let content;
    try {
      content = await io.readFile(path, 'utf8');
    } catch {
      throw fail('无法读取状态文件，请检查文件权限', 500, 'store');
    }
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw fail('状态文件过大', 500, 'store');
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw fail('状态文件内容无效，原文件未被修改', 500, 'store');
    }
    return normalizeState(parsed);
  }

  async function persist(state) {
    const content = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw fail('状态文件过大', 400, 'store');
    const folder = dirname(path);
    const temporary = join(folder, `.ua-store-${uuid()}.tmp`);
    let handle;
    try {
      await io.mkdir(folder, { recursive: true, mode: 0o700 });
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await io.rename(temporary, path);
    } catch {
      throw fail('状态保存失败，请检查目录权限与可用空间；原状态保留', 500, 'store');
    } finally {
      if (handle) await handle.close().catch(() => {});
      await io.unlink(temporary).catch(() => {});
    }
  }

  async function update(action) {
    return enqueue(async () => {
      const loaded = await load();
      const state = loaded ?? emptyState();
      const outcome = await action(state);
      if (outcome.changed) {
        state.generation = (loaded?.generation ?? 0) + 1;
        await persist(state);
      }
      return typeof outcome.value === 'function' ? outcome.value(state) : outcome.value;
    });
  }

  async function initialize() {
    return enqueue(async () => {
      const loaded = await load();
      const state = loaded ?? emptyState();
      const seeds = builtinTemplates();
      if (!Array.isArray(seeds) || seeds.length === 0) throw fail('内置模板数据无效', 500, 'builtinTemplates');
      const created = [];
      for (const seed of seeds) {
        const template = governTemplate(seed);
        if (![...BUILTIN_IDS, ...SEED_CUSTOM_IDS].includes(template.id)) throw fail('内置模板 id 无效', 500, 'builtinTemplates');
        if (state.templates.some((item) => item.id === template.id && item.revision === template.revision)) continue;
        state.templates.push(template);
        created.push({ id: template.id, revision: template.revision });
      }
      if (created.length === 0) return { generation: state.generation, created, changed: false };
      state.generation = (loaded?.generation ?? 0) + 1;
      await persist(state);
      return { generation: state.generation, created, changed: true };
    });
  }

  async function snapshot({ secrets = false } = {}) {
    return enqueue(async () => {
      const state = (await load()) ?? emptyState();
      return {
        schemaVersion: SCHEMA_VERSION,
        generation: state.generation,
        templates: state.templates.map((item) => publicTemplate(item)),
        connections: state.connections.map((item) => publicConnection(item, secrets === true)),
      };
    });
  }

  async function saveTemplate({ template: raw, expectedRevision } = {}) {
    if (!isObject(raw)) throw fail('模板必须是对象', 400, 'template');
    return update((state) => {
      const id = isText(raw.id) ? raw.id.trim() : `custom.${uuid()}`;
      if (id.startsWith('builtin.')) throw fail('内置模板只读，不能保存', 400, 'template');
      const history = state.templates.filter((item) => item.id === id);
      if (history.some((item) => item.kind === 'builtin')) throw fail('内置模板只读，不能保存', 400, 'template');
      const latest = history.reduce((max, item) => Math.max(max, item.revision), 0);
      if (expectedRevision !== undefined && expectedRevision !== latest) throw fail('模板已被其他窗口更新，请重新读取', 409, 'expectedRevision');
      const previous = history.find((item) => item.revision === latest);
      const template = governTemplate(raw, {
        id,
        revision: latest > 0 ? latest + 1 : 1,
      });
      template.archived = raw.archived ?? previous?.archived ?? false;
      if (template.kind !== 'custom') throw fail('内置模板只读，不能保存', 400, 'template');
      if (template.basedOn) assertTemplateRef(state.templates, template.basedOn.id, template.basedOn.revision);
      state.templates.push(template);
      return {
        changed: true,
        value: (next) => ({ template: publicTemplate(template), generation: next.generation }),
      };
    });
  }

  async function archiveTemplate({ id, archived = true } = {}) {
    return update((state) => {
      if (!isText(id)) throw fail('模板 id 缺失', 400, 'id');
      const templateId = id.trim();
      const revisions = state.templates.filter((item) => item.id === templateId);
      if (revisions.length === 0) throw fail('模板不存在', 404, 'id');
      if (revisions[0].kind !== 'custom') throw fail('内置模板只读，不能归档', 400, 'id');
      if (typeof archived !== 'boolean') throw fail('archived 必须是布尔值', 400, 'archived');
      let changed = false;
      for (const revision of revisions) {
        if (revision.archived !== archived) {
          revision.archived = archived;
          changed = true;
        }
      }
      return {
        changed,
        value: (next) => ({ id: templateId, archived, generation: next.generation }),
      };
    });
  }

  function referencedTemplate(state, id, revision) {
    const matches = (binding) => {
      if (binding?.mode === 'template') return binding.id === id && (revision === undefined || binding.revision === revision);
      if (binding?.mode === 'auto') {
        return Object.values(binding.resolvedVersions ?? {}).some((ref) => ref?.id === id && (revision === undefined || ref.revision === revision));
      }
      return false;
    };
    return state.connections.some((connection) => matches(connection.binding) || Object.values(connection.modelBindings ?? {}).some(matches));
  }

  async function removeTemplate({ id, revision } = {}) {
    return update((state) => {
      if (!isText(id)) throw fail('模板 id 缺失', 400, 'id');
      const templateId = id.trim();
      const all = state.templates.filter((item) => item.id === templateId);
      if (all.length === 0) throw fail('模板不存在', 404, 'id');
      if (all[0].kind !== 'custom') throw fail('内置模板只读，不能删除', 400, 'id');
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw fail('模板 revision 无效', 400, 'revision');
      const targets = revision === undefined ? all : all.filter((item) => item.revision === revision);
      if (targets.length === 0) throw fail('模板不存在', 404, 'id');
      // Deleting the seeded revision would make service.initialize resurrect it on
      // the next request; the seed revision is archive-only.
      if (targets.some((item) => PROTECTED_SEED_VERSIONS.has(`${item.id}@${item.revision}`))) {
        throw fail('内置种子模板版本不能删除，请使用归档', 400, 'id');
      }
      if (referencedTemplate(state, templateId, revision)) throw fail('模板版本正被连接使用，不能删除', 409, 'id');
      state.templates = state.templates.filter((item) => !targets.includes(item));
      return {
        changed: true,
        value: (next) => ({ id: templateId, removed: targets.map((item) => item.revision), generation: next.generation }),
      };
    });
  }

  async function prepareConnection({ connection: raw, expectedRevision, clearSecrets = [] } = {}) {
    if (!isObject(raw)) throw fail('连接必须是对象', 400, 'connection');
    if (!Array.isArray(clearSecrets) || clearSecrets.some(field => !['key', 'value'].includes(field))) throw fail('clearSecrets 无效', 400, 'clearSecrets');
    const shape = normalizeConnectionShape({ ...raw, name: isText(raw.name) ? raw.name : '未保存连接', models: [], modelProtocols: {}, binding: undefined, modelBindings: {}, siteId: '', independent: false });
    return enqueue(async () => {
      const state = await load();
      const existing = shape.id ? state?.connections.find(item => item.id === shape.id) : undefined;
      if (shape.id && !existing) throw fail('连接已移除，请重新读取', 404, 'connection');
      const revision = expectedRevision ?? raw.revision;
      if (existing && revision !== undefined && revision !== existing.revision) throw fail('连接已被其他窗口更新，请重新读取', 409, 'expectedRevision');
      if (shape.auth.source === 'host') {
        if (!existing || existing.auth.source !== 'host' || shape.auth.provider !== existing.auth.provider || shape.auth.account !== existing.auth.account || shape.auth.mode !== existing.auth.mode) throw fail('宿主账号引用已改变，请重新读取连接', 409, 'auth');
        if (targetOf(shape.baseURL) !== targetOf(existing.baseURL)) throw fail('宿主账号地址已改变，请重新建立对应连接', 409, 'baseURL');
        if (clearSecrets.length) throw fail('宿主凭据已标记清除，不能用于查询', 400, 'auth');
      }
      return { ...shape, auth: mergeAuth(existing, shape, clearSecrets) };
    });
  }

  async function saveConnection({ connection: raw, expectedRevision, clearSecrets = [] } = {}) {
    if (!isObject(raw)) throw fail('连接必须是对象', 400, 'connection');
    if (!Array.isArray(clearSecrets) || clearSecrets.some((field) => !['key', 'value'].includes(field))) throw fail('clearSecrets 无效', 400, 'clearSecrets');
    return update((state) => {
      const shape = normalizeConnectionShape(raw);
      const existing = shape.id ? state.connections.find((item) => item.id === shape.id) : undefined;
      if (!shape.id) shape.id = `connection.${uuid()}`;
      if (!existing && expectedRevision !== undefined && expectedRevision !== 0) throw fail('连接已被其他窗口更新，请重新读取', 409, 'expectedRevision');
      if (existing) {
        if (expectedRevision !== undefined && expectedRevision !== existing.revision) throw fail('连接已被其他窗口更新，请重新读取', 409, 'expectedRevision');
        shape.revision = existing.revision + 1;
        shape.binding = structuredClone(existing.binding);
        shape.modelBindings = structuredClone(existing.modelBindings ?? {});
      } else {
        shape.revision = 1;
        shape.binding = shape.binding ?? { mode: 'auto', resolvedVersions: structuredClone(DEFAULT_AUTO_RESOLVED) };
      }
      shape.auth = mergeAuth(existing, shape, clearSecrets);
      const connections = existing
        ? state.connections.map((item) => (item.id === shape.id ? shape : item))
        : [...state.connections, shape];
      validateSites(connections);
      validateConnectionBindings({ templates: state.templates }, shape);
      state.connections = connections;
      return {
        changed: true,
        value: (next) => ({ connection: publicConnection(shape, false), generation: next.generation }),
      };
    });
  }

  async function removeConnection({ id, expectedRevision } = {}, { beforeRemove } = {}) {
    return update(async (state) => {
      if (!isText(id)) throw fail('连接 id 缺失', 400, 'id');
      const connectionId = id.trim();
      const existing = state.connections.find((item) => item.id === connectionId);
      if (!existing) throw fail('连接不存在', 404, 'id');
      if (expectedRevision !== undefined && expectedRevision !== existing.revision) throw fail('连接已被其他窗口更新，请重新读取', 409, 'expectedRevision');
      await beforeRemove?.(publicConnection(existing, false));
      state.connections = state.connections.filter((item) => item.id !== connectionId);
      return { changed: true, value: (next) => ({ id: connectionId, generation: next.generation }) };
    });
  }

  async function applyBinding({ connectionIds, binding, model, expectedGeneration } = {}) {
    return update((state) => {
      if (!Number.isInteger(expectedGeneration) || expectedGeneration !== state.generation) throw fail('配置已被其他窗口更新，请重新读取', 409, 'expectedGeneration');
      if (!Array.isArray(connectionIds) || connectionIds.length === 0) throw fail('必须选择至少一个连接', 400, 'connectionIds');
      if (connectionIds.some((id) => !isText(id))) throw fail('连接 id 无效', 400, 'connectionIds');
      const ids = connectionIds.map((id) => id.trim());
      if (new Set(ids).size !== ids.length) throw fail('连接不能重复', 400, 'connectionIds');
      if (model !== undefined && !isText(model)) throw fail('模型名称无效', 400, 'model');
      const normalized = normalizeBinding(binding);
      const targets = ids.map((id) => {
        const connection = state.connections.find((item) => item.id === id);
        if (!connection) throw fail('连接不存在', 404, 'connectionIds');
        return connection;
      });
      // A connection protocol of 'auto' without a model override cannot prove one
      // template matches every possible target. The binding is still accepted;
      // resolveTemplate/transform reject a mismatching final protocol per request.
      for (const connection of targets) assertBindingResolvable(state, normalized, bindingProtocol(connection, model?.trim()), { allowArchived: false });
      for (const connection of targets) {
        if (model !== undefined) connection.modelBindings = { ...connection.modelBindings, [model.trim()]: structuredClone(normalized) };
        else connection.binding = structuredClone(normalized);
        connection.revision += 1;
      }
      return {
        changed: true,
        value: (next) => ({ generation: next.generation, connections: targets.map((item) => publicConnection(item, false)) }),
      };
    });
  }

  async function applyModelRoute({ connectionId, model, protocol, binding, expectedGeneration } = {}) {
    return update(state => {
      if (!Number.isInteger(expectedGeneration) || expectedGeneration !== state.generation) throw fail('配置已被其他窗口更新，请重新读取', 409, 'expectedGeneration');
      if (!isText(connectionId) || !isText(model) || BAD_KEYS.has(model.trim()) || model.trim().length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(model) || !PROTOCOLS.includes(protocol)) throw fail('模型路由参数无效', 400, 'model');
      const existing = state.connections.find(item => item.id === connectionId);
      if (!existing) throw fail('连接不存在', 404, 'connectionId');
      const normalized = normalizeBinding(binding);
      const target = { ...existing, revision: existing.revision + 1, modelProtocols: { ...existing.modelProtocols, [model.trim()]: protocol }, modelBindings: { ...existing.modelBindings, [model.trim()]: normalized } };
      assertBindingResolvable(state, normalized, protocol, { allowArchived: false });
      validateConnectionBindings(state, target);
      state.connections = state.connections.map(item => item.id === connectionId ? target : item);
      return { changed: true, value: next => ({ generation: next.generation, connection: publicConnection(target, false) }) };
    });
  }

  return {
    path, initialize, snapshot, saveTemplate, archiveTemplate, removeTemplate,
    prepareConnection, saveConnection, removeConnection, applyBinding, applyModelRoute,
  };
}

export function resolveTemplate(snapshot, connection, protocol, model) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.templates)) throw fail('状态快照无效', 400, 'snapshot');
  if (!PROTOCOLS.includes(protocol)) throw fail('未知上游协议', 400, 'protocol');
  if (!isObject(connection)) throw fail('连接无效', 400, 'connection');
  const binding = model && isObject(connection.modelBindings) && Object.hasOwn(connection.modelBindings, model)
    ? connection.modelBindings[model]
    : connection.binding;
  if (!isObject(binding)) throw fail('连接缺少模板绑定', 400, 'binding');
  if (binding.mode === 'passthrough') return null;
  if (binding.mode === 'auto') {
    const ref = binding.resolvedVersions?.[protocol];
    if (!ref) {
      if (protocol === 'chat-completions' || protocol === 'gemini') return null;
      throw fail('auto 绑定缺少协议版本', 400, 'binding');
    }
    return findTemplate(snapshot, ref, protocol);
  }
  if (binding.mode === 'template') return findTemplate(snapshot, binding, protocol);
  throw fail('模板绑定模式无效', 400, 'binding');
}

function findTemplate(snapshot, ref, protocol) {
  if (!isObject(ref) || !isText(ref.id) || !Number.isInteger(ref.revision)) throw fail('模板版本缺失或损坏，拒绝回退', 400, 'binding');
  const matches = snapshot.templates.filter((item) => item.id === ref.id && item.revision === ref.revision);
  if (matches.length !== 1) throw fail('模板版本缺失或损坏，拒绝回退', 400, 'binding');
  if (!Array.isArray(matches[0].protocols) || !matches[0].protocols.includes(protocol)) throw fail('模板协议不匹配', 400, 'protocol');
  return resolvedTemplate(matches[0]);
}