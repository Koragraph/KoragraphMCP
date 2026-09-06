'use strict';

// End-to-end regression coverage for the Java qualified-call cross-repo binding fix.
//
// Reported symptom: on a real 5-repo Maven project (a shared `common-utils` library consumed by
// four Spring services), `neighbours`/`blast_radius` on shared-library methods
// (`ConfigUtils.getValue()`, `TimeUtils.getTimeDifference()`, `CacheServiceFactory.clone()`)
// returned zero cross-repo callers for every symbol tested, even though every repo ingested
// cleanly and a separate reference tool confirmed hundreds of real cross-repo call edges existed.
//
// Root cause: extractors/java.js never set `alias` on an import fact. `import a.b.Foo;` produced
// `{name: "Foo", module: "a.b"}` with no alias, so cross-repo-edge-resolver.js's qualified-call
// binder fell back to deriving one from the module string (`module.split('/').pop()`) — a rule
// built for path-like modules (Go/npm). Java's dotted module string has no `/`, so the fallback
// returned the WHOLE package ("a.b") as the alias, which can never match a call's actual receiver
// ("Foo"). Every qualified static/instance call into another repo's class silently failed to bind.
// This reproduces with a real `koragraph ingest` + `blast_radius` call across two fixture repos —
// not a unit test of the extractor in isolation — so it also exercises the cross-repo-edge-resolver
// query path (callExpressions -> aliasByFile -> pickDecl) end to end.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');

// Provider: a shared library repo, the shape of the reported `common-utils`.
const LIBCOMMON_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion>'
    + '<groupId>com.digitral.common</groupId><artifactId>digitral-common-library</artifactId>'
    + '<version>1.0.0</version></project>\n',
  'src/main/java/com/digitral/common/utils/ConfigUtils.java':
    'package com.digitral.common.utils;\n\n'
    + 'public class ConfigUtils {\n'
    + '  public static String getValue(String key) {\n'
    + '    return System.getenv(key);\n'
    + '  }\n'
    + '}\n',
};

// Consumer: declares the shared library as a `system`-scope local-JAR dependency — the exact
// declaration shape from the report — and calls the shared class through a qualified static call.
const CONSUMERAPI_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion>'
    + '<groupId>com.example.consumer</groupId><artifactId>consumerapi</artifactId><version>1.0.0</version>'
    + '<dependencies><dependency>'
    + '<groupId>com.digitral.common</groupId><artifactId>digitral-common-library</artifactId>'
    + '<version>1.0.0</version><scope>system</scope>'
    + '<systemPath>${basedir}/packages/digitral-common-library-1.0.0.jar</systemPath>'
    + '</dependency></dependencies></project>\n',
  'src/main/java/com/example/consumer/PaymentController.java':
    'package com.example.consumer;\n\n'
    + 'import com.digitral.common.utils.ConfigUtils;\n\n'
    + 'public class PaymentController {\n'
    + '  public String handle() {\n'
    + '    return ConfigUtils.getValue("PAYMENT_KEY");\n'
    + '  }\n'
    + '}\n',
};

let home;
let libcommonRoot;
let consumerRoot;
let th; // tool-handlers, required only after KORAGRAPH_HOME is set for this process

function writeFixture(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial');
}

test.before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koragraph-crossrepo-java-'));
  home = path.join(tmp, 'home');
  libcommonRoot = path.join(tmp, 'libcommon');
  consumerRoot = path.join(tmp, 'consumerapi');
  fs.mkdirSync(home, { recursive: true });
  writeFixture(libcommonRoot, LIBCOMMON_FIXTURE);
  writeFixture(consumerRoot, CONSUMERAPI_FIXTURE);

  // One `ingest` call, two repos, no --project: both land in the default project, so cross-repo
  // resolution (ingest-post-tail.js -> resolveProjectCrossRepoEdges) runs across them.
  execFileSync('node', [CLI, 'ingest', libcommonRoot, consumerRoot, '--stack', 'JAVA_SPRING'], {
    env: { ...process.env, KORAGRAPH_HOME: home },
    stdio: 'pipe',
  });

  // The pool singleton in THIS process resolves KORAGRAPH_HOME at require time, so it must be set
  // before the first require of anything that touches it.
  process.env.KORAGRAPH_HOME = home;
  th = require('../src/mcp/tool-handlers');
});

test('blast_radius on the shared library method finds the cross-repo qualified-call caller', async () => {
  const result = await th.blastRadius({
    files_changed: ['src/main/java/com/digitral/common/utils/ConfigUtils.java'],
    detail: 'full',
  }, {});

  const callers = result.data.callers || [];
  // cross-repo-edge-resolver.js's package plane attributes an IMPORTS_SYMBOL edge to the
  // CONSUMER's FILE node, not to the specific calling method — an import belongs to a file, and
  // the resolver has no per-call-site consumer node to point at instead — so the caller surfaced
  // here IS the file itself, not `PaymentController`/`handle` by name.
  const caller = callers.find((c) => c.file === 'src/main/java/com/example/consumer/PaymentController.java');
  assert.ok(
    caller,
    `expected PaymentController.java among cross-repo callers of ConfigUtils, `
    + `got: ${JSON.stringify(callers.map((c) => ({ name: c.name, file: c.file, repo: c.repo, edge_type: c.edge_type })))}`,
  );
  assert.strictEqual(caller.edge_type, 'IMPORTS_SYMBOL');
  assert.strictEqual(caller.repo, 'consumerapi', `expected the caller to be attributed to the consumer repo, got: ${JSON.stringify(caller)}`);
});

test('neighbours(direction: "in") on ConfigUtils.getValue lists the consumer as a caller', async () => {
  const result = await th.neighbours({
    symbol: 'src/main/java/com/digitral/common/utils/ConfigUtils.java:getValue',
    direction: 'in',
    detail: 'full',
  }, {});

  const relations = result.data.neighbours.in;
  const hit = relations.some((r) =>
    (r.repo === 'consumerapi') || (r.name === 'PaymentController') || (r.name === 'handle'));
  assert.ok(
    hit,
    `expected a cross-repo relation into consumerapi/PaymentController, got: ${JSON.stringify(relations)}`,
  );
});
