'use strict';

// Neither the MCP SDK nor zod is a dependency of this package, deliberately: the tool schemas in
// tool-contracts.js are plain JSON Schema and this validates the exact subset they use — nothing
// more. It is not a JSON Schema implementation and must not grow into one.

function fail(message) {
  const err = new Error(message);
  err.code = 'invalid_params';
  err.status = 400;
  return err;
}

function coerceInteger(value, key) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw fail(`"${key}" must be an integer`);
  }
  return n;
}

function validateValue(key, value, schema) {
  // Union type, e.g. ['integer','string'] for a scope that is a numeric id OR a name. Bind to the
  // first member the value satisfies: a number / numeric string takes 'integer', anything else the
  // next type. Kept deliberately narrow — this is not a JSON Schema anyOf.
  if (Array.isArray(schema.type)) {
    for (const t of schema.type) {
      try {
        return validateValue(key, value, { ...schema, type: t });
      } catch (_) { /* try the next member */ }
    }
    throw fail(`"${key}" must be one of types: ${schema.type.join(', ')}`);
  }
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') throw fail(`"${key}" must be a string`);
      if (schema.minLength != null && value.trim().length < schema.minLength) {
        throw fail(`"${key}" must be a non-empty string`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        throw fail(`"${key}" must be one of: ${schema.enum.join(', ')}`);
      }
      return value;
    }
    case 'integer': {
      const n = coerceInteger(value, key);
      if (schema.minimum != null && n < schema.minimum) throw fail(`"${key}" must be >= ${schema.minimum}`);
      if (schema.maximum != null && n > schema.maximum) throw fail(`"${key}" must be <= ${schema.maximum}`);
      return n;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw fail(`"${key}" must be a boolean`);
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) throw fail(`"${key}" must be an array`);
      if (schema.minItems != null && value.length < schema.minItems) {
        throw fail(`"${key}" must contain at least ${schema.minItems} item(s)`);
      }
      return value.map((item, i) => validateValue(`${key}[${i}]`, item, schema.items || {}));
    }
    default:
      return value;
  }
}

function validateArgs(schema, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const props = schema.properties || {};
  const required = schema.required || [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) throw fail(`"${key}" is required`);
  }

  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((k) => !(k in props));
    // Name the accepted arguments in the error. An agent that guessed a plausible-but-wrong arg
    // (recall takes `symbol`/`file`, not the `query` an agent instinctively reaches for) then
    // self-corrects on the next call instead of giving up or retrying blind.
    if (unknown.length) {
      const accepted = Object.keys(props).join(', ') || '(none)';
      throw fail(`unknown argument(s): ${unknown.join(', ')}. Accepted: ${accepted}`);
    }
  }

  const out = {};
  for (const [key, propSchema] of Object.entries(props)) {
    const provided = args[key];
    if (provided === undefined || provided === null) {
      if (propSchema.default !== undefined) out[key] = propSchema.default;
      continue;
    }
    out[key] = validateValue(key, provided, propSchema);
  }
  return out;
}

module.exports = { validateArgs };
