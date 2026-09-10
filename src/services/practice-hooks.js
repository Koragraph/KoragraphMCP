'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Wire koragraph's practice layer into a TARGET repository's Claude Code sessions by writing its
// `.claude/settings.json` hooks. Without this the memory layer is inert in that repo — nothing
// captures a correction, nothing delivers a recalled fact — which is exactly the state a fresh
// checkout is in. `koragraph doctor` prints these lines to paste by hand; this writes them.
//
// The hook COMMAND runs koragraph's own hook script by absolute path, so the script resolves
// koragraph's `src/` via its own location (import.meta.url/../..) with no PYTHONPATH-style env to get
// wrong. A non-default graph store is threaded through KORAGRAPH_DB so a per-repo store still anchors
// and delivers against the right graph; the practice store is shared by default.

// The canonical four events. Kept in lockstep with doctor.js#HOOK_WIRING — the same source a support
// answer points at, so an installed repo and the doctor's snippet cannot disagree.
const HOOK_WIRING = Object.freeze([
  ['UserPromptSubmit', 'context.mjs', null],
  // Prompt-conditioned graph push: reads the prompt for a symbol and a phrase and injects a small,
  // budgeted explore/recall block, so the graph reaches the model whether or not it thinks to ask.
  // Distinct from context.mjs (which pushes session laws): this one is prompt-conditioned and stays
  // additive. It shells the CLI with a hard timeout and fails open; KORAGRAPH_INJECT=0 disables it.
  ['UserPromptSubmit', 'inject.mjs', null],
  ['PreToolUse', 'preflight.mjs', 'Bash|Edit|Write|MultiEdit|NotebookEdit'],
  // No matcher: this one has to see every tool name, including mcp__koragraph__* attempts (to mark
  // the graph as "in use" and go quiet) and raw Bash/Grep/Read/Glob calls. A cold Grep/Glob (the
  // harness's codebase-search primitives) is DENIED and redirected to explore/search_code; a Read or
  // Bash search is only nudged. A PreToolUse hook fires for every tool call regardless of which agent
  // issued it, so — unlike SERVER_INSTRUCTIONS, which only reaches the top-level session — this is the
  // one place that reaches a delegated subagent too. See nudge.mjs.
  ['PreToolUse', 'nudge.mjs', null],
  ['PostToolUse', 'record.mjs', null],
  ['SessionEnd', 'session-end.mjs', null],
]);

function koragraphRoot() {
  return path.resolve(__dirname, '..', '..');
}

function hookScriptPath(file) {
  return path.join(koragraphRoot(), '.claude', 'hooks', file);
}

// A shell command that runs one hook script, threading a non-default graph store through the env so
// the hook (and the ingest-time drain it feeds) resolves anchors against the right graph.
function hookCommand(file, { graphDb, practiceDb } = {}) {
  const env = [];
  if (graphDb) env.push(`KORAGRAPH_DB=${JSON.stringify(graphDb)}`);
  if (practiceDb) env.push(`KORAGRAPH_PRACTICE_DB=${JSON.stringify(practiceDb)}`);
  const prefix = env.length ? `${env.join(' ')} ` : '';
  return `${prefix}node ${JSON.stringify(hookScriptPath(file))}`;
}

// A command belongs to koragraph if it invokes one of koragraph's hook scripts — the marker uninstall
// keys on, so we add/remove exactly our own entries and never touch a hook the user wrote.
function isKoragraphCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const hooksDir = path.join(koragraphRoot(), '.claude', 'hooks');
  return HOOK_WIRING.some(([, file]) => cmd.includes(path.join(hooksDir, file)))
    || cmd.includes(path.join('.claude', 'hooks', 'context.mjs')); // tolerate an older $CLAUDE_PROJECT_DIR form
}

// Same test, narrowed to ONE specific hook script rather than "any of koragraph's". Two entries can
// now share an event (PreToolUse: preflight.mjs and nudge.mjs) — matching broadly here would find
// the wrong one's entry and overwrite it instead of installing its own.
function isThisKoragraphCommand(cmd, file) {
  if (typeof cmd !== 'string') return false;
  // Match both the installer's absolute path and the committed `$CLAUDE_PROJECT_DIR/.claude/hooks/…`
  // form a checkout carries, so status/uninstall recognise a hook however it was wired. The file
  // names are koragraph's own, so the relative tail cannot collide with an unrelated hook.
  return cmd.includes(path.join(koragraphRoot(), '.claude', 'hooks', file))
    || cmd.includes(path.join('.claude', 'hooks', file));
}

function settingsPath(repoPath) {
  return path.join(repoPath, '.claude', 'settings.json');
}

function readSettings(repoPath) {
  const file = settingsPath(repoPath);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(`.claude/settings.json is not valid JSON (${err.message}) — fix or remove it, then re-run`);
  }
}

function writeSettings(repoPath, settings) {
  const file = settingsPath(repoPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

// Add koragraph's four hook entries to a settings object, preserving every existing hook. Idempotent:
// an event that already carries koragraph's entry is refreshed in place, not duplicated.
function installClaudeHooks(repoPath, opts = {}) {
  const settings = readSettings(repoPath);
  settings.hooks = settings.hooks || {};
  const results = [];
  for (const [event, file, matcher] of HOOK_WIRING) {
    const command = hookCommand(file, opts);
    const entry = matcher
      ? { matcher, hooks: [{ type: 'command', command }] }
      : { hooks: [{ type: 'command', command }] };
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const existingIdx = list.findIndex((e) => (e.hooks || []).some((h) => isThisKoragraphCommand(h.command, file)));
    if (existingIdx >= 0) {
      list[existingIdx] = entry;
      results.push({ event, action: 'refreshed' });
    } else {
      list.push(entry);
      results.push({ event, action: 'installed' });
    }
    settings.hooks[event] = list;
  }
  writeSettings(repoPath, settings);
  return { settingsFile: settingsPath(repoPath), results };
}

// Remove only koragraph's entries; leave any user hooks (and the rest of settings.json) untouched.
function uninstallClaudeHooks(repoPath) {
  const file = settingsPath(repoPath);
  if (!fs.existsSync(file)) return { settingsFile: file, results: [] };
  const settings = readSettings(repoPath);
  const results = [];
  for (const event of Object.keys(settings.hooks || {})) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event]
      .filter((e) => !(e.hooks || []).some((h) => isKoragraphCommand(h.command)));
    if (settings.hooks[event].length !== before) results.push({ event, action: 'removed' });
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  writeSettings(repoPath, settings);
  return { settingsFile: file, results };
}

function claudeHookStatus(repoPath) {
  const settings = readSettings(repoPath);
  const hooks = settings.hooks || {};
  const results = [];
  for (const [event, file] of HOOK_WIRING) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const present = list.some((e) => (e.hooks || []).some((h) => isThisKoragraphCommand(h.command, file)));
    results.push({ event, file, state: present ? 'managed' : 'absent' });
  }
  return { settingsFile: settingsPath(repoPath), results };
}

module.exports = {
  installClaudeHooks, uninstallClaudeHooks, claudeHookStatus, HOOK_WIRING, hookCommand, isKoragraphCommand,
};
