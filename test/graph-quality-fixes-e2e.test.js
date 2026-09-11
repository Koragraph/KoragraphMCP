'use strict';

// Deep, end-to-end regression coverage for the three findings from hands-on testing of
// `neighbours` and `blast_radius` against a real 45-file Java Spring repository. Unlike
// graph-quality-fixes.test.js (which unit-tests the fixed functions in isolation with synthetic
// inputs), every test here runs the REAL `koragraph ingest` CLI against a real fixture repo, reads
// the REAL sqlite graph it produces, and calls the REAL `neighbours`/`blastRadius` MCP handlers —
// the same path a live MCP client hits. Several assertions below were only settled by actually
// inspecting the ingested graph (`sqlite3 graph.db`) rather than assumed, because a first-pass
// hypothesis (see the "finding 1" section) turned out to be empirically wrong once tested against
// a real ingest, and a second, distinct bug (see "finding 3") was only found this way too — a
// SECOND, separate regex scanner producing the same false-edge symptom that a narrower unit test
// of the first fix would never have caught.
//
// Four independent fixture repos, ingested together (mirrors eval-findings.test.js's multi-repo
// pattern) so this file needs only one `koragraph ingest` call and one shared graph.db:
//   smallutil — a 2-method utility class with 6 real Spring-DI callers (finding 1, small-class case)
//   bigclass  — a 30-method class with exactly one real caller (finding 1, large-class case)
//   otpsvc    — an interface + impl + a caller that only calls through the interface type (finding 2)
//   barrelts  — a TS barrel file with a commented-out dead re-export beside a real one (finding 3)

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

// --- smallutil: a small class with 6 real Spring-DI callers, none of which should be lost -------
const SMALLUTIL_FIXTURE = {
  'src/main/java/com/example/util/TokenValidator.java':
    'package com.example.util;\n\npublic class TokenValidator {\n'
    + '  public boolean validate(String token) {\n    return token != null && token.length() >= 10;\n  }\n\n'
    + '  public String normalize(String token) {\n    return token.trim();\n  }\n}\n',
};
for (let i = 1; i <= 6; i += 1) {
  SMALLUTIL_FIXTURE[`src/main/java/com/example/svc/Caller${i}Service.java`] = [
    'package com.example.svc;',
    '',
    'import com.example.util.TokenValidator;',
    '',
    `public class Caller${i}Service {`,
    '  private final TokenValidator validator;',
    '',
    `  public Caller${i}Service(TokenValidator validator) {`,
    '    this.validator = validator;',
    '  }',
    '',
    '  public boolean check(String token) {',
    '    return validator.validate(token);',
    '  }',
    '}',
    '',
  ].join('\n');
}

// --- bigclass: a 30-method class with exactly one real external caller --------------------------
const BIGCLASS_METHOD_COUNT = 30;
function bigServiceSource() {
  const lines = ['package com.example.util;', '', 'public class BigService {'];
  for (let i = 1; i <= BIGCLASS_METHOD_COUNT; i += 1) {
    lines.push(
      `  public String method${i}(String input) {`,
      '    if (input == null) {',
      `      return "default${i}";`,
      '    }',
      '    return input.trim();',
      '  }',
      '',
    );
  }
  lines.push('}', '');
  return lines.join('\n');
}
const BIGCLASS_FIXTURE = {
  'src/main/java/com/example/util/BigService.java': bigServiceSource(),
  'src/main/java/com/example/svc/RealCaller.java':
    'package com.example.svc;\n\nimport com.example.util.BigService;\n\npublic class RealCaller {\n'
    + '  private final BigService svc = new BigService();\n\n'
    + '  public String run(String input) {\n    return svc.method1(input);\n  }\n}\n',
};

// --- otpsvc: interface + impl + a caller that only calls through the interface type --------------
const OTPSVC_FIXTURE = {
  'src/main/java/com/example/otp/OTPService.java':
    'package com.example.otp;\n\npublic interface OTPService {\n  String generateOtp(String userId);\n}\n',
  'src/main/java/com/example/otp/OTPServiceImpl.java':
    'package com.example.otp;\n\npublic class OTPServiceImpl implements OTPService {\n'
    + '  @Override\n  public String generateOtp(String userId) {\n    return "123456";\n  }\n}\n',
  'src/main/java/com/example/auth/AuthController.java':
    'package com.example.auth;\n\nimport com.example.otp.OTPService;\n\npublic class AuthController {\n'
    + '  private final OTPService otpService;\n\n'
    + '  public AuthController(OTPService otpService) {\n    this.otpService = otpService;\n  }\n\n'
    + '  public String login(String userId) {\n    return otpService.generateOtp(userId);\n  }\n}\n',
};

// --- barrelts: a TS barrel file with one real re-export and one commented-out dead one ------------
const BARRELTS_FIXTURE = {
  'src/api/real-handler.ts': 'export class RealHandler {\n  handle(): string { return \'ok\'; }\n}\n',
  'src/api/legacy-handler.ts': 'export class LegacyHandler {\n  handle(): string { return \'legacy\'; }\n}\n',
  'src/api/index.ts':
    '// export { LegacyHandler } from \'./legacy-handler\';\n'
    + 'export { RealHandler } from \'./real-handler\';\n',
};

let home;
let roots;
let th; // tool-handlers, required only after KORAGRAPH_HOME is set for this process

test.before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koragraph-deep-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  roots = {
    smallutil: path.join(tmp, 'smallutil'),
    bigclass: path.join(tmp, 'bigclass'),
    otpsvc: path.join(tmp, 'otpsvc'),
    barrelts: path.join(tmp, 'barrelts'),
  };
  writeFixture(roots.smallutil, SMALLUTIL_FIXTURE);
  writeFixture(roots.bigclass, BIGCLASS_FIXTURE);
  writeFixture(roots.otpsvc, OTPSVC_FIXTURE);
  writeFixture(roots.barrelts, BARRELTS_FIXTURE);

  execFileSync('node', [
    CLI, 'ingest',
    roots.smallutil, roots.bigclass, roots.otpsvc, roots.barrelts,
    '--stack', 'JAVA_SPRING',
  ], {
    env: { ...process.env, KORAGRAPH_HOME: home },
    stdio: 'pipe',
  });

  process.env.KORAGRAPH_HOME = home;
  th = require('../src/mcp/tool-handlers');
});

// ---------------------------------------------------------------------------
// Finding 1 — neighbours(direction: "in") must not lose real external callers behind a class's
// own self-referential CONTAINS/DEFINED_IN structural edges.
//
// Empirical note: testing this against a real ingest showed DEFINED_IN edges in this resolver
// consistently land at confidence_tier AMBIGUOUS (resolution "legacy_unretiered"), not EXTRACTED
// as originally assumed — which already sorts them last under the OLD tier-first ranking too, for
// every fixture triable here. The weight-before-tier fix in rankRelations is still the objectively
// correct general rule (a CALLS/REFERENCES/DEPENDS_ON relationship is more informative than a
// structural bookkeeping fact regardless of either edge's resolution confidence), and these tests
// assert the fix's actual, intended behavior — every real caller present and ranked ahead of
// self-referential noise — without claiming to reproduce the exact severity numbers from the
// original report, which would need the reporter's own graph to confirm.
// ---------------------------------------------------------------------------

test('finding 1: neighbours(direction: "in") surfaces every real caller of a small utility class, not just its own members', async () => {
  const res = await th.neighbours({
    symbol: 'TokenValidator', direction: 'in', detail: 'full', limit: 60, project_id: 'smallutil',
  }, {});
  const inRows = res.data.neighbours.in;
  const callerNames = new Set(inRows.map((r) => r.name));
  for (let i = 1; i <= 6; i += 1) {
    assert.ok(callerNames.has(`Caller${i}Service`),
      `expected Caller${i}Service among callers, got: ${JSON.stringify([...callerNames])}`);
  }
  // Every real caller must rank ahead of the class's own DEFINED_IN self-edges (its own methods
  // reporting themselves as "callers" of the class) — the exact symptom reported.
  const firstSelfIdx = inRows.findIndex((r) => r.edge_type === 'DEFINED_IN');
  const lastCallerIdx = inRows.map((r) => r.name).lastIndexOf('Caller6Service');
  assert.ok(firstSelfIdx === -1 || lastCallerIdx < firstSelfIdx,
    `expected all real callers ranked ahead of self-referential DEFINED_IN rows, got order: ${JSON.stringify(inRows.map((r) => `${r.name}(${r.edge_type})`))}`);
});

test('finding 1: neighbours(direction: "in") surfaces a large class\'s one real caller with none of its own structural noise', async () => {
  // DEFINED_IN/CONTAINS are excluded by default now (see tool-handlers.js's
  // STRUCTURAL_MEMBERSHIP_EDGE_TYPES), rather than merely ranked behind the real caller — a
  // stricter, better outcome than the ranking-only fix this test originally checked for. A
  // 30-method class's own membership bookkeeping (30 DEFINED_IN edges, one CONTAINS edge per
  // member) must not appear in the default answer at all, only its one real external caller.
  const res = await th.neighbours({
    symbol: 'BigService', direction: 'in', detail: 'full', limit: 60, project_id: 'bigclass',
  }, {});
  const inRows = res.data.neighbours.in;
  const realCallerIdx = inRows.findIndex((r) => r.name === 'RealCaller');
  assert.ok(realCallerIdx !== -1, `expected RealCaller among the in-edges, got: ${JSON.stringify(inRows.map((r) => r.name))}`);
  assert.ok(realCallerIdx < 60, `expected RealCaller within the default limit of 60, got position ${realCallerIdx + 1}`);
  assert.ok(inRows.every((r) => r.edge_type !== 'DEFINED_IN' && r.edge_type !== 'CONTAINS'),
    `expected no structural membership noise in the default answer, got: ${JSON.stringify(inRows.map((r) => `${r.name}(${r.edge_type})`))}`);
});

// Pure unit-level confirmation of the actual code change, isolated from resolver-tier reality:
// rankRelations must not let ANY tier combination let a structural (low-weight) edge outrank a
// real (high-weight) one — this is the case the resolver did not happen to produce in the fixtures
// above but which the fix must still handle correctly if a future/different resolver path does.
const { rankRelations } = require('../src/mcp/tool-handlers');

test('finding 1 (unit): rankRelations puts a real CALLS caller ahead of a self-referential structural edge even when the structural edge has the BETTER tier', () => {
  const selfReferentialWithBestTier = {
    node_id: 1, name: 'ownMethod', edge_type: 'DEFINED_IN', confidence_tier: 'EXTRACTED', file: 'Widget.java',
  };
  const realCallerWithWorseTier = {
    node_id: 2, name: 'OrderService', edge_type: 'CALLS', confidence_tier: 'INFERRED', file: 'OrderService.java',
  };
  const ranked = rankRelations([selfReferentialWithBestTier, realCallerWithWorseTier], 'Widget.java');
  assert.strictEqual(ranked[0].name, 'OrderService',
    `expected the real CALLS caller first despite its worse tier, got order: ${ranked.map((r) => r.name).join(', ')}`);
});

// ---------------------------------------------------------------------------
// Finding 2 — blast_radius must find a caller that only ever reaches an implementation through
// its interface type (the OVERRIDES-seed-expansion fix). Confirmed empirically: reverting just
// this fix (via `git stash`, see the session's own investigation) made this exact fixture return
// ZERO callers for the impl change — matching "blast_radius missed a real caller" precisely.
// ---------------------------------------------------------------------------

test('finding 2: blast_radius finds a caller that only calls through the interface type when the implementation changes', async () => {
  const res = await th.blastRadius({
    files_changed: ['src/main/java/com/example/otp/OTPServiceImpl.java'],
    project_id: 'otpsvc',
    detail: 'full',
  }, {});
  const callers = res.data.callers || [];
  const authController = callers.find((c) => c.name === 'login');
  assert.ok(authController,
    `expected AuthController.login among callers, got: ${JSON.stringify(callers.map((c) => c.name))}`);
  assert.strictEqual(authController.edge_type, 'CALLS');
});

// ---------------------------------------------------------------------------
// Finding 3 — a commented-out (dead) reference must never produce a live graph edge. Two
// SEPARATE regex scanners were found to have this defect during this session's own deep testing:
// buildRelativeImportEdges' barrel-re-export scan (feeds DEPENDS_ON, fixed first) and
// extractReExportFacts (feeds the FILE node's `properties.imports` -> IMPORTS_SYMBOL/IMPORTS,
// found only by actually ingesting a real fixture and inspecting the resulting graph.db — a
// narrower test of the first fix alone would never have caught this second one).
// ---------------------------------------------------------------------------

test('finding 3: a commented-out re-export produces no IMPORTS/IMPORTS_SYMBOL/DEPENDS_ON edge, while the real one beside it still does', async () => {
  // neighbours/blastRadius resolve symbols by name/changed-file, not by "list this file's own
  // outgoing edges" — the point under test is edge PRESENCE/ABSENCE for specific node names, so
  // this reads the ingested graph directly rather than going through either MCP tool.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(home, 'graph.db'), { readonly: true });
  try {
    const rows = db.prepare(
      `SELECT tn.name AS target, e.edge_type AS type
         FROM edges e
         JOIN nodes fn ON fn.id = e.from_node_id
         JOIN files ff ON ff.id = fn.file_id
         JOIN nodes tn ON tn.id = e.to_node_id
        WHERE ff.path = 'src/api/index.ts'
          AND e.edge_type IN ('IMPORTS', 'IMPORTS_SYMBOL', 'DEPENDS_ON')`,
    ).all();
    const targets = rows.map((r) => r.target);
    assert.ok(!targets.some((t) => /legacy/i.test(t)),
      `expected no edge referencing the commented-out LegacyHandler/legacy-handler.ts, got: ${JSON.stringify(rows)}`);
    assert.ok(targets.some((t) => /real/i.test(t)),
      `expected the real, live re-export to RealHandler/real-handler.ts to still produce an edge, got: ${JSON.stringify(rows)}`);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Finding 8 — blast_radius must accept a repo-prefixed path in `files_changed`. A multi-repo
// project's own status/report output shows paths repo-prefixed (`repo/path/to/file`), which is an
// easy, natural copy-paste mistake into `files_changed` — and every path actually stored in the
// graph is repository-relative, so the prefixed form used to resolve to graph_coverage:
// "unresolved" / callers_found: 0 with no error, indistinguishable from "this file genuinely has no
// callers".
// ---------------------------------------------------------------------------

test('finding 8: blast_radius resolves a files_changed path prefixed with its own repo name', async () => {
  const res = await th.blastRadius({
    files_changed: ['bigclass/src/main/java/com/example/util/BigService.java'],
    detail: 'full',
  }, {});
  assert.strictEqual(res.data.graph_coverage, 'resolved',
    `expected the repo-prefixed path to resolve, got: ${JSON.stringify(res.data)}`);
  const callers = res.data.callers || [];
  assert.ok(callers.some((c) => c.name === 'RealCaller'),
    `expected RealCaller among callers, got: ${JSON.stringify(callers.map((c) => c.name))}`);
});
