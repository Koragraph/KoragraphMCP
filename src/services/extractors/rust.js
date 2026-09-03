'use strict';

// Maps a richer source relation set down onto koragraph's closed
// CLASS/METHOD/IMPORT node_type + traversal-vocabulary edge_type contract
// defined in extractors/base.js:
//   contains      -> dropped (file scoping is the DB row's file_id, not an edge)
//   method        -> DEFINED_IN (impl method -> owning struct/interface)
//   inherits      -> EXTENDS   (trait supertrait, first bound only)
//   implements    -> IMPLEMENTS (impl Trait for Type)
//   references    -> COUPLED_WITH (field/variant type reference, role "type"
//                     only — "generic_arg"-role refs are dropped, same
//                     reasoning python.js/typescript.js document for their own
//                     generic-argument references being outside EDGE_TYPES)
//   imports_from  -> IMPORTS (imports are nodes here, not edges)
//   calls         -> CALLS
// Package-wide cross-file resolution is explicitly out of scope — this
// extractor sees one file. A call/reference this file cannot evidence is
// dropped rather than guessed; cross-file/package import-evidence resolution
// is out of scope.
//
// Unlike extractors/go.js's callAccessor conservatism (only resolves a
// field_expression receiver that is an imported package alias), identifier,
// field_expression member calls, and scoped_identifier (`Type::method()`)
// calls are ALL resolved through the same flat same-file name table
// (methodByName, falling back to classByName) — it never disambiguates by
// receiver. This is a real, disclosed fidelity choice: it takes priority over
// the more conservative "refuse to guess a non-import receiver" policy
// elsewhere.

const base = require('./base');

// Cyclomatic complexity. Rust has no C-style ternary (its `if` is itself an
// expression, already counted via if_expression) and no exceptions (no
// catch). match_arm's wildcard `_` arm is counted like any other arm (no
// distinct "default" shape to exclude in this grammar).
// `function_item` is in the skip set: walkFunctions (below) recurses into
// EVERY child looking for nested fns, so a genuinely nested named function
// gets its own METHOD node and its own complexity count elsewhere in this
// same walk — not skipping it here would double-count its branches into the
// outer function's total.
const _RUST_COMPLEXITY_CONFIG = {
  branchNodeTypes: new Set(['if_expression', 'for_expression', 'while_expression', 'match_arm']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
  functionTypes: new Set(['function_item']),
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
        _parser = await base.loadGrammar('rust');
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

// Walks a Rust type expression, collecting {name, role} pairs — role is
// "generic_arg" inside a `<...>` type-argument list, else "type".
function _collectTypeRefs(node, generic, out) {
  if (!node) return;
  const t = node.type;
  if (t === 'primitive_type') return;
  if (t === 'type_identifier') {
    const text = base._readText(node);
    if (text) out.push({ name: text, role: generic ? 'generic_arg' : 'type' });
    return;
  }
  if (t === 'scoped_type_identifier') {
    const text = base._readText(node).split('::').pop();
    if (text) out.push({ name: text, role: generic ? 'generic_arg' : 'type' });
    return;
  }
  if (t === 'generic_type') {
    let nameNode = node.childForFieldName('type');
    if (!nameNode) {
      nameNode = (node.children || []).find(
        (c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier'
      );
    }
    if (nameNode) {
      const text = nameNode.type === 'scoped_type_identifier'
        ? base._readText(nameNode).split('::').pop()
        : base._readText(nameNode);
      if (text) out.push({ name: text, role: generic ? 'generic_arg' : 'type' });
    }
    for (const c of node.children || []) {
      if (c.type === 'type_arguments') {
        for (const arg of c.namedChildren || []) _collectTypeRefs(arg, true, out);
      }
    }
    return;
  }
  if (['reference_type', 'pointer_type', 'array_type', 'tuple_type', 'slice_type'].includes(t)) {
    for (const c of node.children || []) {
      if (c.isNamed) _collectTypeRefs(c, generic, out);
    }
    return;
  }
  if (node.isNamed) {
    for (const c of node.children || []) {
      if (c.isNamed) _collectTypeRefs(c, generic, out);
    }
  }
}

// An impl block's target, reduced to the bare type name: `ContentVisitor<'de>` -> ContentVisitor,
// `io::Read` -> Read. Anything that is not a named type — `impl Trait for &'a mut P`, for a
// primitive, for a tuple — returns null and registers no class, because inventing a node called
// `&'a mut P` is a phantom declaration, not a symbol anyone can resolve against.
function _implTypeName(node) {
  if (!node) return null;
  if (node.type === 'type_identifier') return base._readText(node);
  if (node.type === 'scoped_type_identifier') return base._readText(node).split('::').pop().trim();
  if (node.type === 'generic_type') {
    return _implTypeName(node.childForFieldName('type')
      || (node.children || []).find((c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier'));
  }
  return null;
}

const _TUPLE_FIELD_TYPES = new Set([
  'type_identifier', 'generic_type', 'scoped_type_identifier',
  'reference_type', 'primitive_type', 'tuple_type', 'array_type',
]);

function extract(tree, content, filePath) {
  const root = tree.rootNode;
  const nodes = [];
  const edges = [];
  // Supertrait/impl edges resolved by NAME across the whole branch (and, for a
  // std/prelude trait like `Debug`, minted as an external DEPENDENCY by
  // ingest.js's external_base_type rung). The old same-file-only rung dropped
  // essentially every one, because a Rust trait is almost always foreign.
  const unresolvedInheritance = []; // { from, toName, edge_type }

  const classByName = new Map();  // name -> nodeIndex (struct/enum/trait/impl, merged by name)
  const methodByName = new Map(); // name -> nodeIndex (bare, first-wins — same precedent as go.js)
  // per-impl method table, mirrors base.js's classMethods — needed to prove a
  // `self.method()` call targets a method of the CALLER'S OWN impl block
  // (tier 1, this_receiver), not just a same-named method anywhere in the
  // file (tier 2, same_file).
  const methodsByContainer = new Map(); // implIdx -> Map(name -> nodeIndex)
  const importByName = new Map(); // module_name -> import fact
  const importFacts = [];         // flat list threaded to the FILE node's properties.imports
  const methodBodies = [];        // { nodeIndex, body, containerIdx }
  const pendingSupertraits = [];  // { ownerIdx, refName, line } — trait X: Y (first bound only)
  const pendingImplements = [];   // { ownerIdx, refName, line } — impl Trait for Type
  const pendingFieldRefs = [];    // { ownerIdx, refName, line } — field/variant type refs, role "type" only

  function addNode(n) {
    nodes.push(n);
    return nodes.length - 1;
  }

  // Fixes the duplicate CLASS:S emission (`struct S {}` + `impl S {}` both
  // naming the same symbol): merges in place rather than pushing a second
  // node and relying on base.mergeSameFileDuplicates() to collapse indices
  // after the fact, which would require remapping every edge that already
  // references the earlier index. base.mergeSameFileDuplicates() is still
  // called defensively below before returning — it is a no-op here because
  // duplicates never reach `nodes`.
  // `extendOnly` is how an impl block declines to invent a type. `impl Serialize for String`
  // does not declare `String` — serde has 68 such blocks over std and foreign types (`Vec`,
  // `HashMap`, and once the bare generic parameter `T`), and registering each as a CLASS put 68
  // phantom declarations into the graph for a symbol that lives in another crate entirely.
  function registerOrExtendClass(name, line, endLine, kind, extendOnly) {
    if (classByName.has(name)) {
      const idx = classByName.get(name);
      const existing = nodes[idx];
      const constructs = Array.isArray(existing.properties && existing.properties.constructs)
        ? existing.properties.constructs
        : [existing.kind || existing.node_type];
      if (!constructs.includes(kind)) constructs.push(kind);
      existing.start_line = Math.min(existing.start_line, line);
      existing.end_line = Math.max(existing.end_line != null ? existing.end_line : existing.start_line, endLine != null ? endLine : line);
      existing.properties = { ...(existing.properties || {}), constructs };
      return idx;
    }
    if (extendOnly) return null;
    const idx = addNode({
      node_type: 'CLASS', name,
      summary: `${kind} ${name}`,
      start_line: line, end_line: endLine,
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      kind,
    });
    classByName.set(name, idx);
    return idx;
  }

  // ─── struct_item / union_item / enum_item / trait_item → CLASS ────────────
  function walkTypeDecls(node) {
    const t = node.type;

    if (t === 'struct_item' || t === 'union_item') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = base._readText(nameNode);
        const idx = registerOrExtendClass(name, _line(node), _endLine(node), t === 'union_item' ? 'union' : 'struct');
        for (const c of node.children || []) {
          if (c.type === 'field_declaration_list') {
            for (const field of c.children || []) {
              if (field.type !== 'field_declaration') continue;
              // A struct field is a real FIELD declaration, not only a type ref —
              // this was never emitted, so Rust field recall was 0.
              const fnNode = field.childForFieldName('name');
              if (fnNode) {
                const fidx = addNode({
                  node_type: 'FIELD', name: base._readText(fnNode), summary: base._readText(fnNode),
                  start_line: _line(field), end_line: _line(field),
                  confidence_tier: 'EXTRACTED', confidence: 1.0, _owner: name,
                });
                edges.push({ from: fidx, to: idx, edge_type: 'DEFINED_IN', resolution: 'same_file', evidence_line: _line(field) });
              }
              let typeNode = field.childForFieldName('type');
              if (!typeNode) {
                typeNode = (field.children || []).find((fc) => fc.type !== 'field_identifier' && fc.isNamed);
              }
              const refs = [];
              _collectTypeRefs(typeNode, false, refs);
              for (const ref of refs) {
                if (ref.role !== 'type' || ref.name === name) continue;
                pendingFieldRefs.push({ ownerIdx: idx, refName: ref.name, line: _line(field) });
              }
            }
          } else if (c.type === 'ordered_field_declaration_list') {
            const fline = _line(c);
            for (const tc of c.children || []) {
              if (!_TUPLE_FIELD_TYPES.has(tc.type)) continue;
              const refs = [];
              _collectTypeRefs(tc, false, refs);
              for (const ref of refs) {
                if (ref.role !== 'type' || ref.name === name) continue;
                pendingFieldRefs.push({ ownerIdx: idx, refName: ref.name, line: fline });
              }
            }
          }
        }
        return idx;
      }
      return null;
    }

    if (t === 'enum_item') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = base._readText(nameNode);
        const idx = registerOrExtendClass(name, _line(node), _endLine(node), 'enum');
        for (const c of node.children || []) {
          if (c.type !== 'enum_variant_list') continue;
          for (const variant of c.children || []) {
            if (variant.type !== 'enum_variant') continue;
            const vline = _line(variant);
            for (const vc of variant.children || []) {
              if (vc.type === 'ordered_field_declaration_list') {
                for (const tc of vc.children || []) {
                  if (!_TUPLE_FIELD_TYPES.has(tc.type)) continue;
                  const refs = [];
                  _collectTypeRefs(tc, false, refs);
                  for (const ref of refs) {
                    if (ref.role !== 'type' || ref.name === name) continue;
                    pendingFieldRefs.push({ ownerIdx: idx, refName: ref.name, line: vline });
                  }
                }
              } else if (vc.type === 'field_declaration_list') {
                for (const field of vc.children || []) {
                  if (field.type !== 'field_declaration') continue;
                  const typeNode = field.childForFieldName('type');
                  const refs = [];
                  _collectTypeRefs(typeNode, false, refs);
                  for (const ref of refs) {
                    if (ref.role !== 'type' || ref.name === name) continue;
                    pendingFieldRefs.push({ ownerIdx: idx, refName: ref.name, line: _line(field) });
                  }
                }
              }
            }
          }
        }
        return idx;
      }
      return null;
    }

    if (t === 'trait_item') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = base._readText(nameNode);
        const idx = registerOrExtendClass(name, _line(node), _endLine(node), 'trait');
        for (const c of node.children || []) {
          if (c.type !== 'trait_bounds') continue;
          const line = _line(c);
          let first = true;
          for (const sub of c.namedChildren || []) {
            const refs = [];
            _collectTypeRefs(sub, false, refs);
            for (const ref of refs) {
              if (ref.role !== 'type' || ref.name === name) continue;
              if (first) {
                pendingSupertraits.push({ ownerIdx: idx, refName: ref.name, line });
                first = false;
              }
              // Additional bounds beyond the first carry no closed-vocab
              // edge_type, dropped.
            }
          }
        }
        return idx;
      }
      return null;
    }
    return null;
  }

  // ─── impl_item → merged CLASS (struct+impl) + EXTENDS/IMPLEMENTS + methods ─
  function walkImpl(node) {
    const typeNode = node.childForFieldName('type');
    const traitNode = node.childForFieldName('trait');
    let implIdx = null;
    const typeName = _implTypeName(typeNode);
    if (typeName) implIdx = registerOrExtendClass(typeName, _line(node), _endLine(node), 'impl', true);
    if (traitNode && implIdx !== null) {
      const refs = [];
      _collectTypeRefs(traitNode, false, refs);
      const first = refs.find((r) => r.role === 'type');
      if (first && first.name !== nodes[implIdx].name) {
        pendingImplements.push({ ownerIdx: implIdx, refName: first.name, line: _line(node) });
      }
    }
    return typeName ? { idx: implIdx, name: typeName } : null;
  }

  // ─── function_item / function_signature_item → METHOD ────────────────────
  function walkFunctions(node, container) {
      const parentImplIdx = container ? container.idx : null;
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = base._readText(nameNode);
        if (name) {
          // Rust's `parameters` field resolves directly; entries are
          // `parameter` — deliberately NOT `self_parameter` (the implicit
          // `&self`/`self` receiver has no identifier-shaped name in this
          // grammar and is not a real named arg).
          const args = base.extractArgs(node.childForFieldName('parameters'), new Set(['parameter']));
          const body = node.childForFieldName('body');
          const idx = addNode({
            node_type: 'METHOD', name,
            summary: parentImplIdx !== null && parentImplIdx !== undefined
              ? `.${name}()` : `${name}()`,
            start_line: _line(node), end_line: _endLine(node),
            confidence_tier: 'EXTRACTED', confidence: 1.0,
            args,
            cyclomatic_complexity: base.computeCyclomatic(body, _RUST_COMPLEXITY_CONFIG),
            // ingest.js#writeNode keys a METHOD on file+owner+args+name. An `impl Serialize for
            // String` block registers no CLASS (see registerOrExtendClass), so without an owner
            // stamped here serde's ~50 `deserialize(deserializer)` methods in one file would all
            // key identically and collapse to one row on the canonical_key upsert. The owner is
            // the impl target whether or not that type is declared in this file.
            ...(container && container.name ? { _owner: container.name } : {}),
          });
          if (!methodByName.has(name)) methodByName.set(name, idx);
          if (parentImplIdx !== null && parentImplIdx !== undefined && parentImplIdx !== idx) {
            edges.push({ from: idx, to: parentImplIdx, edge_type: 'DEFINED_IN', resolution: 'same_file', evidence_line: _line(node) });
            if (!methodsByContainer.has(parentImplIdx)) methodsByContainer.set(parentImplIdx, new Map());
            methodsByContainer.get(parentImplIdx).set(name, idx);
          }
          if (body) methodBodies.push({ nodeIndex: idx, body, containerIdx: parentImplIdx });
        }
      }
  }

  // `macro_rules! name` is a declaration whose body is token trees, not code — there is nothing
  // below it to walk, and its expansion sites are a different (unresolvable, same-file) question.
  function walkMacroDef(node) {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? base._readText(nameNode) : '';
    if (!name) return;
    const idx = addNode({
      node_type: 'METHOD', name, summary: `${name}!()`,
      start_line: _line(node), end_line: _endLine(node),
      confidence_tier: 'EXTRACTED', confidence: 1.0, kind: 'macro',
    });
    if (!methodByName.has(name)) methodByName.set(name, idx);
  }

  // ─── use_declaration → IMPORT ─────────────────────────────────────────────
  // Expands use-groups: `use std::io::{Read, Write}` is TWO imports (Read,
  // Write), not one named `io`. The old `split('{')[0]` kept only the segment
  // before the brace, so every grouped import — the common form in real Rust —
  // was dropped, and the leaf names the referee emits never matched.
  function _pushImport(name, alias, prefixSegs, line) {
    if (!name || name === 'self' || name === 'crate' || name === 'super') {
      // `use a::b::{self}` re-exports the module `b` itself — emit its leaf.
      if (name === 'self' && prefixSegs.length) name = prefixSegs[prefixSegs.length - 1];
      else return;
      prefixSegs = prefixSegs.slice(0, -1);
    }
    if (importByName.has(name)) return;
    const fact = {
      name, alias: alias || null,
      module: prefixSegs.length ? prefixSegs.join('::') : null,
      line,
    };
    importFacts.push(fact);
    importByName.set(name, fact);
  }
  function _collectUse(node, prefixSegs, line) {
    if (!node) return;
    const t = node.type;
    if (t === 'identifier' || t === 'type_identifier' || t === 'self' || t === 'crate' || t === 'super') {
      _pushImport(base._readText(node), null, prefixSegs, line);
      return;
    }
    if (t === 'use_wildcard') return; // `a::*` — the referee (syn UseTree::Glob) emits nothing
    if (t === 'scoped_identifier') {
      const segs = base._readText(node).split('::').map((s) => s.trim()).filter(Boolean);
      const leaf = segs.pop();
      _pushImport(leaf, null, [...prefixSegs, ...segs], line);
      return;
    }
    if (t === 'use_as_clause') {
      const pathNode = node.childForFieldName('path');
      const aliasNode = node.childForFieldName('alias');
      const segs = pathNode ? base._readText(pathNode).split('::').map((s) => s.trim()).filter(Boolean) : [];
      const leaf = segs.pop();
      _pushImport(leaf, aliasNode ? base._readText(aliasNode) : null, [...prefixSegs, ...segs], line);
      return;
    }
    if (t === 'scoped_use_list') {
      const pathNode = node.childForFieldName('path');
      const listNode = node.childForFieldName('list');
      const segs = pathNode ? base._readText(pathNode).split('::').map((s) => s.trim()).filter(Boolean) : [];
      if (listNode) for (const c of listNode.namedChildren || []) _collectUse(c, [...prefixSegs, ...segs], line);
      return;
    }
    if (t === 'use_list') {
      for (const c of node.namedChildren || []) _collectUse(c, prefixSegs, line);
      return;
    }
  }
  function walkImports(node) {
    if (node.type === 'use_declaration') {
      _collectUse(node.childForFieldName('argument'), [], _line(node));
      return;
    }
    for (const child of node.children || []) walkImports(child);
  }

  // ─── declaration walk ────────────────────────────────────────────────────
  //
  // Every branch descends. The previous version returned at the first declaration it recognised,
  // so anything nested inside one was invisible — and Rust nests constantly: serde declares
  // structs and their whole impl blocks INSIDE function bodies (serde/src/private/de.rs:29 is one
  // of 114 in that crate alone), and trait bodies carry both signatures and default methods.
  // `container` is the nearest enclosing impl/trait/mod, which is what a DEFINED_IN edge should
  // point at; a declaration inside a function body has no container rather than inheriting the
  // function's one.
  function walkTop(node, container, inAssoc) {
    const t = node.type;
    let childContainer = container;
    let childInAssoc = inAssoc;
    if (t === 'function_item' || t === 'function_signature_item') {
      walkFunctions(node, container);
      childContainer = null;
    } else if (t === 'mod_item') {
      // A Rust `mod` is NOT a type. Registering it as a CLASS both inflated the
      // type-declaration plane with false positives (a module is snake_case, a
      // type PascalCase — the referee counts neither `mod`) AND shadowed real
      // traits during inheritance resolution: `impl Buf for BytesMut` bound to
      // the module `buf` (src/buf/) instead of the trait `Buf`, `impl fmt::Debug
      // for Vtable` to the module `debug` (src/fmt/debug.rs). A module is a pure
      // container here — recurse into its items, emit no node for it.
      childContainer = null;
      childInAssoc = false;
    } else if (t === 'struct_item' || t === 'union_item' || t === 'enum_item' || t === 'trait_item') {
      const idx = walkTypeDecls(node);
      childContainer = idx === null ? null : { idx, name: nodes[idx].name };
      // A trait body's associated consts are ImplItemConst-shaped; the syn
      // referee does not visit them, so `trait_item` marks associated scope.
      childInAssoc = true;
    } else if (t === 'impl_item') {
      childContainer = walkImpl(node);
      childInAssoc = true;
    } else if (t === 'const_item' || t === 'static_item') {
      // `const NAME: T = ...` / `static NAME: T = ...` — module/top-level Rust
      // constants, never emitted before (recall 0). Associated consts inside an
      // impl/trait body are the same node type but the syn referee does not
      // count them, so `inAssoc` excludes them to keep precision honest.
      const cn = node.childForFieldName('name');
      if (cn && !inAssoc) {
        addNode({
          node_type: 'CONSTANT', name: base._readText(cn), summary: base._readText(cn),
          start_line: _line(node), end_line: _endLine(node),
          confidence_tier: 'EXTRACTED', confidence: 1.0,
        });
      }
    } else if (t === 'macro_definition') {
      walkMacroDef(node);
      return;
    } else if (t === 'use_declaration') {
      walkImports(node);
      return;
    }
    for (const child of node.children || []) walkTop(child, childContainer, childInAssoc);
  }
  walkTop(root, null, false);

  // ─── EXTENDS: trait supertrait (first bound) — branch-wide by name ───────
  // A supertrait/impl base is resolved against the whole branch (and minted as
  // an external DEPENDENCY when it is a std/prelude trait), not only against a
  // same-file class. `impl Debug for X`, `impl From<A> for B`, `trait Service:
  // Layer` all live cross-file/cross-crate; the same-file rung saw none of them.
  for (const st of pendingSupertraits) {
    if (st.refName && st.refName !== nodes[st.ownerIdx].name) {
      unresolvedInheritance.push({ from: st.ownerIdx, toName: st.refName, edge_type: 'EXTENDS' });
    }
  }
  for (const im of pendingImplements) {
    if (im.refName && im.refName !== nodes[im.ownerIdx].name) {
      unresolvedInheritance.push({ from: im.ownerIdx, toName: im.refName, edge_type: 'IMPLEMENTS' });
    }
  }

  // ─── COUPLED_WITH: field/variant type reference to a type in this file ───
  for (const fr of pendingFieldRefs) {
    const targetIdx = classByName.get(fr.refName);
    if (targetIdx === undefined || targetIdx === fr.ownerIdx) continue;
    edges.push({ from: fr.ownerIdx, to: targetIdx, edge_type: 'COUPLED_WITH', resolution: 'same_file', evidence_line: fr.line });
  }

  // importFacts, collected above, carries the imports to the FILE node's
  // properties.imports.

  // ─── CALLS: identifier / field_expression / scoped_identifier, all through
  // the same flat same-file name table (see file header).
  // Two additions on top of that, neither changing which calls
  // resolve, only (a) how precisely a self-receiver call is labelled and (b)
  // whether a resolution miss leaves residue:
  //   - `self.method()` (field_expression whose `value` field is the literal
  //     `self` node type) is tried FIRST against the caller's own impl
  //     block's method table (methodsByContainer) — a hit is tier 1
  //     (this_receiver), genuine same-impl proof, not a file-wide guess. A
  //     miss falls through to the existing flat-table lookup unchanged (for
  //     e.g. a trait default method not defined in this impl).
  //   - every call form that still fails to resolve now pushes an
  //     `unresolvedCalls` residue entry instead of vanishing with no trace —
  //     this file had NO unresolvedCalls output at all before, unlike go.js's
  //     equivalent bespoke walk. ──
  const seenPairs = new Set();
  const unresolvedCalls = [];
  const seenDeferred = new Set();
  function calleeNameOf(funcNode) {
    if (!funcNode) return null;
    if (funcNode.type === 'identifier') {
      return base._readText(funcNode);
    }
    if (funcNode.type === 'field_expression') {
      const field = funcNode.childForFieldName('field');
      return field ? base._readText(field) : null;
    }
    if (funcNode.type === 'scoped_identifier') {
      const name = funcNode.childForFieldName('name');
      return name ? base._readText(name) : null;
    }
    return null;
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
    if (node.type === 'function_item') return; // nested fn boundary (go.js precedent)
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode && funcNode.type === 'field_expression') {
        const valueNode = funcNode.childForFieldName('value');
        const fieldNode = funcNode.childForFieldName('field');
        const calleeName = fieldNode ? base._readText(fieldNode) : null;
        if (calleeName && !base._LANGUAGE_BUILTIN_GLOBALS.has(calleeName)) {
          if (valueNode && valueNode.type === 'self') {
            const container = containerIdx !== null && containerIdx !== undefined ? methodsByContainer.get(containerIdx) : undefined;
            const selfTargetIdx = container ? container.get(calleeName) : undefined;
            if (selfTargetIdx !== undefined && selfTargetIdx !== callerIdx) {
              const pairKey = `${callerIdx}->${selfTargetIdx}::this_receiver`;
              if (!seenPairs.has(pairKey)) {
                seenPairs.add(pairKey);
                edges.push({ from: callerIdx, to: selfTargetIdx, edge_type: 'CALLS', resolution: 'this_receiver', evidence_line: _line(node) });
              }
            } else {
              // Not a method of THIS impl block (inherited trait default,
              // dynamic dispatch) — residue carries the canonical 'self'
              // marker, same convention base.js's accessor branch uses.
              pushUnresolved(callerIdx, calleeName, _line(node), 'self');
            }
            for (const child of node.children || []) walkCalls(child, callerIdx, containerIdx);
            return;
          }
        }
      }
      const calleeName = calleeNameOf(funcNode);
      if (calleeName && !base._LANGUAGE_BUILTIN_GLOBALS.has(calleeName)) {
        const targetIdx = methodByName.has(calleeName) ? methodByName.get(calleeName) : classByName.get(calleeName);
        if (targetIdx !== undefined && targetIdx !== callerIdx) {
          const pairKey = `${callerIdx}->${targetIdx}::CALLS`;
          if (!seenPairs.has(pairKey)) {
            seenPairs.add(pairKey);
            edges.push({ from: callerIdx, to: targetIdx, edge_type: 'CALLS', resolution: 'same_file', evidence_line: _line(node) });
          }
        } else if (targetIdx === undefined) {
          const receiverName = (funcNode && funcNode.type === 'field_expression' && funcNode.childForFieldName('value'))
            ? base._readText(funcNode.childForFieldName('value')) : undefined;
          pushUnresolved(callerIdx, calleeName, _line(node), receiverName);
        }
      }
    }
    for (const child of node.children || []) walkCalls(child, callerIdx, containerIdx);
  }
  for (const { nodeIndex, body, containerIdx } of methodBodies) walkCalls(body, nodeIndex, containerIdx);

  const { nodes: merged, indexMap } = base.mergeSameFileDuplicates(nodes);
  const result = {
    nodes: merged,
    edges: base.remapEdgeIndices(indexMap, edges),
    unresolvedCalls: base.remapFromIndices(indexMap, unresolvedCalls),
    unresolvedInheritance: base.remapFromIndices(indexMap, unresolvedInheritance),
    importFacts,
  };
  // Rust builds METHOD nodes directly (not via walkGeneric), so it applies the shared
  // language-agnostic HTTP-call scan on its own result — this is what gives reqwest/hyper/ureq
  // outbound calls the same cross-repo resolution the other languages get.
  base.augmentHttpCallsAcrossLanguages(result.nodes, content);
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
