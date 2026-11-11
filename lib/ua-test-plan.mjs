import { SDK_BY_PROTOCOL, protocolForModel, apiBase, operationURL } from './ua-protocol.mjs'

const OPERATIONS = {
  anthropic: ['messages', 'count_tokens'],
  responses: ['responses'],
  'chat-completions': ['chat/completions'],
  gemini: ['generateContent', 'streamGenerateContent', 'countTokens'],
}
const BUILTIN_REFS = {
  responses: { id: 'builtin.codex', revision: 1 },
  anthropic: { id: 'builtin.claude-code', revision: 1 },
}
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isCount = operation => operation === 'count_tokens' || operation === 'countTokens'
const label = template => template ? `${template.name || template.id}@${template.revision}` : '普通转发'
const fail = (message, field) => Object.assign(new Error(message), {
  status: 400, code: 'test-plan-invalid', fields: { [field]: message },
})

function checked(field, action) {
  try { return action() } catch (error) {
    if (error?.code === 'test-plan-invalid') throw error
    throw fail(error?.message || '测试计划无效', field)
  }
}

function validateProtocol(protocol) {
  if (!Object.hasOwn(SDK_BY_PROTOCOL, protocol)) throw fail('不支持的上游协议', 'protocol')
}

function validateModel(model) {
  if (typeof model !== 'string' || !model.trim() || CONTROL.test(model)) throw fail('请选择有效的测试模型，模型名不能为空或包含控制字符', 'model')
}

function chooseOperation(protocol, operation, stream) {
  validateProtocol(protocol)
  if (typeof stream !== 'boolean') throw fail('测试 stream 必须是布尔值', 'stream')
  const selected = operation ?? (protocol === 'gemini' && stream ? 'streamGenerateContent' : OPERATIONS[protocol][0])
  if (!OPERATIONS[protocol].includes(selected)) throw fail('操作与上游协议不匹配', 'operation')
  if (isCount(selected) && stream) throw fail('计数操作不支持流式测试', 'stream')
  if (protocol === 'gemini' && !isCount(selected) && (selected === 'streamGenerateContent') !== stream) {
    throw fail('Gemini 操作与测试 stream 不一致', 'stream')
  }
  return selected
}

function validateRef(ref, field) {
  if (!isObject(ref) || typeof ref.id !== 'string' || !ref.id.trim() || CONTROL.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) {
    throw fail('模板引用必须指定有效 id 和精确 revision', field)
  }
}

function validateTemplateShape(template, field) {
  validateRef(template, field)
  if (template.schemaVersion !== 1 || typeof template.name !== 'string' || !template.name.trim() ||
      !['builtin', 'custom'].includes(template.kind) || !Array.isArray(template.headers) || !isObject(template.body) ||
      !Array.isArray(template.protocols) || !template.protocols.length ||
      template.protocols.some(protocol => !Object.hasOwn(OPERATIONS, protocol)) ||
      !Array.isArray(template.operations) || !template.operations.length ||
      template.operations.some(operation => !template.protocols.some(protocol => OPERATIONS[protocol].includes(operation)))) {
    throw fail('模板数据损坏，不能为测试自动回退', field)
  }
  return template
}

function findTemplate(snapshot, ref, field = 'templateRef', allowArchived = true) {
  validateRef(ref, field)
  if (!isObject(snapshot) || !Array.isArray(snapshot.templates)) throw fail('状态快照无效', 'snapshot')
  const matches = snapshot.templates.filter(template => isObject(template) && template.id === ref.id && template.revision === ref.revision)
  if (matches.length !== 1) throw fail(matches.length ? '模板版本重复，状态快照损坏' : '指定的模板 revision 不存在', field)
  const template = validateTemplateShape(matches[0], field)
  if (!allowArchived && template.archived) throw fail('本次自动兼容所需的固定内置模板已归档', field)
  return template
}

function assertCompatible(template, protocol, operation) {
  if (template && (!template.protocols.includes(protocol) || !template.operations.includes(operation))) {
    throw fail('选择的模板不支持当前协议或操作，请明确选择兼容模板', 'template')
  }
}

function autoTemplate(snapshot, binding, protocol) {
  const versions = binding.resolvedVersions
  if (versions !== undefined && !isObject(versions)) throw fail('auto 绑定的固定版本数据损坏', 'binding')
  if (versions && Object.hasOwn(versions, protocol)) return findTemplate(snapshot, versions[protocol], 'binding')
  if (protocol === 'chat-completions' || protocol === 'gemini') return null
  throw fail('auto 绑定缺少当前协议的固定模板版本', 'binding')
}

function effectiveBinding(connection, model) {
  if (connection.modelBindings !== undefined && !isObject(connection.modelBindings)) throw fail('模型模板绑定数据损坏', 'binding')
  const binding = model && connection.modelBindings && Object.hasOwn(connection.modelBindings, model)
    ? connection.modelBindings[model] : connection.binding
  if (!isObject(binding)) throw fail('连接缺少模板绑定', 'binding')
  return binding
}

function compatibleTemplate(snapshot, connection, binding, protocol) {
  // An explicit configured auto reference is still pinned; invalid references never fall back.
  const configured = binding.mode === 'auto' ? binding : connection.binding?.mode === 'auto' ? connection.binding : null
  if (configured) return autoTemplate(snapshot, configured, protocol)
  const ref = BUILTIN_REFS[protocol]
  return ref ? findTemplate(snapshot, ref, 'binding', false) : null
}

function resolveSelection({ snapshot, connection, model, protocol, operation, templateMode, template, templateRef }) {
  if (template === null) return { template: null, resolution: { mode: 'passthrough', message: '本次测试使用普通转发，不修改连接绑定' }, warnings: [] }
  if (template !== undefined || templateRef !== undefined) {
    const selected = template !== undefined ? validateTemplateShape(template, 'template') : findTemplate(snapshot, templateRef)
    assertCompatible(selected, protocol, operation)
    return { template: selected, resolution: { mode: 'explicit', message: `本次测试使用${label(selected)}，不修改连接绑定` }, warnings: [] }
  }
  const binding = effectiveBinding(connection, model)
  let selected
  if (binding.mode === 'passthrough') selected = null
  else if (binding.mode === 'auto') selected = autoTemplate(snapshot, binding, protocol)
  else if (binding.mode === 'template') selected = findTemplate(snapshot, binding, 'binding')
  else throw fail('模板绑定模式无效', 'binding')

  const protocolMatches = selected === null || selected.protocols.includes(protocol)
  const operationMatches = selected === null || selected.operations.includes(operation)
  if (!protocolMatches || !operationMatches) {
    // Counting must not hide a same-protocol template's deliberately unsupported operation.
    if (templateMode !== 'auto' || (protocolMatches && isCount(operation))) assertCompatible(selected, protocol, operation)
    const compatible = compatibleTemplate(snapshot, connection, binding, protocol)
    assertCompatible(compatible, protocol, operation)
    return {
      template: compatible,
      resolution: { mode: 'compatible', message: `本次测试改用${label(compatible)}；连接仍绑定${label(selected)}` },
      warnings: ['仅用于本次测试，不修改连接或模型的模板绑定。'],
    }
  }
  return {
    template: selected,
    resolution: { mode: selected ? 'binding' : 'passthrough', message: selected ? `使用绑定模板${label(selected)}` : '使用绑定的普通转发策略' },
    warnings: [],
  }
}

/** Build an immutable-input, credential-free plan. The caller owns transport and authentication. */
export function createTestPlan({ snapshot, connection, kind = 'infer', protocol, operation, model = '', stream = false, templateMode = 'binding', template, templateRef, apiPath } = {}) {
  if (!['preview', 'check', 'infer'].includes(kind)) throw fail('测试类型无效', 'kind')
  if (!['binding', 'auto'].includes(templateMode)) throw fail('测试模板模式无效', 'templateMode')
  if (typeof stream !== 'boolean') throw fail('测试 stream 必须是布尔值', 'stream')
  if (!isObject(connection)) {
    if (kind !== 'preview' || connection != null) throw fail('请选择测试连接', 'connection')
    validateProtocol(protocol)
    connection = { baseURL: 'https://preview.invalid', protocol, binding: { mode: 'auto', resolvedVersions: BUILTIN_REFS } }
  }
  if (kind === 'check') {
    protocol = checked('protocol', () => protocolForModel(connection, ''))
    model = ''
    operation = 'models'
    stream = false
  } else {
    validateModel(model)
    protocol = protocol ?? checked('protocol', () => protocolForModel(connection, model))
    operation = chooseOperation(protocol, operation, stream)
  }
  validateProtocol(protocol)
  // Never spread the connection: doing so could read/copy a credential getter or secret value.
  const target = { baseURL: connection.baseURL, apiPaths: connection.apiPaths }
  if (apiPath !== undefined) {
    if (typeof apiPath !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(apiPath) || apiPath.includes('//')) {
      throw fail('本次协议根路径必须以 / 开头，且不能包含 URL、重复斜杠、遍历、查询或片段', 'apiPath')
    }
    if (/\/(?:messages(?:\/count_tokens)?|responses|chat\/completions)$/.test(apiPath)) throw fail('请填写协议根路径，不要填写完整的模型操作路径', 'apiPath')
    target.apiPaths = { [protocol]: apiPath }
  }
  const url = checked('connection.baseURL', () => kind === 'check' ? `${apiBase(target, protocol)}/models` : operationURL(target, protocol, operation, model))
  const selection = kind === 'check'
    ? { template: null, resolution: { mode: 'passthrough', message: '连接检查仅查询模型列表，不应用模板' }, warnings: [] }
    : resolveSelection({ snapshot, connection, model, protocol, operation, templateMode, template, templateRef })
  const selected = selection.template === null ? null : checked('template', () => structuredClone(selection.template))
  if (selected) delete selected.archived
  return {
    kind,
    connectionId: connection.id ?? null,
    connectionName: connection.name ?? '',
    model, protocol, operation, stream,
    method: kind === 'check' ? 'GET' : 'POST',
    url,
    template: selected,
    templateId: selected?.id ?? null,
    revision: selected?.revision ?? null,
    templateMode,
    resolution: selection.resolution,
    warnings: selection.warnings,
  }
}

/** Generate a fresh sample for the exact protocol/model/stream/operation selection. */
export function createTestSample(protocol, model, stream = false, operation) {
  validateModel(model)
  operation = chooseOperation(protocol, operation, stream)
  const text = 'Reply with OK.'
  if (protocol === 'gemini') {
    const contents = [{ role: 'user', parts: [{ text }] }]
    return operation === 'countTokens' ? { contents } : { contents, generationConfig: { maxOutputTokens: 128 } }
  }
  const messages = [{ role: 'user', content: text }]
  if (protocol === 'anthropic' && operation === 'count_tokens') return { model, messages }
  if (protocol === 'responses') return {
    model, input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
    max_output_tokens: 128, store: false, prompt_cache_key: 'ua-pro-test-session', stream,
  }
  return { model, max_tokens: 128, messages, stream }
}

/** Return the original body after structural checks; never rewrite caller business fields. */
export function validateTestSample(body, plan) {
  if (!isObject(body)) throw fail('测试请求正文必须是 JSON 对象，不能是数组', 'request.body')
  if (!isObject(plan)) throw fail('测试计划无效', 'plan')
  validateProtocol(plan.protocol)
  if (typeof body.model === 'string' && body.model !== plan.model) {
    throw fail('请求正文模型与测试计划模型不一致，请重新生成样例或修改正文', 'request.body.model')
  }
  if (Object.hasOwn(body, 'stream')) {
    if (typeof body.stream !== 'boolean') throw fail('请求正文 stream 必须是布尔值', 'request.body.stream')
    if (body.stream !== plan.stream) throw fail('请求正文 stream 与测试计划不一致，请重新生成样例或修改正文', 'request.body.stream')
  }
  if (plan.operation === 'models') return body
  if (['anthropic', 'chat-completions'].includes(plan.protocol) && !Array.isArray(body.messages)) {
    throw fail('当前协议的测试正文需要 messages 数组', 'request.body.messages')
  }
  if (plan.protocol === 'responses' && typeof body.input !== 'string' && !Array.isArray(body.input)) {
    throw fail('Responses 测试正文需要字符串或数组 input', 'request.body.input')
  }
  if (plan.protocol === 'gemini' && !Array.isArray(body.contents)) throw fail('Gemini 测试正文需要 contents 数组', 'request.body.contents')
  return body
}
