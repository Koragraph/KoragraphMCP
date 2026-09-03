// resource-ref.js — the join key for the config/infra plane.
//
// The other contract parsers each own a globally unique string that both ends of a cross-repo
// join produce independently: proto has the gRPC wire path, thrift has `<Service>.<method>`,
// manifest has `group:artifact`, openapi has `METHOD /path`. The config/infra plane had none —
// a `DATABASE_URL` in one repo's `.env` and a `postgres` service in another repo's compose file
// are the same database, and nothing in the graph could say so.
//
// This file mints that string. `postgres://db:5432/appdb` is the canonical form: scheme,
// host, port, dbname — lowercased, default port filled in, credentials removed. Two repos that
// independently produce it share a database.
//
// TWO KEYS, BECAUSE THE HOSTNAME IS THE PART THAT DISAGREES
// ---------------------------------------------------------
// The ICP's actual shape: `docker-compose.yml` says `postgres://db:5432/appdb` (a compose
// service name) while each service's `.env.example` says `postgres://localhost:5432/appdb`
// (a developer's machine). Same database, different host. So every reference carries:
//   canonical — scheme://host:port/path, exact, high confidence
//   weakKey   — scheme:path, host-independent, lower confidence
// A resolver joins on `canonical` first and falls back to `weakKey`; both are recorded so the
// confidence of an edge is a property of which one matched, not a guess after the fact.
// `weakKey` is deliberately null for the http class — there the path is a route, and routes
// already join to ENDPOINT nodes through the existing HTTP plane.
//
// REDACTION
// ---------
// A `.env` is the one file in a repository that is all secrets. No credential ever reaches a
// fact: URL userinfo is stripped before anything else looks at the string, and a value is
// dropped whenever its KEY names a credential or its SHAPE is one. Over-redaction is the safe
// direction and is taken deliberately — `*_KEY` is redacted even though `SORT_KEY` is harmless.
// Deliberately NOT emitted: any hash or fingerprint of a redacted value. It would make "these
// two repos share a signing key" joinable, but a truncated digest of a low-entropy secret is
// brute-forceable, and a parser that never sees a reason to keep the value should not keep a
// derivative of it either.

'use strict';

const DEFAULT_PORTS = {
  postgres: 5432, postgresql: 5432, cockroachdb: 26257, timescaledb: 5432,
  mysql: 3306, mariadb: 3306, sqlserver: 1433, mssql: 1433, oracle: 1521, db2: 50000,
  mongodb: 27017, 'mongodb+srv': 27017, cassandra: 9042, clickhouse: 8123, influxdb: 8086,
  redis: 6379, rediss: 6379, memcached: 11211, etcd: 2379,
  amqp: 5672, amqps: 5671, kafka: 9092, nats: 4222, pulsar: 6650, mqtt: 1883, stomp: 61613,
  http: 80, https: 443, ws: 80, wss: 443,
  elasticsearch: 9200, opensearch: 9200,
  ftp: 21, sftp: 22, smtp: 25, smtps: 465, ldap: 389,
};

const SCHEME_CLASS = {
  postgres: 'database', postgresql: 'database', cockroachdb: 'database', timescaledb: 'database',
  mysql: 'database', mariadb: 'database', sqlserver: 'database', mssql: 'database',
  oracle: 'database', db2: 'database', sqlite: 'database', mongodb: 'database',
  'mongodb+srv': 'database', cassandra: 'database', clickhouse: 'database', influxdb: 'database',
  redis: 'cache', rediss: 'cache', memcached: 'cache', etcd: 'cache',
  amqp: 'broker', amqps: 'broker', kafka: 'broker', nats: 'broker', pulsar: 'broker',
  mqtt: 'broker', stomp: 'broker', sqs: 'broker', sns: 'broker',
  http: 'http', https: 'http', ws: 'http', wss: 'http', grpc: 'http', grpcs: 'http',
  s3: 'bucket', gs: 'bucket', gcs: 'bucket', azblob: 'bucket', minio: 'bucket',
  elasticsearch: 'search', opensearch: 'search',
};

// One resource, two spellings. `postgresql://` and `postgres://` are the same database and must
// produce the same key or the join silently fails — measured against a real GitHub Actions
// workflow whose job env said `postgresql://` while the compose file beside it said `postgres://`.
// Only aliases that name the SAME product are listed: `mariadb` is not folded into `mysql` and
// `cockroachdb` is not folded into `postgres`, protocol compatibility notwithstanding.
const SCHEME_ALIASES = {
  postgresql: 'postgres', psql: 'postgres', pgsql: 'postgres',
  'mongodb+srv': 'mongodb',
  rediss: 'redis',
  amqps: 'amqp', rabbitmq: 'amqp',
  mssql: 'sqlserver',
  gcs: 'gs',
  opensearch: 'elasticsearch',
};

function canonicalScheme(scheme) {
  if (!scheme) return null;
  const s = String(scheme).toLowerCase();
  return SCHEME_ALIASES[s] || s;
}

// A host that names the developer's own machine joins nothing across repos — every repo says
// `localhost`. Such a reference still carries a weakKey, which is the whole reason weakKey exists.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal', 'docker.for.mac.localhost']);

function schemeClass(scheme) {
  if (!scheme) return 'other';
  const s = String(scheme).toLowerCase();
  return SCHEME_CLASS[s] || SCHEME_CLASS[canonicalScheme(s)] || 'other';
}

// `scheme://[user[:pass]@]host[:port][/path][?query]`, tolerant of an unexpanded `${VAR}` and of
// a comma-separated host list (a MongoDB replica set / Kafka broker list — the first host is
// taken and `hostCount` records that there were more).
const URLISH_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^/@\s]*)@)?([^/?#\s]*)(?:\/([^?#\s]*))?/;

function splitHostPort(authority) {
  if (!authority) return { host: null, port: null };
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const idx = authority.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(authority.slice(idx + 1))) {
    return { host: authority.slice(0, idx), port: Number(authority.slice(idx + 1)) };
  }
  return { host: authority, port: null };
}

function parseUrlish(raw) {
  const m = URLISH_RE.exec(raw);
  if (!m) return null;
  const authorities = (m[3] || '').split(',').filter(Boolean);
  const { host, port } = splitHostPort(authorities[0] || '');
  return {
    scheme: m[1].toLowerCase(),
    host: host || null,
    port,
    path: m[4] || null,
    hostCount: authorities.length || 0,
    hadCredentials: Boolean(m[2]),
  };
}

// libpq (`host=x port=5432 dbname=app`) and ADO.NET (`Server=x;Database=app;`) key-value DSNs.
const DSN_ALIASES = {
  host: 'host', server: 'host', 'data source': 'host', datasource: 'host', addr: 'host', address: 'host',
  port: 'port',
  dbname: 'path', database: 'path', 'initial catalog': 'path', db: 'path',
};

function parseKeyValueDsn(raw) {
  // Split on `;` when there is one. ADO.NET keys contain spaces (`Initial Catalog=shopdb`), so a
  // whitespace split loses the database name — the only field of that string worth having.
  const pairs = (raw.includes(';') ? raw.split(';') : raw.split(/\s+/)).map((s) => s.trim()).filter(Boolean);
  if (pairs.length < 2) return null;
  const out = {};
  let seen = 0;
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    seen++;
    const target = DSN_ALIASES[key];
    if (!target || !value) continue;
    if (target === 'port') out.port = /^\d+$/.test(value) ? Number(value) : null;
    else out[target] = value;
  }
  if (seen < 2 || (!out.host && !out.path)) return null;
  // A key-value DSN names no scheme. `Initial Catalog` is SQL Server's spelling and nothing
  // else's; everything else is left unnamed rather than guessed.
  const scheme = /initial catalog|integrated security|trustservercertificate/i.test(raw) ? 'sqlserver' : null;
  return { scheme, host: out.host || null, port: out.port ?? null, path: out.path || null, hostCount: out.host ? 1 : 0, hadCredentials: /password|pwd/i.test(raw) };
}

// `jdbc:postgresql://host:5432/db` and `jdbc:sqlserver://host;databaseName=db`.
function parseJdbc(raw) {
  const m = /^jdbc:([a-z0-9+.-]+):(.*)$/i.exec(raw);
  if (!m) return null;
  const sub = m[2];
  const parsed = sub.startsWith('//')
    ? parseUrlish(`${m[1]}:${sub}`)
    : parseKeyValueDsn(sub);
  if (!parsed) return null;
  const dbName = /(?:databaseName|database)=([^;\s]+)/i.exec(sub);
  return { ...parsed, scheme: m[1].toLowerCase(), path: parsed.path || (dbName ? dbName[1] : null), dialect: 'jdbc' };
}

function parseConnectionString(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  return parseJdbc(s) || parseUrlish(s) || parseKeyValueDsn(s);
}

// Strip `user:pass@` from a URL. Runs before any value is stored, kept or compared.
function stripUserInfo(raw) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/, '$1');
}

function normalizeRef(parts) {
  const rawScheme = parts.scheme ? String(parts.scheme).toLowerCase() : null;
  const scheme = canonicalScheme(rawScheme);
  const host = parts.host ? String(parts.host).toLowerCase() : null;
  const port = Number.isFinite(parts.port) ? parts.port
    : (scheme && DEFAULT_PORTS[scheme] !== undefined ? DEFAULT_PORTS[scheme]
      : (rawScheme && DEFAULT_PORTS[rawScheme] !== undefined ? DEFAULT_PORTS[rawScheme] : null));
  const path = parts.path ? String(parts.path).replace(/^\/+/, '').replace(/\/+$/, '').split('?')[0] : null;
  const cls = schemeClass(scheme);
  // No host, no canonical. `POSTGRES_DB=shopdb` genuinely names a database and joins on weakKey;
  // giving it a canonical with a placeholder host would let two unrelated repos match on `?` at
  // the high-confidence key, which is the one join a resolver is entitled to trust.
  const canonical = host ? `${scheme || '?'}://${host}${port != null ? `:${port}` : ''}${path ? `/${path}` : ''}` : null;
  // For http the path is a route, not a resource name — the existing HTTP plane already joins
  // routes to ENDPOINT nodes, so a host-independent key here would be a duplicate, worse channel.
  const weakKey = cls === 'http' || !path ? null : `${scheme || '?'}:${path}`;
  return {
    canonical,
    weakKey,
    scheme,
    rawScheme,
    host,
    port,
    path,
    class: cls,
    local: host ? LOCAL_HOSTS.has(host) : false,
    hostCount: parts.hostCount ?? (host ? 1 : 0),
  };
}

// ─── Redaction ────────────────────────────────────────────────────────────────

// `auth` and `cert` are deliberately absent: `AUTH_URL` and `CERT_PATH` are references worth
// keeping, and the credential spellings they would have caught (`AUTH_TOKEN`, a PEM body) are
// already caught by `token` and by the value-shape checks below.
const SECRET_KEY_RE = /(?:^|[_.-])(?:secret|secrets|password|passwd|pwd|passphrase|token|tokens|apikey|credential|credentials|salt|signing|privatekey|key|keys|dsn)(?:$|[_.-])/i;

const SECRET_VALUE_RES = [
  /^-----BEGIN [A-Z0-9 ]+-----/,
  /^(?:sk|pk|rk)[-_][A-Za-z0-9_]{16,}/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^xox[baprs]-/,
  /^AKIA[0-9A-Z]{16}$/,
  /^ya29\./,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
  /^[0-9a-f]{32,}$/i,
];

const SAFE_SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]{0,63}$/;
const BOOLISH_RE = /^(?:true|false|yes|no|on|off|null|none|debug|info|warn|error|development|production|staging|test)$/i;
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;
const MAX_KEPT_VALUE_CHARS = 512;

function isSecretKey(key) {
  // `_KEY` is redacted wholesale. A false positive costs a value nobody needed; a false negative
  // puts a credential in the graph.
  return SECRET_KEY_RE.test(String(key || '').replace(/[A-Z]+(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])/g, '_'));
}

function looksSecret(value) {
  const v = String(value || '');
  return SECRET_VALUE_RES.some((re) => re.test(v));
}

/**
 * redactValue(key, value, {strict}) -> {value, redacted, reason}
 *
 * `strict` is for a real `.env` — a file whose entire purpose is to hold secrets. There a value
 * survives only when it is recognisably structural (a reference, a number, a boolean, a short
 * plain token). Non-strict is for `.env.example` and a committed compose file, where the key and
 * shape checks alone are the right level.
 */
function redactValue(key, value, opts = {}) {
  const strict = Boolean(opts.strict);
  if (value === null || value === undefined) return { value: null, redacted: false, reason: null };
  const raw = String(value);
  if (raw === '') return { value: '', redacted: false, reason: null };
  if (isSecretKey(key)) return { value: null, redacted: true, reason: 'secret_key' };
  if (looksSecret(raw)) return { value: null, redacted: true, reason: 'secret_shape' };
  if (raw.length > MAX_KEPT_VALUE_CHARS) return { value: null, redacted: true, reason: 'oversize' };
  const safe = stripUserInfo(raw);
  if (!strict) return { value: safe, redacted: safe !== raw, reason: safe !== raw ? 'userinfo' : null };
  if (parseConnectionString(raw)) return { value: safe, redacted: safe !== raw, reason: safe !== raw ? 'userinfo' : null };
  if (NUMERIC_RE.test(raw) || BOOLISH_RE.test(raw)) return { value: raw, redacted: false, reason: null };
  if (SAFE_SCALAR_RE.test(raw)) return { value: raw, redacted: false, reason: null };
  return { value: null, redacted: true, reason: 'strict_unrecognised' };
}

// ─── Reference extraction ─────────────────────────────────────────────────────

// Keys that name half of a reference on their own. `DB_HOST` + `DB_PORT` is the second most
// common way the ICP's repos point at the same database, after a single URL.
const HOST_KEY_RE = /(?:^|_)(HOST|HOSTNAME|ADDR|ADDRESS|ENDPOINT|SERVER|BROKER|BROKERS|URI|URL)$/i;
const PORT_KEY_RE = /(?:^|_)PORT$/i;
const NAME_KEY_RE = /(?:^|_)(BUCKET|TOPIC|QUEUE|DATABASE|DB|DBNAME|SCHEMA|INDEX|NAMESPACE|CHANNEL|STREAM)$/i;

// Scheme guessed from the key prefix when the value carries none: `REDIS_HOST=cache`.
const SCHEME_BY_KEY = [
  [/(^|_)(POSTGRES|POSTGRESQL|PG|PSQL)(_|$)/i, 'postgres'],
  [/(^|_)(MYSQL|MARIADB)(_|$)/i, 'mysql'],
  [/(^|_)(MONGO|MONGODB)(_|$)/i, 'mongodb'],
  [/(^|_)(REDIS)(_|$)/i, 'redis'],
  [/(^|_)(MEMCACHED?)(_|$)/i, 'memcached'],
  [/(^|_)(KAFKA)(_|$)/i, 'kafka'],
  [/(^|_)(RABBIT|RABBITMQ|AMQP)(_|$)/i, 'amqp'],
  [/(^|_)(NATS)(_|$)/i, 'nats'],
  [/(^|_)(PULSAR)(_|$)/i, 'pulsar'],
  [/(^|_)(ELASTIC|ELASTICSEARCH|OPENSEARCH)(_|$)/i, 'elasticsearch'],
  [/(^|_)(S3|MINIO)(_|$)/i, 's3'],
  [/(^|_)(CLICKHOUSE)(_|$)/i, 'clickhouse'],
  [/(^|_)(CASSANDRA)(_|$)/i, 'cassandra'],
];

function schemeFromKey(key) {
  const k = String(key || '');
  for (const [re, scheme] of SCHEME_BY_KEY) if (re.test(k)) return scheme;
  return null;
}

const BARE_HOST_PORT_RE = /^([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?|\[[0-9a-fA-F:]+\]):(\d{2,5})$/;
const BARE_HOST_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

/**
 * referenceFrom(key, value, opts) -> normalized reference | null
 *
 * `opts.siblingPort` supplies the value of the matching `*_PORT` key so a `*_HOST` entry can
 * canonicalise to the same string a URL would. `opts.provenance` is carried through unchanged so
 * a wrong edge traces back to the rule that made it, the same way topic-facts records how a topic
 * name was reached.
 */
function referenceFrom(key, value, opts = {}) {
  if (typeof value !== 'string') return null;
  // Userinfo goes first, not just for redaction: `postgres://shop:${DB_PASSWORD}@db:5432/shopdb`
  // is the single most common form of the ICP's shared-database link, and the only unresolved
  // variable in it sits in the credential — the one part the join key never uses. Bailing on the
  // `${` before stripping would throw that edge away.
  const raw = stripUserInfo(value.trim());
  if (!raw || raw.includes('${') || raw.includes('$(') || /\$[A-Za-z_]/.test(raw)) return null;

  const parsed = parseConnectionString(raw);
  if (parsed && parsed.scheme && parsed.host) {
    return { ...normalizeRef(parsed), provenance: parsed.dialect === 'jdbc' ? 'jdbc' : 'url', key: key || null };
  }
  if (parsed && parsed.path && !parsed.host) {
    return { ...normalizeRef({ ...parsed, scheme: parsed.scheme || schemeFromKey(key) }), provenance: 'dsn', key: key || null };
  }

  const hostPort = BARE_HOST_PORT_RE.exec(raw);
  if (hostPort) {
    return {
      ...normalizeRef({ scheme: schemeFromKey(key), host: hostPort[1], port: Number(hostPort[2]), path: null, hostCount: 1 }),
      provenance: 'host_port', key: key || null,
    };
  }

  if (HOST_KEY_RE.test(key || '') && BARE_HOST_RE.test(raw)) {
    const port = Number.isFinite(opts.siblingPort) ? opts.siblingPort : null;
    return {
      ...normalizeRef({ scheme: schemeFromKey(key), host: raw, port, path: null, hostCount: 1 }),
      provenance: port != null ? 'host_port_keys' : 'host_key', key: key || null,
    };
  }

  // `KAFKA_TOPIC=orders`, `S3_BUCKET=uploads`, `DB_NAME=appdb` — no host at all, but the NAME is
  // the thing two repos agree on, and weakKey is exactly that join.
  if (NAME_KEY_RE.test(key || '') && SAFE_SCALAR_RE.test(raw) && !raw.includes(' ')) {
    const scheme = schemeFromKey(key);
    if (!scheme) return null;
    return { ...normalizeRef({ scheme, host: null, port: null, path: raw, hostCount: 0 }), provenance: 'name_key', key: key || null };
  }

  return null;
}

// ─── `${VAR}` interpolation ───────────────────────────────────────────────────
//
// Compose's documented forms, which `.env` files use too:
//   ${VAR} $VAR      ${VAR:-def} (unset OR empty)   ${VAR-def} (unset only)
//   ${VAR:?msg} ${VAR?msg} (required)               $$ (a literal $)
const INTERP_RE = /\$(\$)|\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])?([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * expandInterpolation(value, lookup) -> {value, vars, resolved}
 *
 * `lookup` is a Map or a plain object of known variable values — for compose that is the `.env`
 * beside it, supplied by the caller, the same opt-in shape topic-facts uses for its repo-wide
 * bindings. An unresolved variable is left written as it appeared rather than blanked, so the
 * fact still shows what the author wrote, and `resolved` says whether it can be trusted as a
 * literal.
 */
function expandInterpolation(value, lookup) {
  if (typeof value !== 'string' || !value.includes('$')) {
    return { value: typeof value === 'string' ? value : '', vars: [], resolved: true };
  }
  const get = (name) => {
    if (!lookup) return undefined;
    if (lookup instanceof Map) return lookup.get(name);
    return Object.prototype.hasOwnProperty.call(lookup, name) ? lookup[name] : undefined;
  };
  const vars = [];
  let resolved = true;
  const out = value.replace(INTERP_RE, (match, dollar, braced, operator, tail, bare) => {
    if (dollar) return '$';
    const name = braced || bare;
    if (!name) return match;
    const op = operator || null;
    const fallback = op === '-' || op === ':-' ? (tail || '') : null;
    const required = op === '?' || op === ':?';
    const supplied = get(name);
    const emptyCountsAsUnset = op === ':-' || op === ':?';
    const has = supplied !== undefined && !(emptyCountsAsUnset && supplied === '');
    const chosen = has ? String(supplied) : fallback;
    vars.push({ name, default: fallback, required, resolved: chosen !== null });
    if (chosen === null) { resolved = false; return match; }
    return chosen;
  });
  return { value: out, vars, resolved };
}

module.exports = {
  DEFAULT_PORTS,
  LOCAL_HOSTS,
  schemeClass,
  canonicalScheme,
  parseConnectionString,
  stripUserInfo,
  normalizeRef,
  isSecretKey,
  looksSecret,
  redactValue,
  referenceFrom,
  expandInterpolation,
};
