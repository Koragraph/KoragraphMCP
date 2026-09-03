'use strict';

// The closed CLASS/METHOD/IMPORT node_type + traversal-vocabulary edge_type
// contract defined in extractors/base.js maps a richer relation set
// ("contains", "references", "embeds", "method") down onto that closed set:
//   contains   -> dropped (file scoping is the DB row's file_id, not an edge)
//   method     -> DEFINED_IN (method -> owning struct/interface)
//   embeds     -> EMBEDS    (struct/interface embeds another type declared
//                            in this file — retargeted off EXTENDS, since Go
//                            embedding is composition, not inheritance)
//   references -> COUPLED_WITH (field/param/return type reference)
//   imports_from -> IMPORTS
//   calls      -> CALLS
// Package-wide cross-file resolution is explicitly out of scope here — this
// extractor sees one file. A call/reference this file cannot evidence is dropped rather than
// guessed (the "refuse to guess" principle); cross-file/package import-evidence
// resolution is a separate cross-file pass.

const base = require('./base');

const _GO_PREDECLARED_TYPES = new Set([
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any', 'comparable',
]);

// Cyclomatic complexity for tree-sitter-go. expression_case/default_case are
// already distinct node types (no branchArmDefaultTypes entry needed). Go
// has no while/do/ternary. Passed directly to base.computeCyclomatic — this
// is a plain object with the same field names computeCyclomatic reads off a
// real LanguageConfig, not a LanguageConfig itself (go.js is one of the 5
// bespoke extractors, not routed through walkGeneric).
const _GO_COMPLEXITY_CONFIG = {
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'expression_case']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
};

let _parserState = 'pending'; // 'pending' | 'ready' | 'failed'
let _parser = null;
let _parserReadyPromise = null;

// Loads through base.js's shared grammar loader — NOT a second independent
// Parser.init() — because a second Parser.init() call after ast-extractor.js's
// has already resolved corrupts the web-tree-sitter module object (see
// base.js's loadGrammar doc comment). Lazily invoked (NOT a top-level IIFE):
// ast-extractor.js requires this file at ITS OWN top level (EXT_TO_EXTRACTOR),
// so an eager top-level call here would race the require-cycle back into
// ast-extractor.js's not-yet-populated module.exports (base.loadGrammar's lazy
// `require('../ast-extractor')` returned a partial exports object mid-load, so
// `tsInitPromise` was undefined). Deferring to first call means ast-extractor.js
// has finished loading by the time this runs.
function _ensureParserReady() {
  if (!_parserReadyPromise) {
    _parserReadyPromise = (async () => {
      try {
        _parser = await base.loadGrammar('go');
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

// Walks a Go type expression, collecting referenced type_identifier names
// (unwraps pointer/slice/array/map/channel/generic wrappers).
function _collectTypeRefs(node, out) {
  if (!node) return;
  const t = node.type;
  if (t === 'type_identifier') {
    const text = base._readText(node);
    if (text && !_GO_PREDECLARED_TYPES.has(text)) out.push(text);
    return;
  }
  if (t === 'qualified_type') {
    const text = base._readText(node).split('.').pop();
    if (text && !_GO_PREDECLARED_TYPES.has(text)) out.push(text);
    return;
  }
  if (t === 'generic_type') {
    const typeField = node.childForFieldName('type');
    if (typeField) _collectTypeRefs(typeField, out);
    for (const c of node.children || []) {
      if (c.type === 'type_arguments') {
        for (const arg of c.namedChildren || []) _collectTypeRefs(arg, out);
      }
    }
    return;
  }
  if (['pointer_type', 'slice_type', 'array_type', 'map_type', 'channel_type', 'parenthesized_type'].includes(t)) {
    for (const c of node.namedChildren || []) _collectTypeRefs(c, out);
    return;
  }
  if (node.isNamed) {
    for (const c of node.namedChildren || []) _collectTypeRefs(c, out);
  }
}

// extract(tree, content, filePath) -> { nodes, edges } per extractors/base.js contract.
function extract(tree, content, filePath) {
  const root = tree.rootNode;
  const nodes = [];
  const edges = [];

  const classByName = new Map();  // name -> nodeIndex
  const methodByName = new Map(); // name -> nodeIndex (bare, non-receiver funcs + methods)
  const importByPkg = new Map();  // local alias -> import fact
  const importedPkgAliases = new Set();
  const importFacts = [];         // flat list threaded to the FILE node's properties.imports
  const methodBodies = []; // { nodeIndex, body }
  const pendingFieldRefs = []; // { ownerName, refs: [name], line }
  const pendingEmbeds = [];    // { ownerName, refName, line }
  const receiverMethods = [];  // { nodeIndex, receiverType }

  function addNode(node) {
    nodes.push(node);
    return nodes.length - 1;
  }

  // ─── type_declaration → CLASS ──────────────────────────────────────────────
  for (const td of root.descendantsOfType('type_declaration')) {
    for (const spec of td.descendantsOfType('type_spec')) {
      const nameNode = spec.childForFieldName('name') || spec.children.find((c) => c.type === 'type_identifier');
      if (!nameNode) continue;
      const name = base._readText(nameNode);
      if (!name || classByName.has(name)) continue;

      const body = spec.children.find((c) => c.type === 'struct_type' || c.type === 'interface_type');
      const kind = body && body.type === 'interface_type' ? 'interface' : 'struct';
      const idx = addNode({
        node_type: 'CLASS', name,
        summary: `${kind} ${name}`,
        start_line: _line(spec), end_line: _endLine(spec),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
        _sourceFile: filePath, kind,
      });
      classByName.set(name, idx);

      if (!body) continue;
      if (body.type === 'struct_type') {
        const fdl = body.children.find((c) => c.type === 'field_declaration_list');
        for (const field of (fdl ? fdl.children : []).filter((c) => c.type === 'field_declaration')) {
          const hasName = field.children.some((c) => c.type === 'field_identifier');
          const typeNode = field.childForFieldName('type') ||
            field.children.find((c) => c.isNamed && c.type !== 'field_identifier');
          const refs = [];
          _collectTypeRefs(typeNode, refs);
          for (const refName of refs) {
            if (refName === name) continue;
            if (!hasName) pendingEmbeds.push({ ownerName: name, refName, line: _line(field) });
            else pendingFieldRefs.push({ ownerName: name, refName, line: _line(field) });
          }
        }
      } else if (body.type === 'interface_type') {
        // The installed tree-sitter-go grammar names this wrapper node
        // `constraint_elem`, not `type_elem` — `type_elem` never occurs, so a
        // `type_elem` filter would match nothing and interface embedding would
        // be silently never captured. `constraint_elem` also wraps Go generic
        // type-constraint terms (`~int`, `int | string`) via
        // `negated_type`/`union_type` children — those are type-parameter
        // bounds, not interface embedding, so a constraint_elem whose sole
        // child is one of those is excluded; a bare named-type child is treated
        // as an embed.
        for (const elem of body.children.filter((c) => c.type === 'constraint_elem')) {
          const child = (elem.namedChildren || [])[0];
          if (!child || child.type === 'union_type' || child.type === 'negated_type') continue;
          const refs = [];
          _collectTypeRefs(child, refs);
          for (const refName of refs) {
            if (refName === name) continue;
            pendingEmbeds.push({ ownerName: name, refName, line: _line(elem) });
          }
        }
      }
    }
  }

  // ─── import_declaration → IMPORT ───────────────────────────────────────────
  for (const imp of root.descendantsOfType('import_declaration')) {
    const specs = [];
    for (const child of imp.children) {
      if (child.type === 'import_spec_list') specs.push(...child.children.filter((c) => c.type === 'import_spec'));
      else if (child.type === 'import_spec') specs.push(child);
    }
    for (const spec of specs) {
      const pathNode = spec.childForFieldName('path');
      if (!pathNode) continue;
      const raw = base._readText(pathNode).replace(/^"|"$/g, '');
      if (!raw) continue;
      const aliasNode = spec.childForFieldName('name');
      const localName = aliasNode ? base._readText(aliasNode) : raw.split('/').pop();
      if (!localName || localName === '_' || localName === '.') continue;
      if (importByPkg.has(localName)) continue;
      const fact = { name: localName, alias: localName, module: raw, line: _line(spec) };
      importFacts.push(fact);
      importByPkg.set(localName, fact);
      importedPkgAliases.add(localName);
    }
  }

  // ─── function_declaration / method_declaration → METHOD ───────────────────
  for (const fn of root.descendantsOfType('function_declaration')) {
    const nameNode = fn.childForFieldName('name');
    if (!nameNode) continue;
    const name = base._readText(nameNode);
    if (!name || methodByName.has(name)) continue;
    // args-only for the 5 bespoke extractors. Go's `parameters` field resolves
    // on both function_declaration and method_declaration; entries are
    // `parameter_declaration`.
    const args = base.extractArgs(fn.childForFieldName('parameters'), new Set(['parameter_declaration']));
    const body = fn.childForFieldName('body');
    const idx = addNode({
      node_type: 'METHOD', name,
      summary: `func ${name}()`,
      start_line: _line(fn), end_line: _endLine(fn),
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      _sourceFile: filePath,
      args,
      cyclomatic_complexity: base.computeCyclomatic(body, _GO_COMPLEXITY_CONFIG),
    });
    methodByName.set(name, idx);
    if (body) methodBodies.push({ nodeIndex: idx, body });
  }

  for (const md of root.descendantsOfType('method_declaration')) {
    const nameNode = md.childForFieldName('name');
    if (!nameNode) continue;
    const name = base._readText(nameNode);
    if (!name) continue;

    let receiverType = null;
    const receiver = md.childForFieldName('receiver');
    if (receiver) {
      const paramDecl = receiver.children.find((c) => c.type === 'parameter_declaration');
      if (paramDecl) {
        const typeNode = paramDecl.childForFieldName('type');
        if (typeNode) {
          receiverType = typeNode.type === 'pointer_type'
            ? (typeNode.namedChildren || []).find((c) => c.type === 'type_identifier')
            : typeNode;
          receiverType = receiverType ? base._readText(receiverType) : null;
        }
      }
    }

    const args = base.extractArgs(md.childForFieldName('parameters'), new Set(['parameter_declaration']));
    const body = md.childForFieldName('body');
    const idx = addNode({
      node_type: 'METHOD', name,
      summary: receiverType ? `func (${receiverType}) ${name}()` : `func ${name}()`,
      start_line: _line(md), end_line: _endLine(md),
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      _sourceFile: filePath,
      args,
      cyclomatic_complexity: base.computeCyclomatic(body, _GO_COMPLEXITY_CONFIG),
    });
    // Receiver methods keyed separately from bare funcs so a same-named bare
    // func in the file isn't shadowed for CALLS resolution.
    if (!methodByName.has(name)) methodByName.set(name, idx);
    if (receiverType) receiverMethods.push({ nodeIndex: idx, receiverType });

    if (body) methodBodies.push({ nodeIndex: idx, body });
  }

  // ─── DEFINED_IN: receiver methods → owning struct/interface (same_file) ───
  for (const rm of receiverMethods) {
    const ownerIdx = classByName.get(rm.receiverType);
    if (ownerIdx !== undefined && ownerIdx !== rm.nodeIndex) {
      edges.push({ from: rm.nodeIndex, to: ownerIdx, edge_type: 'DEFINED_IN', resolution: 'same_file', evidence_line: nodes[rm.nodeIndex].start_line });
    }
  }

  // ─── EMBEDS: struct/interface embeds another type declared in this file ──
  // Retargeted off EXTENDS — Go embedding is composition (promoted fields/
  // methods), not inheritance, and the two are kept distinct (embeds vs. is_a).
  // Existing DB rows written as EXTENDS before this change are left as-is
  // (indistinguishable without re-parse); only fresh ingests emit EMBEDS.
  for (const emb of pendingEmbeds) {
    const ownerIdx = classByName.get(emb.ownerName);
    const targetIdx = classByName.get(emb.refName);
    if (ownerIdx === undefined || targetIdx === undefined || ownerIdx === targetIdx) continue;
    edges.push({ from: ownerIdx, to: targetIdx, edge_type: 'EMBEDS', resolution: 'same_file', evidence_line: emb.line });
  }

  // ─── COUPLED_WITH: named field references another type declared in this file ──
  for (const fr of pendingFieldRefs) {
    const ownerIdx = classByName.get(fr.ownerName);
    const targetIdx = classByName.get(fr.refName);
    if (ownerIdx === undefined || targetIdx === undefined || ownerIdx === targetIdx) continue;
    edges.push({ from: ownerIdx, to: targetIdx, edge_type: 'COUPLED_WITH', resolution: 'same_file', evidence_line: fr.line });
  }

  // importFacts, collected above, carries the imports to the FILE node's
  // properties.imports.

  // ─── CALLS: same-file bare-name calls resolve directly; package-qualified
  // calls defer to unresolvedCalls so resolve.js#resolveViaReceiverImport
  // resolves them branch-wide against the real import target. ──
  const seenPairs = new Set();
  const unresolvedCalls = [];
  const seenDeferred = new Set();
  // Go has no `this`/`self` keyword — method receivers are arbitrary named
  // parameters (`func (r *Foo) Bar()`), not a fixed spellable token, so this
  // file gets no selfTokens-equivalent addition. What it DID have was a genuine
  // silent drop: an unmatched bare call and a non-package-receiver
  // selector_expression (e.g. `s.logger.Log()`) both vanished with no
  // unresolvedCalls residue at all — the receiver-conservatism itself (declared
  // in this file's header, a divergence from rust.js's flat-table fallback) is
  // unchanged; only the "leaves no trace" part was a bug.
  function pushUnresolved(callerIdx, calleeName, line, receiverName) {
    const dkey = `${callerIdx}::${receiverName || ''}::${calleeName}`;
    if (seenDeferred.has(dkey)) return;
    seenDeferred.add(dkey);
    const marker = { from: callerIdx, calleeName, line };
    if (receiverName) marker.receiverName = receiverName;
    unresolvedCalls.push(marker);
  }
  function walkCalls(node, callerIdx) {
    if (node.type === 'function_declaration' || node.type === 'method_declaration') return;
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        if (funcNode.type === 'identifier') {
          const calleeName = base._readText(funcNode);
          if (calleeName && !base._LANGUAGE_BUILTIN_GLOBALS.has(calleeName)) {
            const targetIdx = methodByName.get(calleeName);
            if (targetIdx !== undefined && targetIdx !== callerIdx) {
              const pairKey = `${callerIdx}->${targetIdx}`;
              if (!seenPairs.has(pairKey)) {
                seenPairs.add(pairKey);
                edges.push({ from: callerIdx, to: targetIdx, edge_type: 'CALLS', resolution: 'same_file', evidence_line: _line(node) });
              }
            } else if (targetIdx === undefined) {
              pushUnresolved(callerIdx, calleeName, _line(node));
            }
          }
        } else if (funcNode.type === 'selector_expression') {
          // Every selector_expression call (package-alias-qualified or not)
          // refuses to guess a same-file target — package-qualified calls
          // defer to resolve.js#resolveViaReceiverImport branch-wide; a
          // non-package receiver (e.g. s.logger.Log()) carries no same-file
          // import evidence at all, a declared divergence from
          // rust.js/zig.js's flat-table fallback (this file's own header).
          // Both leave unresolvedCalls residue instead of dropping silently.
          const operand = funcNode.childForFieldName('operand');
          const field = funcNode.childForFieldName('field');
          const receiverName = operand ? base._readText(operand) : '';
          if (field) {
            const calleeName = base._readText(field);
            if (calleeName) pushUnresolved(callerIdx, calleeName, _line(node), receiverName || undefined);
          }
        }
      }
    }
    for (const child of node.children || []) walkCalls(child, callerIdx);
  }
  for (const { nodeIndex, body } of methodBodies) walkCalls(body, nodeIndex);

  const result = { nodes, edges, unresolvedCalls, importFacts };
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

module.exports = { extract, extractFile, ready };
