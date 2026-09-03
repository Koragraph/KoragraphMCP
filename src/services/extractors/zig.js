'use strict';

// The closed CLASS/METHOD/IMPORT node_type + traversal-vocabulary edge_type
// contract defined in extractors/base.js maps a richer relation set down onto
// the closed set:
//   contains     -> dropped (file scoping is the DB row's file_id, not an edge)
//   method       -> DEFINED_IN (function_declaration nested in a struct ->
//                    owning struct, same_file)
//   imports_from -> IMPORTS (imports are nodes here, not the dangling FILE-node
//                    edges the source emits to an id no node in its own output
//                    defines — the same structural difference
//                    go.js/rust.js/csharp.js/python.js already document for
//                    their own languages)
//   calls        -> CALLS
// This extractor has no cross-file resolution at all (no ensure_named_node
// stub, no raw_calls consumer) — it is single-file by construction, so unlike
// rust.js/csharp.js there is no "cross-file resolution is Track B's job" caveat
// to state.
//
// Deliberately NOT filtering resolveCall through
// base._LANGUAGE_BUILTIN_GLOBALS, unlike go.js/rust.js: resolution here is
// purely by same-file label lookup with no built-in filter. Adding one would
// be an unrequested improvement; the flat same-file name table already makes a
// false-positive resolution to an unrelated same-named symbol impossible
// unless the file itself defines a function literally named e.g. "String".

const base = require('./base');

// Cyclomatic complexity. Zig's `if`/`while`/`for` are usable
// both as statements (if_statement/while_statement/for_statement) and as
// expressions (if_expression) — both forms counted. switch_case wraps both
// a real arm and Zig's `else =>` fallback arm (an `else` child distinguishes
// it, not `default`) — excluded via branchArmDefaultTypes/_isDefaultArm,
// which already checks for a literal `else` child alongside `default`.
// `&&`/`||` AND the word forms `and`/`or` (Zig accepts both)
// share the same binary_expression `operator` field.
const _ZIG_COMPLEXITY_CONFIG = {
  branchNodeTypes: new Set(['if_statement', 'if_expression', 'while_statement', 'for_statement', 'switch_case']),
  branchArmDefaultTypes: new Set(['switch_case']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||', 'and', 'or']),
};

let _parserState = 'pending'; // 'pending' | 'ready' | 'failed'
let _parser = null;
let _parserReadyPromise = null;

// See extractors/go.js's identical comment: loads through base.js's shared
// grammar loader (never a second independent Parser.init()), lazily invoked
// so this module has no load-time dependency on ast-extractor.js even though
// ast-extractor.js requires this file at its own top level.
function _ensureParserReady() {
  if (!_parserReadyPromise) {
    _parserReadyPromise = (async () => {
      try {
        _parser = await base.loadGrammar('zig');
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

const _IMPORT_BUILTINS = new Set(['@import', '@cImport']);

const _CONTAINER_KEYWORD = {
  struct_declaration: 'struct',
  enum_declaration: 'enum',
  union_declaration: 'union',
  error_set_declaration: 'error set',
  opaque_declaration: 'opaque',
};
const _CONTAINER_TYPES = new Set(Object.keys(_CONTAINER_KEYWORD));

// Mirrors zig.py's `_extract_import`: `node` is a variable_declaration whose
// value child is either a builtin_function (`@import("std")`) or a
// field_expression wrapping one (`@import("std").mem`). Returns the module
// name (last path segment, extension stripped) or null. One level of
// field_expression recursion, exactly as the Python source does — no deeper.
function _extractImportModuleName(node) {
  for (const child of node.children || []) {
    if (child.type === 'builtin_function') {
      let bi = null;
      let args = null;
      for (const c of child.children || []) {
        if (c.type === 'builtin_identifier') bi = base._readText(c);
        else if (c.type === 'arguments') args = c;
      }
      if (bi && _IMPORT_BUILTINS.has(bi) && args) {
        for (const arg of args.children || []) {
          if (arg.type === 'string_literal' || arg.type === 'string') {
            const raw = base._readText(arg).replace(/^"|"$/g, '');
            const moduleName = raw.split('/').pop().split('.')[0];
            if (moduleName) return moduleName;
          }
        }
      }
      return null;
    }
    if (child.type === 'field_expression') {
      return _extractImportModuleName(child);
    }
  }
  return null;
}

function extract(tree, content, filePath) {
  const root = tree.rootNode;
  const nodes = [];
  const edges = [];

  const classByName = new Map();  // struct/enum/union name -> nodeIndex
  const methodByName = new Map(); // function name -> nodeIndex (flat, first-wins)
  const importByName = new Map(); // module_name -> import fact
  const importFacts = [];         // flat list threaded to the FILE node's properties.imports
  const functionBodies = [];      // { nodeIndex, body }

  function addNode(n) {
    nodes.push(n);
    return nodes.length - 1;
  }

  // ─── function_declaration → METHOD, variable_declaration → CLASS/IMPORT ──
  // Mirrors zig.py's `walk`: a single recursive dispatcher threading
  // `parent_struct_nid` (here `parentClassIdx`) through struct bodies.
  function walk(node, parentClassIdx, inBodyIn) {
    const t = node.type;
    // Container members hang off struct/enum/union bodies; a `block` is always
    // executable scope (a function body, a `test`, a `comptime` block), so
    // anything bound inside one is a temporary.
    const inBody = inBodyIn || t === 'block';

    if (t === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = base._readText(nameNode);
        const line = _line(node);
        const endLine = _endLine(node);
        const hasOwner = parentClassIdx !== undefined && parentClassIdx !== null;
        // args-only for the bespoke extractors. Zig's function_declaration has no
        // `parameters` FIELD — the container is a plain direct child of type
        // `parameters`, entries of type `parameter`.
        const paramsNode = (node.children || []).find((c) => c.type === 'parameters');
        const args = base.extractArgs(paramsNode, new Set(['parameter']));
        const body = node.childForFieldName('body');
        const idx = addNode({
          node_type: 'METHOD', name,
          summary: hasOwner ? `.${name}()` : `${name}()`,
          start_line: line, end_line: endLine,
          confidence_tier: 'EXTRACTED', confidence: 1.0,
          args,
          cyclomatic_complexity: base.computeCyclomatic(body, _ZIG_COMPLEXITY_CONFIG),
        });
        if (hasOwner) {
          edges.push({ from: idx, to: parentClassIdx, edge_type: 'DEFINED_IN', resolution: 'same_file', evidence_line: line });
        }
        if (!methodByName.has(name)) methodByName.set(name, idx);
        if (body) functionBodies.push({ nodeIndex: idx, body });
        // `pub fn List(comptime T: type) type { return struct { pub fn push(...) }; }`
        // is how Zig writes a generic type, so a function BODY is a real
        // declaration site — descend, with locals suppressed.
        if (body) walk(body, undefined, true);
      }
      return;
    }

    if (t === 'variable_declaration') {
      const nameNode = (node.children || []).find((c) => c.type === 'identifier');
      const named = (node.namedChildren || []).filter((c) => c !== nameNode);
      const valueNode = named.length ? named[named.length - 1] : null;
      const name = nameNode ? base._readText(nameNode) : null;

      // `const std = @import("std")` is Zig's import syntax, not a declaration:
      // it belongs on the import plane, the same as every other language's
      // import statement.
      const moduleName = _extractImportModuleName(node);
      if (moduleName) {
        if (!importByName.has(moduleName)) {
          const fact = { name: moduleName, alias: null, module: moduleName, line: _line(node) };
          importFacts.push(fact);
          importByName.set(moduleName, fact);
        }
        return;
      }

      // A body-local `var`/`const` (and `_ = expr;`, which parses as one) is a
      // temporary, not a container member.
      // A container can hide anywhere in the declaration, not just in the value:
      // `const op: packed struct { pub fn f() ... } = @bitCast(b);` puts one in
      // the TYPE annotation.
      const descend = (body) => {
        for (const child of node.namedChildren || []) {
          if (child !== nameNode) walk(child, parentClassIdx, body);
        }
      };

      if (inBody || name === '_' || !name) {
        descend(inBody);
        return;
      }

      if (valueNode && _CONTAINER_TYPES.has(valueNode.type)) {
        const line = _line(node);
        let idx = classByName.get(name);
        if (idx === undefined) {
          idx = addNode({
            node_type: 'CLASS', name,
            summary: `${_CONTAINER_KEYWORD[valueNode.type]} ${name}`,
            start_line: line, end_line: _endLine(valueNode),
            confidence_tier: 'EXTRACTED', confidence: 1.0,
          });
          classByName.set(name, idx);
        }
        for (const child of valueNode.children || []) walk(child, idx, false);
        return;
      }

      // Every remaining container-level binding — `pub const max_len = 100`,
      // `const Map = std.AutoHashMap(K, V)`, `const Alloc = std.mem.Allocator`.
      // Zig has no declaration form other than `fn` and `const`/`var`, so these
      // are the language's constants, type aliases and comptime-built types; the
      // closed node vocabulary (CLASS/METHOD/IMPORT) has no constant, and CLASS
      // is reserved for containers because walkGeneric-style CLASS identity is
      // one-per-name-per-file — two structs' `small_size` are distinct symbols.
      const idx = addNode({
        node_type: 'METHOD', name,
        summary: name,
        start_line: _line(node), end_line: _endLine(node),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
      });
      if (parentClassIdx !== undefined && parentClassIdx !== null) {
        edges.push({ from: idx, to: parentClassIdx, edge_type: 'DEFINED_IN', resolution: 'same_file', evidence_line: _line(node) });
      }
      if (!methodByName.has(name)) methodByName.set(name, idx);
      descend(false);
      return;
    }

    for (const child of node.children || []) walk(child, parentClassIdx, inBody);
  }
  walk(root, undefined, false);

  // importFacts, collected above, carries the imports to the FILE node's
  // properties.imports.

  // ─── CALLS: same-file resolution by trailing dotted segment ──────────────
  // Mirrors zig.py's `walk_calls` exactly: callee = fn_text.split(".")[-1],
  // looked up against the SAME flat methodByName table regardless of
  // whether the call was a bare identifier or a member/scoped access
  // (`std.math.sqrt(...)` resolves on "sqrt" as would any other name in
  // scope) — no accessor-vs-bare distinction, no import-evidence branch,
  // because zig.py itself has neither.
  //
  // Unlike rust.js's `self`, tree-sitter-zig has NO dedicated
  // grammar node for a self-receiver — `self` here is only the conventional
  // first-parameter name: `self.other()` parses as a plain field_expression
  // whose `object` child is a bare `identifier` "self", structurally identical
  // to `Widget.other()`. Because it already resolves via the SAME flat table
  // as every other dotted call, `self.method()` in Zig already gets a
  // same_file edge today — no coverage hole there. Elevating it to tier 1
  // (this_receiver) would mean trusting a naming convention with no grammar
  // backing as proof, which tier honesty says not to do — so this
  // file gets no selfTokens-equivalent addition, unlike rust.js/objc.js.
  // What WAS a real hole: a call whose trailing segment matches nothing in
  // methodByName vanished with no residue — fixed below.
  const seenPairs = new Set();
  const unresolvedCalls = [];
  const seenDeferred = new Set();
  function walkCalls(node, callerIdx) {
    if (node.type === 'function_declaration') return;
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn) {
        const fnText = base._readText(fn);
        const parts = fnText.split('.');
        const callee = parts[parts.length - 1];
        const targetIdx = callee ? methodByName.get(callee) : undefined;
        if (targetIdx !== undefined && targetIdx !== callerIdx) {
          const pairKey = `${callerIdx}->${targetIdx}`;
          if (!seenPairs.has(pairKey)) {
            seenPairs.add(pairKey);
            edges.push({ from: callerIdx, to: targetIdx, edge_type: 'CALLS', resolution: 'same_file', evidence_line: _line(node) });
          }
        } else if (callee && targetIdx === undefined) {
          const dkey = `${callerIdx}::${callee}`;
          if (!seenDeferred.has(dkey)) {
            seenDeferred.add(dkey);
            unresolvedCalls.push({ from: callerIdx, calleeName: callee, line: _line(node) });
          }
        }
      }
    }
    for (const child of node.children || []) walkCalls(child, callerIdx);
  }
  for (const { nodeIndex, body } of functionBodies) walkCalls(body, nodeIndex);

  const { nodes: merged, indexMap } = base.mergeSameFileDuplicates(nodes);
  const result = {
    nodes: merged,
    edges: base.remapEdgeIndices(indexMap, edges),
    unresolvedCalls: base.remapFromIndices(indexMap, unresolvedCalls),
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
