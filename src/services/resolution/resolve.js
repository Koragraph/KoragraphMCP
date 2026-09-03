'use strict';

// Import-evidence edge resolution.
//
// Only part of the resolution machinery is carried
// over:
//   - Path aliases (tsconfig paths/baseUrl, package.json exports, workspace packages) are
//     handled by the resolveImportNodeTarget tiers below; the CALLS resolvers here handle
//     only same-repo RELATIVE import specs (./x, ../x/y).
//   - Resolution is against files already present in this branch's node set (via nodes/files
//     joined at query time), not a second filesystem walk.
// The core invariant: resolve a call to a definition ONLY where an import proves the
// binding, uniquely; otherwise refuse and let the caller fall back to its own (lower-trust)
// heuristics.

const path = require('path');
const fs = require('fs');
const { moduleStem, findUniqueSymbol, findGlobalLabelWithTiebreakers, resolveDottedSuffixFile, normalizeLabel } = require('./symbol-index');

const RELATIVE_IMPORT_RE = /^\.{1,2}\//;

// Suffixes tried against a relative import spec that has no extension of its
// own (e.g. `./util` -> `./util.js`, `./util/index.ts`).
const CANDIDATE_SUFFIXES = [
  '', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue',
  '.py', '.go', '.java', '.rb', '.php', '.cs', '.kt', '.rs',
  '/index.js', '/index.ts', '/index.jsx', '/index.tsx', '/__init__.py',
];

// Python's relative-import syntax is dotted, not slashed: `from .exceptions import X`
// carries module ".exceptions" (one leading dot = the current package
// directory, each additional leading dot = one more directory up); `from
// ..foo.bar import X` carries "..foo.bar" (two dots = one directory up, then
// into foo/bar). RELATIVE_IMPORT_RE only matches the JS/TS/Go `./`/`../`
// spelling, so a python dotted-relative spec falls straight through it
// untouched. This converts the dotted spec to the equivalent slash-path spec
// so it goes through the SAME resolveRelativeImportPath suffix ladder below,
// not a parallel path. Returns null for anything that isn't a plain
// leading-dot(s) + dotted-identifier spec (so a non-python, non-relative
// spec like "fmt" or "react" is left alone) or for the bare-package-root form
// (`from . import x` — dots with no trailing module name — which names a
// directory, not a single file, and CANDIDATE_SUFFIXES has no reliable way to
// pick "the" file for a directory beyond the /__init__.py entry already
// tried by the normal ladder).
function pyDottedRelativeToSlashSpec(importSpec) {
  const dotsMatch = /^\.+/.exec(importSpec || '');
  if (!dotsMatch) return null;
  const dots = dotsMatch[0].length;
  const remainder = importSpec.slice(dots);
  if (remainder && !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(remainder)) return null;
  const upCount = dots - 1;
  const modParts = remainder ? remainder.split('.') : [];
  const parts = [...Array(upCount).fill('..'), ...modParts];
  if (!parts.length) return null;
  return (upCount > 0 ? '' : './') + parts.join('/');
}

// A compiled/bundled JS import spec (`import './x.js'`) is written against the .ts/.tsx
// SOURCE that produced it once the project builds. Only rewrite when the literal .js/.jsx
// path did NOT resolve above — this is a FALLBACK, not a preference. If a real `x.js` sits
// next to `x.ts`, the un-rewritten candidate already matched via the '' suffix earlier in
// the ladder and this function never runs, so `./foo.js` still resolves to `foo.js`, not
// `foo.ts`, when both exist.
function rewriteJsSpecToTs(candidatePath) {
  if (candidatePath.endsWith('.jsx')) return candidatePath.slice(0, -4) + '.tsx';
  if (candidatePath.endsWith('.js')) return candidatePath.slice(0, -3) + '.ts';
  return null;
}

// Resolves a relative import spec written inside `fromFilePath` against the
// set of file paths actually present in this branch. Returns the matched
// repo-relative path, or null when the spec is not relative (an external
// package — "fmt", "react", "com.foo.Bar" — is not evidence of anything in
// THIS repo, so guessing at it is refused) or no
// candidate path exists in `knownFilePaths`.
function resolveRelativeImportPath(fromFilePath, importSpec, knownFilePaths) {
  if (!fromFilePath || !importSpec) return null;
  let spec = importSpec;
  if (!RELATIVE_IMPORT_RE.test(spec)) {
    const converted = pyDottedRelativeToSlashSpec(spec);
    if (!converted) return null;
    spec = converted;
  }
  const fromDir = path.posix.dirname(fromFilePath.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = joined + suffix;
    if (knownFilePaths.has(candidate)) return candidate;
  }
  const rewritten = rewriteJsSpecToTs(joined);
  if (rewritten && knownFilePaths.has(rewritten)) return rewritten;
  return null;
}

// The real tier table lives in resolution/tiers.js — this is a thin delegate kept here so
// every existing `require('./resolution/resolve').deriveConfidenceTier` caller keeps working
// without an import-path change. It returns { tier, confidence, label }; read `.label` for
// the confidence_tier column.
const { deriveConfidenceTier } = require('./tiers');

// Attempts to resolve `toName` called from `fromNodeId` via real import
// evidence: does the caller's file import something whose resolved target
// file declares a node named `toName`, uniquely? Returns
// { targetId, resolution: 'import' } on a unique hit, or null (refuse to
// guess — caller falls back to its own name-matching heuristics, tagged
// with whatever resolution string describes THAT path, never 'import').
function resolveViaImportEvidence(fromNodeId, toName, fileIndex) {
  if (!fileIndex) return null;
  const fromFilePath = fileIndex.fileById.get(fromNodeId);
  if (!fromFilePath) return null;
  const fileImports = fileIndex.importsByFile.get(fromFilePath);
  if (!fileImports || !fileImports.length) return null;

  for (const imp of fileImports) {
    const moduleOnly = !imp.module || imp.module === imp.name;
    if (!moduleOnly && imp.name !== toName && imp.alias !== toName) continue;
    const targetFile = resolveRelativeImportPath(fromFilePath, imp.module || imp.name, fileIndex.knownFilePaths);
    if (!targetFile) continue;
    const targetName = imp.alias === toName ? imp.name : toName;
    const decls = fileIndex.declByFileAndName.get(targetFile)?.get(targetName);
    if (decls && decls.length === 1 && decls[0].id !== fromNodeId) {
      return { targetId: decls[0].id, resolution: 'import' };
    }
  }
  return null;
}

// Resolves a receiver-qualified call (`Bar.baz()`) whose receiver token could not be bound
// same-file but IS an import alias in the caller's own file — the accessor-branch analogue
// of resolveViaImportEvidence above: same "import proves the binding, uniquely, or refuse"
// contract, applied to the RECEIVER instead of the bare callee name. `receiverName` is
// carried on the pendingEdge; this function never sees the whole pendingEdges array, just
// one edge's fields, so it composes with the waterfall exactly like
// resolveViaImportEvidence/resolveViaModuleStem do.
//
// Import-alias match mirrors resolveViaModuleStem's own check (`imp.name` OR `imp.alias` —
// an aliased import's LOCAL binding, per facts.js's `{name, alias, module}` shape). Once the
// binding import is found, its module spec is resolved to a real file two ways, tried in the
// same order resolveImportNodeTarget already uses for the identical "module + name -> file"
// problem: (1) a same-repo relative path (`./b`, `../x/y`), then (2) a dotted FQN suffix
// match (Java/Kotlin/C#: `import a.b.Bar;` -> file suffix `a.b.Bar`) for the case
// resolveRelativeImportPath structurally cannot handle (non-slash specs). `calleeName` is
// then looked up ONLY in that one resolved file — a unique hit is proof (tier 6); more than
// one declaration, or none, refuses and lets the waterfall fall through to module-stem /
// global-label / the name-matching fan-out, same conservatism as every resolver in this file.
//
// base.js#resolveCall's own accessor branch ALREADY intercepts a single-token receiver that
// matches a same-file import alias BEFORE it ever reaches unresolvedCalls (it emits a direct
// CALLS structuralEdge to the IMPORT node instead). So a plain `receiverName === alias`
// exact match here would only ever fire for a receiver shape no CURRENT extractor produces.
// The receiverName shape that ACTUALLY reaches this resolver via a real accessor call is the
// NESTED one — a multi-level member access (`B.Bar.baz()`) whose object text is the full
// dotted chain ("B.Bar"), which does not equal the single-token alias key ("B") and so
// base.js's own short-circuit does not catch it. Handling only the exact token would leave
// this resolver dead code on every live extractor; trying the leading dot-segment too
// (`import * as B from './b'; B.Bar.baz()` -> receiverName === 'B.Bar') is what makes it
// reachable, at the SAME evidence quality resolveViaImportEvidence already accepts for a bare
// callee name (a flat, unscoped lookup in the one file the import proves — this resolver does
// not verify `calleeName` belongs to the dotted chain's SPECIFIC class).
//
// Returns { targetId, resolution: 'receiver_import' } or null.
function resolveViaReceiverImport(fromNodeId, receiverName, calleeName, fileIndex) {
  if (!fileIndex || !receiverName || !calleeName) return null;
  const fromFilePath = fileIndex.fileById.get(fromNodeId);
  if (!fromFilePath) return null;
  const fileImports = fileIndex.importsByFile.get(fromFilePath);
  if (!fileImports || !fileImports.length) return null;

  const tokens = receiverName.includes('.')
    ? [receiverName, receiverName.split('.')[0]]
    : [receiverName];

  for (const token of tokens) {
    for (const imp of fileImports) {
      if (imp.name !== token && imp.alias !== token) continue;
      if (!imp.module) continue;
      const targetFile = resolveRelativeImportPath(fromFilePath, imp.module, fileIndex.knownFilePaths)
        || resolveDottedSuffixFile(`${imp.module}.${imp.name}`, fileIndex.dottedPathSuffixIndex);
      if (!targetFile) continue;
      const decls = fileIndex.declByFileAndName.get(targetFile)?.get(calleeName);
      if (decls && decls.length === 1 && decls[0].id !== fromNodeId) {
        return { targetId: decls[0].id, resolution: 'receiver_import' };
      }
    }
  }
  return null;
}

// Resolves a receiver-qualified call whose receiver is neither same-file nor an import
// alias, but IS a declared field of the CALLING method's own enclosing class —
// `svc.doWork()` where `private FooService svc;` is a class member. Bounded, no flow
// analysis: only DECLARED field types (java.js's `field_declaration`, typescript.js's
// `public_field_definition` + constructor parameter properties) are consulted, never
// inferred/assigned types. Tried in the same waterfall slot as resolveViaReceiverImport,
// AFTER it — receiver-import is stronger evidence: the receiver token itself is proven by an
// import, where this tier only proves the receiver's DECLARED type, one hop further removed.
//
// `receiverName` may carry a `this.`-qualified prefix (TypeScript always requires it:
// `this.svc.method()`) or be a bare single token (Java allows unqualified field access:
// `svc.doWork()`) — `_fieldNameFromReceiver` below normalises both to the plain field name.
// A multi-segment receiver with NO `this.` prefix (`B.Bar.baz()`) is a namespace/import
// shape, not a field access — the receiver-import rung owns that, this function refuses it
// outright (returns null before ever consulting `classFieldsById`).
//
// Two tiers, tried in order (tier 3 = 0.88, tier 4 = 0.72 — both narrower/weaker than tier
// 6's 0.85 receiver-import, consistent with receiver-import being tried first in the
// waterfall):
//   3. receiver_type_import — the caller's OWN file imports the field's
//      declared type; resolve that import to a real file (same relative-path
//      / dotted-FQN-suffix ladder resolveViaReceiverImport already uses) and
//      look up `calleeName` there, uniquely. Import-proven, same evidence
//      quality band as resolveViaImportEvidence's tier-3 'import'.
//   4. receiver_type_global — no import evidence for the type, but exactly
//      ONE CLASS anywhere in the branch is named exactly that (case-sensitive
//      — a declared type name is a real identifier, not a fuzzy label,
//      `classNodesByName` deliberately skips normalizeLabel); look up
//      `calleeName` in THAT class's file, uniquely. Weaker: the type itself
//      is a guess among branch-wide same-named classes, not import-proven.
// Ambiguity at either step (2+ candidates, or 0) refuses and falls through —
// same conservatism as every other resolver in this file.
//
// Returns { targetId, resolution: 'receiver_type_import'|'receiver_type_global' }
// or null.
function _fieldNameFromReceiver(receiverName) {
  if (!receiverName) return null;
  if (receiverName.startsWith('this.')) return receiverName.slice(5) || null;
  if (receiverName.includes('.')) return null; // namespace/nested receiver — 1e's shape, not a field access
  return receiverName;
}

function resolveViaReceiverType(fromNodeId, receiverName, calleeName, fileIndex) {
  if (!fileIndex || !receiverName || !calleeName) return null;
  const fieldName = _fieldNameFromReceiver(receiverName);
  if (!fieldName) return null;

  const classId = fileIndex.methodParentClassId && fileIndex.methodParentClassId.get(fromNodeId);
  if (classId === undefined || classId === null) return null;
  const fields = fileIndex.classFieldsById && fileIndex.classFieldsById.get(classId);
  if (!fields || !fields.length) return null;
  const field = fields.find((f) => f && f.name === fieldName);
  if (!field || !field.type) return null;
  const typeName = field.type;

  // Tier 3: caller's own file imports the field's declared type.
  const fromFilePath = fileIndex.fileById.get(fromNodeId);
  const fileImports = fromFilePath ? fileIndex.importsByFile.get(fromFilePath) : null;
  if (fromFilePath && fileImports && fileImports.length) {
    for (const imp of fileImports) {
      if (imp.name !== typeName && imp.alias !== typeName) continue;
      if (!imp.module) continue;
      const targetFile = resolveRelativeImportPath(fromFilePath, imp.module, fileIndex.knownFilePaths)
        || resolveDottedSuffixFile(`${imp.module}.${imp.name}`, fileIndex.dottedPathSuffixIndex);
      if (!targetFile) continue;
      const decls = fileIndex.declByFileAndName.get(targetFile)?.get(calleeName);
      if (decls && decls.length === 1 && decls[0].id !== fromNodeId) {
        return { targetId: decls[0].id, resolution: 'receiver_type_import' };
      }
    }
  }

  // Tier 4: exactly one CLASS branch-wide named `typeName`, no import needed.
  const classCandidates = fileIndex.classNodesByName && fileIndex.classNodesByName.get(typeName);
  if (classCandidates && classCandidates.length === 1) {
    const typeFilePath = classCandidates[0].filePath;
    const decls = typeFilePath && fileIndex.declByFileAndName.get(typeFilePath)?.get(calleeName);
    if (decls && decls.length === 1 && decls[0].id !== fromNodeId) {
      return { targetId: decls[0].id, resolution: 'receiver_type_global' };
    }
  }
  return null;
}

// The module-stem pass. Deliberately kept language-neutral (works for any
// extractor that stamps `properties.module`/`alias` on its IMPORT nodes), not Python-only.
//
// Resolves `callName` called from `fromNodeId` by: finding the caller's own file's import
// whose bound name (`name` or `alias`) is `callName`, taking that import's module stem, and
// looking up the UNIQUE (stem, import.name) symbol in the branch-wide `symbolIndex` (built
// from CLASS/METHOD nodes by facts.js#buildFileScopedIndex). `import.name` — the import's OWN
// true name — not `callName`, so an aliased import (`from x import y as z;
// z()`) still keys the symbol index on `y`, its real declared name.
//
// Returns { targetId, resolution: 'module_stem' } on a unique hit, or null
// (refuse to guess — same conservatism as resolveViaImportEvidence; ambiguity
// is findUniqueSymbol's job, not this function's).
function resolveViaModuleStem(fromNodeId, callName, fileIndex, symbolIndex) {
  if (!fileIndex || !symbolIndex) return null;
  const fromFilePath = fileIndex.fileById.get(fromNodeId);
  if (!fromFilePath) return null;
  const fileImports = fileIndex.importsByFile.get(fromFilePath);
  if (!fileImports || !fileImports.length) return null;

  for (const imp of fileImports) {
    if (imp.name !== callName && imp.alias !== callName) continue;
    if (!imp.module) continue;
    const stem = moduleStem(imp.module);
    if (!stem) continue;
    const targetId = findUniqueSymbol(symbolIndex, stem, imp.name,
      { fileById: fileIndex.fileById, callSiteFile: fromFilePath });
    if (targetId !== null && targetId !== undefined && targetId !== fromNodeId) {
      return { targetId, resolution: 'module_stem' };
    }
  }
  return null;
}

// The global-label fallback, tried THIRD, only when both the import-evidence pass and the
// module-stem pass miss: a bare call name with a unique-or-tie-broken definition anywhere in
// the branch (symbol-index.js#findGlobalLabelWithTiebreakers — ceiling of 3 candidates,
// non-test preference then directory distance). Weaker than module-stem — no import proves
// the binding — so deriveConfidenceTier's default branch tiers it INFERRED, never EXTRACTED.
//
// Tier split: global-label unique -> 7 / tie-broken -> 8 — any branch that picks among >1
// candidates by anything other than proof is 8. findGlobalLabelWithTiebreakers collapses
// both cases into one opaque node id, so a truly unique label and a label disambiguated by
// non-test-preference/directory-distance heuristics (disambiguateGlobalLabel) would be
// indistinguishable to the caller and every global_label edge would land at tier 7. The raw
// candidate count is re-checked here (before tie-breaking) — a cheap, already-built Map
// lookup, no change to disambiguateGlobalLabel's return shape.
//
// Returns { targetId, resolution: 'global_label' | 'global_label_tiebreak' }
// on a resolved hit, or null (refuse to guess — same conservatism as the
// other two passes).
function resolveViaGlobalLabel(fromNodeId, callName, fileIndex, labelIndex) {
  if (!fileIndex || !labelIndex) return null;
  const fromFilePath = fileIndex.fileById.get(fromNodeId);
  const targetId = findGlobalLabelWithTiebreakers(labelIndex, callName, fileIndex.fileById, fromFilePath);
  if (targetId === null || targetId === undefined || targetId === fromNodeId) return null;
  const candidates = labelIndex.get(normalizeLabel(callName));
  const resolution = (candidates && candidates.length > 1) ? 'global_label_tiebreak' : 'global_label';
  return { targetId, resolution };
}

// ─── IMPORTS cross-file resolution (root-cause fix) ────────────────────────
//
// The three resolvers above all resolve a CALL NAME using import evidence as
// a clue. None of them resolve the IMPORT STUB ITSELF to the real declaration
// it names — that gap is why every IMPORTS edge in the graph
// terminates on a same-file IMPORT stub (nothing downstream ever
// follows the stub's own `module`/`name` any further). This function closes
// that gap: given one IMPORT node's own evidence (`module` — the dotted/
// relative spec the import statement itself carries; `name` — the imported
// symbol, NOT the local alias), find the real cross-file declaration it
// binds to. Same refuse-to-guess conservatism as the CALLS resolvers: a
// unique hit or nothing, never a guess among plausible candidates.
//
// Three tiers, tried in order of evidence strength — all EXTRACTED via
// deriveConfidenceTier (every tier here is import-proven; there is no
// global-label/bare-name tier, deliberately — see tier 2's comment):
//
//   1. relative path (`./x`, `../x/y`, or python's dotted-relative `.x`/
//      `..x.y`) — the spec IS a same-repo file path, resolved via the same
//      resolveRelativeImportPath suffix ladder every other relative-import
//      pass in this codebase uses. Strongest evidence: if the spec resolves
//      to a real file, the imported name is looked up ONLY in that file — no
//      fallback to a weaker tier on a miss, because a resolved relative path
//      is a claim about exactly one file, not "somewhere in the branch".
//   2. dotted FQN path suffix (Java/Kotlin/C#-style: `import a.b.C;`, one
//      class per file named after the class) — module+name forms a dotted
//      path (`a.b.C`) matched against a suffix index of every known file's
//      own dotted, extension-stripped path. Exists because moduleStem's
//      last-dotted-segment convention (tier 3) assumes python's "module ==
//      file stem" layout, which does not hold for Java's "package ==
//      directory, class == file stem" layout — moduleStem("a.b.C") would key
//      on "b" (the package's last segment) against a file literally named
//      "b.*", never matching a real Java source tree. This tier is NOT one of
//      the three CALLS resolvers reused verbatim — it is a narrowly-scoped
//      addition for exactly this shape, still governed
//      by the same "unique suffix match or refuse" rule as the rest of this
//      file (buildDottedPathSuffixIndex/resolveDottedSuffixFile,
//      symbol-index.js). No hardcoded source-root guess (`src/main/java/`,
//      ...) — an unambiguous path suffix is accepted regardless of the root.
//   3. module stem (python package convention: `from a.b import C` -> stem
//      "b" -> unique symbol named C in a file whose own stem is "b") — same
//      resolveViaModuleStem/findUniqueSymbol machinery already
//      built, applied to the IMPORT node's own name instead of a call name.
//
// Deliberately excludes the CALLS waterfall's third tier (global_label — bare name,
// unique-or-tie-broken, anywhere in the branch, no import evidence at all): resolving a CALL
// that way is accepted, but applying the SAME bare-name guess to an IMPORT STATEMENT's
// short, often-generic class name (Java's `import org.springframework.stereotype.Service;`
// colliding with a same-repo class literally named `Service` is a realistic collision, not
// a hypothetical one) would be a precision regression.
// A barrel
// file (`index.ts`) that re-exports a symbol declares nothing itself —
// `export { X } from './real'` and `export * from './real'` both register as
// IMPORT nodes on the barrel file (typescript.js/javascript.js's
// `_extraWalkTs`/equivalent), never as a CLASS/METHOD declaration. Walk that
// file's own IMPORT-node re-exports, recursively, to the file that actually
// declares `symbolName`.
//
// Two re-export shapes recognised, matching how the extractors stamp them
// (see typescript.js's `_extraWalkTs`):
//   - named:  `export { X } from './real'`   -> IMPORT{name: 'X', module: './real'}
//   - star:   `export * from './real'`       -> IMPORT{name: './real', module: './real'}
//     (no individual symbol name to recover at extraction time, so the
//     extractor registers the module spec itself as the placeholder name —
//     `imp.name === imp.module` is how this function recognises that shape
//     and tries it for ANY symbolName, since a star export may carry any of
//     the target file's exports).
//
// Cycle-guarded (`visited`, keyed on file path — an `a -> b -> a` re-export
// ring terminates the moment the walk revisits a file already on the current
// path, never a guess, never a hang) AND depth-capped
// (BARREL_HOP_DEPTH_CAP): hitting the cap is logged by name, not silently
// swallowed — a silent cap is indistinguishable from the bug it replaces.
// Refuses (returns null) on ambiguity at every hop, same conservatism as
// every other resolver in this file.
const BARREL_HOP_DEPTH_CAP = 8;

function resolveExportedOrigin(filePath, symbolName, fileIndex, depth = 0, visited = null) {
  if (!fileIndex || !filePath || !symbolName) return null;
  if (!visited) visited = new Set();
  if (visited.has(filePath)) return null; // cycle guard
  visited.add(filePath);

  const decls = fileIndex.declByFileAndName.get(filePath)?.get(symbolName);
  if (decls && decls.length === 1) return filePath;
  if (decls && decls.length > 1) return null; // ambiguous declaration — refuse, do not guess

  if (depth >= BARREL_HOP_DEPTH_CAP) {
    console.error(`resolveExportedOrigin: hop cap (${BARREL_HOP_DEPTH_CAP}) reached resolving "${symbolName}" from "${filePath}" — refusing rather than guessing`);
    return null;
  }

  const reExports = fileIndex.importsByFile.get(filePath);
  if (!reExports || !reExports.length) return null;

  for (const imp of reExports) {
    if (!imp.module) continue;
    const isNamedReExport = imp.name === symbolName;
    const isStarReExport = imp.name === imp.module; // extractor's wildcard placeholder — see header
    if (!isNamedReExport && !isStarReExport) continue;
    const nextFile = resolveRelativeImportPath(filePath, imp.module, fileIndex.knownFilePaths);
    if (!nextFile || nextFile === filePath) continue;
    const origin = resolveExportedOrigin(nextFile, symbolName, fileIndex, depth + 1, visited);
    if (origin) return origin;
  }
  return null;
}

// ─── tsconfig / jsconfig `paths` + `baseUrl` alias resolution ──────────────
//
// `import '@/foo'` (a NON-relative spec — RELATIVE_IMPORT_RE above only matches `./`/`../`)
// is unresolvable by every existing tier in this file, because it names
// neither a same-repo relative path nor a dotted FQN nor a python-style
// module stem — it is only meaningful in light of a tsconfig/jsconfig
// `compilerOptions.paths` alias map, which lives in a JSON(C) file on disk,
// not in this branch's node set. This section reads that file directly
// (fs), unlike every other resolver in this module, which is deliberately
// filesystem-free (see resolveRelativeImportPath's `knownFilePaths` design)
// — there is no way to honour an alias without reading the config that
// declares it.
//
// This machinery is ADDITIVE and OPT-IN. `resolveImportNodeTarget` below only attempts it
// when called with `opts.repoRoot` (grep `resolveImportNodeTarget(` before assuming a call
// site passes it). It exists so a caller with a real repo checkout available at
// edge-resolution time can pass repoRoot and get real alias/baseUrl resolution.

const JS_RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.svelte', '.js', '.jsx', '.mjs', '.cjs'];
const JS_INDEX_FILES = ['index.ts', 'index.tsx', 'index.svelte', 'index.js', 'index.jsx', 'index.mjs'];

// Port of resolution.py's `_strip_jsonc` — strips // and /* */ comments and
// trailing commas while leaving string contents untouched, so tsconfig.json
// files generated by SvelteKit/NestJS/Vite/T3/Astro (which default to JSONC)
// still parse.
function stripJsonc(text) {
  const pattern = /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  const stripped = text.replace(pattern, (m) => (m.startsWith('"') ? m : ''));
  return stripped.replace(/,(\s*[}\]])/g, '$1');
}

// Port of resolution.py's `_read_json_config` — plain JSON first, JSONC
// fallback. Returns null on any unreadable/unparseable file (malformed
// config degrades to "no config", never throws).
function readJsonConfig(absPath) {
  let raw;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch (_) { return null; }
  for (const candidate of [raw, stripJsonc(raw)]) {
    try {
      const data = JSON.parse(candidate);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch (_) { /* try the other candidate */ }
  }
  return null;
}

// Port of resolution.py's `_find_js_config` — nearest tsconfig.json or
// jsconfig.json walking up from startDirAbs. tsconfig.json wins over
// jsconfig.json in the SAME directory (matches tsc/editor behaviour);
// jsconfig.json is only consulted when a directory has no tsconfig.json.
//
// `stopAtDirAbs` bounds the upward walk INCLUSIVELY (that directory is
// searched, its parent is not). Callers resolving inside a cloned repo MUST
// pass the repo root: a clone lives under a server-controlled parent
// (`/tmp/...`, a workspace dir) that may itself contain a tsconfig.json, and
// an unbounded walk would silently apply a FOREIGN project's `paths` to every
// repo cloned beneath it — cross-repo config contamination. The repo-root
// check in resolveViaTsconfigAlias only rejects targets that land outside the
// repo; it cannot detect a foreign alias that happens to map inside it.
// Omitting the bound preserves the original unbounded behaviour.
function findJsConfig(startDirAbs, stopAtDirAbs) {
  let current = path.resolve(startDirAbs);
  const stopAt = stopAtDirAbs ? path.resolve(stopAtDirAbs) : null;
  for (;;) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return { configPath: candidate, configDir: current };
    }
    if (stopAt && current === stopAt) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Port of resolution.py's `_read_tsconfig_aliases` (:89-168) — recursively
// reads `compilerOptions.paths`, following `extends` chains (child overrides
// parent; a scoped npm package extends target like `@tsconfig/svelte` is
// skipped, it is not on disk). `paths` targets are resolved against
// `baseUrl` (default ".", relative to the CONFIG's own directory, not the
// child's) per TS 4.1+ semantics — a NestJS-style `baseUrl: "./src"` layout
// depends on this. `seen` is a Set of already-visited config paths — guards
// a circular `extends` chain from infinite recursion.
function readTsconfigAliases(configAbsPath, baseDirAbs, seen) {
  if (seen.has(configAbsPath)) return {};
  seen.add(configAbsPath);
  const data = readJsonConfig(configAbsPath);
  if (!data) return {};

  const aliases = {};
  const extendsField = data.extends;
  const extendsList = typeof extendsField === 'string' ? [extendsField]
    : Array.isArray(extendsField) ? extendsField.filter((e) => typeof e === 'string') : [];
  for (const ext of extendsList) {
    if (!ext || ext.startsWith('@')) continue; // scoped npm config — not on disk
    let extendedPath = path.resolve(baseDirAbs, ext);
    if (!path.extname(extendedPath)) extendedPath += '.json';
    if (fs.existsSync(extendedPath)) {
      Object.assign(aliases, readTsconfigAliases(extendedPath, path.dirname(extendedPath), seen));
    }
  }

  const compilerOptions = data.compilerOptions || {};
  const baseUrl = (typeof compilerOptions.baseUrl === 'string' && compilerOptions.baseUrl) || '.';
  const pathsBase = path.resolve(baseDirAbs, baseUrl);
  const paths = compilerOptions.paths || {};
  for (const [alias, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || !targets.length) continue;
    // Keep ALL declared targets, in order — resolveTsconfigAlias tries each
    // until one resolves on disk, same as tsc itself (resolution.py's own
    // comment: dropping fallbacks misresolves imports whose file lives at a
    // non-first target).
    const targetPatterns = targets
      .filter((t) => typeof t === 'string' && t)
      .map((t) => path.join(pathsBase, t));
    if (targetPatterns.length) aliases[alias] = targetPatterns;
  }
  return aliases;
}

const tsconfigAliasCache = new Map();
const tsconfigBaseUrlCache = new Map();

// Cache-busting hook for both tests and production. The caches above are
// keyed on absolute config path and never expire, so (a) tests that reuse ONE
// fixture path across mutations must bust them explicitly, and (b) callers
// that re-read a repo which may have changed on disk between passes must too
// — `ingest.js#buildOnDiskResolutionOpts` calls this once per import-stub
// resolution pass, because this process re-ingests the same repo (often
// re-cloned to the same path) and would otherwise resolve a freshly edited
// tsconfig against the previous ingest's cached `paths`. That call also bounds
// these maps, which are otherwise unbounded across every repo the server sees.
function clearTsconfigCaches() {
  tsconfigAliasCache.clear();
  tsconfigBaseUrlCache.clear();
}

// Port of resolution.py's `_load_tsconfig_aliases` — cached by config path.
// `stopAtDirAbs` bounds the config search — see findJsConfig.
function loadTsconfigAliases(startDirAbs, stopAtDirAbs) {
  const found = findJsConfig(startDirAbs, stopAtDirAbs);
  if (!found) return {};
  if (!tsconfigAliasCache.has(found.configPath)) {
    tsconfigAliasCache.set(found.configPath, readTsconfigAliases(found.configPath, found.configDir, new Set()));
  }
  return tsconfigAliasCache.get(found.configPath);
}

// The NEAREST tsconfig's own `baseUrl` (does NOT chase `extends`), as an
// absolute directory. Exposed separately from
// loadTsconfigAliases so it can act as a resolution root of LAST RESORT
// (see resolveTsconfigAlias) — a config declaring baseUrl and no paths
// would otherwise yield an empty alias map and every non-relative import
// would go unresolved.
function loadTsconfigBaseUrl(startDirAbs, stopAtDirAbs) {
  const found = findJsConfig(startDirAbs, stopAtDirAbs);
  if (!found) return null;
  if (!tsconfigBaseUrlCache.has(found.configPath)) {
    let baseUrl = null;
    const data = readJsonConfig(found.configPath);
    if (data) {
      const raw = data.compilerOptions && data.compilerOptions.baseUrl;
      if (typeof raw === 'string' && raw) baseUrl = path.resolve(found.configDir, raw);
    }
    tsconfigBaseUrlCache.set(found.configPath, baseUrl);
  }
  return tsconfigBaseUrlCache.get(found.configPath);
}

// Port of resolution.py's `_match_tsconfig_alias` (:247-271). Returns
// { specificity: [tier, negLen], captured, isWildcard } when `pattern`
// matches `raw`, or null. Three tiers, lowest wins ties: 0 = exact,
// 1 = single-wildcard (TS longest-prefix — more negative negLen, i.e. a
// longer captured prefix, wins within the tier), 2 = bare directory-prefix
// (tried only after real wildcard matches lose).
function matchTsconfigAlias(raw, pattern) {
  if (pattern.includes('*')) {
    if ((pattern.match(/\*/g) || []).length !== 1) return null;
    const starIdx = pattern.indexOf('*');
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) return null;
    const end = suffix ? raw.length - suffix.length : raw.length;
    if (end < prefix.length) return null;
    return { specificity: [1, -prefix.length], captured: raw.slice(prefix.length, end), isWildcard: true };
  }
  if (raw === pattern) return { specificity: [0, -pattern.length], captured: '', isWildcard: false };
  const prefix = pattern.replace(/\/$/, '');
  if (prefix && raw.startsWith(`${prefix}/`)) {
    return { specificity: [2, -prefix.length], captured: raw.slice(prefix.length).replace(/^\//, ''), isWildcard: false };
  }
  return null;
}

function specificityLess(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  return a[1] < b[1];
}

// The filesystem-facing counterpart of resolveRelativeImportPath's knownFilePaths-facing
// suffix ladder above (the .js->.ts rewrite is mirrored here too, since a tsconfig-aliased
// spec may equally be a compiled-JS-style spec).
function resolveJsImportPathOnDisk(candidateAbs) {
  const normalized = path.normalize(candidateAbs);
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
  if (isFile(normalized)) return normalized;

  if (normalized.endsWith('.js')) {
    const ts = `${normalized.slice(0, -3)}.ts`;
    if (isFile(ts)) return ts;
  } else if (normalized.endsWith('.jsx')) {
    const tsx = `${normalized.slice(0, -4)}.tsx`;
    if (isFile(tsx)) return tsx;
  }

  for (const ext of JS_RESOLVE_EXTS) {
    const withExt = normalized + ext;
    if (isFile(withExt)) return withExt;
  }

  let isDir = false;
  try { isDir = fs.statSync(normalized).isDirectory(); } catch (_) { /* not a dir */ }
  if (isDir) {
    for (const indexName of JS_INDEX_FILES) {
      const indexCandidate = path.join(normalized, indexName);
      if (isFile(indexCandidate)) return indexCandidate;
    }
  }
  return null;
}

// Port of resolution.py's `_resolve_tsconfig_alias` (:273-322). Finds the
// most specific matching alias pattern and tries its declared targets, in
// order, returning the first that resolves to a real file on disk.
// `baseUrlAbs` is tried ONLY when no declared alias matches AT ALL — it
// deliberately does not enter the specificity contest (a bare baseUrl
// fallback must never outrank or shadow a declared alias, wildcard or not).
function resolveTsconfigAlias(raw, aliases, baseUrlAbs) {
  let best = null;
  for (const [pattern, targets] of Object.entries(aliases || {})) {
    const match = matchTsconfigAlias(raw, pattern);
    if (!match) continue;
    if (!best || specificityLess(match.specificity, best.specificity)) {
      best = { ...match, targets };
    }
  }

  if (!best) {
    if (!baseUrlAbs) return null;
    return resolveJsImportPathOnDisk(path.join(baseUrlAbs, raw));
  }

  for (const target of best.targets) {
    const candidate = best.isWildcard
      ? path.normalize(best.captured ? target.replace('*', best.captured) : target)
      : (best.captured ? path.join(target, best.captured) : target);
    const resolved = resolveJsImportPathOnDisk(candidate);
    if (resolved) return resolved;
  }
  return null; // every declared target missed on disk — refuse, do not fabricate
}

// Entry point resolveImportNodeTarget calls: resolves a NON-relative import
// spec (`@/foo`, `utils`) written inside `fromFilePathAbs` against the
// nearest tsconfig/jsconfig's `paths`/`baseUrl`, and converts the result
// back to a repo-relative path (POSIX-separated, matching every other path
// this module hands back). Returns null for a relative spec (that is
// resolveRelativeImportPath's job, tried by the caller), when no config is
// found, or when nothing resolves.
function resolveViaTsconfigAlias(fromFilePathAbs, importSpec, repoRootAbs) {
  if (!repoRootAbs || !fromFilePathAbs || !importSpec) return null;
  if (RELATIVE_IMPORT_RE.test(importSpec)) return null;
  const fromDirAbs = path.dirname(fromFilePathAbs);
  // Bound the config search at the repo root — a tsconfig ABOVE the clone
  // belongs to some other project and must never alias this repo's imports.
  const aliases = loadTsconfigAliases(fromDirAbs, repoRootAbs);
  const baseUrlAbs = loadTsconfigBaseUrl(fromDirAbs, repoRootAbs);
  const resolvedAbs = resolveTsconfigAlias(importSpec, aliases, baseUrlAbs);
  if (!resolvedAbs) return null;
  const rel = path.relative(repoRootAbs, resolvedAbs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return null; // outside the repo root — refuse
  return rel;
}

// ─── workspace package resolution (npm/pnpm/yarn/lerna monorepos) ─────────
//
// `import '@myorg/foo'` (a NON-relative spec naming a SIBLING workspace package, not an alias) is
// unresolvable by every existing tier — it is not a same-repo relative path, not a dotted
// FQN, not a python-style module stem, and not a tsconfig-declared alias.
// `workspace-layout.js#buildWorkspacePackageIndex` already turned the packages this repo
// collects for ingest-unit splitting into a specifier -> absolute-source-dir map; this
// section is the resolution logic that consumes it, colocated here with the tsconfig-alias
// ladder above (same "reads real files on disk, opt-in via opts" shape as that section, not
// the knownFilePaths-only design the rest of this module uses).
//
// ADDITIVE and OPT-IN via `opts.workspacePackages` (grep `resolveImportNodeTarget(` before
// assuming a call site passes it). Wiring a real `workspacePackages` array through from
// ingest-time package.json manifests is future work.

// The `exports` map value is
// either a plain relative-path string, or a condition object keyed by
// environment (`import`/`require`/`types`/...) whose FIRST matching key (by
// this fixed priority order, not object insertion order — Node's own
// resolver is order-sensitive in the same way) wins; a condition object may
// itself nest another condition object (`{"import": {"types": "...", "default": "..."}}`),
// so this recurses. Returns null when nothing in `value` matches any known
// condition (an `exports` entry gated entirely behind conditions this list
// doesn't recognise, e.g. `"node"` alone with no `"default"`).
const EXPORT_CONDITION_PRIORITY = ['source', 'import', 'module', 'svelte', 'types', 'require', 'default'];

function resolveExportConditionTarget(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const cond of EXPORT_CONDITION_PRIORITY) {
      const v = value[cond];
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = resolveExportConditionTarget(v);
        if (nested) return nested;
      }
    }
  }
  return null;
}

// Port of resolution.py's `_contained_in_package` (:426-432). Guards against
// an `exports` target that escapes the package directory (`"./evil":
// "../../../etc/passwd"`) — without this, `exports` is a path-traversal read
// primitive over repository contents (this slice's own adversarial gate).
// Accepts only paths that, once resolved, stay inside `packageDirAbs`.
function isContainedInPackage(resolvedAbs, packageDirAbs) {
  const rel = path.relative(path.resolve(packageDirAbs), path.resolve(resolvedAbs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Port of resolution.py's `_package_entry_candidates` (:434-475). `subpath`
// is the part of the import spec after the package name (`'browser'` for
// `@myorg/foo/browser`, `''` for a bare `@myorg/foo`).
//
//   - subpath present: consult `exports`'s exact subpath key (`"./browser"`)
//     first, honouring the condition ladder above; on a miss, try declared
//     `exports` patterns with exactly one `*` wildcard (longest-match not
//     contested — first structurally-matching pattern wins); every
//     `exports`-derived candidate is escape-guarded. If
//     `exports` has nothing for this subpath at all (no matching key, no
//     matching wildcard, or no `exports` field), fall through to the bare
//     `packageDir/subpath` join — NOT escape-guarded, since a plain subpath
//     join can only ever land inside the package dir by construction.
//   - subpath absent (bare package import): `exports['.']` (string or
//     condition object) first, then legacy `svelte`/`module`/`main`/`types`
//     fields in that order, then `src/index`/`index` as a last-resort guess
//     — all resolved through `resolveJsImportPathOnDisk`'s existing
//     extension/index probing by the caller.
function packageEntryCandidates(packageDirAbs, subpath) {
  const manifest = readJsonConfig(path.join(packageDirAbs, 'package.json')) || {};

  if (subpath) {
    const exportsField = manifest.exports;
    if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
      const subpathKey = `./${subpath}`;
      const target = resolveExportConditionTarget(exportsField[subpathKey]);
      if (target) {
        const candidate = path.resolve(packageDirAbs, target);
        if (isContainedInPackage(candidate, packageDirAbs)) return [candidate];
      } else {
        for (const [pattern, patternValue] of Object.entries(exportsField)) {
          if (typeof pattern !== 'string' || !pattern.includes('*')) continue;
          if ((pattern.match(/\*/g) || []).length !== 1) continue;
          const starIdx = pattern.indexOf('*');
          const prefix = pattern.slice(0, starIdx);
          const suffix = pattern.slice(starIdx + 1);
          if (!subpathKey.startsWith(prefix)) continue;
          if (suffix && !subpathKey.endsWith(suffix)) continue;
          const matched = suffix
            ? subpathKey.slice(prefix.length, subpathKey.length - suffix.length)
            : subpathKey.slice(prefix.length);
          const resolved = resolveExportConditionTarget(patternValue);
          if (resolved && resolved.includes('*')) {
            const candidate = path.resolve(packageDirAbs, resolved.replace('*', matched));
            if (isContainedInPackage(candidate, packageDirAbs)) return [candidate];
          }
          break; // structurally-matching pattern found; do not try weaker patterns
        }
      }
    }
    return [path.resolve(packageDirAbs, subpath)];
  }

  if (typeof manifest.exports === 'string') return [path.resolve(packageDirAbs, manifest.exports)];
  if (manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)) {
    const dotTarget = resolveExportConditionTarget(manifest.exports['.']);
    if (dotTarget) return [path.resolve(packageDirAbs, dotTarget)];
  }

  const candidates = [];
  for (const key of ['svelte', 'module', 'main', 'types']) {
    if (typeof manifest[key] === 'string') candidates.push(path.resolve(packageDirAbs, manifest[key]));
  }
  candidates.push(path.resolve(packageDirAbs, 'src/index'));
  candidates.push(path.resolve(packageDirAbs, 'index'));
  return candidates;
}

// Port of resolution.py's `_resolve_workspace_import` (:477-503), minus its
// own workspace-package DISCOVERY (that half is `workspace-layout.js`'s job,
// already built pre-E6 for ingest-unit splitting and enriched by this slice's
// `buildWorkspacePackageIndex`) — this only does the specifier MATCH +
// entry-candidate RESOLUTION. `raw === packageName` matches the bare package;
// `raw.startsWith(packageName + '/')` matches a subpath. First package that
// matches the specifier is tried; workspace package names are unique by npm
// construction, so this does not need a findUniqueSymbol-style ambiguity
// guard the way a bare-name CALLS resolver would.
function resolveWorkspacePackageImport(importSpec, workspacePackages) {
  if (!importSpec || RELATIVE_IMPORT_RE.test(importSpec)) return null;
  if (!Array.isArray(workspacePackages) || !workspacePackages.length) return null;

  for (const pkg of workspacePackages) {
    if (!pkg || !pkg.packageName || !pkg.absDir) continue;
    let subpath;
    if (importSpec === pkg.packageName) subpath = '';
    else if (importSpec.startsWith(`${pkg.packageName}/`)) subpath = importSpec.slice(pkg.packageName.length + 1);
    else continue;

    for (const candidate of packageEntryCandidates(pkg.absDir, subpath)) {
      const resolved = resolveJsImportPathOnDisk(candidate);
      if (resolved) return resolved;
    }
    return null; // matched this package's name; do not fall through to another package
  }
  return null;
}

// Entry point resolveImportNodeTarget calls (mirrors resolveViaTsconfigAlias's
// shape exactly): resolves a NON-relative import spec against the workspace
// package index and converts the hit back to a repo-relative path. Returns
// null for a relative spec, when no `workspacePackages` were supplied, or
// when nothing resolves.
function resolveViaWorkspacePackage(importSpec, repoRootAbs, workspacePackages) {
  if (!repoRootAbs || !importSpec) return null;
  if (RELATIVE_IMPORT_RE.test(importSpec)) return null;
  const resolvedAbs = resolveWorkspacePackageImport(importSpec, workspacePackages);
  if (!resolvedAbs) return null;
  const rel = path.relative(repoRootAbs, resolvedAbs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return null; // outside the repo root — refuse
  return rel;
}

function resolveImportNodeTarget(importRow, fileIndex, opts = {}) {
  if (!fileIndex || !importRow || !importRow.file_path || !importRow.name || !importRow.module) return null;
  const fromFilePath = importRow.file_path;
  const module = importRow.module;
  const selfId = importRow.id;

  // tsconfig/jsconfig `paths`/`baseUrl` alias tier, tried first for a NON-relative spec —
  // see resolveViaTsconfigAlias's header for the opt-in contract (opts.repoRoot must be
  // passed; it is a no-op and byte-identical for every relative-spec import otherwise).
  if (opts.repoRoot) {
    // Tried before the
    // tsconfig-alias tier: a workspace-package specifier match
    // (`@myorg/foo` against a package.json `name`) is a stronger, more
    // specific signal than a generic tsconfig `paths` pattern that HAPPENS
    // to also match the same specifier shape.
    const workspaceFile = resolveViaWorkspacePackage(module, opts.repoRoot, opts.workspacePackages);
    if (workspaceFile) {
      const decls = fileIndex.declByFileAndName.get(workspaceFile)?.get(importRow.name);
      if (decls && decls.length === 1 && decls[0].id !== selfId) {
        return { targetId: decls[0].id, resolution: 'import' };
      }
      const originFile = resolveExportedOrigin(workspaceFile, importRow.name, fileIndex);
      if (originFile) {
        const originDecls = fileIndex.declByFileAndName.get(originFile)?.get(importRow.name);
        if (originDecls && originDecls.length === 1 && originDecls[0].id !== selfId) {
          return { targetId: originDecls[0].id, resolution: 'import' };
        }
      }
    }

    const aliasFile = resolveViaTsconfigAlias(path.join(opts.repoRoot, fromFilePath), module, opts.repoRoot);
    if (aliasFile) {
      const decls = fileIndex.declByFileAndName.get(aliasFile)?.get(importRow.name);
      if (decls && decls.length === 1 && decls[0].id !== selfId) {
        return { targetId: decls[0].id, resolution: 'import' };
      }
      const originFile = resolveExportedOrigin(aliasFile, importRow.name, fileIndex);
      if (originFile) {
        const originDecls = fileIndex.declByFileAndName.get(originFile)?.get(importRow.name);
        if (originDecls && originDecls.length === 1 && originDecls[0].id !== selfId) {
          return { targetId: originDecls[0].id, resolution: 'import' };
        }
      }
    }
  }

  const relFile = resolveRelativeImportPath(fromFilePath, module, fileIndex.knownFilePaths);
  if (relFile) {
    const decls = fileIndex.declByFileAndName.get(relFile)?.get(importRow.name);
    if (decls && decls.length === 1 && decls[0].id !== selfId) {
      return { targetId: decls[0].id, resolution: 'import' };
    }
    // `relFile` declares nothing under this name — it may be a barrel (`index.ts`) that only
    // re-exports it: `export { X } from './real'` or `export * from './real'`.
    // Chase the re-export chain to its true declaring file before refusing.
    const originFile = resolveExportedOrigin(relFile, importRow.name, fileIndex);
    if (originFile) {
      const originDecls = fileIndex.declByFileAndName.get(originFile)?.get(importRow.name);
      if (originDecls && originDecls.length === 1 && originDecls[0].id !== selfId) {
        return { targetId: originDecls[0].id, resolution: 'import' };
      }
    }
    return null;
  }

  const dottedFile = resolveDottedSuffixFile(`${module}.${importRow.name}`, fileIndex.dottedPathSuffixIndex);
  if (dottedFile) {
    const decls = fileIndex.declByFileAndName.get(dottedFile)?.get(importRow.name);
    if (decls && decls.length === 1 && decls[0].id !== selfId) {
      return { targetId: decls[0].id, resolution: 'import' };
    }
    return null;
  }

  // A `firstPartyOnly` fact is a named binding lifted out of a
  // NON-relative import (`import { formatValue } from '@app/util/format'`). It exists purely
  // so the workspace-package and tsconfig-alias tiers above — the two that resolve a module
  // specifier to an actual in-repo file, i.e. proof rather than inference — can find the
  // symbol. If neither matched, the specifier is an external package and there is nothing
  // first-party to bind to. Falling through to the relative/dotted/module-stem tiers below
  // would let `import { Injectable } from '@angular/core'` bind to a local `core.ts` that
  // happens to declare `Injectable`. Refuse instead of guessing.
  if (importRow.firstPartyOnly) return null;

  const stem = moduleStem(module);
  if (stem && fileIndex.symbolIndex) {
    const targetId = findUniqueSymbol(fileIndex.symbolIndex, stem, importRow.name,
      { fileById: fileIndex.fileById, callSiteFile: fileIndex.fileById.get(importRow.from_node_id) });
    if (targetId !== null && targetId !== undefined && targetId !== selfId) {
      return { targetId, resolution: 'module_stem' };
    }
  }

  return null;
}

module.exports = {
  resolveRelativeImportPath,
  rewriteJsSpecToTs,
  pyDottedRelativeToSlashSpec,
  resolveImportNodeTarget,
  resolveExportedOrigin,
  deriveConfidenceTier,
  resolveViaImportEvidence,
  resolveViaReceiverImport,
  resolveViaReceiverType,
  resolveViaModuleStem,
  resolveViaGlobalLabel,
  stripJsonc,
  readJsonConfig,
  findJsConfig,
  readTsconfigAliases,
  loadTsconfigAliases,
  loadTsconfigBaseUrl,
  matchTsconfigAlias,
  resolveTsconfigAlias,
  resolveJsImportPathOnDisk,
  resolveViaTsconfigAlias,
  clearTsconfigCaches,
  resolveExportConditionTarget,
  isContainedInPackage,
  packageEntryCandidates,
  resolveWorkspacePackageImport,
  resolveViaWorkspacePackage,
};
