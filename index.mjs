import { createPlugin } from './src/plugin.mjs'
import { pluginOptions } from './src/options.mjs'
import { createUAPlugin, createUASite } from './src/ua-plugin.mjs'

export default async function ClaudeCodeUAPlugin(input, options) {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new TypeError('Plugin options must be an object')
  const legacy = { ...options }
  delete legacy.uaFile
  return createPlugin(input, legacy)
}

export const UAProPlugin = async (input, options) => createUAPlugin(input, options)
export const UAProSite1 = async (input, options) => createUASite(input, options, 0)
export const UAProSite2 = async (input, options) => createUASite(input, options, 1)
export const UAProSite3 = async (input, options) => createUASite(input, options, 2)
export const UAProSite4 = async (input, options) => createUASite(input, options, 3)
export const UAProSite5 = async (input, options) => createUASite(input, options, 4)
export const UAProSite6 = async (input, options) => createUASite(input, options, 5)
export const UAProSite7 = async (input, options) => createUASite(input, options, 6)
export const UAProSite8 = async (input, options) => createUASite(input, options, 7)

// The host calls every exported function; helpers therefore live on an object.
export const _internal = Object.freeze({ createPlugin, pluginOptions, createUAPlugin, createUASite })
