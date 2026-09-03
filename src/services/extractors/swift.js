'use strict';

// Like Java/C#/PHP/C++/Kotlin, Swift has no bespoke extractor — it
// runs the shared generic core over a config. This file supplies only
// Swift's own pieces: `_SWIFT_CONFIG` as a base.js `LanguageConfig`, the
// import handler `_import_swift`, and the parts of the
// tree_sitter_swift sites that fit the closed CLASS/METHOD/IMPORT +
// EDGE_TYPES contract.
//
// Grammar-shape notes (verified live against tree-sitter-swift.wasm, the
// grammar this codebase actually loads):
//   - `class_declaration` covers class/struct/enum/extension/actor alike —
//     the leading anonymous keyword token (`class`/`struct`/`enum`/
//     `extension`/`actor`) distinguishes the kind, via
//     `_swiftDeclKeyword`. `protocol_declaration` is a distinct
//     node type.
//   - `class_declaration`/`protocol_declaration`/`function_declaration` DO
//     expose a `name` field in this wasm build (unlike Kotlin's build, which
//     exposes none) — `childForFieldName('name')` returns the right node for
//     all of these, verified live.
//   - `init_declaration` also has a working `name` field (its text is the
//     literal `init` keyword token itself — coincidental but correct).
//     `deinit_declaration` has NO `name` field at all (`childForFieldName`
//     returns null). `subscript_declaration`'s `name` field resolves to the
//     WRONG node (its return-type's `type_identifier`, not "subscript") —
//     verified live. Both are hardcoded literals ("Swift
//     deinit/subscript have no name field — resolve before generic
//     fallback"); `resolveFunctionNameFn` below mirrors that exactly.
//   - `function_declaration`'s body resolves via the default `body` field
//     (`function_body`). `init_declaration`/`deinit_declaration` likewise.
//     `subscript_declaration` has NO `body` field — its body lives under a
//     `computed_property` child instead, added to `bodyFallbackChildTypes`.
//   - `call_expression`'s callee is always `node.children[0]` — no field at
//     all (`call_function_field=""`,
//     matching this grammar exactly). `walkGeneric`'s field-based call
//     resolution has no field to read, so — exactly like kotlin.js —
//     `callTypes` is left EMPTY here and CALLS edges are produced by
//     `_resolveSwiftCalls`, a same-file-only second pass run from `extract()`
//     after `walkGeneric` returns.
//
// Declared divergences:
//   - `swift_protocol_names`/`swift_class_names` pre-scan (`_swift_pre_scan`)
//     is RELOCATED, not dropped: `_resolveSwiftInheritance` below performs the
//     same whole-tree pre-scan itself, as part of its own post-pass (so it
//     works regardless of declaration order in the file), then classifies each
//     `inheritance_specifier` exactly per `_swift_classify_base`.
//   - `swift_extensions` bookkeeping is dropped: it exists purely to
//     populate a `swift_extensions` result field, an out-of-contract side
//     channel nothing in the CLASS/METHOD/IMPORT + EDGE_TYPES vocabulary
//     consumes.
//   - Conformance/inheritance edges ARE relocated, into
//     `_resolveSwiftInheritance`'s EXTENDS/IMPLEMENTS emission — same-file
//     only; an external stub node for an
//     unresolved base is deliberately never fabricated (base.js's "refuse to
//     guess" philosophy, same as csharp.js's/php.js's/kotlin.js's
//     EXTENDS/IMPLEMENTS ports).
//   - `property_declaration` handling (`_resolveSwiftComputedProperties`, a same-file post-pass):
//     every member property — stored (`var x = 5`) or computed (`var body: some View { … }`,
//     `get {}`) — is a FIELD node (DEFINED_IN its owning type), the taxonomy the compiler
//     frontends use (a computed property is a `var` with an accessor). A computed property's
//     accessor body is walked for CALLS, attributed to that FIELD. A local `let`/`var` inside a
//     function body is not a member, so `memberScope` tracking excludes it; a stored property's
//     initializer and a `willset_didset_block` observer are not walked for CALLS. Declared-type
//     `references` edges stay dropped (outside the closed `EDGE_TYPES` vocabulary).
//   - Function parameter type-ref collection is dropped, same "outside closed
//     vocabulary" reasoning.
//   - `enum_entry` cases are CONSTANT nodes (DEFINED_IN the enum). The `case_of` and
//     associated-value `references` edges the old walk also emitted stay dropped (outside
//     `EDGE_TYPES`); the owning enum is a CLASS via `classTypes`.
//   - Call-target resolution is PARTIALLY relocated: the callee-name
//     extraction (bare identifier, or the last `navigation_suffix` segment of
//     a `navigation_expression`) is ported into
//     `_resolveSwiftCalls`/`_swiftCallCallee`. The `swift_receiver` capture in
//     the same block feeds only the cross-file resolver and is dropped along
//     with those sites — same-file lookup never consults the receiver anyway
//     (the same-file pass ignores it too, exactly like Kotlin's
//     `is_member_call`).

const base = require('./base');

// `protocol_function_declaration` is a protocol REQUIREMENT (`func f()` with no body). It is a
// distinct node type from `function_declaration` in this grammar and was missing here, so every
// protocol's whole method surface was absent from the graph — 31 declarations in Alamofire alone,
// and with it every CALLS edge that would have landed on a protocol method. It has a working
// `name` field (simple_identifier) and no body, so it costs nothing else.
const FUNCTION_TYPES = new Set([
  'function_declaration', 'protocol_function_declaration',
  'init_declaration', 'deinit_declaration', 'subscript_declaration',
]);

const CONFIG = base.LanguageConfig({
  // typealias/associatedtype are named TYPES, so they belong with the class-likes: a `typealias
  // AFDataResponse<T> = DataResponse<T, AFError>` is exactly the name a reader searches for and a
  // sibling file imports. Both expose a `name` field (type_identifier), verified against
  // tree-sitter-swift.wasm.
  classTypes: new Set(['class_declaration', 'protocol_declaration', 'typealias_declaration', 'associatedtype_declaration']),
  functionTypes: new Set(FUNCTION_TYPES),
  importTypes: new Set(['import_declaration']),
  callTypes: new Set(), // see file header — CALLS produced via a second pass instead
  bodyFallbackChildTypes: ['function_body', 'computed_property'],
  functionBoundaryTypes: new Set(FUNCTION_TYPES),
  resolveFunctionNameFn: _resolveSwiftFunctionName,
  importHandler: _importSwift,
  // Unlike every other walkGeneric language, there is no parameter-list
  // wrapper node at all — `parameter` nodes sit as FLAT direct children of
  // function_declaration itself, alongside the literal `(`/`)` tokens — hence
  // paramsAreDirectChildren rather than a paramsField/paramsContainerTypes
  // lookup. `@objc`/`@MainActor` attributes
  // are children of a `modifiers` container, same shape as Java's. No async
  // wiring: Swift's `async` keyword sits AFTER the parameter list (`func
  // f() async {}`), which asyncMarkerText's direct-children-of-the-function-
  // node scan would still technically catch, but this is unverified across
  // the grammar's other async placements (getters, throws combinations) —
  // left unset rather than guessed at.
  paramsAreDirectChildren: true,
  paramEntryTypes: new Set(['parameter']),
  decoratorNodeTypes: new Set(['attribute']),
  decoratorContainerTypes: new Set(['modifiers']),
  // switch_entry wraps both a real `case` pattern and the `default:` arm (a
  // `default_keyword` child distinguishes it) — excluded via
  // branchArmDefaultTypes. && and || are their own distinct node types
  // (conjunction_expression/disjunction_expression), so no
  // logicalOperatorField mechanism is needed. catch is `catch_block`, not
  // `catch_clause` (differs from the C-family grammars).
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'switch_entry', 'catch_block', 'ternary_expression', 'conjunction_expression', 'disjunction_expression']),
  branchArmDefaultTypes: new Set(['switch_entry']),
});

// `deinit_declaration` has no `name` field at all
// in this grammar; `subscript_declaration`'s `name` field resolves to the
// wrong node (its return type), verified live — both are hardcoded literals
// for the same reason. Every other function type
// (`function_declaration`, `init_declaration`) resolves correctly via the
// default `name` field in this wasm build.
function _resolveSwiftFunctionName(node) {
  if (node.type === 'deinit_declaration') return 'deinit';
  if (node.type === 'subscript_declaration') return 'subscript';
  const nameNode = node.childForFieldName('name');
  if (nameNode) return base._readText(nameNode);
  const fallback = (node.children || []).find((c) => c.type === 'simple_identifier' || c.type === 'identifier');
  return fallback ? base._readText(fallback) : null;
}

// An import_declaration's `identifier` child
// text is the imported module name verbatim (no dotted-path splitting —
// take the raw text of the first `identifier` child and
// stop).
function _importSwift(node) {
  const identNode = (node.children || []).find((c) => c.type === 'identifier');
  if (!identNode) return [];
  const raw = base._readText(identNode);
  if (!raw) return [];
  return [{ name: raw, module: raw }];
}

// The leading anonymous child
// token distinguishes class/struct/enum/extension/actor — all of which parse
// as the same `class_declaration` node type in this grammar.
function _swiftDeclKeyword(node) {
  for (const c of node.children || []) {
    if (!c.isNamed && ['class', 'struct', 'enum', 'extension', 'actor'].includes(c.type)) return c.type;
  }
  return null;
}

// The head type_identifier of a
// user_type, ignoring any generic type_arguments.
function _swiftUserTypeName(userTypeNode) {
  if (!userTypeNode) return null;
  for (const c of userTypeNode.children || []) {
    if (c.type === 'type_identifier') return base._readText(c) || null;
  }
  return null;
}

// An inheritance_specifier's base name comes from its
// user_type child (head type_identifier, generics ignored) or, failing that,
// a direct type_identifier child.
function _swiftInheritanceBaseName(specifierNode) {
  for (const sub of specifierNode.children || []) {
    if (sub.type === 'user_type') return _swiftUserTypeName(sub);
    if (sub.type === 'type_identifier') return base._readText(sub) || null;
  }
  return null;
}

function _swiftClassifyBase(name, kind, isFirst, protocolNames, classLikeNames) {
  if (protocolNames.has(name)) return 'IMPLEMENTS';
  if (classLikeNames.has(name)) return 'EXTENDS';
  if (['struct', 'enum', 'extension', 'actor'].includes(kind)) return 'IMPLEMENTS';
  return isFirst ? 'EXTENDS' : 'IMPLEMENTS';
}

// Relocates the `_swift_pre_scan` + conformance/inheritance edges as a
// same-file-only second pass, run from `extract()` after `walkGeneric` has
// registered every CLASS node. A second pass — not `extraWalkFn` — because the
// protocol/class-name classification needs the WHOLE file's declarations
// pre-scanned regardless of where in the file a given `inheritance_specifier`
// appears (the pre-scan runs over the whole
// tree before the main walk).
//
// This never fabricates an external stub node for an
// unresolved base — same-file only, consistent with every other ported
// language's EXTENDS/IMPLEMENTS divergence.
function _resolveSwiftInheritance(root, result) {
  const protocolNames = new Set();
  const classLikeNames = new Set();
  (function scan(n) {
    if (n.type === 'protocol_declaration') {
      const nameNode = n.childForFieldName('name');
      if (nameNode) protocolNames.add(base._readText(nameNode));
    } else if (n.type === 'class_declaration') {
      const kw = _swiftDeclKeyword(n);
      if (['class', 'struct', 'enum', 'actor'].includes(kw)) {
        const nameNode = n.childForFieldName('name');
        if (nameNode) classLikeNames.add(base._readText(nameNode));
      }
    }
    for (const c of n.children || []) scan(c);
  })(root);

  const classIdxByName = new Map();
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (n.node_type === 'CLASS' && !classIdxByName.has(n.name)) classIdxByName.set(n.name, i);
  }

  const seen = new Set();
  (function walk(node) {
    if (node.type === 'class_declaration' || node.type === 'protocol_declaration') {
      const nameNode = node.childForFieldName('name');
      const selfName = nameNode ? base._readText(nameNode) : null;
      const selfIdx = selfName != null ? classIdxByName.get(selfName) : undefined;
      if (selfIdx !== undefined) {
        const isProtocol = node.type === 'protocol_declaration';
        const kind = isProtocol ? 'protocol' : _swiftDeclKeyword(node);
        let isFirst = true;
        for (const child of node.children || []) {
          if (child.type !== 'inheritance_specifier') continue;
          const baseName = _swiftInheritanceBaseName(child);
          if (!baseName) continue;
          const baseIdx = classIdxByName.get(baseName);
          if (baseIdx !== undefined && baseIdx !== selfIdx) {
            const edgeType = isProtocol ? 'EXTENDS' : _swiftClassifyBase(baseName, kind, isFirst, protocolNames, classLikeNames);
            const key = `${selfIdx}->${baseIdx}->${edgeType}`;
            if (!seen.has(key)) {
              seen.add(key);
              result.edges.push({
                from: selfIdx, to: baseIdx, edge_type: edgeType,
                resolution: 'same_file', evidence_line: node.startPosition.row + 1,
              });
            }
          }
          isFirst = false;
        }
      }
    }
    for (const c of node.children || []) walk(c);
  })(root);
}

// Call-target callee extraction: a call_expression's first
// child is either a plain `simple_identifier` (bare call) or a
// `navigation_expression` (member call) whose direct `navigation_suffix`
// child holds the last dotted segment as the callee —
// the receiver chain itself (`self.svc` in `self.svc.fetch()`) is never
// consulted, same "refuse to guess" behaviour as every other config-driven
// language's accessor-based call resolution.
function _swiftCallCallee(callNode) {
  const first = (callNode.children || [])[0];
  if (!first) return null;
  if (first.type === 'simple_identifier') return base._readText(first);
  if (first.type === 'navigation_expression') {
    const suffix = (first.children || []).find((c) => c.type === 'navigation_suffix');
    if (!suffix) return null;
    const ident = (suffix.children || []).find((c) => c.type === 'simple_identifier' || c.type === 'identifier');
    return ident ? base._readText(ident) : null;
  }
  return null;
}

// Relocates the callee-resolution logic as a same-file-only
// equivalent, since walkGeneric's own field-based call resolution has no
// field to read for this grammar (see file header). Deliberately its OWN
// pass over the whole tree, in `extract()`, AFTER `walkGeneric` has finished
// registering every CLASS/METHOD — same reasoning as kotlin.js's
// `_resolveKotlinCalls` (order-independent: a call to a function declared
// later in the file must still resolve).
function _resolveSwiftCalls(root, result) {
  const methodByName = new Map();
  const classByName = new Map();
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (n.node_type === 'METHOD' && !methodByName.has(n.name)) methodByName.set(n.name, i);
    if (n.node_type === 'CLASS' && !classByName.has(n.name)) classByName.set(n.name, i);
  }
  const seen = new Set();
  // Same fix as kotlin.js's `_resolveKotlinCalls` — this pass had NO
  // unresolvedCalls output at all before, so an unmatched callee vanished
  // with no residue. `result.unresolvedCalls` already exists on the
  // walkGeneric result object (CONFIG.callTypes is empty here — see file
  // header — so walkGeneric's own call pass never populates it; this is the
  // first writer). No selfTokens-equivalent upgrade: `_swiftCallCallee`'s own
  // header already documents that the receiver chain (including self) is
  // deliberately never consulted — not one
  // of the bespoke self-form languages (go/objc/zig/rust/elixir).
  const seenDeferred = new Set();

  (function walkFn(node) {
    if (FUNCTION_TYPES.has(node.type)) {
      const name = _resolveSwiftFunctionName(node);
      const callerIdx = name != null ? methodByName.get(name) : undefined;
      let bodyNode = node.childForFieldName('body');
      if (!bodyNode) {
        bodyNode = (node.children || []).find((c) => c.type === 'function_body' || c.type === 'computed_property');
      }
      if (callerIdx !== undefined && bodyNode) {
        (function walkBody(n) {
          if (n.type === 'call_expression') {
            const calleeName = _swiftCallCallee(n);
            if (calleeName && !base._LANGUAGE_BUILTIN_GLOBALS.has(calleeName)) {
              const targetIdx = methodByName.has(calleeName) ? methodByName.get(calleeName) : classByName.get(calleeName);
              if (targetIdx !== undefined && targetIdx !== callerIdx) {
                const key = `${callerIdx}->${targetIdx}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  result.edges.push({
                    from: callerIdx, to: targetIdx, edge_type: 'CALLS',
                    resolution: 'same_file', evidence_line: n.startPosition.row + 1,
                  });
                }
              } else if (targetIdx === undefined) {
                const dkey = `${callerIdx}::${calleeName}`;
                if (!seenDeferred.has(dkey)) {
                  seenDeferred.add(dkey);
                  result.unresolvedCalls.push({ from: callerIdx, calleeName, line: n.startPosition.row + 1 });
                }
              }
            }
          }
          if (n !== bodyNode && FUNCTION_TYPES.has(n.type)) return;
          for (const c of n.children || []) walkBody(c);
        })(bodyNode);
      }
    }
    for (const c of node.children || []) walkFn(c);
  })(root);
}

// The bound name of a property is
// either the `simple_identifier` inside its `pattern` child (the common
// shape) or, failing that, a direct `simple_identifier` child of the
// property_declaration itself.
function _swiftPropertyName(node) {
  for (const c of node.children || []) {
    if (c.type === 'pattern') {
      const ident = (c.children || []).find((sc) => sc.type === 'simple_identifier');
      if (ident) return base._readText(ident);
    }
    if (c.type === 'simple_identifier') return base._readText(c);
  }
  return null;
}

// Relocates the `comp_bodies` branch of the dropped
// `property_declaration` handling (narrowed to `computed_property` only — see
// file header) as a third same-file-only post-pass, run from `extract()`
// after `_resolveSwiftCalls` so the METHOD/CALLS machinery for declared
// functions is already settled before a computed property's own body is
// walked.
//
// A stored property (`var x = 5`, or one with only a `willset_didset_block`
// observer) has NO `computed_property` child at all, so it is never touched
// here — the distinguishing signal is the accessor block's presence, not the
// keyword (`var` vs `let`) or an initializer.
function _resolveSwiftComputedProperties(root, result) {
  const classIdxByName = new Map();
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (n.node_type === 'CLASS' && !classIdxByName.has(n.name)) classIdxByName.set(n.name, i);
  }

  const propertyEntries = [];
  // memberScope: inside a type/extension body a `property_declaration` is a member (a field of the
  // type); inside a function body it is a local `let`/`var`, not a declaration to emit.
  (function walk(node, parentClassIdx, memberScope) {
    let nextParent = parentClassIdx;
    let nextMember = memberScope;
    if (node.type === 'class_declaration' || node.type === 'protocol_declaration') {
      const nameNode = node.childForFieldName('name');
      const selfName = nameNode ? base._readText(nameNode) : null;
      if (selfName != null && classIdxByName.has(selfName)) nextParent = classIdxByName.get(selfName);
      nextMember = true;
    } else if (node.type === 'extension_declaration') {
      // `extension Foo { var x: ... }` declares members of Foo; link to Foo's node when it is
      // declared in this file, otherwise emit the members unparented (still real declarations).
      const ext = (node.children || []).find((c) => c.type === 'user_type' || c.type === 'type_identifier');
      const extName = ext ? base._readText(ext).split('.').pop() : null;
      nextParent = extName != null && classIdxByName.has(extName) ? classIdxByName.get(extName) : undefined;
      nextMember = true;
    } else if (FUNCTION_TYPES.has(node.type)) {
      nextMember = false;
    } else if (node.type === 'property_declaration' && memberScope) {
      const propName = _swiftPropertyName(node);
      const compBody = (node.children || []).find((c) => c.type === 'computed_property');
      if (propName) {
        // Every member property (stored or computed) is a field of the type — the same taxonomy
        // the compiler frontends use (a computed property is a `var` with an accessor).
        const fieldIdx = result.nodes.length;
        result.nodes.push({
          node_type: 'FIELD', name: propName, summary: propName,
          start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1,
          confidence_tier: 'EXTRACTED', confidence: 1.0,
        });
        if (parentClassIdx !== undefined) {
          result.edges.push({
            from: fieldIdx, to: parentClassIdx, edge_type: 'DEFINED_IN', resolution: 'same_file',
            evidence_line: node.startPosition.row + 1,
          });
        }
        // A computed property's accessor body makes calls; they are attributed to the property's
        // FIELD node (a computed property is a `var`, not a method) and resolved in the pass below.
        if (compBody) propertyEntries.push({ propIdx: fieldIdx, bodyNode: compBody });
      }
    } else if (node.type === 'enum_entry' && memberScope) {
      // `case red, green` — each case is a constant of the enum. walkGeneric models only the enum
      // itself (a CLASS), so without this the constant plane of every Swift enum was empty.
      for (const c of node.children || []) {
        if (c.type !== 'simple_identifier') continue;
        const caseName = base._readText(c);
        if (!caseName) continue;
        const caseIdx = result.nodes.length;
        result.nodes.push({
          node_type: 'CONSTANT', name: caseName, summary: caseName,
          start_line: c.startPosition.row + 1, end_line: c.startPosition.row + 1,
          confidence_tier: 'EXTRACTED', confidence: 1.0,
        });
        if (parentClassIdx !== undefined) {
          result.edges.push({
            from: caseIdx, to: parentClassIdx, edge_type: 'DEFINED_IN', resolution: 'same_file',
            evidence_line: c.startPosition.row + 1,
          });
        }
      }
    }
    for (const c of node.children || []) walk(c, nextParent, nextMember);
  })(root, undefined, false);

  if (!propertyEntries.length) return;

  // The same-file method/class lookup `_resolveSwiftCalls` uses — a computed property calling a
  // plain method (`self.increment()` from inside `var body`) resolves against the full table,
  // including everything walkGeneric and `_resolveSwiftCalls` already registered.
  const methodByName = new Map();
  const classByName = new Map();
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (n.node_type === 'METHOD' && !methodByName.has(n.name)) methodByName.set(n.name, i);
    if (n.node_type === 'CLASS' && !classByName.has(n.name)) classByName.set(n.name, i);
  }
  const seen = new Set();
  const seenDeferred = new Set();
  for (const { propIdx, bodyNode } of propertyEntries) {
    (function walkBody(n) {
      if (n.type === 'call_expression') {
        const calleeName = _swiftCallCallee(n);
        if (calleeName && !base._LANGUAGE_BUILTIN_GLOBALS.has(calleeName)) {
          const targetIdx = methodByName.has(calleeName) ? methodByName.get(calleeName) : classByName.get(calleeName);
          if (targetIdx !== undefined && targetIdx !== propIdx) {
            const key = `${propIdx}->${targetIdx}`;
            if (!seen.has(key)) {
              seen.add(key);
              result.edges.push({
                from: propIdx, to: targetIdx, edge_type: 'CALLS', resolution: 'same_file',
                evidence_line: n.startPosition.row + 1,
              });
            }
          } else if (targetIdx === undefined) {
            // Same residue fix as _resolveSwiftCalls above — a computed
            // property's own call pass had the identical silent-drop hole.
            const dkey = `${propIdx}::${calleeName}`;
            if (!seenDeferred.has(dkey)) {
              seenDeferred.add(dkey);
              result.unresolvedCalls.push({ from: propIdx, calleeName, line: n.startPosition.row + 1 });
            }
          }
        }
      }
      if (n !== bodyNode && FUNCTION_TYPES.has(n.type)) return;
      for (const c of n.children || []) walkBody(c);
    })(bodyNode);
  }
}

let _parserState = 'pending'; // 'pending' | 'ready' | 'failed'
let _parser = null;
let _parserReadyPromise = null;

// See extractors/go.js's identical comment: web-tree-sitter's Parser.init()
// must run exactly once per process, so this loads through base.js's shared
// grammar loader, and lazily (not a top-level IIFE) to avoid racing the
// require-cycle back into ast-extractor.js's not-yet-populated exports.
function _ensureParserReady() {
  if (!_parserReadyPromise) {
    _parserReadyPromise = (async () => {
      try {
        _parser = await base.loadGrammar('swift');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

// `class_declaration` is one node type for class/struct/enum/extension/actor, so without the
// leading keyword the graph cannot say which a type is — and `summary` degrades from "struct Task"
// to "Task". walkGeneric has no hook for a per-language class kind, so this stamps it afterwards
// rather than widening base.js's config for one language. First declaration of a name wins,
// matching mergeSameFileDuplicates, so `class Foo` + `extension Foo` stays "class".
function _stampSwiftKinds(root, result) {
  const classIdxByName = new Map();
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (n.node_type === 'CLASS' && !classIdxByName.has(n.name)) classIdxByName.set(n.name, i);
  }
  const KINDS = {
    protocol_declaration: 'protocol',
    typealias_declaration: 'typealias',
    associatedtype_declaration: 'associatedtype',
  };
  (function walk(node) {
    const kind = node.type === 'class_declaration' ? _swiftDeclKeyword(node) : KINDS[node.type];
    if (kind) {
      const nameNode = node.childForFieldName('name');
      const idx = nameNode ? classIdxByName.get(base._readText(nameNode)) : undefined;
      if (idx !== undefined && !result.nodes[idx].kind) {
        result.nodes[idx].kind = kind;
        result.nodes[idx].summary = `${kind} ${result.nodes[idx].name}`;
      }
    }
    for (const c of node.children || []) walk(c);
  })(root);
}

function extract(tree, content, filePath) {
  const result = base.walkGeneric(tree, content, CONFIG);
  _stampSwiftKinds(tree.rootNode, result);
  _resolveSwiftInheritance(tree.rootNode, result);
  _resolveSwiftCalls(tree.rootNode, result);
  _resolveSwiftComputedProperties(tree.rootNode, result);
  base.validateOutput(result);
  result.nodes = result.nodes.map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath }));
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  if (_parserState !== 'ready') {
    return { nodes: [], edges: [], unresolvedCalls: [] };
  }
  const tree = _parser.parse(content);
  return extract(tree, content, filePath);
}

async function ready() {
  await _ensureParserReady();
  return _parserState;
}

module.exports = { extract, extractFile, ready, CONFIG };
