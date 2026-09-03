'use strict';

// Module-stem symbol index.
//
// The functions only ever look at a node's own source-file stem and a label
// string, so none of them are Python-specific — this
// file is language-neutral, for every language whose extractor stamps `properties.module`.
//
// Deliberately conservative: resolution only ever returns a candidate when the (stem, name)
// key has EXACTLY one match. That is the entire reason the pass this index feeds produces
// zero ambiguity refusals, unlike a name-fan-out plane.

const path = require('path');

// `module_name.strip(".").split(".")[-1]`. `.strip(".")` in Python strips ANY
// leading/trailing run of "." characters (not just a single dot); JS has no direct
// equivalent, hence the regex.
function moduleStem(moduleName) {
  if (!moduleName) return '';
  const stripped = String(moduleName).replace(/^\.+|\.+$/g, '');
  if (!stripped) return '';
  const parts = stripped.split('.');
  return parts[parts.length - 1];
}

// Normalises a callable label so a lookup key always agrees with an index key:
// `.strip().strip("()").lstrip(".").lower()`.
function normalizeLabel(label) {
  if (!label) return '';
  let s = String(label).trim();
  s = s.replace(/^[()]+|[()]+$/g, '');
  s = s.replace(/^\.+/, '');
  return s.toLowerCase();
}

// Path(source_file).stem. Accepts either `file_path` (the shape facts.js's own rows use) or
// a bare `path`, so the same function works whether it is fed through facts.js or invoked
// ad hoc.
function nodeSourceStem(row) {
  const sourceFile = row && (row.file_path || row.path || row.source_file);
  if (!sourceFile) return '';
  const base = path.posix.basename(String(sourceFile).replace(/\\/g, '/'));
  if (!base) return '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// Builds `Map<"stem::lowername", nodeId[]>` from a flat row list shaped
// { id, name, node_type, file_path|path }, as returned by a single query
// joining nodes to files scoped to CLASS/METHOD nodes.
function buildSymbolIndex(nodes) {
  const index = new Map();
  for (const node of nodes || []) {
    if (!node) continue;
    const stem = nodeSourceStem(node);
    if (!stem) continue;
    const label = normalizeLabel(node.name);
    if (!label) continue;
    const nodeId = node.id;
    if (nodeId === undefined || nodeId === null) continue;
    const key = `${stem}::${label}`;
    const list = index.get(key);
    if (list) list.push(nodeId); else index.set(key, [nodeId]);
  }
  return index;
}

// Resolves only when exactly one candidate exists for (stem, name); ambiguity returns null
// rather than guessing — this conservatism is the whole reason the pass this feeds yields 0
// ambiguity refusals. A call site cannot resolve to a declaration written in another
// language.
//
// normalizeLabel() lowercases, so without a language filter a JavaScript `.set(` call and a
// Go `func Set` would be the same key, and a JS call would resolve to a Go declaration at
// the EXTRACTED tier — the highest confidence the ladder issues.
//
// Families, not extensions, because several real languages span several suffixes and a few
// genuinely do call across them: a .ts call resolving into a .js declaration is normal, a C
// translation unit and its .h are one program, and an SFC's script block is JavaScript.
const LANGUAGE_FAMILIES = [
  ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro'],
  ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cu', 'cuh', 'm', 'mm'],
  ['py', 'pyi'],
  ['kt', 'kts', 'java'],
  ['rb', 'rake'],
  ['ex', 'exs'],
  ['ml', 'mli'],
  ['sh', 'bash', 'zsh'],
  ['res', 'resi'],
];

const FAMILY_OF = new Map();
LANGUAGE_FAMILIES.forEach((exts, i) => exts.forEach((e) => FAMILY_OF.set(e, `f${i}`)));

function languageFamily(filePath) {
  if (!filePath) return null;
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filePath));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  // An extension in no family is its own family -- go, rs, php, cs, scala, sol, zig, swift and
  // anything added later are all single-suffix languages, and defaulting them to "compatible with
  // everything" is exactly the hole this closes.
  return FAMILY_OF.get(ext) || ext;
}

// Unknown on EITHER side means "cannot tell", and cannot-tell must not reject: a node with no
// file row is not evidence of a language mismatch, and refusing it would silently delete real
// edges to make a precision number look better.
function sameLanguageFamily(a, b) {
  const fa = languageFamily(a);
  const fb = languageFamily(b);
  if (!fa || !fb) return true;
  return fa === fb;
}

function findUniqueSymbol(index, stem, name, opts = {}) {
  if (!index || !stem || !name) return null;
  const key = `${stem}::${normalizeLabel(name)}`;
  const candidates = index.get(key);
  if (!candidates || !candidates.length) return null;

  // A module stem is Path(file).stem, so `main.go` and `main.js` are the same key, and
  // normalizeLabel lowercases, so Go's `Set` and JavaScript's `set` are the same name.
  // Together that would resolve a JS call to a Go declaration at the module_stem tier —
  // which maps to EXTRACTED, the highest confidence the ladder issues.
  //
  // The filter runs BEFORE the uniqueness test, not after: a stem whose only candidate is in
  // another language must refuse, and a stem with two candidates of which exactly one shares the
  // caller's language is now resolvable where it previously refused.
  const { fileById, callSiteFile } = opts;
  const usable = fileById && callSiteFile
    ? candidates.filter((c) => sameLanguageFamily(callSiteFile, fileById.get(c)))
    : candidates;
  if (usable.length !== 1) return null;
  return usable[0];
}

// Unique-global-label fallback, with tie-breakers. Where the stem pass finds nothing, a bare
// call name with exactly one definition ANYWHERE in the branch — no source-file-stem qualification — is
// still resolvable. Weaker evidence than the stem pass (no import proves it), so callers
// must tier this INFERRED (see resolve.js#deriveConfidenceTier), never EXTRACTED.
//
// Applies exactly two ordered tie-breakers (non-test preference, then directory distance
// from the calling file), and refuses outright above 3 candidates rather than trying to
// disambiguate an arbitrarily large fan-out.

// Keyed on label ALONE (no source-file stem) — deliberately broader than buildSymbolIndex's
// per-stem key. Builds Map<normalizedLabel, nodeId[]> from the same CLASS/METHOD rows
// buildSymbolIndex consumes.
function buildLabelIndex(nodes) {
  const index = new Map();
  for (const node of nodes || []) {
    if (!node) continue;
    const label = normalizeLabel(node.name);
    if (!label) continue;
    const nodeId = node.id;
    if (nodeId === undefined || nodeId === null) continue;
    const list = index.get(label);
    if (list) list.push(nodeId); else index.set(label, [nodeId]);
  }
  return index;
}

// The same single-candidate conservatism applied to the label-only index: resolves ONLY
// when exactly one definition exists branch-wide for `name`. Ambiguity (0 or 2+) returns
// null. The ceiling + tie-breakers below are a SEPARATE, explicit escalation — not folded
// into this function — so a caller wanting the strict single-candidate behaviour has it
// available undiluted.
function findUniqueGlobalLabel(index, name) {
  if (!index || !name) return null;
  const candidates = index.get(normalizeLabel(name));
  if (!candidates || candidates.length !== 1) return null;
  return candidates[0];
}

// Port of paths.py:99-158 `_is_test_path` — case-insensitive, segment-aware:
// a whole path segment matching a known test-dir name, or a filename matching
// a known test-file naming convention across ecosystems.
const TEST_DIR_SEGMENTS = new Set(['tests', 'test', 'spec', 'specs', '__tests__']);
const TEST_FILENAME_PATTERNS = [
  /^test_.*/i,
  /.*_test\..+$/i,
  /.*\.test\..+$/i,
  /.*\.spec\..+$/i,
  /.*_spec\..+$/i,
  /.*\.tests\.ps1$/i,
  /.*Test\.java$/,
  /.*Tests\.java$/,
  /.*Tests\.cs$/,
];

function isTestPath(filePath) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);
  for (const seg of segments) {
    if (TEST_DIR_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  const filename = segments[segments.length - 1] || '';
  if (!filename) return false;
  for (const pattern of TEST_FILENAME_PATTERNS) {
    if (pattern.test(filename)) return true;
  }
  return false;
}

// Directory-segment distance between two files — 0 when they share a
// directory, rising by one for every segment that must be walked up/down to
// relate them. A single monotone distance the surviving candidates are
// compared on (ties refuse).
function directoryDistance(fileA, fileB) {
  const dirOf = (p) => {
    const norm = String(p || '').replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    return idx >= 0 ? norm.slice(0, idx) : '';
  };
  const a = dirOf(fileA).split('/').filter(Boolean);
  const b = dirOf(fileB).split('/').filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return (a.length - common) + (b.length - common);
}

// Port of paths.py:223 disambiguate_ambiguous_candidates, simplified (see
// file header). `fileById` maps a candidate node id -> its file path.
// Candidate counts of exactly 1 are trivially returned; > 3 refuse outright
// (the fan-out ceiling); 2-3 apply the two tie-breakers in order and refuse
// (null) whenever they do not converge on exactly one survivor.

function disambiguateGlobalLabel(candidates, fileById, callSiteFile) {
  if (!candidates || !candidates.length) return null;

  // Language first, and BEFORE the single-candidate shortcut. Applied after it, a lone
  // cross-language candidate is returned unexamined, which is precisely how one Go `Set` became
  // the target of 225 JavaScript and Python call sites.
  const byId = fileById || new Map();
  const sameLang = candidates.filter((c) => sameLanguageFamily(callSiteFile, byId.get(c)));
  if (!sameLang.length) return null;
  if (sameLang.length === 1) return sameLang[0];
  if (sameLang.length > 3) return null;
  candidates = sameLang;

  const nonTest = candidates.filter((c) => !isTestPath(byId.get(c)));
  const survivors = nonTest.length ? nonTest : candidates;
  if (survivors.length === 1) return survivors[0];

  let best = null;
  let bestDist = Infinity;
  let tie = false;
  for (const c of survivors) {
    const d = directoryDistance(callSiteFile, byId.get(c));
    if (d < bestDist) { bestDist = d; best = c; tie = false; }
    else if (d === bestDist) { tie = true; }
  }
  return tie ? null : best;
}

// Convenience wrapper combining "get all candidates for this label" with the
// ceiling + tie-breakers above — the shape resolve.js#resolveViaGlobalLabel
// actually calls. Returns a node id, or null (no candidates, or refused).
function findGlobalLabelWithTiebreakers(index, name, fileById, callSiteFile) {
  if (!index || !name) return null;
  const candidates = index.get(normalizeLabel(name));
  if (!candidates || !candidates.length) return null;
  return disambiguateGlobalLabel(candidates, fileById, callSiteFile);
}

// IMPORTS cross-file resolution. A suffix
// index over every known file's dot-joined, extension-stripped path segments
// (`src/myapp/models.py` -> keys `src.myapp.models`, `myapp.models`,
// `models`). Built once per branch. Exists for fully-qualified dotted imports
// (Java `import a.b.C;`, Kotlin, C#) that name a path relative to SOME source
// root this branch's file rows don't carry explicitly (`src/main/java/`, a
// monorepo package dir, ...) — matching by suffix sidesteps guessing that
// root instead of hardcoding one. `resolveDottedSuffixFile` refuses (returns
// null) on zero or on more than one match — same conservatism as
// findUniqueSymbol above, never picks an arbitrary root when more than one
// known file happens to share a suffix.
function buildDottedPathSuffixIndex(knownFilePaths) {
  const index = new Map();
  for (const p of knownFilePaths || []) {
    const stripped = String(p).replace(/\\/g, '/').replace(/\.[^./]+$/, '');
    const segs = stripped.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const key = segs.slice(i).join('.');
      const list = index.get(key);
      if (list) { if (!list.includes(p)) list.push(p); } else index.set(key, [p]);
    }
  }
  return index;
}

function resolveDottedSuffixFile(dottedKey, dottedPathSuffixIndex) {
  if (!dottedKey || !dottedPathSuffixIndex) return null;
  const matches = dottedPathSuffixIndex.get(dottedKey);
  if (!matches || matches.length !== 1) return null;
  return matches[0];
}

module.exports = {
  moduleStem,
  normalizeLabel,
  nodeSourceStem,
  buildSymbolIndex,
  findUniqueSymbol,
  buildLabelIndex,
  findUniqueGlobalLabel,
  isTestPath,
  directoryDistance,
  disambiguateGlobalLabel,
  findGlobalLabelWithTiebreakers,
  buildDottedPathSuffixIndex,
  sameLanguageFamily,
  languageFamily,
  resolveDottedSuffixFile,
};
