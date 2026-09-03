'use strict';

// Modelled on extractors/go.js's shape, not extractors/java.js's LanguageConfig/
// walkGeneric shape, because every Elixir construct this file cares about
// (`defmodule`, `def`/`defp`, `alias`/`import`/`require`/`use`) is a `call`
// node distinguished only by its head `identifier` text, not by a distinct
// tree-sitter node type — walkGeneric's classTypes/functionTypes/importTypes
// dispatch is keyed on node.type and cannot express that.
//
// The relation set is mapped onto the closed set:
//   contains  -> dropped (module -> nested-def containment; the DEFINED_IN
//                edge below already threads method -> module the other way,
//                and file scoping is the DB row's file_id, not an edge)
//   method    -> DEFINED_IN (def/defp -> owning defmodule)
//   imports   -> IMPORTS (module -> IMPORT node; see below)
//   calls     -> CALLS
//
// This IS the shipping path for `.ex`/`.exs`. `buildGenericAstResult` routes here; no engine
// flag is involved.
//
// A structural limit, not a parsing gap: repeated `defmodule SameName` blocks in separate
// `assert_raise` scopes collide. extractors/base.js#validateOutput forbids two CLASS nodes with
// one name in a file (their canonical_key is `branch::CLASS::file::name`, with no line, so they
// genuinely collide on upsert), so mergeSameFileDuplicates collapses them.

const base = require('./base');

let _parserState = 'pending'; // 'pending' | 'ready' | 'failed'
let _parser = null;
let _parserReadyPromise = null;

// See go.js's identical comment: loads through base.js's shared grammar
// loader, lazily, so a second independent Parser.init() never races
// ast-extractor.js's own init or its require-cycle-partial-exports hazard.
function _ensureParserReady() {
  if (!_parserReadyPromise) {
    _parserReadyPromise = (async () => {
      try {
        _parser = await base.loadGrammar('elixir');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

function _line(node) {
  return node.startPosition.row + 1;
}
function _endLine(node) {
  return node.endPosition.row + 1;
}

const _IMPORT_KEYWORDS = new Set(['alias', 'import', 'require', 'use']);

const _SKIP_KEYWORDS = new Set([
  'def', 'defp', 'defmodule', 'defmacro', 'defmacrop',
  'defstruct', 'defprotocol', 'defimpl', 'defguard',
  'alias', 'import', 'require', 'use',
  'if', 'unless', 'case', 'cond', 'with', 'for',
]);

// Cyclomatic complexity. Elixir's if/unless/for/case/cond are ALL the generic `call`
// node type (distinguished only by a child identifier's TEXT, same reason
// this whole file is bespoke rather than walkGeneric-configured — see the
// file header). `if`/`unless`/`for` have no separate per-branch arm node (an
// if/unless is a single `call` with do_block/else_block children; `for` is a
// loop header), so the `call` node itself is the decision point. `case`/
// `cond` instead branch through `stab_clause` children of their do_block —
// counting the `call` itself as well as every stab_clause would double the
// header AND its arms, so only the stab_clauses are counted (the C-family
// "count case arms, not the switch header" rule) — reached
// by walking up two parents (stab_clause -> do_block -> call) since a
// `stab_clause` is ALSO how anonymous `fn ... end` clauses parse, and an fn
// clause is not itself a decision the way a case/cond arm is.
function _elixirComplexityBranch(node) {
  if (node.type === 'call') {
    const ident = (node.children || []).find((c) => c.type === 'identifier');
    const kw = ident ? base._readText(ident) : null;
    return kw === 'if' || kw === 'unless' || kw === 'for';
  }
  if (node.type === 'stab_clause') {
    const doBlock = node.parent;
    const call = doBlock && doBlock.type === 'do_block' ? doBlock.parent : null;
    if (!call || call.type !== 'call') return false;
    const ident = (call.children || []).find((c) => c.type === 'identifier');
    const kw = ident ? base._readText(ident) : null;
    return kw === 'case' || kw === 'cond';
  }
  return false;
}

const _ELIXIR_COMPLEXITY_CONFIG = {
  customBranchFn: _elixirComplexityBranch,
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||', 'and', 'or']),
};

const _MODULE_DEFS = new Set(['defmodule', 'defprotocol', 'defimpl']);
const _FUNC_DEFS = new Set(['def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate']);

// The module name is the FIRST named argument whatever its node type, not specifically an
// `alias`. Restricting it to `alias` dropped `defmodule :erlang_like`, `defmodule mod` and
// `defmodule config.test` — and dropped their whole `do` block with them, so every declaration
// nested inside also vanished. A runtime-computed module name is taken as its literal source
// text: an approximation, but a visible one, where the previous behaviour was silent loss.
function _declaredModuleName(keyword, argumentsNode, enclosingModule) {
  if (!argumentsNode) return null;
  const first = (argumentsNode.children || []).find((c) => c.isNamed);
  if (!first) return null;
  const name = base._readText(first);
  if (keyword !== 'defimpl') return name;
  // `defimpl Inspect, for: Ecto.Query` declares the module `Inspect.Ecto.Query`. Naming it after
  // the bare protocol makes two impls in one file collide on one CLASS node.
  for (const child of argumentsNode.children || []) {
    if (child.type !== 'keywords') continue;
    for (const pair of child.children || []) {
      if (pair.type !== 'pair' || !/^for:/.test(base._readText(pair))) continue;
      const value = pair.childForFieldName('value');
      if (value) return `${name}.${base._readText(value)}`;
    }
  }
  return enclosingModule ? `${name}.${enclosingModule}` : name;
}

// `def`'s target is not always the nested `name(args)` call. A guard wraps it in `when`, an
// operator definition (`def left == right`) puts the NAME in the operator token, and a
// parenless head (`defp check! do`) is a bare identifier. Returns { name, paramsNode }.
function _declaredFunction(argumentsNode) {
  if (!argumentsNode) return null;
  let target = (argumentsNode.children || []).find((c) => c.isNamed);
  if (target && target.type === 'binary_operator') {
    const op = target.childForFieldName('operator');
    const opText = op ? base._readText(op) : null;
    if (opText !== 'when') return opText ? { name: opText, paramsNode: null } : null;
    target = (target.children || []).find((c) => c.isNamed);
  }
  if (!target) return null;
  if (target.type === 'unary_operator') {
    const op = target.childForFieldName('operator');
    return op ? { name: base._readText(op), paramsNode: null } : null;
  }
  if (target.type === 'call') {
    const head = (target.children || [])[0];
    if (!head) return null;
    const paramsNode = (target.children || []).find((c) => c.type === 'arguments') || null;
    return { name: base._readText(head), paramsNode };
  }
  return { name: base._readText(target), paramsNode: null };
}

// Mirrors elixir.py's _get_alias_modules: every module named by an
// alias/import/require/use argument. Handles the single form
// (`alias Foo.Bar` -> `["Foo.Bar"]`) and the multi-alias brace form
// (`alias Foo.{Bar, Baz}` -> `["Foo.Bar", "Foo.Baz"]`), which the grammar
// represents as a `dot` node holding the base alias and a trailing `tuple`
// of member aliases.
function _getAliasModules(argumentsNode) {
  for (const child of argumentsNode.children || []) {
    if (child.type === 'alias') {
      return [base._readText(child)];
    }
    if (child.type === 'dot') {
      let aliasBase = null;
      let tupleNode = null;
      for (const sub of child.children || []) {
        if (sub.type === 'alias' && aliasBase === null) aliasBase = base._readText(sub);
        else if (sub.type === 'tuple') tupleNode = sub;
      }
      if (aliasBase && tupleNode) {
        const members = (tupleNode.children || [])
          .filter((m) => m.type === 'alias')
          .map((m) => base._readText(m));
        if (members.length) return members.map((m) => `${aliasBase}.${m}`);
      }
      return [base._readText(child)];
    }
  }
  return [];
}

// extract(tree, content, filePath) -> { nodes, edges } per extractors/base.js contract.
function extract(tree, content, filePath) {
  const root = tree.rootNode;
  const nodes = [];
  const edges = [];

  const classByName = new Map();  // module name -> nodeIndex
  const methodByName = new Map(); // function name -> nodeIndex
  const importByName = new Map(); // imported module name -> import fact
  const importFacts = [];         // flat list threaded to the FILE node's properties.imports
  const functionBodies = [];      // { nodeIndex, body }
  const pendingImports = [];      // { name, line }

  function addNode(n) {
    nodes.push(n);
    return nodes.length - 1;
  }

  // ─── First pass: defmodule -> CLASS, def/defp -> METHOD, alias/import/
  // require/use -> pending IMPORT, threading the owning module through
  // do_block bodies. Mirrors elixir.py's `walk`. ─────────────────────────────
  function walk(node, parentModuleIdx, enclosingModule) {
    if (node.type !== 'call') {
      for (const child of node.children || []) walk(child, parentModuleIdx, enclosingModule);
      return;
    }

    let identifierNode = null;
    let argumentsNode = null;
    let doBlockNode = null;
    for (const child of node.children || []) {
      if (child.type === 'identifier') identifierNode = child;
      else if (child.type === 'arguments') argumentsNode = child;
      else if (child.type === 'do_block') doBlockNode = child;
    }

    if (!identifierNode) {
      for (const child of node.children || []) walk(child, parentModuleIdx, enclosingModule);
      return;
    }

    const keyword = base._readText(identifierNode);
    const line = _line(node);

    if (_MODULE_DEFS.has(keyword)) {
      const moduleName = _declaredModuleName(keyword, argumentsNode, enclosingModule);
      if (!moduleName) {
        for (const child of node.children || []) walk(child, parentModuleIdx, enclosingModule);
        return;
      }
      // Emitted per occurrence rather than deduped by name: two `defmodule` calls in one file are
      // two distinct declarations, and collapsing them threw the second one's whole body away.
      // Genuinely identical names (only reachable through a runtime-computed module name) are
      // merged by mergeSameFileDuplicates at the end, which the output contract requires.
      const idx = addNode({
        node_type: 'CLASS', name: moduleName,
        summary: `${keyword} ${moduleName}`,
        start_line: line, end_line: _endLine(node),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
        _sourceFile: filePath, kind: keyword === 'defprotocol' ? 'protocol' : 'module',
      });
      if (!classByName.has(moduleName)) classByName.set(moduleName, idx);
      if (doBlockNode) {
        const scope = keyword === 'defmodule' ? moduleName : enclosingModule;
        for (const child of doBlockNode.children || []) walk(child, idx, scope);
      }
      return;
    }

    if (_FUNC_DEFS.has(keyword)) {
      // args-only for the bespoke extractors. `def bar(a, b)`'s own params live on the NESTED
      // `call` node's (`bar(a, b)`) own `arguments` child, not on the outer `def` call's
      // `arguments` (which just wraps that nested call). Elixir's parameter shapes are too
      // varied for a fixed node-type allowlist (plain identifier, `\\`-default binary_operator,
      // map/tuple/struct destructuring) — extractArgs falls back to tree-sitter's own isNamed
      // flag when no entryTypes Set is passed, which is exactly what's wanted here.
      const declared = _declaredFunction(argumentsNode);
      if (!declared || !declared.name) {
        for (const child of node.children || []) walk(child, parentModuleIdx, enclosingModule);
        return;
      }
      const funcName = declared.name;
      const args = base.extractArgs(declared.paramsNode);
      // `def f(x), do: expr` has NO do_block — the body is the `do:` pair inside `arguments`.
      // Treating only do_block as a body left a third of Elixir's functions contributing no
      // call sites and no complexity at all.
      const bodyNode = doBlockNode
        || (argumentsNode && (argumentsNode.children || []).find((c) => c.type === 'keywords'))
        || null;
      const idx = addNode({
        node_type: 'METHOD', name: funcName,
        summary: `${funcName}()`,
        start_line: line, end_line: _endLine(node),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
        _sourceFile: filePath,
        args,
        cyclomatic_complexity: base.computeCyclomatic(bodyNode, _ELIXIR_COMPLEXITY_CONFIG),
      });
      if (!methodByName.has(funcName)) methodByName.set(funcName, idx);
      if (parentModuleIdx !== undefined && parentModuleIdx !== idx) {
        edges.push({ from: idx, to: parentModuleIdx, edge_type: 'DEFINED_IN', resolution: 'same_file', evidence_line: line });
      }
      if (bodyNode) {
        functionBodies.push({ nodeIndex: idx, body: bodyNode });
        // A macro body is where a library's real API lives: Phoenix's `__using__` is a `defmacro`
        // whose `quote do` block holds the `def`s every consumer gets. Returning here left all of
        // them unextracted.
        for (const child of bodyNode.children || []) walk(child, parentModuleIdx, enclosingModule);
      }
      return;
    }

    if (_IMPORT_KEYWORDS.has(keyword) && argumentsNode) {
      for (const moduleName of _getAliasModules(argumentsNode)) {
        if (moduleName) pendingImports.push({ name: moduleName, line });
      }
      return;
    }

    for (const child of node.children || []) walk(child, parentModuleIdx, enclosingModule);
  }
  walk(root, undefined, null);

  // ─── Import facts, deduped by module name. The FILE node carries these as
  // `properties.imports`. ────────────
  for (const imp of pendingImports) {
    if (!importByName.has(imp.name)) {
      const fact = { name: imp.name, alias: null, module: imp.name, line: imp.line };
      importFacts.push(fact);
      importByName.set(imp.name, fact);
    }
  }

  // ─── CALLS: flat same-file label table (module names + function names),
  // resolved over each def/defp body in two passes — last-declared symbol wins
  // a name collision. ────────────────
  const labelToIdx = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].node_type === 'CLASS' || nodes[i].node_type === 'METHOD') {
      labelToIdx.set(nodes[i].name, i);
    }
  }

  // Elixir has no OOP self/this receiver — module functions
  // call sibling functions by bare name (already the flat labelToIdx table
  // above, uniformly for both `foo()` and `Mod.foo()` since only the
  // trailing dotted segment is ever used), so this file gets no
  // selfTokens-equivalent addition, unlike rust.js/objc.js. What WAS a real
  // hole: a resolvable-looking call whose name matched nothing in
  // labelToIdx vanished with no residue at all — fixed below.
  const seenPairs = new Set();
  const unresolvedCalls = [];
  const seenDeferred = new Set();
  function recordCall(calleeName, line, callerIdx) {
    if (!calleeName || base._LANGUAGE_BUILTIN_GLOBALS.has(calleeName)) return;
    const targetIdx = labelToIdx.get(calleeName);
    if (targetIdx !== undefined && targetIdx !== callerIdx) {
      const pairKey = `${callerIdx}->${targetIdx}`;
      if (seenPairs.has(pairKey)) return;
      seenPairs.add(pairKey);
      edges.push({ from: callerIdx, to: targetIdx, edge_type: 'CALLS', resolution: 'same_file', evidence_line: line, calleeName });
      return;
    }
    if (targetIdx !== undefined) return;
    const dkey = `${callerIdx}::${calleeName}`;
    if (seenDeferred.has(dkey)) return;
    seenDeferred.add(dkey);
    unresolvedCalls.push({ from: callerIdx, calleeName, line });
  }

  function walkCalls(node, callerIdx) {
    // `x |> upcase` is a call with the pipeline supplying the first argument, but the grammar
    // gives it no `call` node at all — the right operand is a bare identifier, so the whole
    // parenless pipeline stage was invisible to the call plane. `x |> String.upcase()` already
    // parses as a call and is handled below.
    if (node.type === 'binary_operator') {
      const op = node.childForFieldName('operator');
      if (op && base._readText(op) === '|>') {
        const rhs = (node.children || []).filter((c) => c.isNamed)[1];
        if (rhs && rhs.type === 'identifier') recordCall(base._readText(rhs), _line(node), callerIdx);
      }
    }
    if (node.type !== 'call') {
      for (const child of node.children || []) walkCalls(child, callerIdx);
      return;
    }

    for (const child of node.children || []) {
      if (child.type === 'identifier') {
        const kw = base._readText(child);
        if (_SKIP_KEYWORDS.has(kw)) {
          for (const c of node.children || []) walkCalls(c, callerIdx);
          return;
        }
        break;
      }
    }

    let calleeName = null;
    for (const child of node.children || []) {
      if (child.type === 'dot') {
        const dotText = base._readText(child).replace(/\.$/, '');
        const parts = dotText.split('.');
        if (parts.length) calleeName = parts[parts.length - 1];
        break;
      }
      if (child.type === 'identifier') {
        calleeName = base._readText(child);
        break;
      }
    }

    recordCall(calleeName, _line(node), callerIdx);

    for (const child of node.children || []) walkCalls(child, callerIdx);
  }
  for (const { nodeIndex, body } of functionBodies) walkCalls(body, nodeIndex);

  const merged = base.mergeSameFileDuplicates(nodes);
  const result = {
    nodes: merged.nodes,
    edges: base.remapEdgeIndices(merged.indexMap, edges),
    unresolvedCalls: unresolvedCalls.map((c) => ({ ...c, from: merged.indexMap.get(c.from) ?? c.from })),
    importFacts,
  };
  base.validateOutput(result);
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  if (_parserState !== 'ready') {
    return { nodes: [], edges: [], unresolvedCalls: [], importFacts: [] };
  }
  const tree = _parser.parse(content);
  return extract(tree, content, filePath);
}

async function ready() {
  await _ensureParserReady();
  return _parserState;
}

module.exports = { extract, extractFile, ready, CONFIG: null };
