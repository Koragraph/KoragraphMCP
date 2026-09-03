'use strict';

// A digest of what was learned, the cheapest way to catch a bad rule early. What makes it cheap is
// that it is pure SQL over practice.db: no graph, no resolution, no model. It is the same read the
// CLI and the delivery side both need, so it lives here rather than in either.

let recallFor = null;
try { ({ recallFor } = require('./recall')); } catch { /* recall may not be loadable in every context */ }

const { neutralise } = require('./untrusted');

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 20;

const LEARNED_SQL = `
SELECT f.id AS fact_id, f.kind, f.tier, f.body, f.evidence, f.recurrence, f.source,
       f.created_at, f.valid_at
  FROM facts f
 WHERE f.expired_at IS NULL
   AND f.tier != 'hypothesis'
   AND f.created_at >= @since
 ORDER BY f.recurrence DESC, f.created_at DESC, f.id DESC
 LIMIT @limit`;

const EXPIRED_SQL = `
SELECT f.id AS fact_id, f.kind, f.tier, f.body, f.expiry_reason, f.expiry_note, f.expired_at
  FROM facts f
 WHERE f.expired_at IS NOT NULL
   AND f.tier != 'hypothesis'
   AND f.expired_at >= @since
 ORDER BY f.expired_at DESC, f.id DESC
 LIMIT @limit`;

const ANCHORS_SQL = `SELECT repo_id, file_path, symbol_name, symbol_owner, symbol_kind, grain,
                            renamed_from
                       FROM anchors WHERE fact_id = ? ORDER BY file_path, symbol_name`;

// Evidence is opaque JSON by design — the promoter owns its shape and it differs between a
// fail-fix lesson and a history seed. Everything a reader needs to CHECK the fact is pulled out
// here and nothing else is: a fact the user cannot check is a fact the user cannot correct.
function provenanceOf(row) {
  let e = {};
  try { e = JSON.parse(row.evidence || '{}') || {}; } catch { e = {}; }
  const commits = [];
  if (e.commit) commits.push(e.commit);
  for (const c of Array.isArray(e.commits) ? e.commits : []) {
    commits.push(typeof c === 'string' ? c : (c && (c.sha || c.commit)) || '');
  }
  return {
    when: (row.valid_at || e.passed_at || e.failed_at || row.created_at || '').slice(0, 19).replace('T', ' '),
    cmd: oneLine(e.cmd),
    error: oneLine(e.err_excerpt, 400),
    commits: commits.filter(Boolean),
    session_id: e.session_id || null,
    agent_id: e.agent_id || null,
    recurrence: e.recurrence || row.recurrence || 1,
  };
}

// Agents do not run `npm test`, they run a new heredoc every time, so provenance commands can be
// hundreds of lines long. Rendered whole, one fact buries the rest and costs more tokens than the
// lesson saves. The full command stays in `evidence`; sqlite3 will print it in full.
const CMD_CHARS = 120;

// Everything that reaches this renderer is recorded text — a commit subject, stderr, a shell
// command. The digest is printed to a terminal and pasted into bug reports, so it gets the same
// treatment every other reader surface gets: no ANSI repaint, no forged tag, no credential.
function oneLine(text, max = CMD_CHARS) {
  if (!text) return null;
  return neutralise(text, max) || null;
}

function tally(rows, field) {
  const out = {};
  for (const r of rows) {
    const k = r[field] == null ? '(none)' : String(r[field]);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function eventCounts(db) {
  if (!tableExists(db, 'events')) return { captured: 0, harvested: 0, unharvested: 0 };
  const captured = db.prepare('SELECT count(*) c FROM events').get().c;
  const hasHarvested = db.prepare('PRAGMA table_info(events)').all()
    .some((c) => c.name === 'harvested_at');
  if (!hasHarvested) return { captured, harvested: null, unharvested: null };
  const harvested = db.prepare('SELECT count(*) c FROM events WHERE harvested_at IS NOT NULL').get().c;
  return { captured, harvested, unharvested: captured - harvested };
}

// How many of these facts a reader would actually be shown right now. Alive but unreachable is
// dead weight, and it is a different number from "not expired" — worth separating, and null rather
// than 0 when we have no way to ask, because unknown is not zero.
function reachableCount(practiceDb, facts) {
  if (!recallFor) return null;
  let n = 0;
  for (const f of facts) {
    const a = (f.anchors || [])[0];
    if (!a) continue;
    try {
      const hits = recallFor(practiceDb, {
        repoId: a.repo_id, filePath: a.file_path, symbolName: a.symbol_name, limit: 50,
      }) || [];
      if (hits.some((h) => h.fact_id === f.fact_id)) n++;
    } catch { /* a delivery-side failure must not break the digest */ }
  }
  return n;
}

function digest(practiceDb, { since = null, days = DEFAULT_DAYS, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const from = since || new Date(now.getTime() - days * 86400000).toISOString();
  const anchorsOf = practiceDb.prepare(ANCHORS_SQL);

  const learned = practiceDb.prepare(LEARNED_SQL).all({ since: from, limit }).map((r) => ({
    fact_id: r.fact_id,
    kind: r.kind,
    tier: r.tier,
    body: r.body,
    recurrence: r.recurrence,
    source: r.source,
    created_at: r.created_at,
    anchors: anchorsOf.all(r.fact_id),
    provenance: provenanceOf(r),
  }));

  const expired = practiceDb.prepare(EXPIRED_SQL).all({ since: from, limit });

  const live = practiceDb.prepare(
    'SELECT kind, tier, recurrence FROM facts WHERE expired_at IS NULL',
  ).all();
  const dead = practiceDb.prepare(
    'SELECT expiry_reason FROM facts WHERE expired_at IS NOT NULL',
  ).all();

  return {
    window: { since: from, until: now.toISOString() },
    counts: {
      live: live.length,
      learned_in_window: learned.length,
      expired_in_window: expired.length,
      by_kind: tally(live, 'kind'),
      by_tier: tally(live, 'tier'),
      by_expiry_reason: tally(dead, 'expiry_reason'),
      recurring: live.filter((f) => (f.recurrence || 1) > 1).length,
    },
    learned,
    expired,
    events: eventCounts(practiceDb),
    reachable: reachableCount(practiceDb, learned),
  };
}

function anchorLabel(a) {
  if (!a) return '(no anchor)';
  return a.symbol_name ? `${a.file_path}:${a.symbol_name}` : a.file_path;
}

// The tier gate lives in BOTH queries above, not only in the loop below. A renderer-only `continue`
// filters the TEXT while `digest()` still returns full hypothesis bodies in its structured
// `learned` array, and the Expired block would have no tier filter at all — so `practice digest`
// would print a hypothesis body verbatim. Filtering at the source makes it structural rather than
// careful, which is the whole point of the tier ladder. Never a hypothesis in rendered output:
// a hypothesis that has not predicted correctly three times cannot reach a reader, so a wrong one
// costs nothing.
function renderDigest(d) {
  const lines = [];
  lines.push(`Since ${d.window.since.slice(0, 10)}: ${d.counts.learned_in_window} learned, `
    + `${d.counts.expired_in_window} expired. ${d.counts.live} fact(s) live.`);

  const ev = d.events;
  lines.push(`Events: ${ev.captured} captured`
    + (ev.harvested === null ? '' : `, ${ev.harvested} harvested, ${ev.unharvested} not yet`));

  if (!d.learned.length && !d.expired.length) {
    lines.push('');
    lines.push('Nothing was learned in this window. That is an answer, not a failure — the layer');
    lines.push('records a lesson only when a failure was followed by a fix, which is rare.');
    return lines.join('\n');
  }

  if (d.learned.length) {
    lines.push('');
    lines.push('Learned:');
    for (const f of d.learned) {
      if (f.tier === 'hypothesis') continue;
      const p = f.provenance;
      const seen = f.recurrence > 1 ? `  (seen ${f.recurrence}×)` : '';
      lines.push(`  [p#${f.fact_id}] ${f.kind}/${f.tier}${seen}  ${anchorLabel(f.anchors[0])}`);
      lines.push(`      ${oneLine(f.body, 200)}`);
      const why = [];
      if (p.cmd) why.push(`cmd \`${p.cmd}\``);
      if (p.error) why.push(`error "${oneLine(p.error, 80)}"`);
      if (p.commits.length) why.push(`commit ${p.commits.slice(0, 3).map((c) => c.slice(0, 8)).join(', ')}`);
      if (p.when) why.push(p.when);
      if (why.length) lines.push(`      ${why.join(' · ')}`);
    }
  }

  if (d.expired.length) {
    lines.push('');
    lines.push('Expired:');
    for (const f of d.expired) {
      lines.push(`  [p#${f.fact_id}] ${f.expiry_reason}${f.expiry_note ? ` (${f.expiry_note})` : ''}`
        + `  ${oneLine(f.body, 70)}`);
    }
  }

  if (d.reachable !== null) {
    lines.push('');
    lines.push(`${d.reachable} of ${d.learned.length} would be surfaced by the recall path right now.`);
  }
  return lines.join('\n');
}

// A headline number, not a listing: what a `CLAUDE.md`/`AGENTS.md` import (or any stated rule)
// actually cost, in a shape a reader can screenshot. Three counts over AUTHORED facts only —
// `evidence.authored` — because this is the corpus a stale instruction file produces, not the
// mined fail-fix/seed planes:
//   total     — every authored rule this store has ever held, live or not.
//   unanchored — currently stored at hypothesis because the referent named at creation was
//                already gone: a rule about code that does not exist, right now.
//   went_stale — was anchored and TRUE when stated, then expired 'orphaned'/'drifted' later: a
//                rule that kept asserting something once true, silently, until this layer noticed.
// `longest_stale` is the single sharpest fact in `went_stale`: the one whose gap between
// created_at and expired_at is largest — "this has been wrong for N days and nobody caught it".
// Pure SQL over practice.db, same contract as digest() above: no graph, no resolution, no model.
function auditSummary(practiceDb) {
  const total = practiceDb.prepare(
    `SELECT count(*) c FROM facts WHERE json_extract(evidence, '$.authored') = 1`,
  ).get().c;

  const unanchored = practiceDb.prepare(
    `SELECT count(*) c FROM facts
      WHERE json_extract(evidence, '$.authored') = 1
        AND expired_at IS NULL
        AND tier = 'hypothesis'
        AND json_extract(evidence, '$.missing') IS NOT NULL`,
  ).get().c;

  const wentStale = practiceDb.prepare(
    `SELECT count(*) c FROM facts
      WHERE json_extract(evidence, '$.authored') = 1
        AND expired_at IS NOT NULL
        AND expiry_reason IN ('orphaned', 'drifted')
        AND json_extract(evidence, '$.missing') IS NULL`,
  ).get().c;

  const longestRow = practiceDb.prepare(
    `SELECT f.id AS fact_id, f.body, f.expiry_reason, f.created_at, f.expired_at,
            CAST(julianday(f.expired_at) - julianday(f.created_at) AS INTEGER) AS days,
            a.repo_id, a.file_path, a.symbol_name
       FROM facts f
       LEFT JOIN anchors a ON a.fact_id = f.id
      WHERE json_extract(f.evidence, '$.authored') = 1
        AND f.expired_at IS NOT NULL
        AND f.expiry_reason IN ('orphaned', 'drifted')
        AND json_extract(f.evidence, '$.missing') IS NULL
      ORDER BY days DESC
      LIMIT 1`,
  ).get() || null;

  return {
    total, unanchored, went_stale: wentStale,
    longest_stale: longestRow ? {
      fact_id: longestRow.fact_id,
      body: longestRow.body,
      days: longestRow.days,
      reason: longestRow.expiry_reason,
      file_path: longestRow.file_path || null,
      symbol_name: longestRow.symbol_name || null,
    } : null,
  };
}

function renderAudit(a) {
  if (a.total === 0) {
    return 'No authored rules yet — nothing stated via remember, /korainit, or the correction channel.';
  }
  const lines = [`${a.total} authored rule(s) in koramemory.`];
  lines.push(a.unanchored > 0
    ? `${a.unanchored} already reference code that's gone — stored, never delivered.`
    : '0 currently reference code that\'s gone.');
  if (a.went_stale > 0) {
    lines.push(`${a.went_stale} were true when stated and later went stale on their own — caught, not guessed.`);
  }
  if (a.longest_stale) {
    const where = a.longest_stale.symbol_name
      ? `${a.longest_stale.symbol_name}${a.longest_stale.file_path ? ` (${a.longest_stale.file_path})` : ''}`
      : a.longest_stale.file_path || 'a repo-wide rule';
    lines.push(`The oldest: "${oneLine(a.longest_stale.body, 90)}" — about ${where} — sat ${a.longest_stale.reason}`
      + ` for ${a.longest_stale.days} day(s) before anyone caught it.`);
  }
  return lines.join('\n');
}

module.exports = {
  digest, renderDigest, provenanceOf, anchorLabel, eventCounts, oneLine,
  auditSummary, renderAudit,
  DEFAULT_DAYS, DEFAULT_LIMIT,
};
