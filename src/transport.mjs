import { randomUUID } from 'node:crypto';
import { buildHeaders } from './headers.mjs';
import { normalizeProfile } from './profile.mjs';
import { applyParameters, compileParameters } from '../lib/parameters.mjs';
const MAX_INSPECTION_BYTES = 2 * 1024 * 1024;
function objectJson(text) {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
export async function inspectJsonBody(input, init = {}, limit = MAX_INSPECTION_BYTES) {
  const body = init.body;
  if (typeof body === 'string') return Buffer.byteLength(body) <= limit ? objectJson(body) : {};
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return bytes.byteLength <= limit ? objectJson(new TextDecoder().decode(bytes)) : {};
  }
  // Never consume Request streams merely to inspect optional context.
  return {};
}
const scalar = value => typeof value === 'string' && value.trim() ? value : undefined;
export function contextFromRequest({ headers = new Headers(), body = {}, host = {}, clientVersion, uuid = randomUUID, now = Date.now } = {}) {
  const context = {
    'session.id': scalar(host.sessionID) ?? scalar(host.sessionId) ?? scalar(headers.get('x-claude-code-session-id')),
    'request.id': scalar(headers.get('x-client-request-id')) ?? scalar(headers.get('x-request-id')) ?? scalar(host.requestID) ?? uuid(),
    'client.version': scalar(clientVersion),
    'model.id': scalar(host.model?.api?.id) ?? scalar(host.model?.id) ?? scalar(body.model),
    'reasoning.effort': scalar(body.output_config?.effort),
    timestamp: now(),
  };
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}
function assertUpstream(input, baseUrl) {
  let target, base;
  try { target = new URL(input instanceof Request ? input.url : input); base = new URL(baseUrl); }
  catch { throw new Error('请求地址无效，请检查上游配置'); }
  const prefix = base.pathname.replace(/\/+$/, '');
  if (target.origin !== base.origin || target.username || target.password || target.hash ||
    (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))) throw new Error('拒绝发送到未配置的上游地址；修改 Base URL 后请重新加载 Provider');
  return target;
}
async function requestBody(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new TypeError('Messages body must be UTF-8 JSON'); }
  } else if (value instanceof ReadableStream || value instanceof Blob) return requestBody(await new Response(value).arrayBuffer());
  else throw new TypeError('Messages body must contain JSON text or UTF-8 bytes');
  try { return JSON.parse(text); } catch { throw new TypeError('Messages body must contain valid JSON'); }
}
export function createTransport({ getProfile, fetchImpl = globalThis.fetch, getContext = () => ({}), extractHostContext = () => ({}), uuid = randomUUID, now = Date.now } = {}) {
  return async function transport(input, init = {}) {
    const saved = await getProfile();
    if (!saved) throw new Error('请先完成 Claude Code UA 配置，未配置时不会发送请求');
    const profile = normalizeProfile(saved);
    const url = assertUpstream(input, profile.upstream.baseUrl);
    const request = input instanceof Request ? input : undefined;
    const baseHeaders = new Headers(request?.headers);
    new Headers(init.headers ?? {}).forEach((value, name) => baseHeaders.set(name, value));
    const host = { ...(await getContext() ?? {}), ...extractHostContext(baseHeaders) };
    const body = await inspectJsonBody(input, init);
    const context = contextFromRequest({ headers: baseHeaders, body, host, clientVersion: profile.client.version, uuid, now });
    const headers = buildHeaders({ profile, baseHeaders, context, stream: typeof body.stream === 'boolean' ? body.stream : undefined });
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    const sent = { ...init, headers, redirect: 'manual' };
    const plan = compileParameters(profile.parameters);
    const messagesPath = `${new URL(profile.upstream.baseUrl).pathname.replace(/\/+$/, '')}/messages`;
    if (plan.active && method === 'POST' && url.pathname === messagesPath) {
      // Read the incoming encoding before the safety filter removes framing headers.
      const encoding = baseHeaders.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') throw new TypeError('Cannot override a Messages body with content-encoding');
      const content = init.body !== undefined ? init.body : request ? await request.clone().arrayBuffer() : undefined;
      sent.body = JSON.stringify(applyParameters(await requestBody(content), plan));
      for (const name of ['content-length', 'content-md5', 'digest', 'content-encoding']) headers.delete(name);
      headers.set('content-type', 'application/json');
    } else if (baseHeaders.has('content-encoding')) {
      // Raw compressed bodies remain compressed when no edits are requested.
      headers.set('content-encoding', baseHeaders.get('content-encoding'));
    }
    // Preserve input, original body, caller signal, Response, and fetch errors without retries or SSE rewriting.
    return fetchImpl(input, sent);
  };
}
