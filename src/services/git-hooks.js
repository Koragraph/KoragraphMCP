'use strict';

// Git-hook auto-reindex: install hooks that re-ingest a repository whenever its HEAD moves, so the
// graph an agent queries is never stale after a commit, checkout, merge or rebase.
//
// These four hooks are exactly the events that move HEAD: incremental ingest diffs the recorded
// commit SHA against HEAD. A post-* hook cannot fail the git operation, so a slow or broken
// re-ingest can never cost the developer a commit — and the command is backgrounded regardless, so
// `git commit` returns immediately.
//
// This module is pure filesystem + git plumbing (no store, no tree-sitter) so it loads cheap and is
// tested against a throwaway `git init`. The store lookup that turns a path into its project lives
// in the CLI, which already owns the pool.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// post-checkout also fires on FILE checkouts (git checkout -- file); its third arg is 1 for a
// branch switch and 0 for a file, and only a branch switch can move HEAD. post-merge's arg is a
// squash flag we ignore. post-rewrite covers amend and rebase.
const MANAGED_HOOKS = ['post-commit', 'post-checkout', 'post-merge', 'post-rewrite'];

// Bump when the rendered block changes so an install over an older block replaces it in place.
const BLOCK_VERSION = 1;
const BLOCK_START = '# >>> koragraph auto-reindex >>> (managed — edit above/below, not between)';
const BLOCK_END = '# <<< koragraph auto-reindex <<<';
const SHEBANG = '#!/bin/sh';

// The hooks directory, honouring core.hooksPath and worktrees. `--git-path hooks` resolves
// relative to the repo, so a relative answer is joined onto the checkout root.
function hooksDir(repoPath) {
  const out = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim();
  return path.isAbsolute(out) ? out : path.join(repoPath, out);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// The command a hook runs. Absolute node + CLI entry because a git hook does NOT inherit the
// developer's interactive PATH, and this package is often run from a checkout rather than a global
// install — a bare `koragraph` would silently do nothing. Fully detached in a subshell and with all
// output discarded so it neither blocks git nor scribbles on the terminal mid-commit.
function reindexCommand({ nodeBin, cliEntry, repoPath, project }) {
  const call = `${shellQuote(nodeBin)} ${shellQuote(cliEntry)} ingest ${shellQuote(repoPath)} --project ${shellQuote(project)}`;
  return `( ${call} >/dev/null 2>&1 & )`;
}

function renderBlock(hookName, opts) {
  const guard = hookName === 'post-checkout'
    ? 'test "$3" = 1 || exit 0   # only a branch checkout moves HEAD\n'
    : '';
  return `${BLOCK_START} v${BLOCK_VERSION}\n${guard}${reindexCommand(opts)}\n${BLOCK_END}\n`;
}

function hasManagedBlock(body) {
  return body.includes(BLOCK_START);
}

// The managed block exactly as it sits in the file, start-marker through end-marker and the one
// trailing newline. Compared against a freshly rendered block to decide whether an install is a
// no-op, independent of whatever surrounds it.
function extractManagedBlock(body) {
  const s = body.indexOf(BLOCK_START);
  if (s < 0) return null;
  const e = body.indexOf(BLOCK_END, s);
  if (e < 0) return null;
  let end = e + BLOCK_END.length;
  if (body[end] === '\n') end += 1;
  return body.slice(s, end);
}

// Replace our block wherever it sits, start-marker to end-marker inclusive, leaving everything else
// byte-for-byte. Splitting on the markers rather than a regex keeps an unrelated hook the developer
// wrote around ours completely intact.
function stripManagedBlock(body) {
  const startIdx = body.indexOf(BLOCK_START);
  if (startIdx < 0) return body;
  const endMarkerIdx = body.indexOf(BLOCK_END, startIdx);
  if (endMarkerIdx < 0) return body;                      // half-written block: leave it, report it
  let end = endMarkerIdx + BLOCK_END.length;
  if (body[end] === '\n') end += 1;
  // Drop one leading blank-line separator we may have added when appending to a foreign hook.
  let start = startIdx;
  if (start >= 1 && body[start - 1] === '\n' && body[start - 2] === '\n') start -= 1;
  return body.slice(0, start) + body.slice(end);
}

// One hook file. Returns what happened so the CLI can report it honestly. Idempotent: a second
// install of the same version is a no-op; an install over an older version replaces the block.
function installHook(dir, hookName, opts) {
  const file = path.join(dir, hookName);
  const block = renderBlock(hookName, opts);
  let action;
  let body;
  if (!fs.existsSync(file)) {
    body = `${SHEBANG}\n\n${block}`;
    action = 'created';
  } else {
    const existing = fs.readFileSync(file, 'utf8');
    if (hasManagedBlock(existing)) {
      if (extractManagedBlock(existing) === block) return { hook: hookName, action: 'unchanged' };
      body = `${stripManagedBlock(existing).replace(/\s*$/, '\n')}\n${block}`;
      action = 'updated';
    } else {
      // A hook the developer (or another tool) already wrote. Append rather than overwrite, so
      // theirs still runs; a post-* hook that `exit`s early before ours is the one case this cannot
      // cover, and the CLI says so.
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      body = existing + sep + block;
      action = 'appended';
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return { hook: hookName, action };
}

function uninstallHook(dir, hookName) {
  const file = path.join(dir, hookName);
  if (!fs.existsSync(file)) return { hook: hookName, action: 'absent' };
  const existing = fs.readFileSync(file, 'utf8');
  if (!hasManagedBlock(existing)) return { hook: hookName, action: 'not-managed' };
  const stripped = stripManagedBlock(existing);
  // If nothing but our own scaffold remains, remove the file so an uninstall leaves no trace.
  if (stripped.replace(SHEBANG, '').trim() === '') {
    fs.rmSync(file);
    return { hook: hookName, action: 'removed' };
  }
  fs.writeFileSync(file, stripped);
  return { hook: hookName, action: 'unhooked' };
}

function hookStatus(dir, hookName) {
  const file = path.join(dir, hookName);
  if (!fs.existsSync(file)) return { hook: hookName, state: 'absent' };
  const body = fs.readFileSync(file, 'utf8');
  return { hook: hookName, state: hasManagedBlock(body) ? 'managed' : 'unmanaged' };
}

function installHooks(repoPath, opts) {
  const dir = hooksDir(repoPath);
  return { dir, results: MANAGED_HOOKS.map((h) => installHook(dir, h, opts)) };
}

function uninstallHooks(repoPath) {
  const dir = hooksDir(repoPath);
  return { dir, results: MANAGED_HOOKS.map((h) => uninstallHook(dir, h)) };
}

function statusHooks(repoPath) {
  const dir = hooksDir(repoPath);
  return { dir, results: MANAGED_HOOKS.map((h) => hookStatus(dir, h)) };
}

module.exports = {
  MANAGED_HOOKS, BLOCK_VERSION, BLOCK_START, BLOCK_END,
  hooksDir, reindexCommand, renderBlock, stripManagedBlock, hasManagedBlock, extractManagedBlock,
  installHook, uninstallHook, hookStatus,
  installHooks, uninstallHooks, statusHooks,
};
