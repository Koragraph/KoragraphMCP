'use strict';

const crypto = require('crypto');

// Two different questions, two different signatures.
//
// `fingerprint` answers "is this byte-identical to what I saw" — drift detection. It is exact and
// therefore useless the moment anything changes, which is correct for drift and wrong for rename.
//
// `sketch` answers "is this the same code wearing a different name" — the re-resolution case.
// A rename edits the declaration line, and the declaration line is inside the body we hash, so an
// exact fingerprint ALWAYS misses on a rename, so it is a similarity with a stated threshold.

const SKETCH_SIZE = 64;
const SHINGLE_TOKENS = 3;

// Trailing whitespace and blank-line churn are not changes. Leading indentation IS — a re-indent
// that moves a block into a different scope is a real edit.
function normaliseLines(lines) {
  return lines.map((l) => String(l).replace(/\s+$/, '')).filter((l) => l.trim().length > 0);
}

function fingerprint(lines) {
  const text = normaliseLines(lines).join('\n');
  if (!text) return null;
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// FNV-1a, 32-bit. Deterministic across machines and node versions with no dependency, which is
// what matters when a sketch is compared to one stored months earlier.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Shingles are over TOKENS, not lines. On a 4-line function, 3-line shingles yield 2 shingles, a
// rename destroys one of them, and Jaccard reads 0.33 — indistinguishable from unrelated code.
// Short bodies are the common case (accessors, guards), so a line-grain sketch would have failed
// silently on exactly the symbols it is most needed for.
const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g;

function tokenise(lines) {
  return normaliseLines(lines).join('\n').match(TOKEN_RE) || [];
}

function sketch(lines) {
  const tokens = tokenise(lines);
  if (!tokens.length) return [];
  const shingles = new Set();
  const n = Math.max(1, tokens.length - SHINGLE_TOKENS + 1);
  for (let i = 0; i < n; i++) {
    shingles.add(hash32(tokens.slice(i, i + SHINGLE_TOKENS).join(' ')));
  }
  return [...shingles].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
}

// The bottom-k estimator, not Jaccard of the two truncated lists. Truncating each side
// independently and intersecting under-counts whenever either body is larger than SKETCH_SIZE:
// the k smallest of A and the k smallest of B are different windows of the hash space. Taking the
// k smallest of the UNION and asking how many of those are in both is the standard fix.
function similarity(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  const union = [...new Set([...sa, ...sb])].sort((x, y) => x - y).slice(0, SKETCH_SIZE);
  if (!union.length) return 0;
  let shared = 0;
  for (const h of union) if (sa.has(h) && sb.has(h)) shared++;
  return shared / union.length;
}

// From a structuredPatch hunk. `side` picks which version of the hunk the lines describe:
// 'old' is the pre-edit content (context + removals), 'new' is post-edit (context + additions).
// Mixing them binds a fact to whatever used to be there instead of the current declaration.
function hunkLines(hunk, side) {
  const out = [];
  for (const raw of hunk.lines || []) {
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === ' ') out.push(text);
    else if (marker === '-' && side === 'old') out.push(text);
    else if (marker === '+' && side === 'new') out.push(text);
    else if (marker !== '-' && marker !== '+' && marker !== ' ') out.push(raw);
  }
  return out;
}

module.exports = {
  fingerprint, sketch, similarity, hunkLines, normaliseLines, tokenise, hash32,
  SKETCH_SIZE, SHINGLE_TOKENS,
};
