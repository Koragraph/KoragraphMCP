// compose.js — deterministic (zero-token) reader for Docker Compose files.
//
// For the ICP — one developer, two or three repositories — the compose file IS the architecture
// diagram. It is the single artifact in the workspace that names every service, says which of
// them talk, and says what backing store they share. Nothing in the graph read it, so an agent
// looking at three repos saw three unrelated trees.
//
// This is a different join from the four transports already modelled. proto/thrift/openapi each
// describe ONE contract between two named ends. A compose file describes the whole topology at
// once, and the edges it carries are the ones static analysis structurally cannot see: service A
// reaches service B because B's compose service name resolves as a DNS hostname inside the
// network, which appears in A's source only as the string `${API_URL}`.
//
// THE THREE JOINS THIS FILE PRODUCES
// ----------------------------------
//   1. service -> service, inside the file. `depends_on`, and — the one that carries real
//      meaning — an environment value on A whose host is B's compose hostname. `serviceRefs`.
//   2. service -> repository. A compose file usually lives in one repo and orchestrates the
//      others, so the join that matters most is "which repo is this service". Three deterministic
//      signals are emitted per service as `repoHints`: the `build.context` directory, the image
//      repository name, and the service name. The resolver picks; this parser does not guess.
//   3. service -> external resource. A reference whose host is NOT a service in this file — a
//      managed database, an S3 bucket, a broker. Canonicalised by resource-ref.js so a second
//      repo's `.env` naming the same thing joins to it.
//
// THE MESS, HANDLED DELIBERATELY
// ------------------------------
//   * `docker-compose.override.yml`. Compose merges files in order with per-key rules that are
//     not "deep merge": lists like `ports` and `volumes` APPEND, maps like `environment` and
//     `depends_on` merge by key, scalars replace. `mergeComposeFiles` implements exactly that
//     and re-derives the joins from the merged result, because a ref that only becomes resolvable
//     after the override is applied is the common case, not the exotic one.
//   * `${VAR}` / `${VAR:-default}` / `${VAR:?required}` / `$$`. Expanded through
//     resource-ref.js#expandInterpolation against a caller-supplied lookup (the `.env` beside the
//     compose file). Unresolved variables are LEFT AS WRITTEN and reported in `requiredVars`,
//     which is itself a join: compose requires `DB_PASSWORD`, `.env.example` declares it.
//   * Both port spellings: `"8080:80"`, `"127.0.0.1:8080:80/udp"`, `"9090-9091:8080-8081"`, and
//     the long form `{target, published, protocol, mode}`.
//   * Compose v1 files, which have no `services:` key at all and put services at the top level.
//
// A `depends_on` naming a service the file does not define is not dropped — it lands in
// `danglingDependsOn`, because "the compose file expects a service nobody in this workspace has"
// is a finding, not a parse failure.

'use strict';

const path = require('path');
const yaml = require('js-yaml');
const { redactValue, referenceFrom, expandInterpolation, stripUserInfo } = require('./resource-ref');

const COMPOSE_BASENAME_RE = /^(?:docker-)?compose(?:[.-][A-Za-z0-9_.-]+)?\.ya?ml$/i;

function isComposePath(relPath) {
  return COMPOSE_BASENAME_RE.test(path.basename(relPath || ''));
}

const MAX_EXPANDED_PORTS = 64;

function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function expandRange(text) {
  const m = /^(\d+)-(\d+)$/.exec(text);
  if (!m) return /^\d+$/.test(text) ? [Number(text)] : [];
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (hi < lo || hi - lo + 1 > MAX_EXPANDED_PORTS) return [lo];
  const out = [];
  for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}

function parsePortString(spec) {
  let str = String(spec).trim();
  if (!str) return [];
  let protocol = 'tcp';
  const pm = /\/(tcp|udp|sctp)$/i.exec(str);
  if (pm) { protocol = pm[1].toLowerCase(); str = str.slice(0, pm.index); }

  let hostIp = null;
  const v6 = /^\[([0-9a-fA-F:]+)\]:(.*)$/.exec(str);
  if (v6) { hostIp = v6[1]; str = v6[2]; }

  const parts = str.split(':');
  let publishedRaw = null;
  let targetRaw = null;
  if (!v6 && parts.length === 3) { [hostIp, publishedRaw, targetRaw] = parts; }
  else if (parts.length === 2) { [publishedRaw, targetRaw] = parts; }
  else if (parts.length === 1) { [targetRaw] = parts; }
  else return [];

  const targets = expandRange(targetRaw);
  if (!targets.length) return [];
  const published = publishedRaw === null ? [] : expandRange(publishedRaw);
  return targets.map((target, i) => ({
    hostIp: hostIp || null,
    published: published.length ? (published[i] ?? published[0]) : null,
    target,
    protocol,
    mode: null,
  }));
}

function parsePorts(raw) {
  const out = [];
  for (const spec of asArray(raw)) {
    if (spec === null || spec === undefined) continue;
    if (typeof spec === 'object') {
      const target = Number(spec.target);
      if (!Number.isFinite(target)) continue;
      const published = spec.published === undefined || spec.published === null ? null : Number(String(spec.published).split('-')[0]);
      out.push({
        hostIp: spec.host_ip || null,
        published: Number.isFinite(published) ? published : null,
        target,
        protocol: (spec.protocol || 'tcp').toLowerCase(),
        mode: spec.mode || null,
      });
      continue;
    }
    out.push(...parsePortString(spec));
  }
  return out;
}

function parseDependsOn(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string').map((service) => ({ service, condition: null }));
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([service, cfg]) => ({
      service,
      condition: cfg && typeof cfg === 'object' ? (cfg.condition || null) : null,
    }));
  }
  return [];
}

// `environment` is either a map or a list of `KEY=VALUE`. A bare `KEY` in the list form means
// "pass through from the host environment" — the value is genuinely unknown, and recording it as
// the empty string would be a lie, so it is null with `passthrough: true`.
function parseEnvironment(raw) {
  const out = [];
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq === -1) out.push({ key: item.trim(), raw: null, passthrough: true });
      else out.push({ key: item.slice(0, eq).trim(), raw: item.slice(eq + 1), passthrough: false });
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) out.push({ key, raw: null, passthrough: true });
      else out.push({ key, raw: String(value), passthrough: false });
    }
  }
  return out;
}

function parseEnvFileList(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (typeof item === 'string') out.push({ path: item, required: true });
    else if (item && typeof item === 'object' && typeof item.path === 'string') {
      out.push({ path: item.path, required: item.required !== false });
    }
  }
  return out;
}

const BIND_SOURCE_RE = /^[.~/$]|^[A-Za-z]:[\\/]/;

function parseVolumes(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (item && typeof item === 'object') {
      out.push({
        source: item.source || null,
        target: item.target || null,
        type: item.type || (item.source && BIND_SOURCE_RE.test(item.source) ? 'bind' : 'volume'),
        readOnly: Boolean(item.read_only),
      });
      continue;
    }
    if (typeof item !== 'string') continue;
    const parts = item.split(':');
    if (parts.length === 1) { out.push({ source: null, target: parts[0], type: 'anonymous', readOnly: false }); continue; }
    const [source, target, mode] = parts;
    out.push({
      source,
      target: target || null,
      type: BIND_SOURCE_RE.test(source) ? 'bind' : 'volume',
      readOnly: mode === 'ro',
    });
  }
  return out;
}

function parseNetworks(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((n) => typeof n === 'string').map((name) => ({ name, aliases: [] }));
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([name, cfg]) => ({
      name,
      aliases: cfg && typeof cfg === 'object' ? asArray(cfg.aliases).filter((a) => typeof a === 'string') : [],
    }));
  }
  return [];
}

function parseBuild(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { context: raw, dockerfile: null, target: null };
  if (typeof raw === 'object') {
    return {
      context: typeof raw.context === 'string' ? raw.context : null,
      dockerfile: typeof raw.dockerfile === 'string' ? raw.dockerfile : null,
      target: typeof raw.target === 'string' ? raw.target : null,
    };
  }
  return null;
}

// `myorg/checkout-service:1.2` -> repository `myorg/checkout-service`, tag `1.2`.
function parseImageRef(image) {
  if (typeof image !== 'string' || !image.trim()) return null;
  let rest = image.trim();
  let digest = null;
  const at = rest.indexOf('@');
  if (at !== -1) { digest = rest.slice(at + 1); rest = rest.slice(0, at); }
  let tag = null;
  const lastColon = rest.lastIndexOf(':');
  const lastSlash = rest.lastIndexOf('/');
  if (lastColon > lastSlash) { tag = rest.slice(lastColon + 1); rest = rest.slice(0, lastColon); }
  const firstSlash = rest.indexOf('/');
  const maybeRegistry = firstSlash === -1 ? null : rest.slice(0, firstSlash);
  const isRegistry = Boolean(maybeRegistry) && (maybeRegistry.includes('.') || maybeRegistry.includes(':') || maybeRegistry === 'localhost');
  const repository = isRegistry ? rest.slice(firstSlash + 1) : rest;
  return {
    registry: isRegistry ? maybeRegistry : null,
    repository,
    tag,
    digest,
    // A Docker Official Image has no registry and no namespace — `postgres`, `redis`, `nginx`.
    // That is a structural property of the reference, not a curated list, and it is the only
    // honest way to know an image will never name a repository in the user's workspace.
    official: !isRegistry && !repository.includes('/'),
  };
}

function normalizeContext(context) {
  if (typeof context !== 'string') return null;
  const cleaned = context.trim().replace(/\/+$/, '');
  if (!cleaned || cleaned === '.') return '.';
  return cleaned.replace(/^\.\//, '');
}

function repoHintsFor(service) {
  const hints = [];
  const ctx = service.build ? normalizeContext(service.build.context) : null;
  if (ctx && ctx !== '.') hints.push({ kind: 'build_context', value: ctx });
  if (service.imageRef && service.imageRef.repository && !service.imageRef.official && !service.build) {
    hints.push({ kind: 'image', value: service.imageRef.repository });
  }
  hints.push({ kind: 'service_name', value: service.name });
  return hints;
}

// ─── Line numbers ─────────────────────────────────────────────────────────────
//
// js-yaml gives no positions, and `contract-config.js` sets `line: null` for every YAML entry
// rather than inventing one. A service is the one thing here worth an evidence line, and it is
// recoverable without a second parser: it is the only key at the `services:` block's own indent.
function serviceLineIndex(content) {
  const out = new Map();
  const lines = String(content || '').split(/\r\n|\r|\n/);
  let inServices = false;
  let baseIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.replace(/^[ \t]*/, '').length;
    if (/^services\s*:\s*$/.test(line)) { inServices = true; baseIndent = null; continue; }
    if (!inServices) continue;
    if (indent === 0) { inServices = false; continue; }
    if (baseIndent === null) baseIndent = indent;
    if (indent !== baseIndent) continue;
    const m = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*:/.exec(line);
    if (m && !out.has(m[1])) out.set(m[1], i + 1);
  }
  return out;
}

// ─── Derivation ───────────────────────────────────────────────────────────────

const URL_IN_TEXT_RE = /\b([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s"',;)]+)/g;

const VAR_IN_TEXT_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*/g;

// `value` being redacted is not enough — `raw` is the same secret with the quoting still on it.
// What survives is only the VARIABLE NAMES, which are not secrets and are the thing `requiredVars`
// is built from; every literal in a redacted value is dropped. Keeping the names also makes this
// idempotent, so `mergeComposeFiles` re-deriving over an already-redacted entry loses nothing.
function redactRaw(raw) {
  const found = String(raw).match(VAR_IN_TEXT_RE);
  if (!found) return null;
  return found.map((v) => (v.startsWith('${') ? `${v}}` : v)).join(' ');
}

function hostnamesOf(service) {
  const names = new Set([service.name]);
  if (service.containerName) names.add(service.containerName);
  if (service.hostname) names.add(service.hostname);
  for (const net of service.networks) for (const alias of net.aliases) names.add(alias);
  return names;
}

/**
 * deriveComposeFacts(services, opts) -> {serviceRefs, refs, sharedMounts, danglingDependsOn,
 *                                        requiredVars, services}
 *
 * Separated from `parseCompose` because `mergeComposeFiles` must re-run it: an override file
 * routinely supplies the environment value that makes a reference resolvable, so deriving before
 * the merge would record a resolvable link as unresolved.
 */
function deriveComposeFacts(services, opts = {}) {
  const lookup = opts.lookup instanceof Map ? opts.lookup
    : (opts.lookup ? new Map(Object.entries(opts.lookup)) : null);

  const hostOwner = new Map();
  for (const service of services) {
    for (const host of hostnamesOf(service)) {
      if (!hostOwner.has(host.toLowerCase())) hostOwner.set(host.toLowerCase(), service.name);
    }
  }

  const serviceRefs = [];
  const refs = [];
  const requiredVars = new Map();
  const danglingDependsOn = [];
  const seenServiceRef = new Set();
  const seenRef = new Set();

  const noteVars = (vars) => {
    for (const v of vars) {
      if (v.resolved) continue;
      const prior = requiredVars.get(v.name);
      if (!prior) requiredVars.set(v.name, { name: v.name, required: v.required, default: v.default });
      else if (v.required) prior.required = true;
    }
  };

  const addServiceRef = (rec) => {
    const key = `${rec.from}|${rec.to}|${rec.via}|${rec.key || ''}|${rec.port ?? ''}`;
    if (seenServiceRef.has(key)) return;
    seenServiceRef.add(key);
    serviceRefs.push(rec);
  };

  const addRef = (rec) => {
    const key = `${rec.service}|${rec.canonical || rec.weakKey}|${rec.key || ''}`;
    if (seenRef.has(key)) return;
    seenRef.add(key);
    refs.push(rec);
  };

  for (const service of services) {
    const own = hostnamesOf(service);

    for (const dep of service.dependsOn) {
      if (hostOwner.has(dep.service.toLowerCase())) {
        addServiceRef({ from: service.name, to: dep.service, via: 'depends_on', key: null, scheme: null, port: null, canonical: null, condition: dep.condition, line: service.line });
      } else {
        danglingDependsOn.push({ from: service.name, service: dep.service, line: service.line });
      }
    }

    // Resolve every environment value before looking for references: `DB_HOST` needs `DB_PORT`,
    // and nothing guarantees the port is written first.
    const expanded = new Map();
    for (const entry of service.environment) {
      // raw === null without passthrough means a prior derive already redacted it away — there is
      // nothing left to expand, and it must not come back as an un-redacted empty value.
      if (entry.passthrough || entry.raw === null) {
        entry.value = null;
        entry.resolved = true;
        entry.redacted = !entry.passthrough;
        continue;
      }
      const exp = expandInterpolation(entry.raw, lookup);
      noteVars(exp.vars);
      const red = redactValue(entry.key, exp.value, { strict: false });
      entry.resolved = exp.resolved;
      entry.redacted = red.redacted;
      entry.value = red.value;
      entry.raw = red.redacted
        ? (red.reason === 'userinfo' ? stripUserInfo(entry.raw) : redactRaw(entry.raw))
        : entry.raw;
      expanded.set(entry.key, { exp, red });
    }

    const portOf = (key) => {
      const sibling = expanded.get(key.replace(/(HOST|HOSTNAME|ADDR|ADDRESS|SERVER)$/i, 'PORT'));
      const n = sibling && sibling.exp.resolved ? Number(sibling.exp.value) : NaN;
      return Number.isFinite(n) ? n : null;
    };

    for (const entry of service.environment) {
      const slot = expanded.get(entry.key);
      if (!slot) continue;
      const { exp, red } = slot;
      if (red.redacted && red.reason !== 'userinfo') continue;
      // Not gated on `exp.resolved`: referenceFrom refuses a value that still carries a variable
      // AFTER the credentials are removed, which is the distinction that matters — an unexpanded
      // password does not stop `postgres://…@db:5432/shopdb` from naming a database.
      const ref = referenceFrom(entry.key, stripUserInfo(exp.value), { siblingPort: portOf(entry.key) });
      if (!ref) continue;
      const target = ref.host ? hostOwner.get(ref.host) : null;
      if (target && !own.has(ref.host)) {
        addServiceRef({ from: service.name, to: target, via: 'environment', key: entry.key, scheme: ref.scheme, port: ref.port, canonical: ref.canonical, condition: null, line: service.line });
      } else if (!target) {
        addRef({ ...ref, service: service.name, via: 'environment', line: service.line });
      }
    }

    for (const text of [service.command, service.entrypoint].filter((t) => typeof t === 'string')) {
      URL_IN_TEXT_RE.lastIndex = 0;
      let m;
      while ((m = URL_IN_TEXT_RE.exec(text)) !== null) {
        const exp = expandInterpolation(m[0], lookup);
        noteVars(exp.vars);
        const ref = referenceFrom(null, exp.value, {});
        if (!ref) continue;
        const target = ref.host ? hostOwner.get(ref.host) : null;
        if (target && !own.has(ref.host)) {
          addServiceRef({ from: service.name, to: target, via: 'command', key: null, scheme: ref.scheme, port: ref.port, canonical: ref.canonical, condition: null, line: service.line });
        } else if (!target) {
          addRef({ ...ref, service: service.name, via: 'command', line: service.line });
        }
      }
    }
  }

  // Two services on the same named volume or the same host path are looking at one piece of
  // state. For the ICP this is how "a shared database" usually appears when the database is a
  // compose service with a data volume — and how a shared upload directory always appears.
  const mounts = new Map();
  for (const service of services) {
    for (const vol of service.volumes) {
      if (!vol.source) continue;
      const key = `${vol.type}:${vol.source}`;
      if (!mounts.has(key)) mounts.set(key, { source: vol.source, type: vol.type, services: [] });
      const rec = mounts.get(key);
      if (!rec.services.includes(service.name)) rec.services.push(service.name);
    }
  }
  const sharedMounts = [...mounts.values()].filter((m) => m.services.length > 1);

  return { serviceRefs, refs, sharedMounts, danglingDependsOn, requiredVars: [...requiredVars.values()] };
}

// ─── Entry points ─────────────────────────────────────────────────────────────

function normalizeService(name, spec, line) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const image = typeof s.image === 'string' ? s.image : null;
  return {
    name,
    line,
    image,
    imageRef: parseImageRef(image),
    build: parseBuild(s.build),
    ports: parsePorts(s.ports),
    expose: asArray(s.expose).map((p) => Number(p)).filter(Number.isFinite),
    dependsOn: parseDependsOn(s.depends_on),
    environment: parseEnvironment(s.environment),
    envFiles: parseEnvFileList(s.env_file),
    volumes: parseVolumes(s.volumes),
    networks: parseNetworks(s.networks),
    containerName: typeof s.container_name === 'string' ? s.container_name : null,
    hostname: typeof s.hostname === 'string' ? s.hostname : null,
    command: typeof s.command === 'string' ? s.command : (Array.isArray(s.command) ? s.command.filter((x) => typeof x === 'string').join(' ') : null),
    entrypoint: typeof s.entrypoint === 'string' ? s.entrypoint : (Array.isArray(s.entrypoint) ? s.entrypoint.filter((x) => typeof x === 'string').join(' ') : null),
    extendsRef: s.extends && typeof s.extends === 'object'
      ? { file: s.extends.file || null, service: s.extends.service || null }
      : null,
    repoHints: [],
  };
}

// Compose v1: no `services:` key, services are the top-level mapping. Recognised only when every
// top-level value looks like a service, so an unrelated YAML that happens to sit at a
// compose-shaped filename is still rejected.
function looksLikeV1(doc) {
  const values = Object.values(doc);
  if (!values.length) return false;
  return values.every((v) => v && typeof v === 'object' && !Array.isArray(v)
    && ('image' in v || 'build' in v || 'ports' in v || 'environment' in v));
}

/**
 * parseCompose(relPath, content, opts) -> compose facts | null
 *
 * `null` for a path this parser does not own, and for a compose-named YAML with no service map —
 * the same "not mine" signal `manifest.js` uses. Never throws.
 *
 * opts.lookup — variable values for `${VAR}` expansion, normally the parsed `.env` sitting beside
 * the compose file. Supplied by the caller after its own sweep, the shape `topic-facts.js` uses
 * for `opts.bindings`.
 */
function parseCompose(relPath, content, opts = {}) {
  if (typeof content !== 'string' || !content.trim()) return null;
  if (!isComposePath(relPath)) return null;

  try {
    const doc = yaml.load(content, { json: true });
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;

    let serviceMap = null;
    if (doc.services && typeof doc.services === 'object' && !Array.isArray(doc.services)) serviceMap = doc.services;
    else if (!('services' in doc) && !('version' in doc) && looksLikeV1(doc)) serviceMap = doc;
    if (!serviceMap) return null;

    const lineIndex = serviceLineIndex(content);
    const services = Object.entries(serviceMap)
      .filter(([, spec]) => spec === null || typeof spec === 'object')
      .map(([name, spec]) => normalizeService(name, spec, lineIndex.get(name) ?? null));
    for (const service of services) service.repoHints = repoHintsFor(service);

    const derived = deriveComposeFacts(services, opts);

    return {
      kind: 'compose',
      file: relPath || null,
      version: typeof doc.version === 'string' ? doc.version : null,
      name: typeof doc.name === 'string' ? doc.name : null,
      services,
      volumeNames: doc.volumes && typeof doc.volumes === 'object' ? Object.keys(doc.volumes) : [],
      networkNames: doc.networks && typeof doc.networks === 'object' ? Object.keys(doc.networks) : [],
      ...derived,
    };
  } catch (_) {
    return null;
  }
}

// Compose's documented merge rules, which are per-key and not a deep merge:
//   append & dedupe   ports, expose, volumes, env_file, networks
//   merge by key      environment, depends_on
//   replace           every scalar, build, command, entrypoint, image
const ADDITIVE_KEYS = ['ports', 'expose', 'volumes', 'networks', 'envFiles'];

function mergeService(base, over) {
  const merged = { ...base };
  for (const key of ['image', 'imageRef', 'build', 'containerName', 'hostname', 'command', 'entrypoint', 'extendsRef']) {
    if (over[key] !== null && over[key] !== undefined) merged[key] = over[key];
  }
  if (over.line !== null && base.line === null) merged.line = over.line;

  for (const key of ADDITIVE_KEYS) {
    const seen = new Set();
    merged[key] = [...base[key], ...over[key]].filter((item) => {
      const id = typeof item === 'object' ? JSON.stringify(item) : String(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  const envByKey = new Map(base.environment.map((e) => [e.key, e]));
  for (const e of over.environment) envByKey.set(e.key, e);
  merged.environment = [...envByKey.values()];

  const depByName = new Map(base.dependsOn.map((d) => [d.service, d]));
  for (const d of over.dependsOn) depByName.set(d.service, d);
  merged.dependsOn = [...depByName.values()];

  merged.repoHints = repoHintsFor(merged);
  return merged;
}

/**
 * mergeComposeFiles(parsedList, opts) -> compose facts | null
 *
 * Files must be given in the order Compose would apply them — the base first, the override last.
 * Derived facts are recomputed from the merged services rather than unioned, because an override
 * that supplies a hostname turns an unresolved reference into a resolved one, and unioning the
 * pre-merge derivations would keep the unresolved copy.
 */
function mergeComposeFiles(parsedList, opts = {}) {
  const inputs = (parsedList || []).filter((p) => p && p.kind === 'compose');
  if (!inputs.length) return null;
  if (inputs.length === 1) return inputs[0];

  const byName = new Map();
  for (const parsed of inputs) {
    for (const service of parsed.services) {
      const prior = byName.get(service.name);
      byName.set(service.name, prior ? mergeService(prior, service) : service);
    }
  }
  const services = [...byName.values()];
  const derived = deriveComposeFacts(services, opts);

  return {
    kind: 'compose',
    file: inputs.map((p) => p.file).filter(Boolean).join(','),
    files: inputs.map((p) => p.file),
    version: inputs.map((p) => p.version).filter(Boolean).pop() || null,
    name: inputs.map((p) => p.name).filter(Boolean).pop() || null,
    services,
    volumeNames: [...new Set(inputs.flatMap((p) => p.volumeNames))],
    networkNames: [...new Set(inputs.flatMap((p) => p.networkNames))],
    ...derived,
  };
}

module.exports = {
  parseCompose,
  mergeComposeFiles,
  deriveComposeFacts,
  isComposePath,
  parsePortString,
  parseImageRef,
};
