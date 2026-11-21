import { createHash, randomUUID } from 'node:crypto'
import { normalizeBaseURL, resolveTemplate } from './ua-store.mjs'
import { DEFAULT_AUTO_RESOLVED, SDK_BY_PROTOCOL } from '../lib/ua-protocol.mjs'

const PROTOCOL_LABELS = { anthropic: 'Anthropic Messages', responses: 'OpenAI Responses', 'chat-completions': 'OpenAI Chat Completions', gemini: 'Gemini' }
const fail = message => Object.assign(new Error(message), { status: 400 })
const owns = (object, key) => Object.hasOwn(object, key)
const object = value => value && typeof value === 'object' && !Array.isArray(value)

function validateKey(value) {
  return typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\r\n\u0000]/.test(value) ? '请填写有效的上游模型 API key' : undefined
}

function templateAt(snapshot, value, { allowArchived = false } = {}) {
  const match = typeof value === 'string' && /^template:((?:builtin|custom)\.[A-Za-z0-9][A-Za-z0-9._-]*)@([1-9][0-9]*)$/.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw fail('请选择有效的已保存模板版本')
  const matches = snapshot.templates.filter(item => item.id === match[1] && item.revision === Number(match[2]))
  if (matches.length !== 1) throw fail('所选模板版本不存在，请重新选择；不会自动替换模板')
  const template = matches[0]
  if (template.archived && !allowArchived) throw fail('所选模板已归档，请重新选择可用版本')
  return template
}

/** Native choices always pin one exact saved revision; names are display-only. */
export function nativeTemplateChoice(snapshot, value, protocol, options) {
  if (value === 'auto' || value === 'passthrough') {
    if (protocol !== undefined && protocol !== 'auto' && !owns(SDK_BY_PROTOCOL, protocol)) throw fail('上游协议无效')
    const binding = value === 'auto' ? { mode: 'auto', resolvedVersions: structuredClone(DEFAULT_AUTO_RESOLVED) } : { mode: 'passthrough' }
    if (value === 'auto') for (const name of Object.keys(binding.resolvedVersions)) resolveTemplate(snapshot, { binding }, name)
    return { binding, protocol: protocol ?? 'auto' }
  }
  const template = templateAt(snapshot, value, options)
  const selectedProtocol = protocol ?? (template.protocols.length === 1 ? template.protocols[0] : undefined)
  if (!template.protocols.includes(selectedProtocol)) throw fail('请为所选模板选择兼容的上游协议')
  return { binding: { mode: 'template', id: template.id, revision: template.revision }, protocol: selectedProtocol }
}

/** A consumed login choice must not undo later explicit WebUI applications. */
export function nativeTemplateSelectionId(metadata = {}) {
  if (!owns(metadata, 'uaTemplate')) return null
  const token = metadata.uaTemplateSelectionId
  if (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(token))) throw fail('原生模板选择标识无效，请重新登录')
  return createHash('sha256').update(JSON.stringify([token ?? 'legacy', metadata.uaTemplate, metadata.protocol ?? 'auto'])).digest('hex')
}

function templatePrompt(snapshot) {
  return { type: 'select', key: 'uaTemplate', message: '选择已保存的 WebUA 模板版本', options: [
    { label: '自动匹配协议（固定内置版本）', value: 'auto', hint: 'Responses: Codex @1；Messages: Claude Code @2；Chat/Gemini 透传' },
    { label: '透传（不应用 WebUA 模板）', value: 'passthrough', hint: '保留请求头和正文，仅应用当前账号地址与认证' },
    ...snapshot.templates.filter(item => !item.archived).map(item => ({
      label: `${item.name} @${item.revision} · ${item.id}`, value: `template:${item.id}@${item.revision}`,
      hint: item.protocols.map(protocol => PROTOCOL_LABELS[protocol]).join(' / '),
    })),
  ] }
}

/** This method is enabled only for Magpie's native GUI/CLI ask/keyless contract. */
export async function createNativeAuthMethod({ store, uuid = randomUUID }) {
  const address = { type: 'text', key: 'baseURL', message: '上游 Base URL', placeholder: 'https://your-service.example', validate(value) {
    try { normalizeBaseURL(value); return undefined } catch { return '请填写有效的 HTTPS Base URL（本机可用 HTTP），不要填写具体请求路径' }
  } }
  const key = { type: 'password', key: 'upstreamKey', message: '此上游的模型 API key', placeholder: '此上游的模型 API key', validate: validateKey }
  const protocols = { type: 'select', key: 'uaProtocol', message: '此模板的上游请求协议', options: Object.entries(PROTOCOL_LABELS).map(([value, label]) => ({ value, label })) }
  const initial = templatePrompt(await store.snapshot())
  return {
    type: 'api', label: '连接上游 API key', placeholder: key.placeholder, keyless: true,
    prompts: [address, key, initial, { ...protocols, condition: inputs => inputs.uaTemplate?.startsWith('template:') }],
    async ask(inputs = {}) {
      if (!object(inputs)) throw fail('原生连接输入无效，请重新打开登录')
      if (!owns(inputs, 'baseURL')) return { ...address, validate: undefined }
      if (address.validate(inputs.baseURL)) throw fail(address.validate(inputs.baseURL))
      if (!owns(inputs, 'upstreamKey')) return { ...key, validate: undefined }
      if (validateKey(inputs.upstreamKey)) throw fail(validateKey(inputs.upstreamKey))
      const snapshot = await store.snapshot()
      if (!owns(inputs, 'uaTemplate')) return templatePrompt(snapshot)
      if (inputs.uaTemplate !== 'auto' && inputs.uaTemplate !== 'passthrough') {
        const template = templateAt(snapshot, inputs.uaTemplate)
        if (template.protocols.length > 1 && !owns(inputs, 'uaProtocol')) return { ...protocols, options: protocols.options.filter(item => template.protocols.includes(item.value)) }
      }
      nativeTemplateChoice(snapshot, inputs.uaTemplate, inputs.uaProtocol)
      return null
    },
    async authorize(inputs = {}) {
      try {
        if (!object(inputs)) throw fail('原生连接输入无效，请重新打开登录')
        const baseURL = normalizeBaseURL(inputs.baseURL)
        // host.js merges inputs into metadata before this result. Explicit
        // undefined values are removed by JSON serialization, including the key.
        const metadata = Object.fromEntries(Object.keys(inputs).map(name => [name, undefined]))
        metadata.baseURL = baseURL
        const interactive = owns(inputs, 'upstreamKey')
        if (interactive && validateKey(inputs.upstreamKey)) throw fail(validateKey(inputs.upstreamKey))
        if (!owns(inputs, 'uaTemplate') && !interactive) return { type: 'success', metadata }
        const choice = nativeTemplateChoice(await store.snapshot(), inputs.uaTemplate, inputs.uaProtocol)
        Object.assign(metadata, { uaTemplate: inputs.uaTemplate, protocol: choice.protocol, uaTemplateSelectionId: uuid() })
        return { type: 'success', ...(interactive ? { key: inputs.upstreamKey } : {}), metadata }
      } catch (error) {
        return { type: 'failed', error: error.status === 400 ? error.message : '无法读取已保存模板，请重新打开登录' }
      }
    },
  }
}
