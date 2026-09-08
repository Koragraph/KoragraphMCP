#!/usr/bin/env node
// PreToolUse retrieval-layer guard: make the graph the first thing an agent reaches for, before a
// raw Grep/Glob/Read/Bash-search call fires.
//
// SERVER_INSTRUCTIONS (the MCP server's own description of when to use koragraph) only reaches the
// top-level session — a subagent spawned via Task never sees it, so it falls back to grep cold. A
// PreToolUse hook fires for every tool call regardless of which agent issued it, so this is the one
// place that reaches a subagent too.
//
// Two strengths, by tool:
//   - Grep and Glob are the harness's codebase-search primitives — the retrieval layer koragraph
//     replaces. On the COLD path (this agent has not called a koragraph tool yet) these are DENIED,
//     up to KORAGRAPH_NUDGE_MAX_REDIRECTS times, with a reason that tells the agent to reissue the
//     search as explore/search_code. After that many denials the guard relents and allows the call,
//     so a graph that genuinely has no answer never hard-locks the agent out of searching.
//   - Read of a source file, and a Bash command that shells out to grep/rg/find/cat/…, are only
//     NUDGED (advisory context, never blocked): a Bash grep is often a legitimate pipeline
//     (`git log | grep`, `npm test | grep fail`) and a Read targets a file the agent already chose,
//     so blocking either would break real work rather than redirect a search.
//
// Once the agent calls any koragraph tool, a marker is written and this guard goes fully silent for
// that (session, agent): the graph has been consulted, so grep is now a legitimate fallback and
// every later search/read passes untouched. State is a stat on tmp marker files — no database, no
// network.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const CODE_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|ex|exs|sh|sql|rb)$/i;
const BASH_EXPLORE_RE = /(^|[\s;|&])(grep|rg|ag|ack|find|cat|less|more|head|tail)\b/;

// How many cold Grep/Glob calls to deny before relenting. One denial is enough to make a compliant
// agent switch to explore (which sets the graph-used marker and ends all redirects); the extra
// headroom only covers an agent that ignores the first reason. Kept low so a graph with no answer
// costs at most this many blocked calls before grep is allowed through as the fallback.
function maxRedirects() {
  const v = parseInt(process.env.KORAGRAPH_NUDGE_MAX_REDIRECTS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function markerBase(input) {
  const key = `${input.session_id || 'nosession'}-${input.agent_id || 'main'}`;
  return path.join(os.tmpdir(), `koragraph-nudge-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
}

// One (session, agent) has three independent marker files hanging off the same base: the graph-used
// flag, the soft-nudge-shown flag, and the redirect counter. Separate files so counting denials
// never disturbs the once-only soft nudge, and vice versa.
const GRAPH_USED = (base) => `${base}-graphused`;
const SOFT_SHOWN = (base) => `${base}-soft`;
const REDIRECTS = (base) => `${base}-redirects`;

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}
function touch(file) {
  try { fs.writeFileSync(file, ''); } catch { /* best-effort */ }
}
function readCount(file) {
  try { const n = parseInt(fs.readFileSync(file, 'utf8'), 10); return Number.isFinite(n) ? n : 0; } catch { return 0; }
}
function bumpCount(file) {
  const n = readCount(file) + 1;
  try { fs.writeFileSync(file, String(n)); } catch { /* best-effort */ }
  return n;
}

// The two search primitives koragraph stands in for. A cold call to either is what gets redirected.
function isGraphSearch(name) {
  return name === 'Grep' || name === 'Glob';
}

// A raw read/exploration that is only worth a soft nudge, never a block.
function looksLikeRawRead(input) {
  const name = input.tool_name;
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

function emitContext(text) {
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }));
}

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

const DENY_REASON = [
  'koragraph is this repository\'s retrieval layer, and it has not been consulted yet this task.',
  'Reissue this search as mcp__koragraph__explore (pass the symbol OR a plain-English phrase) or',
  'mcp__koragraph__search_code: it searches a resolved code graph, not raw text, and usually answers',
  '"how does X work / where do I change it" in one call — ranked declarations with their source,',
  'callers and callees. Grep/Glob are the fallback for when the graph comes up empty; reach for them',
  'after you have tried the graph. If another agent delegated this task to you, you were not told',
  'this directly — use the koragraph tools yourself.',
].join(' ');

const NUDGE = [
  'This repository has koragraph code-graph tools connected',
  '(mcp__koragraph__explore, search_code, blast_radius, neighbours, file_symbols, overview) — a',
  'resolved graph, not raw text. Before reading source to learn what code does, call explore or',
  'search_code; it usually answers "how does X work / where do I change it" in one call. If you were',
  'just delegated this task by another agent, you were not told this directly — use the koragraph',
  'tools yourself rather than falling back to grep. (Shown once per agent.)',
].join(' ');

const RELENT = [
  'koragraph: the graph has not been consulted this task, but Grep/Glob are now allowed as a',
  'fallback. If mcp__koragraph__explore has not answered your question, grep is fine — otherwise it',
  'usually locates code here in fewer steps.',
].join(' ');

try {
  const raw = await readStdin();
  if (raw.trim()) {
    const input = JSON.parse(raw);
    const base = markerBase(input);
    const name = input.tool_name;
    const usedKoragraph = typeof name === 'string' && name.startsWith('mcp__koragraph__');

    if (usedKoragraph) {
      // The graph has been consulted; every later search/read is a legitimate fallback. Go silent.
      touch(GRAPH_USED(base));
    } else if (exists(GRAPH_USED(base))) {
      // Already in the fallback regime for this agent — pass everything through untouched.
    } else if (isGraphSearch(name)) {
      // Cold codebase search: redirect to the graph, up to the cap, then relent so a graph with no
      // answer never hard-locks searching.
      if (readCount(REDIRECTS(base)) < maxRedirects()) {
        bumpCount(REDIRECTS(base));
        emitDeny(DENY_REASON);
      } else if (!exists(SOFT_SHOWN(base))) {
        touch(SOFT_SHOWN(base));
        emitContext(RELENT);
      }
    } else if (looksLikeRawRead(input) && !exists(SOFT_SHOWN(base))) {
      // A read or a Bash search: advise once, never block.
      touch(SOFT_SHOWN(base));
      emitContext(NUDGE);
    }
  }
} catch (err) {
  if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[nudge] ${err.stack}\n`);
}
process.exit(0);
