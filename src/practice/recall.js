'use strict';

const { openPracticeDb } = require('./db');
const { neutralise, safePath } = require('./untrusted');
const { SURFACE_THRESHOLD } = require('./fail-fix');

// The read API for the practice layer. Everything that shows a fact to a human or to an agent
// comes through here: the MCP `recall` tool, the MCP annotation, the UserPromptSubmit brief, and
// the digest.
//
// Three properties are load-bearing and are the reason this is one module rather than a query at
// each call site:
//   * A hypothesis can never reach a reader. It is filtered in SQL, not by a caller remembering.
//   * An expired fact can never reach a reader — in system time (expired_at) and in world time
//     (invalid_at), which move independently.
//   * Every returned fact carries a fact_id, so a reader can kill it with `practice why`.
//   * Nothing leaves here carrying text as it was written. A body is a commit subject, a detail is
//     stderr, a cmd is whatever was typed — all attacker-influenceable in any repository the user
//     indexes, and all injected straight into a reader's context. untrusted.js neutralises them
//     HERE rather than at each renderer, because a renderer added later would not know to.
//
// It opens practice.db and NOTHING else. graph.db is off-limits here because this module runs on
// the UserPromptSubmit hook path, where better-sqlite3's synchronous busy wait would stall the
// editor for the length of an ingest.

const DEFAULT_LIMIT = 5;
const DEFAULT_BUDGET_CHARS = 600;

const TIER_RANK = Object.freeze({ law: 0, observation: 1 });

// Which kinds of fact a task is likely to need. A tiebreak only — it never reorders across tiers
// and never filters, because a wrong guess about the task must not hide a law.
const TASK_AFFINITY = Object.freeze({
  bugfix: { correction: 3, revert: 2, hazard: 2, law: 1, ritual: 0 },
  refactor: { hazard: 3, law: 2, revert: 1, correction: 1, ritual: 0 },
  feature: { law: 2, ritual: 2, hazard: 1, correction: 1, revert: 0 },
  config: { ritual: 3, law: 2, hazard: 1, correction: 1, revert: 0 },
  unknown: {},
});

// The weight gate. A typo fixed on the first try and a bug that burned an afternoon used to rank
// identically; the difference is what `facts.weight` records (fail-fix.js#weighLesson).
//
// Three things about the clause are deliberate. A NULL weight means "never measured" — a
// git-history seed has no session and no abandoned attempt — so it COALESCEs to the threshold and
// passes: suppressing on absence of evidence is the same mistake as expiring an anchor we could
// not check. A `law` is exempt entirely, because the user said it and no measurement outranks
// that. And it is enforced in SQL, next to the tier filter, for the same reason that one is:
// a caller cannot forget it.
const WEIGHT_GATE = `AND (f.tier = 'law'
                          OR COALESCE(f.weight, ${SURFACE_THRESHOLD}) >= ${SURFACE_THRESHOLD})`;

const SELECT = `
SELECT f.id AS fact_id, f.kind, f.tier, f.body, f.evidence,
       f.recurrence, f.valid_at, f.created_at, %WEIGHT% AS weight,
       %UNCONFIRMED% AS unconfirmed_since,
       a.repo_id, a.file_path, a.symbol_name, a.symbol_kind, a.grain
  FROM anchors a
  JOIN facts f ON f.id = a.fact_id
 WHERE f.expired_at IS NULL
   AND f.tier IN ('law', 'observation')
   %CONTRADICTED%`;

// This module opens practice.db READ-ONLY, and a read-only open does not migrate (db.js). So a
// store that no writer has touched since 006 landed still has no `weight` column, and naming it
// would make every recall throw — which this module catches and turns into silence. The layer
// going quiet on an un-migrated store is a worse failure than an ungated read on one, so the
// column is probed once per handle rather than assumed.
const weightColumn = new WeakMap();
const contradictedColumn = new WeakMap();

function hasColumn(conn, cache, name) {
  let ok = cache.get(conn);
  if (ok === undefined) {
    try { ok = conn.pragma('table_info(facts)').some((c) => c.name === name); } catch { ok = false; }
    cache.set(conn, ok);
  }
  return ok;
}

function hasWeight(conn) { return hasColumn(conn, weightColumn, 'weight'); }

// 011. Probed rather than assumed for the same reason `weight` is: this module opens practice.db
// READ-ONLY and a read-only open does not migrate, so naming the column on a store no writer has
// touched since 011 would make every recall throw -- which this module catches and turns into
// silence. The layer going quiet is a worse failure than an unfiltered read.
function hasContradicted(conn) { return hasColumn(conn, contradictedColumn, 'contradicted_at'); }

// 013. Same probe, same reason.
const unconfirmedColumn = new WeakMap();
function hasUnconfirmed(conn) { return hasColumn(conn, unconfirmedColumn, 'unconfirmed_since'); }

let cached;

function handle(db) {
  if (db) return db;
  if (cached === undefined) {
    try { cached = openPracticeDb({ readonly: true }); } catch { cached = null; }
  }
  return cached;
}

function resetCache() {
  if (cached) { try { cached.close(); } catch { /* already closed */ } }
  cached = undefined;
}

function parseEvidence(raw) {
  try {
    const e = JSON.parse(raw || '{}');
    return e && typeof e === 'object' ? e : {};
  } catch {
    return {};
  }
}

// How closely the anchor matches what was asked for. A fact about the exact symbol beats one about
// the file it lives in, which beats one about the repository.
function specificity(row, { filePath, symbolName }) {
  if (symbolName && row.symbol_name === symbolName) return 0;
  if (filePath && row.file_path === filePath && row.grain === 'symbol') return 1;
  if (filePath && row.file_path === filePath) return 2;
  return 3;
}

// Sizes, not style. A body is already ≤180 at write time; a detail is a 600-char stderr excerpt;
// a cmd is UNBOUNDED at capture and one real heredoc in the live store filled an entire digest,
// so 120 is the same number digest.js#oneLine settled on.
const BODY_MAX = 200;
const DETAIL_MAX = 400;
const CMD_MAX = 120;

// A commit sha is the one provenance field a reader is invited to paste into a shell.
const SHA = /^[0-9a-f]{7,40}$/i;

function shape(row) {
  const evidence = parseEvidence(row.evidence);
  const commit = String(evidence.commit || '');
  return {
    fact_id: row.fact_id,
    tier: row.tier,
    kind: row.kind,
    body: neutralise(row.body, BODY_MAX),
    detail: neutralise(evidence.detail || evidence.err_excerpt || '', DETAIL_MAX) || null,
    // The fix/observation count — what the CLI renders as "seen N×" and what ranks the most
    // trouble-prone symbols first.
    recurrence: row.recurrence || 0,
    // The code this fact is anchored to changed body since it was last checked. Null means fine.
    // Shown in the annotation as a short "(unconfirmed since <date>)" marker.
    unconfirmed_since: row.unconfirmed_since || null,
    provenance: {
      when: String(row.valid_at || row.created_at || '').slice(0, 10) || null,
      cmd: neutralise(evidence.cmd || '', CMD_MAX) || null,
      commit: SHA.test(commit) ? commit : null,
    },
    anchor: {
      repo_id: row.repo_id,
      file_path: safePath(row.file_path),
      // neutralise, not safePath: `operator<<` and `$scope` are real declaration names and a path
      // sanitiser would rewrite them, which breaks annotationFrom's identity check silently.
      symbol_name: row.symbol_name ? neutralise(row.symbol_name, 120) : null,
      grain: row.grain,
    },
  };
}

// tier > specificity > recurrence > task affinity > recency. The base ladder is tier then
// recurrence then recency; specificity and affinity are inserted as tiebreaks, because without
// them the tie is broken by insertion order, which is arbitrary.
function compare(a, b, affinity) {
  // Relevance BAND before tier: a fact actually about the queried symbol/file (specificity 0-2) must
  // outrank a repo-wide rule (specificity 3), whatever their tiers. Tier-first was safe only while a
  // repo carried a handful of stated laws; once /korainit imports 100+ repo-grain laws, tier-first
  // let those laws crowd every symbol-specific fact out of a scoped recall — a real `recall(symbol=X)`
  // returned "Do NOT modify code files" instead of X's own hazard. Repo-grain laws belong in the
  // once-per-session rulebook (context-brief), not injected ahead of the fact the reader asked for.
  // Bare/repo queries leave every fact at specificity 3, so this band is a no-op there and tier still
  // leads (then the bare-mode hazard reserve rebalances).
  const ba = a._spec >= 3 ? 1 : 0;
  const bb = b._spec >= 3 ? 1 : 0;
  if (ba !== bb) return ba - bb;
  const ta = TIER_RANK[a.tier] ?? 9;
  const tb = TIER_RANK[b.tier] ?? 9;
  if (ta !== tb) return ta - tb;
  if (a._spec !== b._spec) return a._spec - b._spec;
  // Weight below specificity, not above it: an expensive lesson about another file is still about
  // another file, and relevance has to win before importance does.
  if (a._weight !== b._weight) return b._weight - a._weight;
  if (a.recurrence !== b.recurrence) return b.recurrence - a.recurrence;
  const aa = affinity[a.kind] ?? 0;
  const ab = affinity[b.kind] ?? 0;
  if (aa !== ab) return ab - aa;
  const da = a.provenance.when || '';
  const db = b.provenance.when || '';
  if (da !== db) return da < db ? 1 : -1;
  return b.fact_id - a.fact_id;
}

// A repo-grain anchor (009) is about the whole repository and has file_path = '' and no symbol, so
// every clause below excludes it by construction — and since that is the grain a stated law lands
// at, the developer's own rules were the one class of fact that could never be delivered. Admitted
// only when the query is repo-scoped: without a repo_id this would hand a rule from one checkout to
// another. `specificity` already ranks it last, so it fills the tail of an answer rather than
// displacing something about the actual symbol.
const REPO_GRAIN_OR = " OR a.grain = 'repo'";

function buildQuery({
  repoId, filePath, symbolName, weighted = false, contradictable = false, unconfirmable = false,
}) {
  const select = SELECT
    .replace('%WEIGHT%', weighted ? 'f.weight' : 'NULL')
    .replace('%UNCONFIRMED%', unconfirmable ? 'f.unconfirmed_since' : 'NULL')
    .replace('%CONTRADICTED%', contradictable ? 'AND f.contradicted_at IS NULL' : '');
  const clauses = [];
  const params = [];
  const wide = repoId ? REPO_GRAIN_OR : '';
  if (repoId) { clauses.push('a.repo_id = ?'); params.push(repoId); }
  if (filePath && symbolName) {
    clauses.push(`(a.symbol_name = ? OR (a.file_path = ? AND a.grain = 'file')${wide})`);
    params.push(symbolName, filePath);
  } else if (symbolName) {
    clauses.push(`(a.symbol_name = ?${wide})`);
    params.push(symbolName);
  } else if (filePath) {
    clauses.push(`(a.file_path = ?${wide})`);
    params.push(filePath);
  }
  const where = clauses.length ? `${select} AND ${clauses.join(' AND ')}` : select;
  return { sql: weighted ? `${where}\n   ${WEIGHT_GATE}` : where, params };
}

// Fail-soft in every direction: no practice.db, an older schema, a hook mid-write. A recall that
// throws would turn a retrieval into a failure, and the whole point of the second layer is that it
// is a bonus on top of the first one.
function recallFor(practiceDb, opts = {}) {
  const conn = handle(practiceDb);
  if (!conn) return [];
  const {
    repoId = null, filePath = null, symbolName = null, taskType = null,
    limit = DEFAULT_LIMIT, budgetChars = DEFAULT_BUDGET_CHARS, now = new Date(),
  } = opts;

  let rows;
  try {
    const { sql, params } = buildQuery({
      repoId, filePath, symbolName, weighted: hasWeight(conn), contradictable: hasContradicted(conn),
      unconfirmable: hasUnconfirmed(conn),
    });
    rows = conn.prepare(sql).all(...params);
  } catch {
    return [];
  }

  const affinity = TASK_AFFINITY[taskType] || TASK_AFFINITY.unknown;
  const best = new Map();
  for (const row of rows) {
    const spec = specificity(row, { filePath, symbolName });
    const prev = best.get(row.fact_id);
    if (prev && prev._spec <= spec) continue;
    const fact = shape(row);
    fact._spec = spec;
    // Private, and stripped before the fact leaves. This module's output is delivered into an
    // agent's context and the whole point of the gate is to make that output smaller, so the score
    // that did the gating must not itself become a field somebody pays for.
    fact._weight = Number.isFinite(row.weight) ? row.weight : SURFACE_THRESHOLD;
    best.set(row.fact_id, fact);
  }

  let ranked = [...best.values()].sort((a, b) => compare(a, b, affinity));

  // Bare, repo-level recall ("what should I know about this repo?") has two distinct answers a
  // reader wants together: the developer's stated rules AND the most trouble-prone areas. Pure
  // tier-first order lets a large imported rulebook (a real CLAUDE.md imports 100+ laws) crowd every
  // hazard out of the top-N, so "what breaks most here" would return only rules. When neither a
  // symbol nor a file was named, reserve up to half the slots for the highest-recurrence hazards so
  // both kinds surface. Per-symbol and per-file recall are untouched — there, tier-first is correct.
  if (!filePath && !symbolName) {
    const isHazard = (f) => f.kind === 'hazard' || f.kind === 'tombstone';
    // "Most trouble-prone" means genuinely RECURRING trouble — a symbol fixed repeatedly — not an
    // imported "do not do X" caution that a classifier tagged hazard but has never actually recurred.
    // Rank the reserve by recurrence so a 3-fix code hazard leads a 0-recurrence instruction rule.
    const hazards = ranked.filter(isHazard)
      .sort((a, b) => (b.recurrence || 0) - (a.recurrence || 0) || compare(a, b, affinity));
    if (hazards.length) {
      const reserve = Math.max(1, Math.floor(limit / 2));
      const topHazards = hazards.slice(0, reserve);
      const picked = new Set(topHazards.map((f) => f.fact_id));
      const rest = ranked.filter((f) => !picked.has(f.fact_id));
      const merged = [];
      let hi = 0; let ri = 0;
      // Interleave so hazards are guaranteed representation without displacing laws entirely.
      while (merged.length < ranked.length) {
        if (hi < topHazards.length && (merged.length % 2 === 1 || ri >= rest.length)) merged.push(topHazards[hi++]);
        else if (ri < rest.length) merged.push(rest[ri++]);
        else if (hi < topHazards.length) merged.push(topHazards[hi++]);
        else break;
      }
      ranked = merged;
    }
  }

  const out = [];
  let spent = 0;
  for (const fact of ranked) {
    if (out.length >= limit) break;
    const cost = String(fact.body || '').length + String(fact.detail || '').length;
    if (out.length && spent + cost > budgetChars) break;
    spent += cost;
    delete fact._spec;
    delete fact._weight;
    out.push(fact);
  }
  return out;
}

const ANNOTATION_CANDIDATES = 5;

// How many flagged facts sit at one exact anchor decides the MODE — this is a narrow,
// unranked existence/count query, deliberately separate from recallFor's ranked, budget-capped
// answer. A contradicted fact can never carry unconfirmed_since (the contradict path clears it),
// so there is nothing to additionally filter here.
const MAX_FLAGGED_SHOWN = 5;
// valid_at/created_at/unconfirmed_since are selected here too (not just id/tier/body) so the
// single-flagged-fact case in factSlotAt can build a complete slot directly from THIS row — never
// dependent on recallFor's ranked, capped candidate list. Without that, a flagged fact that did not
// happen to rank in the top ANNOTATION_CANDIDATES at a heavily-annotated anchor would silently lose
// its own flag slot to whatever WAS in that capped list, the same failure mode this whole query
// exists to prevent.
const FLAGGED_AT_SYMBOL = `
SELECT f.id AS fact_id, f.tier, f.body, f.valid_at, f.created_at, f.unconfirmed_since
  FROM facts f JOIN anchors a ON a.fact_id = f.id
 WHERE f.expired_at IS NULL AND f.unconfirmed_since IS NOT NULL
   AND a.repo_id = ? AND a.file_path = ? AND a.symbol_name = ? AND a.grain = 'symbol'
 ORDER BY f.unconfirmed_since ASC, f.id DESC`;
const FLAGGED_AT_FILE = `
SELECT f.id AS fact_id, f.tier, f.body, f.valid_at, f.created_at, f.unconfirmed_since
  FROM facts f JOIN anchors a ON a.fact_id = f.id
 WHERE f.expired_at IS NULL AND f.unconfirmed_since IS NOT NULL
   AND a.repo_id = ? AND a.file_path = ? AND a.grain = 'file'
 ORDER BY f.unconfirmed_since ASC, f.id DESC`;

function flaggedAt(conn, { repoId, filePath, symbolName }) {
  try {
    return symbolName
      ? conn.prepare(FLAGGED_AT_SYMBOL).all(repoId, filePath, symbolName)
      : conn.prepare(FLAGGED_AT_FILE).all(repoId, filePath);
  } catch { return []; }
}

// The single fact/flagged-list slot for ONE exact anchor. Normal case: rank exactly as
// recallFor already does (tier > specificity > weight > recurrence) and take the winner — which
// may itself be a flagged fact, carrying its own unconfirmed_since for the caller to show a
// marker. Multi-flag case: more than one fact at this SAME anchor is currently flagged, and
// hiding two-thirds of "someone needs to look" behind a single ranked pick defeats the mechanism
// — switch to a capped list of short one-liners instead, every one keeping its fact id visible.
function factSlotAt(practiceDb, conn, { repoId, filePath, symbolName, now }) {
  const flagged = flaggedAt(conn, { repoId, filePath, symbolName });
  if (flagged.length > 1) {
    return {
      flagged: flagged.slice(0, MAX_FLAGGED_SHOWN).map((f) => ({
        fact_id: f.fact_id, tier: f.tier, body: neutralise(f.body, BODY_MAX),
      })),
      flagged_more: Math.max(0, flagged.length - MAX_FLAGGED_SHOWN),
    };
  }

  // The one-flagged-fact case: built DIRECTLY from the flaggedAt() row, never from recallFor's
  // ranked/capped candidate list. It must never lose the slot to a higher-ranked but UNFLAGGED
  // fact at the same anchor — "someone needs to look" cannot be silently buried by a healthy law
  // sharing the node — and it must not depend on ranking inside the top ANNOTATION_CANDIDATES
  // either, or a flagged fact at a heavily-annotated anchor could lose its own slot the same way.
  if (flagged.length === 1) {
    const f = flagged[0];
    return {
      fact: {
        fact_id: f.fact_id, tier: f.tier, body: neutralise(f.body, BODY_MAX),
        at: String(f.valid_at || f.created_at || '').slice(0, 10) || null,
        unconfirmed_since: f.unconfirmed_since,
      },
    };
  }

  // Nothing flagged: the plain ranked winner decides, exactly as recallFor already ranks
  // (tier > specificity > weight > recurrence). Ask for more than one: a fact ranked below the
  // eligible one at this exact anchor can still occupy [0], so taking the head alone would answer
  // null where a real hit exists.
  const grainOk = symbolName
    ? (f) => f.anchor.grain === 'symbol' && f.anchor.symbol_name === symbolName && f.anchor.file_path === filePath
    : (f) => f.anchor.grain === 'file' && f.anchor.file_path === filePath;
  const top = recallFor(practiceDb, {
    repoId, filePath, symbolName, limit: ANNOTATION_CANDIDATES, now,
  }).find(grainOk);
  if (!top) return null;
  return {
    fact: {
      fact_id: top.fact_id, tier: top.tier, body: top.body,
      at: top.provenance.when, unconfirmed_since: top.unconfirmed_since,
    },
  };
}

// The independent open-note slot, for an anchored situational note. A node's
// fact slot and note slot never compete — a hazard should not crowd out an open loop, because they
// answer different questions. Exactly one note, unlike the fact slot's multi-flag list: an open
// note does not have the "several independent claims on one thing" shape a flagged fact does.
function noteSlotAt(conn, { repoId, filePath, symbolName }) {
  try {
    // open-loops.js, not loop-anchors.js: this must stay hook-safe (see open-loops.js's own note
    // on loopsAtNode for why the split exists).
    const { loopsAtNode } = require('./open-loops');
    const hits = loopsAtNode(conn, { repoId, filePath, symbolName: symbolName || null });
    if (!hits.length) return null;
    return { loop_id: hits[0].id, body: neutralise(hits[0].body, BODY_MAX) };
  } catch { return null; }
}

// The `recall` tool's own entry point onto the note slot. `recall` is the tool the agent is told
// to "call FIRST... whenever a symbol is unfamiliar," and it takes the same `file`/`symbol`
// coordinates a loop anchors to — but its retrieval (recallFor, above) only ever touches `facts`.
// Without this, a file-anchored open loop is visible only as a side-effect annotation on
// explore/neighbours/file_symbols/blast_radius, tools the agent has no particular reason to call
// once recall has already answered "what do we know about this."
function noteAt(practiceDb, { repoId, filePath, symbolName = null }) {
  if (!filePath) return null;
  const conn = handle(practiceDb);
  if (!conn) return null;
  try {
    return noteSlotAt(conn, { repoId, filePath, symbolName });
  } catch { return null; }
}

// The MCP annotation lookup for a list of symbol candidates (explore/neighbours/changes_with/
// blast_radius): the fact slot and the note slot are found INDEPENDENTLY, each the first candidate
// in render order that has something — so a fact on one node and a note on a different node can
// both be delivered in one response, and a node that has both shows both. Scoped by repo_id:
// without it, two repositories sharing a repo-relative path and a symbol name collide.
function annotationFrom(practiceDb, candidates, { repoId = null, now = new Date() } = {}) {
  if (!candidates || !candidates.length) return null;
  const conn = handle(practiceDb);
  if (!conn) return null;

  let factSlot = null;
  let factNode = null;
  const factSeen = new Set();
  for (const c of candidates) {
    if (!c || !c.file || !c.name) continue;
    const key = `${c.file}\x00${c.name}`;
    if (factSeen.has(key)) continue;
    factSeen.add(key);
    const slot = factSlotAt(practiceDb, conn, { repoId, filePath: c.file, symbolName: c.name, now });
    if (slot) { factSlot = slot; factNode = c; break; }
  }

  // Symbol-grain first, then a FILE-grain fallback on the same candidate's file — unlike the fact
  // slot above, deliberately not scoped to file_symbols/blast_radius only. A situational note is
  // rare (at most one per file, usually zero) and high-stakes ("don't touch this file right now"),
  // not the repetitive-hazard-on-every-symbol case the fact widening above is scoped against, and
  // the narrower the tool call, the more precisely it names the one file about to be edited.
  let noteSlot = null;
  let noteNode = null;
  const noteSeen = new Set();
  const noteFileSeen = new Set();
  for (const c of candidates) {
    if (!c || !c.file || !c.name) continue;
    const key = `${c.file}\x00${c.name}`;
    if (noteSeen.has(key)) continue;
    noteSeen.add(key);
    const note = noteSlotAt(conn, { repoId, filePath: c.file, symbolName: c.name });
    if (note) { noteSlot = note; noteNode = c; break; }
    if (!noteFileSeen.has(c.file)) {
      noteFileSeen.add(c.file);
      const fileNote = noteSlotAt(conn, { repoId, filePath: c.file, symbolName: null });
      if (fileNote) { noteSlot = fileNote; noteNode = c; break; }
    }
  }

  if (!factSlot && !noteSlot) return null;
  return {
    ...(factSlot ? { ...factSlot, file: factNode.file, name: factNode.name } : {}),
    ...(noteSlot ? { note: { ...noteSlot, file: noteNode.file, name: noteNode.name } } : {}),
  };
}

// The file-grain counterpart: a tool call ABOUT a file directly
// (file_symbols, and blast_radius's changed files) surfaces a file-grain fact/note the per-symbol
// scan above never reaches — deliberately NOT applied per-symbol, which would repeat the same
// file-wide item on every declaration beneath it.
function fileAnnotationFrom(practiceDb, filePaths, { repoId = null, now = new Date() } = {}) {
  if (!filePaths || !filePaths.length) return null;
  const conn = handle(practiceDb);
  if (!conn) return null;

  for (const filePath of filePaths) {
    if (!filePath) continue;
    const fact = factSlotAt(practiceDb, conn, { repoId, filePath, symbolName: null, now });
    const note = noteSlotAt(conn, { repoId, filePath, symbolName: null });
    if (!fact && !note) continue;
    // `file`/`name: null` ALWAYS set at the top level, whether or not `fact` fired — a note-only
    // hit (a fact-less file with an open loop on it) must still read as file-grain to a caller
    // like renderBlastRadius that switches on `annotation.name === null`. Nesting `file`/`name`
    // only inside `fact` silently dropped a real, anchored note with nothing rendering it anywhere.
    return {
      file: filePath,
      name: null,
      ...(fact || {}),
      ...(note ? { note: { ...note, file: filePath, name: null } } : {}),
    };
  }
  return null;
}

module.exports = {
  recallFor,
  annotationFrom,
  fileAnnotationFrom,
  noteAt,
  resetCache,
  DEFAULT_LIMIT,
  DEFAULT_BUDGET_CHARS,
  TASK_AFFINITY,
  MAX_FLAGGED_SHOWN,
};
