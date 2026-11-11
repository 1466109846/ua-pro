import * as fsPromises from "node:fs/promises"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, resolve } from "node:path"

const MAX_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 128
const MAX_MODELS = 2048
const MAX_ID = 256
const MAX_NAME = 512
const TTL = 24 * 60 * 60 * 1000
const queues = new Map()
const sources = new Set(["host", "management"])
const controls = /[\u0000-\u001f\u007f-\u009f]/u

function unsafe() {
  // Filesystem/JSON errors can contain paths or file contents; never expose them.
  return Object.assign(new Error("UA model catalog cannot be safely read or written"), { code: "ERR_UA_MODEL_CATALOG" })
}

function validScope(scope) {
  return typeof scope === "string" && scope.length === 64 && /^[a-f0-9]+$/.test(scope)
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function fields(value, names) {
  return record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}

function text(value, limit) {
  if (typeof value !== "string" || controls.test(value)) return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= limit ? trimmed : null
}

function timestamp(value, now) {
  let date = new Date(NaN)
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) date = new Date(value)
  if (!Number.isFinite(date.getTime())) date = new Date(now())
  if (!Number.isFinite(date.getTime())) throw unsafe()
  return date.toISOString()
}

function normalize(input, now) {
  if (!record(input) || !Array.isArray(input.models) || !sources.has(input.source)) throw unsafe()
  const models = []
  const seen = new Set()
  for (const model of input.models) {
    if (!record(model)) continue
    const id = text(model.id, MAX_ID)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: text(model.name, MAX_NAME) || id })
    if (models.length === MAX_MODELS) break
  }
  return { models, checkedAt: timestamp(input.checkedAt, now), source: input.source }
}

function validate(document) {
  if (!fields(document, ["schemaVersion", "entries"]) || document.schemaVersion !== 1 || !record(document.entries)) throw unsafe()
  const entries = Object.entries(document.entries)
  if (entries.length > MAX_ENTRIES) throw unsafe()
  for (const [scope, entry] of entries) {
    if (!validScope(scope) || !fields(entry, ["models", "checkedAt", "source"]) || !sources.has(entry.source)) throw unsafe()
    const date = typeof entry.checkedAt === "string" ? new Date(entry.checkedAt) : new Date(NaN)
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== entry.checkedAt) throw unsafe()
    if (!Array.isArray(entry.models) || entry.models.length > MAX_MODELS) throw unsafe()
    const seen = new Set()
    for (const model of entry.models) {
      if (!fields(model, ["id", "name"]) || !model.id || !model.name || text(model.id, MAX_ID) !== model.id || text(model.name, MAX_NAME) !== model.name || seen.has(model.id)) throw unsafe()
      seen.add(model.id)
    }
  }
  return document
}

function regular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BYTES) throw unsafe()
  return stat
}

function sameFile(left, right) {
  if (!left || !right) return left === right
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => left[key] === right[key])
}

function serialize(key, operation) {
  const previous = queues.get(key) || Promise.resolve()
  const task = previous.then(operation)
  const settled = task.then(() => {}, () => {})
  queues.set(key, settled)
  return task.finally(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
}

function encode(entries, scope) {
  // Reject individually oversized results; otherwise evict strictly by age.
  if (Buffer.byteLength(JSON.stringify({ schemaVersion: 1, entries: { [scope]: entries[scope] } })) > MAX_BYTES) throw unsafe()
  const oldest = Object.keys(entries).sort((a, b) => Date.parse(entries[a].checkedAt) - Date.parse(entries[b].checkedAt) || a.localeCompare(b))
  let remaining = Object.keys(entries).length
  while (remaining > MAX_ENTRIES) {
    delete entries[oldest.shift()]
    remaining--
  }
  let json = JSON.stringify({ schemaVersion: 1, entries })
  while (Buffer.byteLength(json) > MAX_BYTES) {
    const key = oldest.shift()
    if (!key) throw unsafe()
    delete entries[key]
    json = JSON.stringify({ schemaVersion: 1, entries })
  }
  return json
}

/**
 * Cache only normalized model names, timestamps, sources and caller-made SHA256 scopes.
 * IDs are limited to 256 UTF-16 units and names to 512. Invalid names fall back to IDs.
 * The queue coordinates this module's instances in one process, not other processes.
 */
export function createUAModelCatalog(statePath, { io = fsPromises, now = Date.now } = {}) {
  if (typeof statePath !== "string" || !isAbsolute(statePath) || statePath.includes("\0")) throw unsafe()
  const path = `${statePath}.models.json`
  const absolute = resolve(path)
  const queueKey = process.platform === "win32" ? absolute.toLowerCase() : absolute

  async function inspect() {
    let stat
    try {
      stat = await io.lstat(path)
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    return regular(stat)
  }

  async function load() {
    const stat = await inspect()
    if (!stat) return { stat: null, document: { schemaVersion: 1, entries: {} } }
    // O_NOFOLLOW is used where supported; lstat/fstat checks also cover Windows.
    const handle = await io.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      if (!sameFile(stat, regular(await handle.stat()))) throw unsafe()
      // Read at most the observed length plus one byte, never an unbounded readFile.
      const buffer = Buffer.allocUnsafe(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== stat.size || !sameFile(stat, regular(await handle.stat())) || !sameFile(stat, await inspect())) throw unsafe()
      const json = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))
      return { stat, document: validate(JSON.parse(json)) }
    } finally {
      await handle.close()
    }
  }

  async function guarded(scope, operation) {
    if (!validScope(scope)) throw unsafe()
    try {
      return await serialize(queueKey, operation)
    } catch {
      throw unsafe()
    }
  }

  return {
    path,
    async read(scope) {
      return guarded(scope, async () => {
        const { document } = await load()
        const entry = document.entries[scope]
        if (!entry) return null
        const clock = now()
        if (!Number.isFinite(clock)) throw unsafe()
        return clock - Date.parse(entry.checkedAt) >= TTL ? null : entry
      })
    },
    async write(scope, input) {
      return guarded(scope, async () => {
        const entry = normalize(input, now)
        const original = await load()
        const entries = { ...original.document.entries, [scope]: entry }
        const json = encode(entries, scope)
        await io.mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`
        let handle
        let owned = false
        try {
          handle = await io.open(temporary, "wx", 0o600)
          owned = true
          await handle.writeFile(json, "utf8")
          await handle.sync()
          await handle.close()
          handle = null
          // Revalidate immediately before replacing; this is not cross-process CAS.
          const current = await load()
          if (!sameFile(original.stat, current.stat)) throw unsafe()
          await io.rename(temporary, path)
          owned = false
          return entry
        } finally {
          try {
            if (handle) await handle.close()
          } finally {
            if (owned) await io.unlink(temporary)
          }
        }
      })
    },
  }
}
