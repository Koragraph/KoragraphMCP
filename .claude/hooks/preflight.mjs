#!/usr/bin/env node
// PreToolUse pre-flight for the practice graph.
//
// Surfaces what is already known about the symbol about to be edited, before the edit happens.
// Silent unless there is a LAW or an OBSERVATION to say, which is most edits.
//
// Same three rules as record.mjs, plus one more: this hook runs BEFORE the tool, so a slow or
// noisy one is felt directly by the user. It touches practice.db only — never graph.db, whose
// write lock during an ingest would stall the editor for the length of the ingest.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const root = process.env.KORAGRAPH_PRACTICE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function emit(text) {
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }));
}

try {
  const raw = await readStdin();
  if (raw.trim()) {
    const input = JSON.parse(raw);
    const { preflight } = require(join(root, 'src', 'practice', 'preflight.js'));
    const { openPracticeDb } = require(join(root, 'src', 'practice', 'db.js'));
    const sections = [];

    // Checks, not memory, and free: preconditions opens no store at all, which is what makes it
    // affordable before EVERY command the agent runs.
    if (input.tool_name === 'Bash') {
      const { preconditions } = require(join(root, 'src', 'practice', 'preconditions.js'));
      sections.push(preconditions(input));
    }

    // The tombstone pre-flight — the whole reason an abandoned approach is recorded — must be
    // reachable for Bash too, so this runs after the preconditions branch rather than returning.
    // It opens practice.db before every command: one read-only-shaped open of a WAL database
    // against re-running a command a past session already found to be a dead end. preflight()
    // answers null for a command shape nothing is recorded against, which is nearly all of them.
    const db = openPracticeDb();
    try {
      sections.push(preflight(input, { db }));
    } finally {
      db.close();
    }

    emit(sections.filter(Boolean).join('\n\n'));
  }
} catch (err) {
  if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[practice] ${err.stack}\n`);
}
process.exit(0);
