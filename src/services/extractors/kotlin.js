'use strict';

// Like Java/C#/PHP/C++, Kotlin has no dedicated extractor module —
// `extract_kotlin` is `_extract_generic(path, _KOTLIN_CONFIG)`, driven by the
// shared `_extract_generic` core. This file supplies only Kotlin's own pieces:
// `_KOTLIN_CONFIG` as a base.js `LanguageConfig`, the import handler
// `_import_kotlin`, and the parts of the 6 `tree_sitter_kotlin` sites that fit
// the closed CLASS/METHOD/IMPORT + EDGE_TYPES contract.
//
// This is a REPLACEMENT, like typescript.js: `extractKotlinTreeSitter`
// already exists (ast-extractor.js). This port must beat it, not merely match
// it — see the REPLACEMENT comparison at the bottom of this file's test suite.
//
// Grammar-shape note (tree-sitter-kotlin.wasm, the grammar this codebase
// loads): `class_declaration`/`object_declaration`/`function_declaration`
// expose NO named fields at all in this wasm build (`childForFieldName`
// returns null for every field). A class/object's name is a direct
// `type_identifier` child (not `simple_identifier`/`identifier`), so this
// file's CONFIG adds `type_identifier` to `name_fallback_child_types` as an
// accommodation for the grammar bundled in `node_modules/tree-sitter-wasms`.
//
// Notes:
//   - `call_expression` exposes its callee under NO field at all in this
//     grammar (`childForFieldName` on every candidate name returns null); the
//     callee is always node.children[0], either a plain
//     `simple_identifier`/`identifier` (bare call) or a `navigation_expression`
//     (member call, e.g. `this.baz()`/`obj.qux()`) whose own last
//     `simple_identifier`/`identifier` child is the callee name. walkGeneric's
//     built-in call resolution (`resolveCall`/`walkCalls`) requires a
//     `childForFieldName`-addressable `callFunctionField` on the call node
//     itself, which does not exist for Kotlin — so `callTypes` is left EMPTY
//     here and CALLS edges are instead produced by `_resolveKotlinCalls`, a
//     second pass over the whole tree run from `extract()` after
//     `walkGeneric` returns (see that function's own comment for why it must
//     be a second pass, not `extraWalkFn`). It is exactly the local,
//     same-file equivalent of the Kotlin call branch: bare-name
//     lookup, ignoring the receiver entirely (the Kotlin
//     call-resolution pass does the same — `is_member_call` only feeds the
//     cross-file resolver, not same-file lookup).
//   - `property_declaration`/function-parameter/return type-ref collection
//     (`_kotlin_collect_type_refs`) is not ported: it feeds `references` edges
//     outside the closed `EDGE_TYPES` vocabulary, same reasoning
//     java.js/csharp.js document for their own dropped type-reference
//     collection.
//   - `enum_entry` handling (`_kotlin_extra_walk`) is not ported: it emits a
//     `case_of` edge from each enum constant to its owning enum class, outside
//     the closed `EDGE_TYPES` vocabulary. Enum constants are simply not
//     registered as nodes here — the enum class itself is still captured as
//     CLASS via `classTypes` (`class_declaration` with an `enum_class_body`).
//   - `use`-style mixin/companion-object semantics are not special-cased: a
//     Kotlin `companion object` parses as a nested `object_declaration`
//     inside the enclosing class's `class_body`, which walkGeneric's default
//     recursion already registers as its own CLASS node with a DEFINED_IN
//     edge to the enclosing class — same structural handling as any other
//     nested type, no Kotlin-specific code needed.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['class_declaration', 'object_declaration']),
  functionTypes: new Set(['function_declaration']),
  importTypes: new Set(['import_header']),
  callTypes: new Set(), // see file header — CALLS produced via extraWalkFn instead
  nameFallbackChildTypes: ['simple_identifier', 'identifier', 'type_identifier'],
  bodyFallbackChildTypes: ['function_body', 'class_body', 'enum_class_body'],
  functionBoundaryTypes: new Set(['function_declaration']),
  importHandler: _importKotlin,
  extraWalkFn: _extraWalkKotlin,
  // function_declaration has no `parameters` FIELD in this grammar — the
  // container is a plain direct child of type `function_value_parameters`,
  // hence paramsContainerTypes rather than paramsField. Entries are
  // `parameter` (name via its own `simple_identifier` child — no `name`
  // field either, caught by paramEntryName's fallback descendant search).
  // No async/decorator wiring here (Kotlin's nearest analogue, `suspend`, is
  // not literally `async`, and coroutine/annotation coverage is unverified —
  // left for a later pass rather than guessed at).
  paramsContainerTypes: new Set(['function_value_parameters']),
  paramEntryTypes: new Set(['parameter']),
  // Kotlin has no C-style ternary (its `if` is itself an expression, already
  // counted via if_expression); && and || are their own distinct node types
  // (conjunction_expression/disjunction_expression), not a shared generic
  // binary node, so no logicalOperatorField mechanism is needed.
  // when_entry's `else` arm shares the same node type as a real arm — best
  // effort exclusion via branchArmDefaultTypes/_isDefaultArm (not fully
  // verified against every `else ->` shape; a documented approximation).
  branchNodeTypes: new Set(['if_expression', 'for_statement', 'while_statement', 'when_entry', 'catch_block', 'conjunction_expression', 'disjunction_expression']),
  branchArmDefaultTypes: new Set(['when_entry']),
});

// An import_header's `identifier` child
// carries the full dotted path as ONE token's text in this grammar (e.g.
// "a.b.C"), not a chain of nested nodes the way java.js's scoped_identifier
// walk needs — so the last dot-segment is the imported name directly.
// `import a.b.*` still has an `identifier` child ("a.b", the wildcard "*" is a
// separate sibling `wildcard_import` node), so the same last-segment rule
// naturally falls back to the package name. `import a.b.D as E` carries a
// sibling `import_alias` node whose text is "as E" — stripped to the bare
// alias.
function _importKotlin(node) {
  const identNode = (node.children || []).find((c) => c.type === 'identifier');
  if (!identNode) return [];
  const raw = base._readText(identNode);
  const segs = raw.split('.').filter(Boolean);
  if (!segs.length) return [];
  const moduleName = segs[segs.length - 1];
  if (!moduleName) return [];
  const aliasNode = (node.children || []).find((c) => c.type === 'import_alias');
  let alias;
  if (aliasNode) {
    const aliasText = base._readText(aliasNode).replace(/^as\s+/, '').trim();
    if (aliasText) alias = aliasText;
  }
  const pkgSegs = segs.slice(0, -1);
  return [{ name: moduleName, alias, module: pkgSegs.length ? pkgSegs.join('.') : undefined }];
}

// First type_identifier descendant's text — Kotlin's user_type wraps a
// type_identifier (and, for generics, type_arguments) but this file only
// needs the bare base-type name for same-file EXTENDS/IMPLEMENTS matching.
function _firstTypeIdentifierText(node) {
  if (!node) return null;
  if (node.type === 'type_identifier') return base._readText(node);
  for (const c of node.children || []) {
    const found = _firstTypeIdentifierText(c);
    if (found) return found;
  }
  return null;
}

// Relocates the delegation_specifier(s) inheritance/interface
// implementation into the closed EXTENDS/IMPLEMENTS vocabulary.
// This grammar exposes each base directly as a `delegation_specifier`
// child of the class_declaration/object_declaration itself — no wrapping
// `delegation_specifiers` node. A `constructor_invocation` child means a
// superclass constructor call (`: Base()`) -> EXTENDS; a bare `user_type`
// child means an interface (`: Iface`) -> IMPLEMENTS — same disposition
// the `relation` variable encodes. Same-file only: resolves when
// the base name is already registered in `ctx.classByName` — cross-file/
// external bases never resolve, same "refuse to guess" contract limitation
// csharp.js's/php.js's EXTENDS/IMPLEMENTS ports document.
function _walkKotlinDelegations(node, source, ctx) {
  const name = _firstTypeIdentifierText(node);
  if (!name) return;
  const classIdx = ctx.classByName.get(name);
  if (classIdx === undefined) return;

  for (const child of node.children || []) {
    if (child.type !== 'delegation_specifier') continue;
    const ctorInv = (child.children || []).find((c) => c.type === 'constructor_invocation');
    let edgeType;
    let typeNode;
    if (ctorInv) {
      edgeType = 'EXTENDS';
      typeNode = (ctorInv.children || []).find((c) => c.type === 'user_type');
    } else {
      edgeType = 'IMPLEMENTS';
      typeNode = (child.children || []).find((c) => c.type === 'user_type');
    }
    if (!typeNode) continue;
    const baseName = _firstTypeIdentifierText(typeNode);
    if (!baseName) continue;
    const baseIdx = ctx.classByName.get(baseName);
    if (baseIdx === undefined || baseIdx === classIdx) continue;
    ctx.addEdge(classIdx, baseIdx, edgeType, 'same_file', ctx.line(node));
  }
}

// Relocates the Kotlin call-target callee resolution as a
// same-file-only equivalent, since walkGeneric's own field-based call
// resolution has no field to read for this grammar (see file header).
// Deliberately run as its OWN pass over the whole tree, in `extract()`,
// AFTER `walkGeneric` has finished registering every CLASS/METHOD — unlike
// the EXTENDS/IMPLEMENTS relocation above (which runs inside walkGeneric's
// single forward pass and is therefore order-sensitive, same documented
// limitation as python.js's EXTENDS port), CALLS needs every method name
// resolvable regardless of declaration order within the file (e.g. `bar()`
// calling `helper()` declared later), exactly mirroring base.js's own
// two-pass class/function-registration-then-call-walk design
// (walkGeneric's own `functionBodies`/`walkCalls`).
function _resolveKotlinCalls(root, result) {
  const methodByName = new Map();
  const classByName = new Map();
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (n.node_type === 'METHOD' && !methodByName.has(n.name)) methodByName.set(n.name, i);
    if (n.node_type === 'CLASS' && !classByName.has(n.name)) classByName.set(n.name, i);
  }
  const seen = new Set();
  // This pass had NO unresolvedCalls output at all originally — every call
  // whose callee matched nothing in methodByName/classByName vanished with no
  // residue. `result.unresolvedCalls` already exists on the walkGeneric result
  // object (CONFIG.callTypes is empty here, so walkGeneric's own call pass
  // never populates it — this is the first writer). No selfTokens-equivalent
  // upgrade: `_kotlinCallCallee`'s own header already documents that the
  // receiver (this/super included) is deliberately never consulted —
  // same scope boundary as java.js/ruby.js's
  // bare-name-only fallback, not one of the bespoke self-form languages
  // (go/objc/zig/rust/elixir).
  const seenDeferred = new Set();

  (function walkFn(node) {
    if (node.type === 'function_declaration') {
      const name = _firstIdentifierText(node);
      const callerIdx = name ? methodByName.get(name) : undefined;
      const bodyNode = (node.children || []).find((c) => c.type === 'function_body');
      if (callerIdx !== undefined && bodyNode) {
        (function walkBody(n) {
          if (n.type === 'call_expression') {
            const calleeName = _kotlinCallCallee(n);
            if (calleeName && !base._LANGUAGE_BUILTIN_GLOBALS.has(calleeName)) {
              const targetIdx = methodByName.has(calleeName)
                ? methodByName.get(calleeName)
                : classByName.get(calleeName);
              if (targetIdx !== undefined && targetIdx !== callerIdx) {
                const key = `${callerIdx}->${targetIdx}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  result.edges.push({
                    from: callerIdx, to: targetIdx, edge_type: 'CALLS',
                    resolution: 'same_file', evidence_line: n.startPosition.row + 1,
                  });
                }
              } else if (targetIdx === undefined) {
                const dkey = `${callerIdx}::${calleeName}`;
                if (!seenDeferred.has(dkey)) {
                  seenDeferred.add(dkey);
                  result.unresolvedCalls.push({ from: callerIdx, calleeName, line: n.startPosition.row + 1 });
                }
              }
            }
          }
          if (n !== bodyNode && n.type === 'function_declaration') return;
          for (const c of n.children || []) walkBody(c);
        })(bodyNode);
      }
    }
    for (const c of node.children || []) walkFn(c);
  })(root);
}

// Bare simple_identifier/identifier child's text — used for a
// function_declaration's own name (mirrors resolveName's fallback, but this
// file needs it standalone in extraWalkFn, which has no access to
// walkGeneric's private resolveName closure).
function _firstIdentifierText(node) {
  const child = (node.children || []).find((c) => c.type === 'simple_identifier' || c.type === 'identifier');
  return child ? base._readText(child) : null;
}

// A call node's first child is either a
// plain identifier (bare call) or a navigation_expression (member call); for
// the latter, the LAST simple_identifier/identifier descendant of the
// navigation_expression is the callee name — the receiver itself is not
// consulted (the same-file pass ignores it too; `is_member_call`
// only feeds the cross-file resolver). A descendant search (not just direct
// children) is needed because the wasm grammar nests the method-name token one
// level deeper than the receiver, inside a `navigation_suffix` child:
// `this.baz()` parses as `navigation_expression(this_expression,
// navigation_suffix(., simple_identifier))` — "baz" is a grandchild, not a
// child, of the navigation_expression. Safe to search the whole
// navigation_expression subtree: it only ever contains receiver/suffix
// tokens, never a nested call's own arguments (those live in the sibling
// `call_suffix` node, outside this subtree).
function _kotlinCallCallee(callNode) {
  const first = (callNode.children || [])[0];
  if (!first) return null;
  if (first.type === 'simple_identifier' || first.type === 'identifier') {
    return base._readText(first);
  }
  if (first.type === 'navigation_expression') {
    let found = null;
    (function scan(n) {
      if (n.type === 'simple_identifier' || n.type === 'identifier') found = base._readText(n);
      for (const c of n.children || []) scan(c);
    })(first);
    return found;
  }
  return null;
}

function _extraWalkKotlin(node, source, ctx) {
  if (node.type === 'class_declaration' || node.type === 'object_declaration') {
    _walkKotlinDelegations(node, source, ctx);
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
        _parser = await base.loadGrammar('kotlin');
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
  _resolveKotlinCalls(tree.rootNode, result);
  base.validateOutput(result);
  result.nodes = result.nodes.map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath }));
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  if (_parserState !== 'ready') {
    return { nodes: [], edges: [], unresolvedCalls: [] };
  }
  const tree = _parser.parse(content);
  return extract(tree, content, filePath);
}

async function ready() {
  await _ensureParserReady();
  return _parserState;
}

module.exports = { extract, extractFile, ready, CONFIG };
