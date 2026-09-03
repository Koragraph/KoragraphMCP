'use strict';

// Like Java/C#/C++/PHP/Kotlin, Scala has no bespoke extractor — it
// runs the shared generic core over a config. This file supplies only
// Scala's own pieces: `_SCALA_CONFIG` as a base.js `LanguageConfig`, the
// import handler `_import_scala`, and the parts of the
// tree_sitter_scala sites that fit the closed CLASS/METHOD/IMPORT +
// EDGE_TYPES contract.
//
// Grammar-shape note (tree-sitter-scala.wasm, the grammar this codebase loads):
// a call_expression's callee is addressable through a named `function` field in
// this build (the callee identifier for a bare call, or a `field_expression`
// node for a member call), so this file drives call resolution through
// `walkGeneric`'s field-based mechanism (`callFunctionField`/
// `callAccessorNodeTypes`) rather than a second custom pass. The import node
// type here is `stable_identifier` — the same class of grammar naming drift
// kotlin.js documents for `simple_identifier`/`identifier`.
//
// Notes:
//   - `field_expression` call targets (`x.log(...)`, `Helper.run(...)`)
//     resolve only when the receiver is a same-file import alias —
//     `walkGeneric`'s built-in accessor mechanism (`callAccessorNodeTypes`)
//     never falls back to bare-method-name matching for an accessor node,
//     the same "refuse to guess" rule cpp.js's `field_expression` accessor
//     documents. Adding bare-name accessor fallback would mean either bypassing
//     `callAccessorNodeTypes` for this language (silently reintroducing the
//     "ignore the receiver" hazard base.js's contract exists to avoid) or
//     editing `walkGeneric` itself (forbidden).
//   - `val_definition`/`var_definition` field-type references and
//     function-parameter type references are dropped: they feed `references`
//     edges outside the closed `EDGE_TYPES` vocabulary, the same reasoning
//     java.js/csharp.js document for their own dropped type-reference
//     collection.
//   - class_parameters (constructor-as-field) type references are dropped for
//     the same reason.

const base = require('./base');

// `trait_definition` and `type_definition` were both absent from classTypes, and
// `function_declaration` from functionTypes, so on real Scala this extractor lost every trait (the
// dominant declaration form in cats and scalatest alike — 1127 traits against 929 classes in cats),
// every type alias, and every abstract `def f: A`. All three expose a working `name` field
// (identifier / type_identifier / identifier), verified live against tree-sitter-scala.wasm.
// A trait is the closest thing Scala has to an interface, so it lands as CLASS beside
// class/object, matching the EXTENDS/IMPLEMENTS split _extraWalkScala already emits.
const CONFIG = base.LanguageConfig({
  classTypes: new Set(['class_definition', 'object_definition', 'trait_definition', 'type_definition']),
  // function_declaration is `def f(a: A): B` with no `=` body — a trait's abstract member. It has
  // no body to walk, so it adds nodes and DEFINED_IN edges only, never a CALLS source.
  functionTypes: new Set(['function_definition', 'function_declaration']),
  importTypes: new Set(['import_declaration']),
  callTypes: new Set(['call_expression']),
  callFunctionField: 'function',
  callAccessorNodeTypes: new Set(['field_expression']),
  callAccessorField: 'field',
  callAccessorObjectField: 'value',
  // scala.js routes calls through the exact same base.js#resolveCall accessor
  // branch as javascript.js/typescript.js/csharp.js/python.js. Only `this` is
  // verified here; Scala's `super.foo()` receiver-node shape is unverified,
  // left for a later pass rather than guessed at.
  selfTokens: new Set(['this']),
  bodyFallbackChildTypes: ['template_body'],
  functionBoundaryTypes: new Set(['function_definition']),
  importHandler: _importScala,
  extraWalkFn: _extraWalkScala,
  // function_definition's `parameters` field resolves to a `parameters`
  // container of `parameter` entries, each exposing a `name` field. No
  // async/decorator wiring (Scala annotation placement is unverified — left
  // for a later pass).
  paramEntryTypes: new Set(['parameter']),
  // This grammar (tree-sitter-scala, as loaded via tree-sitter-wasms) has NO
  // dedicated for_expression/while_expression node — `for (...) {...}` and
  // `while (...) {...}` both parse as a generic call_expression with
  // identifier text "for"/"while", indistinguishable by TYPE from any other
  // call — a grammar limitation, not an oversight. Loop headers are therefore
  // NOT counted for Scala (a declared, documented undercount); if/match/catch
  // still are. `&&`/`||` fold into the generic infix_expression node whose
  // `operator` field is itself always typed `operator_identifier` — only its
  // TEXT (checked by computeCyclomatic uniformly) disambiguates.
  branchNodeTypes: new Set(['if_expression', 'case_clause', 'catch_clause']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

// The first stable_identifier/identifier
// child of an import_declaration carries the FULL dotted path as that one
// node's text (this grammar nests each dot
// segment inside the next stable_identifier, but `.text` on the outermost
// one already covers the whole chain) — the last dot-separated segment is
// the imported name. A
// braced-selector import (`import a.b.{Map, Set}`) or a wildcard
// (`import a.b._`) both register only the PACKAGE prefix's last segment
// ("b"), never the individual selector names — the walk
// breaks after the first stable_identifier/identifier match and never
// inspects `import_selectors`/`wildcard` siblings, an intentional
// behaviour, not a koragraph-specific loss.
function _importScala(node) {
  for (const child of node.children || []) {
    if (child.type === 'stable_identifier' || child.type === 'identifier') {
      const raw = base._readText(child);
      const segs = raw.split('.');
      let moduleName = segs[segs.length - 1].replace(/^[{}\s]+|[{}\s]+$/g, '');
      if (moduleName && moduleName !== '_') {
        const pkgSegs = segs.slice(0, -1).filter(Boolean);
        return [{ name: moduleName, module: pkgSegs.length ? pkgSegs.join('.') : undefined }];
      }
      return [];
    }
  }
  return [];
}

// First named, non-keyword child of a type-position node — resolves both a
// bare `type_identifier` base and a `generic_type` base's own `type` field
// (`Base[Dep]` -> "Base").
function _scalaBaseName(node) {
  if (!node) return null;
  if (node.type === 'type_identifier') return base._readText(node);
  if (node.type === 'generic_type') {
    const t = node.childForFieldName('type')
      || (node.children || []).find((c) => c.type === 'type_identifier');
    return t ? base._readText(t) : null;
  }
  return null;
}

// Relocates the Scala `extends_clause` inheritance/trait mixin into
// the closed EXTENDS/IMPLEMENTS vocabulary: `extends Base with
// Trait1 with Trait2` — the first base is `inherits` (-> EXTENDS), every
// subsequent `with`-joined type is `mixes_in` (there is no MIXES_IN edge
// type in the closed vocabulary, so this maps to IMPLEMENTS, matching the
// established EXTENDS/IMPLEMENTS split csharp.js's/php.js's/kotlin.js's own
// base/interface ports already use). Single-base `extends X` (no `with`)
// parses as a bare `type_identifier`/`generic_type` child of extends_clause,
// not wrapped in `compound_type`; multi-base parses as `compound_type`'s own
// named children (verified live against tree-sitter-scala.wasm). Same-file
// only: resolves when the base name is already registered in
// `ctx.classByName` — cross-file/external bases never resolve, same
// "refuse to guess" contract limitation every other port's EXTENDS/IMPLEMENTS
// relocation documents.
const EXTENDABLE_TYPES = new Set(['class_definition', 'trait_definition', 'object_definition']);

function _extraWalkScala(node, source, ctx) {
  if (!EXTENDABLE_TYPES.has(node.type)) return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classIdx = ctx.classByName.get(base._readText(nameNode));
  if (classIdx === undefined) return;

  const extend = (node.children || []).find((c) => c.type === 'extends_clause');
  if (!extend) return;
  const typeChild = (extend.children || []).find((c) => c.isNamed);
  if (!typeChild) return;

  const bases = [];
  if (typeChild.type === 'compound_type') {
    for (const c of typeChild.children || []) {
      const name = _scalaBaseName(c);
      if (name) bases.push(name);
    }
  } else {
    const name = _scalaBaseName(typeChild);
    if (name) bases.push(name);
  }

  bases.forEach((baseName, idx) => {
    const baseIdx = ctx.classByName.get(baseName);
    if (baseIdx === undefined || baseIdx === classIdx) return;
    const edgeType = idx === 0 ? 'EXTENDS' : 'IMPLEMENTS';
    ctx.addEdge(classIdx, baseIdx, edgeType, 'same_file', ctx.line(node));
  });
}

// Same reasoning as swift.js's _stampSwiftKinds: a trait, an object, a case class and a plain
// class are four different things a reader needs told apart, and walkGeneric has no per-language
// class-kind hook. First declaration of a name wins, matching mergeSameFileDuplicates — so a
// `trait Foo` + companion `object Foo` pair reads as "trait".
function _stampScalaKinds(root, result) {
  const classIdxByName = new Map();
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (n.node_type === 'CLASS' && !classIdxByName.has(n.name)) classIdxByName.set(n.name, i);
  }
  const kindOf = (node) => {
    if (node.type === 'trait_definition') return 'trait';
    if (node.type === 'object_definition') return 'object';
    if (node.type === 'type_definition') return 'type';
    if (node.type !== 'class_definition') return null;
    return (node.children || []).some((c) => c.type === 'case') ? 'case_class' : 'class';
  };
  (function walk(node) {
    const kind = kindOf(node);
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
        _parser = await base.loadGrammar('scala');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

function extract(tree, content, filePath) {
  const result = base.walkGeneric(tree, content, CONFIG);
  _stampScalaKinds(tree.rootNode, result);
  result.nodes = result.nodes.map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath }));
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  if (_parserState !== 'ready') {
    return { nodes: [], edges: [] };
  }
  const tree = _parser.parse(content);
  return extract(tree, content, filePath);
}

async function ready() {
  await _ensureParserReady();
  return _parserState;
}

module.exports = { extract, extractFile, ready, CONFIG };
