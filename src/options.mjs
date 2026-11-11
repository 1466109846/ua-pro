import { isAbsolute } from 'node:path'
import { compileParameters, copyJSON, isObject } from '../lib/parameters.mjs'
import { createDefaultProfile } from './profile.mjs'

const blocked = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'host', 'content-length', 'content-encoding', 'connection', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer'])

export function pluginOptions(raw = {}) {
  if (!isObject(raw)) throw new TypeError('Plugin options must be an object')
  for (const key of Object.keys(raw)) {
    if (!['profileFile', 'accountBindings', 'baseURL', 'userAgent', 'headers', 'models', 'parameters', 'searches'].includes(key)) throw new TypeError(`Unknown plugin option: ${key}`)
  }
  if (raw.profileFile !== undefined && (typeof raw.profileFile !== 'string' || !isAbsolute(raw.profileFile))) throw new TypeError('profileFile must be an absolute path')
  if (raw.baseURL !== undefined) {
    let url
    try { url = new URL(raw.baseURL) } catch { throw new TypeError('baseURL must be an absolute HTTP(S) URL') }
    if (typeof raw.baseURL !== 'string' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new TypeError('Invalid baseURL: use HTTPS or loopback HTTP without credentials, query or fragment')
  }
  if (raw.userAgent !== undefined && (typeof raw.userAgent !== 'string' || !raw.userAgent.trim() || /[^\x20-\x7e]/.test(raw.userAgent))) throw new TypeError('userAgent must be a nonempty printable ASCII value')
  if (raw.headers !== undefined) {
    if (!isObject(raw.headers)) throw new TypeError('headers must be an object')
    const seen = new Set()
    for (const [key, value] of Object.entries(raw.headers)) {
      const name = key.toLowerCase()
      if (blocked.has(name) || name.startsWith('x-magpie-') || name === 'user-agent') throw new TypeError(`Cannot configure header ${name}; use userAgent for User-Agent`)
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || (value !== null && (typeof value !== 'string' || /[^\x20-\x7e\t]/.test(value)))) throw new TypeError(`Invalid header option: ${name}`)
      if (seen.has(name)) throw new TypeError(`Duplicate header option: ${name}`)
      seen.add(name)
    }
  }
  if (raw.models !== undefined && (!isObject(raw.models) || !Object.keys(raw.models).length || Object.values(raw.models).some(value => !isObject(value)))) throw new TypeError('models must be a nonempty object of model definitions')
  if (raw.parameters !== undefined) compileParameters(raw.parameters)
  if (raw.searches !== undefined && typeof raw.searches !== 'boolean') throw new TypeError('searches must be a boolean')
  const bindings = raw.accountBindings ?? {}
  if (!isObject(bindings) || Object.entries(bindings).some(([key, value]) => !key || typeof value !== 'string' || !value.trim())) throw new TypeError('accountBindings must map host account keys to site account IDs')
  return { ...copyJSON(raw), accountBindings: { ...bindings } }
}

// Saved profiles stay target-scoped; old plugin options are explicit global defaults.
export function optionProfile(options) {
  const profile = createDefaultProfile()
  if (options.baseURL) profile.upstream.baseUrl = options.baseURL.replace(/\/+$/, '')
  if (options.userAgent !== undefined) profile.headers.userAgent = options.userAgent
  if (options.headers) profile.headers.extra = Object.entries(options.headers).map(([name, value]) => ({ name, value, enabled: true }))
  if (options.models) profile.models = Object.keys(options.models)
  if (options.parameters) profile.parameters = copyJSON(options.parameters)
  return profile
}
