'use strict';

// Like Java/C#/C++, C has no bespoke extractor — it runs the shared
// generic core over a config. This file supplies only C's own pieces:
// `_C_CONFIG` as a base.js `LanguageConfig`, the import handler (shared with
// C++), and the declarator-unwrapping function-name resolver.
//
// The single tree_sitter_c site feeds parameter/return-type-ref collection
// into `references` edges outside the closed EDGE_TYPES vocabulary — dropped,
// same reasoning cpp.js documents for its own copy of this branch.
//
// _C_CONFIG has an EMPTY class_types set — C has no class/struct-as-type
// construct in this model (a `typedef struct` is a type
// declaration, not walked as a class here). So walkGeneric never registers a
// CLASS node or a class-scoped DEFINED_IN edge for this language: there is no
// owning-class context for a top-level C function to be "defined in". A real
// property of the language/config, not an omission.
//
// Declared divergences:
//   - call_expression's `field_expression` accessor (`s->method()`-shaped
//     access through a struct pointer, e.g. a function-pointer member call)
//     resolves only when the receiver is a same-file import alias — same
//     "refuse to guess" rule java.js/cpp.js already document. There is no
//     receiver-typed resolution in this closed generic walk.
//   - parameter/return-type reference collection is not ported: it feeds
//     `references` edges outside the closed EDGE_TYPES vocabulary.
//   - cross-file include-path resolution is not attempted — both quoted and
//     system includes are treated identically, same declared divergence
//     cpp.js documents for its own copy of the import handler.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set(),
  functionTypes: new Set(['function_definition']),
  importTypes: new Set(['preproc_include']),
  callTypes: new Set(['call_expression']),
  callFunctionField: 'function',
  callAccessorNodeTypes: new Set(['field_expression']),
  callAccessorField: 'field',
  callAccessorObjectField: 'argument',
  functionBoundaryTypes: new Set(['function_definition']),
  importHandler: _importC,
  resolveFunctionNameFn: _resolveCFuncName,
  // C's parameter_list is NOT a direct field of function_definition — it
  // hangs off the `declarator` field's own `parameters` field
  // (function_definition -> declarator:function_declarator ->
  // parameters:parameter_list). No class_types means class_context never
  // fires for this language (by design, see file header) and there is no
  // async/decorator concept in C, so only args is wired.
  resolveParamsFn: (node) => {
    const decl = node.childForFieldName('declarator');
    return decl ? decl.childForFieldName('parameters') : null;
  },
  paramEntryTypes: new Set(['parameter_declaration']),
  // No catch (C has no exceptions). case_statement covers both `case`/
  // `default` in this grammar (a `default` child distinguishes it) —
  // branchArmDefaultTypes excludes it.
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'case_statement', 'conditional_expression']),
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
function _importC(node) {
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
// find the innermost identifier. Needed because tree-sitter-c's
// function_definition has no `name` field — the name lives inside
// `declarator`, which may itself be a pointer-wrapper (`char *process(...)`'s
// declarator is a pointer_declarator wrapping the function_declarator).
function _unwrapCDeclarator(node) {
  if (!node) return null;
  if (node.type === 'identifier') return base._readText(node);
  const decl = node.childForFieldName('declarator');
  if (decl) return _unwrapCDeclarator(decl);
  for (const child of node.children || []) {
    if (child.type === 'identifier') return base._readText(child);
  }
  return null;
}

function _resolveCFuncName(node) {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;
  return _unwrapCDeclarator(declarator);
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
        _parser = await base.loadGrammar('c');
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
