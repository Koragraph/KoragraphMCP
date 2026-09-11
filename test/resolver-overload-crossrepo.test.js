'use strict';

// Regression coverage for three call-resolution findings from a hands-on multi-repo eval:
//
//   (a) Overload disambiguation by the receiver's DECLARED TYPE, not its variable name.
//       Two repositories' worth of Spring services inject a field literally named
//       `recruitmentRepository` — but one is typed `RecruitmentRepository` and another
//       `RecruitmentRepositoryV2`. Both `getRecruitmentWithActions()` call sites collapsed onto V1
//       because the resolver keyed the dotted call on the receiver's identifier, so V2 got zero
//       callers and V1 absorbed V2's. The fix resolves the field's declared type and binds each
//       call site to the method on that type.
//
//   (b) A cross-repo qualified call to an OVERLOADED shared-library method used to bind to nothing:
//       `ApiResponse.success(...)` (several overloads in one file) fell through the package
//       plane's single-target picker. Overloads of one member now bind as a set.
//
//   (c) Forward direction: a method's own cross-repo callees were attributed to the consumer FILE
//       node, so `neighbours(method, "out")` could not see them. Call-site cross-repo edges are now
//       attributed to the calling METHOD.
//
// All three run through a real `koragraph ingest` + `neighbours`, across three fixture repos in one
// project, so the whole resolution pipeline is exercised rather than any function in isolation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');

// ── (a) One repo with a V1/V2 repository pair and two services that inject them under the SAME
//        field name but DIFFERENT declared types. ────────────────────────────────────────────────
const OVERLOAD_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.digitral.app</groupId>'
    + '<artifactId>recruitmentapi</artifactId><version>1.0.0</version></project>\n',
  'src/main/java/com/digitral/app/repository/RecruitmentRepository.java':
    'package com.digitral.app.repository;\n'
    + 'public class RecruitmentRepository {\n'
    + '  public String getRecruitmentWithActions(long id) { return "v1:" + id; }\n}\n',
  'src/main/java/com/digitral/app/repository/RecruitmentRepositoryV2.java':
    'package com.digitral.app.repository;\n'
    + 'public class RecruitmentRepositoryV2 {\n'
    + '  public String getRecruitmentWithActions(long id) { return "v2:" + id; }\n}\n',
  'src/main/java/com/digitral/app/service/RecruitmentService.java':
    'package com.digitral.app.service;\n'
    + 'import com.digitral.app.repository.RecruitmentRepository;\n'
    + 'public class RecruitmentService {\n'
    + '  private RecruitmentRepository recruitmentRepository;\n'
    + '  public String approveRecruitment(long id) {\n'
    + '    return recruitmentRepository.getRecruitmentWithActions(id);\n  }\n}\n',
  'src/main/java/com/digitral/app/service/RecruitmentServiceV2.java':
    'package com.digitral.app.service;\n'
    + 'import com.digitral.app.repository.RecruitmentRepositoryV2;\n'
    + 'public class RecruitmentServiceV2 {\n'
    + '  private RecruitmentRepositoryV2 recruitmentRepository;\n'
    + '  public String approveRecruitment(long id) {\n'
    + '    return recruitmentRepository.getRecruitmentWithActions(id);\n  }\n}\n',
};

// ── (b)/(c) A shared library and a consumer that calls an OVERLOADED static method and a unique one
//            across the repo boundary. ────────────────────────────────────────────────────────────
const LIB_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.digitral.common</groupId>'
    + '<artifactId>digitral-common-library</artifactId><version>1.0.0</version></project>\n',
  'src/main/java/com/digitral/common/utils/ApiResponse.java':
    'package com.digitral.common.utils;\n'
    + 'public class ApiResponse {\n'
    + '  public static ApiResponse success() { return new ApiResponse(); }\n'
    + '  public static ApiResponse success(Object data) { return new ApiResponse(); }\n'
    + '  public static ApiResponse success(Object data, String msg) { return new ApiResponse(); }\n'
    + '  public static ApiResponse error(String msg) { return new ApiResponse(); }\n}\n',
  'src/main/java/com/digitral/common/utils/DatabaseService.java':
    'package com.digitral.common.utils;\n'
    + 'public class DatabaseService {\n'
    + '  public static String fetchData(String q) { return q; }\n}\n',
  // (d) a real Spring service, called by the consumer through an INJECTED FIELD rather than a
  // static/qualified reference — see below.
  'src/main/java/com/digitral/common/service/RecruitmentServiceV2.java':
    'package com.digitral.common.service;\n'
    + 'import org.springframework.stereotype.Service;\n\n'
    + '@Service\n'
    + 'public class RecruitmentServiceV2 {\n'
    + '  public String approveRecruitment(long id) { return "approved:" + id; }\n'
    + '  public String rejectRecruitment(long id) { return "rejected:" + id; }\n}\n',
};

const CONSUMER_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example.api</groupId>'
    + '<artifactId>consumerapi</artifactId><version>1.0.0</version><dependencies><dependency>'
    + '<groupId>com.digitral.common</groupId><artifactId>digitral-common-library</artifactId>'
    + '<version>1.0.0</version><scope>system</scope><systemPath>${basedir}/x.jar</systemPath>'
    + '</dependency></dependencies></project>\n',
  'src/main/java/com/example/api/OrdersRepository.java':
    'package com.example.api;\n'
    + 'import com.digitral.common.utils.ApiResponse;\n'
    + 'import com.digitral.common.utils.DatabaseService;\n'
    + 'public class OrdersRepository {\n'
    + '  public ApiResponse listOrders(long id) {\n'
    + '    String data = DatabaseService.fetchData("q" + id);\n'
    + '    return ApiResponse.success(data);\n  }\n}\n',
  // (d) a controller injecting the cross-repo service as a field and calling its methods — the
  // ordinary Spring-DI shape (constructor injection, instance receiver), as opposed to (b)/(c)'s
  // static/qualified calls above. One call through the bare field, one through `this.field`.
  'src/main/java/com/example/api/RecruitmentControllerV2.java':
    'package com.example.api;\n'
    + 'import com.digitral.common.service.RecruitmentServiceV2;\n'
    + 'public class RecruitmentControllerV2 {\n'
    + '  private final RecruitmentServiceV2 recruitmentServiceV2;\n\n'
    + '  public RecruitmentControllerV2(RecruitmentServiceV2 recruitmentServiceV2) {\n'
    + '    this.recruitmentServiceV2 = recruitmentServiceV2;\n  }\n\n'
    + '  public String approve(long id) {\n    return recruitmentServiceV2.approveRecruitment(id);\n  }\n\n'
    + '  public String reject(long id) {\n    return this.recruitmentServiceV2.rejectRecruitment(id);\n  }\n}\n',
};

let home;
let th;

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koragraph-resolver-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const overloadRoot = path.join(tmp, 'recruitmentapi');
  const libRoot = path.join(tmp, 'common-utils');
  const consumerRoot = path.join(tmp, 'consumerapi');
  writeFixture(overloadRoot, OVERLOAD_FIXTURE);
  writeFixture(libRoot, LIB_FIXTURE);
  writeFixture(consumerRoot, CONSUMER_FIXTURE);

  // One ingest, all three repos, default project — so cross-repo resolution runs across the shared
  // library and its consumer while the overload repo stays self-contained.
  execFileSync('node', [CLI, 'ingest', overloadRoot, libRoot, consumerRoot, '--stack', 'JAVA_SPRING'], {
    env: { ...process.env, KORAGRAPH_HOME: home },
    stdio: 'pipe',
  });

  process.env.KORAGRAPH_HOME = home;
  th = require('../src/mcp/tool-handlers');
});

// A caller's originating file, from whichever field the renderer populated.
const callerFiles = (relations) => relations.map((r) => r.file || '').filter(Boolean);

test('(a) each getRecruitmentWithActions overload binds to the caller whose field type matches it', async () => {
  const v1 = await th.neighbours({
    symbol: 'com/digitral/app/repository/RecruitmentRepository.java:getRecruitmentWithActions',
    direction: 'in', detail: 'full',
  }, {});
  const v1Files = callerFiles(v1.data.neighbours.in);
  assert.ok(
    v1Files.some((f) => f.endsWith('service/RecruitmentService.java')),
    `V1 method should be called by RecruitmentService, got: ${JSON.stringify(v1Files)}`,
  );
  assert.ok(
    !v1Files.some((f) => f.endsWith('service/RecruitmentServiceV2.java')),
    `V1 method must NOT absorb RecruitmentServiceV2's call (that is the misattribution), got: ${JSON.stringify(v1Files)}`,
  );

  const v2 = await th.neighbours({
    symbol: 'com/digitral/app/repository/RecruitmentRepositoryV2.java:getRecruitmentWithActions',
    direction: 'in', detail: 'full',
  }, {});
  const v2Files = callerFiles(v2.data.neighbours.in);
  assert.ok(
    v2Files.some((f) => f.endsWith('service/RecruitmentServiceV2.java')),
    `V2 method should be called by RecruitmentServiceV2 (was zero before the fix), got: ${JSON.stringify(v2Files)}`,
  );
});

test('(b) a cross-repo call to the overloaded ApiResponse.success binds to the consumer caller', async () => {
  const result = await th.neighbours({
    symbol: 'src/main/java/com/digitral/common/utils/ApiResponse.java:success',
    direction: 'in', detail: 'full',
  }, {});
  const relations = result.data.neighbours.in;
  const fromConsumer = relations.filter((r) => r.repo === 'consumerapi' || (r.file || '').endsWith('OrdersRepository.java'));
  assert.ok(
    fromConsumer.length > 0,
    `expected the overloaded success() to have a cross-repo caller in consumerapi, got: ${JSON.stringify(relations.map((r) => ({ name: r.name, repo: r.repo, edge_type: r.edge_type })))}`,
  );
});

test('(c) forward neighbours of the consumer method reach its cross-repo callees', async () => {
  const result = await th.neighbours({
    symbol: 'src/main/java/com/example/api/OrdersRepository.java:listOrders',
    direction: 'out', detail: 'full',
  }, {});
  const outs = result.data.neighbours.out || [];
  const names = new Set(outs.filter((r) => r.cross_repo).map((r) => r.name));
  assert.ok(
    names.has('fetchData'),
    `forward direction should reach the unique cross-repo callee fetchData, got: ${JSON.stringify(outs.map((r) => ({ name: r.name, edge_type: r.edge_type, cross: r.cross_repo })))}`,
  );
  assert.ok(
    names.has('success'),
    `forward direction should reach the overloaded cross-repo callee success, got: ${JSON.stringify(outs.map((r) => ({ name: r.name, edge_type: r.edge_type, cross: r.cross_repo })))}`,
  );
});

// ── (d) Cross-repo calls through an INJECTED FIELD (Spring DI), not a static/qualified reference.
//        cross-repo-edge-resolver.js's aliasByFile only bound a call receiver that WAS ITSELF the
//        import alias (`ApiResponse.success()`), never an instance whose DECLARED TYPE is the
//        imported symbol (`recruitmentServiceV2.approveRecruitment()`) — the ordinary shape for a
//        constructor-injected field, and the single most common cross-repo call shape in a real
//        Spring microservice fleet. resolve.js#resolveViaReceiverType already resolves this same
//        shape in-repo; it is scoped to one branch's fileIndex by construction (ingest.js builds it
//        per-branch), so it can never see a field typed with a class from another repo. Confirmed
//        empirically (session's own probe ingest, not committed) before this fix: the only edge
//        landing on the called method was CONTAINS from its own FILE — no CALLS/IMPORTS_SYMBOL edge
//        at all, despite the class-level import already producing one. ────────────────────────────

test('(d) a cross-repo call through a plain injected-field receiver binds to the method it calls', async () => {
  const result = await th.neighbours({
    symbol: 'src/main/java/com/digitral/common/service/RecruitmentServiceV2.java:approveRecruitment',
    direction: 'in', detail: 'full',
  }, {});
  const relations = result.data.neighbours.in;
  const fromConsumer = relations.filter((r) => r.cross_repo
    && (r.file || '').endsWith('RecruitmentControllerV2.java'));
  assert.ok(
    fromConsumer.length > 0,
    `expected a cross-repo caller in consumerapi's RecruitmentControllerV2, got: ${JSON.stringify(relations.map((r) => ({ name: r.name, file: r.file, edge_type: r.edge_type, cross: r.cross_repo })))}`,
  );
});

test('(d) a cross-repo call through a `this.field` receiver also binds to the method it calls', async () => {
  const result = await th.neighbours({
    symbol: 'src/main/java/com/digitral/common/service/RecruitmentServiceV2.java:rejectRecruitment',
    direction: 'in', detail: 'full',
  }, {});
  const relations = result.data.neighbours.in;
  const fromConsumer = relations.filter((r) => r.cross_repo
    && (r.file || '').endsWith('RecruitmentControllerV2.java'));
  assert.ok(
    fromConsumer.length > 0,
    `expected a cross-repo caller via this.field, got: ${JSON.stringify(relations.map((r) => ({ name: r.name, file: r.file, edge_type: r.edge_type, cross: r.cross_repo })))}`,
  );
});

test('(d) forward neighbours of the DI-calling controller method reach the injected-field callee cross-repo', async () => {
  const result = await th.neighbours({
    symbol: 'src/main/java/com/example/api/RecruitmentControllerV2.java:approve',
    direction: 'out', detail: 'full',
  }, {});
  const outs = result.data.neighbours.out || [];
  const names = new Set(outs.filter((r) => r.cross_repo).map((r) => r.name));
  assert.ok(
    names.has('approveRecruitment'),
    `forward direction should reach the injected-field cross-repo callee approveRecruitment, got: ${JSON.stringify(outs.map((r) => ({ name: r.name, edge_type: r.edge_type, cross: r.cross_repo })))}`,
  );
});
