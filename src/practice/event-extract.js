'use strict';

const { repoIdentity, relativise } = require('./repo-identity');
const { fingerprint, sketch, hunkLines } = require('./fingerprint');
const { redactSecrets } = require('./untrusted');

// Hook input → event rows. Pure: no I/O beyond the filesystem walk that finds the repo root, no
// database. Separated from recorder.js so every rule below is testable against a literal payload
// rather than against a live hook.
//
// The contract, read out of the installed CLI rather than assumed:
//
//   base            { session_id, transcript_path, cwd, prompt_id, permission_mode,
//                     agent_id, agent_type, effort }
//   PostToolUse        + { hook_event_name, tool_name, tool_input, tool_response,
//                          tool_use_id, duration_ms }
//   PostToolUseFailure + { hook_event_name, tool_name, tool_input, tool_use_id,
//                          error, is_interrupt, duration_ms }
//
// Note what the failure event does NOT carry: `tool_response`. So `structuredPatch` exists only on
// success, which is right — a failed Edit changed nothing and has no range to anchor.

const MAX_ERR = 2000;
const MAX_PAYLOAD = 8000;
const MAX_HUNK_LINES = 120;
// A command must be bounded here. One real heredoc can run to hundreds of lines, and
// practice.db is durable and irreplaceable — a secret written into it is written forever.
const MAX_CMD = 4000;

// The same class of leak that can put `.env` contents into stored evidence one layer up: an inlined
// `TOKEN=…`, a `postgres://user:pw@host` in a psql invocation, an edited `.env`
// hunk. Redaction happens at CAPTURE, not only at render, because the store outlives every
// renderer and users paste terminal output into bug reports. Only the value is replaced, so the
// command SHAPE the fail→fix matcher keys on is untouched.
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.\w+)*|\.envrc|credentials?(?:\.\w+)*|secrets?(?:\.\w+)*|\.aws\/credentials|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|id_rsa|id_ed25519|.*\.tfvars|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i;

// Denial families authored by the CLI itself, taken from the strings in the binary. Deliberately
// not a generic /permission denied/i: that is also a real EACCES from the shell, and treating a
// genuine failure as a denial would silently drop the lesson it was about to produce.
//
// These patterns are only ever matched against Edit/Write/Bash results, all of which are
// CLI-authored. They must never be applied to an MCP tool's text, which the tool itself writes and
// can therefore forge.
const DENIAL_PATTERNS = [
  /^The user doesn't want to proceed with this tool use/,
  /\brequested permissions to (?:use|edit|read from|write to|glob)\b/,
  /\bbut you haven't granted it yet\b/,
  /^Permission to use\b/,
  /^Permission for this\b/,
  /\bThe user (?:denied|rejected) (?:this|the)\b/,
];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

function errText(input) {
  const e = input.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return e.message || JSON.stringify(e);
  // A failing Bash arrives in the transcript as a plain string ("Error: Exit code 1\n…"), so a
  // caller replaying transcript rows lands here rather than on `error`.
  const r = input.tool_response;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') return r.stderr || r.stdout || '';
  return '';
}

function isDenial(input) {
  // The CLI distinguishes an abort from a denial and hands us the answer directly. An Esc
  // mid-command is not evidence about the code either way.
  if (input.is_interrupt === true) return true;
  if (input.tool_response && input.tool_response.interrupted === true) return true;
  if (input.permission_decision === 'deny' || input.tool_denial_kind) return true;
  const text = errText(input);
  return DENIAL_PATTERNS.some((re) => re.test(text));
}

function trimPayload(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { return null; }
  return s.length > MAX_PAYLOAD ? s.slice(0, MAX_PAYLOAD) : s;
}

function baseOf(input, ts) {
  return {
    session_id: input.session_id || null,
    // NULL is the main loop. Scoping by session alone would interleave a subagent's edits with the
    // main loop's into a fail→fix pair that never happened.
    agent_id: input.agent_id || null,
    ts,
    tool_name: input.tool_name || null,
    tool_use_id: input.tool_use_id || null,
  };
}

function extractEvents(input, { now = new Date() } = {}) {
  if (!input || !input.session_id || !input.tool_name) return [];
  const ts = now.toISOString();
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const base = baseOf(input, ts);
  const tool = input.tool_name;

  if (tool === 'Bash') {
    const cmd = (input.tool_input && input.tool_input.command) || null;
    if (!cmd) return [];
    let event_type = 'cmd_pass';
    if (failed) event_type = isDenial(input) ? 'cmd_denied' : 'cmd_fail';
    else if (isDenial(input)) event_type = 'cmd_denied';
    const { repoId } = repoIdentity(input.cwd || process.cwd());
    return [{
      ...base,
      event_type,
      repo_id: repoId,
      file_path: null,
      hunk_index: null,
      old_start: null, old_lines: null, new_start: null, new_lines: null,
      old_fingerprint: null, new_fingerprint: null,
      cmd: redactSecrets(cmd).slice(0, MAX_CMD),
      err_excerpt: event_type === 'cmd_pass' ? null : redactSecrets(errText(input)).slice(0, MAX_ERR),
      payload: trimPayload({ cwd: input.cwd, permission_mode: input.permission_mode }),
    }];
  }

  if (READ_TOOLS.has(tool) || SEARCH_TOOLS.has(tool)) {
    // A failed Read is a file that was not there; a denied one never ran. Neither is evidence that
    // anyone looked at the code, which is the only thing this plane claims to record.
    if (failed || isDenial(input)) return [];
    const ti = input.tool_input || {};
    const target = ti.file_path || ti.notebook_path || ti.path || null;
    const pattern = ti.pattern || null;
    if (!target && !pattern) return [];
    const { repoRoot, repoId } = repoIdentity(input.cwd || process.cwd());
    return [{
      ...base,
      event_type: READ_TOOLS.has(tool) ? 'read' : 'search',
      repo_id: repoId,
      file_path: target ? relativise(repoRoot, target) : null,
      hunk_index: null,
      old_start: null, old_lines: null, new_start: null, new_lines: null,
      old_fingerprint: null, new_fingerprint: null,
      cmd: null,
      err_excerpt: null,
      search_pattern: pattern ? String(pattern).slice(0, MAX_ERR) : null,
      payload: trimPayload({ cwd: input.cwd, abs_path: target, glob: ti.glob || null }),
    }];
  }

  if (!EDIT_TOOLS.has(tool)) return [];
  // A failed or denied edit wrote nothing. There is no post-state to anchor and no delta to learn
  // from; the state machine reads edits, and an edit that did not happen is not one.
  if (failed || isDenial(input)) return [];

  const filePath = (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || null;
  if (!filePath) return [];

  const { repoRoot, repoId } = repoIdentity(input.cwd || process.cwd());
  const rel = relativise(repoRoot, filePath);
  const patch = (input.tool_response && input.tool_response.structuredPatch) || [];

  // Write has no patch, and an Edit can report an empty one. Both anchor at file grain: a
  // coordinate, not a node reference — a repo can have zero FILE nodes in the graph, so a
  // file-grain anchor cannot be a node id even when we want it to be.
  if (!Array.isArray(patch) || patch.length === 0) {
    return [{
      ...base,
      event_type: 'edit',
      repo_id: repoId,
      file_path: rel,
      hunk_index: null,
      old_start: null, old_lines: null, new_start: null, new_lines: null,
      old_fingerprint: null, new_fingerprint: null,
      cmd: null,
      err_excerpt: null,
      payload: trimPayload({ cwd: input.cwd, grain: 'file', abs_path: filePath }),
    }];
  }

  // One row per hunk. A single Edit with replace_all produces several, and every range but one
  // would be lost by collapsing them; tool_use_id + hunk_index put the call back together.
  // A hunk from a credential file is never worth its risk: the fingerprint and the line range are
  // what drift detection needs, and the text is what leaks.
  const secretFile = SECRET_FILE.test(rel);

  return patch.map((hunk, i) => {
    const oldLines = hunkLines(hunk, 'old');
    const newLines = hunkLines(hunk, 'new');
    return {
      ...base,
      event_type: 'edit',
      repo_id: repoId,
      file_path: rel,
      hunk_index: i,
      // oldStart indexes the PRE-edit file, newStart the POST-edit file. Resolving a fix against
      // oldStart points at whatever used to be there.
      old_start: hunk.oldStart ?? null,
      old_lines: hunk.oldLines ?? null,
      new_start: hunk.newStart ?? null,
      new_lines: hunk.newLines ?? null,
      old_fingerprint: fingerprint(oldLines),
      new_fingerprint: fingerprint(newLines),
      cmd: null,
      err_excerpt: null,
      payload: trimPayload({
        cwd: input.cwd,
        grain: 'symbol',
        abs_path: filePath,
        old: secretFile ? [] : oldLines.slice(0, MAX_HUNK_LINES).map(redactSecrets),
        new: secretFile ? [] : newLines.slice(0, MAX_HUNK_LINES).map(redactSecrets),
        secret_file: secretFile || undefined,
        new_sketch: sketch(newLines),
      }),
    };
  });
}

// The state machine matches on this, never on the raw string: `npm test` and `npm  test\n` are the
// same command. Deliberately not a shell parse — we never need to know it was a test.
function normaliseCommand(cmd) {
  if (!cmd) return null;
  return String(cmd).trim().replace(/\s+/g, ' ');
}

// Prefixes that say where a command runs, not what it does. Skipping them is what lets
// `cd /repo && npx vitest run` and `SP=/tmp/x; npx vitest run --silent` share a shape.
const SHAPE_SKIP = new Set([
  'cd', 'export', 'set', 'unset', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'source', '.',
  'shopt', 'umask', 'alias', 'true', 'pushd', 'popd', 'time',
]);

// Command SHAPE, not command identity: an agent writes a new heredoc and a new scratchpad path
// every time, so almost every command string is unique and exact identity never matches. Shape is
// program + first non-flag token with paths stripped: `npx vitest`, `node -e`, `go test`.
function commandShape(cmd) {
  if (!cmd) return null;
  const text = String(cmd);
  // Everything after the first quote or heredoc marker is a script body. Segmenting it would take
  // tokens out of the user's own program and call them commands.
  const stop = text.search(/<<|['"]/);
  const head = (stop === -1 ? text : text.slice(0, stop)).replace(/\\\n/g, ' ');
  for (const seg of head.split(/(?:&&|\|\||;|\||\n)/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i])) i++;
    if (i >= toks.length) continue;
    const prog = toks[i].split('/').pop();
    if (!prog || SHAPE_SKIP.has(prog) || /[$*?(){}]/.test(prog)) continue;
    const next = toks[i + 1];
    // A filename is not part of the shape: an agent runs a NEW scratch script every time, so
    // `node probe-a.mjs` and `node probe-b.mjs` have to compare equal or nothing ever pairs.
    const isFile = next && /\.[a-zA-Z0-9]{1,5}$/.test(next);
    if (next && !isFile && /^[-\w][-\w.:=]*$/.test(next) && next.length <= 24) return `${prog} ${next}`;
    return prog;
  }
  return null;
}

module.exports = {
  extractEvents, normaliseCommand, commandShape, isDenial, errText,
  DENIAL_PATTERNS, EDIT_TOOLS, READ_TOOLS, SEARCH_TOOLS,
};
