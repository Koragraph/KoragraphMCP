'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Truth maintenance for the one grain that had none.
//
// `revalidate.js` returns `ok` unconditionally for a repo-grain anchor, and says why: its only
// claim is "this repository exists", and the branch resolving IS that claim. That reasoning is
// right about the ANCHOR and wrong about the FACT. "Always use vitest here, never jest" is not a
// claim about a repository existing; it is a claim about a toolchain, and toolchains change.
//
// So repo-grain facts were immortal — and they are exactly the class a CLAUDE.md is made of, which
// makes them exactly the class this layer promises to expire and did not.
//
// Not diffable does not mean not checkable. A tool preference leaves structural evidence in the
// manifest, and that evidence is cheap, deterministic and needs no model. What it does NOT justify
// is expiry: a developer stated this, and a manifest is weaker evidence than a person. A
// contradiction is therefore RECORDED and withheld from delivery, never silently expired — the
// developer can see it in `practice list` and settle it.

// "use vitest, not jest" / "always vitest, never jest" / "we use vitest instead of jest".
// Deliberately narrow. A pattern that fires on prose it does not understand would mark real rules
// contradicted, and a memory layer that deletes true things is worse than one that forgets slowly.
const PREFER_AVOID = [
  /\b(?:use|prefer)\s+([A-Za-z][\w.@/-]{1,40})\b[^.]{0,30}?\b(?:not|never|instead of|rather than)\s+([A-Za-z][\w.@/-]{1,40})\b/i,
  /\b(?:always)\s+(?:use\s+)?([A-Za-z][\w.@/-]{1,40})\b[^.]{0,30}?\bnever\s+(?:use\s+)?([A-Za-z][\w.@/-]{1,40})\b/i,
];

// Words that match the shape but name no tool. Without this, "use it, not that" parses.
const NOT_A_TOOL = new Set([
  'it', 'this', 'that', 'them', 'these', 'those', 'the', 'a', 'an', 'one', 'any', 'some',
  'code', 'tests', 'test', 'files', 'file', 'here', 'there', 'we', 'you', 'i',
]);

function parsePreference(body) {
  const text = String(body || '');
  for (const re of PREFER_AVOID) {
    const m = re.exec(text);
    if (!m) continue;
    const prefer = m[1].toLowerCase().replace(/[.,;:]+$/, '');
    const avoid = m[2].toLowerCase().replace(/[.,;:]+$/, '');
    if (!prefer || !avoid || prefer === avoid) continue;
    if (NOT_A_TOOL.has(prefer) || NOT_A_TOOL.has(avoid)) continue;
    return { prefer, avoid };
  }
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Every dependency name the repository declares, from the manifests we can read without a model.
// Returns null — not an empty set — when there is no manifest at all, because "this repo declares
// nothing" and "we could not look" are different answers and only one of them may contradict.
function declaredDependencies(repoRoot) {
  if (!repoRoot) return null;
  const names = new Set();
  let sawManifest = false;

  const pkg = readJson(path.join(repoRoot, 'package.json'));
  if (pkg) {
    sawManifest = true;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] || {})) names.add(name.toLowerCase());
    }
    // A tool can be present as a script verb without being a declared dependency (`npx vitest`).
    for (const cmd of Object.values(pkg.scripts || {})) {
      for (const word of String(cmd).split(/[^\w.@/-]+/)) if (word) names.add(word.toLowerCase());
    }
  }

  for (const [file, re] of [
    ['pyproject.toml', /^\s*(?:name\s*=\s*)?["']?([A-Za-z][\w.-]*)["']?\s*(?:[=~<>]|$)/gm],
    ['requirements.txt', /^\s*([A-Za-z][\w.-]*)/gm],
    ['go.mod', /^\s*require\s+([^\s]+)/gm],
  ]) {
    let text;
    try { text = fs.readFileSync(path.join(repoRoot, file), 'utf8'); } catch { continue; }
    sawManifest = true;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) names.add(String(m[1]).toLowerCase());
  }

  return sawManifest ? names : null;
}

// A config file named after the tool is presence too: vitest.config.ts, jest.config.js, .eslintrc.
function hasConfigNamed(repoRoot, tool) {
  if (!repoRoot || !tool) return false;
  let entries;
  try { entries = fs.readdirSync(repoRoot); } catch { return false; }
  const t = tool.toLowerCase();
  return entries.some((e) => {
    const n = e.toLowerCase();
    return n === t || n.startsWith(`${t}.config`) || n === `.${t}rc` || n.startsWith(`.${t}rc.`);
  });
}

function present(names, repoRoot, tool) {
  if (names && names.has(tool)) return true;
  // A scoped package: a rule naming `jest` should see `@types/jest` as presence of jest.
  if (names && [...names].some((n) => n === `@${tool}` || n.endsWith(`/${tool}`) || n.startsWith(`${tool}-`))) return true;
  return hasConfigNamed(repoRoot, tool);
}

// The verdict for ONE repo-grain fact. Three-valued on purpose, and `unknown` is the default:
// no parseable preference, no manifest, or a checkout we cannot read all mean "cannot tell", and
// cannot-tell must never contradict.
function checkRepoFact(body, repoRoot, deps = {}) {
  const pref = parsePreference(body);
  if (!pref) return { status: 'unknown', reason: 'no checkable claim' };
  if (!repoRoot || !fs.existsSync(repoRoot)) return { status: 'unknown', reason: 'checkout not found' };

  const names = deps.declared !== undefined ? deps.declared : declaredDependencies(repoRoot);
  if (!names) return { status: 'unknown', reason: 'no manifest to check against' };

  const avoidPresent = present(names, repoRoot, pref.avoid);
  const preferPresent = present(names, repoRoot, pref.prefer);

  // BOTH conditions, deliberately. The forbidden tool being present is not enough on its own — a
  // repository can carry jest transitively while really running vitest — so the preferred tool
  // must also be GONE before this says the rule no longer describes the repository.
  if (avoidPresent && !preferPresent) {
    return {
      status: 'contradicted',
      // `manifest:` marks who raised this. revalidate clears only its own contradictions; a
      // developer's, marked `stated:`, must survive a manifest that agrees again.
      reason: `manifest: the rule prefers ${pref.prefer} over ${pref.avoid}, but this repository `
        + `declares ${pref.avoid} and not ${pref.prefer}`,
      prefer: pref.prefer,
      avoid: pref.avoid,
    };
  }
  return { status: 'ok', reason: `${pref.prefer} still present`, prefer: pref.prefer, avoid: pref.avoid };
}

module.exports = { checkRepoFact, parsePreference, declaredDependencies, present };
