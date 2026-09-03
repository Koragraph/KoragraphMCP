'use strict';

// Like Java/C#/C++, PHP has no bespoke extractor — it runs the
// shared generic core over a config. This file supplies only PHP's own
// pieces: `_PHP_CONFIG` as a base.js `LanguageConfig`, the import handler
// `_import_php`, and the parts of PHP's tree_sitter_php sites that fit
// the closed CLASS/METHOD/IMPORT + EDGE_TYPES contract.
//
// Behavioural notes:
//   - `member_call_expression` ($obj->method()) and `scoped_call_expression`
//     (Class::method()) both expose their callee name directly under a
//     `name` field on the call node itself (neither is nested inside a
//     `function` field the way C#'s `invocation_expression`/
//     `member_access_expression` pair is), so walkGeneric's single
//     `callFunctionField` slot is set to `'name'` and both resolve via
//     bare-method-name same-file matching, ignoring the receiver/scope
//     entirely — same "refuse to guess a receiver" choice java.js/csharp.js
//     document for their own accessor branches.
//   - `function_call_expression` (`foo()`) exposes its callee under a
//     DIFFERENT field (`function`, not `name`), so it is wired via the
//     per-callType `calleeFieldByType` override and resolves same-file by
//     bare name, same as the two call forms above.
//   - `namespace_use_clause`'s `namespace_aliasing_clause` (`use Foo as
//     Bar;`) is not consulted — `_import_php` itself never reads it either,
//     so no alias is ever registered.
//   - `use Trait;` inside a class body (`use_declaration`, PHP's trait
//     mixin) is not wired: it would need a `mixes_in`-shaped edge, which is
//     outside the closed `EDGE_TYPES` vocabulary.
//   - property_declaration / constructor-promoted-parameter type references
//     are not ported: they feed `references` edges outside the closed
//     vocabulary, same reasoning java.js/csharp.js document for their own
//     dropped type-reference collection.
//   - `class_constant_access_expression` (`Foo::BAR`) is not registered as a
//     call type at all: it would be a `references_constant` edge,
//     outside the closed vocabulary.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['class_declaration']),
  functionTypes: new Set(['function_definition', 'method_declaration']),
  importTypes: new Set(['namespace_use_clause']),
  // 'function_call_expression' (bare foo()) — its callee lives under
  // 'function', not 'name', handled via calleeFieldByType below. Previously
  // dropped entirely: bare calls produced neither an edge nor an
  // unresolvedCalls residue, a silent drop.
  callTypes: new Set(['member_call_expression', 'scoped_call_expression', 'function_call_expression']),
  callFunctionField: 'name',
  calleeFieldByType: new Map([['function_call_expression', 'function']]),
  functionBoundaryTypes: new Set(['function_definition', 'method_declaration']),
  importHandler: _importPhp,
  extraWalkFn: _extraWalkPhp,
  // `parameters` field resolves to formal_parameters (entries
  // simple_parameter/variadic_parameter/property_promotion_parameter for
  // constructor-promoted properties); each entry's `$name` variable_name has
  // no direct name/pattern/declarator field, caught by paramEntryName's
  // fallback (finds the inner `name`-typed leaf, PHP's identifier-equivalent
  // node type, before the `$`). PHP 8
  // attributes (`#[Attr]`) nest attribute_list > attribute_group > attribute
  // — two levels, within collectDecorators' depth-2 container scan. No
  // async keyword in PHP.
  paramEntryTypes: new Set(['simple_parameter', 'variadic_parameter', 'property_promotion_parameter']),
  decoratorNodeTypes: new Set(['attribute']),
  decoratorContainerTypes: new Set(['attribute_list']),
  // else_if_clause is its OWN node type in this grammar (unlike C's nested
  // if_statement) — omitting it would undercount every elseif chain.
  // case_statement/default_statement are already distinct types.
  branchNodeTypes: new Set(['if_statement', 'else_if_clause', 'for_statement', 'while_statement', 'do_statement', 'case_statement', 'catch_clause', 'conditional_expression']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

// The first qualified_name/name/identifier child of a namespace_use_clause,
// last backslash-separated segment as the imported module name. Does not
// consult namespace_aliasing_clause (`use Foo as Bar;`), so no alias is ever
// registered.
function _importPhp(node) {
  for (const child of node.children || []) {
    if (child.type === 'qualified_name' || child.type === 'name' || child.type === 'identifier') {
      const raw = base._readText(child);
      const segs = raw.split('\\');
      const moduleName = segs.pop().trim();
      if (!moduleName) return [];
      const pkgSegs = segs.filter(Boolean);
      return [{ name: moduleName, module: pkgSegs.length ? pkgSegs.join('\\') : undefined }];
    }
  }
  return [];
}

// Last backslash-separated segment of a (possibly namespaced) type name node
// — same segment-splitting _import_php uses for base_clause/
// class_interface_clause entries (`extends \Foo\Bar` -> "Bar").
function _lastSegment(text) {
  const parts = String(text).split('\\').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

// Handles PHP extends/implements/use disposition: only the
// extends/implements portion fits the closed EXTENDS/IMPLEMENTS vocabulary —
// `use Trait;` (mixes_in) is dropped (see file header). Same-
// file only: resolves when the base/interface name is already registered in
// `ctx.classByName` — cross-file/external bases never resolve, same
// "refuse to guess" contract limitation csharp.js's EXTENDS/IMPLEMENTS port
// documents. Note interface_declaration/trait_declaration are NOT in this
// file's classTypes, so an interface that is
// only declared, never defined as a class_declaration, never resolves either.
function _extraWalkPhp(node, source, ctx) {
  if (node.type !== 'class_declaration') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classIdx = ctx.classByName.get(base._readText(nameNode));
  if (classIdx === undefined) return;

  for (const child of node.children || []) {
    if (child.type === 'base_clause') {
      for (const c of child.children || []) {
        if (c.type !== 'name' && c.type !== 'qualified_name') continue;
        const baseName = _lastSegment(base._readText(c));
        const baseIdx = ctx.classByName.get(baseName);
        if (baseIdx === undefined || baseIdx === classIdx) continue;
        ctx.addEdge(classIdx, baseIdx, 'EXTENDS', 'same_file', ctx.line(node));
      }
    } else if (child.type === 'class_interface_clause') {
      for (const c of child.children || []) {
        if (c.type !== 'name' && c.type !== 'qualified_name') continue;
        const ifaceName = _lastSegment(base._readText(c));
        const ifaceIdx = ctx.classByName.get(ifaceName);
        if (ifaceIdx === undefined || ifaceIdx === classIdx) continue;
        ctx.addEdge(classIdx, ifaceIdx, 'IMPLEMENTS', 'same_file', ctx.line(node));
      }
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
        _parser = await base.loadGrammar('php');
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
