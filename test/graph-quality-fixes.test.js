'use strict';

// Regression coverage for three findings from hands-on testing of `neighbours` and `blast_radius`
// against a real 45-file Java Spring repository:
//
//   1. neighbours(direction: "in") on a class buried its one real external caller behind the
//      class's own methods/fields reporting themselves as "callers" via CONTAINS/DEFINED_IN.
//   2. blast_radius missed a caller that only ever reaches a class through its interface type —
//      the common Spring/DI shape — and surfaced an unrelated IMPORTS edge instead.
//   3. blast_radius (and neighbours) could report a DEPENDS_ON/IMPLEMENTS edge whose only
//      "evidence" was a class name appearing inside a comment or dead code, never a live reference.
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
