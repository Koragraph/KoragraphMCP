'use strict';

const fs = require('fs');
const path = require('path');

const { resolveBranch, resolveFileId, resolveSymbols, anchorable } = require('./resolve');
const { repoNameOf } = require('./repo-identity');
const { fingerprint, sketch } = require('./fingerprint');

// A lesson from fail-fix.js becomes a fact plus its anchors. This is where the two graphs meet,
// and it is the ONLY step that needs both open at once.
//
// Tier is `observation`: a mechanical fact with provenance. Never `law` — nobody stated it
// — and never `hypothesis`, because nothing was inferred; the failure output is the reason and the
// second edit is the answer.

const MAX_EVIDENCE_LINES = 60;

// The vocabulary lives in 001_init.sql's CHECK; these mirror it so a bad value fails at the call
// site with the offending string in the message, not as an opaque SQLITE_CONSTRAINT three frames
// down. `resolution/tiers.js:242-248` is the precedent: an unmapped enum THROWS, it never defaults.
// `kind` absent is not unmapped — fail-fix.js emits no kind and means 'correction'.
const FACT_KINDS = Object.freeze(['correction', 'law', 'ritual', 'revert', 'hazard', 'tombstone']);
const FACT_TIERS = Object.freeze(['law', 'observation', 'hypothesis']);
const FACT_SOURCES = Object.freeze(['harvest', 'seed', 'hook', 'user', 'import']);

function checked(value, allowed, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) {
    throw new Error(`practice: unknown fact ${field} "${value}" (expected one of ${allowed.join(', ')})`);
  }
  return value;
}

// A target from fail-fix.js carries patch hunks; one from a git-history seed carries a line range
// and no hunks at all. Both are legitimate and neither may crash the other's path.
function hunksOf(call) {
  return call && Array.isArray(call.hunks) ? call.hunks : [];
}

function readSpan(absPath, startLine, endLine) {
  let text;
  try { text = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  if (startLine < 1 || startLine > lines.length) return null;
  return lines.slice(startLine - 1, Math.min(endLine, lines.length));
}

// The absolute path at capture time, which the recorder stored, in preference to reconstructing it
// from the graph's `repositories.full_path` — that column records where the repo was when it was
// ingested, which is not necessarily where it is now.
function absPathFor(target, repoRoot) {
  // An authored fact has no edit behind it and therefore no hunk carrying a path, but the caller
  // knows the checkout it is standing in — which is better than `repositories.full_path`, whose
  // value is where the repo was when it was ingested.
  if (target.abs_path) return target.abs_path;
  for (const hunk of hunksOf(target.fix)) {
    if (!hunk.payload) continue;
    try {
      const p = JSON.parse(hunk.payload).abs_path;
      if (p) return p;
    } catch { /* a trimmed payload is not a failure */ }
  }
  return repoRoot ? path.join(repoRoot, target.file_path) : null;
}

// The fix's range in POST-edit coordinates. Resolving it against oldStart would point at the
// pre-edit content, not the fix.
function fixRange(target) {
  let start = null;
  let end = null;
  for (const h of hunksOf(target.fix)) {
    if (h.new_start == null) continue;
    const s = h.new_start;
    const e = h.new_start + Math.max(1, h.new_lines || 1) - 1;
    if (start === null || s < start) start = s;
    if (end === null || e > end) end = e;
  }
  if (start === null && target.start_line != null) {
    start = target.start_line;
    end = target.end_line != null ? target.end_line : target.start_line;
  }
  return { start, end };
}

function hunkPayload(call) {
  if (!call) return null;
  const out = [];
  for (const h of hunksOf(call)) {
    if (!h.payload) continue;
    try {
      const p = JSON.parse(h.payload);
      out.push({
        old_start: h.old_start, new_start: h.new_start,
        old: (p.old || []).slice(0, MAX_EVIDENCE_LINES),
        new: (p.new || []).slice(0, MAX_EVIDENCE_LINES),
      });
    } catch { /* skip */ }
  }
  return out.length ? out : null;
}

// One anchor per resolved symbol, or a single file-grain anchor when the edit landed outside every
// declaration — the majority case at 46.8% declaration line-coverage, and the reason a file-grain
// anchor is a coordinate rather than a node reference (`requests` has zero FILE nodes).
function anchorsFor(target, { graphDb, branch }) {
  const repoId = target.repo_id;

  // A rule the developer states about the whole repository ("never `git add -A` here") names no
  // file. Before 009 it produced no anchor and promoteLessons dropped the lesson, so the entire
  // class of stated laws was silently unstorable.
  if (target.grain === 'repo') {
    return [{
      repo_id: repoId, file_path: '', symbol_name: null, symbol_owner: null,
      symbol_kind: null, grain: 'repo', body_fingerprint: null, body_sketch: null,
    }];
  }

  const fileGrain = [{
    repo_id: repoId, file_path: target.file_path, symbol_name: null, symbol_owner: null,
    symbol_kind: null, grain: 'file', body_fingerprint: null, body_sketch: null,
  }];

  if (!branch) return fileGrain;
  const fileId = resolveFileId(graphDb, branch.branchId, target.file_path);
  if (!fileId) return fileGrain;

  // A target that names its node was resolved by NAME (remember --symbol), and that node is the
  // anchor — one anchor, the stated one. The line-range resolution below exists for edit hunks,
  // where nobody named anything and innermost-wins is the honest guess. Running a named class
  // through it anchored to the methods inside the class instead.
  if (target.named_node && target.named_node.name) {
    const n = target.named_node;
    const abs = absPathFor(target, branch.repoRoot);
    const body = abs ? readSpan(abs, n.start_line, n.end_line) : null;
    return [{
      repo_id: repoId,
      file_path: target.file_path,
      symbol_name: n.name,
      symbol_owner: n.owner || null,
      symbol_kind: n.node_type || null,
      grain: 'symbol',
      body_fingerprint: body ? fingerprint(body) : null,
      body_sketch: body ? JSON.stringify(sketch(body)) : null,
    }];
  }

  const { start, end } = fixRange(target);
  if (start === null) return fileGrain;

  const resolved = anchorable(resolveSymbols(graphDb, {
    branchId: branch.branchId, fileId, startLine: start, endLine: end,
  }));
  if (!resolved.length) return fileGrain;

  const abs = absPathFor(target, branch.repoRoot);
  return resolved.map((n) => {
    const body = abs ? readSpan(abs, n.start_line, n.end_line) : null;
    return {
      repo_id: repoId,
      file_path: target.file_path,
      symbol_name: n.name,
      symbol_owner: n.owner,
      symbol_kind: n.node_type,
      grain: 'symbol',
      // Both signatures, because they answer different questions: the fingerprint detects drift,
      // the sketch survives a rename (fingerprint.js).
      body_fingerprint: body ? fingerprint(body) : null,
      body_sketch: body ? JSON.stringify(sketch(body)) : null,
    };
  });
}

const INSERT_FACT = `INSERT INTO facts (kind, tier, body, evidence, valid_at, created_at, recurrence,
                                        source, weight, weight_reasons)
                     VALUES (@kind, @tier, @body, @evidence, @valid_at, @created_at, @recurrence,
                             @source, @weight, @weight_reasons)`;

const INSERT_ANCHOR = `INSERT OR IGNORE INTO anchors
  (fact_id, repo_id, file_path, symbol_name, symbol_owner, symbol_kind,
   body_fingerprint, body_sketch, hunk_fingerprint, grain)
  VALUES (@fact_id, @repo_id, @file_path, @symbol_name, @symbol_owner, @symbol_kind,
          @body_fingerprint, @body_sketch, @hunk_fingerprint, @grain)`;

function promoteLessons(practiceDb, graphDb, lessons, { now = new Date(), source = null } = {}) {
  const insertFact = practiceDb.prepare(INSERT_FACT);
  const insertAnchor = practiceDb.prepare(INSERT_ANCHOR);
  const branchCache = new Map();
  const created = [];

  const write = practiceDb.transaction((batch) => {
    for (const lesson of batch) {
      const anchors = [];
      for (const target of lesson.targets) {
        let branch = branchCache.get(target.repo_id);
        if (branch === undefined) {
          // `repo_root`, when a caller has it (seed.js), lets `resolveBranch` match on
          // `repositories.full_path` (the actual ingest path — a monorepo subdirectory, not
          // necessarily this repo_id's own basename) instead of falling back to a name comparison
          // that is wrong whenever the ingest root differs from the local identity's basename.
          branch = graphDb
            ? resolveBranch(graphDb, {
              repoId: target.repo_id, repoName: repoNameOf(target.repo_id), repoRoot: target.repo_root,
            })
            : null;
          branchCache.set(target.repo_id, branch);
        }
        const hunkFp = hunksOf(target.fix).map((h) => h.new_fingerprint).filter(Boolean)[0] || null;
        for (const a of anchorsFor(target, { graphDb, branch })) {
          anchors.push({ ...a, hunk_fingerprint: hunkFp });
        }
      }
      if (!anchors.length) continue;

      const recurrence = Number.isInteger(lesson.recurrence) && lesson.recurrence > 0
        ? lesson.recurrence : 1;

      const evidence = {
        cmd: lesson.cmd,
        err_excerpt: lesson.err_excerpt,
        session_id: lesson.session_id,
        agent_id: lesson.agent_id,
        failed_at: lesson.failed_at,
        passed_at: lesson.passed_at,
        recurrence,
        tool_use_ids: [...new Set(lesson.targets.flatMap(
          (t) => [t.attempt, t.fix].filter(Boolean).map((c) => c.tool_use_id),
        ))],
        targets: lesson.targets.map((t) => ({
          file_path: t.file_path,
          attempt: hunkPayload(t.attempt),
          fix: hunkPayload(t.fix),
        })),
        // A history seed has no failing command and no patch hunks; its provenance is a list of
        // commits. Merged last so the producer's own keys win over the fail-fix-shaped nulls above.
        ...(lesson.evidence && typeof lesson.evidence === 'object' ? lesson.evidence : {}),
      };

      const factId = insertFact.run({
        kind: checked(lesson.kind, FACT_KINDS, 'correction', 'kind'),
        tier: checked(lesson.tier, FACT_TIERS, 'observation', 'tier'),
        body: lesson.body || '',
        evidence: JSON.stringify(evidence),
        // World time: when this became true of the code. `created_at` is system time — when we
        // learned it. They move independently.
        valid_at: lesson.passed_at || null,
        created_at: now.toISOString(),
        recurrence,
        source: checked(lesson.source || source, FACT_SOURCES, null, 'source'),
        // NULL, not 0, when the producer measured nothing. A git-history seed has no session, no
        // turns and no abandoned attempt; scoring it 0 would suppress the entire cold-start plane
        // on absence of evidence, which is the same mistake as expiring an anchor we could not
        // check. Readers COALESCE a NULL to the threshold, so unmeasured passes and cheap does not.
        weight: Number.isFinite(lesson.weight) ? lesson.weight : null,
        weight_reasons: Array.isArray(lesson.weight_reasons) && lesson.weight_reasons.length
          ? JSON.stringify(lesson.weight_reasons) : null,
      }).lastInsertRowid;

      for (const a of anchors) insertAnchor.run({ fact_id: factId, ...a });
      created.push(factId);
    }
  });

  write(lessons);
  return { factIds: created };
}

// Facts promoted before `weight` existed carry NULL, which readers treat as unmeasured and let
// through — correct as a default and wrong for these, because their events are still in the store
// and CAN be measured. Replays the whole event log and matches on `harvested_lessons.lesson_key`,
// the identity harvesting already keys on, so nothing is guessed positionally. A lesson the replay
// no longer produces stays NULL rather than being scored from a different lesson's evidence.
function backfillWeights(practiceDb, { events = null } = {}) {
  const pending = practiceDb
    .prepare('SELECT count(*) c FROM facts WHERE weight IS NULL AND expired_at IS NULL').get().c;
  if (!pending) return { candidates: 0, matched: 0, updated: 0 };

  const { runFailFix } = require('./fail-fix');
  const { lessonKey } = require('./harvest');
  const rows = events || practiceDb.prepare('SELECT * FROM events ORDER BY ts, id').all();
  const lessons = runFailFix(rows);

  const factOf = practiceDb.prepare('SELECT fact_id FROM harvested_lessons WHERE lesson_key = ?');
  const update = practiceDb.prepare(
    'UPDATE facts SET weight = ?, weight_reasons = ? WHERE id = ? AND weight IS NULL',
  );

  let matched = 0;
  let updated = 0;
  practiceDb.transaction(() => {
    for (const lesson of lessons) {
      const row = factOf.get(lessonKey(lesson));
      if (!row || !row.fact_id) continue;
      matched++;
      const reasons = lesson.weight_reasons && lesson.weight_reasons.length
        ? JSON.stringify(lesson.weight_reasons) : null;
      updated += update.run(lesson.weight, reasons, row.fact_id).changes;
    }
  })();
  return { candidates: pending, matched, updated };
}

module.exports = {
  promoteLessons, backfillWeights, anchorsFor, fixRange, readSpan, absPathFor,
  FACT_KINDS, FACT_TIERS, FACT_SOURCES,
};
