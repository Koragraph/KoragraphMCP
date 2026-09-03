'use strict';

// Like Python/Java/TypeScript, JavaScript has no dedicated extractor
// module — `extract_js` is `_extract_generic(path, config)` where
// `config` is `_JS_CONFIG` for `.js/.mjs/.cjs` files (`.ts/.mts/.cts` ->
// `_TS_CONFIG` and `.tsx/.jsx` -> `_TSX_CONFIG` are `typescript.js`, which
// owns both the `typescript` and `tsx` grammars and is registered to `.jsx`
// per ast-extractor.js's EXT_TO_SLUG — a declared divergence from
// `extract_js`, which routes `.jsx` through `_JS_CONFIG` instead).
// `_JS_CONFIG` is identical to `_TS_CONFIG` in every field except `class_types`
// (JS has no interface/enum/type-alias/abstract-class declarations) and
// `ts_module` (`tree_sitter_javascript` vs `tree_sitter_typescript`) — so this
// file's `importHandler`/`extraWalkFn` logic mirrors typescript.js's
// `_importTs`/`_extraWalkTs` (both configs share `import_types =
// {import_statement, export_statement}` and the same shaped `_import_js`),
// with the TS-only class types dropped.
//
// Notes on the config choices below:
//   - `export_statement` is deliberately NOT in `importTypes`, for the exact
//     reason typescript.js documents: walkGeneric's import-type branch
//     returns without recursing into children (extractors/base.js), which
//     would silently drop `export class Foo {}` / `export function bar(){}`.
//     `extraWalkFn` (`_extraWalkJs`, below) handles genuine re-exports
//     (`export {x} from './y'`) directly via `ctx.addNode`; plain
//     declaration exports fall through to normal recursion.
//   - `new_expression` (`new Foo()`) is wired as an INSTANTIATES call site,
//     mirroring typescript.js (tree-sitter-javascript shares the same
//     `new_expression` shape as tree-sitter-typescript — callee in a
//     `constructor` field), via walkGeneric's `calleeFieldByType` override.
//   - `member_expression`'s `object` field only resolves a CALLS edge when
//     the receiver is a same-file import alias; `this.method()` does not
//     resolve (refuse-to-guess, same as every other config-driven language).
//   - Arrow-function class fields (`onClick = () => {}`) are NOT extracted
//     as METHOD nodes — same `_js_extra_walk`-only population typescript.js
//     documents; `_JS_CONFIG.function_types` itself does not include
//     `arrow_function` either.
//   - CommonJS `require(...)` calls are NOT recognized as imports.
//     `_JS_CONFIG.import_types` covers only `import_statement`/
//     `export_statement` — `require()` is a plain
//     `call_expression` in the config-driven path (the CommonJS
//     handling, `_require_imports_js`, lives outside `_extract_generic`
//     entirely). A same-file `require('./x')` therefore produces no IMPORT
//     node and no CALLS edge to a real symbol (no METHOD named `require`
//     exists in-repo) — a declared limitation, not a bug.
//
// Module-level const/arrow extraction (see typescript.js's identical header
// note and base.js's `registerCallableBody`/`registeredCallableIds` for the
// body-walk half). Scoped to `lexical_declaration`
// (`const`/`let`) only, module-level only (`_isModuleLevel`, the
// god-node scope guard):
//   - `const f = () => {}` / `= function(){}` -> METHOD node `f()`,
//     registered as a same-file callable, body walkable.
//   - `const X = {...}` / `= [...]` / `= call()` / `= new Foo()` -> CLASS
//     node `X` (bare label) — node only, not walked.
//   - Nested/block-scoped `const` is never emitted here (scope guard).
//
//   - Dynamic `import('./x')`, decorator edges (JS has no decorator syntax
//     without a transform, so this is moot in practice), and every
//     indirect-callback/dispatch-table/assignment/return-reference site are
//     dropped for the same reason typescript.js/python.js document their own
//     dropped sites: each feeds a `references`-edge machinery with
//     a context outside this codebase's closed `EDGE_TYPES` vocabulary.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['class_declaration']),
  functionTypes: new Set(['function_declaration', 'generator_function_declaration', 'method_definition']),
  importTypes: new Set(['import_statement']),
  // new_expression — see the file header for the calleeFieldByType/
  // instantiation wiring.
  callTypes: new Set(['call_expression', 'new_expression']),
  callFunctionField: 'function',
  calleeFieldByType: new Map([['new_expression', 'constructor']]),
  instantiationNodeTypes: new Set(['new_expression']),
  callAccessorNodeTypes: new Set(['member_expression']),
  callAccessorField: 'property',
  callAccessorObjectField: 'object',
  // `this.x()` / `super.x()` receivers resolve tier-1 same-class before
  // falling to the bare-name plane.
  selfTokens: new Set(['this', 'super']),
  functionBoundaryTypes: new Set(['function_declaration', 'generator_function_declaration', 'arrow_function', 'method_definition']),
  importHandler: _importJs,
  extraWalkFn: _extraWalkJs,
  // tree-sitter-javascript's formal_parameters entries are FLAT
  // (identifier/assignment_pattern/rest_pattern/object_pattern/array_pattern),
  // unlike TS's required_parameter/optional_parameter wrapper. No decorator
  // support: plain JS has no decorator syntax in this grammar (TS/TSX
  // decorators are typescript.js's; `.jsx` is also routed there per that
  // file's own header note) — decoratorNodeTypes stays unset.
  paramEntryTypes: new Set(['identifier', 'assignment_pattern', 'rest_pattern', 'object_pattern', 'array_pattern']),
  asyncMarkerText: 'async',
  // for_in_statement covers both `for...in` and `for...of`. switch_case/
  // switch_default are already distinct types, so no branchArmDefaultTypes
  // entry is needed.
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'catch_clause', 'ternary_expression']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

// Reads a tree-sitter `string` node's text with its quote characters
// stripped, preferring the grammar's own `string_fragment` child over a
// manual trim (mirrors typescript.js's `_modulePathText`).
function _modulePathText(stringNode) {
  const frag = (stringNode.children || []).find((c) => c.type === 'string_fragment');
  if (frag) return base._readText(frag);
  return base._readText(stringNode).replace(/^['"`]|['"`]$/g, '');
}

// Handles the `import_statement` forms only —
// `export_statement` re-exports are handled by `_extraWalkJs` below, since
// `export_statement` is deliberately not in `CONFIG.importTypes` (see the
// file-header divergence note). Same shapes as typescript.js's `_importTs`:
//   `import Foo from './foo'`          -> import_clause > identifier (default)
//   `import * as ns from './ns'`       -> import_clause > namespace_import > identifier
//   `import { a, b as bb } from './m'` -> import_clause > named_imports > import_specifier(s)
//   `import './x'`                     -> no import_clause at all (side-effect)
// `module` is always `modulePath` (the import specifier string, e.g.
// './security' or 'lodash') — the ES module system has no separate "module vs.
// symbol" distinction at the specifier level, unlike Python's dotted packages.
// Named imports (`import { x } from './y'`) previously lost `modulePath`
// entirely; every branch below now carries it.
function _importJs(node, source, ctx) {
  const out = [];
  const sourceNode = node.childForFieldName('source');
  const modulePath = sourceNode ? _modulePathText(sourceNode) : null;
  const clause = (node.children || []).find((c) => c.type === 'import_clause');
  if (!clause) {
    if (modulePath) out.push({ name: modulePath, module: modulePath }); // side-effect import: import './x';
    return out;
  }

  for (const child of clause.children || []) {
    if (child.type === 'identifier') {
      if (modulePath) out.push({ name: modulePath, alias: base._readText(child), module: modulePath });
    } else if (child.type === 'namespace_import') {
      const idNode = (child.children || []).find((c) => c.type === 'identifier');
      if (modulePath && idNode) out.push({ name: modulePath, alias: base._readText(idNode), module: modulePath });
    } else if (child.type === 'named_imports') {
      for (const spec of child.children || []) {
        if (spec.type !== 'import_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        if (!nameNode) continue;
        out.push({
          name: base._readText(nameNode),
          alias: aliasNode ? base._readText(aliasNode) : undefined,
          module: modulePath || undefined,
        });
      }
    }
  }
  return out;
}

// Handles `export_statement` re-exports (`export {x} from './y'`,
// `export * from './y'`, `export * as ns from './y'`) by registering the
// same import facts an equivalent `import` would — via base.js's shared
// `registerImportFact`, never a base.js edit. A plain declaration export
// (`export class Foo {}`) has no `source` field and this function does nothing
// for it — normal recursion (which walkGeneric always runs after extraWalkFn)
// picks up the wrapped declaration exactly as if `export` were not present.
// Identical to typescript.js's `_extraWalkTs`.
// See typescript.js's identical
// constant for why `function` is kept despite no live grammar emitting it.
const _FUNCTION_VALUE_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
// `as_expression` is TS-only and tree-sitter-javascript never produces it —
// kept anyway so this constant stays byte-parallel with typescript.js's.
const _CONST_VALUE_TYPES = new Set(['object', 'array', 'as_expression', 'call_expression', 'new_expression']);

// `base.detectAsync` just needs asyncMarkerText — a full LanguageConfig is
// overkill for this one field.
const _ASYNC_MARKER_CONFIG = { asyncMarkerText: 'async' };
// arrow_function's `parameters` field is ONLY present when the param list is
// parenthesized (`(a, b) =>`); a single bare param (`a => a+1`) has no
// wrapping formal_parameters node at all — the identifier sits as a direct
// child instead (identical shape to typescript.js's copy of this helper — see
// its comment for the ordering argument). Entry types here are the FLAT
// identifier/assignment_pattern/rest_pattern shape — NOT TS's
// required_parameter/optional_parameter wrapper, a real grammar difference
// between the two tree-sitter parsers despite the shared source layout.
function _extractValueArgs(valueNode) {
  const paramsNode = valueNode.childForFieldName('parameters');
  if (paramsNode) {
    return base.extractArgs(paramsNode, new Set(['identifier', 'assignment_pattern', 'rest_pattern', 'object_pattern', 'array_pattern']));
  }
  if (valueNode.type !== 'arrow_function') return [];
  const bare = (valueNode.children || []).find((c) => c.type === 'identifier');
  return bare ? [base._readText(bare)] : [];
}

// The god-node scope guard — identical to typescript.js's `_isModuleLevel`.
function _isModuleLevel(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'program') return true;
  return parent.type === 'export_statement' && !!parent.parent && parent.parent.type === 'program';
}

// Identical to typescript.js's `_handleModuleLevelConst`.
function _handleModuleLevelConst(node, source, ctx) {
  if (!_isModuleLevel(node)) return;
  for (const child of node.children || []) {
    if (child.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    const valueNode = child.childForFieldName('value');
    // Refuses destructuring targets (`const { a } = foo()`, `const [a,b] =
    // pair()`) — see typescript.js's identical guard for why.
    if (!nameNode || nameNode.type !== 'identifier' || !valueNode) continue;
    const name = base._readText(nameNode);
    if (!name) continue;

    if (_FUNCTION_VALUE_TYPES.has(valueNode.type)) {
      const idx = ctx.addNode({
        node_type: 'METHOD', name,
        summary: `${name}()`,
        start_line: ctx.line(child), end_line: ctx.endLine(child),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
        // See typescript.js's identical call site for why this is wired here
        // rather than relying on base.js's own walk()#functionTypes branch
        // (this METHOD never reaches it).
        args: _extractValueArgs(valueNode),
        ...(base.detectAsync(valueNode, _ASYNC_MARKER_CONFIG) ? { is_async: true } : {}),
        // Same rationale as the args/is_async wiring above this
        // METHOD-creation site — CONFIG is this module's own top-level const,
        // in scope by closure.
        cyclomatic_complexity: base.computeCyclomatic(valueNode.childForFieldName('body'), CONFIG),
      });
      if (!ctx.methodByName.has(name)) ctx.methodByName.set(name, idx);
      const bodyNode = valueNode.childForFieldName('body');
      if (bodyNode) ctx.registerCallableBody(idx, bodyNode, valueNode);
    } else if (_CONST_VALUE_TYPES.has(valueNode.type)) {
      if (ctx.classByName.has(name)) continue;
      const idx = ctx.addNode({
        node_type: 'CLASS', name,
        summary: name,
        start_line: ctx.line(child), end_line: ctx.endLine(child),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
      });
      ctx.classByName.set(name, idx);
    }
  }
}

function _extraWalkJs(node, source, ctx) {
  if (node.type === 'lexical_declaration') {
    _handleModuleLevelConst(node, source, ctx);
    return;
  }
  if (node.type !== 'export_statement') return;
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return; // plain declaration export — let normal recursion handle it
  const modulePath = _modulePathText(sourceNode);
  if (!modulePath) return;

  const clause = (node.children || []).find((c) => c.type === 'export_clause');
  const imported = [];
  if (clause) {
    for (const spec of clause.children || []) {
      if (spec.type !== 'export_specifier') continue;
      const nameNode = spec.childForFieldName('name');
      if (nameNode) imported.push({ name: base._readText(nameNode), module: modulePath });
    }
  } else {
    // `export * from './x'` or `export * as ns from './x'` — no individual
    // symbol names to recover; register the module itself, mirroring
    // python.js/typescript.js's wildcard-import handling.
    imported.push({ name: modulePath, module: modulePath });
  }

  // registerImportFact (base.js) records the import — same dedup contract
  // (ctx.importedAliases), no node created.
  for (const im of imported) {
    base.registerImportFact(ctx, { name: im.name, alias: im.alias, module: im.module, line: ctx.line(node) });
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
        _parser = await base.loadGrammar('javascript');
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
