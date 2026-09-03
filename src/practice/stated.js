'use strict';

const { looksWorthRemembering } = require('./corrections');
const { neutralise } = require('./untrusted');

// The hook-side half of the correction channel. It runs on UserPromptSubmit, so its entire require
// graph must stay clear of graph.db — which is why this file cannot import author.js/promote.js.
// `corrections.js` has zero requires of its own for the same reason.
//
// This stages a CANDIDATE and nothing more — an audit record of what tripped the tripwire.
// Nothing here decides that something is true, decides its kind or tier, or promotes it into a
// fact: that decision belongs entirely to the agent, on the SAME turn, reacting to the nudge this
// triggers in context.mjs. Nothing here auto-promotes a staged row into a fact — see author.js for
// the mechanism that actually captures the developer's statement.

const MAX_BODY = 400;

// `confidence` still exists in the schema (010_stated.sql, NOT NULL, CHECK IN law/observation), but
// corrections.js does not classify prompts, so nothing here can populate it with a real verdict.
// Always 'observation': the less presumptuous of the two values, on a column kept only so this
// table's shape does not change out from under any existing reader. A future migration can drop it.
const UNCLASSIFIED_CONFIDENCE = 'observation';

const INSERT = `INSERT OR IGNORE INTO stated_rules
  (session_id, agent_id, repo_id, cwd, body, confidence, signals, captured_at)
  VALUES (?,?,?,?,?,?,?,?)`;


// A staged rule contradicts a live one when they name the SAME pair of tools in opposite
// directions: "use vitest, not jest" against "use jest, not vitest". That is a comparison of two
// parsed claims, not of two sentences, so a rephrasing still matches and an unrelated rule that
// happens to share a word does not.
//
// Marked with the `stated:` prefix so revalidation can tell it apart from a `manifest:`
// contradiction and does not clear it: a manifest agreeing again is evidence about a toolchain,
// and it says nothing about what the developer just told us.
const CONTRADICTION_PREFIX = 'stated: ';

const LIVE_REPO_LAWS = `
SELECT f.id, f.body, f.contradicted_at
  FROM anchors a JOIN facts f ON f.id = a.fact_id
 WHERE f.expired_at IS NULL AND a.grain = 'repo' AND a.repo_id = ?`;

function supersedeLive(db, { body, cwd, repoId, now }) {
  try {
    // The column only exists from 011. On an older store there is nothing to suppress and the
    // right behaviour is to stage the rule and say nothing.
    if (!db.pragma('table_info(facts)').some((c) => c.name === 'contradicted_at')) return 0;

    const { parsePreference } = require('./repo-checks');
    const fresh = parsePreference(body);
    if (!fresh) return 0;

    let id = repoId;
    if (!id && cwd) {
      try { ({ repoId: id } = require('./repo-identity').repoIdentity(cwd)); } catch { id = null; }
    }
    if (!id) return 0;

    // Also over an existing `manifest:` contradiction. A rule already withheld because package.json
    // disagreed would keep that reason, so the developer's own statement would be recorded nowhere —
    // and `revalidate` clears `manifest:%` contradictions when the repository agrees again, so
    // adding the tool back would RESURRECT a rule the developer had explicitly overturned, delivering
    // a rule and its negation in one injection, both as instructions to follow.
    //
    // A person outranks a manifest, so `stated:` overwrites `manifest:` and never the reverse.
    // Also clears unconfirmed_since: a live correction IS the agent's verdict that the old
    // rule is now false, the same landing spot korainit and `confirm`/`contradicted` use.
    const mark = db.prepare(`UPDATE facts SET contradicted_at = ?, contradicted_reason = ?, unconfirmed_since = NULL
                              WHERE id = ?
                                AND (contradicted_at IS NULL OR contradicted_reason LIKE 'manifest:%')`);
    let marked = 0;
    for (const row of db.prepare(LIVE_REPO_LAWS).all(id)) {
      const old = parsePreference(row.body);
      if (!old) continue;
      // Opposite directions on the same pair. Same direction is a restatement, not a conflict.
      if (old.prefer !== fresh.avoid || old.avoid !== fresh.prefer) continue;
      marked += mark.run(now.toISOString(),
        `${CONTRADICTION_PREFIX}the developer has since said to use ${fresh.prefer}, not ${fresh.avoid}`,
        row.id).changes;
    }
    return marked;
  } catch {
    return 0;                            // never break the prompt
  }
}

// Returns the row id, or null. Null is the common answer: most prompts are nothing worth a second
// glance, and the tripwire is built to say so.
function captureStated(db, input, { now = new Date() } = {}) {
  if (!db || !input || typeof input.prompt !== 'string') return null;

  const hit = looksWorthRemembering(input.prompt);
  if (!hit) return null;

  // Redacted and defanged HERE, at capture. `stated_rules` is durable and never auto-deleted (kept
  // as precision evidence), so a token the developer pasted a moment earlier would otherwise sit in
  // plaintext forever. `untrusted.js` has zero requires, so this stays hook-safe. Same
  // neutralisation the write door applies.
  const body = neutralise(hit.body, MAX_BODY);
  if (!body) return null;

  try {
    const res = db.prepare(INSERT).run(
      input.session_id || '',
      input.agent_id || null,
      input.repo_id || null,
      input.cwd || null,
      body,
      UNCLASSIFIED_CONFIDENCE,
      hit.signals && hit.signals.length ? JSON.stringify(hit.signals) : null,
      now.toISOString(),
    );
    // The rule is staged, but the fact it overturns is still LIVE and still being delivered, and
    // the drain that would replace it does not run until the next ingest. Suppressing it here is
    // the difference between a layer that listens and one that argues: without it, a developer who
    // types "actually we use jest now, not vitest" is told "we always use vitest here, never jest"
    // on the very next turn of the same session.
    supersedeLive(db, { body, cwd: input.cwd || null, repoId: input.repo_id || null, now });
    // changes === 0 is the dedupe index firing, which is a correct outcome and not an error: the
    // developer restated the same rule inside one session.
    return res.changes ? res.lastInsertRowid : null;
  } catch {
    // A capture that throws must never break the prompt. The whole layer is a bonus.
    return null;
  }
}

// The audit trail: what tripped the tripwire and has not been superseded/dedupe-coalesced.
// `promoted_at`/`fact_id`/`rejected_reason` remain in the schema (010_stated.sql), but nothing
// writes them — the agent that reacts to the nudge calls `remember` itself, through the normal
// write door, with no back-reference to the staging row that prompted it. This is a plain,
// still-useful read of what was staged, for a human or a future audit surface to inspect.
const PENDING = `SELECT id, session_id, agent_id, repo_id, cwd, body, confidence, captured_at
                   FROM stated_rules
                  WHERE promoted_at IS NULL AND rejected_reason IS NULL
                  ORDER BY captured_at, id
                  LIMIT ?`;

function pendingStated(db, { limit = 200 } = {}) {
  try { return db.prepare(PENDING).all(limit); } catch { return []; }
}

module.exports = {
  supersedeLive,
  CONTRADICTION_PREFIX, captureStated, pendingStated, MAX_BODY };
