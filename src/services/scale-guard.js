'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The graceful wall. koragraph runs entirely in a local SQLite file and is tuned for a developer's
// one-to-three repositories; a very large monorepo (a competitor documents heap overflow past ~10k
// files, and an OOM on the Linux kernel) can exceed the memory a laptop process has. The founder's
// rule is that this ceiling must be a legible PITCH, not a crash: measured before the heavy work,
// stated plainly, and never a hard block — the developer can always proceed.
//
// This module is two halves kept apart on purpose: classifyScale() is a pure function over a count
// (unit-tested from a literal), and countIngestFiles() reads the disk (best-effort, never throws).

// File-count bands. `large` is a heads-up (ingest will be slower and use more memory); `enterprise`
// is the pitch. The numbers bracket the competitor's documented ~10k-file failure and the ICP's
// stated 1-3 repos — a solo developer's repositories sit far below `large`.
const SCALE_THRESHOLDS = Object.freeze({ large: 8000, enterprise: 20000 });

function classifyScale({ files = 0 } = {}) {
  if (files >= SCALE_THRESHOLDS.enterprise) {
    return {
      level: 'enterprise',
      message:
        `This looks like an enterprise-scale workload — ${files.toLocaleString()} files in one repository.\n`
        + 'koragraph indexes into a single local SQLite graph and is tuned for a developer\'s one to three\n'
        + 'repositories; a tree this large can exceed the memory a local process has, and the index will be\n'
        + 'slow to build. This is the point the hosted version is for — a server-side graph that holds a\n'
        + 'whole organisation\'s repositories and serves them to every agent, without the local memory limit.\n'
        + 'Indexing will continue; narrow it with a subdirectory path, or a .koragraphignore, if it struggles.',
    };
  }
  if (files >= SCALE_THRESHOLDS.large) {
    return {
      level: 'large',
      message:
        `Large repository — ${files.toLocaleString()} files. The index will take longer and use more memory\n`
        + 'than the usual one-to-three-repo workload; this is well within reach locally, just not instant.',
    };
  }
  return { level: 'ok', message: null };
}

// Best-effort count of the files an ingest will actually read. A git checkout is asked directly
// (tracked + untracked-but-not-ignored — the exact set the walk honours via .gitignore); anything
// else falls back to a bounded directory walk that skips the heavy always-ignored directories. Never
// throws and never blocks meaningfully: on any error it returns null and the caller simply skips the
// scale note rather than failing the ingest over a file count.
function countIngestFiles(repoPath, { limit = 60000 } = {}) {
  try {
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      const out = execFileSync(
        'git', ['-C', repoPath, 'ls-files', '--cached', '--others', '--exclude-standard'],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const n = out.length ? out.split('\n').filter(Boolean).length : 0;
      if (n > 0) return n;
      // Fall through to the walk for a repo with no committed or tracked files yet.
    }
  } catch (_) { /* not a usable git checkout — fall back to the walk */ }
  return walkCount(repoPath, limit);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target',
  '.next', '.cache', '__pycache__', 'vendor', '.gradle', '.idea', '.claude']);

function walkCount(root, limit) {
  let count = 0;
  const stack = [root];
  try {
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
        } else if (e.isFile()) {
          if (++count >= limit) return count;
        }
      }
    }
  } catch (_) { return count || null; }
  return count;
}

module.exports = { SCALE_THRESHOLDS, classifyScale, countIngestFiles };
