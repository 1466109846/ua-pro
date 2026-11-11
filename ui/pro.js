import { createTestPlan, createTestSample, validateTestSample } from '../lib/ua-test-plan.mjs'
import { protocolForModel, matchesAccountSite } from '../lib/ua-protocol.mjs'

export const PROTOCOLS = ['anthropic', 'responses', 'chat-completions', 'gemini']
export const OPERATIONS = { anthropic: ['messages', 'count_tokens'], responses: ['responses'], 'chat-completions': ['chat/completions'], gemini: ['generateContent', 'streamGenerateContent', 'countTokens'] }
const clone = value => JSON.parse(JSON.stringify(value))
const keyOf = template => `${template.id}@${template.revision}`
export function templateGroups(templates = []) {
  const groups = new Map()
  for (const item of templates) {
    if (!groups.has(item.id)) groups.set(item.id, [])
    groups.get(item.id).push(item)
  }
  return [...groups.values()].map(items => items.sort((a, b) => b.revision - a.revision))
}
export function forkTemplate(base, name) {
  const draft = clone(base)
  draft.basedOn = { id: base.id, revision: base.revision }
  delete draft.id
  delete draft.archived
  draft.kind = 'custom'
  draft.revision = 1
  draft.name = name.trim()
  return draft
}
export function jsonObject(text, label) {
  let value
  try { value = JSON.parse(text || '{}') } catch { throw new Error(`${label} 必须是有效 JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`)
  return value
}
export function lines(text) { return [...new Set(String(text).split(/\r?\n/).map(value => value.trim()).filter(Boolean))] }
export const ACCOUNT_BINDING_EMPTY = '不绑定签到账号（仅查询 Key 用量）'
/** Same-site comparison for the optional balance/check-in account binding. */
export function siteRoot(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  if (!text) return ''
  return text.replace(/\/v1(?:beta)?$/i, '').replace(/\/+$/, '')
}
export function connectionAccountChoices(accounts = [], baseURL = '', selectedId = '') {
  const list = (Array.isArray(accounts) ? accounts : []).filter(item => item && item.id)
  const root = siteRoot(baseURL)
  const matches = item => { try { return matchesAccountSite(baseURL, item) } catch { return false } }
  const same = root ? list.filter(matches) : []
  const pool = same.length ? same : list
  const selected = selectedId === null || selectedId === undefined ? '' : String(selectedId)
  const selectedAccount = list.find(item => String(item.id) === selected)
  const choices = pool.map(item => ({
    value: String(item.id),
    label: `${item.name ?? item.id} · ${item.siteUrl ?? ''}${item.enabled === false ? '（已停用）' : ''}`,
  }))
  const invalid = Boolean(selected && (!selectedAccount || (root !== '' && !matches(selectedAccount))))
  if (invalid) {
    const label = selectedAccount
      ? `当前绑定：${selectedAccount.name} · ${selectedAccount.siteUrl}（属于其他站点或已失效，请重新选择）`
      : '当前绑定（已失效或属于其他站点，请重新选择）'
    const existing = choices.findIndex(item => item.value === selected)
    if (existing >= 0) choices.splice(existing, 1)
    choices.unshift({ value: selected, label, invalid: true })
  }
  return { mode: same.length ? 'same-site' : 'all', choices, selected, invalid }
}
export function connectionAccountBindingLabel(accountId, accounts = []) {
  if (!accountId) return '余额与签到：仅查询 Key 用量（未绑定站点账号）'
  const account = (Array.isArray(accounts) ? accounts : []).find(item => String(item.id) === String(accountId))
  return account ? `余额与签到：${account.name} · ${account.siteUrl}` : '余额与签到：绑定账号已失效，请编辑连接重新选择'
}
export function fillSelectedModels(current, selected, replace = false) {
  const ids = selected.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
  return [...new Set([...(replace ? [] : lines(current)), ...ids])].join('\n')
}
const CATALOG_SOURCES = { 'host-cache': '宿主已发现的模型', 'management-cache': '上次获取的模型' }
const pad2 = value => String(value).padStart(2, '0')
function catalogTime(value) {
  const raw = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  const date = typeof raw === 'number' ? new Date(raw < 1e11 ? raw * 1000 : raw) : new Date(raw ?? Number.NaN)
  if (raw === null || raw === undefined || raw === '' || Number.isNaN(date.getTime())) return '时间未知'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}
function catalogReason(error) {
  const value = String(error?.message || error?.code || '').replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***').replace(/\bsk-[\w-]{6,}/g, 'sk-***').replace(/\s+/g, ' ').trim()
  if (!value) return '上游暂不可用'
  return value.length > 200 ? `${value.slice(0, 200)}…` : value
}
export function catalogModels(result) {
  return Array.isArray(result?.models) ? [...new Set(result.models.map(model => typeof model?.id === 'string' ? model.id.trim() : '').filter(Boolean))] : []
}
export function catalogFor(state, id) {
  const catalogs = state?.modelCatalogs
  if (!id || !catalogs || typeof catalogs !== 'object' || !Object.hasOwn(catalogs, id)) return null
  const entry = catalogs[id]
  return entry && typeof entry === 'object' && Array.isArray(entry.models) ? { ...entry, cached: true, refreshError: undefined } : null
}
export function modelCatalogStatus(result) {
  const count = catalogModels(result).length
  if (!result?.cached && !result?.refreshError) return (count ? `已获取 ${count} 个模型。选择后追加或替换，下方手填内容尚未改变。` : '上游返回空模型列表，手填内容已保留。') + (result?.catalogWarning ? ` ${result.catalogWarning}` : '')
  const kept = `${CATALOG_SOURCES[result.source] ?? '缓存的模型'} · ${catalogTime(result.checkedAt)}，${count ? `共 ${count} 个` : '缓存为空'}；这是缓存，不代表本次刷新成功`
  if (result.refreshError) return `刷新失败：${catalogReason(result.refreshError)}。保留的缓存：${kept}，手填内容保留。`
  return `${kept}。点击“获取模型”会重新查询；${count ? '选择后追加或替换，手填内容尚未改变。' : '手填内容保留。'}`
}
export function modelProtocolLines(text) {
  const result = {}
  for (const line of lines(text)) {
    const match = /^([^=]+?)\s*=\s*(.+)$/.exec(line)
    if (!match || !PROTOCOLS.includes(match[2].trim())) throw new Error('模型协议格式应为：模型 = 协议')
    const name = match[1].trim()
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('模型名称无效')
    result[name] = match[2].trim()
  }
  return result
}
export function differences(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => differences(before[key], after[key], path ? `${path}.${key}` : key))
  }
  return [{ path: path || 'template', action: before === undefined ? '新增' : after === undefined ? '删除' : '修改' }]
}
export function safeTemplate(template) {
  const safe = clone(template)
  safe.headers = safe.headers.map(header => /token|secret|key|cookie|auth/i.test(header.name) ? { ...header, value: '[已遮罩]' } : header)
  return safe
}
export function testModelOptions(connection, catalog) {
  const entries = new Map()
  const safe = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value)
  for (const id of connection?.models ?? []) if (safe(id)) entries.set(id.trim(), { id: id.trim(), name: id.trim() })
  for (const model of catalog?.models ?? []) {
    if (!safe(model?.id)) continue
    const id = model.id.trim()
    entries.set(id, { id, name: safe(model.name) ? model.name.trim() : id })
  }
  return [...entries.values()]
}
export function selectTestModel(models, current = '') {
  return models.some(model => model.id === current) ? current : models[0]?.id ?? ''
}
export function gatewayModelReference(connection, model) {
  const provider = connection?.independent && connection.siteId ? `ua-pro-${connection.siteId}` : 'ua-pro'
  return model ? `${provider}/${model}` : ''
}
export function testModelProtocol(connection, model, fallback = 'anthropic') {
  if (!connection) return fallback
  try { return protocolForModel(connection, model) } catch { return fallback }
}
export function sampleBody(protocol, model, stream) {
  return createTestSample(protocol, model, stream)
}
export function operationErrorText(result) {
  return [...new Set([result.error, ...Object.values(result.fields ?? {})].filter(value => typeof value === 'string' && value.trim()))].join('\n') || '操作未完成'
}
export function testRequestIdentity(payload) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
  return JSON.stringify(stable(payload))
}
export async function requestOperation(fetcher, action, payload, operationId) {
  try {
    const response = await fetcher(`./api/pro/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, operationId }) })
    const data = await response.json()
    if (response.ok) return { ok: true, data }
    if (data.code === 'save-pending') return { ok: false, unknown: true, error: data.error }
    return { ok: false, unknown: false, error: data.error || '操作未完成', fields: data.fields }
  } catch { return { ok: false, unknown: true, error: '未收到操作确认，结果未知。请查询原操作，不要重复提交。' } }
}

if (typeof document !== 'undefined') void mount()
async function mount() {
  const $ = id => document.getElementById(id)
  let state = { templates: [], connections: [], siteAccounts: [], generation: 0, runtime: {} }
  let view = 'overview', loading = false, pending = null, operation = null
  let connection = null, connectionBaseline = '', template = null, templateBaseline = '', templateOrigin = null
  let migration = null, dirtyConnection = false, dirtyTemplate = false
  let modelQuery = null, modelQueryReady = false, modelResultShown = false
  let testModelQuery = null, testModels = [], testCatalog = null, testConnectionID = '', testConnectionRevision, testModelManual = false, testSampleBaseline = '', testProtocolExplicit = false
  let testSelectionInitialized = false
  const queriedTestConnections = new Set()
  let testPlan = null, testPlanError = '', lastTestIdentity = '', testResultRunning = false, dirtyTestSample = false, testHeadersBaseline = '{}'
  const text = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = String(value) }
  const node = (tag, content, className) => { const item = document.createElement(tag); if (content !== undefined) item.textContent = content; if (className) item.className = className; return item }
  const button = (label, action, className = 'ghost') => { const item = node('button', label, className); item.type = 'button'; item.addEventListener('click', action); return item }
  const tag = value => node('span', value, 'tag')
  const status = value => text('pro-status', value)
  const showError = error => { $('pro-error').hidden = !error; $('pro-error').textContent = error ? String(error.message ?? error) : '' }
  function isDirty() { return dirtyTemplate || dirtyConnection || dirtyTestSample }
  function locked() { return loading || Boolean(pending) || Boolean(modelQuery) }
  function allowLeave() {
    if (locked()) { showError('操作进行中或结果未知，请先确认结果。'); return false }
    return !isDirty() || window.confirm('有未保存的草稿。确定放弃并继续吗？')
  }
  function options(select, values, selected = select.value) {
    select.replaceChildren()
    for (const [value, label] of values) { const item = node('option', label); item.value = value; select.append(item) }
    if (values.some(([value]) => value === selected)) select.value = selected
  }
  function setBusy(value) {
    loading = value
    for (const element of document.querySelectorAll('button,input,select,textarea')) {
      if (element.id === 'pro-recover' || element.id === 'test-cancel') continue
      if (value) { element.dataset.preDisabled = element.disabled ? '1' : '0'; element.disabled = true }
      else if (element.dataset.preDisabled !== undefined) { element.disabled = element.dataset.preDisabled === '1'; delete element.dataset.preDisabled }
    }
    $('test-cancel').hidden = !(value && operation?.action === 'test')
    if(!value){$('test-cancel').disabled=false;text('test-cancel','取消测试')}
    $('pro-pending').hidden = !pending
  }
  async function refresh(keepDraft = true) {
    const response = await fetch('./api/pro/state', { cache: 'no-store' })
    if (!response.ok) throw new Error('配置会话不可用，请重新打开 UA PRO')
    state = await response.json()
    renderState()
    if (!keepDraft) { dirtyConnection = false; dirtyTemplate = false; dirtyTestSample = false }
  }
  async function run(action, payload, complete) {
    if (locked()) return
    showError(null)
    operation = { action, payload, id: crypto.randomUUID(), complete }
    setBusy(true)
    status(action === 'test' ? '正在执行测试…' : '正在保存操作…')
    const result = await requestOperation(fetch.bind(globalThis), action, payload, operation.id)
    setBusy(false)
    if (result.unknown) {
      pending = operation
      setBusy(true)
      loading = false
      $('pro-pending').hidden = false
      text('pro-pending-text', `${result.error} 操作标识：${operation.id}`)
      status('结果未知，等待查询')
      return
    }
    operation = null
    if (!result.ok) { showError(operationErrorText(result)); status('操作未完成，草稿保留'); return }
    await refresh()
    if (complete) await complete(result.data)
    status(action === 'test' ? result.data.result?.status === 'passed' ? '测试完成：通过' : '测试完成：未通过，请查看本次原因' : action === 'routes/apply' ? '模型路由已保存，请在 Magpie 重新获取模型或重载插件' : result.data.activation ? '已保存绑定；等待宿主后续请求确认使用版本' : '操作完成')
  }
  async function recover() {
    if (!pending || loading) return
    try {
      const response = await fetch(`./api/pro/operations?id=${encodeURIComponent(pending.id)}`, { cache: 'no-store' })
      const result = await response.json()
      if (result.state === 'saved') {
        const done = pending.complete; pending = null; setBusy(false); $('pro-pending').hidden = true
        await refresh(); if (done) await done(result.result); status('已确认原操作完成')
      } else if (result.state === 'failed') { pending = null; setBusy(false); $('pro-pending').hidden = true; showError(result.error?.error || '原操作已确认失败，可修正后重试') }
      else text('pro-pending-text', '尚不能确认操作结果；请保留草稿并稍后查询，不重复提交。')
    } catch { showError('暂时无法查询结果，请稍后重试') }
  }
  function navigate(next, force = false) {
    if (!['overview', 'connections', 'templates', 'tests', 'settings'].includes(next)) next = 'overview'
    if (!force && next !== view && !allowLeave()) return
    if (next !== view && !force) { dirtyConnection = false; dirtyTemplate = false; dirtyTestSample = false }
    if (next === 'templates' && !force) { $('template-library').hidden = false; $('template-editor').hidden = true }
    if (next !== 'tests') cancelTestModelQuery()
    view = next
    for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== next
    for (const link of document.querySelectorAll('[data-view-link]')) { if (link.dataset.viewLink === next) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current') }
    text('pro-title', { overview: '概览', connections: '连接与模型', templates: '模板库', tests: '测试', settings: '设置' }[next])
    history.replaceState(null, '', `#${next}`)
    if (next === 'tests') syncTestConnection({ autoFetch: true })
  }
  function bindingLabel(binding) {
    if (binding?.mode === 'template') return `${binding.id} @ ${binding.revision}`
    return binding?.mode === 'auto' ? '自动：固定 Codex / Claude 版本' : '普通转发'
  }
  function renderState() {
    text('pro-generation', state.generation)
    text('pro-runtime', state.runtime?.mode === 'host' ? 'Magpie 插件宿主' : '独立配置工具')
    $('overview-metrics').replaceChildren(...[
      [state.connections.filter(item => item.enabled).length, '启用连接'],
      [templateGroups(state.templates).filter(items => items[0].kind === 'custom').length, '自定义模板'],
      [state.runtime?.observed?.length ?? 0, '宿主已观察连接'],
    ].map(([count, label]) => { const item = node('div', undefined, 'metric'); item.append(node('span', label), node('strong', count)); return item }))
    $('overview-empty').hidden = state.connections.length > 0
    $('overview-connections').replaceChildren(...state.connections.map(item => { const row = node('div', undefined, 'overview-item'); const info = node('div'); info.append(node('strong', item.name), node('small', item.baseURL), node('small', bindingLabel(item.binding))); const seen = state.runtime?.observed?.find(entry => entry.connectionId === item.id); row.append(info, tag(seen ? `观察 generation ${seen.generation} · ${seen.templateId ?? '普通转发'} @ ${seen.revision ?? '—'}` : '等待宿主观察')); return row }))
    $('connection-list').replaceChildren(...state.connections.map(item => { const card = node('article', undefined, 'conn-card'); card.append(node('h3', item.name), tag(item.enabled ? '启用' : '停用'), node('p', `${item.baseURL}\n${item.protocol} · ${item.auth.source === 'host' ? '宿主凭据' : '本地连接凭据'}`), node('p', bindingLabel(item.binding)), node('p', connectionAccountBindingLabel(item.newApiAccountId, state.siteAccounts), 'hint'), (() => { const link = node('a', '管理签到账号 / 补 Cookie 或登录凭据'); link.href = './accounts'; link.addEventListener('click', event => { if (!allowLeave()) event.preventDefault() }); return link })()); const actions = node('div', undefined, 'card-actions'); actions.append(button('编辑', () => editConnection(item)), button('应用模板', () => openBinding([item.id])), button('测试', () => openTest(item.id))); card.append(actions); return card }))
    renderTemplates()
    renderConnectionSelectors()
    $('session-info').replaceChildren(...Object.entries(state.session ?? {}).map(([key, value]) => { const item = node('div'); item.append(node('dt', key), node('dd', value)); return item }))
  }
  function renderTemplates() {
    const archived = $('template-show-archived').checked
    $('template-list').replaceChildren(...templateGroups(state.templates).filter(items => archived || !items[0].archived).map(items => {
      const latest = items[0], card = node('article', undefined, 'tpl-card')
      card.append(node('h3', latest.name), tag(latest.kind === 'builtin' ? '内置基线 · 只读' : latest.archived ? '已归档' : '我的模板'), tag(`v${latest.revision}`), node('p', latest.protocols.join(' / ')))
      const uses = state.connections.filter(item => item.binding.id === latest.id || Object.values(item.modelBindings).some(binding => binding.id === latest.id)).length
      card.append(node('p', `${items.length} 个版本 · ${uses} 个连接引用`))
      const actions = node('div', undefined, 'card-actions')
      actions.append(button(latest.kind === 'builtin' ? '查看规则' : '编辑新版本', () => editTemplate(latest)), button('复制', () => beginFork(latest)), button('历史', () => showHistory(latest.id)))
      if (latest.kind !== 'builtin') actions.append(button(latest.archived ? '恢复' : '归档', () => run('templates/archive', { id: latest.id, archived: !latest.archived })))
      card.append(actions); return card
    }))
  }
  function renderConnectionSelectors() {
    const enabled = state.connections.filter(item => item.enabled)
    const selected = testSelectionInitialized ? $('test-connection').value : enabled[0]?.id ?? ''
    if (enabled.length) testSelectionInitialized = true
    options($('test-connection'), [['', '不选择连接（仅本地预览）'], ...enabled.map(item => [item.id, item.name])], enabled.some(item => item.id === selected) ? selected : '')
    const groups = templateGroups(state.templates).filter(items => !items[0].archived)
    const entries = groups.map(items => [items[0].id, items[0].name])
    options($('binding-template'), entries)
    options($('test-template'), entries)
    options($('conn-binding'), [['auto', '自动：按协议选择'], ['passthrough', '普通转发'], ...groups.map(items => [keyOf(items[0]), `${items[0].name} @ ${items[0].revision}`])])
    renderRevisions('binding'); renderRevisions('test')
    syncTestConnection({ autoFetch: view === 'tests' })
  }
  function renderRevisions(prefix, revision) {
    const id = $(`${prefix}-template`).value
    options($(`${prefix}-revision`), state.templates.filter(item => item.id === id).sort((a, b) => b.revision - a.revision).map(item => [String(item.revision), `版本 ${item.revision}`]), revision === undefined ? undefined : String(revision))
  }
  function connectionDraft() {
    const auth = { ...(connection?.auth ?? { source: 'stored' }), mode: $('conn-auth-mode').value, key: $('conn-key').value, value: $('conn-value').value }
    const result = { ...(connection ? clone(connection) : {}), name: $('conn-name').value.trim(), baseURL: $('conn-base').value.trim(), protocol: $('conn-protocol').value,
      auth, models: lines($('conn-models').value), modelProtocols: modelProtocolLines($('conn-model-protocols').value), apiPaths: {}, enabled: $('conn-enabled').checked, independent: $('conn-independent').checked, siteId: $('conn-site').value.trim(), newApiAccountId: $('conn-site-account').value }
    delete result.secrets
    for (const control of document.querySelectorAll('[data-api-path]')) if (control.value.trim()) result.apiPaths[control.dataset.apiPath] = control.value.trim()
    if (!connection) {
      const binding = $('conn-binding').value
      result.binding = binding === 'auto' || binding === 'passthrough' ? { mode: binding } : { mode: 'template', id: binding.split('@')[0], revision: Number(binding.split('@')[1]) }
    }
    return result
  }
  function updateAuthFields() {
    const mode = $('conn-auth-mode').value, host = connection?.auth.source === 'host'
    $('conn-key-field').hidden = host || !['api-key', 'bearer'].includes(mode)
    $('conn-value-field').hidden = host || mode !== 'custom'
    $('conn-host-note').hidden = !host
    $('conn-auth-mode').disabled = Boolean(host)
    text('conn-secret-state', host ? '凭据由 Magpie 保存，不会复制到模板。' : connection?.secrets?.key || connection?.secrets?.value ? '已有凭据；同一目标留空保留。换站需输入新凭据。' : '输入此连接自己的模型凭据。')
    $('conn-clear-field').hidden = !connection || host
  }
  function resetModelQuery(message = '使用上方地址、认证方式和密钥读取模型，无需先保存；不会发送生成请求。') {
    const previous = modelQuery
    modelQuery = null
    previous?.controller.abort()
    modelQueryReady = false
    modelResultShown = false
    $('conn-model-result').hidden = true
    $('conn-model-options').replaceChildren()
    text('conn-model-options-label', '获取到的模型（可多选）')
    $('conn-model-cancel').hidden = true
    $('conn-model-fetch').disabled = loading || Boolean(pending)
    $('connection-save').disabled = loading || Boolean(pending)
    text('conn-model-fetch', '获取模型')
    text('conn-model-status', message)
  }
  function modelQueryDraft() {
    const apiPaths = {}
    for (const input of document.querySelectorAll('[data-api-path]')) if (input.value.trim()) apiPaths[input.dataset.apiPath] = input.value.trim()
    return {
      ...(connection ? { id: connection.id } : {}),
      name: $('conn-name').value.trim(), baseURL: $('conn-base').value.trim(), protocol: $('conn-protocol').value, apiPaths,
      auth: { ...(connection?.auth ?? { source: 'stored' }), mode: $('conn-auth-mode').value, key: $('conn-key').value, value: $('conn-value').value },
    }
  }
  async function fetchConnectionModels() {
    if (locked()) return
    const draft = modelQueryDraft()
    if (!draft.baseURL) { text('conn-model-status', '请先填写上方站点地址。'); $('conn-base').focus(); return }
    if (draft.auth.source !== 'host' && draft.auth.mode !== 'none') {
      const field = draft.auth.mode === 'custom' ? 'value' : 'key'
      const saved = connection?.secrets?.[field] && connection.baseURL.replace(/\/+$/, '') === draft.baseURL.replace(/\/+$/, '') && !$('conn-clear-secret').checked
      if (!draft.auth[field] && !saved) { text('conn-model-status', '请先填写上方当前站点的密钥或完整 Authorization。'); return }
    }
    resetModelQuery('正在读取模型列表…')
    const query = { controller: new AbortController() }
    modelQuery = query
    $('conn-model-fetch').disabled = true
    $('connection-save').disabled = true
    $('conn-model-cancel').hidden = false
    text('conn-model-fetch', '获取中…')
    try {
      const response = await fetch('./api/pro/connections/models', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: query.controller.signal,
        body: JSON.stringify({ connection: draft, expectedRevision: connection?.revision, clearSecrets: $('conn-clear-secret').checked ? ['key','value'] : [], confirmNetwork: true, operationId: crypto.randomUUID() }),
      })
      const result = await response.json()
      if (modelQuery !== query) return
      if (!response.ok) throw new Error(result.error || '模型列表读取失败')
      if (!Array.isArray(result.models)) throw new Error('模型列表响应格式无效')
      showModelResult(result)
    } catch (error) {
      if (modelQuery === query) text('conn-model-status', query.controller.signal.aborted ? '已取消获取，手填内容保留。' : `${error.message}；手填内容保留。`)
    } finally {
      if (modelQuery === query) {
        modelQuery = null
        $('conn-model-fetch').disabled = false
        $('connection-save').disabled = false
        $('conn-model-cancel').hidden = true
        text('conn-model-fetch', '获取模型')
      }
    }
  }
  function showModelResult(result) {
    const ids = catalogModels(result)
    $('conn-model-options').replaceChildren(...ids.map(id => { const option = node('option', id); option.value = id; option.selected = true; return option }))
    modelQueryReady = ids.length > 0
    modelResultShown = true
    $('conn-model-result').hidden = !modelQueryReady
    text('conn-model-options-label', result.cached || result.refreshError ? '缓存的模型（可多选，未经本次刷新确认）' : '获取到的模型（可多选）')
    text('conn-model-status', modelCatalogStatus(result))
  }
  function applyFetchedModels(replace) {
    if (!modelQueryReady || locked()) return
    const selected = [...$('conn-model-options').selectedOptions].map(item => item.value)
    if (!selected.length) { text('conn-model-status', '请先选择需要填入的模型。'); return }
    if (replace && $('conn-models').value.trim() && !window.confirm('用选中模型替换当前手填列表？尚未保存的旧列表会被替换。')) return
    $('conn-models').value = fillSelectedModels($('conn-models').value, selected, replace)
    $('conn-models').dispatchEvent(new Event('input', { bubbles: true }))
    text('conn-model-status', `已${replace ? '替换为' : '追加'}选中的 ${selected.length} 个模型；点击“保存连接”才会保存。`)
  }
  function renderConnectionAccountOptions(selectedId = $('conn-site-account').value) {
    const result = connectionAccountChoices(state.siteAccounts ?? [], $('conn-base').value, selectedId)
    options($('conn-site-account'), [['', ACCOUNT_BINDING_EMPTY], ...result.choices.map(item => [item.value, item.label])], result.selected)
    text('conn-site-account-hint', result.invalid
      ? '当前绑定已失效或属于其他站点，已保留选项等待重新选择；保存时后端会拒绝无效绑定。'
      : result.mode === 'same-site'
        ? '仅列出与该连接站点根地址相同的账号；只影响余额与签到，不改变模型请求和凭据。'
        : '未找到同站点账号，暂显示全部；保存时后端仍会校验站点根地址一致。')
    return result
  }
  function editConnection(item = null) {
    if (!allowLeave()) return
    resetModelQuery()
    navigate('connections', true)
    connection = item ? clone(item) : null
    $('connection-panel').hidden = false; $('connection-form').hidden = false; $('binding-form').hidden = true
    text('connection-form-title', item ? '编辑连接' : '添加连接')
    for (const [id, value] of Object.entries({ 'conn-name': item?.name ?? '', 'conn-base': item?.baseURL ?? '', 'conn-protocol': item?.protocol ?? 'auto', 'conn-auth-mode': item?.auth.mode ?? 'api-key', 'conn-key': '', 'conn-value': '', 'conn-models': (item?.models ?? []).join('\n'), 'conn-model-protocols': Object.entries(item?.modelProtocols ?? {}).map(([key, value]) => `${key} = ${value}`).join('\n'), 'conn-site': item?.siteId ?? '' })) $(id).value = value
    $('conn-enabled').checked = item?.enabled !== false; $('conn-independent').checked = Boolean(item?.independent); $('conn-clear-secret').checked = false
    renderConnectionAccountOptions(item?.newApiAccountId ?? '')
    for (const control of document.querySelectorAll('[data-api-path]')) control.value = item?.apiPaths?.[control.dataset.apiPath] ?? ''
    $('connection-remove').hidden = !item; $('conn-binding-field').hidden = Boolean(item); $('conn-binding-note').hidden = !item
    $('conn-binding').value = 'auto'; text('connection-form-error', ''); updateAuthFields()
    connectionBaseline = JSON.stringify(connectionDraft()); dirtyConnection = false
    const cachedCatalog = catalogFor(state, item?.id)
    if (cachedCatalog) showModelResult(cachedCatalog)
  }
  function openBinding(ids = [], ref = null) {
    if (!allowLeave()) return
    navigate('connections', true)
    $('connection-panel').hidden = false; $('connection-form').hidden = true; $('binding-form').hidden = false
    text('binding-generation', `generation ${state.generation}`)
    $('binding-connections').replaceChildren(...state.connections.map(item => { const label = node('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id; input.checked = ids.includes(item.id); label.append(input, node('span', item.name)); return label }))
    $('binding-mode').value = ref ? 'template' : 'auto'; $('binding-scope').value = 'connection'; $('binding-model').value = ''
    if (ref) { $('binding-template').value = ref.id; renderRevisions('binding', ref.revision) }
    bindingFields()
  }
  function bindingFields() {
    $('binding-template-fields').hidden = $('binding-mode').value !== 'template'
    $('binding-model-field').hidden = $('binding-scope').value !== 'model'
    text('binding-summary', '应用只改变所选连接的后续请求。已开始的请求继续使用原版本；回退请选择历史版本。')
  }
  function beginFork(base) {
    if (!allowLeave()) return
    options($('template-base-select'), state.templates.filter(item => !item.archived).map(item => [keyOf(item), `${item.name} @ ${item.revision}`]), base ? keyOf(base) : 'builtin.codex@1')
    $('template-base-name').value = base ? `${base.name} 副本` : ''
    $('template-base-dialog').showModal()
  }
  function checkboxes(container, values, checked) {
    container.replaceChildren(...values.map(value => { const label = node('label'); const control = document.createElement('input'); control.type = 'checkbox'; control.value = value; control.checked = checked.includes(value); label.append(control, node('span', value)); return label }))
  }
  function addHeader(rule = { name: '', action: 'set', value: '', enabled: true, when: 'always' }) {
    const row = document.createElement('tr'); row.dataset.headerRow = 'true'
    const input = (field, kind = 'input') => { const element = document.createElement(kind); element.dataset.field = field; return element }
    const on = input('enabled'); on.type = 'checkbox'; on.checked = rule.enabled !== false; on.setAttribute('aria-label', '启用请求头')
    const name = input('name'); name.value = rule.name; name.setAttribute('aria-label', '请求头名称')
    const action = input('action', 'select'); options(action, [['set','覆盖'],['set-if-missing','仅缺失补充'],['set-if-empty','缺失或空补充'],['delete','删除'],['preserve','保留']], rule.action)
    const value = input('value','textarea'); value.value = rule.value ?? ''; value.setAttribute('aria-label', '请求头值'); value.rows = 2
    const when = input('when','select'); options(when, [['always','始终'],['native','原生'],['third-party','第三方']], rule.when ?? 'always')
    const ops = input('operations'); ops.value = rule.operations?.join(',') ?? ''; ops.placeholder = '全部'; ops.setAttribute('aria-label', '限定操作')
    const remove = button('×', () => { row.remove(); updateDraft() }, 'danger'); remove.setAttribute('aria-label','移除请求头')
    for (const control of [on,name,action,value,when,ops,remove]) { const cell = document.createElement('td'); cell.append(control); row.append(cell) }
    $('tpl-headers').tBodies[0].append(row)
  }
  function templateDraft() {
    const draft = clone(template)
    draft.name = $('tpl-name').value.trim()
    draft.protocols = [...$('tpl-protocols').querySelectorAll('input:checked')].map(input => input.value)
    draft.operations = [...$('tpl-operations').querySelectorAll('input:checked')].map(input => input.value)
    draft.identity = { ...draft.identity, detector: $('tpl-detector').value, mode: $('tpl-mode').value, session: $('tpl-session').value, userAgent: $('tpl-ua').value, version: $('tpl-version').value }
    draft.headers = [...$('tpl-headers').tBodies[0].rows].map(row => { const get = field => row.querySelector(`[data-field="${field}"]`); const action = get('action').value; const entry = { name: get('name').value, action, enabled: get('enabled').checked, when: get('when').value }; if (!['delete','preserve'].includes(action)) entry.value = get('value').value; if (get('operations').value.trim()) entry.operations = get('operations').value.split(',').map(value => value.trim()).filter(Boolean); return entry })
    draft.body = { ...draft.body, codexMetadata: $('tpl-codex-metadata').checked, claudeCompatibility: $('tpl-claude-compat').value, fastBeta: $('tpl-fast-beta').checked,
      parameters: { defaults: jsonObject($('tpl-defaults').value,'defaults'), overrides: jsonObject($('tpl-overrides').value,'overrides'), remove: lines($('tpl-remove').value) } }
    if ($('tpl-identity-prompt').value.trim()) draft.body.identityprompt = $('tpl-identity-prompt').value; else delete draft.body.identityprompt
    draft.limits = { maxBodyBytes: Number($('tpl-max-body').value), bodyTimeoutMs: Number($('tpl-body-timeout').value), maxMetadataBytes: Number($('tpl-max-metadata').value) }
    return draft
  }
  function updateDraft() {
    if (!template) return
    try {
      const current = templateDraft()
      dirtyTemplate = template.kind === 'custom' && JSON.stringify(current) !== templateBaseline
      text('tpl-dirty', template.kind === 'builtin' ? '内置基线只读' : dirtyTemplate ? '草稿已修改，尚未保存为版本' : '已保存版本，连接绑定保持不变')
      text('tpl-state', dirtyTemplate ? '未保存' : '无修改')
      const changes = differences(templateOrigin ?? template, current)
      $('tpl-changes').replaceChildren(...(changes.length ? changes.map(change => node('div', `${change.action} ${change.path}`, 'diff-line')) : [node('p','与基线相同')]))
      text('tpl-json', JSON.stringify(safeTemplate(current), null, 2))
      $('tpl-save').disabled = template.kind === 'builtin' || locked() || (!dirtyTemplate && Boolean(template.id))
      $('tpl-apply').disabled = !template.id || dirtyTemplate || locked()
      text('tpl-error','')
    } catch (cause) { dirtyTemplate = true; text('tpl-error',cause.message); $('tpl-apply').disabled = true }
  }
  function editTemplate(item, isNew = false) {
    if (!isNew && !allowLeave()) return
    navigate('templates', true)
    template = clone(item)
    templateOrigin = item.basedOn ? state.templates.find(base => base.id === item.basedOn.id && base.revision === item.basedOn.revision) : item
    $('template-library').hidden = true; $('template-editor').hidden = false
    $('tpl-name').value = item.name
    checkboxes($('tpl-protocols'), PROTOCOLS, item.protocols)
    checkboxes($('tpl-operations'), [...new Set(Object.values(OPERATIONS).flat())], item.operations)
    for (const [id, value] of Object.entries({ 'tpl-detector': item.identity.detector, 'tpl-mode': item.identity.mode, 'tpl-session': item.identity.session, 'tpl-ua': item.identity.userAgent ?? '', 'tpl-version': item.identity.version ?? '', 'tpl-claude-compat': item.body.claudeCompatibility, 'tpl-identity-prompt': item.body.identityprompt ?? '', 'tpl-defaults': JSON.stringify(item.body.parameters.defaults, null, 2), 'tpl-overrides': JSON.stringify(item.body.parameters.overrides, null, 2), 'tpl-remove': item.body.parameters.remove.join('\n'), 'tpl-max-body': item.limits.maxBodyBytes, 'tpl-body-timeout': item.limits.bodyTimeoutMs, 'tpl-max-metadata': item.limits.maxMetadataBytes })) $(id).value = value
    $('tpl-codex-metadata').checked = item.body.codexMetadata; $('tpl-fast-beta').checked = item.body.fastBeta
    $('tpl-headers').tBodies[0].replaceChildren(); for (const header of item.headers) addHeader(header)
    text('tpl-revision', item.id ? `v${item.revision}` : '新草稿'); text('tpl-base', item.basedOn ? `${item.basedOn.id} @ ${item.basedOn.revision}` : '内置基线')
    $('tpl-readonly').hidden = item.kind !== 'builtin'
    for (const control of $('template-editor').querySelectorAll('.tpl-sections input,.tpl-sections select,.tpl-sections textarea,.tpl-sections button,#tpl-name')) control.disabled = item.kind === 'builtin'
    templateBaseline = JSON.stringify(templateDraft()); dirtyTemplate = isNew
    updateDraft(); if (isNew) { dirtyTemplate = true; text('tpl-dirty','新模板草稿，尚未保存'); $('tpl-save').disabled = false }
  }
  function showHistory(id) {
    const items = state.templates.filter(item => item.id === id).sort((a,b) => b.revision-a.revision)
    text('history-title', `${items[0].name} · 版本历史`)
    $('history-body').replaceChildren(...items.map(item => { const row = node('div', undefined,'history-row'); row.append(node('span', `版本 ${item.revision} · ${item.protocols.join('/')}`)); const actions = node('div', undefined,'toolbar-actions'); actions.append(button('查看', () => { $('template-history').close(); editTemplate(item) }), button('与上一版比较', () => { const previous = items.find(other => other.revision === item.revision-1); $('history-diff').replaceChildren(...differences(previous ?? {}, item).map(change => node('p', `${change.action} ${change.path}`, 'hint'))) }), button('应用 / 回退', () => { $('template-history').close(); openBinding([], item) })); if (item.kind === 'custom') actions.append(button('删除', async () => { if (window.confirm('删除这个未被使用的版本？此操作不能撤销。')) await run('templates/remove', { id, revision: item.revision }, () => { $('template-history').close() }) },'danger')); row.append(actions); return row }))
    $('history-diff').replaceChildren(); $('template-history').showModal()
  }
  function selectedTestConnection() { return state.connections.find(item => item.id === $('test-connection').value) }
  function currentTestModel() { return testModelManual ? $('test-model').value.trim() : $('test-model-select').value }
  function cancelTestModelQuery() {
    const query = testModelQuery
    testModelQuery = null
    query?.controller.abort()
    $('test-model-cancel').hidden = true
  }
  function testFormIdentity() {
    return testRequestIdentity({ kind: $('test-kind').value, connectionId: $('test-connection').value, connectionRevision: selectedTestConnection()?.revision,
      protocol: $('test-protocol').value, model: currentTestModel(), operation: $('test-operation').value, stream: $('test-stream').checked,
      templateMode: $('test-template-source').value, templateId: $('test-template').value, revision: $('test-revision').value,
      apiPath: $('test-api-path').value, request: { headers: $('test-headers').value, body: $('test-body').value } })
  }
  function markTestResult() {
    const stale = Boolean(lastTestIdentity) && lastTestIdentity !== testFormIdentity()
    $('test-result-stale').hidden = !stale || testResultRunning
    $('test-result').dataset.stale = String(stale && !testResultRunning)
    if(stale&&!testResultRunning&&!loading&&!pending)status('当前选项尚未测试，下方是上一次请求结果')
  }
  function planInputs() {
    const source = $('test-template-source').value
    const connection = selectedTestConnection() ?? { id: 'preview-only', name: '离线预览', baseURL: 'https://preview.invalid', protocol: $('test-protocol').value, apiPaths: {}, binding: { mode: 'auto', resolvedVersions: { responses: { id: 'builtin.codex', revision: 1 }, anthropic: { id: 'builtin.claude-code', revision: 1 } } } }
    const input = { snapshot: state, connection, kind: $('test-kind').value, protocol: $('test-protocol').value, model: currentTestModel(), operation: $('test-operation').value,
      stream: $('test-stream').checked, templateMode: source === 'auto' ? 'auto' : 'binding', apiPath: $('test-kind').value === 'check' ? undefined : $('test-api-path').value.trim() || undefined }
    if (source === 'ref' && input.kind !== 'check') input.templateRef = { id: $('test-template').value, revision: Number($('test-revision').value) }
    if (source === 'draft' && input.kind !== 'check') { if (!template) throw new Error('尚无模板草稿，请先选择已有版本或复制模板'); input.template = { ...templateDraft(), id: template.id ?? 'custom.preview-draft', revision: template.revision ?? 1 } }
    if (source === 'none') input.template = null
    if (input.kind !== 'preview' && !selectedTestConnection()) throw new Error('请选择要直测的连接')
    return input
  }
  function updateTestPlan() {
    testPlan = null
    testPlanError = ''
    try {
      testPlan = createTestPlan(planInputs())
      if ($('test-kind').value !== 'check') validateTestSample(jsonObject($('test-body').value, '请求正文'), testPlan)
      text('test-plan-url', `${testPlan.method} ${testPlan.url}`)
      text('test-plan-template', testPlan.templateId ? `模板：${testPlan.template?.name ?? testPlan.templateId} @ ${testPlan.revision}` : '模板：普通转发')
      text('test-plan-note', [testPlan.resolution?.message, ...(testPlan.warnings ?? [])].filter(Boolean).join(' '))
      text('test-plan-state', '准备就绪')
      text('test-plan-error', '')
    } catch (cause) {
      testPlanError = cause.message
      text('test-plan-url', testPlan ? `${testPlan.method} ${testPlan.url}` : '请选择连接与模型并核对本次协议')
      text('test-plan-template', testPlan?.templateId ? `模板：${testPlan.template?.name ?? testPlan.templateId} @ ${testPlan.revision}` : '')
      text('test-plan-note', '')
      text('test-plan-state', '需要核对')
      text('test-plan-error', testPlanError)
    }
    const connection = selectedTestConnection()
    const model = currentTestModel()
    const productionProtocol = connection && model ? protocolForModel(connection, model) : null
    text('test-production-route', productionProtocol ? `已保存的生产上游：${productionProtocol}。${testPlan?.protocol !== productionProtocol ? `本次测试为 ${testPlan?.protocol ?? '待选择'}，尚未保存到生产路由。` : '本次协议与生产路由一致。'}` : '')
    text('test-model-reference', gatewayModelReference(connection, model))
    const productionBinding = connection?.modelBindings?.[model] ?? connection?.binding
    const templateDiffers = productionBinding?.mode === 'template' && testPlan && (productionBinding.id !== testPlan.templateId || productionBinding.revision !== testPlan.revision)
    $('test-route-save').hidden = !connection || !testPlan || Boolean(testPlanError) || $('test-kind').value === 'check' || Boolean($('test-api-path').value.trim()) || (!templateDiffers && productionProtocol === testPlan.protocol) || $('test-template-source').value === 'draft'
    $('test-route-save').disabled = loading || Boolean(pending)
    $('test-plan').dataset.valid = String(!testPlanError)
    markTestResult()
  }
  function updateTestControls() {
    const busy = loading || Boolean(pending)
    updateTestPlan()
    $('test-model-fetch').disabled = busy || Boolean(testModelQuery) || !selectedTestConnection()
    $('test-model-select').disabled = busy || testModelManual || !testModels.length
    $('test-model-manual').disabled = busy
    $('test-run').disabled = busy || Boolean(testPlanError) || ($('test-kind').value !== 'check' && (!currentTestModel() || Boolean(testModelQuery))) || ($('test-kind').value === 'check' && !selectedTestConnection())
  }
  function syncTestModel({ followProtocol = true, reset = false } = {}) {
    const model = currentTestModel()
    if (!testModelManual) $('test-model').value = model
    if (followProtocol && !testProtocolExplicit && model) $('test-protocol').value = testModelProtocol(selectedTestConnection(), model, $('test-protocol').value)
    const protocol = $('test-protocol').value
    options($('test-operation'), OPERATIONS[protocol].map(value => [value,value]))
    if (['count_tokens','countTokens'].includes($('test-operation').value)) $('test-stream').checked=false
    else if (protocol === 'gemini' && $('test-stream').checked) $('test-operation').value = 'streamGenerateContent'
    if (!$('test-body').value || $('test-body').value === testSampleBaseline) resetSample()
    else {
      dirtyTestSample = true
      $('test-sample-notice').hidden = false
    }
    if (reset) text('test-error', '')
    updateTestControls()
  }
  function renderTestModels(message) {
    const current = selectTestModel(testModels, $('test-model-select').value)
    options($('test-model-select'), testModels.length ? testModels.map(model => [model.id, model.name === model.id ? model.id : `${model.name} · ${model.id}`]) : [['', selectedTestConnection() ? '暂无可测试模型' : '请先选择连接']], current)
    options($('test-model-list'), testModels.map(model => [model.id, model.name]))
    const saved = selectedTestConnection()?.models?.length
    text('test-model-status', message ?? (testModels.length ? testCatalog?.cached ? `已载入 ${testModels.length} 个可选模型 · ${CATALOG_SOURCES[testCatalog.source] ?? '已发现目录'}；可刷新列表，不代表生成已验证。` : saved ? `已载入 ${testModels.length} 个模型，优先使用连接中已保存的模型。` : `已获取 ${testModels.length} 个可选模型；请确认后再发送测试。` : selectedTestConnection() ? '此连接暂无模型。可点击“刷新模型”，或使用高级选项明确输入模型 ID；离线预览不会自动联网。' : '请选择连接；仅离线预览也可手动输入模型 ID。'))
    syncTestModel()
  }
  function syncTestConnection({ autoFetch = false, reset = false } = {}) {
    const selected = selectedTestConnection()
    const changed = testConnectionID !== (selected?.id ?? '') || testConnectionRevision !== selected?.revision
    if (changed || reset) {
      cancelTestModelQuery()
      testConnectionID = selected?.id ?? ''
      testConnectionRevision = selected?.revision
      testProtocolExplicit = false
      testModelManual = false
      $('test-model-manual-field').hidden = true
      $('test-model-manual').setAttribute('aria-expanded', 'false')
      text('test-model-manual', '手动输入模型 ID')
      $('test-model').value = ''
      $('test-model-select').value = ''
      testCatalog = catalogFor(state, selected?.id)
      $('test-api-path').value = ''
      if (!$('test-body').value || $('test-body').value === testSampleBaseline) testSampleBaseline = $('test-body').value = ''
      else { dirtyTestSample = true; $('test-sample-notice').hidden = false }
    } else {
      const cached = catalogFor(state, selected?.id)
      if (cached && (!testCatalog || Date.parse(cached.checkedAt) >= Date.parse(testCatalog.checkedAt))) testCatalog = cached
    }
    testModels = testModelOptions(selected, testCatalog)
    renderTestModels()
    if (autoFetch && $('test-kind').value === 'infer' && selected && !testModels.length && !queriedTestConnections.has(selected.id) && !testModelQuery && !loading && !pending) void fetchTestModels()
  }
  async function fetchTestModels() {
    const selected = selectedTestConnection()
    if (!selected || loading || pending || testModelQuery) return
    const query = { controller: new AbortController(), id: selected.id, revision: selected.revision }
    testModelQuery = query
    queriedTestConnections.add(selected.id)
    text('test-model-status', '正在读取此连接的模型列表…仅获取目录，不发送生成请求。')
    $('test-model-cancel').hidden = false
    updateTestControls()
    try {
      const response = await fetch('./api/pro/connections/models', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: query.controller.signal,
        body: JSON.stringify({ connection: selected, expectedRevision: selected.revision, confirmNetwork: true, operationId: crypto.randomUUID() }) })
      const result = await response.json()
      if (testModelQuery !== query || selectedTestConnection()?.id !== query.id || selectedTestConnection()?.revision !== query.revision) return
      if (!response.ok) throw new Error(result.error || '模型列表读取失败')
      if (!Array.isArray(result.models)) throw new Error('模型列表响应格式无效')
      testCatalog = result
      state.modelCatalogs ??= {}
      state.modelCatalogs[selected.id] = result
      testModels = testModelOptions(selected, result)
      renderTestModels(result.cached ? `${modelCatalogStatus(result)} 请选择列表中的模型进行测试。` : testModels.length ? `已获取 ${testModels.length} 个可选模型，已自动选中真实模型。` : '上游返回空模型列表。可刷新重试，或使用高级选项手动输入已知模型 ID。')
    } catch (error) {
      if (testModelQuery === query) renderTestModels(query.controller.signal.aborted ? '已取消读取模型列表，未发送生成请求。' : `模型列表读取失败：${error.message}。${testModels.length ? '已有模型仍可选择。' : '可刷新重试，或使用高级选项输入已知模型 ID。'}`)
    } finally {
      if (testModelQuery === query) { testModelQuery = null; $('test-model-cancel').hidden = true; updateTestControls() }
    }
  }
  function resetSample() {
    const protocol = $('test-protocol').value
    options($('test-operation'), OPERATIONS[protocol].map(value => [value,value]))
    if (protocol === 'gemini' && $('test-stream').checked) $('test-operation').value = 'streamGenerateContent'
    const model = currentTestModel()
    const body = model ? createTestSample(protocol, model, $('test-stream').checked, $('test-operation').value) : null
    $('test-body').value = body ? JSON.stringify(body, null, 2) : ''
    testSampleBaseline = $('test-body').value
    dirtyTestSample = $('test-headers').value !== testHeadersBaseline
    $('test-sample-notice').hidden = true
  }
  function testFields() {
    const kind = $('test-kind').value, source = $('test-template-source').value
    $('test-template-fields').hidden = kind === 'check'; $('test-ref-fields').hidden = source !== 'ref'
    for(const id of ['test-protocol-fields','test-model-fields','test-stream-field','test-sample'])$(id).hidden=kind==='check'
    $('test-endpoint-options').hidden=kind==='check'
    if(kind==='check')$('test-sample-notice').hidden=true
    text('test-kind-hint', kind === 'preview' ? '离线转换，不发送网络请求。' : kind === 'check' ? '只读取所选连接的模型列表，不验证生成能力。' : '直接请求所选连接，不换 key、不自动回退；可能产生费用。')
    text('test-run', kind === 'preview' ? '运行本地预览' : kind === 'check' ? '检查模型列表' : '发送实际测试')
    updateTestControls()
  }
  function openTest(connectionId = '', draft = null) {
    if (connectionId) $('test-connection').value = connectionId
    $('test-template-source').value = draft ? 'draft' : 'auto'
    $('test-kind').value = 'preview'
    syncTestConnection({ reset: Boolean(connectionId) })
    if (draft) { testProtocolExplicit = true; $('test-protocol').value = draft.protocols[0]; syncTestModel({ followProtocol: false }) }
    testFields()
    navigate('tests', true)
  }
  function renderTest(result, identity) {
    testResultRunning = false
    lastTestIdentity = identity ?? testFormIdentity()
    $('test-result').replaceChildren(node('h2', result.kind === 'preview' ? '本地转换预览' : result.kind === 'check' ? '模型列表检查' : '直测此连接'))
    $('test-result').append(node('p', result.status === 'passed' ? '通过' : '未通过', `result-state ${result.status === 'passed' ? '' : 'failed'}`), node('p', result.error ?? result.message ?? '这是本次请求的固定结果；改变表单后会标记为上一次测试。', 'hint'))
    const summary = node('dl', undefined,'kv')
    for (const [label,value] of [['连接',result.connectionName ?? result.connectionId ?? '离线预览'],['模型',result.model || '模型列表检查'],['测试时间',catalogTime(result.testedAt ?? new Date().toISOString())],['模板', result.templateId ? `${result.templateId} @ ${result.revision}` : '普通转发 / 未使用'],['上游协议',result.protocol ?? '模型列表'],['HTTP',result.httpStatus ?? (result.kind === 'preview' ? '未联网' : '未收到响应')],['耗时', `${result.durationMs ?? 0} ms`],['原始身份',result.callerIdentity ?? '未判断']]) { const row = node('div'); row.append(node('dt',label),node('dd',value)); summary.append(row) }
    $('test-result').append(summary)
    if (result.request?.url) $('test-result').append(node('p', `${result.request.method ?? 'POST'} ${result.request.url}`, 'test-plan-url'))
    if (result.resolution?.message) $('test-result').append(node('p',result.resolution.message,'hint'))
    if (result.diagnostic) {
      const info=node('section',undefined,'test-diagnostic')
      info.append(node('h3',result.diagnostic.title),node('p',result.diagnostic.message))
      for(const step of result.diagnostic.suggestions ?? [])info.append(node('p',step,'hint'))
      $('test-result').append(info)
    }
    for (const [title,value] of [['响应',result.responseText],['用量',result.usage],['模型列表',result.models],['出站请求（脱敏）',result.request],['变更规则',result.changes]]) if (value !== undefined) { const details = node('details',undefined,'more'); details.open = title==='响应'; details.append(node('summary',title),node('pre',typeof value === 'string' ? value : JSON.stringify(value,null,2),'code-block')); $('test-result').append(details) }
    markTestResult()
  }
  async function executeTest() {
    let payload
    try {
      const kind = $('test-kind').value
      if (kind !== 'check' && !currentTestModel()) throw new Error('请选择列表中的模型，或在高级选项中输入已知模型 ID')
      if (kind !== 'check' && testModelQuery) throw new Error('模型列表正在读取，请稍候或取消获取')
      payload = { kind, connectionId: $('test-connection').value || undefined, protocol: $('test-protocol').value, model: currentTestModel(), operation: $('test-operation').value, stream: $('test-stream').checked }
      if (kind !== 'check') payload.request = { headers: jsonObject($('test-headers').value,'请求头'), body: jsonObject($('test-body').value,'请求正文') }
      if (kind !== 'check') {
        const source = $('test-template-source').value
        payload.templateMode = source === 'auto' ? 'auto' : 'binding'
        if (source === 'ref') payload.templateRef = { id: $('test-template').value, revision: Number($('test-revision').value) }
        if (source === 'draft') { if (!template) throw new Error('请先创建模板草稿'); payload.template = { ...templateDraft(), id: template.id ?? 'custom.preview-draft', revision: template.revision ?? 1 } }
        if (source === 'none') payload.template = null
      }
      updateTestPlan()
      if (testPlanError) throw new Error(testPlanError)
      payload.apiPath = kind === 'check' ? undefined : $('test-api-path').value.trim() || undefined
      payload.expectedGeneration = state.generation
      payload.expectedConnectionRevision = selectedTestConnection()?.revision
      const identity = testFormIdentity()
      if (kind !== 'preview') {
        if (!payload.connectionId) throw new Error('请选择要直测的连接')
        text('test-confirm-text', kind === 'infer' ? '此操作将发送一次简短模型请求，可能产生费用；不自动重试或切换连接。测试选项不会改变保存的绑定。' : '此操作只读取模型列表，不发送生成请求。')
        $('test-confirm-detail').replaceChildren(node('p', selectedTestConnection()?.name ?? ''), node('p', `${testPlan.method} ${testPlan.url}`, 'test-plan-url'), node('p', `模型：${kind === 'check' ? '目录检查' : testPlan.model} · 协议：${testPlan.protocol}`), node('p', testPlan.templateId ? `模板：${testPlan.template?.name ?? testPlan.templateId} @ ${testPlan.revision}` : '模板：普通转发'), node('p', testPlan.resolution?.message ?? '', 'hint'))
        $('test-confirm').showModal()
        const choice = await new Promise(resolve => $('test-confirm').addEventListener('close', () => resolve($('test-confirm').returnValue), { once: true }))
        if (choice !== 'confirm') return
        payload.confirmNetwork = true
      }
      text('test-error', '')
      showError(null)
      testResultRunning = true
      $('test-result-stale').hidden = true
      $('test-result').replaceChildren(node('h2', '正在测试当前选择'), node('p', `${testPlan.model || '模型列表'} · ${testPlan.protocol}`, 'hint'), node('p', `${testPlan.method} ${testPlan.url}`, 'test-plan-url'))
      await run('test',payload,data => {
        renderTest(data.result, identity)
        status(data.result.status === 'passed' ? '测试完成：通过' : '测试完成：未通过，请查看本次原因')
      })
      if (!pending && testResultRunning) { testResultRunning = false; $('test-result').replaceChildren(node('h2', '本次测试未发送或准备失败'), node('p', '请查看配置提示。此处不是之前的请求结果。', 'hint')) }
    } catch (cause) { text('test-error',cause.message); $('test-error').focus?.(); markTestResult() }
  }

  for (const link of document.querySelectorAll('[data-view-link]')) link.addEventListener('click', event => { event.preventDefault(); navigate(link.dataset.viewLink) })
  for (const link of document.querySelectorAll('[data-leave]')) link.addEventListener('click',event => { if (!allowLeave()) event.preventDefault() })
  for (const control of document.querySelectorAll('[data-action="connection-new"]')) control.addEventListener('click', () => editConnection())
  $('pro-reload').addEventListener('click', async () => { if (!allowLeave()) return; try { await refresh(false); status('已重新读取') } catch (error) { showError(error) } })
  $('pro-recover').addEventListener('click', recover)
  $('pro-close').addEventListener('click', async () => { if (!allowLeave()) return; await fetch('./api/cancel', { method:'POST',headers:{'content-type':'application/json'},body:'{}' }); document.body.replaceChildren(node('main','配置已关闭。此前保存的更改已保留。','empty')) })
  $('connection-form').addEventListener('input', () => { try { dirtyConnection = JSON.stringify(connectionDraft()) !== connectionBaseline } catch { dirtyConnection = true } text('connection-form-state',dirtyConnection ? '未保存' : '无修改') })
  $('conn-auth-mode').addEventListener('change',updateAuthFields)
  $('conn-base').addEventListener('input',()=>{if(!$('connection-form').hidden)renderConnectionAccountOptions()})
  $('conn-model-fetch').addEventListener('click', () => { void fetchConnectionModels() })
  $('conn-model-cancel').addEventListener('click', () => resetModelQuery('已取消获取，手填内容保留。'))
  $('conn-model-all').addEventListener('click', () => { for (const option of $('conn-model-options').options) option.selected = true })
  $('conn-model-add').addEventListener('click', () => applyFetchedModels(false))
  $('conn-model-replace').addEventListener('click', () => applyFetchedModels(true))
  for (const eventName of ['input', 'change']) $('connection-form').addEventListener(eventName, event => {
    if ((modelQuery || modelQueryReady || modelResultShown) && (['conn-base','conn-auth-mode','conn-key','conn-value','conn-protocol','conn-clear-secret'].includes(event.target.id) || event.target.hasAttribute('data-api-path'))) resetModelQuery('连接信息已改变，请重新获取模型。手填内容保留。')
  })
  $('connection-form').addEventListener('submit', async event => { event.preventDefault(); try { const current = connectionDraft(); if (!current.name || !current.baseURL) throw new Error('请填写连接名称和地址'); await run('connections/save',{connection:current,expectedRevision:connection?.revision,clearSecrets:$('conn-clear-secret').checked ? ['key','value'] : []},data=>{dirtyConnection=false;editConnection(data.connection)}) } catch(error){text('connection-form-error',error.message)} })
  $('connection-cancel').addEventListener('click',()=>{if(allowLeave()){dirtyConnection=false;$('connection-panel').hidden=true}})
  $('connection-remove').addEventListener('click',()=>{if(connection && window.confirm('删除这个连接？不会删除模板或修改旧插件。'))void run('connections/remove',{id:connection.id,expectedRevision:connection.revision},()=>{dirtyConnection=false;$('connection-panel').hidden=true})})
  $('binding-open').addEventListener('click',()=>openBinding())
  $('binding-template').addEventListener('change',()=>renderRevisions('binding'))
  $('binding-mode').addEventListener('change',bindingFields); $('binding-scope').addEventListener('change',bindingFields)
  $('binding-cancel').addEventListener('click',()=>{$('connection-panel').hidden=true})
  $('binding-form').addEventListener('submit',event=>{event.preventDefault();const ids=[...$('binding-connections').querySelectorAll('input:checked')].map(input=>input.value);const mode=$('binding-mode').value;const binding=mode==='template'?{mode,id:$('binding-template').value,revision:Number($('binding-revision').value)}:{mode};if(!ids.length){text('binding-error','请选择连接');return}if(!window.confirm('应用后续新请求使用这个版本；正在进行的请求保持原版本。继续吗？'))return;void run('bindings/apply',{connectionIds:ids,binding,model:$('binding-scope').value==='model'?$('binding-model').value.trim():undefined,expectedGeneration:state.generation},()=>{$('connection-panel').hidden=true})})
  $('template-import').addEventListener('click',()=>{if(allowLeave())$('template-import-file').click()})
  $('template-import-file').addEventListener('change',async()=>{
    const file=$('template-import-file').files[0];$('template-import-file').value='';if(!file)return
    try{
      if(file.size>192*1024)throw new Error('模板文件最多192 KiB')
      const raw=jsonObject(await file.text(),'模板文件')
      await run('templates/validate',{template:raw},data=>{const draft=forkTemplate(data.template,`${data.template.name} 导入副本`);if(!state.templates.some(item=>item.id===draft.basedOn.id&&item.revision===draft.basedOn.revision))delete draft.basedOn;editTemplate(draft,true)})
    }catch(error){showError(error)}
  })
  $('tpl-export').addEventListener('click',()=>{
    try{
      if(!window.confirm('将导出规则副本。已知秘密字段会遮罩，自定义普通文本仍需你检查后再分享。继续吗？'))return
      const value=safeTemplate({...templateDraft(),id:template.id??'custom.export-draft'})
      const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}))
      const link=document.createElement('a');link.href=url;link.download='ua-pro-template.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
    }catch(error){showError(error)}
  })
  $('template-new').addEventListener('click',()=>beginFork())
  $('template-base-cancel').addEventListener('click',()=>$('template-base-dialog').close())
  $('template-base-form').addEventListener('submit',event=>{event.preventDefault();const base=state.templates.find(item=>keyOf(item)===$('template-base-select').value);const name=$('template-base-name').value.trim();if(!name){text('template-base-error','请填写模板名称');return}$('template-base-dialog').close();editTemplate(forkTemplate(base,name),true)})
  $('template-show-archived').addEventListener('change',renderTemplates)
  $('tpl-fork').addEventListener('click',()=>beginFork(template))
  $('tpl-header-add').addEventListener('click',()=>{addHeader();updateDraft()})
  $('template-editor').addEventListener('input',updateDraft);$('template-editor').addEventListener('change',updateDraft)
  $('tpl-back').addEventListener('click',()=>{if(allowLeave()){dirtyTemplate=false;$('template-editor').hidden=true;$('template-library').hidden=false}})
  $('tpl-discard').addEventListener('click',()=>{if(!dirtyTemplate||window.confirm('放弃尚未保存的模板修改？')){dirtyTemplate=false;editTemplate(template,true);dirtyTemplate=false;templateBaseline=JSON.stringify(templateDraft());updateDraft()}})
  $('template-editor').addEventListener('submit',async event=>{event.preventDefault();try{const current=templateDraft();const versions=state.templates.filter(item=>item.id===current.id);await run('templates/save',{template:current,expectedRevision:versions.length?Math.max(...versions.map(item=>item.revision)):0},data=>{dirtyTemplate=false;editTemplate(data.template)})}catch(error){text('tpl-error',error.message)}})
  $('tpl-preview').addEventListener('click',()=>{try{templateDraft();openTest('',template)}catch(error){text('tpl-error',error.message)}})
  $('tpl-apply').addEventListener('click',()=>{if(template?.id&&!dirtyTemplate)openBinding([],template)})
  $('history-close').addEventListener('click',()=>$('template-history').close())
  $('test-template').addEventListener('change',()=>{renderRevisions('test');updateTestControls()})
  $('test-revision').addEventListener('change',updateTestControls)
  $('test-kind').addEventListener('change',()=>{testFields();syncTestConnection({autoFetch:true})});$('test-template-source').addEventListener('change',testFields)
  $('test-connection').addEventListener('change',()=>{testSelectionInitialized=true;syncTestConnection({autoFetch:true,reset:true})})
  $('test-model-select').addEventListener('change',()=>syncTestModel({reset:true}))
  $('test-model').addEventListener('input',()=>syncTestModel())
  $('test-model-fetch').addEventListener('click',()=>{void fetchTestModels()})
  $('test-model-cancel').addEventListener('click',()=>{cancelTestModelQuery();renderTestModels('已取消读取模型列表，未发送生成请求。')})
  $('test-model-manual').addEventListener('click',()=>{
    testModelManual=!testModelManual
    $('test-model-manual-field').hidden=!testModelManual
    $('test-model-manual').setAttribute('aria-expanded',String(testModelManual))
    text('test-model-manual',testModelManual?'返回列表选择':'手动输入模型 ID')
    if(testModelManual){$('test-model').value=currentTestModel()||$('test-model-select').value;$('test-model').focus()}
    syncTestModel()
  })
  $('test-protocol').addEventListener('change',()=>{testProtocolExplicit=true;syncTestModel({followProtocol:false,reset:true})});$('test-stream').addEventListener('change',()=>syncTestModel({followProtocol:false,reset:true}))
  const useSimpleSample=()=>{if($('test-body').value!==testSampleBaseline&&!window.confirm('用当前协议的简短样例替换自定义正文？'))return;resetSample();text('test-error','');updateTestControls()}
  $('test-sample-reset').addEventListener('click',useSimpleSample);$('test-sample-adapt').addEventListener('click',useSimpleSample)
  $('test-operation').addEventListener('change',()=>{
    if(['count_tokens','countTokens'].includes($('test-operation').value))$('test-stream').checked=false
    else if($('test-protocol').value==='gemini')$('test-stream').checked=$('test-operation').value==='streamGenerateContent'
    if($('test-body').value===testSampleBaseline)resetSample();else{$('test-sample-notice').hidden=false;dirtyTestSample=true}
    updateTestControls()
  })
  $('test-api-path').addEventListener('input',updateTestControls)
  $('test-route-save').addEventListener('click',async()=>{
    updateTestPlan()
    const connection=selectedTestConnection()
    if(!connection||!testPlan||testPlanError||$('test-api-path').value.trim())return
    if(!window.confirm(`将 ${testPlan.model} 的生产上游保存为 ${testPlan.protocol}，模板 ${testPlan.template?.name ?? '普通转发'}？其他模型不变。保存后需在 Magpie 重新获取模型或重载插件。`))return
    const binding=testPlan.templateId?{mode:'template',id:testPlan.templateId,revision:testPlan.revision}:{mode:'passthrough'}
    const routedModel=testPlan.model
    await run('routes/apply',{connectionId:connection.id,model:routedModel,protocol:testPlan.protocol,binding,expectedGeneration:state.generation},()=>{
      syncTestConnection({reset:true})
      if(testModels.some(item=>item.id===routedModel))$('test-model-select').value=routedModel
      else {testModelManual=true;$('test-model').value=routedModel;$('test-model-manual-field').hidden=false;$('test-model-manual').setAttribute('aria-expanded','true');text('test-model-manual','返回列表选择')}
      syncTestModel({reset:true})
      status('模型路由已保存，请在 Magpie 重新获取模型或重载插件')
    })
  })
  for(const id of ['test-body','test-headers'])$(id).addEventListener('input',()=>{dirtyTestSample=$('test-body').value!==testSampleBaseline||$('test-headers').value!==testHeadersBaseline;updateTestControls()})
  $('test-form').addEventListener('change',()=>{text('test-error','');if(!loading&&!pending)showError(null);markTestResult()})
  $('test-form').addEventListener('submit',event=>{event.preventDefault();void executeTest()})
  $('test-cancel').addEventListener('click',async()=>{
    if(operation?.action!=='test')return
    $('test-cancel').disabled=true
    text('test-cancel','取消中…');status('正在取消本次测试；若已到达上游，仍可能计费')
    try{await fetch('./api/pro/cancel-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:operation.id})})}
    catch{showError('未收到取消确认，请查询原操作，不要重复发送')}
    finally{if(!loading){$('test-cancel').disabled=false;text('test-cancel','取消测试')}}
  })
  $('migration-preview').addEventListener('click',()=>run('migration/preview',{},data=>{migration=data;$('migration-result').replaceChildren(node('pre',JSON.stringify(data,null,2),'code-block'));$('migration-apply').hidden=!data.available}))
  $('migration-apply').addEventListener('click',()=>{if(migration?.available&&window.confirm('复制旧 Claude 配置为 UA PRO 新连接？原配置不变。'))void run('migration/apply',{fingerprint:migration.fingerprint},()=>{$('migration-apply').hidden=true})})
  window.addEventListener('beforeunload',event=>{if(isDirty()||locked()){event.preventDefault();event.returnValue=''}})
  try { await refresh();navigate(location.hash.slice(1)||'overview',true);testFields();resetSample();$('pro-shell').dataset.ready='true';status('配置已读取。保存版本与应用连接分别执行。') } catch(error){showError(error);status('无法读取 UA PRO 配置')}
}
