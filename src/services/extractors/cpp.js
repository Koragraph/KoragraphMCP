'use strict';

// Like Java/C#, C++ has no bespoke extractor — it runs the shared
// generic core over a config. This file supplies only C++'s own pieces:
// `_CPP_CONFIG` as a base.js `LanguageConfig`, the import handler (shared
// with C), the declarator-unwrapping function-name resolver, and the one
// tree_sitter_cpp site whose output fits the closed EDGE_TYPES vocabulary —
// same-file `base_class_clause` inheritance.
//
// Declared divergences:
//   - call_expression's `field_expression` accessor (`f.bar()`/`f->bar()`/
//     `this->bar()`) resolves only when the receiver is a same-file import
//     alias — same "refuse to guess" rule java.js/csharp.js already document.
//   - `qualified_identifier` call targets (`Foo::bar()`, a static/qualified
//     call) are NOT wired as an accessor: tree-sitter-cpp's
//     `qualified_identifier` exposes `scope`/`name` fields, not the
//     `argument`/`field` pair `field_expression` uses, and walkGeneric's
//     accessor hook has exactly one field-name pair per config. Declared
//     unresolved rather than guessed.
//   - field_declaration/return-type reference collection is not ported: it
//     feeds `references` edges with contexts ("field", "return_type",
//     "generic_arg") outside the closed EDGE_TYPES vocabulary.
//   - the base's `template_type` generic-argument references (`Base<Dep>` ->
//     `Dep`) are dropped for the same reason — only the `inherits` edge on
//     the base name itself is emitted.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['class_specifier', 'struct_specifier']),
  functionTypes: new Set(['function_definition']),
  importTypes: new Set(['preproc_include']),
  callTypes: new Set(['call_expression']),
  callFunctionField: 'function',
  callAccessorNodeTypes: new Set(['field_expression']),
  callAccessorField: 'field',
  callAccessorObjectField: 'argument',
  // cpp.js routes calls through the exact same base.js#resolveCall accessor
  // branch as javascript.js/typescript.js/csharp.js/python.js. C++ has no
  // `super` keyword (parent calls use explicit `Base::method()`, out of
  // scope), so only `this`.
  selfTokens: new Set(['this']),
  functionBoundaryTypes: new Set(['function_definition']),
  importHandler: _importCpp,
  resolveFunctionNameFn: _resolveCppFuncName,
  extraWalkFn: _extraWalkCpp,
  // Same declarator-nesting shape as c.js (function_definition -> declarator
  // -> parameters), including through a class member's
  // field_declaration_list. No async/decorator concept in C++.
  resolveParamsFn: (node) => {
    const decl = node.childForFieldName('declarator');
    return decl ? decl.childForFieldName('parameters') : null;
  },
  paramEntryTypes: new Set(['parameter_declaration']),
  // Same node set as c.js plus catch_clause (C++ has try/catch, C does not).
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'case_statement', 'conditional_expression', 'catch_clause']),
  branchArmDefaultTypes: new Set(['case_statement']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

// Reads the
// include target from a string_literal/system_lib_string child, strips the
// surrounding quotes/angle-brackets, and uses its basename (extension
// dropped) as the imported module name. Path-based cross-file include
// resolution is out of scope, so both quoted and system includes are treated
// identically here, a declared divergence.
function _importCpp(node) {
  for (const child of node.children || []) {
    if (!['string_literal', 'system_lib_string', 'string'].includes(child.type)) continue;
    let raw = base._readText(child).trim();
    raw = raw.replace(/^["<>\s]+/, '').replace(/["<>\s]+$/, '');
    const moduleName = raw.split('/').pop().split('.')[0];
    if (moduleName) return [{ name: moduleName, module: moduleName }];
    return [];
  }
  return [];
}

// Recursively unwraps a declarator to
// find the innermost name-bearing node. Needed because tree-sitter-cpp's
// function_definition has no `name` field — the name lives inside
// `declarator`, which may itself be a pointer/reference wrapper or a
// qualified out-of-class definition (`void Foo::bar() {}`). Retaining the
// qualifier text for qualified_identifier (rather than just the tail) lets an
// out-of-class member definition's id line
// up with its in-class declaration elsewhere — out of scope for this file's
// own canonical_key, which is ingest-helpers.js's job, but harmless to
// preserve here too.
function _unwrapCppDeclarator(node) {
  if (!node) return null;
  if (node.type === 'identifier') return base._readText(node);
  if (['field_identifier', 'destructor_name', 'operator_name'].includes(node.type)) {
    return base._readText(node);
  }
  if (node.type === 'qualified_identifier') return base._readText(node);
  const decl = node.childForFieldName('declarator');
  if (decl) return _unwrapCppDeclarator(decl);
  for (const child of node.children || []) {
    if (child.type === 'identifier') return base._readText(child);
  }
  return null;
}

function _resolveCppFuncName(node) {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;
  return _unwrapCppDeclarator(declarator);
}

// Relocates base_class_clause inheritance into the closed EXTENDS
// vocabulary. Unlike C#'s `bases` field
// (extractors/csharp.js's _extraWalkCsharp), tree-sitter-cpp's
// base_class_clause is a plain (unnamed-field) child of class_specifier/
// struct_specifier, so it must be found by scanning `node.children` rather
// than `childForFieldName`. C++ has no separate interface concept, so this
// always classifies as EXTENDS, never IMPLEMENTS. Same-file only: a base
// declared in another file (the common header/`.cpp` split) never resolves,
// same "refuse to guess" limitation csharp.js's EXTENDS port documents.
function _extraWalkCpp(node, source, ctx) {
  if (!CONFIG.classTypes.has(node.type)) return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classIdx = ctx.classByName.get(base._readText(nameNode));
  if (classIdx === undefined) return;

  for (const child of node.children || []) {
    if (child.type !== 'base_class_clause') continue;
    for (const sub of child.children || []) {
      let baseName = '';
      if (sub.type === 'type_identifier') {
        baseName = base._readText(sub);
      } else if (sub.type === 'qualified_identifier') {
        const tail = sub.childForFieldName('name');
        baseName = tail ? base._readText(tail) : base._readText(sub);
      } else if (sub.type === 'template_type') {
        const tname = sub.childForFieldName('name');
        baseName = tname ? base._readText(tname) : base._readText(sub);
      } else {
        continue;
      }
      if (!baseName) continue;
      const baseIdx = ctx.classByName.get(baseName);
      if (baseIdx === undefined || baseIdx === classIdx) continue;
      ctx.addEdge(classIdx, baseIdx, 'EXTENDS', 'same_file', ctx.line(child));
    }
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
        _parser = await base.loadGrammar('cpp');
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
