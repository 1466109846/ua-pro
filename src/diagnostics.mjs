import { createModelDiscovery, ModelDiscoveryError } from './connection.mjs';
import { normalizeProfile, ProfileValidationError } from './profile.mjs';
const outcomes = new Map([
  ['unauthorized', { title: '模型列表请求未获授权', message: '请核对 API 凭据后重新检查。', nextAction: 'edit-credentials' }],
  ['forbidden', { title: '模型列表访问被拒绝', message: '服务拒绝了模型列表请求，请核对账户访问权限或联系服务方确认访问限制。', nextAction: 'edit-credentials' }],
  ['unsupported-list', { title: '模型列表接口不可用', message: '服务未提供可用的模型列表接口。可手动填写模型 ID；生成能力尚未测试。', nextAction: 'enter-models' }],
  ['empty-model-list', { title: '未获得可用的模型 ID', message: '模型列表未包含可用的模型 ID。可手动填写模型 ID；生成能力尚未测试。', nextAction: 'enter-models' }],
  ['rate-limited', { title: '模型列表请求受到限流', message: '请稍后重新检查。', nextAction: 'retry' }],
  ['redirect', { title: '模型列表请求发生重定向', message: '检查未接受重定向，请核对并填写服务的直接地址。', nextAction: 'edit-address' }],
  ['upstream-error', { title: '上游服务暂时异常', message: '服务未能完成模型列表请求，请稍后重试。', nextAction: 'retry' }],
  ['invalid-response', { title: '模型列表响应无效', message: '模型列表响应无法识别或超过大小限制，请核对服务地址。', nextAction: 'edit-address' }],
  ['timeout', { title: '模型列表检查超时', message: '未能在限定时间内完整获取模型列表，请稍后重试。', nextAction: 'retry' }],
  ['network', { title: '模型列表网络请求失败', message: '未能完整获取模型列表，请检查网络连接后重试。', nextAction: 'retry' }],
  ['http-error', { title: '模型列表请求失败', message: '服务未接受模型列表请求，请确认服务状态后重试。', nextAction: 'retry' }],
]);
/** Checks only GET /models; never sends generation requests. */
export function createConnectionDiagnostics({ fetchImpl = globalThis.fetch, timeoutMs = 15000, now = Date.now } = {}) {
  const discover = createModelDiscovery({ fetchImpl, timeoutMs, now });
  return async function check(raw) {
    const profile = normalizeProfile(raw);
    const credentials = [profile.upstream.apiKey, profile.upstream.authorizationValue].flatMap(value => [value, value.replace(/^\S+\s+/, '')]).filter(Boolean);
    try {
      const models = await discover(profile, { force: true, ignoreConfigured: true, requireStatus200: true });
      const modelIds = Object.keys(models);
      if (modelIds.some(id => credentials.some(secret => id.includes(secret)))) throw new ModelDiscoveryError('invalid-response', 200);
      return { state: 'models-found', code: 'models-found', title: '已获取模型列表', message: '已获取模型列表；尚未测试生成或回复能力。', nextAction: 'save', modelIds,
        checkedAt: new Date(now()).toISOString(), checks: { modelList: 'passed', generation: 'not-tested' }, httpStatus: 200 };
    } catch (error) {
      if (error instanceof ProfileValidationError) throw error;
      const failure = error instanceof ModelDiscoveryError ? error : undefined;
      const code = ['invalid-json', 'invalid-shape', 'too-large'].includes(failure?.code) ? 'invalid-response' : outcomes.has(failure?.code) ? failure.code : 'network';
      const unavailable = code === 'unsupported-list' || code === 'empty-model-list';
      return { state: unavailable ? 'models-unavailable' : 'failed', code, ...outcomes.get(code), modelIds: [], checkedAt: new Date(now()).toISOString(),
        checks: { modelList: unavailable ? 'unavailable' : 'failed', generation: 'not-tested' }, ...(failure?.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }) };
    }
  };
}
