#!/usr/bin/env node
// PostToolUse / PostToolUseFailure recorder for the practice graph.
//
// Both events must be registered. PostToolUse fires ONLY on success, and the Bash success object
// carries no exit code — register it alone and you record every pass, zero failures, and the
// fail→fix state machine never fires once.
//
// Contract this file must honour, in order of how expensive getting it wrong is:
//   1. Never fail the user's tool call. Every path exits 0.
//   2. Never write to stdout. A PostToolUse hook's stdout is surfaced to the transcript; this
//      hook has nothing to say.
//   3. Never touch graph.db (see recorder.js).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// The repo checkout by default; KORAGRAPH_PRACTICE_ROOT points at it when this file has been
// copied to ~/.koragraph/hooks/ instead of run from the tree.
const root = process.env.KORAGRAPH_PRACTICE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readStdin();
  if (raw.trim()) {
    const { record } = require(join(root, 'src', 'practice', 'recorder.js'));
    record(JSON.parse(raw));
  }
} catch (err) {
  // Debuggable when asked for, silent otherwise. A recorder that breaks an edit is worse than a
  // recorder that misses one.
  if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[practice] ${err.stack}\n`);
}
process.exit(0);
