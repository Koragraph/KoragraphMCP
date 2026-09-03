'use strict';

// The closed CLASS/METHOD/IMPORT node_type + traversal-vocabulary edge_type
// contract defined in extractors/base.js maps a richer relation set down onto
// that closed set:
//   contains    -> dropped (file scoping is the DB row's file_id, not an edge)
//   inherits    -> EXTENDS (superclass, same-file only)
//   implements  -> IMPLEMENTS (adopted protocol, same-file only)
//   method      -> DEFINED_IN (method -> owning interface/implementation/
//                   protocol, same_file)
//   references  -> COUPLED_WITH, via the newly shared base._semanticReferenceEdge
//                   (property field types, [Foo alloc] receiver typing),
//                   same-file only
//   calls/accesses -> CALLS, same_file
//   imports     -> IMPORTS (IMPORT nodes + an edge, not a dangling
//                   FILE-node edge — same "imports are nodes for us" convention
//                   every other ported Tier 1/2 language here documents)
//
// Two shared helpers are provided by base.js:
//   _cpp_declarator_name    -> base._cppDeclaratorName
//   _semantic_reference_edge -> base._semanticReferenceEdge
// A third helper, `_resolve_c_include_path`, is explicitly NOT used: it
// resolves a quoted #import against the other files in a repo, and
// `resolution/**` is outside this file's scope. A quoted #import's target is
// taken as its bare stem instead — identical to how this extractor already
// treats an unresolvable system_lib_string include.
//
// Cross-file pieces NOT ported (single-file extraction scope, same as every
// other Tier 1 language here):
//   - `ensure_named_node`'s SOURCELESS stub nodes for a name not defined in
//     this file (e.g. a `Thing` type imported from elsewhere) — dropped
//     rather than guessed.
//   - the cross-file objc_type_table / raw_calls consumer — this
//     port's own local-var type table (`objcTypeTable` below) is used only
//     to resolve same-file message sends, never exported for a corpus-level
//     resolver this codebase's branch-scoped ingest.js does not have.

const base = require('./base');

// Cyclomatic complexity. This grammar reuses the C family's
// node shapes (case_statement wraps both `case`/`default`, distinguished by
// a `default` child; @try/@catch parses as try_statement/catch_clause).
const _OBJC_COMPLEXITY_CONFIG = {
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'case_statement', 'conditional_expression', 'catch_clause']),
  branchArmDefaultTypes: new Set(['case_statement']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
};

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
        _parser = await base.loadGrammar('objc');
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

// An ObjC method's name is its SELECTOR — `setImage:forState:`, not `setImage`
// and not the colon-less `setImageforState:` this file used to build. The
// selector is what `@selector()` contains, what the runtime dispatches on, and
// what tells `imageWithData:scale:` apart from `imageWithData:options:`; joining
// the keywords without their colons collapses distinct methods onto one name.
// A keyword segment is one whose identifier is followed by a `method_parameter`.
function _declaredSelector(node) {
  const kids = node.children || [];
  let sel = '';
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type !== 'identifier') continue;
    const keyworded = kids[i + 1] && kids[i + 1].type === 'method_parameter';
    sel += base._readText(kids[i]) + (keyworded ? ':' : '');
  }
  return sel;
}

// The send side of the same selector: `[obj setA:1 b:2]` marks each keyword with
// a literal ':' token right after the `method`-field identifier.
function _sentSelector(node) {
  let sel = '';
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) !== 'method') continue;
    const next = node.child(i + 1);
    sel += base._readText(node.child(i)) + (next && next.type === ':' ? ':' : '');
  }
  return sel;
}

// A pointer return type wraps the function_declarator one or more levels deep
// (`static NSString *foo(int)`); base._cppDeclaratorName stops at the plain
// identifier and cannot reach the parameter list, which this needs too.
function _functionDeclarator(node) {
  for (let d = node, i = 0; d && i < 6; i++) {
    if (d.type === 'function_declarator') return d;
    d = d.childForFieldName('declarator');
  }
  return null;
}

// `@selector(setA:b:)` carries no identifier children at all for the keyworded
// form — the selector only exists as source text.
function _literalSelector(node) {
  const m = /@selector\s*\(([^)]*)\)/.exec(base._readText(node));
  return m ? m[1].replace(/\s+/g, '') : '';
}

// Mirrors objc.py's own preprocessing step: tree-sitter-objc
// cannot expand these argument-less annotation macros (no trailing ';'), and
// their presence before @interface makes the parser fail to emit a
// class_interface node. Blanked to equal-length spaces so byte offsets/line
// numbers are preserved and the interface still parses.
const _OBJC_BLANK_MACROS = ['NS_ASSUME_NONNULL_BEGIN', 'NS_ASSUME_NONNULL_END'];
function _blankAnnotationMacros(content) {
  let out = content;
  for (const macro of _OBJC_BLANK_MACROS) {
    out = out.split(macro).join(' '.repeat(macro.length));
  }
  return out;
}

// Mirrors objc.py's `_type_identifiers`: yields every type_identifier under a
// property's type node, descending through generic_specifier/type_name so
// NSArray<Product *> yields both NSArray and the element type Product.
function _typeIdentifiers(node, out) {
  if (node.type === 'type_identifier') {
    out.push(node);
    return;
  }
  for (const c of node.children || []) _typeIdentifiers(c, out);
}

// Mirrors objc.py's `_objc_local_var_types`: collects `var -> ClassName` from
// ObjC local declarations (`Foo *f = ...;`) in a method body, for receiver
// typing during same-file message-send resolution below. Only a capitalized
// `type_identifier` with a single named declarator is recorded; a built-in/
// lower-cased type or an un-nameable declarator is skipped (precision over
// recall). Uses the ported base._cppDeclaratorName to unwrap the declarator
// (objc's grammar extends the C declarator grammar, identical to C++'s).
function _collectLocalVarTypes(bodyNode, table) {
  const stack = [bodyNode];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'method_definition' && n !== bodyNode) continue;
    if (n.type === 'declaration') {
      let typeNode = n.childForFieldName('type');
      if (!typeNode) {
        typeNode = (n.children || []).find((c) => c.type === 'type_identifier');
      }
      if (typeNode && typeNode.type === 'type_identifier') {
        const typeName = base._readText(typeNode).trim();
        const declarators = (n.children || []).filter((c) =>
          c.type === 'identifier' || c.type === 'pointer_declarator' || c.type === 'init_declarator');
        if (typeName && /^[A-Z]/.test(typeName) && declarators.length === 1) {
          const varName = base._cppDeclaratorName(declarators[0]);
          if (varName && !table.has(varName)) table.set(varName, typeName);
        }
      }
    }
    for (const c of n.children || []) stack.push(c);
  }
}

function extract(tree, content, filePath) {
  const root = tree.rootNode;
  const nodes = [];
  const edges = [];

  const classByName = new Map();          // interface/implementation/protocol/category name -> nodeIndex
  const methodsByContainer = new Map();    // containerIdx -> Map(selectorName -> methodIdx)
  const methodByName = new Map();          // flat, first-wins same-file fallback (the go.js/zig.js/java.js convention)
  const methodEntries = [];                // { idx, name, containerIdx } — for @selector's uniqueness check
  const importByName = new Map();          // name -> import fact
  const importFacts = [];                  // flat list threaded to the FILE node's properties.imports
  const methodBodies = [];                 // { nodeIndex, containerIdx, body }
  const pendingExtends = [];               // { ownerIdx, superName, line }
  const pendingImplements = [];            // { ownerIdx, protoName, line }
  const pendingFieldRefs = [];             // { ownerIdx, typeName, line }
  const objcTypeTable = new Map();         // local var name -> ClassName, same-file use only

  function addNode(n) {
    nodes.push(n);
    return nodes.length - 1;
  }

  function registerImport(name, line) {
    if (!name || importByName.has(name)) return;
    const fact = { name, alias: null, module: name, line: line ?? null };
    importFacts.push(fact);
    importByName.set(name, fact);
  }

  // A category interface/implementation (`@interface Foo (Bar)`) reuses
  // Foo's own CLASS node — same lookup-by-name-before-create pattern
  // class_implementation already needs against class_interface, generalised.
  function registerClass(name, line, endLine, summary) {
    let idx = classByName.get(name);
    if (idx === undefined) {
      idx = addNode({
        node_type: 'CLASS', name, summary,
        start_line: line, end_line: endLine,
        confidence_tier: 'EXTRACTED', confidence: 1.0,
      });
      classByName.set(name, idx);
      methodsByContainer.set(idx, new Map());
    } else {
      nodes[idx].end_line = Math.max(nodes[idx].end_line ?? nodes[idx].start_line, endLine);
    }
    return idx;
  }

  function registerMethod(name, line, endLine, containerIdx, prefix, args, bodyNode) {
    const idx = addNode({
      node_type: 'METHOD', name,
      summary: `${prefix}${name}`,
      start_line: line, end_line: endLine,
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      args: args || [],
      cyclomatic_complexity: base.computeCyclomatic(bodyNode, _OBJC_COMPLEXITY_CONFIG),
    });
    if (containerIdx !== undefined) {
      edges.push({ from: idx, to: containerIdx, edge_type: 'DEFINED_IN', resolution: 'same_file', evidence_line: line });
      const m = methodsByContainer.get(containerIdx);
      if (m && !m.has(name)) m.set(name, idx);
    }
    if (!methodByName.has(name)) methodByName.set(name, idx);
    methodEntries.push({ idx, name, containerIdx });
    return idx;
  }

  // ─── First pass: interfaces, implementations, protocols, methods, imports ──
  function walk(node, parentIdx) {
    const t = node.type;

    if (t === 'preproc_include') {
      // #import <Foundation/Foundation.h> or #import "MyClass.h"
      for (const child of node.children || []) {
        if (child.type === 'system_lib_string') {
          const raw = base._readText(child).replace(/^<|>$/g, '');
          const module = raw.split('/').pop().replace(/\.h$/, '');
          registerImport(module, _line(node));
        } else if (child.type === 'string_literal') {
          for (const sub of child.children || []) {
            if (sub.type === 'string_content') {
              // `_resolve_c_include_path` (resolution/** territory) is out of
              // this plan's Owns — take the bare stem, same as a system
              // include one branch above.
              const raw = base._readText(sub);
              const module = raw.split('/').pop().replace(/\.h$/, '');
              registerImport(module, _line(node));
            }
          }
        }
      }
      return;
    }

    if (t === 'module_import') {
      // @import Foundation;  /  @import Foundation.NSString;
      const pathNode = node.childForFieldName('path');
      if (pathNode) {
        const module = base._readText(pathNode).split('.')[0].trim();
        registerImport(module, _line(node));
      }
      return;
    }

    if (t === 'class_interface') {
      // @interface ClassName : SuperClass <Protocols>  OR  @interface ClassName (Category)
      const identifiers = (node.children || []).filter((c) => c.type === 'identifier');
      if (!identifiers.length) {
        for (const child of node.children || []) walk(child, parentIdx);
        return;
      }
      const name = base._readText(identifiers[0]);
      const line = _line(node);
      const idx = registerClass(name, line, _endLine(node), `interface ${name}`);

      const superNode = node.childForFieldName('superclass');
      if (superNode) {
        pendingExtends.push({ ownerIdx: idx, superName: base._readText(superNode), line });
      }
      for (const child of node.children || []) {
        if (child.type === 'parameterized_arguments') {
          for (const sub of child.children || []) {
            if (sub.type === 'type_name') {
              for (const s of sub.children || []) {
                if (s.type === 'type_identifier') {
                  pendingImplements.push({ ownerIdx: idx, protoName: base._readText(s), line });
                }
              }
            }
          }
        } else if (child.type === 'property_declaration') {
          const propLine = _line(child);
          for (const sub of child.children || []) {
            if (sub.type !== 'struct_declaration') continue;
            const seenTypes = new Set();
            for (const s of sub.children || []) {
              if (s.type === 'struct_declarator' || s.type === ';') continue;
              const typeIds = [];
              _typeIdentifiers(s, typeIds);
              for (const ti of typeIds) {
                const tname = base._readText(ti);
                if (seenTypes.has(tname)) continue;
                seenTypes.add(tname);
                pendingFieldRefs.push({ ownerIdx: idx, typeName: tname, line: propLine });
              }
            }
          }
        } else if (child.type === 'method_declaration') {
          walk(child, idx);
        }
      }
      return;
    }

    if (t === 'class_implementation') {
      // @implementation ClassName  OR  @implementation ClassName (Category)
      const nameNode = (node.children || []).find((c) => c.type === 'identifier');
      if (!nameNode) {
        for (const child of node.children || []) walk(child, parentIdx);
        return;
      }
      const name = base._readText(nameNode);
      const line = _line(node);
      const idx = registerClass(name, line, _endLine(node), `implementation ${name}`);
      for (const child of node.children || []) {
        if (child.type === 'implementation_definition') {
          for (const sub of child.children || []) walk(sub, idx);
        }
      }
      return;
    }

    if (t === 'protocol_declaration') {
      const nameNode = (node.children || []).find((c) => c.type === 'identifier');
      if (!nameNode) return;
      const name = base._readText(nameNode);
      const line = _line(node);
      const idx = registerClass(name, line, _endLine(node), `protocol ${name}`);
      for (const child of node.children || []) {
        if (child.type === 'protocol_reference_list') {
          for (const sub of child.children || []) {
            if (sub.type === 'identifier') {
              const baseName = base._readText(sub);
              if (baseName !== name) pendingImplements.push({ ownerIdx: idx, protoName: baseName, line });
            }
          }
        } else if (child.type === 'method_declaration') {
          walk(child, idx);
        }
      }
      return;
    }

    if (t === 'method_declaration' || t === 'method_definition') {
      // Class methods start with '+', instance methods with '-'. The
      // selector is the concatenation of the direct identifier children: one
      // for a simple selector (-go), several for a compound one
      // (-tableView:numberOfRowsInSection:); a method_parameter's own
      // identifier children (arg type/name) are nested, not direct children
      // of this node, so this filter never picks them up.
      let prefix = '-';
      for (const child of node.children || []) {
        if (child.type === '+' || child.type === '-') { prefix = child.type; break; }
      }
      const name = _declaredSelector(node);
      if (!name) return;
      // args-only for the bespoke extractors. Each keyword-selector segment's argument is its own
      // `method_parameter` sibling (`-tableView:(id)a numberOfRows:(int)b`);
      // its LAST direct `identifier` child is the arg name (the type,
      // `(id)`/`(int)`, nests type_identifier — a different node type — not
      // 'identifier', so a plain type-filter on direct children is safe).
      const args = (node.children || [])
        .filter((c) => c.type === 'method_parameter')
        .map((mp) => {
          const idents = (mp.children || []).filter((c) => c.type === 'identifier');
          return idents.length ? base._readText(idents[idents.length - 1]) : null;
        })
        .filter(Boolean);
      const body = t === 'method_definition'
        ? (node.children || []).find((c) => c.type === 'compound_statement')
        : null;
      const idx = registerMethod(name, _line(node), _endLine(node), parentIdx, prefix, args, body);
      if (body) methodBodies.push({ nodeIndex: idx, containerIdx: parentIdx, body });
      return;
    }

    // A .m file is still a C translation unit: ObjC codebases put helpers and
    // C-callable entry points at file scope, and objc.py never modelled them.
    if (t === 'function_definition') {
      const declarator = _functionDeclarator(node.childForFieldName('declarator'));
      const nameNode = declarator ? declarator.childForFieldName('declarator') : null;
      const name = nameNode && nameNode.type === 'identifier' ? base._readText(nameNode) : null;
      if (!name) return;
      const paramsNode = declarator ? declarator.childForFieldName('parameters') : null;
      const args = base.extractArgs(paramsNode, new Set(['parameter_declaration']));
      const body = (node.children || []).find((c) => c.type === 'compound_statement');
      const idx = registerMethod(name, _line(node), _endLine(node), undefined, '', args, body);
      if (body) methodBodies.push({ nodeIndex: idx, containerIdx: undefined, body });
      return;
    }

    for (const child of node.children || []) walk(child, parentIdx);
  }
  walk(root, undefined);

  // ─── EXTENDS: superclass declared in this file ─────────────────────────────
  for (const pe of pendingExtends) {
    const targetIdx = classByName.get(pe.superName);
    if (targetIdx !== undefined && targetIdx !== pe.ownerIdx) {
      edges.push({ from: pe.ownerIdx, to: targetIdx, edge_type: 'EXTENDS', resolution: 'same_file', evidence_line: pe.line });
    }
  }

  // ─── IMPLEMENTS: adopted protocol declared in this file ────────────────────
  for (const pi of pendingImplements) {
    const targetIdx = classByName.get(pi.protoName);
    if (targetIdx !== undefined && targetIdx !== pi.ownerIdx) {
      edges.push({ from: pi.ownerIdx, to: targetIdx, edge_type: 'IMPLEMENTS', resolution: 'same_file', evidence_line: pi.line });
    }
  }

  // ─── COUPLED_WITH: property field type declared in this file ──────────────
  // Uses the ported base._semanticReferenceEdge (Track 3's shared helper).
  for (const fr of pendingFieldRefs) {
    const targetIdx = classByName.get(fr.typeName);
    if (targetIdx !== undefined && targetIdx !== fr.ownerIdx) {
      edges.push(base._semanticReferenceEdge(fr.ownerIdx, targetIdx, 'same_file', fr.line));
    }
  }

  // importFacts, collected above via registerImport, carries the imports to
  // the FILE node's properties.imports.

  // ─── Second pass: resolve calls/references inside method bodies ───────────
  for (const { body } of methodBodies) _collectLocalVarTypes(body, objcTypeTable);

  const seenPairs = new Set();
  // This file already resolved
  // self/super message sends and self.field dot-sugar against the caller's
  // OWN container (methodsByContainer) — genuine same-class proof, tier
  // 1 — but stamped every hit 'same_file' (tier 2) like a flat-table guess,
  // and every miss (ambiguous send, untyped receiver, unmatched @selector)
  // vanished with no residue at all, unlike base.js's config-driven accessor
  // branch. `addCallEdge` now takes an explicit resolution so
  // self/super hits can be labelled `this_receiver`; every miss below pushes
  // an `unresolvedCalls` entry instead of silently dropping.
  const unresolvedCalls = [];
  const seenDeferred = new Set();
  function addCallEdge(fromIdx, toIdx, line, resolution) {
    if (fromIdx === toIdx) return;
    const key = `${fromIdx}->${toIdx}::${resolution || 'same_file'}`;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    edges.push({ from: fromIdx, to: toIdx, edge_type: 'CALLS', resolution: resolution || 'same_file', evidence_line: line });
  }
  function pushUnresolved(callerIdx, calleeName, line, receiverName) {
    const dkey = `${callerIdx}::${receiverName || ''}::${calleeName}`;
    if (seenDeferred.has(dkey)) return;
    seenDeferred.add(dkey);
    const marker = { from: callerIdx, calleeName, line };
    if (receiverName) marker.receiverName = receiverName;
    unresolvedCalls.push(marker);
  }

  function walkCalls(node, callerIdx, containerIdx) {
    const t = node.type;

    if (t === 'message_expression') {
      const recv = node.childForFieldName('receiver');
      const meth = node.childForFieldName('method');
      const line = _line(node);

      // `[[Foo alloc] init]` / `[Foo alloc]`: resolve the allocated class
      // name if it is defined in this file and emit a COUPLED_WITH
      // reference edge — the allocating method links to the allocated type.
      if (meth && meth.type === 'identifier' && base._readText(meth) === 'alloc' &&
          recv && recv.type === 'identifier') {
        const targetIdx = classByName.get(base._readText(recv));
        if (targetIdx !== undefined && targetIdx !== callerIdx) {
          edges.push(base._semanticReferenceEdge(callerIdx, targetIdx, 'same_file', line));
        }
      }

      const selName = _sentSelector(node);
      if (selName) {
        let targetIdx;
        let isSelfReceiver = false;
        const recvName = (recv && recv.type === 'identifier') ? base._readText(recv) : undefined;
        if (recvName === 'self' || recvName === 'super') {
          isSelfReceiver = true;
          const m = containerIdx !== undefined ? methodsByContainer.get(containerIdx) : undefined;
          if (m && m.has(selName)) targetIdx = m.get(selName);
        } else if (recvName !== undefined && objcTypeTable.has(recvName)) {
          const clsIdx = classByName.get(objcTypeTable.get(recvName));
          const m = clsIdx !== undefined ? methodsByContainer.get(clsIdx) : undefined;
          if (m && m.has(selName)) targetIdx = m.get(selName);
        }
        // No same-file evidence for the receiver (an untyped local, a
        // parameter, a nested message send) — fall back to the flat
        // same-file selector table, the same bare-name resolution every
        // other ported language in this codebase falls back to.
        if (targetIdx === undefined && !isSelfReceiver && methodByName.has(selName)) targetIdx = methodByName.get(selName);
        if (targetIdx !== undefined) {
          addCallEdge(callerIdx, targetIdx, line, isSelfReceiver ? 'this_receiver' : 'same_file');
        } else {
          // Miss: self/super whose target isn't in THIS container (inherited
          // from a superclass), or any other unresolved receiver —
          // canonicalised to 'self' for the self/super case (base.js's own
          // accessor-branch convention), literal receiver text otherwise.
          pushUnresolved(callerIdx, selName, line, isSelfReceiver ? 'self' : recvName);
        }
      }
    } else if (t === 'field_expression') {
      // self.name / self.product.name — dot-syntax sugar for [self name].
      // Resolve to a sibling method of the SAME container by exact name —
      // genuine same-class proof, tier 1 (this_receiver), same as the
      // message_expression self/super branch above.
      const idNode = (node.children || []).find((c) => c.type === 'identifier');
      const fieldNode = (node.children || []).find((c) => c.type === 'field_identifier');
      const recvText = idNode ? base._readText(idNode) : undefined;
      if (fieldNode && (recvText === 'self' || recvText === 'super') && containerIdx !== undefined) {
        const m = methodsByContainer.get(containerIdx);
        const fname = base._readText(fieldNode);
        if (m && m.has(fname)) {
          addCallEdge(callerIdx, m.get(fname), _line(node), 'this_receiver');
        } else {
          pushUnresolved(callerIdx, fname, _line(node), 'self');
        }
      }
    } else if (t === 'selector_expression') {
      // @selector(doSomething:withParam:) — compile-time method ref. Match
      // EXACTLY against every registered method name and only wire the edge
      // when the match is unambiguous; zero or ambiguous matches leave residue
      // instead of vanishing — the deferred/ambiguous cases are still evidence a
      // call site exists, just refused rather than guessed.
      const selName = _literalSelector(node);
      if (selName) {
        const matches = methodEntries.filter((m) => m.name === selName && m.idx !== callerIdx);
        if (matches.length === 1) {
          addCallEdge(callerIdx, matches[0].idx, _line(node), 'same_file');
        } else {
          pushUnresolved(callerIdx, selName, _line(node));
        }
      }
    }

    for (const child of node.children || []) walkCalls(child, callerIdx, containerIdx);
  }
  for (const { nodeIndex, containerIdx, body } of methodBodies) walkCalls(body, nodeIndex, containerIdx);

  const result = { nodes, edges, unresolvedCalls, importFacts };
  base.validateOutput(result);
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  if (_parserState !== 'ready') {
    return { nodes: [], edges: [], unresolvedCalls: [], importFacts: [] };
  }
  const blanked = _blankAnnotationMacros(content);
  const tree = _parser.parse(blanked);
  return extract(tree, blanked, filePath);
}

async function ready() {
  await _ensureParserReady();
  return _parserState;
}

module.exports = { extract, extractFile, ready, CONFIG: null };
