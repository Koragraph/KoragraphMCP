'use strict';

// This is not a port: every node type and field name below was read off
// tree-sitter-rescript.wasm directly, via a live parse probe.
//
// The grammar was already vendored at node_modules/tree-sitter-wasms/out/ but
// `.res` appeared in neither EXT_TO_SLUG nor EXT_TO_GRAMMAR, so a ReScript
// file reached no tier at all and extracted zero nodes.
//
// Verified grammar shape:
//   - a definition is `let_declaration` -> `let_binding`, and it is the INNER
//     `let_binding` that carries the fields: `pattern` (a `value_identifier`)
//     and `body`. `let_declaration` exposes no fields, so functionTypes
//     targets `let_binding`.
//   - the `function` node holds the parameters, on a `parameters` field
//     resolving to `formal_parameters` — but ONLY for the parenthesized
//     multi-arg form `(a, b) =>`. A single unparenthesized arg (`orders =>`)
//     is a bare `value_identifier` child with no container at all.
//   - `call_expression`'s callee is the `function` field, a
//     `value_identifier_path` whose text is the full dotted path
//     (`Belt.Int.toString`) for a qualified call.
//   - `open_statement`'s target is a `module_identifier` child.
//
// Declared divergences:
//   - args for the single-unparenthesized-arg form (`raw => ...`) are not
//     collected: there is no parameter container for paramEntryTypes to
//     filter, so `args` comes back empty for those. The METHOD node, its
//     name, and its span are all correct — only the arg list undercounts.
//     Reaching the bare identifier would need a container-less entry mode
//     walkGeneric does not have, and adding one is out of scope.
//   - A `function` node that is NOT a let_binding body (an inline lambda
//     passed to `Array.reduce`, say) produces no METHOD node, matching how
//     every other language here treats an anonymous callback.
//
// Restricting METHOD to bindings whose body is literally a `function` node is
// not sound — `let map = Array.map` and `let compose = (f, g) => ...` are both
// callable, `let empty = []` is referenced from another module exactly like a
// function, and a .resi interface lists them side by side. The model is now:
// `module` is the only ReScript construct that OWNS members, so module_binding
// is the CLASS and every other module-level binding (let, external, type) is a
// METHOD symbol.
//
// type_binding is deliberately NOT a CLASS. walkGeneric admits one CLASS per
// name per file (base.js#validateOutput's invariant, for Rust struct+impl),
// and `type t` once per module is THE ReScript idiom — as CLASS the second
// `t`/`tag`/`props` in a file is silently dropped.

const base = require('./base');

// A block-local `let` is a temporary, not a module member. The grammar gives
// it the same node type as a module-level binding, so the disqualifier is an
// enclosing `function`.
function _insideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'function') return true;
  }
  return false;
}

// A destructuring binding (`let (a, b) = pair`) has a tuple/record pattern
// rather than a plain identifier; its text is punctuation, not a symbol name.
function _resolveRescriptFuncName(node) {
  if (node.type === 'type_binding') {
    const nameNode = node.childForFieldName('name');
    return nameNode ? base._readText(nameNode) : null;
  }
  if (node.type === 'external_declaration') {
    const ident = (node.children || []).find((c) => c.type === 'value_identifier');
    return ident ? base._readText(ident) : null;
  }
  if (_insideFunction(node)) return null;
  const pattern = node.childForFieldName('pattern');
  if (!pattern || pattern.type !== 'value_identifier') return null;
  return base._readText(pattern);
}

// The parameter list hangs off the binding's `function` body, not off the
// binding itself — one level deeper than paramsField can reach on its own.
function _resolveRescriptParams(node) {
  const body = node.childForFieldName('body');
  if (!body || body.type !== 'function') return null;
  return body.childForFieldName('parameters');
}

// `open` is nearly absent from real ReScript; the language's actual dependency
// statement is `@module("react") external ...`, which names a JS package. Same
// shape as javascript.js's own import facts: the specifier is both name and
// module.
function _importRescript(node) {
  if (node.type === 'decorator') {
    const ident = (node.children || []).find((c) => c.type === 'decorator_identifier');
    if (!ident || base._readText(ident) !== '@module') return [];
    const args = (node.children || []).find((c) => c.type === 'decorator_arguments');
    const str = args && (args.children || []).find((c) => c.type === 'string');
    const frag = str && (str.children || []).find((c) => c.type === 'string_fragment');
    const spec = frag ? base._readText(frag) : null;
    return spec ? [{ name: spec, module: spec }] : [];
  }
  for (const child of node.children || []) {
    if (child.type !== 'module_identifier' && child.type !== 'module_identifier_path') continue;
    const raw = base._readText(child);
    if (!raw) return [];
    const segs = raw.split('.');
    const name = segs[segs.length - 1];
    return name ? [{ name, module: segs.length > 1 ? segs.slice(0, -1).join('.') : undefined }] : [];
  }
  return [];
}

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['module_binding']),
  functionTypes: new Set(['let_binding', 'external_declaration', 'type_binding']),
  importTypes: new Set(['open_statement', 'decorator']),
  callTypes: new Set(['call_expression']),
  callFunctionField: 'function',
  functionBoundaryTypes: new Set(['let_binding']),
  importHandler: _importRescript,
  resolveFunctionNameFn: _resolveRescriptFuncName,
  resolveParamsFn: _resolveRescriptParams,
  paramEntryTypes: new Set(['parameter']),
  // `switch_match` is the ARM (switch_expression is the header and is
  // deliberately not counted, per base.js's own no-double-counting rule).
  // `&&`/`||` fold into binary_expression, whose `operator` field carries the
  // token.
  branchNodeTypes: new Set(['if_expression', 'switch_match', 'for_expression', 'while_expression']),
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
        _parser = await base.loadGrammar('rescript');
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
