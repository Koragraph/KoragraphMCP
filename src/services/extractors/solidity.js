'use strict';

// Every node type and field name below was read off tree-sitter-solidity.wasm
// directly, via a live parse probe.
//
// The grammar was already vendored at node_modules/tree-sitter-wasms/out/ but
// `.sol` appeared in neither EXT_TO_SLUG nor EXT_TO_GRAMMAR, so a Solidity
// file reached no tier at all and extracted zero nodes.
//
// Verified grammar shape:
//   - contract/interface/library_declaration: `name` (identifier) + `body`
//     (contract_body). All three are class-like — a library is Solidity's
//     stateless-function container and an interface its abstract type, the
//     same class/interface/trait split php.js and csharp.js already map onto
//     CLASS.
//   - struct_declaration: `name`, but NO `body` field (children are
//     'struct' identifier '{' struct_member '}'). Included as class-like for
//     the name/span; it holds no functions, so nothing nests under it.
//   - function_definition / modifier_definition: `name` (identifier) +
//     `body` (function_body). An interface's function has a `name` but no
//     `body` — walkGeneric emits the METHOD node either way and only skips
//     registerCallableBody, which is correct for a declaration-only entry.
//   - constructor_definition: no `name` field at all — resolveConstructorName
//     below supplies the literal "constructor", mirroring how java.js/
//     typescript.js surface a constructor as a named METHOD rather than
//     dropping it.
//   - parameters are DIRECT children of the function node (there is no
//     parameter-list wrapper node), hence paramsAreDirectChildren.
//   - call_expression's callee is the `function` field; a qualified call
//     (`MathLib.add(...)`) wraps it in `member_expression` with
//     `object`/`property` fields.
//
// This is the shipping path for `.sol`: it replaced the GENERIC_LANG_CONFIG walk, which emitted
// no edges and no import facts and missed every event, error, enum, `type X is uint`,
// `receive`/`fallback` and constructor — the generic tier has no hook to name a node the grammar
// gives no `name` field.
//   - enum_declaration and user_defined_type_definition join the class-like set; event_definition,
//     error_declaration and fallback_receive_definition join the callable set. An event and an
//     error ARE invoked (`emit X(...)`, `revert X(...)`), so METHOD is the honest mapping.
//   - `is` inheritance now emits EXTENDS/IMPLEMENTS — the inheritance_specifier shape is one
//     `user_defined_type` child. Solidity spells both with `is`, so the split is made
//     from how the supertype was declared, and a supertype declared in another file (the common
//     case) goes out as unresolved rather than guessed.
//   - `import_directive` now produces import facts. A Solidity import names a FILE PATH, and
//     `import {X} from "./A.sol"` also names symbols: `module` carries the path for
//     ingest.js's resolver, `name` carries the symbol where one is written and the path otherwise.
//   - `using X for Y` and state variables still produce no nodes. A state variable is Solidity's
//     field and NODE_TYPES is closed to CLASS|METHOD|IMPORT with no field grain — reported rather
//     than mapped onto a type that would be a lie.

const base = require('./base');

let _currentInterfaceNames = new Set();

// constructor_definition has no `name` field; every other function-like node
// in this grammar does. Returning a stable literal keeps the constructor
// addressable as a METHOD instead of being silently dropped by walkGeneric's
// `if (name)` guard.
function _resolveSolidityFuncName(node) {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return base._readText(nameNode);
  if (node.type === 'constructor_definition') return 'constructor';
  // `receive() external payable {}` / `fallback() {}` — one node type, two names, and the name is
  // an anonymous keyword token rather than a field.
  if (node.type === 'fallback_receive_definition') {
    const kw = (node.children || []).find((c) => c.type === 'receive' || c.type === 'fallback');
    return kw ? kw.type : null;
  }
  return null;
}

// `contract A is B, C` — every supertype is an `inheritance_specifier` child holding one
// `user_defined_type`. Solidity has no `implements`: a contract inheriting an interface uses the
// same `is`, so the distinction is made from what the supertype was DECLARED as, same rule
// csharp.js applies, and falls back to EXTENDS when the supertype is not declared in this file.
function _extraWalkSolidity(node, source, ctx) {
  if (!CONFIG.classTypes.has(node.type)) return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classIdx = ctx.classByName.get(base._readText(nameNode));
  if (classIdx === undefined) return;
  for (const child of node.children || []) {
    if (child.type !== 'inheritance_specifier') continue;
    const typeNode = (child.children || []).find((c) => c.type === 'user_defined_type') || child;
    const baseName = base._readText(typeNode);
    if (!baseName) continue;
    const edgeType = _currentInterfaceNames.has(baseName) ? 'IMPLEMENTS' : 'EXTENDS';
    const baseIdx = ctx.classByName.get(baseName);
    if (baseIdx === undefined || baseIdx === classIdx) {
      ctx.addUnresolvedInheritance(classIdx, baseName, edgeType);
      continue;
    }
    ctx.addEdge(classIdx, baseIdx, edgeType, 'same_file', ctx.line(node));
  }
}

// A Solidity import names a FILE PATH, not a symbol, and may or may not also name symbols:
// `import "./A.sol";`, `import {X, Y} from "./A.sol";`, `import * as N from "./A.sol";`.
// `module` carries the path for ingest.js's relative-path resolution; `name` carries the imported
// symbol where one is written, and the path itself otherwise.
function _solidityImportHandler(node) {
  const pathNode = (node.children || []).find((c) => c.type === 'string');
  if (!pathNode) return null;
  const module = base._readText(pathNode).replace(/^["']|["']$/g, '');
  const symbols = (node.children || []).filter((c) => c.type === 'identifier').map((c) => base._readText(c));
  if (!symbols.length) return [{ name: module, module, alias: null }];
  return symbols.map((s) => ({ name: s, module, alias: null }));
}

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['contract_declaration', 'interface_declaration', 'library_declaration', 'struct_declaration', 'enum_declaration', 'user_defined_type_definition']),
  functionTypes: new Set(['function_definition', 'constructor_definition', 'fallback_receive_definition', 'modifier_definition', 'event_definition', 'error_declaration']),
  importTypes: new Set(['import_directive']),
  importHandler: _solidityImportHandler,
  extraWalkFn: _extraWalkSolidity,
  callTypes: new Set(['call_expression']),
  callFunctionField: 'function',
  callAccessorNodeTypes: new Set(['member_expression']),
  callAccessorField: 'property',
  callAccessorObjectField: 'object',
  selfTokens: new Set(['this']),
  functionBoundaryTypes: new Set(['function_definition', 'constructor_definition', 'fallback_receive_definition', 'modifier_definition']),
  resolveFunctionNameFn: _resolveSolidityFuncName,
  paramsAreDirectChildren: true,
  paramEntryTypes: new Set(['parameter']),
  // do_while_statement is distinct from while_statement, and `? :` is
  // ternary_expression. `&&`/`||` fold into binary_expression, whose
  // `operator` field holds the token.
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'do_while_statement', 'ternary_expression']),
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
        _parser = await base.loadGrammar('solidity');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

function extract(tree, content, filePath) {
  // Same one-shot module-level handoff csharp.js uses: walkGeneric offers no pre-pass hook, and
  // `is` is one keyword for both inheritance kinds, so the supertype's own declaration is the only
  // evidence of which edge it is. Only same-file supertypes can be classified; the rest go out as
  // unresolved EXTENDS/IMPLEMENTS by the same rule.
  _currentInterfaceNames = new Set(
    tree.rootNode.descendantsOfType('interface_declaration')
      .map((n) => n.childForFieldName('name'))
      .filter(Boolean)
      .map((n) => base._readText(n))
  );
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
