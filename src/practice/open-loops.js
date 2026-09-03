'use strict';

const fs = require('fs');
const path = require('path');

const { neutralise } = require('./untrusted');
const { repoIdentity } = require('./repo-identity');
const { relevanceBoost, distinctiveTokens } = require('./relevance');

// Sticky notes / open loops. A note the developer leaves for a future session — an item that is
// open until the WORK is done, not until time passes. See 012_open_loops.sql for why this is a
// separate table and not a `facts` kind.
//
// This module opens practice.db only — never graph.db — so it is safe on the UserPromptSubmit hook
// path, where surfacing happens. It anchors to no code, so it needs no graph resolution at all.

const MAX_BODY = 400;
const MIN_BODY = 8;

const RESOLVED_REASONS = Object.freeze(['agent', 'condition', 'user']);

// Content words only, order-preserving-irrelevant: two statements of the same loop reduce to the
// same key so the dedupe index collapses them. Deliberately EXACT on the reduced form rather than a
// fuzzy Jaccard — "still need npx" restated is one loop, but "sort npx packaging" and "publish npx
// to the registry" are two, and a similarity threshold that merged them would silently drop a real
// open item. Exact-normalised only ever coalesces a true restatement.
function normalise(body) {
  return String(body || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function repoFor(cwd, repoIdOverride) {
  if (repoIdOverride) return { repoId: repoIdOverride, repoRoot: null };
  const { repoId, repoRoot } = repoIdentity(cwd);
  return { repoId, repoRoot };
}

// Open a loop, or coalesce onto an identical open one. The upsert targets the partial unique index
// (repo, norm) WHERE resolved_at IS NULL, so a restatement bumps `mentions` and touches
// `updated_at` on the SAME row instead of inserting a second — atomic, so two sessions racing to
// state the same loop cannot both win.
function openLoop(db, {
  body: rawBody, cwd = process.cwd(), repoId: repoIdOverride = null,
  sessionId = null, source = 'user', now = new Date(),
} = {}) {
  const body = neutralise(rawBody, MAX_BODY);
  if (body.length < MIN_BODY) {
    return { status: 'rejected', reason: 'body too short to be a useful open loop', id: null, open_loop: true };
  }
  const { repoId } = repoFor(cwd, repoIdOverride);
  if (!repoId) return { status: 'rejected', reason: 'not inside a git repository', id: null, open_loop: true };
  const norm = normalise(body);
  if (!norm) return { status: 'rejected', reason: 'open loop has no content to remember', id: null, open_loop: true };

  const ts = now.toISOString();
  const row = db.prepare(
    `INSERT INTO open_loops (repo_id, body, norm, source, session_id, mentions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (repo_id, norm) WHERE resolved_at IS NULL
       DO UPDATE SET mentions = mentions + 1, updated_at = excluded.updated_at
     RETURNING id, mentions`,
  ).get(repoId, body, norm, source, sessionId, ts, ts);

  return {
    status: row.mentions > 1 ? 'coalesced' : 'opened',
    id: row.id,
    mentions: row.mentions,
    repo_id: repoId,
    body,
    open_loop: true,
  };
}

// Resolve by id (precise) or by body (the agent closing a loop it just surfaced restates it). Both
// only touch a row that is still open, and both are idempotent: closing an already-closed or
// non-existent loop is a no-op with status 'noop', never an error — a missed close self-heals by
// resurfacing, and a double close must not throw.
function resolveLoop(db, {
  id = null, body = null, cwd = process.cwd(), repoId: repoIdOverride = null,
  reason = 'user', now = new Date(),
} = {}) {
  const resolvedReason = RESOLVED_REASONS.includes(reason) ? reason : 'user';
  const ts = now.toISOString();

  let row = null;
  if (id != null && Number.isFinite(Number(id))) {
    row = db.prepare(
      'UPDATE open_loops SET resolved_at = ?, resolved_reason = ? WHERE id = ? AND resolved_at IS NULL RETURNING id, body',
    ).get(ts, resolvedReason, Number(id));
  } else if (body != null && String(body).trim()) {
    const { repoId } = repoFor(cwd, repoIdOverride);
    if (!repoId) return { status: 'noop', id: null, open_loop: true, reason: 'not inside a git repository' };
    const norm = normalise(neutralise(body, MAX_BODY));
    row = db.prepare(
      'UPDATE open_loops SET resolved_at = ?, resolved_reason = ? WHERE repo_id = ? AND norm = ? AND resolved_at IS NULL RETURNING id, body',
    ).get(ts, resolvedReason, repoId, norm);
  }

  if (!row) return { status: 'noop', id: id != null ? Number(id) : null, open_loop: true };
  return { status: 'resolved', id: row.id, body: row.body, resolved_reason: resolvedReason, open_loop: true };
}

function listOpen(db, { repoId = null, cwd = process.cwd(), limit = 50 } = {}) {
  const rid = repoId || repoFor(cwd, null).repoId;
  if (!rid) return [];
  return db.prepare(
    `SELECT id, body, norm, mentions, source, created_at, updated_at
       FROM open_loops
      WHERE repo_id = ? AND resolved_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  ).all(rid, Math.max(1, limit));
}

function listResolved(db, { repoId = null, cwd = process.cwd(), limit = 50 } = {}) {
  const rid = repoId || repoFor(cwd, null).repoId;
  if (!rid) return [];
  return db.prepare(
    `SELECT id, body, resolved_at, resolved_reason
       FROM open_loops
      WHERE repo_id = ? AND resolved_at IS NOT NULL
      ORDER BY resolved_at DESC, id DESC
      LIMIT ?`,
  ).all(rid, Math.max(1, limit));
}

// Which open loops matter for THIS prompt. Same relevance signal as the rulebook (relevance.js):
// zero-token keyword overlap, distinctive-token aware so a single rare shared word counts. A loop
// that shares nothing topical with the prompt is silent — an open loop is a reminder, and a
// reminder that fires on every unrelated turn is noise the reader learns to ignore.
//
// When the prompt itself names nothing (empty/whitespace), returns [] — silence, not a dump.
function surface(db, {
  prompt = '', repoId = null, cwd = process.cwd(), limit = 3,
} = {}) {
  const open = listOpen(db, { repoId, cwd, limit: 200 });
  if (!open.length) return [];
  if (!String(prompt || '').trim()) return [];

  const distinctive = distinctiveTokens(open.map((l) => l.body));
  const scored = [];
  for (const loop of open) {
    const boost = relevanceBoost(prompt, loop.body, { distinctive });
    if (boost > 0) scored.push({ loop, boost });
  }
  scored.sort((a, b) => (b.boost - a.boost)
    || String(b.loop.created_at || '').localeCompare(String(a.loop.created_at || ''))
    || b.loop.id - a.loop.id);
  return scored.slice(0, Math.max(1, limit)).map((s) => s.loop);
}

// The checkable backstop, narrow and honest. Only ONE class of open loop is machine-checkable
// without a model: "still need to add / create / write <path>" closes the moment that path exists
// on disk. A human who quietly did the work — no agent ever saw the loop — has it crossed off
// anyway. It fires ONLY on that exact shape (a create-verb AND a repo-relative path that now
// exists), because a false auto-close silently discards a real open item, which is worse than
// leaving it open for the agent to judge. Every other loop is left for the agent.
const CREATE_VERB = /\b(?:add|creat\w*|writ\w*|mak\w*|generat\w*|set up|scaffold)\b/i;
const PATHLIKE = /\b[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,6}\b|\b[\w-]+\.[A-Za-z]{1,6}\b/g;
// A path that is the object of a locating/reference preposition names an EXISTING file the work
// touches, not the file to be created: "add rate limiting TO server.js", "write tests (SEE notes.md)".
// Its existence proves nothing about the task, so it must not satisfy the create-shape.
const PREP_BEFORE = /\b(?:to|in|into|onto|from|see|at|on|within|inside|under|of|for|via|using|beside|alongside|reference|references?|ref|refs)\s+$/i;

function checkableClose(db, { repoId = null, cwd = process.cwd(), now = new Date() } = {}) {
  const { repoId: rid, repoRoot } = repoFor(cwd, repoId);
  if (!rid) return { closed: [] };
  const root = repoRoot || (repoId ? null : repoIdentity(cwd).repoRoot);
  if (!root) return { closed: [] };

  const closed = [];
  for (const loop of listOpen(db, { repoId: rid, cwd, limit: 200 })) {
    if (!CREATE_VERB.test(loop.body)) continue;
    const body = String(loop.body);
    const re = new RegExp(PATHLIKE.source, 'gi');
    let satisfied = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const before = body.slice(0, m.index);
      // The path must be GOVERNED by a create verb appearing before it, and must not be the object
      // of a locating/reference preposition — otherwise a task about an existing file auto-closes.
      if (!CREATE_VERB.test(before)) continue;
      if (PREP_BEFORE.test(before)) continue;
      const abs = path.resolve(root, m[0]);
      // Confine to the checkout: a body naming /etc/passwd must not consult it.
      if (!abs.startsWith(path.resolve(root) + path.sep)) continue;
      try { if (fs.existsSync(abs)) { satisfied = true; break; } } catch { /* unreadable — not satisfied */ }
    }
    if (satisfied) {
      const r = resolveLoop(db, { id: loop.id, reason: 'condition', now });
      if (r.status === 'resolved') closed.push({ id: loop.id, body: loop.body });
    }
  }
  return { closed };
}

// The delivery-side lookup: which open loop, if any, is anchored to this exact node.
// Mirrors annotationFrom's shape so tool-handlers.js can treat it the same way. Lives here, not in
// loop-anchors.js, because THIS is a pure read against practice.db alone — loop-anchors.js requires
// resolve.js/revalidate.js for its rename-following mechanics, and this lookup is reached from
// recall.js's note slot, which the UserPromptSubmit hook path must never pull graph.db into, even
// lazily (see loop-anchors.js's own note on why laziness alone does not satisfy the hook-safety
// tests, which walk every `require(...)` in a file's text regardless of position).
const AT_NODE = `
SELECT l.id, l.body, l.mentions, l.created_at
  FROM loop_anchors la JOIN open_loops l ON l.id = la.loop_id
 WHERE l.resolved_at IS NULL AND la.repo_id = ? AND la.file_path = ?
   AND ((? IS NULL AND la.symbol_name IS NULL AND la.grain = 'file')
        OR la.symbol_name = ?)
 ORDER BY l.created_at DESC, l.id DESC`;

function loopsAtNode(db, { repoId, filePath, symbolName = null }) {
  if (!repoId || !filePath) return [];
  try {
    return db.prepare(AT_NODE).all(repoId, filePath, symbolName, symbolName);
  } catch { return []; }
}

module.exports = {
  openLoop, resolveLoop, listOpen, listResolved, surface, checkableClose, normalise, loopsAtNode,
  MAX_BODY, MIN_BODY, RESOLVED_REASONS,
};
