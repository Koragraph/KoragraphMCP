'use strict';

// Python has no bespoke extractor module — `extract_python` runs the shared
// `_extract_generic` core. This file supplies only Python's own pieces:
// `_PYTHON_CONFIG` as a base.js `LanguageConfig`, the import handler
// `_import_python`, and same-file inheritance edges (the one
// `tree_sitter_python` site whose output fits the closed EDGE_TYPES
// vocabulary).
//
// Behavioural notes:
//   - Only the inheritance site is ported. Other `tree_sitter_python` sites
//     (parameter/return type-ref collection, decorator edges, indirect
//     callback references, module-level dispatch tables) feed `references`
//     edges whose contexts fall outside this codebase's closed EDGE_TYPES
//     vocabulary (extractors/base.js) — the same reasoning java.js documents
//     for `_java_extra_walk`'s annotation edges.
//   - Method calls through `self`/`cls` (`self.helper()`) do NOT resolve to a
//     CALLS edge: base.js's accessor branch (`callAccessorNodeTypes`) only
//     resolves a non-bare call when the receiver is a same-file import alias
//     ("refuse to guess" on any other accessor, per its own comment) — the
//     same choice java.js documents for `method_invocation`'s `object` field.
//     Only bare-name calls (`helper()`, not `self.helper()`) resolve via
//     `methodByName`. Receiver-aware resolution is where `self.`-qualified
//     same-file calls belong, not here.
//   - Inheritance (EXTENDS) resolves same-file only, and only when the base
//     class is registered in `classByName` by the time the subclass's
//     `class_definition` node is visited — i.e. the base class must appear
//     earlier in the file's pre-order traversal (the overwhelmingly common
//     case: `class Base: ...` before `class Foo(Base): ...`). walkGeneric's
//     `extraWalkFn` hook runs inline during the single forward walk, with no
//     second pass over classes the way call resolution gets one over
//     function bodies — a same-file base class declared textually AFTER its
//     subclass will not resolve. Cross-file bases never resolve (out of
//     scope; base.js's contract only lets an edge point at a node index
//     already in this file's own `nodes` array).

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set(['class_definition']),
  functionTypes: new Set(['function_definition']),
  importTypes: new Set(['import_statement', 'import_from_statement']),
  callTypes: new Set(['call']),
  callFunctionField: 'function',
  callAccessorNodeTypes: new Set(['attribute']),
  callAccessorField: 'attribute',
  callAccessorObjectField: 'object',
  // `self.x()` is convention, not a grammar keyword, but the
  // receiver-identifier text is what resolveCall reads regardless.
  // `super().x()`'s receiver is a call node, not a plain identifier, and is
  // out of scope.
  selfTokens: new Set(['self']),
  functionBoundaryTypes: new Set(['function_definition']),
  importHandler: _importPython,
  extraWalkFn: _extraWalkPython,
  // tree-sitter-python's function_definition `parameters` field covers
  // identifier/default_parameter/typed_parameter/typed_default_parameter/
  // list_splat_pattern/dictionary_splat_pattern. `async` is a literal child
  // (own type AND text 'async') when present. Decorators are children of the
  // PARENT decorated_definition node, siblings before this function_definition.
  paramEntryTypes: new Set([
    'identifier', 'default_parameter', 'typed_parameter',
    'typed_default_parameter', 'list_splat_pattern', 'dictionary_splat_pattern',
  ]),
  asyncMarkerText: 'async',
  decoratorNodeTypes: new Set(['decorator']),
  decoratorParentWrapTypes: new Set(['decorated_definition']),
  // Includes elif_clause (omitting it undercounts elif chains). case_clause is
  // python's match-statement arm (PEP 634).
  branchNodeTypes: new Set(['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'case_clause', 'except_clause', 'conditional_expression', 'boolean_operator']),
});

// Import handler in base.js's importHandler shape
// (returns [{name, alias?, module?}] instead of appending edges directly).
// web-tree-sitter mints a fresh JS wrapper object on every
// `.children`/`childForFieldName` access, so comparing two accesses of the
// "same" node with `===` is always false — node identity must be compared via
// the stable `.id` property instead.
//
// `module` is the dotted module path the symbol-index resolver keys on —
// `name` for a plain `import_statement` entry IS the dotted module
// (`import pkg.security`), so `module: name`; for an
// `import_from_statement` entry every symbol shares the statement's own
// `module_name` node (`from pkg.security import safe_fetch` -> module
// "pkg.security" for the `safe_fetch` entry).
function _importPython(node, source, ctx) {
  const t = node.type;
  const out = [];
  const moduleNameNode = node.childForFieldName('module_name');
  const moduleNameNodeId = moduleNameNode ? moduleNameNode.id : undefined;
  const moduleText = moduleNameNode ? base._readText(moduleNameNode) : undefined;

  if (t === 'import_statement') {
    for (const child of node.children || []) {
      if (child.type === 'dotted_name') {
        const name = base._readText(child);
        out.push({ name, module: name });
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        if (nameNode) {
          const name = base._readText(nameNode);
          out.push({
            name,
            alias: aliasNode ? base._readText(aliasNode) : undefined,
            module: name,
          });
        }
      }
    }
  } else if (t === 'import_from_statement') {
    for (const child of node.children || []) {
      if (child.type === 'dotted_name') {
        if (moduleNameNodeId !== undefined && child.id === moduleNameNodeId) continue; // the module itself, not an imported symbol
        out.push({ name: base._readText(child), module: moduleText });
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        if (nameNode) {
          out.push({
            name: base._readText(nameNode),
            alias: aliasNode ? base._readText(aliasNode) : undefined,
            module: moduleText,
          });
        }
      } else if (child.type === 'wildcard_import') {
        if (moduleNameNode) out.push({ name: moduleText, module: moduleText });
      }
    }
  }
  return out;
}

// Same-file inheritance branch: each identifier in a class's `superclasses`
// argument_list that names an already-registered same-file class becomes an
// EXTENDS edge. Non-identifier bases (e.g. `pkg.Base` attribute expressions)
// are skipped via an `arg.type == "identifier"` guard — EXCEPT the
// `metaclass=Y` keyword argument, which is not a base class at all and is
// handled separately below.
/**
 * Module-level `Name = factory(Base)` — a class defined by a call rather than a `class` statement.
 *
 * django-machina builds every concrete model this way (`Forum = model_factory(AbstractForum)`), and
 * the pattern is common wherever a library hands out a configured base. Before this, such a module
 * produced a FILE node and nothing else: no `Forum` node, and therefore no link from the concrete
 * model to the abstract class where its fields are actually declared. Measured on machina's
 * `apps/forum/models.py` — 1 node, a FILE node.
 *
 * That is the worst possible gap for a code graph to have, because it is exactly the edge lexical
 * search cannot supply either: a call site reads `Topic.objects.filter(...)` and contains no token
 * linking it to `AbstractTopic`. `grep -rn AbstractTopic` finds the abstract module and the factory
 * line, never the call sites.
 *
 * The base is almost always imported from another module, so resolution cannot happen here —
 * `addUnresolvedInheritance` queues it by name for branch-wide resolution at the INFERRED tier,
 * the same route a supertype an `extraWalkFn` cannot see already takes.
 *
 * Deliberately conservative: only a bare `identifier` argument whose name looks like a type
 * (initial capital) is treated as a base. A keyword argument, a literal, or a lowercase name is
 * ignored rather than guessed at, mirroring this file's "refuse to guess" stance elsewhere.
 */
function _factoryAssignedClass(node, ctx) {
  if (node.type !== 'assignment') return;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;
  if (left.type !== 'identifier' || right.type !== 'call') return;

  const name = base._readText(left);
  // A `class Name:` elsewhere in the file wins — never shadow a real declaration.
  if (!name || !/^[A-Z]/.test(name) || ctx.classByName.has(name)) return;

  const args = right.childForFieldName('arguments');
  if (!args) return;
  const bases = [];
  for (const arg of args.children || []) {
    if (arg.type !== 'identifier') continue;
    const argName = base._readText(arg);
    if (argName && /^[A-Z]/.test(argName)) bases.push(argName);
  }
  if (!bases.length) return;

  const fnNode = right.childForFieldName('function');
  const idx = ctx.addNode({
    node_type: 'CLASS',
    name,
    summary: `${name} (constructed by ${fnNode ? base._readText(fnNode) : 'a factory call'})`,
    start_line: ctx.line(node),
    end_line: ctx.line(node),
    // Not EXTRACTED: this is a class by convention, inferred from an assignment shape, not a
    // declaration the grammar names as one.
    confidence_tier: 'INFERRED',
    confidence: 0.9,
  });
  ctx.classByName.set(name, idx);
  for (const b of bases) ctx.addUnresolvedInheritance(idx, b, 'EXTENDS');
}

function _extraWalkPython(node, source, ctx) {
  _factoryAssignedClass(node, ctx);
  if (node.type !== 'class_definition') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classIdx = ctx.classByName.get(base._readText(nameNode));
  if (classIdx === undefined) return;

  const supers = node.childForFieldName('superclasses');
  if (!supers) return;
  for (const child of supers.children || []) {
    if (child.type === 'keyword_argument') {
      // `metaclass=Y` — the walk-time evidence only covers same-file
      // resolution (EXTENDS's own limitation above applies identically: Y must
      // already be registered by the time this class is visited). Cross-file/
      // import resolution needs the branch-wide file-scoped index that only
      // exists post-write, so this always records the raw name as payload
      // (`properties.metaclass`) and leaves resolution — same-file included,
      // for uniformity — to ingest.js#resolveMetaclassEdges (mirrors
      // DECORATED_BY: extractor records evidence only, one post-tail pass does
      // all the resolving).
      const nameField = child.childForFieldName('name');
      const valueField = child.childForFieldName('value');
      if (nameField && base._readText(nameField) === 'metaclass' && valueField && valueField.type === 'identifier') {
        const target = ctx.nodes[classIdx];
        if (target && !target.metaclass) target.metaclass = base._readText(valueField);
      }
      continue;
    }
    if (child.type !== 'identifier') continue;
    const baseName = base._readText(child);
    const baseIdx = ctx.classByName.get(baseName);
    if (baseIdx === undefined || baseIdx === classIdx) continue;
    ctx.addEdge(classIdx, baseIdx, 'EXTENDS', 'same_file', ctx.line(node));
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
        _parser = await base.loadGrammar('python');
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
