'use strict';

const { parseArgs } = require('node:util');
const { usageError } = require('./errors');

// node:util's parseArgs throws a TypeError carrying an ERR_PARSE_ARGS_* code. Left unwrapped a
// single mistyped flag prints a stack trace; wrapped, it is one line and exit 2.
function parseCommandArgs(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw usageError(err.message);
  }
}

function positiveInt(raw, flag, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw usageError(`${flag} must be a positive integer (got "${raw}").`);
  return n;
}

module.exports = { parseCommandArgs, positiveInt };
