// topic-facts.js — which message-broker topics a source file PUBLISHES to and SUBSCRIBES to.
//
// The third transport, after HTTP routes and gRPC. A fleet coupled by Kafka, RabbitMQ, NATS or
// Pulsar has no import edge and no RPC between its services — the only thing connecting the
// producer to the consumer is a **string**, and if the graph does not resolve that string the
// services look unrelated no matter how tightly coupled they are.
//
// THE PART THAT ACTUALLY MATTERS: THE TOPIC IS ALMOST NEVER A LITERAL
// ------------------------------------------------------------------
// A detector that only matches `send("orders")` finds nothing real. Measured on the
// OpenTelemetry demo, which is three services in three languages sharing one topic, and not one
// of them writes the name at the call site:
//
//   Go      var Topic = getTopic()                                    -> producer.Topic = kafka.Topic
//           func getTopic() string {
//             if t := os.Getenv("KAFKA_TOPIC"); t != "" { return t }
//             return "orders" }
//   C#      static readonly string TopicName =
//             Environment.GetEnvironmentVariable("KAFKA_TOPIC") ?? "orders";  -> Subscribe(TopicName)
//   Kotlin  val topic: String = System.getenv("KAFKA_TOPIC") ?: "orders"      -> subscribe(listOf(topic))
//
// The universal idiom is **environment variable with a literal default**, bound to a
// module-level name, used somewhere else entirely. So this file is two things: a set of call-site
// patterns from each client library's documented API, and a small binding resolver that walks an
// identifier back to a literal within the file — through `=`, `:=`, `const`, `val`, `??`, `?:`,
// `or`, and a zero-argument function whose body returns one.
//
// Every resolution records HOW it was reached (`provenance`), so a consumer of these facts can
// treat `literal` and `env_default` differently, and so a wrong edge can be traced to the rule
// that produced it rather than to "the regex".
//
// WHAT IS DELIBERATELY NOT DONE
//   * No cross-file resolution. A topic defined in another module resolves to nothing rather
//     than to a guess; the identifier is still reported as `unresolved` so the gap is countable.
//   * No concatenation or formatting (`"orders." + env`). A partially-known name is not a name.
//   * Test files are included — a consumer test is real evidence that a service reads the topic —
//     but the caller can filter on `isTest`.

'use strict';

const path = require('path');

const LANG_BY_EXT = {
  '.go': 'go', '.py': 'python', '.java': 'jvm', '.kt': 'jvm', '.scala': 'jvm',
  '.cs': 'csharp', '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.ts': 'node',
  '.rb': 'ruby', '.php': 'php', '.rs': 'rust',
};

// A topic argument is either a quoted literal or a bare identifier/qualified name.
const ARG = String.raw`(?:"([^"\\]*)"|'([^'\\]*)'|` + '`' + String.raw`([^` + '`' + String.raw`]*)` + '`' + String.raw`|([A-Za-z_$][A-Za-z0-9_$.]*))`;

function pat(source) { return new RegExp(source, 'g'); }

// Each pattern is drawn from the client library's own documented API surface.
const PUBLISH_PATTERNS = [
  // Kafka — sarama (Go), kafka-go (Go), kafkajs (Node), confluent-kafka (Python/C#), Spring, JDK client
  pat(String.raw`ProducerMessage\s*\{[^}]*?Topic\s*:\s*` + ARG),
  pat(String.raw`(?:WriterConfig|Writer)\s*\{[^}]*?Topic\s*:\s*` + ARG),
  pat(String.raw`new\s+ProducerRecord\s*<[^>]*>\s*\(\s*` + ARG),
  pat(String.raw`new\s+ProducerRecord\s*\(\s*` + ARG),
  pat(String.raw`kafkaTemplate\s*\.\s*send\s*\(\s*` + ARG),
  pat(String.raw`producer\s*\.\s*(?:send|produce|ProduceAsync|Produce)\s*\(\s*` + ARG),
  pat(String.raw`\.\s*send\s*\(\s*\{\s*topic\s*:\s*` + ARG),
  pat(String.raw`@SendTo\s*\(\s*` + ARG),
  // NATS / Pulsar / RabbitMQ / SNS
  pat(String.raw`(?:^|[^A-Za-z0-9_$])(?:Publish|publish|PublishMsg)\s*\(\s*` + ARG),
  pat(String.raw`newProducer\s*\([^)]*\)\s*\.\s*topic\s*\(\s*` + ARG),
  pat(String.raw`basicPublish\s*\(\s*` + ARG),
];

const SUBSCRIBE_PATTERNS = [
  pat(String.raw`@KafkaListener\s*\([^)]*?topics\s*=\s*(?:\{\s*)?` + ARG),
  pat(String.raw`@(?:RabbitListener|JmsListener)\s*\([^)]*?(?:queues|destination)\s*=\s*` + ARG),
  // The receiver is optional on purpose: Kotlin's `with(consumer) { subscribe(listOf(topic)) }`
  // and Java's static imports call these with no dot, and requiring one lost fraud-detection
  // entirely on the OpenTelemetry demo. The boundary excludes identifier characters but NOT `.`
  // — excluding the dot to allow the bare form silently broke `_consumer.Subscribe(TopicName)`
  // and lost accounting instead, which is the same bug in the other direction.
  pat(String.raw`(?:^|[^A-Za-z0-9_$])(?:Subscribe|subscribe)\s*\(\s*(?:listOf|Arrays\.asList|Collections\.singletonList|List\.of|\[)?\s*\(?\s*` + ARG),
  pat(String.raw`\.\s*subscribe\s*\(\s*\{\s*topics?\s*:\s*(?:\[\s*)?` + ARG),
  pat(String.raw`(?:ReaderConfig|Reader)\s*\{[^}]*?Topic\s*:\s*` + ARG),
  pat(String.raw`ConsumePartition\s*\(\s*` + ARG),
  pat(String.raw`\.\s*Consume\s*\([^,]*,\s*\[\]string\s*\{\s*` + ARG),
  pat(String.raw`KafkaConsumer\s*\(\s*` + ARG),
  pat(String.raw`\.\s*(?:QueueSubscribe|BasicConsume|basicConsume|consume)\s*\(\s*` + ARG),
  pat(String.raw`QueueDeclare\s*\(\s*(?:queue\s*:\s*)?` + ARG),
];

function argFrom(match, base) {
  // Groups: 1 dquote, 2 squote, 3 backtick, 4 identifier — relative to `base`.
  const lit = match[base] ?? match[base + 1] ?? match[base + 2];
  if (lit !== undefined) return { kind: 'literal', value: lit };
  const ident = match[base + 3];
  if (ident) return { kind: 'ident', value: ident };
  return null;
}

// Binding forms that assign a literal, an env-var-with-default, or call a resolver function.
function buildBindingResolver(text) {
  const cache = new Map();

  const literalOf = (expr) => {
    if (expr === undefined || expr === null) return null;
    // env with literal default: `getenv("X") ?? "lit"`, `?: "lit"`, `or "lit"`, `, "lit")`
    const envDefault = /(?:getenv|GetEnvironmentVariable|Getenv|environ\.get|env\.get|process\.env\.[A-Za-z0-9_]+)[^\n]*?(?:\?\?|\?:|\|\||\bor\b|,)\s*["'`]([^"'`]+)["'`]/.exec(expr);
    if (envDefault) return { value: envDefault[1], provenance: 'env_default' };
    const bare = /^\s*["'`]([^"'`]+)["'`]\s*$/.exec(expr);
    if (bare) return { value: bare[1], provenance: 'literal' };
    return null;
  };

  const resolve = (name, depth = 0) => {
    if (depth > 3 || !name) return null;
    if (cache.has(name)) return cache.get(name);
    cache.set(name, null); // cycle guard

    const short = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    let result = null;

    // `X = expr`, `X := expr`, `const X = expr`, `val X: T = expr`, `X: string = expr`
    const assign = new RegExp(
      String.raw`(?:^|\n)\s*(?:(?:public|private|internal|protected|static|readonly|final|const|let|var|val|def)\s+)*` +
      String.raw`(?:[A-Za-z_$][A-Za-z0-9_$<>,\[\]?]*\s+)?` +
      short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      String.raw`\s*(?::\s*[A-Za-z_$][A-Za-z0-9_$<>,\[\]?]*\s*)?(?::=|=)\s*([^\n;]+)`);
    const am = assign.exec(text);
    if (am) {
      const direct = literalOf(am[1]);
      if (direct) result = direct;
      else {
        // `X = getTopic()` — follow a zero-arg resolver function defined in this file.
        const call = /^\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(\s*\)/.exec(am[1]);
        if (call) {
          const viaFn = resolveFunction(call[1], depth + 1);
          if (viaFn) result = viaFn;
        } else {
          const ident = /^\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*$/.exec(am[1]);
          if (ident) result = resolve(ident[1], depth + 1);
        }
      }
    }
    if (!result) result = resolveFunction(short, depth + 1);

    cache.set(name, result);
    return result;
  };

  // A zero-argument function whose body returns a literal (possibly after an env check).
  const resolveFunction = (fnName, depth) => {
    if (depth > 3 || !fnName) return null;
    const esc = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fn = new RegExp(String.raw`(?:func|def|fun|function)\s+${esc}\s*\([^)]*\)[^{:]*[{:]([\s\S]{0,600})`);
    const m = fn.exec(text);
    if (!m) return null;
    const body = m[1];
    const returns = [...body.matchAll(/return\s+([^\n;]+)/g)].map(r => r[1]);
    for (const r of returns) {
      const lit = literalOf(r);
      if (lit) return { value: lit.value, provenance: lit.provenance === 'literal' ? 'function_return' : lit.provenance };
    }
    // `if t := os.Getenv("X"); t != "" { return t }` then a bare `return "lit"` handled above.
    const envInBody = /["'`]([^"'`]+)["'`]/.exec(returns.join('\n'));
    if (envInBody) return { value: envInBody[1], provenance: 'function_return' };
    return null;
  };

  return { resolve, literalOf };
}

// Module-level bindings a topic name may be defined by, harvested from ONE file so a caller can
// merge them across a repository. This is not "cross-file guessing": a package-level `var Topic =
// …` has exactly one definition in its package, and Go's dominant idiom is to put it in a
// `kafka/producer.go` and reference it as `kafka.Topic` from `main.go`. Refusing that resolution
// does not avoid a guess, it just loses the producer.
//
// Keyed under both the bare name and `<dir>.<name>`, because the qualifier at the use site is the
// package (Go) or namespace (C#) name, which for these ecosystems is the directory.
function collectTopicBindings(relPath, content) {
  const out = new Map();
  const text = typeof content === 'string' ? content : '';
  if (!text) return out;
  const { literalOf } = buildBindingResolver(text);
  const dir = path.basename(path.dirname(relPath || '')) || '';
  const re = /(?:^|\n)\s*(?:(?:public|private|internal|protected|static|readonly|final|const|let|var|val|def)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$<>,\[\]?]*\s+)?([A-Z_$a-z][A-Za-z0-9_$]*)\s*(?::\s*[A-Za-z_$][A-Za-z0-9_$<>,\[\]?]*\s*)?(?::=|=)\s*([^\n;]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (!/topic|queue|subject|channel|stream|exchange/i.test(name)) continue;
    const lit = literalOf(m[2]);
    if (!lit) continue;
    const entry = { value: lit.value, provenance: lit.provenance, file: relPath };
    if (!out.has(name)) out.set(name, entry);
    if (dir && !out.has(`${dir}.${name}`)) out.set(`${dir}.${name}`, entry);
  }
  // `var Topic = getTopic()` — the function form, resolved through the same machinery.
  const fnAssign = /(?:^|\n)\s*(?:(?:public|private|internal|protected|static|readonly|final|const|let|var|val)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[A-Za-z_$][A-Za-z0-9_$<>,\[\]?]*\s*)?(?::=|=)\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(\s*\)/g;
  const { resolve } = buildBindingResolver(text);
  while ((m = fnAssign.exec(text)) !== null) {
    const name = m[1];
    if (!/topic|queue|subject|channel|stream|exchange/i.test(name)) continue;
    if (out.has(name)) continue;
    const r = resolve(name);
    if (!r) continue;
    const entry = { value: r.value, provenance: r.provenance, file: relPath };
    out.set(name, entry);
    if (dir) out.set(`${dir}.${name}`, entry);
  }
  return out;
}

const TEST_RE = /(^|\/)(test|tests|spec|__tests__)(\/|$)|(_test\.|\.test\.|\.spec\.|Test\.|Tests\.)/i;

/**
 * Topics a file publishes to and subscribes to.
 *
 * @returns {{publishes: Array<Fact>, subscribes: Array<Fact>, isTest: boolean}}
 *   Fact = {topic, raw, provenance, line} — `topic` is null when the expression could not be
 *   resolved to a literal, and `raw` always carries what was written at the call site.
 */
function extractTopicFacts(relPath, content, opts = {}) {
  const empty = { publishes: [], subscribes: [], isTest: false };
  const text = typeof content === 'string' ? content : '';
  if (!text) return empty;
  const lang = LANG_BY_EXT[path.extname(relPath || '').toLowerCase()];
  if (!lang) return empty;
  // Cheap rejection: no broker client mentioned anywhere in the file.
  if (!/(kafka|rabbit|amqp|nats|pulsar|sarama|sns|sqs|jms|pubsub|eventhub|servicebus)/i.test(text)) {
    return empty;
  }

  const { resolve, literalOf } = buildBindingResolver(text);
  // Repo-wide bindings (see collectTopicBindings) are consulted only after the file's own, so a
  // local definition always wins over a same-named one elsewhere.
  const repoBindings = opts.bindings instanceof Map ? opts.bindings : null;
  const repoLookup = (name) => {
    if (!repoBindings) return null;
    const short = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    const hit = repoBindings.get(name) || repoBindings.get(short);
    return hit ? { value: hit.value, provenance: `repo_${hit.provenance}` } : null;
  };
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;

  const run = (patterns) => {
    const out = new Map();
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const arg = argFrom(m, 1);
        if (!arg) continue;
        let topic = null, provenance = null;
        if (arg.kind === 'literal') {
          topic = arg.value;
          provenance = 'literal';
        } else {
          const r = resolve(arg.value) || repoLookup(arg.value);
          if (r) { topic = r.value; provenance = r.provenance; }
          else provenance = 'unresolved';
        }
        // Reject values that are plainly not topic names.
        if (topic && (topic.length < 2 || /[\s{}<>]/.test(topic))) { topic = null; provenance = 'unresolved'; }
        const key = `${topic || arg.value}|${provenance}`;
        if (!out.has(key)) out.set(key, { topic, raw: arg.value, provenance, line: lineOf(m.index) });
      }
    }
    return [...out.values()];
  };

  return {
    publishes: run(PUBLISH_PATTERNS),
    subscribes: run(SUBSCRIBE_PATTERNS),
    isTest: TEST_RE.test(relPath || ''),
    _literalOf: opts._exposeInternals ? literalOf : undefined,
  };
}

module.exports = { extractTopicFacts, collectTopicBindings, LANG_BY_EXT };
