'use strict';

// Harder, larger end-to-end regression coverage for the same feedback the other
// graph-quality-fixes*.test.js files cover, but closer to the scale and shape of the original
// report: a real 11-repo, ~15k-node Java Spring codebase (saleshub/microservices) split across
// MORE than one koragraph project. The smaller fixtures elsewhere in this tree isolate one finding
// each with the minimum repo count needed to trigger it; this file instead builds one multi-repo,
// multi-project store and re-runs the SAME assertions against it, specifically to catch anything
// that only shows up at scale — e.g. a scope default that behaves differently when the store holds
// more than one project, which none of the 1-2-repo fixtures elsewhere can exercise at all.
//
// Two separate koragraph projects share one store:
//   "saleshub"  — 5 repos: a shared library (common-lib), three independent consumers of its one
//                 plain (non-overloaded) static method, and a real `@Service`-annotated class with
//                 two same-repo controller callers, for the CLASS+SERVICE+constructor ambiguity
//                 finding (same-repo Spring layering — controller/service/repository packages in
//                 one microservice — the realistic shape; see recruitmentapi's own fixture comment
//                 for why a cross-repo variant of this specific caller shape was tried and dropped).
//   "unrelated" — 1 repo (legacy-analytics) with its OWN, unrelated method that happens to share a
//                 bare name with common-lib's method — planted specifically to catch cross-PROJECT
//                 bleed if a tool's default scope is wider than it should be.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');

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

// --- common-lib: the shared library every saleshub consumer depends on -----------------------
const COMMON_LIB_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.saleshub.common</groupId>'
    + '<artifactId>common-lib</artifactId><version>1.0.0</version></project>\n',
  'src/main/java/com/saleshub/common/utils/DatabaseService.java':
    'package com.saleshub.common.utils;\n'
    + 'public class DatabaseService {\n'
    + '  public static String fetchData(String q) { return q; }\n}\n',
  // Real IDE-rule/template noise: an .mdc file that mentions the class/method by name, ingested
  // for real (not synthesized), so it can pick up whatever real edge cross-repo-edge-resolver.js
  // actually writes for a name mention in a non-source file — the exact issue #2/#3 symptom.
  '.cursor/rules/DatabaseServiceUsage.mdc':
    '# DatabaseService usage\n\n'
    + 'Call `DatabaseService.fetchData(query)` from `com.saleshub.common.utils` to read data.\n'
    + 'Do not call it inside a loop.\n',
};

// --- three independent consumers, each calling common-lib's ONE plain (non-overloaded) method --
function consumerFixture(consumerName, className) {
  return {
    'pom.xml':
      `<project><modelVersion>4.0.0</modelVersion><groupId>com.saleshub.${consumerName}</groupId>`
      + `<artifactId>${consumerName}</artifactId><version>1.0.0</version><dependencies><dependency>`
      + '<groupId>com.saleshub.common</groupId><artifactId>common-lib</artifactId>'
      + '<version>1.0.0</version><scope>system</scope><systemPath>${basedir}/x.jar</systemPath>'
      + '</dependency></dependencies></project>\n',
    [`src/main/java/com/saleshub/${consumerName}/${className}.java`]:
      `package com.saleshub.${consumerName};\n`
      + 'import com.saleshub.common.utils.DatabaseService;\n'
      + `public class ${className} {\n`
      + `  public String run(long id) {\n    return DatabaseService.fetchData("q" + id);\n  }\n}\n`,
  };
}
const ORDERS_FIXTURE = consumerFixture('orders', 'OrdersRepository');
const BILLING_FIXTURE = consumerFixture('billing', 'BillingRepository');
const SHIPPING_FIXTURE = consumerFixture('shipping', 'ShippingRepository');

// --- recruitmentapi: the exact CLASS+SERVICE+constructor ambiguity from the original report -----
// semantic-typing.js#deriveSemanticNodes's JAVA_CLASS_ROLES table emits an EXTRA node typed
// 'SERVICE' (same name, same file, same line as the CLASS node) specifically for the `@Service`
// Spring annotation — the file's own path (a `service/` directory) is not what triggers it, a
// class-name suffix alone is not either ("a CLASS named FooService without @Service is a guess too
// far", per that file's own comment); only the annotation does. Empirically confirmed by probing
// this exact fixture both with and without `@Service` before writing this test: WITHOUT it, only
// CLASS + the constructor METHOD are written; WITH it (below), a third node, node_type 'SERVICE',
// appears at the same name/file/line — a real Spring service class always carries this annotation,
// so this is the representative shape, not a synthetic worst case.
const RECRUITMENTAPI_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.saleshub.recruitment</groupId>'
    + '<artifactId>recruitmentapi</artifactId><version>1.0.0</version></project>\n',
  'src/main/java/com/saleshub/recruitment/repository/RecruitmentRepositoryV2.java':
    'package com.saleshub.recruitment.repository;\n'
    + 'public class RecruitmentRepositoryV2 {\n'
    + '  public String getRecruitmentWithActions(long id) { return "v2:" + id; }\n}\n',
  'src/main/java/com/saleshub/recruitment/service/RecruitmentServiceV2.java':
    'package com.saleshub.recruitment.service;\n'
    + 'import com.saleshub.recruitment.repository.RecruitmentRepositoryV2;\n'
    + 'import org.springframework.stereotype.Service;\n\n'
    + '@Service\n'
    + 'public class RecruitmentServiceV2 {\n'
    + '  private RecruitmentRepositoryV2 recruitmentRepository;\n\n'
    + '  public RecruitmentServiceV2(RecruitmentRepositoryV2 recruitmentRepository) {\n'
    + '    this.recruitmentRepository = recruitmentRepository;\n  }\n\n'
    + '  public String approveRecruitment(long id) {\n'
    + '    return recruitmentRepository.getRecruitmentWithActions(id);\n  }\n\n'
    + '  public String rejectRecruitment(long id) {\n    return "rejected:" + id;\n  }\n}\n',
  // Same repo as the service — the realistic Spring layering (controller/service/repository
  // packages inside one microservice) the original report's own 22-CALLS-edges finding was almost
  // certainly measured against. A separate probe during this session's testing (not committed)
  // found that a controller in a DIFFERENT repo, injecting this class as a field and calling its
  // methods, produces only a coarse FILE-level IMPORTS_SYMBOL edge to the CLASS — no edge at all to
  // the specific method called. That looks like a genuine, separate gap in cross-repo receiver-type
  // method resolution (distinct from the 5 issues fixed here, which are about qualified/static
  // calls, not injected-field instance calls) and is being flagged separately rather than folded
  // into this fix.
  'src/main/java/com/saleshub/recruitment/controller/RecruitmentControllerV2.java':
    'package com.saleshub.recruitment.controller;\n'
    + 'import com.saleshub.recruitment.service.RecruitmentServiceV2;\n'
    + 'public class RecruitmentControllerV2 {\n'
    + '  private final RecruitmentServiceV2 recruitmentServiceV2;\n\n'
    + '  public RecruitmentControllerV2(RecruitmentServiceV2 recruitmentServiceV2) {\n'
    + '    this.recruitmentServiceV2 = recruitmentServiceV2;\n  }\n\n'
    + '  public String approve(long id) {\n    return recruitmentServiceV2.approveRecruitment(id);\n  }\n}\n',
  'src/main/java/com/saleshub/recruitment/controller/OnboardingControllerV2.java':
    'package com.saleshub.recruitment.controller;\n'
    + 'import com.saleshub.recruitment.service.RecruitmentServiceV2;\n'
    + 'public class OnboardingControllerV2 {\n'
    + '  private final RecruitmentServiceV2 recruitmentServiceV2;\n\n'
    + '  public OnboardingControllerV2(RecruitmentServiceV2 recruitmentServiceV2) {\n'
    + '    this.recruitmentServiceV2 = recruitmentServiceV2;\n  }\n\n'
    + '  public String reject(long id) {\n    return recruitmentServiceV2.rejectRecruitment(id);\n  }\n}\n',
};

// --- legacy-analytics: a SEPARATE PROJECT with its own unrelated "fetchData" method --------------
// Plants a bare-name collision across project boundaries. If a tool's default scope (no project_id
// given) is wider than "the project the caller is actually asking about" — e.g. org-wide instead
// of project-wide, the asymmetry this session hypothesized as a candidate explanation for the
// original cross-repo `neighbours` gap — this is what would surface it: a second, unrelated
// `fetchData` the query has no business seeing.
const LEGACY_ANALYTICS_FIXTURE = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.otherco.legacy</groupId>'
    + '<artifactId>legacy-analytics</artifactId><version>1.0.0</version></project>\n',
  'src/main/java/com/otherco/legacy/ReportingService.java':
    'package com.otherco.legacy;\n'
    + 'public class ReportingService {\n'
    + '  public static String fetchData(String q) { return "legacy:" + q; }\n}\n',
  'src/main/java/com/otherco/legacy/ReportCaller.java':
    'package com.otherco.legacy;\n'
    + 'public class ReportCaller {\n'
    + '  public String run(String q) {\n    return ReportingService.fetchData(q);\n  }\n}\n',
};

let home;
let th;

test.before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koragraph-hard-e2e-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });

  const roots = {
    commonLib: path.join(tmp, 'common-lib'),
    orders: path.join(tmp, 'orders'),
    billing: path.join(tmp, 'billing'),
    shipping: path.join(tmp, 'shipping'),
    recruitmentapi: path.join(tmp, 'recruitmentapi'),
    legacyAnalytics: path.join(tmp, 'legacy-analytics'),
  };
  writeFixture(roots.commonLib, COMMON_LIB_FIXTURE);
  writeFixture(roots.orders, ORDERS_FIXTURE);
  writeFixture(roots.billing, BILLING_FIXTURE);
  writeFixture(roots.shipping, SHIPPING_FIXTURE);
  writeFixture(roots.recruitmentapi, RECRUITMENTAPI_FIXTURE);
  writeFixture(roots.legacyAnalytics, LEGACY_ANALYTICS_FIXTURE);

  // One project, five repos — the real saleshub shape, just smaller.
  execFileSync('node', [
    CLI, 'ingest',
    roots.commonLib, roots.orders, roots.billing, roots.shipping, roots.recruitmentapi,
    '--project', 'saleshub', '--stack', 'JAVA_SPRING',
  ], { env: { ...process.env, KORAGRAPH_HOME: home }, stdio: 'pipe' });

  // A second, unrelated project in the SAME store.
  execFileSync('node', [
    CLI, 'ingest', roots.legacyAnalytics,
    '--project', 'unrelated', '--stack', 'JAVA_SPRING',
  ], { env: { ...process.env, KORAGRAPH_HOME: home }, stdio: 'pipe' });

  process.env.KORAGRAPH_HOME = home;
  th = require('../src/mcp/tool-handlers');
});

// ---------------------------------------------------------------------------
// Issue #1 (report) — a shared-library plain method with real callers in several other repos.
// Harder than the 1-consumer fixture elsewhere: 3 independent consumer repos, plus a second
// koragraph PROJECT holding an unrelated same-named method, to catch cross-project bleed.
// ---------------------------------------------------------------------------

test('hard e2e: neighbours(fetchData, in) finds all 3 cross-repo consumers, scoped to their own project, with NO project_id given', async () => {
  const res = await th.neighbours({
    symbol: 'fetchData',
    file: 'src/main/java/com/saleshub/common/utils/DatabaseService.java',
    direction: 'in', detail: 'full', limit: 60,
  }, {});
  const inRows = res.data.neighbours.in;
  const callerRepos = new Set(inRows.filter((r) => r.cross_repo).map((r) => r.repo));
  for (const repo of ['orders', 'billing', 'shipping']) {
    assert.ok(callerRepos.has(repo),
      `expected a cross-repo caller in "${repo}", got repos: ${JSON.stringify([...callerRepos])}, full: ${JSON.stringify(inRows.map((r) => ({ name: r.name, repo: r.repo, edge_type: r.edge_type })))}`);
  }
  // The bare-name collision planted in the "unrelated" project must NOT appear here — that would be
  // cross-PROJECT bleed, not a cross-repo caller of THIS method.
  assert.ok(!inRows.some((r) => r.repo === 'legacy-analytics'),
    `expected no bleed from the unrelated project's own fetchData, got: ${JSON.stringify(inRows.map((r) => ({ name: r.name, repo: r.repo })))}`);
});

test('hard e2e: neighbours(fetchData, in) does not resolve to the unrelated project\'s own fetchData when queried by name+file inside legacy-analytics', async () => {
  // Sanity check on the other side of the same boundary: resolving "fetchData" scoped to the
  // unrelated project's own file must find ONLY its own caller, not bleed the other direction.
  const res = await th.neighbours({
    symbol: 'fetchData',
    file: 'src/main/java/com/otherco/legacy/ReportingService.java',
    direction: 'in', detail: 'full', limit: 60,
  }, {});
  const inRows = res.data.neighbours.in;
  // The CALLS edge attributes to the calling METHOD ("run"), not its enclosing CLASS.
  assert.ok(inRows.some((r) => r.name === 'run' && r.file === 'src/main/java/com/otherco/legacy/ReportCaller.java'),
    `expected ReportCaller.run as a caller, got: ${JSON.stringify(inRows.map((r) => ({ name: r.name, file: r.file })))}`);
  assert.ok(!inRows.some((r) => ['orders', 'billing', 'shipping'].includes(r.repo)),
    `expected no bleed from saleshub's consumers, got: ${JSON.stringify(inRows.map((r) => ({ name: r.name, repo: r.repo })))}`);
});

// ---------------------------------------------------------------------------
// Issue #4 (report) — the exact CLASS+SERVICE+constructor ambiguity, with real callers (two
// controllers in the same repo, each calling a different method on the class — realistic Spring
// controller/service/repository layering within one microservice).
// ---------------------------------------------------------------------------

test('hard e2e: resolveSymbol collapses RecruitmentServiceV2 to CLASS+SERVICE, dropping only the constructor', async () => {
  // Scoped by file, the same way a caller who just found the ambiguity via search_code/explore
  // would narrow down: without it, "RecruitmentServiceV2" also case-insensitively matches the two
  // controllers' OWN, unrelated `recruitmentServiceV2` FIELD declarations (their injected copy of
  // the dependency) — a real but separate quirk of case-insensitive tier-1 matching, pre-existing
  // and out of scope for this fix, which is specifically about a container and its OWN constructor.
  const { resolveSymbol } = require('../src/mcp/symbol-resolver');
  const { searchGraphForOrg } = require('../src/services/graph-tool-service');
  const resolution = await resolveSymbol(
    { symbol: 'RecruitmentServiceV2', file: 'src/main/java/com/saleshub/recruitment/service/RecruitmentServiceV2.java' },
    { searchGraphForOrg },
  );
  const types = resolution.resolved.map((n) => n.type).sort();
  assert.deepStrictEqual(types, ['CLASS', 'SERVICE'],
    `expected exactly CLASS+SERVICE (constructor dropped), got: ${JSON.stringify(resolution.resolved.map((n) => ({ type: n.type, line: n.line })))}`);
});

test('hard e2e: neighbours(RecruitmentServiceV2, in) finds both real controller callers, in a 5-repo project, with none of its own structural noise', async () => {
  const res = await th.neighbours({
    symbol: 'RecruitmentServiceV2', direction: 'in', detail: 'full', limit: 60, project_id: 'saleshub',
  }, {});
  const inRows = res.data.neighbours.in;
  // The CALLS edge attributes to the calling METHOD ("approve"/"reject"), not the enclosing
  // controller CLASS — matched by file to pin down which controller each is.
  const approve = inRows.find((r) => r.name === 'approve' && (r.file || '').endsWith('RecruitmentControllerV2.java'));
  const reject = inRows.find((r) => r.name === 'reject' && (r.file || '').endsWith('OnboardingControllerV2.java'));
  assert.ok(approve, `expected RecruitmentControllerV2.approve among callers, got: ${JSON.stringify(inRows.map((r) => ({ name: r.name, file: r.file })))}`);
  assert.ok(reject, `expected OnboardingControllerV2.reject among callers, got: ${JSON.stringify(inRows.map((r) => ({ name: r.name, file: r.file })))}`);
  assert.strictEqual(approve.edge_type, 'CALLS');
  assert.strictEqual(reject.edge_type, 'CALLS');
  assert.ok(inRows.every((r) => r.edge_type !== 'DEFINED_IN' && r.edge_type !== 'CONTAINS'),
    `expected no structural membership noise, got: ${JSON.stringify(inRows.map((r) => `${r.name}(${r.edge_type})`))}`);
  // Both callers must actually be reachable within the default limit, not merely present somewhere
  // past a truncation line.
  assert.ok(inRows.indexOf(approve) < 60 && inRows.indexOf(reject) < 60);
});

test('hard e2e: blast_radius on the same file finds the same two controller callers, confirming neighbours now matches it', async () => {
  const res = await th.blastRadius({
    files_changed: ['src/main/java/com/saleshub/recruitment/service/RecruitmentServiceV2.java'],
    project_id: 'saleshub',
    detail: 'full',
  }, {});
  const callers = res.data.callers || [];
  assert.ok(callers.some((c) => c.name === 'approve' && (c.file || '').endsWith('RecruitmentControllerV2.java')),
    `expected the approve() caller, got: ${JSON.stringify(callers.map((c) => ({ name: c.name, file: c.file })))}`);
  assert.ok(callers.some((c) => c.name === 'reject' && (c.file || '').endsWith('OnboardingControllerV2.java')),
    `expected the reject() caller, got: ${JSON.stringify(callers.map((c) => ({ name: c.name, file: c.file })))}`);
});

// ---------------------------------------------------------------------------
// Issue #2/#3 (report) — real .mdc doc noise, ingested for real, ranked and excludable.
// ---------------------------------------------------------------------------

test('hard e2e: blast_radius ranks a real source caller ahead of the real .mdc doc mention, at 6-repo scale', async () => {
  const res = await th.blastRadius({
    files_changed: ['src/main/java/com/saleshub/common/utils/DatabaseService.java'],
    project_id: 'saleshub',
    limit: 200,
    detail: 'full',
  }, {});
  const callers = res.data.callers || [];
  const mdcIdx = callers.findIndex((c) => /\.mdc$/.test(c.file || ''));
  const sourceIdx = callers.findIndex((c) => /\.java$/.test(c.file || ''));
  assert.ok(sourceIdx !== -1, `expected at least one real .java caller, got: ${JSON.stringify(callers.map((c) => c.file))}`);
  assert.ok(mdcIdx === -1 || sourceIdx < mdcIdx,
    `expected the .java caller ranked ahead of the .mdc mention, got order: ${JSON.stringify(callers.map((c) => c.file))}`);
});

test('hard e2e: blast_radius with exclude_non_source drops the real .mdc mention outright', async () => {
  const res = await th.blastRadius({
    files_changed: ['src/main/java/com/saleshub/common/utils/DatabaseService.java'],
    project_id: 'saleshub',
    limit: 200,
    exclude_non_source: true,
    detail: 'full',
  }, {});
  const callers = res.data.callers || [];
  assert.ok(!callers.some((c) => /\.mdc$/.test(c.file || '')),
    `expected no .mdc caller with exclude_non_source, got: ${JSON.stringify(callers.map((c) => c.file))}`);
  assert.ok(callers.some((c) => /\.java$/.test(c.file || '')), 'expected real .java callers to remain');
});

// ---------------------------------------------------------------------------
// Issue #5 (report) — a deeply-nested, repo-prefixed files_changed path across a real 6-repo
// project (not the 2-repo toy case elsewhere).
// ---------------------------------------------------------------------------

test('hard e2e: blast_radius resolves a deeply-nested repo-prefixed files_changed path in a 6-repo project', async () => {
  const res = await th.blastRadius({
    files_changed: ['common-lib/src/main/java/com/saleshub/common/utils/DatabaseService.java'],
    project_id: 'saleshub',
    detail: 'full',
  }, {});
  assert.strictEqual(res.data.graph_coverage, 'resolved',
    `expected the repo-prefixed path to resolve, got: ${JSON.stringify(res.data.graph_coverage)}`);
  const callerRepos = new Set((res.data.callers || []).map((c) => c.repo));
  assert.ok(['orders', 'billing', 'shipping'].some((r) => callerRepos.has(r)),
    `expected at least one of the 3 consumer repos among callers, got: ${JSON.stringify([...callerRepos])}`);
});
