#!/usr/bin/env node
// PreToolUse nudge toward the graph tools, before a raw Bash/Grep/Read/Glob call fires.
//
// SERVER_INSTRUCTIONS (the MCP server's own description of when to use koragraph) only reaches the
// top-level session — a subagent spawned via Task never sees it, so it falls back to grep cold. A
// PreToolUse hook fires for every tool call regardless of which agent issued it, so this is the one
// place that reaches a subagent too. This hook covers a subagent that never touches koragraph at
// all; the SERVER_INSTRUCTIONS line about not re-verifying covers the main session using koragraph
// and then re-checking with grep anyway.
//
// Fires once per (session, agent) and goes silent — either because it already nudged, or because
// that agent already reached for a koragraph tool on its own. No database, no network: a stat on a
// tmp marker file. Never blocks; PreToolUse output here is advisory context, not a permission denial.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const CODE_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|ex|exs|sh|sql|rb)$/i;
const BASH_EXPLORE_RE = /(^|[\s;|&])(grep|rg|ag|ack|find|cat|less|more|head|tail)\b/;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function markerPath(input) {
  const key = `${input.session_id || 'nosession'}-${input.agent_id || 'main'}`;
  return path.join(os.tmpdir(), `koragraph-nudge-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
}

function looksLikeRawExploration(input) {
  const name = input.tool_name;
  if (name === 'Grep' || name === 'Glob') return true;
  if (name === 'Read') {
    const p = (input.tool_input && input.tool_input.file_path) || '';
    return CODE_FILE_RE.test(p);
  }
  if (name === 'Bash') {
    const cmd = (input.tool_input && input.tool_input.command) || '';
    return BASH_EXPLORE_RE.test(cmd);
  }
  return false;
}

function emit(text) {
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }));
}

const NUDGE = [
  'This repository has koragraph code-graph tools connected',
  '(mcp__koragraph__explore, search_code, blast_radius, neighbours, file_symbols, overview) — a',
  'resolved graph, not raw text. Before grepping or reading source to learn what code does, call',
  'explore or search_code; it usually answers "how does X work / where do I change it" in one call.',
  'If you were just delegated this task by another agent, you were not told this directly — use the',
  'koragraph tools yourself rather than falling back to grep. (Shown once per agent.)',
].join(' ');

try {
  const raw = await readStdin();
  if (raw.trim()) {
    const input = JSON.parse(raw);
    const marker = markerPath(input);
    const usedKoragraph = typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__koragraph__');

    if (usedKoragraph) {
      try { fs.writeFileSync(marker, ''); } catch (_) { /* best-effort */ }
    } else if (looksLikeRawExploration(input) && !fs.existsSync(marker)) {
      emit(NUDGE);
      try { fs.writeFileSync(marker, ''); } catch (_) { /* best-effort */ } // once only, even if never used
    }
  }
} catch (err) {
  if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[nudge] ${err.stack}\n`);
}
process.exit(0);
