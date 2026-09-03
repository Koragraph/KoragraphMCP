'use strict';

// Which stored rules matter for THIS prompt. Zero tokens, zero deps, deterministic.
//
// The rulebook is capped at five slots and law-rank.js fills them by rule QUALITY — who said it,
// does it instruct, does it stand alone. Nothing in that score knows what the developer is about
// to do. Probed before a single trial of the dilution test: with 50 stored rules and a prompt
// asking for an ava test of a 404, the five delivered rules were about logging and mutation, and
// the one rule about test assertions — the only one the task needed — ranked below the cap.
// That is the file's dilution failure reproduced inside the layer, one layer down.
//
// The published result this answers: instruction-following degrades with instruction count
// (IFScale, arXiv 2507.11538), which is why the cap exists. The cap only helps if the five that
// survive are the five that matter, and "matter" is a property of the prompt.
//
// Matching is deliberately dumb: lowercase content tokens, plural-s trimmed, and a prefix rule so
// `throws` meets `throwsAsync` and `assert` meets `asserting`. Two distinct matches minimum —
// one shared word is coincidence, two is topic. No model, no embeddings, same answer every run.

const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'never', 'always', 'must',
  'should', 'every', 'when', 'then', 'them', 'they', 'your', 'ours', 'into', 'onto', 'over',
  'under', 'here', 'there', 'have', 'has', 'been', 'will', 'would', 'could', 'not', 'nor',
  'for', 'are', 'was', 'were', 'any', 'all', 'its', 'it', 'a', 'an', 'of', 'to', 'in', 'on',
  'is', 'be', 'do', 'use', 'using', 'via', 'per', 'after', 'before', 'file', 'files', 'code',
  'repo', 'repository', 'project', 'change', 'changes', 'make', 'write', 'run', 'single', 'only']);

function tokens(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_.]+/)) {
    let t = raw.replace(/^[._]+|[._]+$/g, '');
    if (t.length < 4 || STOP.has(t)) continue;
    if (t.endsWith('s') && t.length > 4) t = t.slice(0, -1);
    out.add(t);
  }
  return out;
}

// A task names a concept as a NOUN ("add pagination", "write a migration") while the rule states
// it as a VERB/participle ("paginate", "migrate", "validate") — the tail changes, not just an
// appended suffix, so strict prefix-equality misses the whole family and the one relevant rule gets
// no boost, which under accumulation is the exact retention-dilution failure this rescue exists to
// prevent. `stemOf` collapses the REGULAR productive derivations (‑ation/‑ate, ‑ization/‑ize,
// ‑ing/‑ed, ‑ies/‑y, trailing ‑e) and matching requires stem EQUALITY, not a fuzzy shared prefix —
// no false matches on unrelated prefix-sharing pairs (service/serve, user/use, general/generate), so
// precision is preserved. The irregular ‑tion/‑sion verbs (deletion/delete, resolution/resolve) are
// deliberately left out: a prefix-fuzz wide enough to catch them also collapsed unrelated words, and
// a missed dedup boost is benign where a false one is not.
function stemOf(t) {
  let s = String(t);
  // `ie` as well as `ies`: tokens() has already trimmed a trailing plural `s`, so "retries" reaches
  // here as "retrie" — the `ies` rule would never fire without the shorter form.
  s = s.replace(/ies?$/, 'y');
  s = s.replace(/(?:ization|isation)$/, 'ize');
  s = s.replace(/ations?$/, 'ate');
  s = s.replace(/(?:ing|ed|es|s)$/, '');
  s = s.replace(/e$/, '');
  return s;
}

function matches(a, b) {
  if (a === b) return true;
  if (a.length >= 5 && b.startsWith(a)) return true;
  if (b.length >= 5 && a.startsWith(b)) return true;
  const sa = stemOf(a);
  if (sa.length >= 4 && sa === stemOf(b)) return true;
  return false;
}

// Tokens that are RARE across the stored rule corpus. "one shared word is coincidence" holds for a
// word that shows up in half the rulebook (request, service, database); it does NOT hold for a word
// that names exactly one rule's subject. A convention stated in jargon — "always use the expectError
// helper, never t.throwsAsync" — shares only a single such word ("test") with a natural task, and
// that one word is the whole topic. Measured live: without this the rule was delivered at session
// depth 1-3 and silently dropped at depth 4+ as generic imperatives accumulated above the cap.
// DF gate mirrors context-brief.js#contentMatch; the fraction guard keeps a tiny pool from calling
// everything distinctive.
function distinctiveTokens(bodies) {
  const df = new Map();
  for (const b of bodies) {
    for (const t of tokens(b)) df.set(t, (df.get(t) || 0) + 1);
  }
  const maxDf = Math.max(2, Math.ceil(bodies.length * 0.15));
  const out = new Set();
  for (const [t, n] of df) if (n <= maxDf) out.add(t);
  return out;
}

// 0 for fewer than two topical matches; then 4 per match up to three. Sized against law-rank's
// own scale (source:user is 3, leads-imperative is 4): two topical hits outrank any single
// quality signal, because a mediocre rule about the task at hand beats a beautiful rule about
// something else — but quality still breaks ties among the relevant.
//
// `opts.distinctive` (a Set from distinctiveTokens over the candidate pool) admits the one case two
// hits cannot: a single shared token that is rare in the corpus is topic, not coincidence. Callers
// with the whole pool in hand (statedLaws) pass it; a bare two-arg call keeps the strict ≥2 rule,
// so nothing that scored 0 before scores non-zero without the corpus saying the word is rare.
function relevanceBoost(promptText, ruleBody, { distinctive = null } = {}) {
  const p = tokens(promptText);
  if (!p.size) return 0;
  let hits = 0;
  let distinctiveHits = 0;
  for (const rt of tokens(ruleBody)) {
    for (const pt of p) {
      if (matches(rt, pt)) {
        hits += 1;
        if (distinctive && distinctive.has(rt)) distinctiveHits += 1;
        break;
      }
    }
    if (hits >= 3) break;
  }
  if (hits >= 2) return hits * 4;
  if (distinctiveHits >= 1) return 4;
  return 0;
}

module.exports = { relevanceBoost, tokens, distinctiveTokens };
