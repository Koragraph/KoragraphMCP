'use strict';

// Typed extraction facts as plain frozen JS objects: only the fields resolve.js actually
// consumes are carried (see resolve.js's header for the declared scope boundary).

function declarationFact(filePath, name, line) {
  return Object.freeze({ kind: 'declaration', filePath, name, line });
}

function importFact(filePath, localName, targetPath, importedName, line) {
  return Object.freeze({ kind: 'import', filePath, localName, targetPath, importedName, line });
}

function aliasFact(filePath, alias, targetName, line) {
  return Object.freeze({ kind: 'alias', filePath, alias, targetName, line });
}

function exportFact(filePath, exportedName, line, localName = null, targetPath = null, targetName = null) {
  return Object.freeze({ kind: 'export', filePath, exportedName, line, localName, targetPath, targetName });
}

function starExportFact(filePath, targetPath, line) {
  return Object.freeze({ kind: 'star_export', filePath, targetPath, line });
}

const { buildSymbolIndex, buildLabelIndex, buildDottedPathSuffixIndex } = require('./symbol-index');

// Builds a file-scoped index from a flat row list shaped
// { id, name, node_type, file_path }, as returned by a single query joining
// nodes to files for a branch. Rows missing file_path (no
// file join available — e.g. unit-test fixtures that only mock branch-level
// node lookups, or nodes with no file_id) are skipped rather than throwing:
// import-evidence resolution degrades to "no evidence available", never to a
// crash — the same refuse-to-guess principle applied to the resolver's own inputs.
//
// Also builds `symbolIndex` (module stem + symbol name -> node ids) from the same rows'
// CLASS/METHOD subset, via symbol-index.js#buildSymbolIndex — so resolve.js has ONE source
// of truth for both the relative-path pass and the module-stem pass.
//
// The Maps below are NOT first-wins — `declByFileAndName` and `importsByFile` push into
// arrays (no entry is discarded) and `fileById` is keyed by a unique node id. What row
// order changes is the ARRAY ORDER, which downstream tie-breaking in
// `buildSymbolIndex`/`resolve.js` is sensitive to. That ordering is enforced at the SQL
// source (`ingest.js` reads that feed this carry `ORDER BY f.path, n.id` / `ORDER BY id`),
// not here — this function deliberately does not re-sort, so do not add a feeding read that
// skips the ORDER BY.
// Three additions consumed by resolve.js#resolveViaReceiverType (typed-field receiver
// inference):
//   - `classFieldsById`: classNodeId -> its declared `fields` ([{name,type}],
//     stamped by the extractors onto the CLASS node's own top-level `fields`
//     key, which lands in `properties.fields`). ingest.js's fileScopedRows
//     query selects it with `json_extract(properties,'$.fields')`, which the
//     SQLite driver returns as JSON *text*, not an array — so it is parsed here
//     (`_tryParseFields`); a fixture literal that already passes an array is
//     used as-is. Either way `classFieldsById` populates against a real store.
//   - `methodParentClassId`: methodNodeId -> its immediate owning CLASS id,
//     from the DEFINED_IN edge the extraction plane already writes at
//     METHOD-creation time (base.js#walkGeneric). Carried on each row as
//     `parent_class_id` (ingest.js's query resolves it via a per-row scalar
//     subquery against edges, not a JOIN — a JOIN risks row
//     multiplication if a node ever carries more than one DEFINED_IN edge).
//   - `classNodesByName`: exact (case-sensitive, unnormalised — a field's
//     declared type name is a real identifier, not a fuzzy label) CLASS name
//     -> [{id, filePath}], for the tier-4 "unique global type" branch. Kept
//     separate from `labelIndex` (built below, CLASS+METHOD mixed, normalised)
//     because a same-named METHOD would otherwise falsely count as a second
//     candidate for what should be a CLASS-only uniqueness check.
// A class's `fields` (and a method's `localTypes`) column is either a parsed array (fixtures)
// or its JSON text (a live SQLite `json_extract`). Returns the array, or null if absent or
// malformed — never throws.
function _tryParseFields(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

// The bare declared-type name a field/parameter type text refers to, so it can be matched against
// a CLASS name: generic arguments (`List<Foo>` -> `List`), array markers (`Foo[]` -> `Foo`) and a
// namespace/package qualifier (`com.x.Foo` -> `Foo`) are all stripped. Returns null when what
// remains is not a plain identifier (a primitive, a wildcard, a mangled fragment), so it never
// contributes a junk type name to the receiver-type resolver.
function _bareTypeName(raw) {
  if (raw == null) return null;
  let t = String(raw).trim();
  const lt = t.indexOf('<');
  if (lt >= 0) t = t.slice(0, lt);              // drop generic args and everything after
  t = t.replace(/\[\s*\]/g, '').trim();          // drop array markers
  const dot = t.lastIndexOf('.');
  if (dot >= 0) t = t.slice(dot + 1);            // drop package/namespace qualifier
  t = t.trim();
  return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
}

function buildFileScopedIndex(rows) {
  const declByFileAndName = new Map();  // filePath -> name -> [{id, type}]
  const importsByFile = new Map();      // filePath -> [{id, name}]
  const fileById = new Map();           // nodeId -> filePath
  const knownFilePaths = new Set();
  const symbolIndexRows = [];           // CLASS/METHOD rows fed to buildSymbolIndex
  const classFieldsById = new Map();    // classNodeId -> [{name, type}]
  const methodParentClassId = new Map(); // methodNodeId -> classNodeId
  const methodLocalTypesById = new Map(); // methodNodeId -> [{name, type}] (params + typed locals)
  const classNodesByName = new Map();   // exact CLASS name -> [{id, filePath}]
  const classBasesByName = new Map();   // exact CLASS name -> [baseTypeName] (for receiver-type chain walk)

  for (const r of rows || []) {
    if (!r || !r.file_path) continue;
    fileById.set(r.id, r.file_path);
    knownFilePaths.add(r.file_path);

    if (r.node_type === 'CLASS') {
      const flds = typeof r.fields === 'string' ? _tryParseFields(r.fields) : r.fields;
      if (Array.isArray(flds) && flds.length) {
        // Merge, not overwrite: a FIELD row for this class may have been seen first (rows arrive in
        // path/id order, and the fields-derived-from-FIELD-nodes branch below shares this map), so
        // clobbering here would drop those. C# stamps the whole set on the class and reaches here
        // with nothing to merge into; the merge is a no-op for it.
        const existing = classFieldsById.get(r.id);
        if (existing) {
          for (const f of flds) if (f && !existing.some((e) => e && e.name === f.name)) existing.push(f);
        } else {
          classFieldsById.set(r.id, flds);
        }
      }
      const entry = { id: r.id, filePath: r.file_path };
      const list = classNodesByName.get(r.name);
      if (list) list.push(entry); else classNodesByName.set(r.name, [entry]);
      const bases = typeof r.bases === 'string' ? _tryParseFields(r.bases) : r.bases;
      if (Array.isArray(bases) && bases.length && !classBasesByName.has(r.name)) {
        classBasesByName.set(r.name, bases.filter((b) => typeof b === 'string'));
      }
    }
    if (r.node_type === 'METHOD' && (r.parent_class_id !== undefined && r.parent_class_id !== null)) {
      methodParentClassId.set(r.id, r.parent_class_id);
    }
    if (r.node_type === 'METHOD') {
      // Parameter/local declared types (same text-or-array duality as `fields`), so a call
      // through a parameter or local (`svc.DoWork()` where `svc` is a `FooService` parameter)
      // resolves to the receiver's declared type.
      const lts = typeof r.local_types === 'string' ? _tryParseFields(r.local_types) : r.local_types;
      if (Array.isArray(lts) && lts.length) methodLocalTypesById.set(r.id, lts);
    }

    // A field's declared type keyed on its owning CLASS, derived from the FIELD node's own
    // `field_type` and DEFINED_IN owner (carried on the row as `parent_class_id`). The
    // config-driven/regex extractors (Java, Go, Kotlin, PHP …) emit FIELD nodes with a declared
    // type but never stamp the aggregate `fields` array on the CLASS node the way the C# pass does,
    // so classFieldsById was empty for them and resolveViaReceiverType could not disambiguate a
    // member call through a typed field. This reconstructs the same {name, type} shape from the
    // FIELD nodes those extractors already produce, additive to the class-stamped path above.
    if (r.node_type === 'FIELD' && r.parent_class_id !== undefined && r.parent_class_id !== null) {
      const rawType = r.field_type != null
        ? r.field_type
        : (r.properties && typeof r.properties === 'object' ? r.properties.field_type : null);
      const typeName = _bareTypeName(rawType);
      if (typeName && r.name) {
        let flds = classFieldsById.get(r.parent_class_id);
        if (!flds) { flds = []; classFieldsById.set(r.parent_class_id, flds); }
        if (!flds.some((f) => f && f.name === r.name)) flds.push({ name: r.name, type: typeName });
      }
    }

    // Keyed on "any row carrying import evidence", not a hardcoded
    // `r.node_type === 'IMPORT'` check — decouples importsByFile's population from the
    // IMPORT node TYPE so retiring IMPORT nodes doesn't silently starve this map.
    if (r.node_type === 'IMPORT' || r.module != null) {
      const list = importsByFile.get(r.file_path);
      // module/alias: carried through from properties.module/properties.alias (the
      // extractor stamp) via whatever flat columns the caller's row query selects
      // (ingest.js's fileScopedRows query aliases them as `module`/`alias`). Absent on any
      // row shape that doesn't select them (e.g. this file's own unit-test fixtures) —
      // resolveViaModuleStem degrades to "no evidence" rather than throwing, same
      // refuse-to-guess principle as the rest of this module.
      const entry = { id: r.id, name: r.name, module: r.module || null, alias: r.alias || null };
      if (list) list.push(entry); else importsByFile.set(r.file_path, [entry]);
      if (r.node_type === 'IMPORT') continue;
    }

    // Import facts land as an array on FILE.properties.imports instead of one IMPORT node
    // per import. Explode them into the SAME importsByFile shape the resolvers above already
    // consume ({id, name, module, alias}). `imp.name` is the import's declared local binding
    // (importFacts shape is `{module, alias, name, line}`); `imp.alias` is the fallback for
    // producers that only stamp an alias (this file's own unit-test fixtures). `line` is
    // carried through for future call-site-adjacent tooling but is not consumed by any
    // resolver yet.
    if (r.properties && Array.isArray(r.properties.imports) && r.properties.imports.length) {
      const list = importsByFile.get(r.file_path);
      const exploded = r.properties.imports.map((imp) => ({
        id: r.id,
        name: (imp && (imp.name || imp.alias)) || null,
        module: (imp && imp.module) || null,
        alias: (imp && imp.alias) || null,
        line: (imp && imp.line) ?? null,
        // Carried through so resolveImportNodeTarget can restrict a non-relative binding
        // fact to the proof-grade (workspace / tsconfig-alias) tiers. Dropping it here would
        // silently re-open the false-edge risk that flag exists to close.
        firstPartyOnly: !!(imp && imp.firstPartyOnly),
      }));
      if (list) list.push(...exploded); else importsByFile.set(r.file_path, exploded);
    }

    let byName = declByFileAndName.get(r.file_path);
    if (!byName) { byName = new Map(); declByFileAndName.set(r.file_path, byName); }
    const entry = { id: r.id, type: r.node_type };
    const list = byName.get(r.name);
    if (list) list.push(entry); else byName.set(r.name, [entry]);

    if (r.node_type === 'CLASS' || r.node_type === 'METHOD') {
      symbolIndexRows.push(r);
    }
  }

  const symbolIndex = buildSymbolIndex(symbolIndexRows);
  // labelIndex is the same CLASS/METHOD rows keyed on label ALONE (no source-file stem) —
  // the branch-wide fallback resolve.js#resolveViaGlobalLabel tries only after the stem
  // pass (via symbolIndex above) misses.
  const labelIndex = buildLabelIndex(symbolIndexRows);
  // IMPORTS cross-file resolution: resolve.js#resolveImportNodeTarget's
  // tier 2 (Java/Kotlin/C#-style fully-qualified imports).
  const dottedPathSuffixIndex = buildDottedPathSuffixIndex(knownFilePaths);

  return {
    declByFileAndName, importsByFile, fileById, knownFilePaths, symbolIndex, labelIndex, dottedPathSuffixIndex,
    classFieldsById, methodParentClassId, methodLocalTypesById, classNodesByName, classBasesByName,
  };
}

module.exports = {
  declarationFact,
  importFact,
  aliasFact,
  exportFact,
  starExportFact,
  buildFileScopedIndex,
  // Exported for cross-repo-edge-resolver.js's own field-declared-type lookup — the cross-repo
  // equivalent of the in-repo `classFieldsById` this same helper feeds above, needing the same
  // generic/array/package-qualifier stripping so both sides compare bare type names.
  bareTypeName: _bareTypeName,
};
