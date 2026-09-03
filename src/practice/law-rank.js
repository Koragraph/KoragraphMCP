'use strict';

// Which five of a hundred-odd repo-grain rules go into the once-per-session rulebook.
//
// Recency ordering (`ORDER BY created_at DESC LIMIT 5`) chooses the five most recently written,
// which after a bulk import means five arbitrary lines from the end of a file — mostly descriptions
// and truncated fragments, not instructions. That is what an agent is handed on turn one, and it is
// paid for in every session.
//
// The scoring below has no model in it and no notion of what any rule MEANS. It ranks on three
// things a rule either is or is not: somebody said it directly, it tells you to do something, and
// it makes sense on its own. Everything else is a tiebreak.

// Who put it there. A rule the developer typed is the highest-confidence signal this store will
// ever get; a rule that arrived as one of many lines from a markdown file is the weakest, because
// nobody chose it individually.
const SOURCE_WEIGHT = Object.freeze({ user: 3, hook: 2, seed: 0.5, harvest: 0.5, import: 0 });

// Does it tell you to do something? An instruction changes behaviour; a description does not, and
// descriptions are pure cost in every session for no gain.
//
// POSITION is most of the signal. Keyword presence alone misclassifies: "Both RUN behind
// soften(...)" reads as an instruction because `run` appears in it, while "No comments unless the
// WHY is non-obvious" reads as a description because it contains `is` and none of the keywords. A
// rule tends to LEAD with its verb; prose mentions the same word in passing.
const LEADING_IMPERATIVE = new RegExp(
  '^[^a-z]{0,12}(?:'
  + 'always|never|no|do not|don\'?t|must|avoid|prefer|use|reuse|keep|ensure|make sure|run|check'
  + '|verify|treat|put|write|record|state|refuse|require|read|stop|start|add|remove|delete|call'
  + '|only ever|every|any'
  + ')\\b', 'i',
);
const IMPERATIVE = /\b(?:always|never|must not|do not|don'?t|should|shall|prefer|avoid|reuse|ensure|make sure|refuse)\b/i;

// Does it stand alone? A fragment that ends mid-thought, or points at something not in the
// sentence, is unusable when it arrives on its own with no surrounding document.
const DANGLING_END = /[:;,]\s*$|\b(?:and|or|but|the|a|an|of|to|for|with|that|which|is|are|was|were)\s*$/i;
const NEEDS_CONTEXT = /\b(?:this way|the above|below|as follows|see above|see below|that said|it is|they are)\b/i;
const STARTS_MID = /^[a-z]/;

// Does it name something you could act on — a command, a path, a flag, a symbol?
const CONCRETE = /`[^`]+`|\b\w+\.(?:js|ts|py|go|java|md|json|ya?ml|sql|sh)\b|--\w[\w-]*|\b\w+\(\)/;

// Description verbs, counted only when nothing imperative is present. "X is Y" is a fact about the
// world; the rulebook is for instructions.
const DESCRIPTIVE = /\b(?:is|are|was|were|has|have|holds?|carries|contains?|lives? in|sits? in|records?|means?)\b/i;

const MIN_USEFUL = 25;
const MAX_USEFUL = 320;

function scoreLaw(row) {
  const body = String(row.body || '').trim();
  let score = 0;
  const why = [];

  const src = SOURCE_WEIGHT[row.source] ?? 0;
  if (src) { score += src; why.push(`source:${row.source}`); }

  // Stripped of markdown emphasis before the position test: `**Never** git add -A` leads with an
  // asterisk, and a rule should not lose its rank to bold.
  const bare = body.replace(/^[*_`#>\s-]+/, '');
  if (LEADING_IMPERATIVE.test(bare)) { score += 4; why.push('leads-imperative'); }
  else if (IMPERATIVE.test(body)) { score += 1; why.push('imperative'); }
  else if (DESCRIPTIVE.test(body)) { score -= 2; why.push('descriptive'); }

  // Self-containment. These are subtractions rather than a filter: a rule can be slightly awkward
  // and still worth delivering, and a hard filter on a regex would silently drop real rules.
  if (DANGLING_END.test(body)) { score -= 3; why.push('dangling'); }
  if (NEEDS_CONTEXT.test(body)) { score -= 2; why.push('needs-context'); }
  if (STARTS_MID.test(body)) { score -= 1; why.push('starts-mid'); }

  if (CONCRETE.test(body)) { score += 1; why.push('concrete'); }

  // Too short to say anything; too long to be read on every turn.
  if (body.length < MIN_USEFUL) { score -= 2; why.push('too-short'); }
  if (body.length > MAX_USEFUL) { score -= 1; why.push('too-long'); }

  return { score, why };
}

// Sorted best-first. Recency survives ONLY as the final tiebreak, which is what it was always
// suited for: among rules that score identically, the newer one is the better guess.
function rankLaws(rows) {
  return rows
    .map((r) => ({ ...r, ...scoreLaw(r) }))
    .sort((a, b) => b.score - a.score
      || String(b.created_at || '').localeCompare(String(a.created_at || ''))
      || b.fact_id - a.fact_id);
}

module.exports = { rankLaws, scoreLaw, SOURCE_WEIGHT };
