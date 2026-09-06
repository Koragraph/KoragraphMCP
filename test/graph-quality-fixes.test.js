'use strict';

// Regression coverage for findings from hands-on testing of `neighbours` and `blast_radius`
// against real Java Spring repositories:
//
//   1. neighbours(direction: "in") on a class buried its one real external caller behind the
//      class's own methods/fields reporting themselves as "callers" via CONTAINS/DEFINED_IN.
//   2. blast_radius missed a caller that only ever reaches a class through its interface type —
//      the common Spring/DI shape — and surfaced an unrelated IMPORTS edge instead.
//   3. blast_radius (and neighbours) could report a DEPENDS_ON/IMPLEMENTS edge whose only
//      "evidence" was a class name appearing inside a comment or dead code, never a live reference.
//   4. Cross-repo blast_radius/neighbours found zero callers for shared-library Java methods
//      across a real 5-repo Maven project, even with every repo cleanly ingested. The tree-sitter
//      Java extractor (extractors/java.js) never set `alias` on an import fact, so
//      cross-repo-edge-resolver.js's qualified-call binding (`ConfigUtils.getValue()` -> receiver
//      "ConfigUtils") fell back to deriving an alias from the dotted module string, which for Java
//      never matches any call receiver. NOTE: extractors/java.js is not yet wired into ingest for
//      any file (only `.rb`/`.rs` are in ast-extractor.js's `_PORTED_EXTRACTORS`) — every real Java
//      ingest today runs ast-extractor.js's older regex-based extractor instead, which has the
//      same class of bug independently; see finding 5.
//   5. The SAME symptom as finding 4, reproduced against the extractor real Java ingests actually
//      use today (ast-extractor.js's regex-based path, `extractor_tier: "regex"`), plus two more
//      gaps in the same chain: its per-language call-expression scanner folds a qualified call's
//      receiver INTO `callee` (`ConfigUtils.getValue`) rather than leaving `callee` as the bare
//      name the resolver's `pickDecl` looks up (Go/PHP/C#/Python/JS/TS each have a dedicated
//      tree-sitter pass that doesn't do this); and blast_radius's own reverse-edge-type list
//      omitted IMPORTS_SYMBOL entirely, so even a correctly-resolved cross-repo symbol edge was
//      invisible to it. A full `koragraph ingest` + `blast_radius`/`neighbours` reproduction of all
//      three lives in cross-repo-java-qualified-call.test.js.
//
// Each block below is a targeted unit test of the exact function that was fixed, not a full ingest
// pipeline — the ingest-based end-to-end pattern lives in eval-findings.test.js and stays green
// (it exercises the same code paths at a higher level and catches anything these miss).

const test = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// Finding 1 — rankRelations must rank by edge weight before confidence tier.
// ---------------------------------------------------------------------------

const { rankRelations } = require('../src/mcp/tool-handlers');

test('finding 1: rankRelations puts a real CALLS caller ahead of a self-referential structural edge', () => {
  // DEFINED_IN is always written at tier EXTRACTED (ingest.js hardcodes it — "this method belongs
  // to this class" needs no resolution), while a real cross-file CALLS edge in Java routinely
  // resolves at a lower tier because it DOES need resolution. Before the fix, sorting tier first
  // let the 100%-certain structural fact permanently outrank the real but merely-inferred caller.
  const selfReferential = {
    node_id: 1, name: 'ownMethod', edge_type: 'DEFINED_IN', confidence_tier: 'EXTRACTED',
    file: 'Widget.java', direction: 'in',
  };
  const realCaller = {
    node_id: 2, name: 'OrderService', edge_type: 'CALLS', confidence_tier: 'INFERRED',
    file: 'OrderService.java', direction: 'in',
  };
  const ranked = rankRelations([selfReferential, realCaller], 'Widget.java');
  assert.strictEqual(ranked[0].name, 'OrderService',
    `expected the real CALLS caller first, got order: ${ranked.map((r) => r.name).join(', ')}`);
});

test('finding 1: rankRelations still prefers a more-confident edge within the same weight class', () => {
  // Tier remains a real tiebreaker — it just no longer overrides weight. Two CALLS edges of
  // different confidence should still order by confidence, exactly as before the fix.
  const inferredCall = {
    node_id: 1, name: 'maybeCaller', edge_type: 'CALLS', confidence_tier: 'AMBIGUOUS', file: 'A.java',
  };
  const extractedCall = {
    node_id: 2, name: 'definiteCaller', edge_type: 'CALLS', confidence_tier: 'EXTRACTED', file: 'B.java',
  };
  const ranked = rankRelations([inferredCall, extractedCall], null);
  assert.strictEqual(ranked[0].name, 'definiteCaller');
});

// ---------------------------------------------------------------------------
// Finding 2 — blast_radius must widen its seed through OVERRIDES so a caller reaching an
// implementation only through its interface type is still found.
// ---------------------------------------------------------------------------

const { expandThroughOverrides } = require('../src/services/blast-radius');

function fakeDb(responsesByHop) {
  let call = 0;
  return {
    query: async () => {
      const rows = responsesByHop[call] || [];
      call += 1;
      return { rows };
    },
    calls: () => call,
  };
}

test('finding 2: expandThroughOverrides adds the interface method an impl method overrides', async () => {
  // OTPServiceImpl.generateOtp() OVERRIDES OTPService.generateOtp(). Changing the impl method
  // (node 10) must widen the seed to include the interface method (node 99) too, so the normal
  // reverse walk — which only ever looks for callers of nodes already in the seed set — finds a
  // caller that only ever calls through the interface type.
  const db = fakeDb([[{ parent_id: 99 }], []]);
  const seeds = await expandThroughOverrides({
    orgId: 1, branchIds: [1], nodeIds: [10], db,
  });
  assert.deepStrictEqual(new Set(seeds), new Set([10, 99]));
});

test('finding 2: expandThroughOverrides walks a multi-level override chain transitively', async () => {
  // child(1) -[OVERRIDES]-> mid(2) -[OVERRIDES]-> top(3): an abstract-class-over-interface shape.
  const db = fakeDb([[{ parent_id: 2 }], [{ parent_id: 3 }], []]);
  const seeds = await expandThroughOverrides({ orgId: 1, branchIds: [1], nodeIds: [1], db });
  assert.deepStrictEqual(new Set(seeds), new Set([1, 2, 3]));
});

test('finding 2: expandThroughOverrides is a no-op when nothing overrides anything', async () => {
  const db = fakeDb([[]]);
  const seeds = await expandThroughOverrides({ orgId: 1, branchIds: [1], nodeIds: [10, 20], db });
  assert.deepStrictEqual(new Set(seeds), new Set([10, 20]));
});

test('finding 2: expandThroughOverrides never re-queries a node it has already seen (cycle-safe)', async () => {
  // A -[OVERRIDES]-> B -[OVERRIDES]-> A would loop forever without the `seen` guard.
  const db = fakeDb([[{ parent_id: 2 }], [{ parent_id: 1 }]]);
  const seeds = await expandThroughOverrides({ orgId: 1, branchIds: [1], nodeIds: [1], db });
  assert.deepStrictEqual(new Set(seeds), new Set([1, 2]));
  assert.strictEqual(db.calls(), 2, 'expected the walk to stop once no fresh parent ids were found');
});

// ---------------------------------------------------------------------------
// Finding 3 — regex-based fallback extraction must not read a commented-out or dead-code line as
// a live declaration/reference.
// ---------------------------------------------------------------------------

const { stripComments, extractInjectedDependencies } = require('../src/services/ast-extractor');

test('finding 3: stripComments blanks a commented-out log line but keeps a live one intact', () => {
  const src = [
    'private final Billing realDep;',
    '// log.info("Calling " + OtpService.class.getName());',
    'String url = "http://example.com"; // a URL, not a comment start',
  ].join('\n');
  const out = stripComments(src, 'java');
  const lines = out.split('\n');
  assert.strictEqual(out.length, src.length, 'stripping must preserve length so line/offset math elsewhere stays valid');
  assert.strictEqual(lines.length, src.split('\n').length);
  assert.ok(lines[0].includes('Billing'), 'a live declaration line must survive untouched');
  assert.ok(!lines[1].includes('OtpService'), `expected the commented-out reference to be blanked, got: ${JSON.stringify(lines[1])}`);
  assert.ok(lines[2].includes('http://example.com'), 'a URL inside a live string must survive, not be read as a comment start');
});

test('finding 3: extractInjectedDependencies ignores a commented-out constructor', () => {
  const src = [
    '// constructor(private readonly otpService: OtpService) {}',
    'class RealThing {',
    '  constructor(private readonly billing: BillingService) {}',
    '}',
  ].join('\n');
  const deps = extractInjectedDependencies(src, 'typescript');
  const types = deps.map((d) => d.fieldType);
  assert.ok(!types.includes('OtpService'), `expected the commented-out DI to be ignored, got: ${JSON.stringify(types)}`);
  assert.ok(types.includes('BillingService'), 'the real, live constructor DI must still be found');
});

// ---------------------------------------------------------------------------
// Finding 4 — Java import facts must carry an `alias` so cross-repo qualified-call
// binding (cross-repo-edge-resolver.js's `aliasByFile`) can find the receiver.
// ---------------------------------------------------------------------------

const java = require('../src/services/extractors/java');

test('finding 4: a single-class Java import carries an alias matching its qualified-call receiver', async () => {
  await java.ready();
  const src = [
    'package com.example.consumer;',
    'import com.digitral.common.utils.ConfigUtils;',
    'public class Caller {',
    '  void run() { String v = ConfigUtils.getValue("k"); }',
    '}',
  ].join('\n');
  const { importFacts } = await java.extractFile('Caller.java', src);
  const fact = importFacts.find((f) => f.name === 'ConfigUtils');
  assert.ok(fact, 'expected an import fact for ConfigUtils');
  // The resolver's fallback (`imp.alias || module.split('/').pop()`) would otherwise return the
  // whole dotted module string "com.digitral.common.utils" as the alias, which never matches a
  // call's `receiver` ("ConfigUtils") — silently breaking every qualified cross-repo method call.
  assert.strictEqual(fact.alias, 'ConfigUtils');
  assert.strictEqual(fact.module, 'com.digitral.common.utils');
});

test('finding 4: a wildcard Java import carries no alias (no qualifier appears in code)', async () => {
  await java.ready();
  const src = [
    'package com.example.consumer;',
    'import com.digitral.common.utils.*;',
    'public class Caller {}',
  ].join('\n');
  const { importFacts } = await java.extractFile('Caller.java', src);
  assert.strictEqual(importFacts.length, 1);
  // A wildcard brings every class in the package into unqualified scope — there is no "b" in
  // `b.Foo.method()` for anyone to write, so recording one as an alias would be a fabrication.
  assert.strictEqual(importFacts[0].alias, null);
  assert.strictEqual(importFacts[0].module, 'com.digitral.common');
});

// ---------------------------------------------------------------------------
// Finding 5 — the SAME alias bug in the extractor real Java ingests actually use
// (ast-extractor.js's regex path), plus the two further gaps in that same chain.
// ---------------------------------------------------------------------------

const { extractImports, buildAstNodes } = require('../src/services/ast-extractor');

test('finding 5: extractImports splits a Java class import into name/module/alias, not the whole FQCN twice', () => {
  const facts = extractImports('import com.digitral.common.utils.ConfigUtils;', 'java');
  assert.strictEqual(facts.length, 1);
  assert.strictEqual(facts[0].name, 'ConfigUtils');
  assert.strictEqual(facts[0].module, 'com.digitral.common.utils');
  // Before the fix this was "com.digitral.common.utils.ConfigUtils" (name === module === the
  // whole FQCN) — `name` could then never match a declared class's simple name, and the derived
  // alias could never match a call's receiver either.
  assert.strictEqual(facts[0].alias, 'ConfigUtils');
});

test('finding 5: extractImports gives distinct name/module/alias to two classes imported from the same package', () => {
  const facts = extractImports('import com.a.b.Foo;\nimport com.a.b.Bar;', 'java');
  assert.strictEqual(facts.length, 2);
  assert.deepStrictEqual(facts.map((f) => f.name), ['Foo', 'Bar']);
  assert.deepStrictEqual(facts.map((f) => f.alias), ['Foo', 'Bar']);
  assert.ok(facts.every((f) => f.module === 'com.a.b'));
});

test('finding 5: extractImports never aliases a static-member import (the member is used unqualified)', () => {
  const single = extractImports('import static org.junit.Assert.assertEquals;', 'java');
  assert.strictEqual(single[0].name, 'assertEquals');
  assert.strictEqual(single[0].module, 'org.junit.Assert');
  assert.strictEqual(single[0].alias, undefined, 'a static-member import must not carry an alias — nobody writes assertEquals.foo()');

  const wildcard = extractImports('import static org.junit.Assert.*;', 'java');
  assert.strictEqual(wildcard[0].alias, undefined);
});

test('finding 5: buildAstNodes stamps the FILE node with a correctly-split import and the calling METHOD with a bare-name callee', () => {
  const src = [
    'package com.example.consumer;',
    '',
    'import com.a.b.Foo;',
    'import com.a.b.Bar;',
    '',
    'public class Caller {',
    '  public void run() {',
    '    Foo.doFoo();',
    '    Bar.doBar();',
    '  }',
    '}',
  ].join('\n');
  const result = buildAstNodes(src, 'Caller.java');
  assert.deepStrictEqual(
    result.importFacts.map((f) => ({ name: f.name, module: f.module, alias: f.alias })),
    [
      { name: 'Foo', module: 'com.a.b', alias: 'Foo' },
      { name: 'Bar', module: 'com.a.b', alias: 'Bar' },
    ],
  );
  const run = result.nodes.find((n) => n.name === 'run');
  assert.ok(run, 'expected a METHOD node for run()');
  // cross-repo-edge-resolver.js's qualified-call binder looks up a declaration by `call.method`
  // (falling back to `call.callee`) — before the resolver-side fix it read `call.callee` only,
  // which here is "Foo.doFoo"/"Bar.doBar", never a declared method's bare name.
  assert.deepStrictEqual(
    run.callExpressions.map((c) => ({ receiver: c.receiver, method: c.method })),
    [
      { receiver: 'Foo', method: 'doFoo' },
      { receiver: 'Bar', method: 'doBar' },
    ],
  );
});

test('finding 5: blast_radius walks IMPORTS_SYMBOL, the edge type the cross-repo package plane writes at symbol grain', () => {
  const { REVERSE_EDGE_TYPES } = require('../src/services/blast-radius');
  assert.ok(
    REVERSE_EDGE_TYPES.includes('IMPORTS_SYMBOL'),
    'blast_radius must walk IMPORTS_SYMBOL or a resolved cross-repo symbol edge is invisible to it',
  );
});
