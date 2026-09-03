'use strict';

// The four shared helpers every language extractor imports
// (_LANGUAGE_BUILTIN_GLOBALS, _file_stem, _make_id, _read_text) plus the
// contract-validation surface (NODE_TYPES/EDGE_TYPES/RESOLUTIONS +
// validateOutput). The node/edge vocabulary is closed here.

// ─── Closed vocabularies ──────────────────────────────────────────────────
//
// Extractors emit CLASS/METHOD/IMPORT only — the semantic types
// (CONTROLLER, SERVICE, REPOSITORY, ENTITY, ENDPOINT, ...) are never invented
// here. edge_type is closed to EMITTABLE_EDGE_TYPES (graph-vocabulary.js) —
// this is NOT the same set as what `retrieveSubgraph` traverses by default
// (TRAVERSAL_EDGE_TYPES, same module): IMPORTS and INSTANTIATES are
// deliberately emittable but never traversed. `resolution` is mandatory on
// every edge and must be one of the values below — there is no unlabelled edge.

// FIELD and CONSTANT are STRUCTURAL declarations, not semantic types — the
// route-1 (ast-extractor.js) plane emits them and the goldset scores them, so
// a route-2 extractor that can see a struct field or a `const` (Rust) must be
// able to emit them too. They are declarations with a real span, unrelated to
// the semantic plane the closed set guards.
const NODE_TYPES = Object.freeze(new Set(['CLASS', 'METHOD', 'IMPORT', 'FIELD', 'CONSTANT']));

// Sourced from graph-vocabulary.js so the emit-time contract here and the
// traversal-time policy can never silently drift apart. This is the superset
// EMITTABLE_EDGE_TYPES; an extractor that emits none of the wider set is
// unaffected — this only widens what validateEdge accepts.
const { EMITTABLE_EDGE_TYPES: EDGE_TYPES } = require('../graph-vocabulary');
const { augmentHttpCallsAcrossLanguages } = require('../http-call-scan');

// Widening this set is mandatory in the same commit that starts emitting a new
// resolution string — validateEdge throws otherwise.
const RESOLUTIONS = Object.freeze(new Set(['import', 'same_file', 'inherited', 'ambiguous', 'this_receiver']));

// Validates one node against the closed node_type set. Throws — this is the
// "base.js must validate this and throw on anything else" requirement.
function validateNode(node) {
  if (!node || typeof node !== 'object') {
    throw new Error('extractors/base.js: node must be an object');
  }
  if (!NODE_TYPES.has(node.node_type)) {
    throw new Error(
      `extractors/base.js: invalid node_type "${node.node_type}" — closed set is ` +
      `${[...NODE_TYPES].join('|')}. An extractor must not emit any other node_type.`
    );
  }
  if (!node.name) {
    throw new Error('extractors/base.js: node missing name');
  }
  if (!node.start_line) {
    throw new Error(`extractors/base.js: node "${node.name}" missing start_line`);
  }
}

// Validates one edge against the closed edge_type set and the resolution
// vocabulary. Throws.
function validateEdge(edge) {
  if (!edge || typeof edge !== 'object') {
    throw new Error('extractors/base.js: edge must be an object');
  }
  if (!EDGE_TYPES.has(edge.edge_type)) {
    throw new Error(
      `extractors/base.js: invalid edge_type "${edge.edge_type}" — closed set is ` +
      `${[...EDGE_TYPES].join('|')}. A novel edge_type is an edge no traversal will follow.`
    );
  }
  if (!RESOLUTIONS.has(edge.resolution)) {
    throw new Error(
      `extractors/base.js: invalid/missing resolution "${edge.resolution}" on edge ` +
      `${edge.from}->${edge.to} (${edge.edge_type}) — must be one of ${[...RESOLUTIONS].join('|')}`
    );
  }
}

// Merges CLASS nodes that share a name within one file's output into a single
// node — e.g. Rust's `struct S` + `impl S`, Kotlin's class + companion object,
// C#'s partial classes: distinct language constructs naming the SAME symbol.
// Union the spans (min start_line, max end_line) and keep the first-seen
// node's identity/summary; the merged constructs are recorded on
// `properties.constructs`. Merging here — not just at the canonical_key level
// (ingest-helpers.js) — matters because file-qualifying canonical_key alone
// still collapses two same-file "CLASS S" nodes onto one key. Extractors that
// split one symbol across constructs MUST call this before returning;
// validateOutput below throws if a duplicate CLASS still slips through, so
// forgetting to merge fails loudly at authoring time instead of silently
// losing a node at write time via the ON CONFLICT upsert.
//
// Scoped to CLASS only, not every node_type — a blanket (node_type, name)
// invariant breaks a legitimate, common Go pattern: two distinct types each
// implementing an interface method of the same name in one file
// (`func (a A) Do(){}` / `func (b B) Do(){}`) are two real METHOD symbols, not
// one symbol split across constructs. METHOD name collisions across owners are
// a separate, pre-existing canonical_key limitation (METHOD's key is file+name
// only, no receiver/owner component) that is out of scope here.
//
// Merging removes nodes from the array, so every index at or after a removed
// duplicate shifts. Any edge already built against the pre-merge `nodes` array
// (the same array this function receives) is silently corrupted unless the
// caller remaps it — an `oldIndex -> newIndex` Map is returned alongside the
// merged array so callers (walkGeneric and every bespoke extractor that calls
// this directly) can fix up their own edges/unresolved markers before
// returning. Every old index — merged or not — appears in the map, so a caller
// never has to special-case "did this index survive."
//
// Two CLASS nodes of one name in a file are the SAME type when they are two
// constructs of one declaration (Rust struct+impl, Kotlin class+companion) and
// DIFFERENT types when they are declared in different containers — `mod remote
// { struct S }` beside a top-level `struct S`, `enum Field` inside six separate
// function bodies, OCaml's `module List` twice in one file, Scala's trait and
// its companion object. Keying on name alone made the second one vanish AND
// pointed its members' DEFINED_IN at the first one's owner — a false statement
// about the code rather than a gap.
//
// `_container` is the enclosing scope's name, stamped by whichever walker
// produced the node. A node with no container keys on name alone, so an
// extractor that does not stamp it behaves EXACTLY as before — which is what
// keeps struct+impl and class+companion merging.
const _classKey = (n) => (n._container ? `${n._container}\u0000${n.name}` : n.name);

function mergeSameFileDuplicates(nodes) {
  const classByName = new Map(); // (container, name) -> newIndex of the merged CLASS node
  const output = [];
  const indexMap = new Map(); // oldIndex -> newIndex
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.node_type !== 'CLASS') {
      indexMap.set(i, output.length);
      output.push(n);
      continue;
    }
    const existingIdx = classByName.get(_classKey(n));
    if (existingIdx === undefined) {
      const copy = { ...n };
      const newIdx = output.length;
      classByName.set(_classKey(n), newIdx);
      output.push(copy);
      indexMap.set(i, newIdx);
      continue;
    }
    const existing = output[existingIdx];
    const constructs = Array.isArray(existing.properties?.constructs)
      ? existing.properties.constructs
      : [existing.kind || existing.node_type];
    constructs.push(n.kind || n.node_type);
    existing.start_line = Math.min(existing.start_line, n.start_line);
    existing.end_line = Math.max(existing.end_line ?? existing.start_line, n.end_line ?? n.start_line);
    existing.properties = { ...(existing.properties || {}), constructs };
    indexMap.set(i, existingIdx);
  }
  return { nodes: output, indexMap };
}

// Applies an oldIndex -> newIndex Map (as returned by mergeSameFileDuplicates)
// to a list of `{ from, to, ... }` edges, dropping any edge whose endpoints
// merged into the same node (a real edge between two distinct pre-merge
// nodes that turned into a meaningless self-loop, not something to emit).
function remapEdgeIndices(indexMap, edges) {
  const out = [];
  for (const e of edges) {
    const from = indexMap.has(e.from) ? indexMap.get(e.from) : e.from;
    const to = indexMap.has(e.to) ? indexMap.get(e.to) : e.to;
    if (from === to) continue;
    out.push({ ...e, from, to });
  }
  return out;
}

// Same idea as remapEdgeIndices but for the deferred marker shape
// (`{ from, ... }`, no `to` — walkGeneric's unresolvedCalls/unresolvedInheritance)
// where there is no second endpoint to compare against, so nothing is dropped.
function remapFromIndices(indexMap, markers) {
  return markers.map((m) => ({
    ...m,
    from: indexMap.has(m.from) ? indexMap.get(m.from) : m.from,
  }));
}

// Validates a whole { nodes, edges } extractor result. Every language
// extractor calls this on its own output before returning.
//
// Also enforces the same-file uniqueness invariant for CLASS: at most one
// CLASS node per name per file. Throws rather than silently accepting a
// duplicate — an extractor that declares one type across several constructs
// (Rust struct+impl, Kotlin class+companion, ...) must call
// mergeSameFileDuplicates() first; forgetting to do so is an authoring bug,
// not a data condition to swallow. Scoped to CLASS only — see
// mergeSameFileDuplicates' doc comment for why METHOD name collisions across
// different owners in one file are a real, distinct-symbol case this must
// NOT reject.
function validateOutput(result) {
  const nodes = (result && result.nodes) || [];
  const edges = (result && result.edges) || [];
  const seenClasses = new Set();
  for (const n of nodes) {
    validateNode(n);
    if (n.node_type === 'CLASS') {
      if (seenClasses.has(_classKey(n))) {
        throw new Error(
          `extractors/base.js: duplicate CLASS "${n.name}" within one file's output — ` +
          `an extractor whose language can declare one type across several constructs ` +
          `(e.g. Rust struct+impl) must call mergeSameFileDuplicates() before returning. ` +
          `This is the same-file case that file-qualification alone cannot resolve.`
        );
      }
      seenClasses.add(_classKey(n));
    }
  }
  for (const e of edges) {
    validateEdge(e);
    // A node merge (mergeSameFileDuplicates) that forgot to remap edge indices
    // produces exactly this — an edge endpoint pointing past the end of (or, at
    // the wrong slot of) the returned nodes array. Range-checking catches the
    // out-of-bounds case; a caller that remaps correctly never trips it.
    if (!Number.isInteger(e.from) || e.from < 0 || e.from >= nodes.length) {
      throw new Error(
        `extractors/base.js: edge "from"=${e.from} out of range [0,${nodes.length}) — ` +
        `corrupted node index, likely an unmapped merge`
      );
    }
    if (!Number.isInteger(e.to) || e.to < 0 || e.to >= nodes.length) {
      throw new Error(
        `extractors/base.js: edge "to"=${e.to} out of range [0,${nodes.length}) — ` +
        `corrupted node index, likely an unmapped merge`
      );
    }
  }
  return result;
}

// ─── Shared extractor helpers ─────────────────────────────────────────────────

// Language built-in globals that AST may classify as call targets when used
// as constructors or coercion functions (e.g. String(x), Number(x),
// Boolean(x)). Without this filter they become god-nodes accumulating
// spurious edges from every call site. Filter applied at same-file and
// cross-file resolution.
const _LANGUAGE_BUILTIN_GLOBALS = Object.freeze(new Set([
  // JavaScript / TypeScript ECMAScript built-ins
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Symbol', 'BigInt',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'EvalError', 'URIError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'JSON', 'Math',
  'Reflect', 'Proxy', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  // Browser / Node common globals
  'URL', 'URLSearchParams', 'FormData', 'Blob', 'File',
  'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'console',
  // Python built-in callables
  'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes',
  'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min', 'max',
  'print', 'open', 'isinstance', 'type', 'super', 'sorted', 'reversed',
  'any', 'all', 'abs', 'round', 'next', 'iter', 'hash', 'id', 'repr',
  'callable', 'getattr', 'setattr', 'hasattr', 'delattr', 'vars', 'dir',
  // Swift standard library / Foundation / SwiftUI (#2147). Value-type
  // initializers (Data(x), Int(x), UUID()) and protocol conformance targets
  // appear from virtually every file of a Swift codebase, exactly like the
  // ECMAScript constructors above. String/Date/URL/Error are already listed.
  'Int', 'Int8', 'Int16', 'Int32', 'Int64',
  'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Double', 'Float', 'Bool', 'Character',
  'Sendable', 'Codable', 'Decodable', 'Encodable', 'Equatable', 'Hashable',
  'Identifiable', 'Comparable', 'CaseIterable', 'RawRepresentable',
  'CustomStringConvertible', 'CustomDebugStringConvertible', 'AnyObject',
  'LocalizedError',
  'Data', 'UUID', 'Decimal', 'Calendar', 'Locale', 'TimeZone', 'Bundle',
  'IndexPath', 'IndexSet', 'NotificationCenter', 'UserDefaults',
  'FileManager', 'URLSession', 'URLRequest', 'URLComponents',
  'JSONDecoder', 'JSONEncoder', 'DateFormatter', 'NumberFormatter',
  'ISO8601DateFormatter',
  'NSObject', 'NSString', 'NSError', 'NSLock', 'NSAttributedString',
  'DispatchQueue', 'DispatchGroup', 'OperationQueue', 'RunLoop',
  'View', 'Color', 'Font',
]));

// Stem used as a within-file/package symbol-table key: the full path with its
// extension dropped, forward-slash separated, "" for a path with no name.
function _fileStem(filePath) {
  if (!filePath) return '';
  const norm = String(filePath).replace(/\\/g, '/');
  const segments = norm.split('/');
  const base = segments[segments.length - 1];
  if (!base) return '';
  const dot = base.lastIndexOf('.');
  segments[segments.length - 1] = dot > 0 ? base.slice(0, dot) : base;
  return segments.join('/');
}

// NFKC-normalize, collapse
// runs of non-word characters to a single underscore, collapse repeats, strip
// leading/trailing underscores, casefold. Used for the extractor's internal
// same-file/package symbol table only — NOT the Postgres canonical_key, which
// remains computeCanonicalKey's job (ingest-helpers.js) unchanged.
function _normalizeId(s) {
  let out = String(s).normalize('NFKC');
  out = out.replace(/[^\p{L}\p{N}_]+/gu, '_');
  out = out.replace(/_+/g, '_');
  out = out.replace(/^_+|_+$/g, '');
  return out.toLowerCase();
}

function _makeId(...parts) {
  const joined = parts
    .filter(Boolean)
    .map((p) => String(p).replace(/^[_.]+|[_.]+$/g, ''))
    .join('_');
  return _normalizeId(joined);
}

// web-tree-sitter nodes compute `.text` lazily and correctly from the parse
// tree's source buffer already — there is no manual byte-slice step. Kept as a
// named helper so the source-bytes signature can be reintroduced without
// touching call sites if a future grammar needs it.
function _readText(node) {
  return node ? node.text : '';
}

// ─── Shared AST helpers used by objc ──
//
// These two helpers are shared, general-purpose AST utilities — not
// objc-specific logic — so they land here rather than in extractors/objc.js.

// Returns the bare variable name from a declaration declarator, unwrapping
// pointer/reference/init wrappers (`*f`, `&r`, `f = Foo()`). Returns null for
// anything that isn't a plain named local (arrays, function pointers,
// structured bindings) so a caller's local-variable type table never records
// a guessed receiver. Named "_cpp*" because the C/C++-family declarator
// grammar it unwraps is shared verbatim by objc's grammar (tree-sitter-objc
// extends the C grammar).
function _cppDeclaratorName(node) {
  if (!node) return null;
  const t = node.type;
  if (t === 'identifier') return _readText(node);
  if (t === 'pointer_declarator' || t === 'reference_declarator' || t === 'init_declarator') {
    let inner = node.childForFieldName('declarator');
    if (!inner) {
      inner = (node.children || []).find((c) =>
        c.type === 'identifier' || c.type === 'pointer_declarator' || c.type === 'reference_declarator');
    }
    if (inner) return _cppDeclaratorName(inner);
  }
  return null;
}

// A field/param/return type reference has no member in the closed edge_type set
// (EDGE_TYPES above), so it is emitted as COUPLED_WITH here. Any richer context
// tag is dropped: it has no closed-vocabulary home and nothing reads it.
// `resolution` is required by validateEdge and must be supplied by the caller;
// every caller here calls this only once same-file resolution has succeeded,
// so it is always 'same_file' in practice — but it is not hardcoded so a
// future caller with a different evidence kind is not forced to lie about it.
function _semanticReferenceEdge(from, to, resolution, evidence_line) {
  return { from, to, edge_type: 'COUPLED_WITH', resolution, evidence_line };
}

// ─── Shared grammar loader ──────────────────────────────
//
// web-tree-sitter's Parser.init() must be called exactly once per process —
// a second call after the first has resolved corrupts the module object
// (`Parser.init` becomes `undefined`). ast-extractor.js already owns the one
// shared init promise; every generic extractor loads its grammar through THIS
// function rather than calling Parser.init() itself. Lazy require (not a
// top-of-file require) so this module has no load-time dependency on
// ast-extractor.js, even though ast-extractor.js requires extractors/<lang>.js
// at its own load time — avoids a require-cycle partial-exports hazard.
const _grammarCache = {};
async function loadGrammar(grammarName) {
  if (_grammarCache[grammarName]) return _grammarCache[grammarName];
  const { tsInitPromise, wasmPath: resolveWasm } = require('../ast-extractor');
  const Parser = await tsInitPromise();
  // Resolved through ast-extractor's require.resolve helper, not
  // `__dirname/../../../node_modules`: npm hoists to the INSTALLER's tree, so a
  // hard-coded path only ever exists in a checkout and every route-2 language
  // falls silently to the regex tier once installed (ingest still exits 0).
  const wasmPath = resolveWasm('tree-sitter-wasms', 'out/tree-sitter-%s.wasm', grammarName);
  if (!wasmPath) throw new Error(`tree-sitter-wasms grammar unresolved: ${grammarName}`);
  const lang = await Parser.Language.load(wasmPath);
  const p = new Parser();
  p.setLanguage(lang);
  _grammarCache[grammarName] = p;
  return p;
}

// The ABI-15 sibling of loadGrammar, for a grammar whose only usable build ships in
// @vscode/tree-sitter-wasm. tree-sitter-wasms' bash build does not merely parse `case` badly —
// its external scanner THROWS ("resolved is not a function") and leaves the parser permanently
// wedged for every later file in the process. Same second-runtime scoping ast-extractor.js
// already uses for the C# grammar, and it awaits that file's single init promise rather than
// starting a second one (web-tree-sitter-next's init is not concurrency-safe).
const _grammarCacheNext = {};
async function loadGrammarNext(grammarName) {
  if (_grammarCacheNext[grammarName]) return _grammarCacheNext[grammarName];
  const { tsNextInitPromise, wasmPath: resolveWasm } = require('../ast-extractor');
  const { Parser, Language } = await tsNextInitPromise();
  const wasmPath = resolveWasm('@vscode/tree-sitter-wasm', 'wasm/tree-sitter-%s.wasm', grammarName);
  if (!wasmPath) throw new Error(`@vscode/tree-sitter-wasm grammar unresolved: ${grammarName}`);
  const p = new Parser();
  p.setLanguage(await Language.load(wasmPath));
  _grammarCacheNext[grammarName] = p;
  return p;
}


// Shared import-fact recorder, replacing per-import IMPORT node creation.
// `ctx.importFacts` is the flat list threaded through _adaptPortedResult ->
// ingest-file-processor.js -> the FILE node's `properties.imports` —
// facts.js#buildFileScopedIndex reads exactly this `{name, module, alias,
// line}` shape. `importByAlias`/`importedAliases` stay for same-file dedup and
// stay exposed on `ctx` for extraWalkFn implementations (javascript.js/
// typescript.js) that build their own import entries outside the importHandler
// hook; they hold the fact object, not a node index — nothing resolves a
// CALLS/IMPORTS target against them at extraction time anymore (resolveCall's
// accessor branch defers every non-self accessor call, import-alias receivers
// included, to unresolvedCalls for ingest-phase resolution).
function registerImportFact(ctx, { name, alias, module, line }) {
  if (!name) return;
  const key = alias || name;
  if (ctx.importedAliases.has(key)) return;
  const fact = { name, alias: alias || null, module: module || null, line: line ?? null };
  ctx.importFacts.push(fact);
  ctx.importByAlias.set(key, fact);
  ctx.importedAliases.add(key);
}

// Shared field-capture helper. Attaches a declared field's `{name, type}` onto
// the owning CLASS node's `fields` array (deduped by name) — a plain TOP-LEVEL
// key on the node object, not nested under `properties`, matching how IMPORT
// nodes already carry `module`/`alias` (ingest.js#writeNode spreads every
// non-well-known top-level key straight into the DB `properties` JSONB column).
// Both java.js (`field_declaration`) and typescript.js
// (`public_field_definition` + constructor parameter properties) call this
// through `ctx.nodes` rather than each hand-rolling the same dedup/append.
function recordClassField(ctx, classIdx, fieldName, typeName) {
  if (classIdx === undefined || classIdx === null || !fieldName || !typeName) return;
  const classNode = ctx.nodes[classIdx];
  if (!classNode) return;
  if (!Array.isArray(classNode.fields)) classNode.fields = [];
  if (!classNode.fields.some((f) => f.name === fieldName)) {
    classNode.fields.push({ name: fieldName, type: typeName });
  }
}

// ─── language-neutral walk skeleton ──────────────────────────────────────
//
// walkGeneric is the language-neutral walk. Anything that must branch on the
// specific grammar — inheritance/conformance resolution, decorator edges,
// per-grammar type-reference collection — belongs to that language and lives in
// its own `extractors/<lang>.js`, driven through the three callable hooks below
// (`importHandler`, `resolveFunctionNameFn`, `extraWalkFn`) plus the `scratch`
// bag. This function handles only the language-neutral remainder: dispatch on
// `LanguageConfig` node-type sets, name/body resolution, same-file class/method
// registration, import registration, and call-target extraction. It must never
// branch on which grammar it is walking.

// A config-driven language extractor builds one of these and passes it to
// walkGeneric — it never edits walkGeneric itself.
function LanguageConfig(overrides) {
  return Object.freeze(Object.assign({
    classTypes: new Set(),
    functionTypes: new Set(),
    importTypes: new Set(),
    callTypes: new Set(),
    staticPropTypes: new Set(),

    nameField: 'name',
    nameFallbackChildTypes: [],

    bodyField: 'body',
    bodyFallbackChildTypes: [],

    callFunctionField: 'function',
    // per-callType override of callFunctionField — Map<nodeType, fieldName>|
    // null. Only a callType present as a key gets the override; every other
    // callType keeps using the plain callFunctionField above. Exists because
    // new_expression's callee lives under `constructor`, not `function`.
    calleeFieldByType: null,
    // the subset of callTypes that are a construction (`new Foo()`) rather than
    // an invocation — persisted as INSTANTIATES instead of CALLS. Empty for
    // every language that doesn't set it (byte-identical CALLS-only behaviour).
    instantiationNodeTypes: new Set(),
    callAccessorNodeTypes: new Set(),
    callAccessorField: 'attribute',
    callAccessorObjectField: 'object',
    // for a grammar that exposes the receiver as a SIBLING field on the call
    // node itself (Java's method_invocation: `object` + `name` fields on the
    // same node) rather than nested under a wrapping member-expression-style
    // node the callAccessorNodeTypes mechanism above expects. Only consulted
    // when callAccessorNodeTypes did not already match, so every existing
    // nested-wrapper language is untouched. Null (unset) for every language but
    // java.js.
    callObjectField: null,
    // the literal receiver-token spellings (read via callAccessorObjectField)
    // that mean "the current instance" for this language — 'this' (js/ts/
    // csharp/...), 'self' (python/...). Only consulted inside the
    // callAccessorNodeTypes branch, so a language whose call-target extraction
    // never reaches the object field (java.js's divergence, kotlin/swift's own
    // extraWalkFn passes) gets no benefit from setting this until it also wires
    // the accessor branch.
    selfTokens: new Set(),

    functionBoundaryTypes: new Set(),

    // (node, source, ctx) -> [{name, alias?, module?}] | null | undefined
    // `module` is the dotted/qualified module or package path an import
    // evidences (e.g. Python's `from pkg.security import safe_fetch` -> module
    // "pkg.security"); `name` stays the imported symbol/local name. Consumed by
    // resolution/symbol-index.js#moduleStem.
    importHandler: null,
    // (node, source, ctx) -> string | null — overrides the default
    // nameField/nameFallbackChildTypes resolution for function-like nodes
    // (e.g. an owning language's declarator-unwrapping rule).
    resolveFunctionNameFn: null,
    functionLabelParens: true,
    // (node, source, ctx) -> void — called for every node during the main
    // walk, after this skeleton's own class/function handling for that node.
    // The one place an owning language may call ctx.addNode/ctx.addEdge to
    // add behaviour this skeleton does not model (e.g. inheritance edges).
    extraWalkFn: null,

    // METHOD node payload depth (args/is_async/decorators/class_context).
    // class_context needs no config — it dereferences parentClassIdx, already
    // in scope in walk().
    //
    // args: the field name on the function/method node whose value is the
    // parameter-list container (tried via childForFieldName). Falls back to
    // paramsContainerTypes (a direct-child type search, for grammars with no
    // field name on the container — e.g. Kotlin's function_value_parameters)
    // when the field lookup misses. paramsAreDirectChildren skips both and
    // treats the function node's own children as the entries (Swift, whose
    // grammar has no parameter-list wrapper node at all).
    paramsField: 'parameters',
    paramsContainerTypes: new Set(),
    paramsAreDirectChildren: false,
    // (node) -> paramsContainer|null — full override for a grammar where the
    // container is nested behind another field (C/C++: function_definition's
    // own params live on the `declarator` child's `parameters` field, not on
    // function_definition itself).
    resolveParamsFn: null,
    // The container's direct-child node types that are individual parameter
    // entries (skips the container's own punctuation children). Empty Set =
    // args unsupported for this language (extractArgNames short-circuits).
    paramEntryTypes: new Set(),

    // is_async: the exact token text (e.g. 'async') that, if it equals the
    // full text of any DIRECT child of the function node, marks it async.
    // Text-based (not type-based) because some grammars fold the keyword
    // into a generic wrapper node (C#'s `modifier` covers public/async/...
    // alike — only the text disambiguates). Null = language has no such
    // keyword; no false positives are risked by leaving it unset.
    asyncMarkerText: null,

    // decorators/annotations: one Set of the node types that ARE a single
    // decorator/annotation, plus exactly one discovery strategy for WHERE to
    // look for them (grammars disagree on this):
    //   - decoratorParentWrapTypes: the function node's PARENT wraps
    //     [decorator*, functionNode] as siblings (Python's
    //     decorated_definition) — decoratorNodeTypes siblings before the
    //     function node in parent.children.
    //   - decoratorContainerTypes: a DIRECT CHILD of the function node
    //     itself is a named container (Java/Swift's `modifiers`, C#/PHP's
    //     `attribute_list`) whose own children (searched up to 2 levels deep,
    //     for PHP's attribute_list > attribute_group > attribute nesting)
    //     include decoratorNodeTypes members.
    //   - decoratorSiblingScan: decorator nodes are the function node's own
    //     immediate PRECEDING siblings within the same parent (TypeScript's
    //     class_body — decorators are not wrapped or field-attached at all).
    // At most one strategy is set per language; collectDecorators checks
    // them in the order above and returns on the first that applies.
    decoratorNodeTypes: new Set(),
    decoratorParentWrapTypes: new Set(),
    decoratorContainerTypes: new Set(),
    decoratorSiblingScan: false,

    // cyclomatic complexity. Node types are verified live per grammar via a
    // direct parse probe — different tree-sitter grammar builds disagree on
    // node-type spellings (e.g. "binary_expression" vs "logical_expression"),
    // so the web-tree-sitter grammars this file loads are the source of truth.
    //
    // branchNodeTypes: each occurrence is +1 decision point (if/elif,
    // loop headers, case/when ARMS — not the switch/when header itself, to
    // avoid double-counting a switch once for its header and again per case
    // — catch clauses, ternaries; a distinct-typed logical-and/or node when
    // the grammar gives one, e.g. Kotlin's conjunction_expression/
    // disjunction_expression, Python's boolean_operator).
    branchNodeTypes: new Set(),
    // branchArmDefaultTypes: the subset of branchNodeTypes whose members can
    // BE a `default:`/`default_keyword`/`else` fallback arm sharing the SAME
    // node type as a real case/when arm (verified live: C's case_statement,
    // Java's switch_label, Swift's switch_entry, Zig's switch_case) — a
    // default/else arm adds no new decision, so isDefaultArm excludes it.
    // Languages whose grammar gives default its own distinct type (C#'s
    // default_switch_label, JS/TS's switch_default, PHP's default_statement)
    // never put that type in branchNodeTypes, so this stays empty for them.
    branchArmDefaultTypes: new Set(),
    // logicalOperatorField/logicalOperatorTokens: grammars that fold &&/||
    // (and Python-family and/or) into one generic binary node (JS's
    // binary_expression, Ruby's `binary`, Scala's infix_expression, Zig's
    // binary_expression which ALSO uses literal `and`/`or`) expose the real
    // operator on a field (verified live: named 'operator' in every grammar
    // checked). Checked by TEXT, not .type — Scala's field node is itself
    // always typed `operator_identifier` regardless of which operator it
    // holds, so only .text disambiguates; every other checked grammar's
    // field node's .type already equals its .text for a leaf token, so text
    // comparison is a strict superset, not a special case.
    logicalOperatorField: null,
    logicalOperatorTokens: new Set(),
    // customBranchFn: (node) -> boolean, an escape hatch for a grammar whose
    // control-flow constructs are not distinguishable by node TYPE at all —
    // Elixir's if/unless/for/case/cond are all the generic `call` node type
    // (the macro name is a child's TEXT, not a type) — see elixir.js's own
    // config for the concrete predicate. Unset for every walkGeneric
    // language; only elixir.js (a bespoke, non-walkGeneric extractor) uses
    // it, passed directly into computeCyclomatic's config argument.
    customBranchFn: null,
  }, overrides || {}));
}

// ─── METHOD payload depth helpers ────────────────────────────────────────
//
// Shared by walkGeneric's own METHOD creation (via config's paramsField/
// paramEntryTypes/decoratorNodeTypes/asyncMarkerText, above) AND the 5 bespoke
// extractors (go/objc/zig/rust/elixir — args-only, no LanguageConfig to hang
// the other three fields off), which call paramEntryName/extractArgs directly
// against their own hand-resolved parameter-list node. Exported at module
// bottom.

// Leaf node types across the 18 grammars this codebase loads whose text IS
// the bare parameter/binding name — verified live per grammar (not
// 'type_identifier': ObjC's `method_parameter` nodes nest a type_identifier
// BEFORE their own identifier child for a pointer type ("NSString *"), so
// including it would misidentify the type as the arg name).
const _IDENT_LEAF_TYPES = new Set(['identifier', 'simple_identifier', 'name']);

// Breadth-first, depth-limited (grammars nest a splat/rest/pattern wrapper
// at most 2-3 deep — python's list_splat_pattern, TS's rest_pattern) search
// for the first identifier-shaped descendant, checking every node at each
// depth level before descending further so a parameter's OWN name (always
// textually first) is found before a default value expression that happens
// to also contain an identifier.
function _identLeafName(node, depth) {
  if (!node) return null;
  if (_IDENT_LEAF_TYPES.has(node.type)) return _readText(node);
  if ((depth || 0) > 4) return null;
  const children = node.children || [];
  for (const c of children) {
    if (_IDENT_LEAF_TYPES.has(c.type)) return _readText(c);
  }
  for (const c of children) {
    const found = _identLeafName(c, (depth || 0) + 1);
    if (found) return found;
  }
  return null;
}

// Resolves one parameter-list entry node (e.g. python's typed_default_parameter,
// TS's required_parameter, a bare identifier) to its bare name. Tries the
// grammar's own name-carrying field first (field names across python/TS/JS/C/
// C++/Java/C#/Ruby: 'name', 'pattern', 'declarator', 'left'), then falls back
// to the first identifier-shaped descendant. Identifier names only — the `*`/
// `**` prefix on splat params is dropped uniformly so one mechanism covers
// every grammar's splat/rest/variadic shape instead of a per-type branch per
// language.
function paramEntryName(node) {
  if (!node) return null;
  if (_IDENT_LEAF_TYPES.has(node.type)) return _readText(node);
  for (const f of ['name', 'pattern', 'declarator', 'left']) {
    const n = node.childForFieldName(f);
    if (!n) continue;
    if (_IDENT_LEAF_TYPES.has(n.type)) return _readText(n);
    const inner = _identLeafName(n, 1);
    if (inner) return inner;
  }
  return _identLeafName(node, 1);
}

// Extracts arg names from a resolved parameter-list container. `entryTypes`
// (a Set) filters the container's direct children to real parameter entries,
// skipping its own punctuation ('(', ')', ',') — when omitted/empty, falls
// back to tree-sitter's own isNamed flag (used by the bespoke elixir.js
// extractor, whose parameter shapes are too varied — plain identifier,
// `\\`-default binary_operator, map/tuple destructuring — for a fixed type
// allowlist to be worth maintaining).
function extractArgs(container, entryTypes) {
  if (!container) return [];
  const out = [];
  for (const child of container.children || []) {
    if (entryTypes && entryTypes.size) {
      if (!entryTypes.has(child.type)) continue;
    } else if (!child.isNamed) {
      continue;
    }
    const nm = paramEntryName(child);
    if (nm) out.push(nm);
  }
  return out;
}

// Resolves `fnNode`'s parameter-list container per `config` (paramsField ->
// paramsContainerTypes -> paramsAreDirectChildren, in that order — see
// LanguageConfig's own field comments for why each exists), then delegates
// to extractArgs. Returns [] (not undefined) for a language with no
// paramEntryTypes configured, so callers can always spread the result.
// The raw parameter-list TEXT, resolved by exactly the same container waterfall
// as extractArgNames. Emitting `params` (the full text, e.g. `Widget(int x)`)
// alongside `args` (names only) lets ingest-helpers.js's method-identity
// qualifier build a stable canonical key via its params-first precedence.
function resolveParamsContainer(fnNode, config) {
  if (config.resolveParamsFn) return config.resolveParamsFn(fnNode);
  if (config.paramsAreDirectChildren) return fnNode;
  let container = config.paramsField ? fnNode.childForFieldName(config.paramsField) : null;
  if (!container && config.paramsContainerTypes && config.paramsContainerTypes.size) {
    container = (fnNode.children || []).find((c) => config.paramsContainerTypes.has(c.type)) || null;
  }
  return container;
}

function extractParamsText(fnNode, config) {
  const container = resolveParamsContainer(fnNode, config);
  if (!container || typeof container.text !== 'string') return null;
  // `paramsAreDirectChildren` makes the container the FUNCTION node itself, so its text is the
  // whole declaration, not a parameter list — Swift keyed a method as
  // `Repo(func load() { helper() })::load` when this guard was missing. Only a container that
  // is a distinct node from the declaration can be read as parameter text.
  if (container === fnNode) return null;
  return container.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim();
}

function extractArgNames(fnNode, config) {
  if (!config.paramEntryTypes || !config.paramEntryTypes.size) return [];
  let container;
  if (config.resolveParamsFn) {
    container = config.resolveParamsFn(fnNode);
  } else if (config.paramsAreDirectChildren) {
    container = fnNode;
  } else {
    container = config.paramsField ? fnNode.childForFieldName(config.paramsField) : null;
    if (!container && config.paramsContainerTypes && config.paramsContainerTypes.size) {
      container = (fnNode.children || []).find((c) => config.paramsContainerTypes.has(c.type)) || null;
    }
  }
  return extractArgs(container, config.paramEntryTypes);
}

// True iff any DIRECT child of `fnNode` has text exactly equal to
// config.asyncMarkerText — see LanguageConfig's own comment for why this is
// text- not type-keyed (C#'s `async` modifier shares its node type with
// every other modifier).
function detectAsync(fnNode, config) {
  if (!config.asyncMarkerText) return false;
  for (const c of fnNode.children || []) {
    if (_readText(c) === config.asyncMarkerText) return true;
  }
  return false;
}

// Depth-limited scan of a decorator CONTAINER node (java's `modifiers`,
// php's `attribute_list`) for members of `types`. Does not recurse into a
// matched node (a decorator's own internal structure is never itself a
// nested decorator).
function _scanDecoratorContainer(container, types, depth) {
  const out = [];
  for (const c of container.children || []) {
    if (types.has(c.type)) { out.push(_readText(c)); continue; }
    if (depth > 0) out.push(..._scanDecoratorContainer(c, types, depth - 1));
  }
  return out;
}

// Collects decorator/annotation text for `fnNode` per config's single
// discovery strategy — see LanguageConfig's decoratorNodeTypes comment for
// why there are three and which languages use which. Returns [] when
// decoratorNodeTypes is unset (default) or the strategy finds nothing.
function collectDecorators(fnNode, config) {
  if (!config.decoratorNodeTypes || !config.decoratorNodeTypes.size) return [];
  if (config.decoratorParentWrapTypes.size && fnNode.parent && config.decoratorParentWrapTypes.has(fnNode.parent.type)) {
    const out = [];
    for (const c of fnNode.parent.children || []) {
      if (c.id === fnNode.id) break; // decorators precede the function node itself
      if (config.decoratorNodeTypes.has(c.type)) out.push(_readText(c));
    }
    return out;
  }
  if (config.decoratorContainerTypes.size) {
    const out = [];
    for (const c of fnNode.children || []) {
      if (config.decoratorContainerTypes.has(c.type)) out.push(..._scanDecoratorContainer(c, config.decoratorNodeTypes, 2));
    }
    if (out.length) return out;
  }
  if (config.decoratorSiblingScan && fnNode.parent) {
    const siblings = fnNode.parent.children || [];
    const idx = siblings.findIndex((c) => c.id === fnNode.id);
    const out = [];
    for (let i = idx - 1; i >= 0; i--) {
      if (config.decoratorNodeTypes.has(siblings[i].type)) { out.unshift(_readText(siblings[i])); continue; }
      // a `comment` sibling (JSDoc immediately above a decorated method, e.g.
      // `@deco\n/** ... */\nfoo(){}`) sits between the decorator and the method
      // in TS's class_body. Skip over it without breaking the "consecutive
      // decorators" chain; any OTHER node type still legitimately breaks it (it
      // means the decorator belongs to a different member).
      if (siblings[i].type === 'comment') continue;
      break; // only consecutive decorators (comments aside) immediately above belong to this node
    }
    return out;
  }
  return [];
}

// ─── cyclomatic complexity ────────────────────────────────────────────────
//
// True iff `node` is a case/when/switch ARM whose own children mark it as
// the default/else fallback (a shared node type with real arms — see
// LanguageConfig's branchArmDefaultTypes comment for which grammars need
// this at all). Checked as a direct-child TYPE match, not text, since every
// grammar surveyed spells the fallback keyword as its own leaf node type.
function _isDefaultArm(node) {
  for (const c of node.children || []) {
    if (c.type === 'default' || c.type === 'default_keyword' || c.type === 'else') return true;
  }
  return false;
}

// Depth-limited decision-point counter: base count 1, +1 per branchNodeTypes/
// logicalOperatorTokens/customBranchFn match, MAX_AST_DEPTH guard with an
// "underestimate" warning instead of throwing. `config` is duck-typed (not
// necessarily a full LanguageConfig — the 5 bespoke extractors pass a plain
// object with the same field names, see e.g. elixir.js).
//
// Does not descend into a nested function/class boundary (config.functionTypes/
// config.classTypes, when supplied) — they carry their own. A nested named
// function/class matching those sets gets its OWN METHOD/CLASS node and its own
// computeCyclomatic call elsewhere in the same walk; not skipping it here would
// double-count its branches into the outer function's total. An anonymous
// inline closure that never becomes its own node (JS arrow callbacks, Elixir
// `fn`) is NOT skipped — it carries nothing of its own anywhere else, so
// folding its branches into the enclosing function is the only way they are not
// simply lost.
//
// Returns 1 (not undefined/0) for a null bodyNode (abstract/interface method
// with no body) — the "default 1" behaviour, produced here for free rather than
// as a separate write-time fallback.
const _MAX_COMPLEXITY_DEPTH = 200;
function computeCyclomatic(bodyNode, config) {
  if (!bodyNode) return 1;
  let count = 1;
  let skipped = false;
  const branchNodeTypes = config.branchNodeTypes || new Set();
  const branchArmDefaultTypes = config.branchArmDefaultTypes || new Set();
  const logicalOperatorField = config.logicalOperatorField || null;
  const logicalOperatorTokens = config.logicalOperatorTokens || new Set();
  const customBranchFn = config.customBranchFn || null;
  const functionTypes = config.functionTypes || null;
  const classTypes = config.classTypes || null;

  function traverse(node, depth) {
    if (depth > _MAX_COMPLEXITY_DEPTH) { skipped = true; return; }
    const t = node.type;
    // node.isNamed guard: some grammars (verified live — Ruby's if/elsif/
    // when/rescue/for/while) give a statement's own leading KEYWORD LEAF
    // token the exact same `type` string as the named statement node that
    // wraps it (Ruby's `if` node has an unnamed child also typed `if`).
    // Without this guard a single `if` would match branchNodeTypes TWICE —
    // once for the real decision, once for its own keyword token — silently
    // doubling every affected language's count. A real decision point is
    // always the named node; never count the anonymous keyword-token twin.
    if (node.isNamed && branchNodeTypes.has(t)) {
      if (!(branchArmDefaultTypes.has(t) && _isDefaultArm(node))) count++;
    } else if (logicalOperatorField && logicalOperatorTokens.size) {
      const op = node.childForFieldName(logicalOperatorField);
      if (op && logicalOperatorTokens.has(op.text)) count++;
    }
    if (customBranchFn && customBranchFn(node)) count++;
    for (const child of node.children || []) {
      if (functionTypes && functionTypes.has(child.type)) continue;
      if (classTypes && classTypes.has(child.type)) continue;
      traverse(child, depth + 1);
    }
  }
  traverse(bodyNode, 0);
  if (skipped) {
    console.warn(`[complexity] AST depth exceeded ${_MAX_COMPLEXITY_DEPTH} levels; cyclomatic_complexity may be underestimated.`);
  }
  return count;
}

// walkGeneric(tree, source, config) -> { nodes, edges } in the extractors/base.js
// contract shape (node_type/name/start_line/end_line on nodes;
// from/to/edge_type/resolution/evidence_line on edges, `from`/`to` as indices
// into the returned `nodes` array — the same shape extractors/go.js already
// returns). Callers stamp `_sourceFile` onto every node afterward (this
// function is not given a file path) and are expected to have already parsed
// `tree` from `source` through base.js's own loadGrammar.
function walkGeneric(tree, source, config) {
  const root = tree.rootNode;
  const nodes = [];
  const edges = [];
  const classByName = new Map();
  const methodByName = new Map();
  // Names defined by more than one METHOD in the file. methodByName is first-wins, so a bare call
  // `foo()` to an ambiguous name would otherwise bind, at same_file/EXTRACTED grade, to whichever
  // `foo` the walk saw first — a confident wrong edge across scopes. Tracked so the bare-call path
  // can refuse to guess and defer to the branch-wide resolver instead.
  const ambiguousMethodNames = new Set();
  // FREE (module/file-level) functions, by name, and the names that have more than one. A bare call
  // with no receiver reaches a free function, not a class member (members need this/self/an alias,
  // handled on the accessor path), so this is the preferred target when a same-named method also
  // exists inside some class.
  const freeFunctionByName = new Map();
  const ambiguousFreeFunctions = new Set();
  const importByAlias = new Map();
  const importedAliases = new Set();
  // flat import-fact list — see registerImportFact's header for shape/consumer.
  const importFacts = [];
  const functionBodies = [];
  const scratch = {};

  // walkCalls(node, callerIdx) does not see parentClassIdx — it is threaded
  // only through walk() and discarded after DEFINED_IN emission. Tier-1 self/
  // this-receiver resolution needs to know, given the CALLING method's node
  // index, which CLASS it belongs to and what that class's own method names
  // resolve to — built here, at METHOD creation time in walk(), where
  // parentClassIdx is still in scope.
  const methodParentClass = new Map(); // methodIdx -> classIdx
  const classMethods = new Map(); // classIdx -> Map<methodName, methodIdx>

  // Tracks which AST nodes (keyed by web-tree-sitter's own stable `.id`, not
  // object identity, since repeated `.children` access can hand back distinct
  // wrapper objects for the same underlying node) already own a
  // `functionBodies` entry and will therefore be walked as their own root in
  // the `for (... of functionBodies)` loop below. walkCalls' boundary-skip
  // (below) consults this so it only skips a functionBoundaryTypes child when
  // that child is ACTUALLY going to be visited separately — an arrow_function
  // that is not independently registered (the overwhelming majority: inline
  // callbacks, event handlers, JSX props, ...) instead falls through and is
  // walked in-line, attributing its calls to whichever named function/method/
  // registered-const currently owns the traversal.
  const registeredCallableIds = new Set();
  // Registers `bodyNode` as its own walkCalls root owned by `nodeIndex`, and
  // marks `boundaryNode` (the AST node that will be seen as a `child` by some
  // OTHER walkCalls traversal — e.g. the arrow_function value of a module-level
  // `const f = () => {}`) as "already going to be visited on its own," so the
  // boundary-skip below does not re-walk it a second time under the wrong
  // caller. `extraWalkFn` implementations (typescript.js/javascript.js's
  // module-level const/arrow handling) are the only callers outside this
  // skeleton's own functionTypes branch, which calls the equivalent logic
  // inline further down.
  function registerCallableBody(nodeIndex, bodyNode, boundaryNode) {
    if (!bodyNode) return;
    functionBodies.push({ nodeIndex, body: bodyNode });
    if (boundaryNode) registeredCallableIds.add(boundaryNode.id);
  }

  function addNode(n) {
    nodes.push(n);
    return nodes.length - 1;
  }
  // `calleeName` is optional (DEFINED_IN/EXTENDS callers never pass it — there
  // is no "callee", the target IS the node) and, when present, is the intended
  // callee name a CALLS edge resolved against — the inheritance-upgrade
  // prerequisite (a candidate name to re-try up the parent chain) and the
  // provenance ingest.js's writers persist as properties.called_name.
  function addEdge(from, to, edge_type, resolution, evidence_line, calleeName) {
    edges.push({ from, to, edge_type, resolution, evidence_line, calleeName: calleeName ?? null });
  }

  // a supertype/interface name an `extraWalkFn` cannot resolve to a same-file
  // `classByName` entry is captured here as a deferred marker rather than
  // dropped, mirroring `unresolvedCalls` below, so
  // ast-extractor.js#_adaptPortedResult can route it into the
  // `inheritanceEdges` bucket (branch-wide name resolution, `confidenceTier:
  // 'INFERRED'` — never the same-file `EXTRACTED` tier: a name-guessed edge
  // must not reuse the top tier).
  const unresolvedInheritance = [];
  const seenUnresolvedInheritance = new Set();
  function addUnresolvedInheritance(from, toName, edge_type) {
    if (from === undefined || !toName || !edge_type) return;
    const key = `${from}::${toName}::${edge_type}`;
    if (seenUnresolvedInheritance.has(key)) return;
    seenUnresolvedInheritance.add(key);
    unresolvedInheritance.push({ from, toName, edge_type });
  }

  // a declared field's TYPE name that could not be resolved to a same-file
  // CLASS (the owning language's extraWalkFn already tries that directly via
  // classByName) is queued here instead of dropped —
  // ast-extractor.js#_adaptPortedResult forwards it as `typeReferences`
  // ({fromIndex, toName, line}), ingest-file-processor.js maps fromIndex -> the
  // written node id, and ingest.js's dedicated resolveTypeReferenceEdges pass
  // tries import evidence ONLY (no module_stem/global_label fallback —
  // REFERENCES has no heuristic variant) before writing a REFERENCES edge.
  const unresolvedTypeReferences = [];
  const seenUnresolvedTypeReferences = new Set();
  function addTypeReference(from, toName, line) {
    if (from === undefined || !toName) return;
    const key = `${from}::${toName}`;
    if (seenUnresolvedTypeReferences.has(key)) return;
    seenUnresolvedTypeReferences.add(key);
    unresolvedTypeReferences.push({ from, toName, line: line ?? null });
  }

  // a re-export (`export {x} from './y'`) is FILE-to-FILE evidence, not
  // node-to-node — no fromIdx to anchor on (a pure-barrel file may have no
  // CLASS/METHOD at all, same reason importFacts carries no node index either).
  // Resolved at ingest time (ingest.js#resolveReExportEdges) against the
  // branch's FILE nodes via the same relative-path ladder
  // resolveViaImportEvidence uses.
  const reExportFacts = [];
  function addReExportFact(module, line) {
    if (!module) return;
    reExportFacts.push({ module, line: line ?? null });
  }
  function ln(n) { return n.startPosition.row + 1; }
  function endLn(n) { return n.endPosition.row + 1; }

  function resolveName(node) {
    let nameNode = node.childForFieldName(config.nameField);
    if (!nameNode && config.nameFallbackChildTypes.length) {
      nameNode = (node.children || []).find((c) => config.nameFallbackChildTypes.includes(c.type));
    }
    return nameNode ? _readText(nameNode) : null;
  }
  function resolveBody(node) {
    let bodyNode = node.childForFieldName(config.bodyField);
    if (!bodyNode && config.bodyFallbackChildTypes.length) {
      bodyNode = (node.children || []).find((c) => config.bodyFallbackChildTypes.includes(c.type));
    }
    return bodyNode;
  }

  const ctx = {
    addNode, addEdge, addUnresolvedInheritance, addTypeReference, addReExportFact, classByName, methodByName, importByAlias, importedAliases,
    importFacts,
    line: ln, endLine: endLn, scratch, registerCallableBody,
    // the live `nodes` array, exposed so an `extraWalkFn` (java.js/
    // typescript.js) can attach `fields` (declared field types, `{name,
    // type}[]`) directly onto an already-created CLASS node it looks up via
    // `classByName` — the same array `addNode` pushes into and
    // `mergeSameFileDuplicates`/`writeNode` (ingest.js) read from afterward, so
    // a mutation here survives to the DB write untouched (top-level node keys
    // become `properties.*` at write time, mirroring how IMPORT nodes carry
    // `module`/`alias` as plain top-level keys).
    nodes,
  };

  // call-site reachability is measured against total call_expression nodes in
  // the AST, not against edges emitted. `walk` above recurses into every node
  // unconditionally (no functionBoundaryTypes skip — only walkCalls has that),
  // so it is the correct place to count the TRUE total; `reachableCallSites`
  // (walkCalls, below) counts how many of those this extraction visits.
  let totalCallSites = 0;
  let reachableCallSites = 0;

  function walk(node, parentClassIdx) {
    const t = node.type;

    if (config.callTypes.has(t)) totalCallSites++;

    if (config.importTypes.has(t)) {
      const imported = config.importHandler ? (config.importHandler(node, source, ctx) || []) : [];
      for (const im of imported) {
        if (!im || !im.name) continue;
        registerImportFact(ctx, { name: im.name, alias: im.alias, module: im.module, line: ln(node) });
      }
      return;
    }

    let nextParent = parentClassIdx;

    if (config.classTypes.has(t)) {
      const name = resolveName(node);
      if (name) {
        if (!classByName.has(name)) {
          const idx = addNode({
            node_type: 'CLASS', name,
            summary: name,
            start_line: ln(node), end_line: endLn(node),
            confidence_tier: 'EXTRACTED', confidence: 1.0,
          });
          classByName.set(name, idx);
          if (parentClassIdx !== undefined && parentClassIdx !== idx) {
            addEdge(idx, parentClassIdx, 'DEFINED_IN', 'same_file', ln(node));
          }
          nextParent = idx;
        } else {
          nextParent = classByName.get(name);
        }
      }
    } else if (config.functionTypes.has(t)) {
      const name = config.resolveFunctionNameFn ? config.resolveFunctionNameFn(node, source, ctx) : resolveName(node);
      if (name) {
        // TOP-LEVEL keys, not a nested `properties` sub-object —
        // changed-file-replacement.js#prepareNodeRow and ingest.js#writeNode
        // both spread the WHOLE node into the DB `properties` JSONB column and
        // strip only the known top-level columns (node_type/name/summary/...),
        // so a node key literally named `properties` survives that spread as
        // its OWN nested key, double-wrapping to `properties.properties.args` in
        // the DB instead of `properties.args`. This mirrors the convention
        // IMPORT's module/alias and CLASS.fields already use.
        const extra = {};
        if (config.paramEntryTypes && config.paramEntryTypes.size) {
          extra.args = extractArgNames(node, config);
          const paramsText = extractParamsText(node, config);
          if (paramsText !== null) extra.params = paramsText;
        }
        if (detectAsync(node, config)) extra.is_async = true;
        const decorators = collectDecorators(node, config);
        if (decorators.length) extra.decorators = decorators;
        if (parentClassIdx !== undefined) {
          const parentClassNode = nodes[parentClassIdx];
          if (parentClassNode && parentClassNode.name) extra.class_context = parentClassNode.name;
        }
        // resolved once, up front, so it is available both for the complexity
        // count (needs it now, at node creation) and the registerCallableBody
        // call below.
        const bodyNode = resolveBody(node);
        extra.cyclomatic_complexity = computeCyclomatic(bodyNode, config);
        const idx = addNode({
          node_type: 'METHOD', name,
          summary: config.functionLabelParens ? `${name}()` : name,
          start_line: ln(node), end_line: endLn(node),
          confidence_tier: 'EXTRACTED', confidence: 1.0,
          ...extra,
        });
        if (!methodByName.has(name)) methodByName.set(name, idx);
        else ambiguousMethodNames.add(name);
        if (parentClassIdx === undefined) {
          if (!freeFunctionByName.has(name)) freeFunctionByName.set(name, idx);
          else ambiguousFreeFunctions.add(name);
        }
        if (parentClassIdx !== undefined) {
          addEdge(idx, parentClassIdx, 'DEFINED_IN', 'same_file', ln(node));
          methodParentClass.set(idx, parentClassIdx);
          if (!classMethods.has(parentClassIdx)) classMethods.set(parentClassIdx, new Map());
          const methods = classMethods.get(parentClassIdx);
          if (!methods.has(name)) methods.set(name, idx);
        }
        if (bodyNode) registerCallableBody(idx, bodyNode, node);
      }
    }

    if (config.extraWalkFn) config.extraWalkFn(node, source, ctx);

    for (const child of node.children || []) walk(child, nextParent);
  }
  walk(root, undefined);

  // Call-target extraction, deferred until every class/function in the file
  // is registered — mirrors the two-pass shape extractors/go.js already uses.
  const seenPairs = new Set();
  // a bare callee name with no same-file target is captured as a 'deferred'
  // marker and queued in unresolvedCalls, so ingest-file-processor.js can carry
  // it into pendingEdges for the ingest tail (ingest.js#resolveAndWriteEdges)
  // to resolve once the branch-wide fileIndex/symbolIndex exist (the
  // module-stem/global-label resolvers need the branch-wide index this per-file
  // extractor cannot see).
  const unresolvedCalls = [];
  const seenDeferred = new Set();
  // `callerIdx` threaded in so the accessor branch can look up the CALLING
  // method's own class. Every accessor branch that doesn't resolve to an import
  // returns an explicit 'unresolved_accessor' marker carrying the receiver name
  // (rather than `return null` with no residue), so later resolution passes
  // have something to consume.
  function resolveCall(node, callerIdx) {
    if (!config.callTypes.has(node.type)) return null;
    // per-callType callee-field map — walkGeneric otherwise supports exactly
    // ONE calleeField (`callFunctionField`) across every member of `callTypes`,
    // which is why `new_expression` (whose callee lives under a `constructor`
    // field, not `function`) would be refused rather than silently wired to
    // `undefined`. `calleeFieldByType`, when set, overrides `callFunctionField`
    // for the specific node type; every other callType — and every language
    // that never sets this map — is byte-identical.
    const calleeField = (config.calleeFieldByType && config.calleeFieldByType.has(node.type))
      ? config.calleeFieldByType.get(node.type)
      : config.callFunctionField;
    const funcNode = node.childForFieldName(calleeField);
    if (!funcNode) return null;
    // `instantiationNodeTypes` marks which `callTypes` members are a
    // construction, not an invocation (the `new_expression`/
    // `object_creation_expression` split). Resolution/tier machinery is
    // identical to CALLS (same import/module-stem/global-label waterfall); only
    // the persisted edge_type differs.
    const edgeType = (config.instantiationNodeTypes && config.instantiationNodeTypes.has(node.type)) ? 'INSTANTIATES' : 'CALLS';

    let objectNode = null;
    let attrNode = null;
    let isAccessor = false;
    if (config.callAccessorNodeTypes.has(funcNode.type)) {
      objectNode = funcNode.childForFieldName(config.callAccessorObjectField);
      attrNode = funcNode.childForFieldName(config.callAccessorField);
      isAccessor = true;
    } else if (config.callObjectField) {
      // java.js's `callObjectField: 'object'` — method_invocation carries
      // `object`/`name` as two SIBLING fields on the call node itself, not
      // nested under a wrapping node funcNode.type could match against
      // callAccessorNodeTypes. Only tried when the accessor-node-type branch
      // above didn't already match, so JS/TS/Go/... (which never set
      // callObjectField) are byte-identical.
      const sibling = node.childForFieldName(config.callObjectField);
      if (sibling) {
        objectNode = sibling;
        attrNode = funcNode;
        isAccessor = true;
      }
    }

    if (isAccessor) {
      if (!attrNode) return null;
      const receiverName = objectNode ? _readText(objectNode) : '';
      const calleeName = _readText(attrNode);
      if (!calleeName) return null; // no callee evidence at all — nothing to report
      if (config.selfTokens.has(receiverName)) {
        // Tier 1: self/this-qualified call inside the SAME class as the caller
        // — proof, not a guess (1.00 confidence).
        const classIdx = methodParentClass.get(callerIdx);
        const methods = classIdx !== undefined ? classMethods.get(classIdx) : undefined;
        const targetIdx = methods ? methods.get(calleeName) : undefined;
        if (targetIdx !== undefined) {
          return { targetIdx, resolution: 'this_receiver', calleeName, edgeType };
        }
        // Miss: inherited-from-parent or dynamically dispatched — a later pass
        // tries the inheritance chain. Canonicalised to 'self' regardless of
        // the language's literal token (this/super/self) — the marker means
        // "same-instance receiver", not the spelling.
        return { targetIdx: undefined, resolution: 'unresolved_accessor', calleeName, receiverName: 'self', edgeType };
      }
      // An import-alias receiver is deferred to unresolvedCalls like every other
      // non-self accessor so resolve.js#resolveViaReceiverImport resolves it
      // branch-wide against the real import target (IMPORT nodes are retired, so
      // there is no same-file stub to target). No same-file evidence for a
      // non-self accessor — refuse to guess a target, but stop discarding the
      // call site.
      return { targetIdx: undefined, resolution: 'unresolved_accessor', calleeName, receiverName, edgeType };
    }
    const calleeName = _readText(funcNode);
    if (!calleeName) return null;
    // `_LANGUAGE_BUILTIN_GLOBALS` includes Python's `super` builtin (calleeName
    // text "super" on an `identifier`-typed funcNode — correct there: python.js's
    // `super().foo()` chains through the accessor branch above, and the bare
    // `super()` sub-call is genuinely noise). But a bare `super()`/`super(args)`
    // CONSTRUCTOR call in JS/TS has funcNode.type === 'super' — a dedicated
    // keyword-token node type, never `identifier` — and IS the real call site
    // (invoking the parent constructor), not noise. Gating the builtin filter
    // on funcNode.type !== 'super' keeps it without weakening the filter for any
    // language where "super" is genuinely just an identifier's text.
    if (_LANGUAGE_BUILTIN_GLOBALS.has(calleeName) && funcNode.type !== 'super') return null;
    // a construction targets a CLASS by definition — preferring classByName
    // first (CALLS keeps its methodByName-first order, unaffected) avoids a
    // same-named-method collision misdirecting `new Foo()` at a method instead
    // of the class.
    if (edgeType === 'INSTANTIATES') {
      const ctorTarget = classByName.has(calleeName) ? classByName.get(calleeName) : methodByName.get(calleeName);
      if (ctorTarget === undefined) return { targetIdx: undefined, resolution: 'deferred', calleeName, edgeType };
      return { targetIdx: ctorTarget, resolution: 'same_file', calleeName, edgeType };
    }
    // A bare call has no receiver, so it reaches a FREE (module/file-level) function, never a class
    // member — prefer a unique free function of that name. Failing that, bind only when the name is
    // UNAMBIGUOUS in the file; several same-named methods across scopes with no unique free function
    // is a guess (whichever the walk saw first), so defer to the branch-wide resolver instead.
    if (methodByName.has(calleeName)) {
      if (freeFunctionByName.has(calleeName) && !ambiguousFreeFunctions.has(calleeName)) {
        return { targetIdx: freeFunctionByName.get(calleeName), resolution: 'same_file', calleeName, edgeType };
      }
      if (!ambiguousMethodNames.has(calleeName)) {
        return { targetIdx: methodByName.get(calleeName), resolution: 'same_file', calleeName, edgeType };
      }
      return { targetIdx: undefined, resolution: 'deferred', calleeName, edgeType };
    }
    if (classByName.has(calleeName)) return { targetIdx: classByName.get(calleeName), resolution: 'same_file', calleeName, edgeType };
    return { targetIdx: undefined, resolution: 'deferred', calleeName, edgeType };
  }
  function walkCalls(node, callerIdx) {
    if (config.callTypes.has(node.type)) reachableCallSites++;
    const resolved = resolveCall(node, callerIdx);
    if (resolved) {
      // dedup keys carry edgeType so a genuine CALLS and INSTANTIATES to the
      // same target (rare — e.g. a same-named static factory method vs. a
      // class) are never collapsed into one. A language whose edgeType is
      // always 'CALLS' here is unaffected (constant suffix).
      const resolvedEdgeType = resolved.edgeType || 'CALLS';
      if (resolved.targetIdx !== undefined && resolved.targetIdx !== callerIdx) {
        const key = `${callerIdx}->${resolved.targetIdx}::${resolvedEdgeType}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          addEdge(callerIdx, resolved.targetIdx, resolvedEdgeType, resolved.resolution, ln(node), resolved.calleeName);
        }
      } else if (resolved.resolution === 'deferred' && resolved.calleeName) {
        const dkey = `${callerIdx}::${resolved.calleeName}::${resolvedEdgeType}`;
        if (!seenDeferred.has(dkey)) {
          seenDeferred.add(dkey);
          unresolvedCalls.push({ from: callerIdx, calleeName: resolved.calleeName, line: ln(node), edgeType: resolvedEdgeType });
        }
      } else if (resolved.resolution === 'unresolved_accessor' && resolved.calleeName) {
        const dkey = `${callerIdx}::${resolved.receiverName}::${resolved.calleeName}::${resolvedEdgeType}`;
        if (!seenDeferred.has(dkey)) {
          seenDeferred.add(dkey);
          unresolvedCalls.push({
            from: callerIdx, calleeName: resolved.calleeName, line: ln(node),
            receiverName: resolved.receiverName, edgeType: resolvedEdgeType,
          });
        }
      }
    }
    for (const child of node.children || []) {
      // the skip is conditional on the child having been independently
      // registered as its own callable (registerCallableBody, above) — a
      // function_declaration/method_definition/generator is registered whenever
      // its name resolves (i.e. always, in practice), so this is a no-op for
      // those. An arrow_function is registered ONLY when some extraWalkFn
      // explicitly called registerCallableBody for it (module-level const/arrow
      // handling); every other arrow — inline callbacks, event handlers, JSX
      // props, nested closures — is NOT registered, so it falls through here and
      // is walked in-line under the CURRENT callerIdx instead of being silently
      // skipped. Without this, EVERY arrow_function would unconditionally block
      // descent, leaving most call sites unreachable.
      if (config.functionBoundaryTypes.has(child.type) && registeredCallableIds.has(child.id)) continue;
      walkCalls(child, callerIdx);
    }
  }
  for (const { nodeIndex, body } of functionBodies) walkCalls(body, nodeIndex);

  // importFacts (no node indices, so no remap needed below) carries the imports
  // forward to the FILE node's properties.imports.

  // `edges`, `unresolvedCalls`, and `unresolvedInheritance` were all built
  // against `nodes` as it stood before the merge below — every `from`/`to` in
  // them is a pre-merge index and must be remapped, not just `edges`.
  // `unresolvedCalls`/`unresolvedInheritance` survive downstream as `{fromIndex,
  // ...}` (ast-extractor.js#_adaptPortedResult) resolved against the POST-merge
  // array (ingest-file-processor.js), so leaving their `from` unmapped would
  // corrupt them exactly like the edges bug, just one hop further downstream.
  const { nodes: merged, indexMap } = mergeSameFileDuplicates(nodes);
  const remappedEdges = remapEdgeIndices(indexMap, edges);
  const remappedUnresolvedCalls = remapFromIndices(indexMap, unresolvedCalls);
  const remappedUnresolvedInheritance = remapFromIndices(indexMap, unresolvedInheritance);
  const remappedUnresolvedTypeReferences = remapFromIndices(indexMap, unresolvedTypeReferences);

  const result = {
    nodes: merged,
    edges: remappedEdges,
    unresolvedCalls: remappedUnresolvedCalls,
    unresolvedInheritance: remappedUnresolvedInheritance,
    unresolvedTypeReferences: remappedUnresolvedTypeReferences,
    // import facts carry no node index (there is no IMPORT node anymore), so —
    // unlike edges/unresolvedCalls/unresolvedInheritance above — they need no
    // indexMap remap.
    importFacts,
    // same "no node index" reasoning as importFacts above.
    reExportFacts,
    // Not part of the node/edge contract validateOutput checks — a debug/
    // measurement-only field additive to the existing result shape.
    callSiteStats: { total: totalCallSites, reachable: reachableCallSites },
  };
  // Same language-agnostic outbound-HTTP-call capture the tree-sitter planes run in
  // ast-extractor.js#_stampPlane — applied here so the generic-grammar languages routed through this
  // walker (Ruby, Rust, Swift, Scala, …) get cross-repo HTTP edges too. Additive and idempotent.
  augmentHttpCallsAcrossLanguages(result.nodes, source);
  validateOutput(result);
  return result;
}

module.exports = {
  NODE_TYPES,
  EDGE_TYPES,
  RESOLUTIONS,
  validateNode,
  validateEdge,
  validateOutput,
  mergeSameFileDuplicates,
  remapEdgeIndices,
  remapFromIndices,
  registerImportFact,
  recordClassField,
  _LANGUAGE_BUILTIN_GLOBALS,
  _fileStem,
  _makeId,
  _readText,
  _cppDeclaratorName,
  _semanticReferenceEdge,
  loadGrammar,
  loadGrammarNext,
  LanguageConfig,
  walkGeneric,
  // shared outbound-HTTP-call capture (./http-call-scan.js). walkGeneric applies it itself; the
  // bespoke extractors that build nodes directly (rust/go/objc/zig/elixir) call it on their result.
  augmentHttpCallsAcrossLanguages,
  // shared with the 5 bespoke extractors (go/objc/zig/rust/elixir), which build
  // METHOD nodes directly rather than through walkGeneric/LanguageConfig.
  paramEntryName,
  extractArgs,
  detectAsync,
  // same rationale — the 5 bespoke extractors call this directly against a plain
  // (non-LanguageConfig) object with the same field names.
  computeCyclomatic,
};
