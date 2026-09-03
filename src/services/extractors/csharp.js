'use strict';

// Like Java/Python, C# has no bespoke extractor — it runs the shared
// generic core over a config. This file supplies only C#'s own pieces:
// `_CSHARP_CONFIG` as a base.js `LanguageConfig`, the import handler
// `_import_csharp`, and the one tree_sitter_c_sharp site whose output fits
// the closed EDGE_TYPES vocabulary — same-file inherits/implements via
// `base_list`.
//
// Behavioural notes:
//   - invocation_expression's `function` field resolves member calls
//     (`recv.Method()`) only when `recv` is a same-file import alias — same
//     "refuse to guess" rule java.js/python.js already document for their own
//     accessor branches. Receiver-typed resolution
//     (field/property/param/local -> declared type) is out of scope for this
//     closed generic walk.
//   - object_creation_expression ("new Foo()") is wired as an INSTANTIATES
//     call site: `type` field is a bare `identifier` for the simple case
//     (`new Foo()` -> "Foo", resolves same-file against classByName), but
//     `qualified_name` (`new Outer.Inner()` -> "Outer.Inner") or
//     `generic_name` (`new List<string>()` -> "List<string>") for a
//     qualified/generic constructor — both push unresolvedCalls residue with
//     a compound calleeName that can never same-file-match a bare class name,
//     the same accepted-but-documented shape as cpp.js's qualified_identifier
//     divergence and java.js's identical generic/qualified-constructor
//     limitation (never a silent drop, just an unresolvable one).
//   - field_declaration/property_declaration/parameter type-ref collection is
//     not ported: it feeds `references` edges with contexts ("field",
//     "parameter_type", "generic_arg") outside the closed EDGE_TYPES
//     vocabulary.
//   - namespace_declaration/file_scoped_namespace_declaration containment is
//     not ported: neither is a classType/functionType/importType in this
//     CONFIG, so walkGeneric's default recursion already descends into their
//     members unchanged; a "contains" edge for the namespace node itself
//     isn't in EDGE_TYPES either way.
//   - `is_nested_type` metadata on a nested class_declaration is cosmetic
//     bookkeeping, not a node/edge — dropped.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set([
    'class_declaration', 'interface_declaration', 'enum_declaration',
    'struct_declaration', 'record_declaration',
  ]),
  functionTypes: new Set(['method_declaration']),
  importTypes: new Set(['using_directive']),
  // object_creation_expression added — see the file header for the
  // calleeFieldByType/instantiation wiring and its documented generic/
  // qualified-name residue limitation.
  callTypes: new Set(['invocation_expression', 'object_creation_expression']),
  callFunctionField: 'function',
  calleeFieldByType: new Map([['object_creation_expression', 'type']]),
  instantiationNodeTypes: new Set(['object_creation_expression']),
  callAccessorNodeTypes: new Set(['member_access_expression']),
  callAccessorField: 'name',
  callAccessorObjectField: 'expression',
  // C# has no `super` keyword — its base-class-access token is `base`, so
  // selfTokens uses the real C# keyword, not a generic 'super'.
  selfTokens: new Set(['this', 'base']),
  bodyFallbackChildTypes: ['declaration_list'],
  functionBoundaryTypes: new Set(['method_declaration']),
  importHandler: _importCsharp,
  extraWalkFn: _extraWalkCsharp,
  // method_declaration's `parameters` field resolves; entries are `parameter`
  // EXCEPT a `params T[] name` variadic parameter, which this grammar
  // represents as a bare `identifier` sibling (not wrapped in a `parameter`
  // node) — included in paramEntryTypes so it isn't silently dropped. `async`
  // and every
  // attribute (`[Obsolete]`) are FLAT direct children of method_declaration
  // itself (no `modifiers`/`attribute_list` wrapper the way Java nests
  // annotations) — modifiers share the generic `modifier` node type with
  // `public`/`static`/etc., disambiguated only by text, which is exactly
  // what asyncMarkerText checks; attribute_list is itself the direct child
  // decoratorContainerTypes searches for.
  paramEntryTypes: new Set(['parameter', 'identifier']),
  asyncMarkerText: 'async',
  decoratorNodeTypes: new Set(['attribute']),
  decoratorContainerTypes: new Set(['attribute_list']),
  // case_switch_label/default_switch_label are already distinct node types in
  // this grammar, so no branchArmDefaultTypes entry is needed (default is
  // simply never added to branchNodeTypes).
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'foreach_statement', 'case_switch_label', 'catch_clause', 'conditional_expression']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

// A using_directive's full text (including the "using"/"global"/";" tokens
// tree-sitter-c-sharp leaves as anonymous siblings) is parsed textually rather
// than via field lookups — `childForFieldName('name')` on a plain `using
// System;` returns null in this grammar, so there is no field-based shortcut
// here the way there is for `bases`/`name`
// elsewhere in this file. Handles `using X;`, `using static X;`,
// `using Alias = X;`, and `global using X;`. Returns the full qualified name
// as `name` (not just its last segment — same choice python.js makes for
// dotted imports), and `alias` for the `using Alias = X;` form so
// walkGeneric's import-alias call resolution can recognise `Alias.Foo()`.
function _importCsharp(node) {
  let text = base._readText(node).trim();
  text = text.replace(/;+\s*$/, '');
  if (text.startsWith('global ')) text = text.slice('global '.length).trim();
  if (!text.startsWith('using')) return [];
  let body = text.slice('using'.length).trim();
  let alias;
  let targetFqn = body;
  if (body.startsWith('static ')) {
    targetFqn = body.slice('static '.length).trim();
  } else if (body.includes('=')) {
    const eq = body.indexOf('=');
    alias = body.slice(0, eq).trim();
    targetFqn = body.slice(eq + 1).trim();
  }
  if (!targetFqn) return [];
  return [{ name: targetFqn, alias, module: targetFqn }];
}

// Reads a type node down to just its base name string — this file doesn't
// emit qualified/qualifier metadata, since our contract carries no metadata
// field for it.
function _readCsharpTypeName(node) {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'predefined_type') {
    return base._readText(node);
  }
  if (node.type === 'qualified_name') {
    const text = base._readText(node);
    const idx = text.lastIndexOf('.');
    return (idx >= 0 ? text.slice(idx + 1) : text).split('<')[0];
  }
  if (node.type === 'generic_name') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return _readCsharpTypeName(nameNode);
  }
  for (const child of node.children || []) {
    if (!child.isNamed) continue;
    const result = _readCsharpTypeName(child);
    if (result) return result;
  }
  return null;
}

// Classifies a base: an explicitly-declared interface in this file, or the
// "I" + uppercase-letter naming convention, classifies as `implements`;
// anything else as `inherits`.
function _classifyBase(name, interfaceNames) {
  if (interfaceNames.has(name)) return 'IMPLEMENTS';
  if (name.length >= 2 && /^[A-Z]/.test(name[1]) && name[0] === 'I') return 'IMPLEMENTS';
  return 'EXTENDS';
}

// A whole-file pre-pass so a class declared BEFORE the interface it implements
// still classifies correctly (unlike EXTENDS resolution generally, which is
// single-pass and order-sensitive — see python.js's identical caveat).
function _preScanInterfaces(root) {
  const names = new Set();
  (function walk(n) {
    if (n.type === 'interface_declaration') {
      const nameNode = n.childForFieldName('name');
      if (nameNode) names.add(base._readText(nameNode));
    }
    for (const c of n.children || []) walk(c);
  })(root);
  return names;
}

// Set synchronously in extract() immediately before the single synchronous
// walkGeneric call it wraps, and cleared immediately after — safe because
// walkGeneric (and everything it calls, including this extraWalkFn) is
// entirely synchronous, so no other extract() call can interleave and
// observe a stale value (single-threaded JS, no await anywhere in the walk).
let _currentInterfaceNames = new Set();

// `partial` is a flat `modifier` child of class_declaration/
// struct_declaration/... (same flat-modifier shape asyncMarkerText/
// decoratorContainerTypes already document above), same detection shape as
// base.js#detectAsync (text match over direct children, not a dedicated
// grammar field).
function _hasPartialModifier(node) {
  for (const c of node.children || []) {
    if (base._readText(c) === 'partial') return true;
  }
  return false;
}

// Partial classes must group by namespace+name, NOT name alone — two
// unrelated `partial class Widget` declared in different namespaces (a legal,
// real C# pattern) must NOT link. Both `namespace A.B { ... }` (block) and
// `namespace A.B;` (C# 10 file-scoped) forms nest the class_declaration as a
// tree DESCENDANT of the namespace node in tree-sitter-c-sharp's output
// (file-scoped is not a flat preceding sibling the way it reads in source),
// so a plain parent-chain walk collecting every namespace ancestor's `name`
// field (innermost first, joined outermost-to-innermost) correctly handles
// the plain, file-scoped, AND nested-namespace (`namespace A { namespace B
// { ... } } `) cases in one pass.
function _enclosingNamespace(node) {
  const parts = [];
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'namespace_declaration' || cur.type === 'file_scoped_namespace_declaration') {
      const nameNode = cur.childForFieldName('name');
      if (nameNode) parts.unshift(base._readText(nameNode));
    }
    cur = cur.parent;
  }
  return parts.join('.');
}

// Relocates base_list inheritance/interface implementation into
// the closed EXTENDS/IMPLEMENTS vocabulary. Same-file only: resolves when the
// base name is already registered in `ctx.classByName` — cross-file/external
// bases (e.g. a class implementing an interface from another file) never
// resolve, same "refuse to guess" contract limitation python.js's EXTENDS
// port documents.
function _extraWalkCsharp(node, source, ctx) {
  if (!CONFIG.classTypes.has(node.type)) return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classIdx = ctx.classByName.get(base._readText(nameNode));
  if (classIdx === undefined) return;

  // Mark this CLASS node as a `partial` construct. Reuses the SAME
  // `properties.constructs` shape base.js#mergeSameFileDuplicates writes for
  // same-file duplicate constructs so the cross-file linker
  // (post-resolution.js#linkCrossFileConstructs) has one shape to check
  // regardless of whether a node went through that merge or not — a lone,
  // never-merged partial-class node still carries `constructs: ['partial']`.
  if (_hasPartialModifier(node)) {
    const target = ctx.nodes[classIdx];
    if (target && !(Array.isArray(target.constructs) && target.constructs.includes('partial'))) {
      target.constructs = [...(Array.isArray(target.constructs) ? target.constructs : []), 'partial'];
      // Audit fix (see _enclosingNamespace comment): recorded once, at the
      // same time as the 'partial' marker, since linkCrossFileConstructs
      // only ever looks at namespace on partial-marked nodes.
      target.namespace = _enclosingNamespace(node);
    }
  }

  const basesNode = node.childForFieldName('bases');
  if (!basesNode) return;

  for (const child of basesNode.children || []) {
    if (!['identifier', 'generic_name', 'qualified_name'].includes(child.type)) continue;
    const baseName = _readCsharpTypeName(child);
    if (!baseName) continue;
    const baseIdx = ctx.classByName.get(baseName);
    if (baseIdx === undefined || baseIdx === classIdx) continue;
    const edgeType = _classifyBase(baseName, _currentInterfaceNames);
    ctx.addEdge(classIdx, baseIdx, edgeType, 'same_file', ctx.line(node));
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
        _parser = await base.loadGrammar('c_sharp');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

function extract(tree, content, filePath) {
  _currentInterfaceNames = _preScanInterfaces(tree.rootNode);
  let result;
  try {
    result = base.walkGeneric(tree, content, CONFIG);
  } finally {
    _currentInterfaceNames = new Set();
  }
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
