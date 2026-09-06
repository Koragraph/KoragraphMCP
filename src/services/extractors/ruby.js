'use strict';

// Like Java/C#/C++/PHP, Ruby has no bespoke extractor — it runs the
// shared generic core over a config. This file supplies only Ruby's own
// pieces: `_RUBY_CONFIG` as a base.js `LanguageConfig`, and the parts of
// Ruby's tree_sitter_ruby sites that fit the closed CLASS/METHOD/IMPORT +
// EDGE_TYPES contract.
//
// `_RUBY_CONFIG.import_types` is EMPTY — Ruby's `require`/
// `require_relative` are plain method calls, not a dedicated import
// construct tree-sitter-ruby's grammar exposes, so there is never a Ruby
// IMPORT node, and `CONFIG.importTypes` stays empty here too.
// It does NOT follow that the file has no imports to record: `require`/
// `require_relative`/`include` are recognised as CALLS in a post-walk pass
// (_resolveRubyDirectives) and become importFacts, which is what
// facts.js#buildFileScopedIndex consumes. Still no IMPORT nodes.
//
// Behavioural notes:
//   - `module Foo` is registered as a CLASS (`_RUBY_CONFIG.class_types =
//     {"class", "module"}`) — tree-sitter-ruby's `module` node has the same
//     name/body shape as `class` (name in a `constant` field, body in
//     `body_statement`), so a plain utility/`module_function` module still
//     produces a node its methods attach to via DEFINED_IN.
//   - `call`'s `method`/`receiver` fields are direct siblings on the call
//     node itself — unlike Java's nested method_invocation.object or C#'s
//     invocation_expression/member_access_expression pair, there is no
//     nested accessor node for walkGeneric's callAccessorNodeTypes mechanism
//     to match against. `CONFIG.callFunctionField = 'method'` already reads
//     the callee directly off the call node (`callAccessorNodeTypes` stays
//     empty), resolving on bare method name only — same "refuse to guess a
//     receiver" choice java.js/php.js document for their own call sites. The
//     receiver itself (`p` in `p.run`, `Processor` in `Processor.new.call`)
//     is never captured — it would only feed cross-file receiver-type
//     resolution, which is out of scope here.
//   - `include`/`extend`/`prepend <Const>` inside a class/module body is a
//     mixin relation outside the closed `EDGE_TYPES` vocabulary. It maps onto
//     EMBEDS — the existing "gains another type's members without subclassing"
//     edge go.js already uses for Go struct embedding — rather than getting a
//     novel type or being dropped. Same-file only; a module this file does not
//     declare becomes an import fact instead of a guessed edge.
//   - `Struct.new(...)`/`Class.new(Super)`/`Data.define(...)` constant-
//     assignment class synthesis is NOT ported: it synthesizes a whole CLASS
//     node (plus attaches block-defined methods by re-parenting the walk)
//     from an `assignment` node's RHS, a shape walkGeneric's per-node
//     `extraWalkFn` hook can inspect but not restructure — the block-
//     recursion re-parenting needs direct control over which `parentClassIdx`
//     a subtree walks with, which is walkGeneric's own recursion, not exposed
//     to extraWalkFn. Declared out of scope, not silently dropped.
//   - receiver-type tagging would exist solely to feed cross-file
//     member-call resolution (the same receiver-typing category out of scope
//     for every other language, per this codebase's own reasoning in
//     java.js/csharp.js for their dropped receiver-typing machinery) — not
//     ported.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['class', 'module']),
  functionTypes: new Set(['method', 'singleton_method']),
  importTypes: new Set(),
  callTypes: new Set(['call']),
  callFunctionField: 'method',
  callAccessorNodeTypes: new Set(),
  nameFallbackChildTypes: ['constant', 'scope_resolution', 'identifier'],
  bodyFallbackChildTypes: ['body_statement'],
  functionBoundaryTypes: new Set(['method', 'singleton_method']),
  extraWalkFn: _extraWalkRuby,
  // Both `method` and `singleton_method` expose `parameters` (->
  // method_parameters). Entries: bare `identifier`, `optional_parameter`/
  // `splat_parameter`/`hash_splat_parameter`/`keyword_parameter`/
  // `block_parameter` (each has a `name` field). No async/decorator concept
  // in Ruby (annotations are plain method calls like `private`, not a
  // distinct grammar construct).
  paramEntryTypes: new Set([
    'identifier', 'optional_parameter', 'splat_parameter',
    'hash_splat_parameter', 'keyword_parameter', 'block_parameter',
  ]),
  // `if`/`elsif`/`for`/`while`/`when`/`rescue`/`conditional` (ternary) are
  // all literal node types in this grammar (not *_statement-suffixed).
  // `case`'s `else` arm is a distinct sibling clause, not a `when` node, so
  // no branchArmDefaultTypes entry is needed. `&&`/`||` fold into the generic
  // `binary` node with an `operator` field; Ruby's word-form `and`/`or` are
  // lower-precedence but share the same `binary` shape and `operator` field
  // text, so they are covered by the same token set without a separate case.
  branchNodeTypes: new Set(['if', 'elsif', 'for', 'while', 'when', 'rescue', 'conditional']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||', 'and', 'or']),
});

// Last `constant` child of a `constant` or `scope_resolution` node:
// `A::B::C` -> `C`.
function _rubyConstLastName(node) {
  if (!node) return '';
  if (node.type === 'constant') return base._readText(node);
  if (node.type === 'scope_resolution') {
    const consts = (node.children || []).filter((c) => c.type === 'constant');
    if (consts.length) return base._readText(consts[consts.length - 1]);
  }
  return '';
}

// Handles the same-file-resolvable half of Ruby superclass/mixin
// disposition: `class Dog < Animal` puts the base class in the `superclass`
// field (a `<` token followed by a `constant` or `scope_resolution`), producing
// an EXTENDS edge. Same-file only: resolves when the base name is already
// registered in `ctx.classByName` — cross-file/external bases never resolve,
// same "refuse to guess" limitation csharp.js/php.js document for their own
// EXTENDS/IMPLEMENTS ports. `module` nodes have no `superclass` field, so
// this only ever fires for `class`. `include`/`extend`/`prepend` mixins are
// deliberately NOT handled here — see file header.
function _extraWalkRuby(node, source, ctx) {
  if (node.type !== 'class') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classIdx = ctx.classByName.get(_rubyConstLastName(nameNode) || base._readText(nameNode));
  if (classIdx === undefined) return;

  const supNode = node.childForFieldName('superclass');
  if (!supNode) return;
  let baseName = '';
  for (const sub of supNode.children || []) {
    if (sub.type === 'constant') { baseName = base._readText(sub); break; }
    if (sub.type === 'scope_resolution') { baseName = _rubyConstLastName(sub); break; }
  }
  if (!baseName) return;
  // Queue for branch-wide resolution instead of resolving same-file only: a Ruby
  // superclass is usually cross-file (`Application < Base`), a builtin
  // (`IndifferentHash < Hash`), or external (`Request < Rack::Request`) — the
  // same-file-only rung dropped every one of those (measured recall 32%).
  ctx.addUnresolvedInheritance(classIdx, baseName, 'EXTENDS');
}

// Ruby has no constant-declaration node — a constant is an `assignment` whose
// left side is a `constant` (`VERSION = "1.0"`, `HEADERS = {...}`). walkGeneric
// only models classes and methods, so these were never emitted; the route-2
// generic path produced ZERO Ruby constants (measured, and the whole reason
// koragraph lost the declaration plane on Ruby). Emitted in a post-walk pass.
function _resolveRubyConstants(root, result, filePath) {
  const seen = new Set();
  (function walk(node) {
    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      if (left && left.type === 'constant') {
        const name = base._readText(left);
        const line = left.startPosition.row + 1;
        const key = `${name}::${line}`;
        if (name && !seen.has(key)) {
          seen.add(key);
          result.nodes.push({
            node_type: 'CONSTANT', name, summary: name,
            start_line: line, end_line: node.endPosition.row + 1,
            confidence_tier: 'EXTRACTED', confidence: 1.0, _sourceFile: filePath,
          });
        }
      }
    }
    for (const child of node.children || []) walk(child);
  })(root);
}

// `attr_accessor`/`attr_reader`/`attr_writer`/`attr :sym, ...` declare instance
// attributes — the field plane of a Ruby class. They are plain method calls, so
// walkGeneric (classes + methods only) never emitted them; Ripper counts each
// symbol as a field, so a class of `attr_accessor`s scored zero fields without
// this pass. Emitted post-walk like constants.
const _RUBY_ATTR_METHODS = new Set(['attr_accessor', 'attr_reader', 'attr_writer', 'attr']);

function _resolveRubyAttributes(root, result, filePath) {
  const seen = new Set();
  (function walk(node) {
    if (node.type === 'call' && !node.childForFieldName('receiver')) {
      const methodNode = node.childForFieldName('method');
      const method = methodNode ? base._readText(methodNode) : '';
      if (_RUBY_ATTR_METHODS.has(method)) {
        const args = node.childForFieldName('arguments');
        for (const arg of (args ? args.namedChildren : []) || []) {
          if (arg.type !== 'simple_symbol') continue;
          const name = base._readText(arg).replace(/^:/, '');
          const line = arg.startPosition.row + 1;
          const key = `${name}::${line}`;
          if (!name || seen.has(key)) continue;
          seen.add(key);
          result.nodes.push({
            node_type: 'FIELD', name, summary: name,
            start_line: line, end_line: line,
            confidence_tier: 'EXTRACTED', confidence: 1.0, _sourceFile: filePath,
          });
        }
      }
    }
    for (const child of node.children || []) walk(child);
  })(root);
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
        _parser = await base.loadGrammar('ruby');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

// Bare `super`/`super()`/`super(args)` calls were a total silent drop for
// ruby.js. Two distinct shapes: (1) bare `super` (no parens) parses as its
// own `super` node TYPE, never wrapped in a `call` node at all — invisible
// to `CONFIG.callTypes` (which only matches `call`) from the start; (2)
// `super()`/`super(args)` DOES parse as a `call` node (method field -> a
// `super`-typed child), so it reaches `base.js#resolveCall` via the generic
// pass, but its callee text ("super") collides with
// `_LANGUAGE_BUILTIN_GLOBALS` (that set includes Python's `super` builtin)
// and gets silently suppressed — `resolveCall` returns null before any
// residue is ever recorded. Ruby's `super` is not a callable named "super"
// at all: it invokes the SAME-NAMED method in an ancestor class, so treating
// "super" as the calleeName would be wrong even if it weren't filtered —
// same-file resolution is refused (the ancestor definition is a different,
// cross-file resolution question) and every occurrence is deferred with the
// ENCLOSING method's own name as calleeName + `receiverName: 'super'`
// (mirrors the canonical 'self' marker convention base.js's own accessor
// branch and rust.js/objc.js's bespoke self-resolution already use).
// Enclosing method is found by innermost start/end-line containment rather
// than mirroring walkGeneric's own traversal order, so this stays correct
// regardless of any future reordering in the shared registration walk.
function _findEnclosingMethod(nodes, line) {
  let best;
  let bestSpan = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.node_type !== 'METHOD') continue;
    const endLine = n.end_line ?? n.start_line;
    if (line < n.start_line || line > endLine) continue;
    const span = endLine - n.start_line;
    if (span < bestSpan) { bestSpan = span; best = i; }
  }
  return best;
}

function _isSuperCallNode(node) {
  if (node.type === 'super') return true;
  if (node.type !== 'call') return false;
  const methodNode = node.childForFieldName('method');
  return !!methodNode && methodNode.type === 'super';
}

function _resolveRubySuperCalls(root, result) {
  const seen = new Set();
  (function walk(node) {
    if (_isSuperCallNode(node)) {
      const line = node.startPosition.row + 1;
      const methodIdx = _findEnclosingMethod(result.nodes, line);
      if (methodIdx !== undefined) {
        const key = `${methodIdx}::super::${line}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.unresolvedCalls.push({
            from: methodIdx, calleeName: result.nodes[methodIdx].name,
            line, receiverName: 'super',
          });
        }
      }
      if (node.type === 'super') return; // leaf-shaped, no call args to descend into
    }
    for (const child of node.children || []) walk(child);
  })(root);
}

// `require`/`require_relative`/`include`/`extend`/`prepend` are plain method calls, so the
// header's "Ruby registers no import construct" is true of the GRAMMAR and was wrongly taken as
// true of the language: sinatra + rack carry 534 requires and 98 mixins with nothing recording
// them. Resolved after walkGeneric rather than from extraWalkFn because that hook fires mid-walk,
// where a module included before its own `module Foo` line is not yet in classByName.
const _RUBY_MIXIN_METHODS = new Set(['include', 'extend', 'prepend']);

function _rubyStringArg(node) {
  const args = node.childForFieldName('arguments');
  for (const arg of (args ? args.namedChildren : node.namedChildren) || []) {
    if (arg.type !== 'string') continue;
    const content = (arg.namedChildren || []).find((c) => c.type === 'string_content');
    if (content) return base._readText(content);
  }
  return '';
}

function _rubyConstArgs(node) {
  const args = node.childForFieldName('arguments');
  const out = [];
  for (const arg of (args ? args.namedChildren : []) || []) {
    const name = _rubyConstLastName(arg);
    if (name) out.push(name);
  }
  return out;
}

function _enclosingClassIdx(node, classIdxByName) {
  for (let a = node.parent; a; a = a.parent) {
    if (a.type !== 'class' && a.type !== 'module') continue;
    const nameNode = a.childForFieldName('name');
    if (!nameNode) continue;
    const idx = classIdxByName.get(_rubyConstLastName(nameNode) || base._readText(nameNode));
    if (idx !== undefined) return idx;
  }
  return undefined;
}

function _resolveRubyDirectives(root, result) {
  const classIdxByName = new Map();
  result.nodes.forEach((n, i) => {
    if (n.node_type === 'CLASS' && !classIdxByName.has(n.name)) classIdxByName.set(n.name, i);
  });
  const seenImports = new Set();
  const seenEdges = new Set();
  const addImport = (name, line) => {
    if (!name || seenImports.has(name)) return;
    seenImports.add(name);
    result.importFacts.push({ name, module: name, alias: null, line });
  };
  (function walk(node) {
    if (node.type === 'call' && !node.childForFieldName('receiver')) {
      const methodNode = node.childForFieldName('method');
      const method = methodNode ? base._readText(methodNode) : '';
      const line = node.startPosition.row + 1;
      if (method === 'require' || method === 'require_relative') {
        addImport(_rubyStringArg(node), line);
      } else if (_RUBY_MIXIN_METHODS.has(method)) {
        const ownerIdx = _enclosingClassIdx(node, classIdxByName);
        for (const name of _rubyConstArgs(node)) {
          const targetIdx = classIdxByName.get(name);
          // EMBEDS, not EXTENDS: a mixin grafts another type's members in without subclassing,
          // which is exactly the distinction go.js already draws for struct embedding.
          if (ownerIdx !== undefined && targetIdx !== undefined && targetIdx !== ownerIdx) {
            const key = `${ownerIdx}->${targetIdx}`;
            if (seenEdges.has(key)) continue;
            seenEdges.add(key);
            result.edges.push({ from: ownerIdx, to: targetIdx, edge_type: 'EMBEDS', resolution: 'same_file', evidence_line: line });
          } else if (targetIdx === undefined && ownerIdx !== undefined) {
            // A cross-file mixin (`include Foo` where Foo is declared in another file) is the same
            // "gains another type's members" relation as the same-file case above — an EMBEDS edge,
            // resolved branch-wide by name — not a require-style import. `include`/`extend` are not
            // `require`, so recording them as imports both misreports the import plane and never
            // matches a real import target; branch-wide EMBEDS is the honest home for them.
            result.unresolvedInheritance.push({ fromIndex: ownerIdx, toName: name, edge_type: 'EMBEDS' });
          }
        }
      }
    }
    for (const child of node.children || []) walk(child);
  })(root);
}

function extract(tree, content, filePath) {
  const result = base.walkGeneric(tree, content, CONFIG);
  _resolveRubySuperCalls(tree.rootNode, result);
  _resolveRubyDirectives(tree.rootNode, result);
  _resolveRubyConstants(tree.rootNode, result, filePath);
  _resolveRubyAttributes(tree.rootNode, result, filePath);
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
