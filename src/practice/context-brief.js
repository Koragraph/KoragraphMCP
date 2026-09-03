'use strict';

const { quoted } = require('./untrusted');
const { alreadyPushed } = require('./rituals');
const { repoIdentity } = require('./repo-identity');

// UserPromptSubmit: what the second layer already knows about the task the user just typed,
// injected before the agent takes its first action. Push, not pull.
//
// Deliberately does not try to guess which stored facts or open loops are relevant to the prompt's
// words — that guess goes wrong on a natural paraphrase, and worse, can confidently surface the
// WRONG note once a realistic number of notes exist. Relevance is instead read off the code itself
// (node-traversal delivery: an agent calling explore/neighbours/blast_radius/file_symbols on a
// piece of code sees what is known about THAT code), or off the session-start file block
// `practice sync` writes for a situation with no node to attach to.
//
// Rituals are not built here: the hook that calls `buildLawPush` below is Claude-Code-specific
// infrastructure (`UserPromptSubmit`, wired in `.claude/settings.json`), so anything delivered only
// through it is invisible to an agent on a different harness, or to this same agent with hooks off.
// Rituals live entirely in `practice sync`'s file output instead (sync.js#ritualLines), which
// reaches every agent. Laws are pushed through both the file and this hook regardless, deliberately
// redundant: the file pays for them on every turn, this push pays once per session, and a rule the
// developer stated is worth that extra channel. A ritual, recoverable by trying it, is not.
//
// `buildLawPush` below is session-conditioned, not prompt-conditioned, and the UserPromptSubmit
// hook (context.mjs) pushes it exactly once per session.
//
// Reads practice.db only — never graph.db. See recall.js.

// The stated half of the rulebook, and the reason a CLAUDE.md can shrink. These are repo-grain
// `law`-tier facts — rules the developer said outright or imported from an instruction file — and
// they are pushed ONCE per session rather than sitting resident in a file that is re-billed on
// every turn of every session. That is the entire token argument for this layer: the same
// sentences, paid once instead of three hundred times.
//
// Law tier only. An observation about the whole repository is a guess about the whole repository,
// and the rulebook is the one surface with no symbol to justify itself against.
// The law half gets its own budget rather than sharing the ritual one: a command shape is ~40
// chars and a stated rule is a sentence, so a single cap for both would silently starve whichever
// was rendered second.
const MAX_LAWS_SHOWN = 5;
const LAW_CHARS = 700;
const LAW_LEAD = 'Practice graph — rules stated for this repository. These ARE instructions and were'
  + ' given by the developer; follow them. `koragraph practice why <id>` shows who said it and when.';

const STATED_LAWS_SQL = `
SELECT f.id AS fact_id, f.body, f.kind, f.created_at, f.source
  FROM anchors a JOIN facts f ON f.id = a.fact_id
 WHERE f.expired_at IS NULL
   AND f.tier = 'law'
   AND a.grain = 'repo'
   AND a.repo_id = ?
   %CONTRADICTED%
 ORDER BY f.created_at DESC, f.id DESC
 LIMIT ?`;

// The SQL fetches a POOL, not the answer. Ordering in SQL can only rank on what a column holds,
// and the thing that decides whether a rule belongs in a rulebook -- does it instruct, does it
// stand alone -- is in the text. 60 is wide enough to cover a bulk-imported CLAUDE.md (156
// repo-grain rules here) without reading a whole store into memory on every session start.
const LAW_POOL = 60;

// This is the ONE surface that pushes a repo-grain law into every session unasked, so it is the
// surface a contradicted rule does most damage from. Probed rather than assumed: the clause is
// dropped on a store predating 011 rather than throwing, because statedLaws catches and returns
// [], and going silent would cost the developer their whole rulebook.
function contradictedClause(db) {
  try {
    return db.pragma('table_info(facts)').some((c) => c.name === 'contradicted_at')
      ? 'AND f.contradicted_at IS NULL' : '';
  } catch {
    return '';
  }
}

// Not through recallFor: that ranks against a symbol or a file and this question has neither. It
// is the same store, the same tier gate and the same expiry gate, asked without a subject.
function statedLaws(db, { repoId, now = new Date(), limit = MAX_LAWS_SHOWN, prompt = null } = {}) {
  if (!db || !repoId) return [];
  try {
    const pool = db.prepare(STATED_LAWS_SQL.replace('%CONTRADICTED%', contradictedClause(db)))
      .all(repoId, Math.max(limit, LAW_POOL));
    const { rankLaws } = require('./law-rank');
    const ranked = rankLaws(pool);
    // The cap only helps if the five that survive are the five that MATTER, and "matter" is a
    // property of the prompt — which this push happens on. With 50 stored rules the quality
    // ranker delivered five rules about logging while the one rule the task needed sat below the
    // cut (probed, not imagined: the dilution-test probe caught it before a single trial ran).
    // Boost is additive, so among relevant rules quality still decides, and with no prompt — the
    // status audit, the CLI — the ranking is unchanged.
    if (prompt) {
      const { relevanceBoost, distinctiveTokens } = require('./relevance');
      // Distinctiveness is a property of the whole pool, so it is computed once over every
      // candidate body — a token that names one rule's subject boosts that rule on a single match.
      const distinctive = distinctiveTokens(ranked.map((l) => l.body));
      for (const l of ranked) l.score += relevanceBoost(prompt, l.body, { distinctive });
      ranked.sort((a, b) => b.score - a.score
        || String(b.created_at || '').localeCompare(String(a.created_at || ''))
        || b.fact_id - a.fact_id);
    }
    return ranked.slice(0, limit);
  } catch {
    return [];
  }
}

function lawLine(f) {
  return `  ${quoted(f.body)} [p#${f.fact_id}]`;
}

// Quoted like every other stored string, because a rule imported from a file on disk is still text
// this layer did not write — but the lead above says plainly that these carry the developer's
// authority, which is the one place in this module where that is true.
function renderLaws(laws) {
  return [LAW_LEAD, ...laws.map(lawLine)].join('\n');
}

// Returns the text to inject, or null. Null is correct on a fresh store, on a repo with no history,
// and on the second prompt of a session — the rulebook does not change mid-session, and re-pushing
// it would re-bill it on every remaining turn.
function buildLawPush(db, {
  cwd = process.cwd(),
  sessionId = null,
  now = new Date(),
  maxLaws = MAX_LAWS_SHOWN,
  prompt = null,
} = {}) {
  const { repoId } = repoIdentity(cwd);
  if (!repoId) return null;
  if (sessionId && alreadyPushed(db, sessionId, repoId)) return null;

  const laws = statedLaws(db, { repoId, now, limit: maxLaws, prompt });
  if (!laws.length) return null;

  let lawText = renderLaws(laws);
  while (lawText.length > LAW_CHARS && laws.length > 1) {
    laws.pop();
    lawText = renderLaws(laws);
  }
  if (lawText.length > LAW_CHARS) return null;

  return { text: lawText, laws, repo_id: repoId };
}

// MAX_LOOPS_SHOWN/LOOP_CHARS/MAX_RITUALS_SHOWN/MAX_RITUAL_CHARS stay exported for `practice sync`'s
// file output (sync.js#ritualLines, #openLoopLines), which reuses these exact numbers for its own
// caps — "reuse those numbers, don't reinvent them" — even though nothing in this file uses the
// ritual pair itself.
const MAX_LOOPS_SHOWN = 3;
const LOOP_CHARS = 500;
const MAX_RITUALS_SHOWN = 3;
const MAX_RITUAL_CHARS = 320;

module.exports = {
  buildLawPush, renderLaws, statedLaws,
  MAX_RITUALS_SHOWN, MAX_RITUAL_CHARS, MAX_LAWS_SHOWN, LAW_CHARS,
  MAX_LOOPS_SHOWN, LOOP_CHARS,
};
