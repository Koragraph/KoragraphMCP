'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The diff-writer: reconcile a directory to a desired set of files. It is deliberately stateless —
// it compares desired bytes against on-disk bytes every pass and writes only what differs — so
// there is no incremental bookkeeping to drift out of sync with the store. Writes are atomic
// (tmp + rename) so a reader or a git status mid-pass never sees a half-written file.

// Enumerate the .md files already on disk, relative to root. Only .md is ours to reconcile; any
// other file a user drops in the tree is left untouched.
function existingMarkdown(root, rel = '', acc = []) {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) existingMarkdown(root, childRel, acc);
    else if (e.isFile() && e.name.endsWith('.md')) acc.push(childRel);
  }
  return acc;
}

function writeAtomic(absPath, bytes) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, absPath);
}

// Remove now-empty directories left behind by deletions, walking upward but never above root.
function pruneEmptyDirs(root) {
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name);
    if (rel) {
      try {
        if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
      } catch { /* raced or not empty */ }
    }
  };
  walk('');
}

// Reconcile `outDir` to `files` ({ relpath: bytes }). Returns a tally for the one-line log.
function writeProjection(outDir, files) {
  fs.mkdirSync(outDir, { recursive: true });
  const desired = new Set(Object.keys(files));
  let written = 0;
  let unchanged = 0;
  let deleted = 0;

  for (const rel of desired) {
    const abs = path.join(outDir, rel);
    const next = files[rel];
    let current = null;
    try {
      current = fs.readFileSync(abs, 'utf8');
    } catch { /* absent */ }
    if (current === next) {
      unchanged += 1;
      continue;
    }
    writeAtomic(abs, next);
    written += 1;
  }

  for (const rel of existingMarkdown(outDir)) {
    if (desired.has(rel)) continue;
    try {
      fs.unlinkSync(path.join(outDir, rel));
      deleted += 1;
    } catch { /* raced */ }
  }

  if (deleted) pruneEmptyDirs(outDir);
  return { written, unchanged, deleted };
}

module.exports = { writeProjection, existingMarkdown };
