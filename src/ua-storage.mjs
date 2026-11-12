import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUAStore } from './ua-store.mjs'

const packageRuntime = fileURLToPath(new URL('../runtime/', import.meta.url))
const preparations = new Map()
const stateFiles = ['ua-pro.json', 'accounts.json', 'ua-pro.json.models.json', 'profile.json']
const claimFile = /^(?:\d{4}-\d{2}-\d{2}-[a-f0-9]{64}|[a-f0-9]{64}\.last)\.json$/

export function uaStorePath(options = {}, env = process.env, input = {}) {
  const path = options.uaFile ?? env.UA_PRO_FILE ?? (input.directory ? join(input.directory, 'ua-pro', 'ua-pro.json') : join(packageRuntime, 'ua-pro.json'))
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('UA PRO 配置路径必须为绝对路径')
  return path
}

async function info(path) {
  try { return await fs.lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function directory(path) {
  const stat = await info(path)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('UA PRO 数据目录必须是普通目录，不能使用符号链接')
  return stat
}

async function file(path, limit = 8 * 1024 * 1024) {
  const stat = await info(path)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('UA PRO 旧配置必须是大小受限的普通文件，不能使用符号链接')
  const bytes = await fs.readFile(path)
  if (bytes.length > limit) throw new Error('UA PRO 旧配置文件过大')
  return bytes
}

export async function prepareUAStorage({ input = {}, options = {}, env = process.env, legacyDirectory = packageRuntime } = {}) {
  const path = uaStorePath(options, env, input)
  const base = { path, imported: false }
  if (options.uaFile !== undefined || env.UA_PRO_FILE !== undefined || !input.directory) return base
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  if (preparations.has(key)) return preparations.get(key)
  const pending = (async () => {
    const folder = dirname(path)
    await directory(folder)
    if (await info(path)) return base
    if (!await directory(legacyDirectory)) return base
    if (!await info(join(legacyDirectory, 'ua-pro.json'))) return base
    if (await info(folder) && (await fs.readdir(folder)).length) throw new Error('UA PRO 目标数据目录已有文件，未合并或覆盖；请核对配置路径')
    await createUAStore(join(legacyDirectory, 'ua-pro.json')).snapshot()
    const files = new Map()
    for (const name of stateFiles) {
      const bytes = await file(join(legacyDirectory, name))
      if (bytes) files.set(name, bytes)
    }
    const claims = join(legacyDirectory, 'schedule-claims')
    if (await directory(claims)) {
      const names = (await fs.readdir(claims)).filter(name => claimFile.test(name))
      if (names.length > 8192) throw new Error('UA PRO 旧签到记录过多，未修改原目录')
      for (const name of names) files.set(join('schedule-claims', name), await file(join(claims, name), 2048))
    }
    const stage = join(input.directory, `.ua-pro-import-${randomUUID()}`)
    await fs.mkdir(stage, { mode: 0o700 })
    try {
      for (const [name, bytes] of files) {
        if (!bytes) continue
        const target = join(stage, name)
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const handle = await fs.open(target, 'wx', 0o600)
        try { await handle.writeFile(bytes); await handle.sync() }
        finally { await handle.close() }
      }
      if (await directory(folder)) {
        if (await info(path)) return base
        if ((await fs.readdir(folder)).length) throw new Error('UA PRO 目标数据目录已变化，未覆盖已有文件')
        await fs.rmdir(folder)
      }
      try { await fs.rename(stage, folder) }
      catch (error) {
        if (await info(path)) return base
        throw error
      }
      return { ...base, imported: true, message: '已将本插件安装目录内仍存在的配置复制到宿主持久目录；原文件保留' }
    } finally {
      const stat = await info(stage)
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.rm(stage, { recursive: true, force: true })
    }
  })()
  preparations.set(key, pending)
  try { return await pending }
  finally { if (preparations.get(key) === pending) preparations.delete(key) }
}
