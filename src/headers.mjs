import { CLIENT_PRESETS, HEADER_LIMIT_BYTES, normalizeProfile, isProtectedHeader, isSafeHeaderText } from './profile.mjs';
export { HEADER_LIMIT_BYTES };
export class HeaderBuildError extends Error {
  constructor(message, field) { super(message); this.name = 'HeaderBuildError'; this.code = 'HEADER_BUILD_ERROR'; if (field !== undefined) this.field = field; }
}
function render(value, context, field) {
  let missing = false;
  const rendered = value.replace(/\{\{([^{}]+)\}\}/g, (_, name) => {
    const [group, key] = name.split('.');
    const item = context[name] ?? context[group]?.[key];
    if ((typeof item !== 'string' || !item.trim()) && !(typeof item === 'number' && Number.isFinite(item)) && typeof item !== 'boolean') { missing = true; return ''; }
    return String(item);
  });
  if (missing) return undefined;
  if (!isSafeHeaderText(rendered) || rendered.length > HEADER_LIMIT_BYTES) throw new HeaderBuildError('请求头值含有非法字符或超过大小限制', field);
  return rendered;
}
export function buildHeaders({ profile, baseHeaders, context = {}, stream } = {}) {
  let p;
  try { p = normalizeProfile(profile, { allowBlank: true }); }
  catch { throw new HeaderBuildError('profile 配置无效'); }
  let headers;
  try { headers = new Headers(baseHeaders ?? undefined); }
  catch { throw new HeaderBuildError('baseHeaders 不是有效的请求头集合'); }
  for (const name of [...headers.keys()]) if (isProtectedHeader(name)) headers.delete(name);
  const callerAccept = headers.get('accept');
  const preset = CLIENT_PRESETS[p.client.preset];
  const version = p.client.version.trim() || preset.version;
  const variables = { ...context, 'client.version': version };
  // All fourteen selected preset values win over caller headers. Explicit settings follow.
  for (const [name, value] of Object.entries(preset.headers)) headers.set(name, value);
  if (preset.userAgent && p.client.version.trim()) headers.set('user-agent', preset.userAgent.replace(`/${preset.version}`, `/${version}`));
  const set = (name, value, field = name) => {
    const text = render(value, variables, field);
    if (text !== undefined && text.trim()) headers.set(name, text);
  };
  if (p.headers.acceptMode === 'json') headers.set('accept', 'application/json');
  else if (p.headers.acceptMode === 'sse') headers.set('accept', 'text/event-stream');
  else if (p.headers.acceptMode === 'auto') headers.set('accept', callerAccept ?? (stream === true ? 'text/event-stream' : 'application/json'));
  else set('accept', p.headers.acceptValue, 'headers.acceptValue');
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  for (const [field, name] of Object.entries({ userAgent: 'user-agent', contentType: 'content-type', anthropicVersion: 'anthropic-version', anthropicBeta: 'anthropic-beta', sessionId: 'x-claude-code-session-id', clientRequestId: 'x-client-request-id' })) {
    if (field === 'clientRequestId' && p.headers[field] === '{{request.id}}' && headers.has(name)) continue;
    if (field === 'sessionId' && p.headers[field] === '{{session.id}}' && headers.has(name)) continue;
    if (p.headers[field]) set(name, p.headers[field], `headers.${field}`);
  }
  for (const [index, item] of p.headers.extra.entries()) {
    if (!item.enabled) continue;
    if (item.value === null) headers.delete(item.name);
    else set(item.name, item.value, `headers.extra[${index}].value`);
  }
  const upstream = p.upstream;
  if (upstream.authorizationMode === 'api-key' && upstream.apiKey.trim()) headers.set('x-api-key', upstream.apiKey);
  else if (upstream.authorizationMode === 'bearer' && upstream.apiKey.trim()) headers.set('authorization', `Bearer ${upstream.apiKey}`);
  else if (upstream.authorizationMode === 'custom' && upstream.authorizationValue.trim()) headers.set('authorization', upstream.authorizationValue);
  let size = 0;
  for (const [name, value] of headers) size += Buffer.byteLength(`${name}: ${value}\r\n`);
  if (size > HEADER_LIMIT_BYTES) throw new HeaderBuildError('请求头总大小超过限制');
  return headers;
}
