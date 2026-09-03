'use strict';

// This is not a port: every node type and field name below was read off
// tree-sitter-ocaml.wasm directly, via a live parse probe.
//
// The grammar was already vendored at node_modules/tree-sitter-wasms/out/ but
// `.ml` appeared in neither EXT_TO_SLUG nor EXT_TO_GRAMMAR, so an OCaml file
// reached no tier at all and extracted zero nodes.
//
// Verified grammar shape:
//   - a top-level definition is `value_definition` -> `let_binding`, and it
//     is the INNER `let_binding` that carries the useful fields: `pattern`
//     (a `value_name`) and `body`. `value_definition` itself exposes no
//     fields at all, so functionTypes targets `let_binding`.
//   - parameters are DIRECT `parameter` children of the let_binding (there
//     is no parameter-list wrapper), hence paramsAreDirectChildren.
//   - `application_expression`'s callee is the `function` field, a
//     `value_path` whose text is the full dotted path (`List.fold_left`) for
//     a qualified call and the bare name (`find_by_id`) otherwise.
//   - `open_module`'s target is a `module_path` child; it has no `name`
//     field.
//
// The one real modelling decision: the old rule was "a let_binding is a METHOD
// only if it has a `parameter` child". The rule is unsound as well as lossy —
// `let compose = fun f g x -> ...`, `let find = List.find`, and every
// point-free definition are callable with no `parameter` child, and a
// parameterless `let limit = 5` is referenced from another module exactly like
// a function is. What OCaml actually has is: `module`/`class` own members, and
// everything else a structure declares (let, external, type, method) is a named
// symbol. So modules and classes are CLASS and the rest are METHOD.
//
// type_binding is deliberately NOT a CLASS: walkGeneric admits one CLASS per
// name per file (base.js#validateOutput's invariant, written for Rust
// struct+impl), and `type t` once per module is the OCaml idiom — as a CLASS,
// the second `t` in a file is silently dropped.
//
// Declared divergences:
//   - `open_module` registers the module as an import FACT only; OCaml's
//     module-to-file resolution is `resolution/**` territory.
//   - A `let ... in` binding inside a function body is a local temporary, not
//     a structure member, and no longer produces a node.
//   - `let (a, b) = pair` and `let _ = side_effect ()` produce no node: the
//     pattern is not a name.

const base = require('./base');

// A `let ... in` binding is function-local; the grammar gives it the same node
// type as a structure-level one, so the disqualifier is the enclosing
// let_expression.
function _insideLetExpression(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'let_expression') return true;
  }
  return false;
}

function _resolveOcamlFuncName(node) {
  if (node.type === 'external') {
    const nameNode = (node.children || []).find((c) => c.type === 'value_name');
    return nameNode ? base._readText(nameNode) : null;
  }
  if (node.type === 'type_binding' || node.type === 'method_definition') {
    const nameNode = node.childForFieldName('name');
    return nameNode ? base._readText(nameNode) : null;
  }
  if (_insideLetExpression(node)) return null;
  const pattern = node.childForFieldName('pattern');
  if (!pattern || pattern.type !== 'value_name') return null;
  const name = base._readText(pattern);
  return name === '_' ? null : name;
}

// `open_module` exposes no `name` field — the module path is a `module_path`
// child whose text is the full dotted path.
function _importOcaml(node) {
  for (const child of node.children || []) {
    if (child.type !== 'module_path' && child.type !== 'module_name') continue;
    const raw = base._readText(child);
    if (!raw) return [];
    const segs = raw.split('.');
    const name = segs[segs.length - 1];
    return name ? [{ name, module: segs.length > 1 ? segs.slice(0, -1).join('.') : undefined }] : [];
  }
  return [];
}

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['module_binding', 'class_binding']),
  functionTypes: new Set(['let_binding', 'external', 'type_binding', 'method_definition']),
  importTypes: new Set(['open_module']),
  callTypes: new Set(['application_expression']),
  callFunctionField: 'function',
  functionBoundaryTypes: new Set(['let_binding']),
  importHandler: _importOcaml,
  resolveFunctionNameFn: _resolveOcamlFuncName,
  paramsAreDirectChildren: true,
  paramEntryTypes: new Set(['parameter']),
  // `match_case` is the ARM (match_expression is the header and is deliberately
  // not counted, per base.js's own no-double-counting rule); `try_expression`
  // covers OCaml's exception handler, which has no separate catch-clause node.
  // `&&`/`||` fold into `infix_expression`, whose `operator` field node is typed
  // `and_operator`/`or_operator` — only its TEXT disambiguates, which is
  // what computeCyclomatic compares.
  branchNodeTypes: new Set(['if_expression', 'match_case', 'try_expression', 'for_expression', 'while_expression']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

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
        _parser = await base.loadGrammar('ocaml');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

// walkGeneric labels every functionTypes node `name()`. A type is not callable,
// and the label is node text retrieval reads, so it is corrected here rather
// than left to say `t()`.
function _retypeTypeSummaries(tree, nodes) {
  const typeLines = new Set();
  const visit = (n) => {
    if (n.type === 'type_binding') {
      const nameNode = n.childForFieldName('name');
      if (nameNode) typeLines.add(`${n.startPosition.row + 1}:${base._readText(nameNode)}`);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(tree.rootNode);
  if (!typeLines.size) return nodes;
  return nodes.map((n) => (typeLines.has(`${n.start_line}:${n.name}`) ? { ...n, summary: `type ${n.name}` } : n));
}

function extract(tree, content, filePath) {
  const result = base.walkGeneric(tree, content, CONFIG);
  result.nodes = _retypeTypeSummaries(tree, result.nodes)
    .map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath }));
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
