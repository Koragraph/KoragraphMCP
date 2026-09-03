'use strict';

const Joi = require('joi');

// Pure, dependency-free helpers extracted from ingest.js so they are unit-testable
// without loading the DB pool / LLM clients. ingest.js re-imports these — behaviour
// is unchanged.

// Joi schema for a single extracted node. Requires node_type (non-empty string) and
// name (non-empty string); all other fields are optional so the schema stays tolerant
// of extra LLM-specific fields while catching the most common failure mode: nodes that
// are missing their identity fields entirely.
const NODE_SCHEMA = Joi.object({
  node_type: Joi.string().min(1).required(),
  name:      Joi.string().min(1).required(),
}).unknown(true);

const NODES_ARRAY_SCHEMA = Joi.array().items(NODE_SCHEMA);

// Validate an array of extracted nodes. Returns { valid: boolean, errors: string[] }.
// A zero-length array is valid (caller handles the empty case separately).
function validateExtractionNodes(nodes) {
  if (!Array.isArray(nodes)) return { valid: false, errors: ['nodes is not an array'] };
  const result = NODES_ARRAY_SCHEMA.validate(nodes, { abortEarly: false });
  if (result.error) {
    const errors = result.error.details.map(d => d.message);
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}

function computeMethodSignatureQualifier(nd) {
  if (typeof nd.params === 'string') return nd.params.replace(/\s+/g, ' ').trim();
  if (typeof nd.signature === 'string') {
    const open = nd.signature.indexOf('(');
    const close = nd.signature.lastIndexOf(')');
    if (open >= 0 && close > open) return nd.signature.slice(open + 1, close).replace(/\s+/g, ' ').trim();
  }
  // extractors/base.js reports parameter NAMES as `args` instead of raw parameter
  // text, so without this fallback overloads still collapse. The two producers
  // therefore key the same method on different TEXT — a real divergence, not
  // something to paper over here.
  if (Array.isArray(nd.args)) return nd.args.join(',');
  return null;
}

// The owner is normally read off the DEFINED_IN edge the extraction pass emitted. That pass runs
// per FILE, so it can only see owner types declared in the same file — and in Go the dominant
// idiom is the opposite: `type Viper struct` lives in viper.go while `func (v *Viper) …` methods
// are spread over remote.go, finder.go, bind_struct.go and the rest. Those methods therefore
// arrived here with NO owner, and the key degraded to file+params+name.
//
// A Go file can declare both `func AddRemoteProvider(provider, endpoint, path string)` and
// `func (v *Viper) AddRemoteProvider(provider, endpoint, path string)` — same file, same
// name, byte-identical parameter text — so without an owner qualifier the two collapse onto
// one canonical_key and one METHOD is silently dropped by the ON CONFLICT upsert. The pattern
// is the whole point of a package-level convenience wrapper, so it recurs across the repo.
//
// `parent_class` is the receiver type the CST itself yielded (ast-extractor.js#emitMethod for Go,
// and the equivalent in every other plane), i.e. exactly the fact the DEFINED_IN edge would have
// carried had the owner happened to be in the same file. Falling back to it can only ever make a
// key MORE specific, so it can merge nothing that was previously distinct.
function computeMethodOwnerQualifier(nd) {
  if (!nd) return null;
  let owner = typeof nd._owner === 'string' ? nd._owner.trim() : '';
  if (!owner && typeof nd.parent_class === 'string') owner = nd.parent_class.trim();
  const signature = computeMethodSignatureQualifier(nd);
  if (!owner && signature === null) return null;
  return `${owner}(${signature === null ? '' : signature})`;
}

// Plane-agnostic: stamp each METHOD node with the identity its own extraction pass proved.
// `definedIn` is that pass's DEFINED_IN structural edges as {fromIndex,toIndex} index pairs —
// every extractor plane emits them in that shape. Called once per file, before any write, so
// the AST plane, the generic plane, and the LLM rows aligned to them all agree on one key.
function stampMethodIdentities(nodes, definedIn) {
  if (!Array.isArray(nodes) || !nodes.length) return;
  if (Array.isArray(definedIn)) {
    for (const edge of definedIn) {
      const fromIndex = edge?.from ?? edge?.fromIndex;
      const toIndex = edge?.to ?? edge?.toIndex;
      const method = nodes[fromIndex];
      const owner = nodes[toIndex];
      if (!method || !owner || method.node_type !== 'METHOD' || !owner.name) continue;
      if (method._owner === undefined) method._owner = owner.name;
    }
  }
  for (const nd of nodes) {
    if (nd && nd.node_type === 'METHOD') nd._methodIdentity = computeMethodOwnerQualifier(nd);
  }
}

function computeCanonicalKey(nodeType, nodeName, branchId, sourceFile, ownerQualifier) {
  const safe = nodeName.trim();
  switch (nodeType) {
    case 'DB_TABLE':        return `${branchId}::dbt::${safe.toLowerCase()}`;
    case 'DEPENDENCY':      return `${branchId}::dep::${safe}`;
    case 'EXTERNAL_SYSTEM': return `${branchId}::ext::${safe.toLowerCase().replace(/\s+/g, '_')}`;
    // ENTITY is the LLM plane's semantic alias for CLASS and shares its key shape,
    // including the A2.5 file-qualification below (LLM-extracted ENTITY nodes omit
    // sourceFile, so they keep the pre-existing branch+name key unaffected).
    case 'ENTITY':
      return sourceFile
        ? `${branchId}::CLASS::${sourceFile}::${safe}`
        : `${branchId}::CLASS::${safe}`;
    // CONFIG_VALUE is file-qualified when sourceFile is known: deterministic config parsing
    //  can see the SAME key name in many files (e.g. i18n message bundles all
    // define `welcome`), and without a file discriminator every file after the first would
    // collide on canonical_key and silently lose its own node (reconciled to node_count=0).
    // LLM-extracted CONFIG_VALUE nodes omit sourceFile and keep the pre-existing branch+name
    // key so writeConfigValueRefEdges' by-name matching is unaffected.
    case 'CONFIG_VALUE':
      return sourceFile ? `${branchId}::${safe}::${sourceFile}` : `${branchId}::${safe}`;
    case 'ENDPOINT':
    case 'SERVICE':
    case 'REPOSITORY':
    case 'SCHEDULER':       return `${branchId}::${safe}`;
    // IMPORT previously fell
    // through to the branch-global key below, colliding every file that imports the
    // same name onto one surviving row via ON CONFLICT (56% of emitted IMPORT nodes
    // were discarded on the E4 corpus) and misattributing the survivor's file_id/
    // start_line to whichever file happened to import that name first. File-qualified
    // exactly like METHOD/CLASS; LLM-extracted IMPORT nodes (if any) omit sourceFile
    // and keep the old branch+name key so nothing already relying on it churns.
    case 'IMPORT':
      return sourceFile
        ? `${branchId}::IMPORT::${sourceFile}::${safe}`
        : `${branchId}::IMPORT::${safe}`;
    // CONSTANT had the same defect IMPORT had, and worse. It fell through to the branch-global
    // key below, so every file declaring a same-named constant collapsed onto one row and the
    // rest were discarded by the ON CONFLICT upsert.
    //
    // Many files declare a same-named constant, so a branch-global key collapses them onto one
    // row and discards the rest. File-qualifying recovers all but the `#ifdef` variants that
    // declare one name twice in one file, which is the conditional-compilation case
    // deliberately not fixed.
    case 'CONSTANT':
      return sourceFile
        ? `${branchId}::CONSTANT::${sourceFile}::${safe}`
        : `${branchId}::CONSTANT::${safe}`;
    // A caller that supplies no ownerQualifier (LLM-extracted nodes, legacy callers) keeps
    // the pre-existing key shape exactly, so nothing already relying on it churns.
    case 'METHOD':
      if (!sourceFile) return `${branchId}::METHOD::${safe}`;
      return ownerQualifier
        ? `${branchId}::METHOD::${sourceFile}::${ownerQualifier}::${safe}`
        : `${branchId}::METHOD::${sourceFile}::${safe}`;
    // CLASS must not fall through to the branch-global default below — two files declaring
    // `class Config` would be ONE node, the second write silently overwriting the first via
    // the canonical_key ON CONFLICT upsert. Nearly every structural extractor emits CLASS, so
    // this collision is systemic without file-qualifying. File-qualified exactly like METHOD;
    // LLM-extracted CLASS/ENTITY nodes that omit sourceFile keep the old branch+name key so
    // nothing already relying on it churns.
    // ownerQualifier here is the CONTAINER — the enclosing module/impl/function a nested type is
    // declared in. Without it `mod remote { struct S }` and a top-level `struct S` produce the same
    // key and the second silently overwrites the first on the ON CONFLICT upsert. A top-level class
    // has no container and keeps its key byte-identical, so nothing already in a graph churns.
    //
    // Line is deliberately NOT part of this key: it would churn every canonical key on any edit
    // above the declaration and break incremental ingest's ability to recognise an unchanged one.
    case 'CLASS':
      if (!sourceFile) return `${branchId}::CLASS::${safe}`;
      return ownerQualifier
        ? `${branchId}::CLASS::${sourceFile}::${ownerQualifier}::${safe}`
        : `${branchId}::CLASS::${sourceFile}::${safe}`;
    // FIELD needs BOTH the file and the owning class: `name`, `id` and `type` recur in almost
    // every class of a real codebase, so a branch-global or even file-global key would collapse
    // them onto one row via the ON CONFLICT upsert exactly as METHOD would without its owner.
    // ownerQualifier carries the declaring class (see stampFieldIdentities).
    case 'FIELD':
      if (!sourceFile) return `${branchId}::FIELD::${safe}`;
      return ownerQualifier
        ? `${branchId}::FIELD::${sourceFile}::${ownerQualifier}::${safe}`
        : `${branchId}::FIELD::${sourceFile}::${safe}`;
    // Fallback covers stack-specific types (NODE_SERVICE, FLUTTER_SCREEN, etc.) so
    // re-ingesting the same branch updates existing nodes instead of duplicating them.
    default:                return `${branchId}::${nodeType}::${safe}`;
  }
}

// "% understood" coverage = extractable code files / total code files, rounded to 2dp.
// When there are no code files in the denominator, fall back to 100 if anything at all
// was extractable, else 0 (a truly empty graph).
function computeCoveragePct({ codeFilesCount, skippedCodeCount, extractableCount }) {
  if (codeFilesCount > 0) {
    return +(((codeFilesCount - skippedCodeCount) / codeFilesCount) * 100).toFixed(2);
  }
  return extractableCount > 0 ? 100 : 0;
}

// Resolve a config_deps entry (string or {key,name} object) against the configByName map.
// Returns the matching CONFIG_VALUE node id, or null if not found.
function resolveConfigRef(cfg, configByName) {
  const raw = typeof cfg === 'string' ? cfg : cfg?.key || cfg?.name || '';
  const r = String(raw).trim().toLowerCase();
  if (!r) return null;
  return configByName.get(r) ?? null;
}

module.exports = { validateExtractionNodes, computeCanonicalKey, computeMethodOwnerQualifier, computeMethodSignatureQualifier, stampMethodIdentities, computeCoveragePct, resolveConfigRef };
