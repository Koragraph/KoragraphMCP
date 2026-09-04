'use strict';

const path = require('path');

const { promoteLessons } = require('./promote');
const { resolveBranch, resolveByName, resolveFilePath, identityOfCheckout } = require('./resolve');
const { repoIdentity, relativise, repoNameOf } = require('./repo-identity');
const { neutralise } = require('./untrusted');
const { findSuperseded, supersede } = require('./fact-edges');

// The write door. Everything a HUMAN says — typed as a correction, imported from a CLAUDE.md,
// stated outright — enters here and nowhere else, and it enters through promoteLessons like every
// mined fact does. That is the whole design: an authored fact gets the same anchor, the same
// drift check and the same expiry as one distilled from a failure, so a rule a developer wrote
// about a function that no longer exists dies on its own.
//
// This is also the only writer that can anchor at DECLARATION grain from a live session. A hook
// may not open graph.db — better-sqlite3's busy wait would stall the editor mid-keystroke — so
// every hook-side promotion passes graphDb = null and lands at file grain. The MCP server is not a
// hook, so this path resolves symbols for real.

const MAX_BODY = 400;
const MIN_BODY = 8;

// A developer stating a rule is the highest-confidence signal this store will ever receive: it is
// explicit, unambiguous and needs no distillation. `law` outranks everything at delivery, and
// nothing else in the tree may produce one — see WRITEABLE_KINDS.
const AUTHORED_TIER = 'law';
const TIER_RANK = Object.freeze({ hypothesis: 0, observation: 1, law: 2 });

const WRITEABLE_KINDS = Object.freeze(['law', 'hazard', 'ritual', 'tombstone', 'correction']);

function rejected(reason) {
  return { status: 'rejected', reason, fact_id: null, anchor: null, superseded: [] };
}

// Which symbol an authored fact is about, when the developer named one. Ambiguity is reported
// rather than resolved by guessing: a bare `get` that matches forty methods should anchor to the
// best candidate AND say it was ambiguous, because the reader is the one who can settle it.
function locateSymbol(graphDb, branch, { symbol, fileHint }) {
  // Call syntax is how both a developer and an instruction file name a function — "evictStale() is
  // O(n)". The graph stores the declaration under its bare name, so a trailing argument list must
  // come off before the lookup or the name resolves to nothing and the stale-instruction audit
  // reports a live declaration as deleted code.
  const name = String(symbol || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!name) return { found: false, ambiguous: 0, node: null };
  const hits = resolveByName(graphDb, branch.branchId, { name, fileHint });
  if (!hits.length) return { found: false, ambiguous: 0, node: null };
  const distinct = new Set(hits.map((h) => `${h.file_path}:${h.start_line}`)).size;
  return { found: true, ambiguous: distinct > 1 ? distinct : 0, node: hits[0] };
}

// `relativise` resolves a relative path against process.cwd(), not against the repo — correct for
// the recorder, which is handed absolute paths by the hook, and wrong here: a caller naming
// "src/foo.js" means it repo-relative, and resolving that from wherever the server was started
// yields a path outside the checkout and a confident "the graph does not know this file".
function repoRelative(repoRoot, file) {
  if (!file) return null;
  const s = String(file).trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return relativise(repoRoot, s);
  return s.replace(/^\.\//, '').split(path.sep).join('/');
}

// Identifier-SHAPED words in a body, as candidates to look up. `extractReferents` is deliberately
// not reused: it feeds `kindOf`, where widening the net would reclassify imported prose, and it
// only sees backticked or parenthesised names. Nobody speaking to an agent types backticks —
// "validateToken must reject short tokens" is the normal shape of a stated rule and it carries a
// referent that the graph can confirm.
//
// Shape is a FILTER, never the decision: every candidate is resolved against the graph and dropped
// unless it is a real declaration here. The shape test only keeps the lookup cheap and stops bare
// English words ("everywhere", "never") from being probed at all, so `SHAPED_ID_RE`'s hump/underscore
// requirement is what separates `openPool` from prose. A lowercase single-word declaration (`main`)
// is missed by design: catching it would mean probing every word in every sentence.
const SHAPED_ID_RE = /[A-Z].*[a-z]|_/;
const CANDIDATE_RE = /\b[A-Za-z_$][\w$]*\b/g;
const SUBSTITUTION_RE = /\b(?:instead of|rather than|in place of|prefer\b[^.]*\bover\b)/i;

function anchorCandidates(body) {
  const text = String(body || '');
  // A substitution rule names an alternative to avoid — "use fastPath instead of openPool" — and
  // anchoring to a name after the marker would attach the rule to the very thing it says not to
  // use. Only the TAIL is dropped, not the sentence: "refreshSession throws on an invalid token
  // instead of returning null" describes one declaration, and its subject sits before the marker.
  const cut = SUBSTITUTION_RE.exec(text);
  const limit = cut ? cut.index : text.length;
  const out = [];
  const seen = new Set();
  for (const m of text.replace(/`/g, ' ').matchAll(CANDIDATE_RE)) {
    if (m.index >= limit) break;
    const w = m[0];
    // A dotted name is namespaced and external (`console.log`); CANDIDATE_RE already splits those,
    // so the guard is on the character before the match rather than inside it.
    if (m.index > 0 && text[m.index - 1] === '.') continue;
    if (w.length < 4 || seen.has(w) || !SHAPED_ID_RE.test(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.slice(0, 8);
}

// The one case where a body earns a declaration anchor: exactly one candidate resolves, and it
// resolves unambiguously. Two resolving names means the sentence mentions two declarations and
// nothing here can say which it is ABOUT; an ambiguous single name is the same problem one level
// down. Both leave the caller's grain alone, because a wrong anchor expires a rule that is still
// true — strictly worse than never checking it.
function soleReferent(graphDb, branch, body, fileHint) {
  const named = anchorCandidates(body);
  if (!named.length) return null;
  const hits = named
    .map((n) => locateSymbol(graphDb, branch, { symbol: n, fileHint }))
    .filter((h) => h.found);
  if (hits.length !== 1 || hits[0].ambiguous !== 0) return null;
  return hits[0].node;
}

function symbolTarget(repoId, repoRoot, node) {
  return {
    repo_id: repoId,
    file_path: node.file_path,
    start_line: node.start_line,
    end_line: node.end_line,
    abs_path: repoRoot ? `${repoRoot}/${node.file_path}` : null,
    named_node: node,
  };
}

function targetFor({ graphDb, branch, repoId, repoRoot, symbol, file, body = '' }) {
  const fileHint = repoRelative(repoRoot, file);

  if (symbol && graphDb && branch) {
    const { found, ambiguous, node } = locateSymbol(graphDb, branch, { symbol, fileHint });
    if (found) {
      return {
        anchored: true,
        ambiguous,
        target: {
          repo_id: repoId,
          file_path: node.file_path,
          start_line: node.start_line,
          end_line: node.end_line,
          abs_path: repoRoot ? `${repoRoot}/${node.file_path}` : null,
          // The node the developer NAMED, carried through so anchoring binds to it directly.
          // Without this, anchorsFor converted the located node back into a line range and
          // re-resolved it through the hunk path, whose innermost-declaration rule is right for
          // an edit and wrong for a name: `--symbol AuthBase` would anchor to the `__call__` method
          // inside AuthBase. The identity is already resolved; it must not be re-guessed.
          named_node: node,
        },
        resolved: node,
      };
    }
    // Named a symbol the graph does not know. Stored anyway, at repo grain, and flagged — an
    // instruction file full of rules about deleted code is exactly what the import audit reports,
    // so this case is a product output and not an error.
    return { anchored: false, ambiguous: 0, missing: 'symbol', target: repoTarget(repoId) };
  }

  if (fileHint) {
    // Resolve to the graph's CANONICAL path, not the raw hint. A bare basename (`auth.py`) resolves
    // through the suffix fallback to a real file, but storing `auth.py` as the anchor coordinate
    // orphans the fact the moment a second `auth.py` appears anywhere in the repo — the fallback
    // then returns null and revalidate reads the file as deleted. With NO GRAPH AT ALL to resolve
    // against, the hint is kept as given — that is the one case this product is honest about being
    // unable to check.
    //
    // `graphDb` present but `branch` null is a DIFFERENT case and must not take the same shortcut:
    // it means this repo (by identity, url, name, or path) simply is not in the graph — a session
    // whose cwd is a real git repo that was never ingested, or was ingested from a different root
    // (a monorepo subdirectory vs. its checkout root — exactly the shape korainit hits whenever the
    // ingest path and the working directory disagree). The old `graphDb && branch` guard on the
    // ONLY branch that could catch this fired NOTHING when branch was null, so it fell through to
    // "keep the hint, call it anchored" — a rule naming a file that exists nowhere in any graph
    // came back a confident, unverified "✓ Saved ... anchored to <path>", defeating the entire
    // point of anchoring. Reproduced: `remember --file ui/desktop/main.ts` against a graph that
    // never ingested ui/desktop anchored successfully, silently, with no warning anywhere.
    if (graphDb && !branch) {
      return { anchored: false, ambiguous: 0, missing: 'file', target: repoTarget(repoId) };
    }
    const canonical = graphDb && branch ? resolveFilePath(graphDb, branch.branchId, fileHint) : null;
    if (!canonical && graphDb && branch) {
      return { anchored: false, ambiguous: 0, missing: 'file', target: repoTarget(repoId) };
    }
    // A file hint is a floor, not a ceiling. Naming the file the rule lives in must not COST the
    // caller the finer anchor — resolving the body's referent inside that file is strictly safer
    // than the whole-repo lookup an unhinted body gets, because the hint bounds the candidates.
    if (graphDb && branch) {
      const node = soleReferent(graphDb, branch, body, canonical || fileHint);
      if (node) {
        return { anchored: true, ambiguous: 0, target: symbolTarget(repoId, repoRoot, node), resolved: node };
      }
    }
    return {
      anchored: true,
      ambiguous: 0,
      target: { repo_id: repoId, file_path: canonical || fileHint, start_line: null, end_line: null },
    };
  }

  // No EXPLICIT referent. Most rules a developer states are true of the whole repository and a
  // repo-grain anchor is a real anchor. But a body can still name code — "always assert with the
  // \`expectError\` helper" — and if every symbol it names is absent from the graph, this is the
  // same situation as --symbol missing: an instruction about code that does not exist, delivered
  // at law into every session forever. The model DEFIES such rules, correctly, citing the
  // codebase — so delivering them buys zero compliance and spends trust. Same demotion as the
  // explicit path; the caller's own tier still wins, and one resolvable symbol among several keeps
  // the rule at law, because it is about real code.
  if (graphDb && branch) {
    try {
      const { extractReferents } = require('./instruction-files');
      // The audit exists to catch a rule about a REPO DECLARATION that no longer exists. Two shapes
      // it must NOT fire on, because their named symbols were never repo declarations at all, so
      // their absence from the graph proves nothing:
      //   - a DOTTED name (console.log, os.system, Intl.NumberFormat, pathlib.Path) is a namespaced
      //     external/builtin reference, never a local declaration;
      //   - a SUBSTITUTION rule (prefer X over Y, use X instead of Y) names alternatives to prefer
      //     or avoid, which are expected to be external.
      // A bare, positively-directed name that is gone — "always use the `expectError` helper" — is
      // the case that must demote (the model defies it, spending trust). Residual limit: a bare
      // external symbol positively directed ("wrap in `withTransaction`") is indistinguishable from
      // a dead repo helper and still demotes.
      const substitution = /\b(?:instead of|rather than|in place of|prefer\b[^.]*\bover\b)/i.test(String(body));
      const named = substitution ? []
        : extractReferents(String(body)).symbols.filter((n) => !n.includes('.')).slice(0, 5);
      // DEMOTION reads only the narrow list, and must keep doing so. It fires on a name the writer
      // deliberately marked as code, so its absence from the graph is evidence the code is gone.
      // An identifier-shaped word in plain prose carries no such intent — "we use CommonJS
      // everywhere" would demote a perfectly true repo-wide rule to a stale-instruction warning.
      if (named.length) {
        const resolvable = named
          .some((n) => locateSymbol(graphDb, branch, { symbol: n, fileHint: null }).found);
        if (!resolvable) {
          return { anchored: false, ambiguous: 0, missing: 'symbol', target: repoTarget(repoId) };
        }
      }
      // PROMOTION reads the wide list. Being wrong here costs a coarser anchor, not a false
      // warning, so it can afford candidates the audit cannot.
      const node = soleReferent(graphDb, branch, body, null);
      if (node) {
        return { anchored: true, ambiguous: 0, target: symbolTarget(repoId, repoRoot, node), resolved: node };
      }
    } catch { /* referent audit is best-effort; a parse failure must not block a store */ }
  }
  return { anchored: true, ambiguous: 0, target: repoTarget(repoId) };
}

function repoTarget(repoId) {
  return { repo_id: repoId, file_path: '', grain: 'repo', start_line: null, end_line: null };
}

function anchorRow(practiceDb, factId) {
  return practiceDb.prepare(
    'SELECT file_path, symbol_name, symbol_owner, symbol_kind, grain FROM anchors WHERE fact_id = ? ORDER BY grain, symbol_name LIMIT 1',
  ).get(factId) || null;
}

const VERIFIED_VALUES = Object.freeze(['confirmed', 'contradicted', 'unverifiable']);

// Given a fact id (or ids), record a verdict against the EXISTING row in place — no new fact, no
// supersession, no evidence bloat. "This is now false" already has a home (contradicted_at) and
// anchoring already has a home (the anchor tables); this is only the verdict write itself.
//
// Batchable by construction: `factIds` is always an array here (rememberFact normalises a bare
// integer into a one-element array before calling in), and `verdictFor(i)` reads a parallel
// `verified`/`note` — either one value applying to every id, or an array aligned position-for-
// position. An agent looking at a node with three flagged facts reports all three in ONE call.
function confirmFacts(practiceDb, graphDb, { factIds, verified, note, now }) {
  // A caller passing an array must pass ONE ENTRY PER id — a shorter array is a real caller error,
  // not something to guess through. Rejecting the whole call here (rather than letting a missing
  // slot silently fall through to the "confirmed" default) is what keeps this mechanical: a
  // judgment call is never manufactured for a fact nobody actually gave a verdict on.
  if (Array.isArray(verified) && verified.length !== factIds.length) {
    return rejected(`verified array length (${verified.length}) must match fact_id array length (${factIds.length})`);
  }
  if (Array.isArray(note) && note.length !== factIds.length) {
    return rejected(`note array length (${note.length}) must match fact_id array length (${factIds.length})`);
  }

  const branchCache = new Map();
  const { checkAnchor, applyAnchorRefresh } = require('./revalidate');
  const at = (v, i) => (Array.isArray(v) ? v[i] : v);

  const results = [];
  for (let i = 0; i < factIds.length; i += 1) {
    const factId = factIds[i];
    const fact = practiceDb.prepare('SELECT id, expired_at FROM facts WHERE id = ?').get(factId);
    if (!fact) { results.push({ fact_id: factId, status: 'not_found' }); continue; }
    if (fact.expired_at) { results.push({ fact_id: factId, status: 'expired' }); continue; }

    // No verdict said at all (for this id) defaults to 'confirmed' — the array length is already
    // guaranteed to match above, so an array slot here is a real (possibly deliberately falsy)
    // value, never a silent gap.
    const verdict = at(verified, i) || 'confirmed';
    // 'unverifiable' is a real, legitimate value (the agent looked and genuinely could not tell) —
    // it just has nothing for this door to DO: leave the flag exactly as it is rather than guess.
    // Anything else unrecognised is a real caller error, reported per-id without failing the batch.
    if (verdict === 'unverifiable') {
      results.push({ fact_id: factId, status: 'skipped', reason: 'unverifiable — left flagged' });
      continue;
    }
    if (verdict !== 'confirmed' && verdict !== 'contradicted') {
      results.push({ fact_id: factId, status: 'skipped', reason: `unknown verified "${verdict}"` });
      continue;
    }

    if (verdict === 'contradicted') {
      const reasonNote = at(note, i);
      // 'checked:' — this path only ever runs against an EXISTING fact an agent just looked at,
      // never an import. `imported:` belongs to rememberFact's own contradicted-on-creation branch
      // below, which really can be an import; conflating the two prefixes would make `practice
      // list`/`why` print "imported" provenance for a fact that was never imported from an
      // instruction file at all.
      const changed = practiceDb.prepare(
        'UPDATE facts SET contradicted_at = ?, contradicted_reason = ?, unconfirmed_since = NULL WHERE id = ? AND contradicted_at IS NULL',
      ).run(
        now.toISOString(),
        `checked: ${reasonNote ? String(reasonNote).slice(0, 200) : 'checked against the current code and found to disagree'}`,
        factId,
      ).changes;
      results.push({ fact_id: factId, status: changed ? 'contradicted' : 'already_contradicted' });
      continue;
    }

    // 'confirmed' (the default when nothing else is said): clear the flag, and refresh each
    // anchor's fingerprint/sketch to the CURRENT body via the exact same mechanism revalidate.js
    // uses — checkAnchor already computes that refresh payload as part of deciding the anchor is
    // still `unconfirmed`; reusing it here is one mechanism, not a second one built to match.
    practiceDb.prepare('UPDATE facts SET unconfirmed_since = NULL WHERE id = ?').run(factId);
    if (graphDb) {
      for (const anchor of practiceDb.prepare('SELECT * FROM anchors WHERE fact_id = ?').all(factId)) {
        try {
          const result = checkAnchor(anchor, { graphDb, branchCache });
          if (result.refresh) applyAnchorRefresh(practiceDb, anchor, result.refresh);
        } catch { /* refreshing the anchor is a convenience; confirming the fact already happened */ }
      }
    }
    results.push({ fact_id: factId, status: 'confirmed' });
  }
  return { status: 'batch', batch: true, results };
}

function rememberFact(practiceDb, graphDb, opts = {}) {
  const {
    body: rawBody, kind = 'law', symbol = null, file = null, repo = null,
    cwd = process.cwd(), source = 'user', tier = null, evidence = {}, now = new Date(),
    // Set only by an agent that just read the current code and judged whether the rule it is
    // about to store still holds. Not a raw tier override — the caller states a VERDICT and the
    // verdict decides the authority, the same way `located.missing` already decides it for an
    // absent referent. A 'contradicted' rule is stored (never a silent drop — the point is to make
    // the disagreement visible) but withheld from delivery exactly like an unanchored fact.
    // 'unverifiable' is not the same as unchecked: it means the agent looked and could not tell,
    // which must never carry the same authority as a rule that was actually confirmed.
    verified = null,
    // The agent's own account of what it found, alongside `verified`. Carried in evidence.detail,
    // which recall.js already neutralises before delivery — no new sanitisation path needed.
    note = null,
  } = opts;

  // `confirm`/`verified` targeting an EXISTING fact id. Triggered only by `fact_id` or
  // `confirm:true` being present — a call that passes neither is completely unaffected, by
  // construction. Facts only: an open_loop never gets a `confirm`, only `resolve` — its anchor is
  // for finding it, not for judging it — so this dispatch runs before the open_loop branch below.
  if (opts.fact_id != null || opts.confirm === true) {
    let factIds;
    if (opts.fact_id != null) {
      const raw = Array.isArray(opts.fact_id) ? opts.fact_id : [opts.fact_id];
      factIds = raw.map(Number);
      if (!factIds.length || factIds.some((n) => !Number.isFinite(n))) {
        return rejected('fact_id must be an integer or a non-empty array of integers');
      }
    } else {
      // The coordinate-convenience form: only enough to identify a target when exactly one
      // flagged fact exists at that anchor. Ambiguous or empty is a rejection, not a guess.
      let coordRepoId = null;
      if (repo) {
        coordRepoId = `local:${repoNameOf(repo) || repo}`;
      } else {
        ({ repoId: coordRepoId } = repoIdentity(cwd));
      }
      if (!coordRepoId) {
        return rejected('confirm needs a fact_id, or "repo"/a git checkout plus symbol/file naming the single flagged fact to resolve');
      }
      if (!symbol && !file) {
        return rejected('confirm needs a fact_id, or a symbol/file naming the single flagged fact to resolve');
      }
      const filePath = symbol ? null : repoRelative(null, file);
      const flagged = practiceDb.prepare(
        `SELECT DISTINCT f.id FROM facts f JOIN anchors a ON a.fact_id = f.id
          WHERE f.expired_at IS NULL AND f.unconfirmed_since IS NOT NULL AND a.repo_id = ?
            AND ((? IS NOT NULL AND a.symbol_name = ?) OR (? IS NULL AND ? IS NOT NULL AND a.file_path = ? AND a.grain = 'file'))`,
      ).all(coordRepoId, symbol || null, symbol || null, symbol || null, filePath, filePath);
      if (!flagged.length) {
        return rejected('no flagged (unconfirmed) fact found at that coordinate — pass fact_id explicitly, or it may already be confirmed');
      }
      if (flagged.length > 1) {
        return rejected(`${flagged.length} flagged facts exist at that coordinate (ids: ${flagged.map((r) => r.id).join(', ')}) — pass fact_id to say which one(s)`);
      }
      factIds = [flagged[0].id];
    }
    return confirmFacts(practiceDb, graphDb, { factIds, verified, note, now });
  }

  // Open loops enter through the same one write door — that is the point, one writer — but they are
  // NOT facts: they anchor to no code, expire on completion not on drift, and are delivered as
  // context not instruction (012_open_loops.sql). So the dispatch is here, at the very entrance,
  // before any of the facts machinery runs; nothing in promote/revalidate/recall ever sees an open
  // loop, and no `if (kind === 'open_loop')` is threaded through them.
  if (kind === 'open_loop') {
    const ol = require('./open-loops');
    if (opts.resolve) {
      return ol.resolveLoop(practiceDb, {
        id: opts.loop_id ?? null, body: rawBody, cwd, reason: 'agent', now,
      });
    }

    // A situational note names what it's about the same way a rule does, when it names one — the
    // exact same targeting logic below (same lookup, same symbol/file/repo grain fallback).
    // Resolution failures here never fail the loop: the note is the valuable part, and a graph
    // that is busy or missing just means it opens repo-grain, same as a fact would with no graph.
    let loopRepoRoot = null;
    let loopRepoId = null;
    let loopBranch = null;
    if (repo) {
      loopRepoId = `local:${repoNameOf(repo) || repo}`;
      if (graphDb) {
        try { loopBranch = resolveBranch(graphDb, { repoName: String(repo) }); } catch { loopBranch = null; }
        if (loopBranch && loopBranch.repoRoot) {
          loopRepoRoot = loopBranch.repoRoot;
          loopRepoId = identityOfCheckout(loopRepoRoot) || loopRepoId;
        }
      }
    } else {
      ({ repoRoot: loopRepoRoot, repoId: loopRepoId } = repoIdentity(cwd));
      if (loopRepoId && graphDb) {
        try {
          loopBranch = resolveBranch(graphDb, {
            repoId: loopRepoId, repoName: repoNameOf(loopRepoId), repoRoot: loopRepoRoot,
          });
        } catch { loopBranch = null; }
      }
    }

    const result = ol.openLoop(practiceDb, {
      // Unlike a fact, an open loop's `source` is pure provenance — never read for authority or
      // delivery weight (nothing in open-loops.js/loop-anchors.js/render.js branches on it) — so
      // the fact path's "leave null rather than forge 'user'" caution does not apply here. Coalesce
      // to the schema's own intended default: the MCP handler always passes an explicit `null` when
      // the caller omits `source` (its schema literally says "omit if unsure"), and `open_loops.source`
      // is NOT NULL with no ambient default fallback for an explicit NULL — SQLite only applies a
      // column DEFAULT when the column is omitted from the INSERT entirely, not when NULL is given
      // explicitly. Without this coalesce, the common "no source given" open_loop call crashes with
      // a raw SqliteError instead of opening the note.
      body: rawBody, cwd, source: source || 'user', sessionId: opts.sessionId ?? null, now,
      repoId: loopRepoId || undefined,
    });

    // Surfaced in the result even on failure — a caller that named a symbol/file and got back
    // silence has no way to tell "anchored" from "the graph didn't have that referent" apart from
    // reading loop_anchors directly. The fact path already reports this (status:"unanchored"); the
    // open_loop path carries the same signal here for the same reason.
    if (result.status !== 'rejected' && (symbol || file) && result.id) {
      result.anchored = false;
      try {
        const located = targetFor({
          graphDb, branch: loopBranch, repoId: result.repo_id || loopRepoId,
          repoRoot: loopRepoRoot, symbol, file, body: rawBody,
        });
        if (located.anchored && located.target && located.target.grain !== 'repo') {
          const { anchorsFor } = require('./promote');
          const { anchorLoop } = require('./loop-anchors');
          anchorLoop(practiceDb, result.id, anchorsFor(located.target, { graphDb, branch: loopBranch }));
          result.anchored = true;
        } else {
          result.missing = located.missing || (graphDb ? 'file' : 'no_graph');
        }
      } catch { result.missing = 'error'; /* anchoring a loop is best-effort; the loop's own write already succeeded */ }
    }
    return result;
  }

  if (!WRITEABLE_KINDS.includes(kind)) {
    return rejected(`unknown kind "${kind}" (expected one of ${WRITEABLE_KINDS.join(', ')})`);
  }

  // Redacted and flattened before storage, not at delivery. A rule a developer types can carry a
  // token they pasted a moment earlier, and this store is durable and never auto-deleted.
  const body = neutralise(rawBody, MAX_BODY);
  if (body.length < MIN_BODY) return rejected('body too short to be a useful rule');

  // Every READ tool on this surface accepts a project/repo scope so the caller's cwd never has
  // to be inside the checkout it's asking about. `remember` is a write, but the same mismatch
  // applies: an agent's session cwd is often a workspace root, a notes directory, or a totally
  // unrelated project, not a checkout of the repo the fact is actually about. `repo` lets the
  // caller name the TARGET explicitly instead of the tool silently assuming cwd == target and
  // rejecting the write with no way to say what it actually meant.
  // resolveBranch THROWING (a busy/locked graph.db — routine right after ingest, while co-change
  // mining still holds a write lock in the background) must never be treated the same as "no
  // graph at all". Both used to fall into the same catch and leave branch=null, and targetFor
  // reads a null branch as license to answer anchored:true with the raw hint unchecked — a rule
  // naming a file that does not exist anywhere in the graph came back "✓ Saved ... anchored to
  // <path>" with no warning, silently defeating the entire point of anchoring. A thrown error is
  // reported as a transient failure instead, never silently downgraded to an unverified "yes".
  let repoRoot, repoId, branch = null;
  if (repo) {
    if (!graphDb) return rejected('no code graph — cannot resolve the "repo" argument without one');
    try {
      branch = resolveBranch(graphDb, { repoName: String(repo) });
    } catch (e) {
      return rejected(`could not check the graph (${e.message}) — likely busy mid-ingest; try again in a moment`);
    }
    if (!branch) {
      return rejected(`no repository named "${repo}" is in the graph — run overview to see the names in this store`);
    }
    repoRoot = branch.repoRoot;
    // The same identity repoIdentity(cwd) would compute if the caller WERE standing in this
    // checkout — read from the resolved repo's own path, not the caller's cwd, so a fact
    // authored this way anchors and revalidates identically to one authored locally.
    repoId = (repoRoot && identityOfCheckout(repoRoot)) || `local:${repoNameOf(repo) || repo}`;
  } else {
    ({ repoRoot, repoId } = repoIdentity(cwd));
    if (!repoId) return rejected('not inside a git repository — pass "repo" to name the target repository explicitly');
    if (graphDb) {
      try {
        branch = resolveBranch(graphDb, { repoId, repoName: repoNameOf(repoId), repoRoot });
      } catch (e) {
        return rejected(`could not check the graph (${e.message}) — likely busy mid-ingest; try again in a moment`);
      }
    }
  }

  const located = targetFor({ graphDb, branch, repoId, repoRoot, symbol, file, body });

  // An UNANCHORED fact is one whose author named a symbol or a file the graph does not have. It is
  // stored, because reporting it is the point of the import audit — but it must never be delivered,
  // and `law` is delivered above everything. It has nothing to drift against, so it cannot expire
  // either: left at law it would be pushed into every session forever, as an instruction, about
  // code that does not exist. That is precisely the failure this layer exists to prevent.
  //
  // `hypothesis` is the honest tier: the referent could not be verified, and a hypothesis never
  // reaches a reader — precision is structural. An explicit `tier` from the caller wins only for an
  // ANCHORED fact. A missing referent must demote to hypothesis EVEN WITH an explicit tier — the
  // passive correction channel (drainStated) always passes a tier, and without this a stated rule
  // naming code that does not exist would be delivered as law forever, unable to drift or expire:
  // the exact failure this layer exists to prevent. `located.missing` is set on precisely the
  // anchored:false paths in targetFor (a --symbol/file the graph lacks, or a body whose every named
  // repo symbol is absent), and never on the documented exceptions (dotted/substitution/repo-wide),
  // which return anchored:true — so those still keep the caller's tier.
  let resolvedTier;
  if (located.missing) {
    resolvedTier = 'hypothesis';
  } else {
    resolvedTier = tier || (located.anchored ? AUTHORED_TIER : 'hypothesis');
    // An ambiguous --symbol anchored to the best of several candidates: real, but not authoritative
    // law, since it may be tracking the wrong declaration. Delivered, but capped below law.
    if (located.ambiguous && TIER_RANK[resolvedTier] > TIER_RANK.observation) resolvedTier = 'observation';
  }

  // The agent's verdict, not the caller's say-so, decides authority from here. Two different
  // findings, two different treatments — conflating them would either bury the interesting one or
  // report noise as an incident:
  //   'unverifiable' — the agent could not check. This is `hypothesis`'s job already: honest
  //   silence, never delivered, structurally invisible even to `practice list --all`. A referent
  //   that could not be checked deserves exactly the same treatment as one that could not be found.
  //   'contradicted' — the agent DID check and the code disagrees. Silence is the wrong answer
  //   here: this is the one finding a human needs to see and settle, so it uses the same
  //   `contradicted_at` mechanism a manifest disagreement uses (011/repo-checks.js) — visible in
  //   `practice list` as WITHHELD, withheld from recall, never auto-cleared (the `imported:`/
  //   `checked:` reason prefix is never `manifest:`, so revalidate's clear-on-agreement never
  //   touches it).
  if (verified && !VERIFIED_VALUES.includes(verified)) {
    return rejected(`unknown verified "${verified}" (expected one of ${VERIFIED_VALUES.join(', ')})`);
  }
  if (verified === 'unverifiable' && TIER_RANK[resolvedTier] > TIER_RANK.observation) {
    resolvedTier = 'observation';
  }

  const lesson = {
    body,
    kind,
    tier: resolvedTier,
    source,
    targets: [located.target],
    // Authored facts are not weighed. `weight` scores what a lesson COST to learn, and a stated
    // rule cost nothing to learn and is not therefore cheap — readers COALESCE NULL to the
    // surfacing threshold, so unmeasured passes and measured-cheap does not (006_weight.sql).
    weight: null,
    evidence: {
      authored: true,
      stated_symbol: symbol || null,
      stated_file: file || null,
      anchored: located.anchored,
      missing: located.missing || null,
      ambiguous: located.ambiguous || 0,
      verified: verified || null,
      detail: note || null,
      ...(evidence && typeof evidence === 'object' ? evidence : {}),
    },
  };

  const { factIds } = promoteLessons(practiceDb, graphDb, [lesson], { now, source });
  if (!factIds.length) return rejected('produced no anchor');
  const factId = factIds[0];

  if (verified === 'contradicted') {
    try {
      if (practiceDb.pragma('table_info(facts)').some((c) => c.name === 'contradicted_at')) {
        // The same landing spot for every "this is now false" verdict, whoever raises it —
        // korainit importing a rule, a live session, or a `confirm` call against an existing
        // flagged fact. Clearing unconfirmed_since here too: a fact judged false is not ALSO
        // pending re-confirmation, that question is moot once an agent has actually looked.
        //
        // The prefix reflects WHERE this verdict actually came from — `imported:` only when
        // `source` says so, `checked:` otherwise (a live first-hand statement immediately found to
        // disagree) — never a blanket `imported:` regardless of provenance, which would make
        // `practice list`/`why` claim import provenance for a fact nobody ever imported.
        practiceDb.prepare(
          'UPDATE facts SET contradicted_at = ?, contradicted_reason = ?, unconfirmed_since = NULL WHERE id = ?',
        ).run(
          now.toISOString(),
          `${source === 'import' ? 'imported' : 'checked'}: ${note ? String(note).slice(0, 200) : 'checked against the current code and found to disagree'}`,
          factId,
        );
      }
    } catch { /* an older store without the column just keeps the fact at full authority */ }
  }

  const anchor = anchorRow(practiceDb, factId);
  const superseded = [];
  if (anchor) {
    for (const prior of findSuperseded(practiceDb, {
      repoId,
      filePath: anchor.file_path,
      symbolName: anchor.symbol_name,
      body,
      excludeId: factId,
    })) {
      if (supersede(practiceDb, factId, prior.id, { now })) {
        superseded.push({ fact_id: prior.id, body: prior.body, similarity: prior.similarity });
      }
    }
  }

  // A stated PREFERENCE ("use jest not vitest") must overturn the opposite live rule with the SAME
  // authority the correction channel uses, or "always use vitest, never jest" stays live beside its
  // negation. `stated:` outranks a weaker `manifest:` contradiction and is never auto-cleared by
  // revalidate's clear-when-agreeing-again, so it cannot be resurrected. No-op unless the body
  // parses as a preference, so it is safe to run for every authored fact.
  try {
    const { supersedeLive } = require('./stated');
    supersedeLive(practiceDb, { body, cwd, repoId, now });
  } catch { /* best-effort; never fail a write over a contradiction sweep */ }

  return {
    status: located.anchored ? 'stored' : 'unanchored',
    fact_id: factId,
    tier: resolvedTier,
    kind,
    repo_id: repoId,
    missing: located.missing || null,
    ambiguous: located.ambiguous || 0,
    verified: verified || null,
    anchor: anchor
      ? {
        file: anchor.file_path || null,
        symbol: anchor.symbol_name,
        owner: anchor.symbol_owner,
        kind: anchor.symbol_kind,
        grain: anchor.grain,
      }
      : null,
    superseded,
  };
}

// stated_rules (stated.js#pendingStated) is an audit trail only: nothing auto-promotes a staged
// row into a full-authority fact. Silently minting a `law`-tier fact from a heuristic keyword
// match is exactly the failure mode a durable-memory layer must avoid. The developer's statement
// is captured for real by the AGENT itself calling `remember`, on the same turn, reacting to the
// nudge context.mjs surfaces — never by a classifier guessing intent from prompt text.

module.exports = {
  rememberFact, targetFor, locateSymbol, confirmFacts,
  WRITEABLE_KINDS, AUTHORED_TIER, MAX_BODY, MIN_BODY, VERIFIED_VALUES,
};
