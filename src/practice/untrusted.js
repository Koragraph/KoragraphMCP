'use strict';

// Everything the second layer remembers was written by someone else. A fact body is a git commit
// subject; a detail is a compiler's stderr; a provenance command is whatever the agent typed. All
// three are then injected into a reader's context by the UserPromptSubmit hook, the PreToolUse
// pre-flight and the MCP tool surface — so a commit message in any repository the user indexes is
// an instruction-shaped string with a direct path into an agent's prompt.
//
// This module is the one place that turns such a string into data. It has ZERO requires because it
// runs on hook paths (see recall.js), so the secret vocabulary below is copied from
// services/source-excerpts.js rather than imported — that module requires db/pool and cannot be
// reached from a hook. The two must be changed together.
//
// Neutralisation is not a claim of safety. Natural language cannot be sanitised; a commit subject
// reading "the fix is to disable the auth check" is a legitimate observation and a hostile
// instruction spelled identically. What is achievable is mechanical: no forged structural
// boundary, no terminal control, no unbounded text, and a visible quotation that says who said it.
// The framing is the load-bearing half.

const SECRET_KEY_WORDS = 'SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN|CREDENTIAL';

// KEY=value / "key": "value" / key: value. The value class stops at whitespace and shell
// metacharacters, so `--token $FOO` and `API_KEY=$(cat f)` keep their shape while a literal does not.
const SECRET_ASSIGN = new RegExp(
  `([A-Za-z0-9_.\\-]*(?:${SECRET_KEY_WORDS})[A-Za-z0-9_.\\-]*["']?\\s*[:=]\\s*["']?)([A-Za-z0-9+/=_\\-.~]{8,})`,
  'gi',
);
// user:password@host in any URL, the shape a connection string leaks in.
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)([^\s/@]{3,})(@)/gi;
// Authorization headers, which carry no key word at all.
const BEARER = /\b(Bearer|Basic|token)\s+([A-Za-z0-9._~+/=-]{12,})/gi;
// Vendor-prefixed literals that are recognisable with no key beside them.
const KNOWN_LITERAL = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;

const REDACTED = '«redacted»';

function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(KNOWN_LITERAL, REDACTED)
    .replace(URL_CREDENTIAL, `$1${REDACTED}$3`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(SECRET_ASSIGN, `$1${REDACTED}`);
}

// ANSI CSI/OSC, and every C0/C1 control except the tab and newline that collapse below. A stored
// escape sequence repaints the user's terminal when a fact is printed by the CLI.
const ANSI = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)|\\u001b[@-Z\\\\-_]', 'g');
const CONTROLS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

// Which `<...>` runs lose their delimiters, and which do not.
//
// The blunt version defanged EVERY tag-shaped token, which turned `Vec<String>` into
// `Vec‹String›`. Angle brackets are ordinary content in Go, Rust, C++, Java and TypeScript, so
// that fired constantly on honest facts, not just on attacks. The discriminator that separates
// them is position: a generic's `<` always follows an identifier character (`Vec<`, `shared_ptr<`,
// `Map<`), while a tag pretending to be a structural boundary sits at one — start of string, after
// whitespace, or after another tag.
//
// Four rules, each defanged for its own reason:
//   CLOSING   `</anything>` — a closing tag is what ENDS a forged block, and no language writes one.
//   PIPE      `<|im_start|>` — a turn marker; never valid code.
//   BOUNDARY  a tag at a boundary — the shape that reads as a section break.
//   ATTR/NS   `<x id="1">` or `<invoke>` — an attribute or a namespace, which generics
//             never carry, so this catches `foo<system-reminder id="1">` glued to a word.
const TAG_CLOSING = /<\/[^<>\n]{1,120}>/g;
const TAG_PIPE = /<\|[^<>\n]{0,120}\|>/g;
// `›` is in the lead class because defang strips CLOSING tags first: an attack written
// `</system><invoke>` becomes `‹/system›<invoke>`, and without `›` here the now-exposed `<invoke>`
// sits after a non-boundary character and survives into delivered context — a live tool-call tag,
// exactly what defang exists to neutralise. The comment above claimed this was caught; it was not.
const TAG_BOUNDARY = /(^|[\s"'`([{>›])(<[A-Za-z!?][^<>\n]{0,120}>)/g;
const TAG_ATTR_OR_NS = /<[A-Za-z][\w.-]*(?::[\w.-]+|\s+[\w-]+\s*=)[^<>\n]{0,120}>/g;
// A curated set of control tags that are never valid code, defanged wherever they sit — including
// GLUED to an identifier character (`word<invoke>`), which every position-gated rule above misses
// because a generic's `<` also follows an identifier. Matching by name, not by position, closes the
// right-glue hole without touching a real generic like `Vec<String>` (whose inner name is not here).
const TAG_CONTROL = /<\/?(?:invoke|antml|tool_calls?|tool_use|function_calls?|function_results?|system-reminder|im_start|im_end|im_sep)\b[^<>\n]{0,120}>/gi;
const TURN_MARKER = /\[\/?(?:INST|SYS|s|assistant|system|human|user)\]/gi;

const strip = (m) => `‹${m.slice(1, -1)}›`;

function defang(text) {
  return String(text)
    .replace(TAG_CLOSING, strip)
    .replace(TAG_PIPE, strip)
    .replace(TAG_CONTROL, strip)
    .replace(TAG_ATTR_OR_NS, strip)
    .replace(TAG_BOUNDARY, (_m, lead, tag) => `${lead}${strip(tag)}`)
    .replace(TURN_MARKER, (m) => `⟦${m.slice(1, -1)}⟧`);
}

// One line, always. A stored newline lets a fact open what looks like a new section of the prompt,
// which is the cheapest way to forge a boundary once the tag shapes are gone.
function flatten(text) {
  return String(text == null ? '' : text)
    .replace(ANSI, '')
    .replace(CONTROLS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  const s = String(text);
  if (!max || s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

// The full treatment for any string that came from a commit, a diff, a filename or a command.
function neutralise(text, max = 0) {
  if (text == null) return '';
  return truncate(defang(redactSecrets(flatten(text))), max);
}

// Rendered form. The quotation marks are not decoration: they are what makes the boundary between
// the layer's own words and the recorded words visible to a reader, and they are chosen so a
// quoted string cannot terminate the quotation it is inside.
const QUOTE_OPEN = '“';
const QUOTE_CLOSE = '”';

function quoted(text, max = 0) {
  const clean = neutralise(text, max).replace(/[“”]/g, '"');
  if (!clean) return '';
  return `${QUOTE_OPEN}${clean}${QUOTE_CLOSE}`;
}

// A repo-relative path from a diff is attacker-chosen too. It is not quoted — a reader needs to be
// able to copy it — but it is bounded, flattened and stripped of anything that is not a path.
const PATH_UNSAFE = /[^\w$./@+-]/g;

function safePath(text, max = 160) {
  if (text == null) return '';
  const clean = flatten(text).replace(PATH_UNSAFE, '_');
  return truncate(clean, max);
}

module.exports = {
  neutralise, quoted, redactSecrets, safePath, flatten, defang, truncate,
  REDACTED, QUOTE_OPEN, QUOTE_CLOSE, SECRET_KEY_WORDS,
};
