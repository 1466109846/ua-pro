import { createHash } from 'node:crypto';
import { applyParameters, compileParameters, isObject } from '../lib/parameters.mjs';

// Pinned to sub2api-magpie-plugin a22d079b (0.4.16), not a live client version.
const CODEX_VERSION = '0.159.0';
const CLAUDE_VERSION = '2.1.296';
const IDENTITY_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const FAST_BETA = 'fast-mode-2026-02-01';
const LIMITS = { maxBodyBytes: 32 << 20, bodyTimeoutMs: 15000, maxMetadataBytes: 1 << 20 };
const OPERATIONS = { anthropic: ['messages', 'count_tokens'], responses: ['responses'], 'chat-completions': ['chat/completions'], gemini: ['generateContent', 'streamGenerateContent', 'countTokens'] };
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BUSINESS = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice', 'input', 'contents', 'systemInstruction']);
const PROTECTED = new Set(['authorization', 'proxy-authorization', 'proxy-authenticate', 'www-authenticate', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'set-cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'proxy-connection', 'accept-encoding', 'x-openai-actor-authorization', 'x-anthropic-billing-header', 'x-sub2api-magpie-plugin-speed-model']);
const VARIABLES = new Set(['session.id', 'request.id', 'client.version', 'model.id', 'reasoning.effort', 'timestamp', 'platform', 'arch', 'terminal']);
const SESSION_HEADERS = ['session-id', 'session_id', 'x-session-id', 'x-claude-code-session-id', 'x-opencode-session'];
const CODEX_FAMILY = /^(?:codex_cli_rs|codex-tui|codex_vscode_copilot|codex_vscode|codex_app|codex_chatgpt_desktop|codex_atlas|codex_exec|codex_sdk_ts)$/;
const VS_BETA = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31';

function error(path, message = 'UA PRO configuration is invalid', status = 400) {
  const e = new Error(message); e.status = status; e.fields = { [path]: message }; return e;
}
function known(value, keys, path) {
  if (!isObject(value) || Object.keys(value).some(k => !keys.includes(k))) throw error(path);
}
function enumeration(value, values, path) {
  if (!values.includes(value)) throw error(path); return value;
}
function text(value, path, max = 16384, blank = true) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || (!blank && !value.trim())) throw error(path);
  return value;
}
function protectedHeader(name) { return PROTECTED.has(name) || name.startsWith('x-magpie-'); }
function billingKey(name) { return /^(?:billing(?:[_-].*)?|x[_-]anthropic[_-]billing[_-]header)$/i.test(name); }
const billingBlock = value => typeof value === 'string' && /^\s*x-anthropic-billing-header\s*:/i.test(value);
const optional = (value, fallback) => value === undefined ? fallback : value;
function billingSnapshot(payload) {
  const records = []; const pending = [[payload, 'body']];
  while (pending.length) {
    const [value, path] = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [name, child] of Object.entries(value)) {
      const next = `${path}.${Array.isArray(value) ? '*' : name}`;
      if (billingKey(name)) records.push([next, JSON.stringify(child)]);
      else if (child !== null && typeof child === 'object') pending.push([child, next]);
    }
  }
  // Only actual existing system billing blocks are identity-protected. Prompt
  // prose mentioning the header name remains ordinary user configuration.
  const system = payload.system;
  if (billingBlock(system)) records.push(['body.system.billing', JSON.stringify({ type: 'text', text: system })]);
  if (Array.isArray(system)) for (const block of system) {
    if (block?.type === 'text' && billingBlock(block.text)) records.push(['body.system.billing', JSON.stringify(block)]);
  }
  return JSON.stringify(records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function headerText(value, path) {
  text(value, path);
  if (/[^\u0020-\u00ff]/u.test(value)) throw error(path);
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('{{', cursor); const close = value.indexOf('}}', cursor);
    if (open < 0 && close < 0) break;
    if (open < 0 || (close >= 0 && close < open)) throw error(path);
    const end = value.indexOf('}}', open + 2);
    if (end < 0 || !VARIABLES.has(value.slice(open + 2, end))) throw error(path);
    cursor = end + 2;
  }
  return value;
}
function json(value, path, depth = 0) {
  if (depth > 32) throw error(path);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => json(v, path, depth + 1));
  if (!isObject(value)) throw error(path);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (BAD_KEYS.has(key) || billingKey(key)) throw error(path);
    out[key] = json(val, path, depth + 1);
  }
  return out;
}
function parameters(raw = {}) {
  known(raw, ['defaults', 'overrides', 'remove'], 'body.parameters');
  const result = {};
  for (const section of ['defaults', 'overrides']) {
    const values = optional(raw[section], {});
    if (!isObject(values) || Object.keys(values).some(k => BUSINESS.has(k))) throw error(`body.parameters.${section}`);
    result[section] = json(values, `body.parameters.${section}`);
  }
  const remove = optional(raw.remove, []);
  if (!Array.isArray(remove) || remove.length > 256) throw error('body.parameters.remove');
  result.remove = remove.map(path => {
    if (typeof path !== 'string' || path.length > 512 || !/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(path)) throw error('body.parameters.remove');
    const keys = path.split('.');
    if (BUSINESS.has(keys[0]) || keys.some(k => BAD_KEYS.has(k) || billingKey(k))) throw error('body.parameters.remove');
    return path;
  });
  return result;
}

export function validateTemplate(raw) {
  known(raw, ['schemaVersion', 'id', 'name', 'revision', 'kind', 'basedOn', 'protocols', 'operations', 'identity', 'headers', 'body', 'limits', 'archived'], 'template');
  if (raw.schemaVersion !== 1) throw error('schemaVersion');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw error('revision');
  const out = { schemaVersion: 1, id: text(raw.id, 'id', 160, false), name: text(raw.name, 'name', 160, false), revision: raw.revision, kind: enumeration(raw.kind, ['builtin', 'custom'], 'kind') };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(out.id)) throw error('id');
  if (raw.archived !== undefined) {
    if (typeof raw.archived !== 'boolean') throw error('archived');
    out.archived = raw.archived;
  }
  if (raw.basedOn !== undefined) {
    known(raw.basedOn, ['id', 'revision'], 'basedOn');
    if (!Number.isSafeInteger(raw.basedOn.revision) || raw.basedOn.revision < 1) throw error('basedOn.revision');
    out.basedOn = { id: text(raw.basedOn.id, 'basedOn.id', 160, false), revision: raw.basedOn.revision };
  }
  if (!Array.isArray(raw.protocols) || !raw.protocols.length || raw.protocols.length > 4) throw error('protocols');
  out.protocols = [...new Set(raw.protocols.map(p => enumeration(p, Object.keys(OPERATIONS), 'protocols')))];
  if (!Array.isArray(raw.operations) || !raw.operations.length || raw.operations.length > 7) throw error('operations');
  out.operations = [...new Set(raw.operations.map(o => enumeration(o, out.protocols.flatMap(p => OPERATIONS[p]), 'operations')))];
  const identity = optional(raw.identity, {});
  known(identity, ['detector', 'mode', 'session', 'userAgent', 'version'], 'identity');
  out.identity = {
    detector: enumeration(optional(identity.detector, 'none'), ['codex-ua', 'claude-ua', 'none'], 'identity.detector'),
    mode: enumeration(optional(identity.mode, 'preserve'), ['reference-compatible', 'preserve'], 'identity.mode'),
    session: enumeration(optional(identity.session, 'preserve'), ['reference-stable', 'host', 'preserve', 'off'], 'identity.session'),
    userAgent: headerText(optional(identity.userAgent, ''), 'identity.userAgent'), version: headerText(optional(identity.version, ''), 'identity.version'),
  };
  if (!Array.isArray(raw.headers) || raw.headers.length > 128) throw error('headers');
  let headerBytes = 0;
  out.headers = raw.headers.map((h, i) => {
    const path = `headers[${i}]`;
    known(h, ['name', 'action', 'value', 'enabled', 'when', 'operations'], path);
    if (typeof h.name !== 'string' || h.name.length > 256 || !TOKEN.test(h.name)) throw error(`${path}.name`);
    const name = h.name.toLowerCase();
    if (protectedHeader(name) || name === 'content-encoding') throw error(`${path}.name`);
    const action = enumeration(h.action, ['set', 'set-if-missing', 'set-if-empty', 'delete', 'preserve'], `${path}.action`);
    if (h.enabled !== undefined && typeof h.enabled !== 'boolean') throw error(`${path}.enabled`);
    const entry = { name, action, enabled: optional(h.enabled, true), when: enumeration(optional(h.when, 'always'), ['always', 'native', 'third-party'], `${path}.when`) };
    if (h.operations !== undefined) {
      if (!Array.isArray(h.operations) || !h.operations.length || h.operations.length > 7) throw error(`${path}.operations`);
      entry.operations = [...new Set(h.operations.map(o => enumeration(o, out.operations, `${path}.operations`)))];
    }
    if (h.value !== undefined) entry.value = h.value === null ? null : headerText(h.value, `${path}.value`);
    if (!['delete', 'preserve'].includes(action) && h.value === undefined) throw error(`${path}.value`);
    headerBytes += name.length + (entry.value?.length ?? 0) + 4;
    return entry;
  });
  if (headerBytes > 65536) throw error('headers');
  const body = optional(raw.body, {});
  known(body, ['codexMetadata', 'claudeCompatibility', 'identityprompt', 'fastBeta', 'parameters', 'promptCacheKey'], 'body');
  if (body.codexMetadata !== undefined && typeof body.codexMetadata !== 'boolean') throw error('body.codexMetadata');
  if (body.fastBeta !== undefined && typeof body.fastBeta !== 'boolean') throw error('body.fastBeta');
  out.body = { codexMetadata: optional(body.codexMetadata, false), claudeCompatibility: enumeration(optional(body.claudeCompatibility, 'off'), ['third-party-messages', 'off'], 'body.claudeCompatibility'), fastBeta: optional(body.fastBeta, false), parameters: parameters(body.parameters) };
  if (body.promptCacheKey !== undefined) out.body.promptCacheKey = enumeration(body.promptCacheKey, ['off', 'session'], 'body.promptCacheKey');
  if (body.identityprompt !== undefined) {
    if (typeof body.identityprompt !== 'string' || !body.identityprompt.trim() || body.identityprompt.length > 8192 || body.identityprompt.includes('\0')) throw error('body.identityprompt');
    out.body.identityprompt = body.identityprompt;
  }
  // Reuse Messages' established compile-time parameter restrictions.
  if (out.protocols.includes('anthropic')) {
    try { compileParameters(out.body.parameters); } catch { throw error('body.parameters', 'Messages parameter rules are invalid'); }
  }
  const limits = optional(raw.limits, {});
  known(limits, Object.keys(LIMITS), 'limits'); out.limits = {};
  for (const key of Object.keys(LIMITS)) {
    const max = key === 'maxBodyBytes' ? 64 << 20 : key === 'maxMetadataBytes' ? 4 << 20 : 60000;
    const value = optional(limits[key], LIMITS[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw error(`limits.${key}`);
    out.limits[key] = value;
  }
  return out;
}

function header(name, action, value, when = 'always') { return { name, action, ...(value === undefined ? {} : { value }), enabled: true, when }; }
export function builtinTemplates() {
  const make = (id, name, protocol, detector, version, userAgent) => ({
    schemaVersion: 1, id, name, revision: 1, kind: 'builtin', protocols: [protocol], operations: [...OPERATIONS[protocol]],
    identity: { detector, mode: 'reference-compatible', session: 'reference-stable', userAgent, version }, headers: [],
    body: { codexMetadata: false, claudeCompatibility: 'off', fastBeta: false, parameters: { defaults: {}, overrides: {}, remove: [] } }, limits: { ...LIMITS },
  });
  const codex = make('builtin.codex', 'Codex', 'responses', 'codex-ua', CODEX_VERSION, 'codex_cli_rs/{{client.version}} ({{platform}}; {{arch}}) {{terminal}}');
  codex.headers = [header('openai-beta', 'set-if-missing', 'responses=experimental'), header('originator', 'set-if-missing', 'codex_cli_rs'), header('version', 'set-if-missing', '{{client.version}}')];
  codex.body.codexMetadata = true;
  const claude = make('builtin.claude-code', 'Claude Code', 'anthropic', 'claude-ua', CLAUDE_VERSION, `claude-cli/${CLAUDE_VERSION} (external, cli)`);
  claude.headers = [header('x-app', 'set-if-missing', 'cli'), header('anthropic-version', 'set-if-missing', '2023-06-01')];
  // These empty-value rules apply to third-party Messages inference only.
  claude.headers.push(...[header('x-app', 'set-if-empty', 'cli', 'third-party'), header('anthropic-version', 'set-if-empty', '2023-06-01', 'third-party'), header('anthropic-beta', 'set-if-empty', 'claude-code-20250219', 'third-party')].map(h => ({ ...h, operations: ['messages'] })));
  claude.body.claudeCompatibility = 'third-party-messages'; claude.body.fastBeta = true; claude.body.identityprompt = IDENTITY_PROMPT;
  const custom = make('custom.claude-vscode-2316', 'Claude Code VS Code 2.1.316', 'anthropic', 'claude-ua', '2.1.316', 'claude-cli/2.1.316 (external, claude-vscode, agent-sdk/0.3.316)');
  custom.kind = 'custom'; custom.basedOn = { id: claude.id, revision: 1 }; custom.identity.mode = 'preserve'; custom.identity.session = 'preserve';
  custom.headers = Object.entries({ accept: 'application/json', 'anthropic-beta': VS_BETA, 'anthropic-dangerous-direct-browser-access': 'true', 'anthropic-version': '2023-06-01', 'user-agent': custom.identity.userAgent, 'x-app': 'cli', 'x-stainless-arch': 'x64', 'x-stainless-lang': 'js', 'x-stainless-os': 'Windows', 'x-stainless-package-version': '0.128.0', 'x-stainless-retry-count': '0', 'x-stainless-runtime': 'node', 'x-stainless-runtime-version': 'v26.12.1', 'x-stainless-timeout': '300' }).map(([n, v]) => header(n, 'set', v));
  return [codex, claude, custom];
}

const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function uuid(...parts) {
  const h = hash('codex-identity', ...parts).slice(0, 32);
  const id = h.slice(0, 12) + '4' + h.slice(13, 16) + (8 + (parseInt(h[16], 16) & 3)).toString(16) + h.slice(17);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
function nativeCaller(detector, headers) {
  const ua = (headers.get('user-agent') ?? '').trim().toLowerCase();
  if (detector === 'claude-ua') return /^claude-cli\/\d+\.\d+\.\d+/.test(ua);
  if (detector !== 'codex-ua') return false;
  const slash = ua.indexOf('/');
  if (slash < 0 || !/^\d+\.\d+\.\d+/.test(ua.slice(slash + 1).split(/[ (]/)[0])) return false;
  if (CODEX_FAMILY.test(ua.slice(0, slash)) || ua.startsWith('codex ')) return true;
  const open = ua.lastIndexOf('('); const close = ua.indexOf(')', open + 1);
  const trailer = open >= 0 && close >= 0 ? ua.slice(open + 1, close).split(';')[0].trim() : '';
  return CODEX_FAMILY.test(trailer) || trailer.startsWith('codex ');
}
function signalAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
}
// Race each asynchronous read, including Blob.text. Cancel clone readers without
// awaiting tee cancellation: it may wait for the untouched original Request.
async function readBody(input, init, max, timeoutMs, signal) {
  signalAbort(signal);
  const source = init.body ?? (input instanceof Request ? input.body : undefined);
  if (source === undefined || source === null) return { reason: 'absent' };
  const failSize = () => ({ reason: 'size' });
  if (typeof source === 'string') return Buffer.byteLength(source) <= max ? { text: source } : failSize();
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    if (source.byteLength > max) return failSize();
    const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
    return { text: new TextDecoder().decode(bytes) };
  }
  const blob = source instanceof Blob;
  if (blob && source.size > max) return failSize();
  if (!blob && (init.body != null || !(input instanceof Request) || input.bodyUsed || !input.body)) return { reason: 'stream' };
  let reader; let timer; let onAbort;
  const stop = new Promise((resolve, reject) => {
    timer = setTimeout(() => resolve({ reason: 'timeout' }), timeoutMs);
    onAbort = () => reject(signal.reason ?? new DOMException('Request aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const work = async () => {
    if (blob) {
      const value = await source.text();
      return typeof value === 'string' && Buffer.byteLength(value) <= max ? { text: value } : failSize();
    }
    reader = input.clone().body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      signalAbort(signal);
      if (done) return { text: Buffer.concat(chunks, size).toString('utf8') };
      size += value.byteLength;
      if (size > max) return failSize();
      chunks.push(Buffer.from(value));
    }
  };
  try { return await Promise.race([work(), stop]); }
  catch (e) { signalAbort(signal); return { reason: 'unreadable' }; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    if (reader) {
      try { void reader.cancel().catch(() => {}); reader.releaseLock(); } catch { /* already closed */ }
    }
  }
}
function validUserID(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const raw = value.trim();
  if (raw[0] !== '{') return /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/.test(raw);
  let parsed; try { parsed = JSON.parse(raw); } catch { return false; }
  if (!isObject(parsed)) return false;
  const fields = Object.create(null);
  for (const [name, field] of Object.entries(parsed)) {
    const key = name.toLowerCase();
    if (!['device_id', 'account_uuid', 'session_id'].includes(key) || field === null) continue;
    if (typeof field !== 'string') return false;
    fields[key] = field;
  }
  return Boolean(fields.device_id && fields.session_id);
}
function messageSession(payload) {
  const userID = payload?.metadata?.user_id;
  if (typeof userID !== 'string') return undefined;
  try {
    const identity = JSON.parse(userID);
    if (!isObject(identity)) return undefined;
    const field = Object.keys(identity).find(name => name.toLowerCase() === 'session_id');
    return field && typeof identity[field] === 'string' ? identity[field] : undefined;
  } catch { return /_session_([a-fA-F0-9-]{36})$/.exec(userID)?.[1]; }
}
function systemBlocks(system, prompt) {
  if (system === undefined || system === null || system === '') return [{ type: 'text', text: prompt }];
  const matches = value => typeof value === 'string' && value.length <= Math.max(512, prompt.length * 2) && value.split(/\s+/).join(' ').trim() === prompt.split(/\s+/).join(' ').trim();
  if (typeof system === 'string') return matches(system) ? [{ type: 'text', text: system }] : [{ type: 'text', text: prompt }, { type: 'text', text: system }];
  if (!Array.isArray(system)) throw error('body.system', 'Messages system must be a string or block array');
  return system.some(b => matches(b?.text)) ? undefined : [{ type: 'text', text: prompt }, ...system];
}
function mergeJSON(target, source, defaults) {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) target[key] = structuredClone(value);
    else if (isObject(value) && isObject(target[key])) mergeJSON(target[key], value, defaults);
    else if (!defaults) target[key] = structuredClone(value);
  }
}
function applyGeneric(payload, plan) {
  const result = structuredClone(payload);
  mergeJSON(result, plan.defaults, true); mergeJSON(result, plan.overrides, false);
  for (const path of plan.remove) {
    const keys = path.split('.'); let parent = result;
    for (const key of keys.slice(0, -1)) { parent = isObject(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined; }
    if (isObject(parent)) delete parent[keys.at(-1)];
  }
  return result;
}
function render(value, variables) {
  let missing = false;
  const output = value.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
    const replacement = variables[key];
    if (replacement === undefined || replacement === null || replacement === '') { missing = true; return ''; }
    return String(replacement);
  });
  if (missing) return undefined;
  // Substituted context is literal HTTP text, not another template to compile.
  try {
    text(output, 'context');
    if (/[^\u0020-\u00ff]/u.test(output)) throw error('context');
    return output;
  } catch { throw error('context', 'Request context cannot be used in an HTTP header'); }
}

export async function transformRequest({ template, protocol, operation, input, init = {}, context = {} }) {
  if (!Object.hasOwn(OPERATIONS, protocol) || !OPERATIONS[protocol].includes(operation)) throw error('operation', 'Protocol and operation do not match');
  const t = template == null ? null : validateTemplate(template);
  if (t && (!t.protocols.includes(protocol) || !t.operations.includes(operation))) throw error('template', 'Template does not match protocol and operation');
  const original = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => original.set(name, value));
  const headers = new Headers(original);
  const ua = (original.get('user-agent') ?? '').trim();
  const visibleUA = Boolean(ua && !/^magpie(?:[/-]|$)/i.test(ua));
  const native = t ? nativeCaller(t.identity.detector, original) : false;
  const sessionHeader = SESSION_HEADERS.map(n => original.get(n)?.trim()).find(Boolean);
  const hostSession = typeof context.sessionID === 'string' && context.sessionID.trim() ? context.sessionID : undefined;
  const summary = { templateId: t?.id ?? null, revision: t?.revision ?? null, callerIdentity: native ? 'native' : visibleUA ? 'third-party' : 'unknown', sourceAvailability: { userAgent: visibleUA ? 'available' : 'unknown', session: hostSession ? 'host' : sessionHeader ? 'inbound' : 'unknown', credentialScope: context.credentialScope ? 'available' : 'unknown' }, changes: [] };
  const change = (path, rule, action) => summary.changes.push({ path, rule, action });
  const set = (name, value, rule) => {
    if (headers.get(name) !== value) { headers.set(name, value); change(`headers.${name}`, rule, 'set'); }
  };
  const del = (name, rule) => { if (headers.has(name)) { headers.delete(name); change(`headers.${name}`, rule, 'delete'); } };
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  signalAbort(signal);
  let resultBody; let rewritten = false;
  if (t) {
    const mode = t.identity.mode === 'reference-compatible';
    const sessionMode = t.identity.session;
    const messages = protocol === 'anthropic' && operation === 'messages';
    const complete = messages && !native && t.body.claudeCompatibility === 'third-party-messages';
    const cacheKey = t.body.promptCacheKey === 'session' && ['messages', 'responses'].includes(operation);
    const plan = t.body.parameters;
    const active = !['count_tokens', 'countTokens'].includes(operation) && (Object.keys(plan.defaults).length || Object.keys(plan.overrides).length || plan.remove.length);
    const method = (init.method ?? (input instanceof Request ? input.method : 'POST')).toUpperCase();
    const hasBody = init.body != null || (input instanceof Request && input.body !== null);
    const canBody = !['GET', 'HEAD'].includes(method) && hasBody;
    const required = canBody && (complete || active || cacheKey);
    if (cacheKey && !canBody) throw error('body.prompt_cache_key', 'A request body is required for the configured prompt_cache_key rule');
    const encoded = headers.has('content-encoding') && headers.get('content-encoding').toLowerCase().trim() !== 'identity';
    if (required && encoded) throw error('body', 'Request body must be uncompressed for body transformation');
    let payload;
    const needsBodyVariables = t.headers.some(h => h.enabled && typeof h.value === 'string' && (h.value.includes('{{model.id}}') || h.value.includes('{{reasoning.effort}}')));
    const inspect = required || (canBody && ((t.body.codexMetadata && protocol === 'responses') || (messages && t.body.fastBeta) || needsBodyVariables));
    if (inspect && !encoded) {
      const read = await readBody(input, init, required ? t.limits.maxBodyBytes : t.limits.maxMetadataBytes, t.limits.bodyTimeoutMs, signal);
      signalAbort(signal);
      if (read.text !== undefined) {
        try { payload = JSON.parse(read.text); } catch { /* checked below */ }
        if (!isObject(payload)) payload = undefined;
      }
      if (required && !payload) {
        const reasons = { size: 'Request body exceeds the byte limit', timeout: 'Request body read timeout', stream: 'Streaming upload body cannot be transformed', unreadable: 'Request body is unreadable', absent: 'Request body is required' };
        throw error('body', reasons[read.reason] ?? 'Request body must be a JSON object');
      }
      if (!payload) change('body', `inspection-${read.reason ?? 'invalid-json'}`, 'skip');
    }
    const protectedBilling = payload && required ? billingSnapshot(payload) : undefined;
    const bodyModel = typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined;
    const cacheSession = cacheKey ? sessionHeader || messageSession(payload) || hostSession : undefined;
    const scope = typeof context.credentialScope === 'string' ? context.credentialScope : '';
    const base = typeof context.baseURL === 'string' ? context.baseURL : '';
    if (t.body.codexMetadata && protocol === 'responses' && payload) {
      let size = 0;
      const promote = (name, value) => {
        const lower = name.toLowerCase();
        if (headers.has(lower) || headers.has(lower.replace(/-/g, '_')) || protectedHeader(lower) || typeof value !== 'string' || !value.trim() || size + name.length + value.length + 4 > 8192) return;
        try { headerText(value, 'metadata'); set(lower, value, 'codex-metadata'); size += name.length + value.length + 4; } catch { /* untrusted metadata is optional */ }
      };
      if (isObject(payload.client_metadata)) for (const [field, value] of Object.entries(payload.client_metadata)) {
        const name = field === 'session_id' ? 'session-id' : field === 'thread_id' ? 'thread-id' : field;
        if (['session-id', 'thread-id'].includes(name) || /^x-codex-[!#$%&'*+.^_`|~0-9A-Za-z-]+$/i.test(name)) promote(name, value);
      }
      promote('session-id', payload.prompt_cache_key); promote('thread-id', payload.prompt_cache_key);
    }
    let version = t.identity.version;
    if (t.identity.detector === 'codex-ua') {
      const given = (original.get('version') ?? '').trim();
      const fromUA = /^(?:codex[^/\s]*|acp-extension-codex|Codex Desktop)\/(\d+(?:\.\d+){1,3})(?=\s|$)/i.exec(ua)?.[1];
      version = /^\d+(?:\.\d+){1,3}$/.test(given) ? given : fromUA ?? version;
    }
    const platform = context.platform ?? process.platform;
    const variables = { 'session.id': hostSession, 'request.id': context.requestId, 'client.version': version, 'model.id': context.model ?? bodyModel, 'reasoning.effort': payload?.output_config?.effort, timestamp: typeof context.now === 'function' ? context.now() : context.now ?? Date.now(), platform: platform === 'darwin' ? 'Mac OS' : platform === 'win32' ? 'Windows' : 'Linux', arch: (context.arch ?? process.arch) === 'x64' ? 'x86_64' : context.arch ?? process.arch, terminal: platform === 'darwin' ? 'Apple_Terminal/455' : platform === 'win32' ? 'WindowsTerminal' : 'xterm-256color' };
    if (mode && !native && t.identity.userAgent) {
      const value = render(t.identity.userAgent, variables);
      if (value !== undefined) set('user-agent', value, 'identity-user-agent');
    }
    if (complete && canBody && payload) {
      const system = systemBlocks(payload.system, t.body.identityprompt ?? IDENTITY_PROMPT);
      const metadata = isObject(payload.metadata) ? payload.metadata : {};
      const valid = validUserID(metadata.user_id);
      if (system !== undefined || !valid) {
        payload = { ...payload, ...(system === undefined ? {} : { system }) };
        if (system !== undefined) change('body.system', 'claude-compatibility', 'complete');
        if (!valid) {
          const session = sessionMode === 'off' ? '' : hostSession ?? sessionHeader ?? '';
          if (!hostSession && !sessionHeader) change('context.session', 'claude-session-fallback-unknown', 'derive');
          payload.metadata = { ...metadata, user_id: JSON.stringify({ device_id: hash('claude-device', base, scope), account_uuid: uuid(base, scope, 'claude-account'), session_id: uuid(base, scope, session, 'claude-session') }) };
          change('body.metadata.user_id', 'claude-compatibility', 'complete');
        }
        rewritten = true;
      }
    }
    if (active && canBody && payload) {
      try {
        const next = protocol === 'anthropic' && messages ? applyParameters(payload, compileParameters(plan)) : applyGeneric(payload, plan);
        if (JSON.stringify(next) !== JSON.stringify(payload)) { payload = next; rewritten = true; change('body', 'explicit-parameters', 'merge'); }
      } catch { throw error('body.parameters', 'Request parameter transformation is invalid'); }
    }
    if (cacheKey && canBody && payload) {
      const existing = payload.prompt_cache_key;
      if (existing !== undefined && existing !== null && typeof existing !== 'string') throw error('body.prompt_cache_key', 'prompt_cache_key must be a string');
      if (typeof existing !== 'string' || !existing.trim()) {
        if (!cacheSession?.trim()) throw error('body.prompt_cache_key', 'A conversation session is required to generate prompt_cache_key');
        if (!scope.trim()) throw error('body.prompt_cache_key', 'A credential scope is required to generate prompt_cache_key');
        text(cacheSession, 'context.session', 512, false);
        text(scope, 'context.credentialScope', 512, false);
        payload = { ...payload, prompt_cache_key: hash('prompt-cache', base, scope, context.model ?? bodyModel ?? '', cacheSession) };
        rewritten = true;
        change('body.prompt_cache_key', 'session-prompt-cache-key', 'set-if-empty');
      }
    }
    if (messages && mode && !native && ['reference-stable', 'host'].includes(sessionMode) && !headers.get('x-claude-code-session-id')?.trim()) {
      const bodySession = messageSession(payload);
      const session = bodySession || hostSession || sessionHeader || (sessionMode === 'reference-stable' ? uuid(base, scope, '', 'claude-session') : undefined);
      if (session) {
        text(session, 'context.session', 512, false);
        set('x-claude-code-session-id', session, bodySession ? 'claude-identity-session' : hostSession ? 'host-session' : 'stable-session');
      }
    }
    for (const h of t.headers) {
      if (!h.enabled || (h.when === 'native' && !native) || (h.when === 'third-party' && native)) continue;
      if (h.operations && !h.operations.includes(operation)) continue;
      if (h.action === 'preserve') continue;
      if (h.action === 'delete' || h.value === null) { del(h.name, 'template-header'); continue; }
      if (h.action === 'set-if-missing' && headers.has(h.name)) continue;
      if (h.action === 'set-if-empty' && headers.get(h.name)?.trim()) continue;
      const value = render(h.value, variables);
      if (value === undefined) { change(`headers.${h.name}`, 'template-variable-unavailable', 'skip'); continue; }
      set(h.name, value, 'template-header');
    }
    if (protocol === 'responses' && !native && ['reference-stable', 'host'].includes(sessionMode)) {
      const given = (headers.get('session-id') ?? headers.get('session_id') ?? '').trim();
      const conversation = hostSession ?? (headers.get('x-session-id') ?? headers.get('x-opencode-session') ?? '').trim();
      const conversationScope = conversation || bodyModel || context.model || '';
      const session = given || hostSession || (sessionMode === 'reference-stable' ? uuid(base, scope, conversationScope, 'session') : undefined);
      if (session) {
        if (!headers.has('session-id')) set('session-id', session, hostSession ? 'host-session' : 'stable-session');
        if (!headers.has('thread-id')) set('thread-id', session, 'stable-session');
      }
      if (sessionMode === 'reference-stable') {
        if (!headers.has('x-codex-window-id')) set('x-codex-window-id', uuid(base, scope, conversationScope, 'window'), 'stable-identity');
        if (!headers.has('x-codex-installation-id')) set('x-codex-installation-id', uuid(base, scope, 'installation'), 'stable-identity');
        if (!hostSession && !sessionHeader) change('context.session', 'codex-session-fallback-unknown', 'derive');
        if (!scope) change('context.credentialScope', 'credential-scope-fallback-unknown', 'derive');
      }
    }
    if (messages && t.body.fastBeta && payload?.speed === 'fast') {
      const beta = headers.get('anthropic-beta');
      if (!beta?.split(',').some(v => v.trim() === FAST_BETA)) set('anthropic-beta', beta ? `${beta},${FAST_BETA}` : FAST_BETA, 'fast-beta');
    }
    if (rewritten) {
      if (protectedBilling !== undefined && billingSnapshot(payload) !== protectedBilling) throw error('body.parameters', 'Existing billing fields and blocks must remain unchanged');
      resultBody = JSON.stringify(payload);
      if (Buffer.byteLength(resultBody) > t.limits.maxBodyBytes) throw error('body', 'Transformed body exceeds the byte limit');
    }
  }
  // Host-owned invariants run last, after all optional template rules.
  const nominated = (original.get('connection') ?? '').split(',').map(v => v.trim().toLowerCase()).filter(v => TOKEN.test(v));
  for (const name of [...headers.keys()]) if (protectedHeader(name) || nominated.includes(name)) del(name, 'transport-cleanup');
  if (rewritten) for (const name of ['content-encoding', 'digest', 'content-digest', 'repr-digest', 'content-md5']) del(name, 'body-rewritten');
  signalAbort(signal);
  return { input, init: { ...init, ...(signal ? { signal } : {}), ...(rewritten ? { body: resultBody } : {}), headers }, summary };
}
