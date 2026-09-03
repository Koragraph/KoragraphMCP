'use strict';

// This module classifies nothing. Its only job is the tripwire: does this prompt look like it
// might be worth remembering at all — a durable rule ("we always...", "never...", "prefer X over
// Y") OR a situational note ("hold off on X for now", "mid-audit, don't touch Y")? If so, the
// caller (stated.js, on the UserPromptSubmit hook) stages the developer's own words and surfaces a
// cheap nudge into context. The actual decision — is this a rule or a situation, does it name real
// code, what tier does it deserve, is it worth keeping at all — belongs to the agent, using the
// same judgment already instructed into `remember`'s tool description and KORAINIT.md. This module
// decides no kind, tier, or anchor, and produces no `confidence` field for anything downstream to
// treat as a classification.
//
// ZERO requires, transitively, and it must stay that way: this runs on the UserPromptSubmit hook
// path, where better-sqlite3 is synchronous with a busy wait, so a single require that reaches
// graph.db stalls the user's editor for the length of an ingest. Hence string logic only — no
// tokenizer, no model, no network.
//
// The trigger fires on rule-shaped OR situation-shaped language, which pulls directly against
// "default to silence" (token cost is a first-class constraint): a wider trigger means more false
// positives. The answer is not a narrower trigger — a narrow one that only catches rule-shaped
// language misses every genuine situational statement, which is worse than a false positive. The
// answer is to keep the OUTPUT nearly free even when it fires: the nudge is a single trailing
// clause, never a paragraph, and there is no output at all on the common case where nothing looked
// worth a second glance. A wrong guess here costs almost nothing to ignore, so a trigger biased
// toward firing is the right trade.

const MAX_PROMPT = 400;

const RULE_WORDS = Object.freeze([
  'always', 'never', 'we use', 'we do not', "we don't", 'we always', 'we never', 'we only',
  'in this repo', 'in this project', 'in this codebase', 'here we', 'from now on',
  'every time', 'only ever', 'prefer', 'should', 'must', 'the rule is', 'convention',
  'our policy', 'the policy', 'avoid using', 'avoid hardcoding', 'stay away from', 'steer clear of',
  // A durable rule is often stated as a modal obligation ("every write HAS TO be atomic") or scoped
  // to all future work ("GOING FORWARD ..."), not with one of the fixed adverbs above. Found missing
  // by running natural developer corrections through the tripwire: "i want every write crash-safe
  // going forward" and "like i told you, every write has to be atomic" both went silent. Cheap to
  // add, and a false fire is one ignorable nudge — the trade this module is built to make.
  'going forward', 'has to', 'have to', 'has to be', 'needs to be',
]);

// A bare weak word ("should", "must", "prefer", "convention") reads as a rule in an imperative
// statement and as ordinary hedge/question prose everywhere else. An interrogative opener with no
// other signal is a question about what to do, not a statement of what IS done, however many rule
// words it contains, so this guard vetoes on it before a rule word alone gets to fire.
const INTERROGATIVE_OPENER = /^(?:what|how|why|when|where|who|which|whose|could|would|can|should|is|are|do|does|did)\b/i;

// The situation-shaped counterpart to RULE_WORDS: language that scopes a statement to a temporary
// state rather than a standing rule. This vocabulary FIRES the tripwire rather than suppressing
// it, because a situation is a real, valuable thing to capture (open_loop), not noise to discard.
const SITUATION_WORDS = Object.freeze([
  'for now', 'right now', 'hold off', 'holding off', 'mid-audit', 'mid-migration', 'mid-refactor',
  'until', 'this week', 'this sprint', 'not yet', 'still need to', 'still need', 'todo:', 'later,',
  'once we', 'we have not decided', "we haven't decided", 'on hold', 'blocked on', 'waiting on',
  'do not touch', "don't touch", 'careful with', 'watch out for', 'heads up',
  // Real chat is dismissive, not procedural — nobody says "mid-audit" out loud. These are how a
  // developer actually defers something in a sentence or two, found missing this by running live
  // sentences through the tripwire and checking it fired.
  'leave it', 'skip it', 'skip that', 'deal with it later', 'deal with that later', 'not a priority',
  'no rush', 'circle back', 'get to it later', 'come back to it', 'not now', 'later this', 'after the',
  'after launch', 'after release', 'next sprint', 'next week', "we'll revisit", 'revisit later',
]);

// A fixed phrase list cannot catch a verb split by the pronoun it governs — "hold THAT off" does not
// contain the substring "hold off". Small, targeted set of the shapes that actually happens in,
// rather than a generic parser this module deliberately has none of (see file header: string logic
// only, zero requires).
const SPLIT_SITUATION_RE = /\b(?:hold|put|push)\s+(?:it|that|this|them|those)\s+(?:off|back)\b/i;

// Explicit capture requests — the most direct way a developer asks for something to be remembered,
// and the exact shape that was slipping through the tripwire: a verb of saving/noting governing
// this/that/it, a "... down" reminder, or a fixed phrase ("note to self", "keep this in mind"). This
// FIRES on its own, and it fires even after an interrogative opener ("can you remember that …?"),
// because it is a request to capture, not a question about the code. The pronoun object is gated so
// an ordinary file action ("save this file", "save it to disk") stays out — that names a target on
// disk, not a memory. "remind me" is included: a reminder is an open_loop the same way a deferral is.
const SAVE_REQUEST_RE = new RegExp([
  /\b(?:save|remember|memoris(?:e|ing)?|memoriz(?:e|ing)?|note|jot|stash)\s+(?:this|that|it)\b(?!\s+(?:file|files|change|edit|line|function|method|code|state|version)\b|\s+to\s+(?:disk|a\s+file|the\s+file))/,
  /\b(?:note|jot|write|take)\s+(?:this|that|it|the\s+following)?\s*down\b/,
  /\bmake\s+(?:a|another|quick)\s+note\b/,
  /\bnote\s+to\s+self\b/,
  /\bfor\s+the\s+record\b/,
  /\b(?:keep|bear)\s+(?:this|that|it)?\s*in\s+mind\b/,
  /\b(?:put\s+a\s+pin\s+in|pin)\s+(?:this|that|it)\b/,
  /\bdon'?t\s+forget\s+(?:this|that|it)\b/,
  /\bremind\s+me\b/,
  /\bthings?\s+to\s+remember\b/,
].map((r) => r.source).join('|'), 'i');

// A deferral to a named future time ("save that for wednesday", "till tomorrow", "next week"). On its
// own this is a situation worth an open_loop; alongside a save request it dates the reminder. Gated to
// a preposition + time so an ordinary "next step" / "by the way" does not trip it.
const DEFER_TARGET_RE = /\b(?:for|til|till|until|by|on|come)\s+(?:tomorrow|tonight|tmrw|mon(?:day)?|tues(?:day)?|wednes(?:day)?|thurs(?:day)?|fri(?:day)?|satur(?:day)?|sun(?:day)?|later|the\s+(?:next|following|weekend|morning)|next\s+(?:time|week|day|session|sprint|month))\b/i;

const TOOL_NAMES = Object.freeze([
  'jest', 'vitest', 'mocha', 'pytest', 'junit', 'rspec', 'npm', 'pnpm', 'yarn', 'bun', 'deno',
  'node', 'eslint', 'prettier', 'webpack', 'vite', 'rollup', 'esbuild', 'babel', 'tsc',
  'typescript', 'react', 'vue', 'svelte', 'angular', 'django', 'flask', 'fastapi', 'express',
  'fastify', 'nest', 'rails', 'docker', 'kubernetes', 'terraform', 'ansible', 'postgres',
  'postgresql', 'sqlite', 'better-sqlite3', 'redis', 'mysql', 'mongodb', 'prisma', 'drizzle',
  'knex', 'sequelize', 'mongoose', 'graphql', 'grpc', 'protobuf', 'openapi', 'axios', 'lodash',
  'tailwind', 'sass', 'cargo', 'gradle', 'maven', 'poetry', 'pip', 'uv', 'make', 'bazel',
  'ruff', 'flake8', 'black', 'isort', 'mypy', 'pylint', 'gofmt', 'clippy', 'rustfmt', 'biome',
  // No LLM-vendor names here, deliberately: the invariant that no code in this tree can make a paid
  // call is worth more than one extra word in a detector's vocabulary.
  'tree-sitter', 'llama.cpp', 'pgvector',
]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (list) => list.map(escape).join('|');

const RULE_WORD_RE = new RegExp(`\\b(?:${alternation(RULE_WORDS)})\\b`, 'i');
const SITUATION_WORD_RE = new RegExp(`\\b(?:${alternation(SITUATION_WORDS)})\\b`, 'i');
const TOOL_RE = new RegExp(`\\b(?:${alternation(TOOL_NAMES)})\\b`, 'i');

// Two openers wear the shape of a rule/situation and carry none. "never mind" prohibits nothing, and
// "don't forget TO …/ABOUT …" is a reminder about one in-flight task, not a standing ban. But
// "don't forget THIS/THAT/IT" is the opposite — an explicit ask to keep something — so the veto is
// scoped to the to/about forms and leaves the pronoun form for SAVE_REQUEST_RE to catch.
const NON_RULE_OPENER = /^(?:never\s?mind\b|(?:don'?t|do not|never)\s+forget\s+(?:to|about)\b)/i;

const CORRECTIVE_MARKERS = Object.freeze([
  'no,', 'nope,', 'nah,', "don't", 'do not', 'stop', 'never', 'actually', 'instead of',
  'again,', 'revert', 'undo', 'wrong', "that's wrong", 'why did you',
  'why are you', 'you should have', "you shouldn't have", 'i told you', 'i already told you',
  'as i said',
]);

const LEADING_MARKERS = [
  /^(?:no|nope|nah)\b\s*[,.!:;—–-]/i,
  /^(?:don'?t|do not)\b\s/i,
  /^stop\b\s/i,
  /^never\b\s/i,
  /^instead of\b\s/i,
  /^actually\b/i,
  /^again\s*,/i,
  /^(?:(?:that'?s|that is|this is)\s+)?wrong\b/i,
  /^(?:revert|undo)\b\s/i,
];

const ANYWHERE_MARKERS = [
  /\bi (?:already )?told you\b/i,
  /\bas i (?:said|mentioned)\b/i,
  /\byou should(?:n'?t)? have\b/i,
  /\b(?:that|this)(?:'s| is| was)? wrong\b/i,
  /\bwhy (?:did|are|would) you\b/i,
];

const IDENTIFIERS = [
  /`[^`\n]{2,}`/,
  /(?:^|\s)[\w@~.-]*\/[\w@~./-]+/,
  /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rb|rs|java|kt|swift|scala|ex|sol|sh|zig|ml|res|json|ya?ml|toml|md|sql|css|html|vue|db|env)\b/i,
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/,
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/,
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/,
  /\b\w+\(\)/,
];

// "we use vitest not jest", "prefer ruff over flake8" — carries neither a RULE_WORD nor a leading
// marker, so nothing else here would catch it. Gated to a known tool or code identifier on one
// side, which is what keeps prose out ("not sure which file to use").
const BARE_CONTRAST = /\b(?:we\s+use|use|using|prefer|go with|stick with|switch(?:ed)? to|it'?s|we'?re using|we'?re on)\s+([`\w@./+-]{2,40})\s*,?\s+(?:not|instead of|rather than|over)\s+([`\w@./+-]{2,40})/i;

function bareToolContrast(flat) {
  const m = BARE_CONTRAST.exec(flat);
  if (!m) return false;
  const idish = (t) => TOOL_RE.test(t) || IDENTIFIERS.some((re) => re.test(t));
  return idish(m[1]) || idish(m[2]);
}

const FILLER = /^(?:ok(?:ay)?|hmm+|uh+|erm|hey|wait|ugh|argh|so|well|please|yeah|yep|right|also|btw|fyi|oh)\b[\s,.:;!—–-]*/i;

// A typed apostrophe arrives curly from every editor with smart quotes on.
const collapse = (text) => String(text).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

// The only capture worth keeping: the developer's own words, trimmed of a leading filler/marker
// word and capped. Deliberately not isolating which sentence within the prompt "is the rule" —
// that would be a classification decision, and this module makes none. What is staged is the
// prompt as the developer typed it, because the agent reviewing the nudge already has the full
// prompt in its own context; this capture exists for the audit trail and for a caller that does not.
const MAX_BODY = 300;
const MIN_BODY = 8;

function trimBody(text) {
  let body = collapse(text).replace(FILLER, '').trim();
  if (body.length <= MAX_BODY) return body;
  const cut = body.slice(0, MAX_BODY);
  const at = cut.lastIndexOf(' ');
  return `${(at > 40 ? cut.slice(0, at) : cut).replace(/[\s,;:.—–-]+$/, '')}…`;
}

// `context` may be absent — the hook does not always carry it — so it may only ever WITHHOLD.
function looksWorthRemembering(prompt) {
  if (typeof prompt !== 'string') return null;
  const raw = prompt.trim();
  if (!raw || raw.length > MAX_PROMPT) return null;
  if (raw.includes('```')) return null;
  if (raw.startsWith('/') || raw.startsWith('@')) return null;
  if (NON_RULE_OPENER.test(raw)) return null;

  const flat = collapse(raw);
  if (!/\s/.test(flat) && /[/.]/.test(flat)) return null;
  if (flat.endsWith('?')) return null;

  const stripped = flat.replace(FILLER, '').trim();

  const signals = [];
  const marker = [...LEADING_MARKERS, ...ANYWHERE_MARKERS].find((re) => re.test(stripped));
  if (marker) signals.push('marker');
  const ruleWord = RULE_WORD_RE.test(stripped);
  if (ruleWord) signals.push('rule-word');
  const situationWord = SITUATION_WORD_RE.test(stripped) || SPLIT_SITUATION_RE.test(stripped);
  if (situationWord) signals.push('situation-word');
  const saveRequest = SAVE_REQUEST_RE.test(stripped);
  if (saveRequest) signals.push('save-request');
  const deferTarget = DEFER_TARGET_RE.test(stripped);
  if (deferTarget) signals.push('defer-target');
  const preference = bareToolContrast(stripped);
  if (preference) signals.push('preference-contrast');
  const identifier = IDENTIFIERS.some((re) => re.test(flat));
  if (identifier) signals.push('identifier');
  const tool = TOOL_RE.test(flat);
  if (tool) signals.push('tool');

  // A marker or a tool/identifier alone is common in ordinary task prose ("wrong file, try
  // src/foo.js"), so it needs company — a rule word, a situation word, or a preference contrast —
  // to clear the tripwire. A rule/situation word or a preference contrast is strong enough alone,
  // UNLESS the prompt opens as a question about what to do ("what should we use here") — that is a
  // request for an answer, not a statement of one, however many rule words it contains.
  const interrogative = INTERROGATIVE_OPENER.test(stripped);
  // A save request fires regardless of an interrogative opener — "can you remember that we deploy on
  // fridays" is a request to capture, not a question. Everything else keeps the interrogative veto.
  const fires = saveRequest
    || (!interrogative && (ruleWord || situationWord || deferTarget))
    || preference || (marker && (identifier || tool));
  if (!fires) return null;

  const body = trimBody(flat);
  if (body.length < MIN_BODY) return null;

  return { body, signals };
}

module.exports = {
  looksWorthRemembering,
  CORRECTIVE_MARKERS,
  RULE_WORDS,
  SITUATION_WORDS,
  SPLIT_SITUATION_RE,
  SAVE_REQUEST_RE,
  DEFER_TARGET_RE,
  TOOL_NAMES,
  MAX_PROMPT,
  MAX_BODY,
  MIN_BODY,
};
