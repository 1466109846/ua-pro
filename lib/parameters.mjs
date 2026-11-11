const protectedFields = new Set(["model", "messages", "stream", "tools", "tool_choice"])
const responsesFields = new Set([
  "store", "include", "instructions", "input", "reasoning", "max_output_tokens",
  "parallel_tool_calls", "prompt_cache_key", "response_format", "stream_options",
  "previous_response_id", "conversation", "background", "truncation",
])
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"])

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

export function copyJSON(value, depth = 0) {
  if (depth > 32) throw new TypeError("JSON depth exceeds 32 (possibly cyclic)")
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item) => copyJSON(item, depth + 1))
  if (!isObject(value)) throw new TypeError("Settings must contain only JSON values")
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (unsafeKeys.has(key)) throw new TypeError(`Unsafe option key: ${key}`)
    result[key] = copyJSON(item, depth + 1)
  }
  return result
}

export function compileParameters(options = {}) {
  if (!isObject(options)) throw new TypeError("parameters must be an object")
  for (const key of Object.keys(options)) {
    if (!["defaults", "overrides", "remove"].includes(key)) throw new TypeError(`Unknown parameters option: ${key}`)
  }
  const plan = {}
  for (const section of ["defaults", "overrides"]) {
    const value = options[section] === undefined ? {} : options[section]
    if (!isObject(value)) throw new TypeError(`parameters.${section} must be an object`)
    for (const key of Object.keys(value)) {
      if (protectedFields.has(key)) throw new TypeError(`parameters.${section}.${key} is protected`)
      if (responsesFields.has(key)) throw new TypeError(`${key} is not an Anthropic Messages parameter`)
    }
    plan[section] = copyJSON(value)
  }
  const remove = options.remove === undefined ? [] : options.remove
  if (!Array.isArray(remove)) throw new TypeError("parameters.remove must be an array of object paths")
  plan.remove = remove.map((path) => {
    if (typeof path !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(path)) {
      throw new TypeError("parameters.remove must contain nonempty dotted object paths (no array indexes)")
    }
    const keys = path.split(".")
    if (keys.some((key) => unsafeKeys.has(key))) throw new TypeError(`Unsafe remove path: ${path}`)
    if (protectedFields.has(keys[0])) throw new TypeError(`parameters.remove: ${keys[0]} is protected`)
    return keys
  })
  plan.active = Object.keys(plan.defaults).length > 0 || Object.keys(plan.overrides).length > 0 || plan.remove.length > 0
  return plan
}

function merge(target, source, defaults) {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) {
      target[key] = copyJSON(value)
    } else if (isObject(value) && isObject(target[key])) {
      // A different thinking mode must not inherit the previous mode's budget.
      if (key === "thinking" && Object.hasOwn(value, "type") && value.type !== target[key].type) {
        if (!defaults) target[key] = copyJSON(value)
      } else merge(target[key], value, defaults)
    } else if (!defaults) target[key] = copyJSON(value)
  }
}

function validate(body) {
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 0) throw new TypeError("max_tokens must be a nonnegative safe integer")
  for (const key of ["temperature", "top_p"]) {
    if (Object.hasOwn(body, key) && (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1)) {
      throw new TypeError(`${key} must be a number between 0 and 1`)
    }
  }
  if (Object.hasOwn(body, "top_k") && (!Number.isSafeInteger(body.top_k) || body.top_k < 0)) throw new TypeError("top_k must be a nonnegative safe integer")
  if (!Object.hasOwn(body, "thinking")) return
  const thinking = body.thinking
  if (!isObject(thinking) || typeof thinking.type !== "string" || !thinking.type.trim()) throw new TypeError("thinking.type must be a nonempty string")
  if (thinking.type === "enabled") {
    // Interleaved thinking can legitimately budget more than max_tokens.
    if (!Number.isSafeInteger(thinking.budget_tokens) || thinking.budget_tokens < 1024) {
      throw new TypeError("thinking.budget_tokens must be an integer >= 1024")
    }
  } else if (["adaptive", "disabled", "between_tools"].includes(thinking.type) && Object.hasOwn(thinking, "budget_tokens")) {
    throw new TypeError("budget_tokens is only valid with thinking.type enabled")
  }
}

export function applyParameters(body, plan) {
  if (!plan.active) return body
  if (!isObject(body)) throw new TypeError("Messages body must be a JSON object")
  const result = structuredClone(body)
  merge(result, plan.defaults, true)
  merge(result, plan.overrides, false)
  for (const keys of plan.remove) {
    let parent = result
    for (const key of keys.slice(0, -1)) {
      if (!isObject(parent) || !Object.hasOwn(parent, key)) { parent = undefined; break }
      parent = parent[key]
    }
    if (isObject(parent)) delete parent[keys.at(-1)]
  }
  validate(result)
  return result
}
