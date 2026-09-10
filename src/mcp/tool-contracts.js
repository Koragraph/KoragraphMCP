'use strict';

// The tool surface. Nine tools, each justified by a question a developer actually asks mid-task,
// and one — remember — by the answer a developer gives.
// The discipline that keeps it right is refusing tools, and every rejection is argued in this
// file's commit message. The rejected names are pinned so the surface cannot
// regrow by accident.

// Read from package.json, not restated here. The literal that used to sit in this file said
// 0.1.0 while the package said 0.1.1, so every MCP client was told the wrong version -- and a
// hardcoded one drifts again at the next release by doing nothing.
const SERVER_INFO = Object.freeze({
  name: 'koragraph',
  version: require('../../package.json').version,
});

const SERVER_INSTRUCTIONS = [
  'Koragraph indexes your repositories as a code graph — declarations, calls, imports, cross-repo',
  'contracts, git-mined temporal coupling — plus a durable memory of what was learned the hard way',
  'on this machine.',
  'Call recall FIRST, before explore or search_code, whenever a symbol is unfamiliar or an error',
  'looks like it might have bitten before. It is the one tool not about the graph: a failed attempt',
  'and its fix, a hazard, a revert, a rule the developer stated — none of it recoverable by reading',
  'the code or grepping it. It is one fast call; silence just means nothing was recorded, not that',
  'nothing happened, so skipping it only risks redoing work a past session already paid for.',
  'Then start with explore for the code itself, and reach for it before grep: one call takes a',
  'symbol OR a plain-English phrase and returns the ranked declarations plus, for the top hits,',
  'their source, callers, and callees together — usually enough to answer "how does X work / where',
  'do I change it" in one call, without opening files or chaining tools. On an unfamiliar codebase',
  'it finds the right code in fewer steps than grepping, because it is searching a resolved graph,',
  'not raw text.',
  'Drop to the narrower tools once you know the shape: search_code to just locate a name,',
  'neighbours for the exact callers/callees of one symbol, blast_radius before editing to see what',
  'depends on the files you are about to change, changes_with for git-mined co-change, file_symbols',
  'to list one file, overview to orient on your first turn in an unfamiliar repo.',
  'Every tool returns file paths and line numbers — read the source yourself, the graph does not',
  'paste bodies at you.',
  'Once explore or search_code has answered, trust it: do not re-verify by grepping the source tree',
  'or opening files it did not point you at. That is duplicate work, not caution, and it is the',
  'single biggest thing that makes a koragraph-assisted turn cost more than it should.',
  'remember is recall\'s write side, and koragraph is where this repository\'s durable knowledge lives:',
  'it is the memory for this project, and it is the RIGHT place for anything specific to this',
  'codebase. Call remember when the developer tells you how things are done here, corrects you, or',
  'says "remember that" or "note that" — and when you spent real effort discovering something the',
  'code does not say. Prefer it over writing a note into a file: a fact recorded here is anchored',
  'to the declaration it is about and expires by itself when that code changes, so recording',
  'something is not a promise to maintain it. A note in a file cannot do either and goes stale',
  'silently.',
  'Every tool defaults to detail:"concise"; pass detail:"full" when the head of the answer was not',
  'enough.',
  'If you delegate research or a plan to a subagent, tell it explicitly to use these koragraph',
  'tools instead of grep/Read — a subagent does not inherit this instruction on its own, and one',
  'left to its own defaults will fall back to grepping even though it has the same tools connected.',
  'A real side-by-side measured this: an identical planning task delegated to an uninstructed',
  'subagent cost MORE than no MCP at all (schema overhead paid, tools never called), while the same',
  'task done directly against these tools cost less than the no-MCP baseline. The tools only pay for',
  'themselves when something actually calls them.',
  'explore/neighbours/blast_radius/file_symbols may attach a fact to a line with an',
  '"(unconfirmed since <date>)" marker: the code changed since that fact was last checked, and',
  'nobody has said whether it still holds. Several flagged facts on one node render as a short list',
  'instead, each keeping its own id. Resolve every one you can judge as part of doing the work — the',
  'moment you have enough information, not as a separate step: call remember with fact_id and',
  'confirm:true (still true) or verified:"contradicted" (no longer true), batched into ONE call when',
  'more than one id needs a verdict — never one remember call per fact. Do this silently: do not',
  'stop and ask, and do not report anything about it mid-task. Only after the WHOLE task is finished,',
  'if any were resolved, say so in one short line — "also updated N stale note(s) I found while',
  'working: <one-line summary>" — inform, never ask. Leave anything genuinely unclear flagged rather',
  'than guessing.',
].join(' ');

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const SYMBOL_ARG = Object.freeze({
  type: 'string',
  minLength: 1,
  description: 'Symbol name. Bare ("readAsCSV"), qualified ("Session.get"), or "file.go:readAsCSV".',
});

const FILE_ARG = Object.freeze({
  type: 'string',
  description: 'Optional disambiguator when the symbol name is defined in more than one place. Full path or basename.',
});

const PROJECT_ARG = Object.freeze({
  type: ['integer', 'string'],
  description: 'Optional scope: a repository or project name exactly as overview prints it, or its numeric id. Omit when the graph holds one project.',
});

// One argument, shared by every tool, rather than five differently-named knobs. `concise` is the
// default because a token admitted at turn t is re-billed on every turn after it (411 cache-read
// tokens per output token, measured locally) — the expensive answer has to be the one you ask for.
const DETAIL_ARG = Object.freeze({
  type: 'string',
  enum: ['concise', 'full'],
  default: 'concise',
  description: 'concise (default): a one-line answer plus the ranked head, file:line kept on every row. full: every row and every field.',
});

const TOOLS = Object.freeze([
  {
    name: 'explore',
    title: 'Explore code',
    description: [
      'Start here for the code itself, before grep/Read/find — call recall first if the symbol or',
      'an error looks like it might have bitten before. One call answers "how does X work / where',
      'do I change it": returns the ranked declarations for your query AND, for the top hits, their',
      'source, callers, and callees together — so you rarely need to open files, grep, or chain',
      'other tools. Use a symbol name or a plain-English phrase.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'A symbol name or a short plain-English description of what you want to understand or change.' },
        project_id: PROJECT_ARG,
        detail: DETAIL_ARG,
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_code',
    title: 'Search code',
    description: [
      'Find declarations by name, path, or description — before grepping the source tree. Answers',
      '"where is the code that does X?". Returns declarations with file paths and line numbers,',
      'ranked; it does not return source bodies — read the files yourself.',
      'This is the entry point: every other tool takes a symbol or a path you get from here.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'What you are looking for. A symbol name, a path fragment, or a short phrase.' },
        project_id: PROJECT_ARG,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        detail: DETAIL_ARG,
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'neighbours',
    title: 'Neighbours of a symbol',
    description: [
      'What is directly connected to this symbol. Answers "what calls this?" (direction "in") and',
      '"what does this call?" (direction "out"); both by default, because the inbound direction is',
      'the one you cannot get by reading the function body.',
      'Every relation carries the line it occurs on and how it was resolved, so you can tell a',
      'resolved call from an inferred one.',
      'Guess-grade edges (HEURISTIC_CALLS) and statistical co-change are excluded unless you ask',
      'for them; for co-change use changes_with instead.',
      'To trace a call chain, set depth > 1 and direction "out" (or "in" going backward) rather',
      'than calling neighbours again on each hop\'s result — one call then walks several hops and',
      'returns them tagged by hop number.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_ARG,
        file: FILE_ARG,
        direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allow-list, e.g. ["CALLS"]. Default: every non-heuristic relation type.',
        },
        include_heuristic: {
          type: 'boolean',
          default: false,
          description: 'Include HEURISTIC_CALLS — calls the resolver could not bind to one target. Guess-grade.',
        },
        include_cochange: {
          type: 'boolean',
          default: false,
          description: 'Include CO_CHANGES. Off by default: it is a statistical relation, not a call. Prefer changes_with.',
        },
        depth: {
          type: 'integer', minimum: 1, maximum: 6, default: 1,
          description: 'Hops to walk outward from symbol. 1 (default): its direct neighbours only. '
            + '>1: also walk that many hops further (each additional hop costs more graph lookups, not '
            + 'more round-trips) — use this to trace a chain in one call instead of calling neighbours '
            + 'once per hop.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 60 },
        project_id: PROJECT_ARG,
        detail: DETAIL_ARG,
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'changes_with',
    title: 'What changes with this symbol',
    description: [
      'Declaration-grain temporal coupling mined from git history: which functions have',
      'historically been edited in the same commits as this one.',
      'THIS IS NOT A CALL GRAPH. A CO_CHANGES edge is a statistical co-occurrence with no',
      'structural relationship implied — treat it as a hint about where else to look, never as',
      'evidence that one function invokes another. For structural relations use neighbours.',
      'Measured on a temporally split benchmark this lifted blast-radius recall@20 by 25%, but the',
      'gain was concentrated in one of four repositories and was flat in the other three. It is',
      'real and it is repo-dependent; weight it accordingly, and expect nothing at all on a',
      'repository with a short or squashed history.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_ARG,
        file: FILE_ARG,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        project_id: PROJECT_ARG,
        detail: DETAIL_ARG,
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'blast_radius',
    title: 'Blast radius of a change',
    description: [
      'What depends on the files you are about to change. Answers "if I edit these, what could',
      'break, and what is untested?".',
      'Walks reverse CALLS/IMPORTS/DEPENDS_ON/USES/REFERENCES edges from every declaration in the',
      'given files and returns a ranked, capped risk surface: nearest first, then callers with no',
      'visible test coverage first.',
      'Over-approximates on purpose — heuristic calls are included here, because a missed caller',
      'is worse than an extra one.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        files_changed: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Repository-relative paths, exactly as they appear in the graph.',
        },
        // NO default. A default here is not a default — validate.js materialises it into every
        // call, so an explicit depth always reached the service and the task policy's own depth
        // (1 for bugfix, 3 for refactor) could never apply. Omitting it is now what lets the
        // policy decide; with no task type the service's historical constant still applies.
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Override the walk depth. Omit to let task_type decide (bugfix 1, refactor 3), or 2 with no task_type.',
        },
        task_type: {
          type: 'string',
          enum: ['bugfix', 'feature', 'refactor', 'config', 'unknown'],
          description: 'What you are doing. bugfix tightens the walk to one hop and admits statistical co-change as a labelled hint; refactor widens it to three hops and admits guess-grade calls. Omit for the neutral projection.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        project_id: PROJECT_ARG,
        detail: DETAIL_ARG,
      },
      required: ['files_changed'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    title: 'What we already know about this',
    description: [
      'Call this FIRST — before explore or search_code — whenever a symbol is unfamiliar or an error',
      'looks like it might have bitten before. It is one fast call, and skipping it risks',
      're-discovering something a past session on this machine already learned the hard way.',
      'Read koramemory — prior experience with this code that is NOT in the code: an attempt that',
      'failed and the fix that worked, a hazard that keeps recurring, a revert, a rule the developer',
      'stated outright. Captured from this machine\'s own sessions and git history, anchored to a',
      'declaration, and expired automatically when the code it describes changes.',
      'THIS IS NOT A CALL GRAPH AND NOT SOURCE CODE. It returns no structure and no bodies — for',
      'structure use explore or neighbours, and read the file for the code.',
      'Call it with NO symbol and NO file to get this repository\'s most trouble-prone areas — the',
      'symbols and files that have needed repeated fixing, ranked by how often they recurred — which',
      'is the way to answer "what breaks most here / where should I be careful" without a name.',
      'When `file` (or `file`+`symbol`) names something with an open situational note anchored to',
      'it — "hold off on this for now", "mid-audit" — that surfaces too, alongside any facts.',
      'Silence is the common answer and means nothing was recorded, not that nothing happened.',
      'Every fact carries a tier — law (the developer said so) outranks observation (mechanically',
      'derived) — provenance, and an id: `koragraph practice why <id>` shows what produced it, and',
      'a wrong one can be killed by that id.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to recall about.' },
        file: { type: 'string', description: 'Repository-relative path. Use alone for file-level facts, or with symbol to disambiguate.' },
        task_type: {
          type: 'string',
          enum: ['bugfix', 'feature', 'refactor', 'config', 'unknown'],
          description: 'What you are doing. Only reorders equally-ranked facts; it never hides one.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        detail: DETAIL_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'remember',
    title: 'Remember this',
    description: [
      'Save something about THIS repository to koramemory — the durable, code-anchored memory for this',
      'codebase — so it never has to be learned twice: a rule the developer stated, a hazard that cost',
      'real time, an approach that was tried and does not work. koramemory is where such a fact belongs,',
      'in preference to writing it into a notes or memory file, which cannot anchor to code and cannot',
      'expire when that code changes. When you save one, tell the developer you saved it to koramemory.',
      'Call this whenever the developer tells you how things are done here, corrects you, says',
      '"remember that" / "note that" / "from now on", or when you have just spent significant effort',
      'discovering something that is not visible in the code. Recording it is one call and it is',
      'cheap; call it before you reply.',
      'You supply the coordinates, not the developer. `symbol` is the one that matters: a fact',
      'anchored to a declaration follows it through a rename and dies with it, which is the whole',
      'reason this store beats a notes file. A fact anchored to a file, or to nothing, is a notes',
      'file with a path attached — it cannot expire and it will still be asserted long after the',
      'code it describes is gone.',
      'So: decide what declaration the rule is ABOUT and pass it as `symbol`. If you do not already',
      'know the name, look it up — you have explore and search_code, and one lookup is cheaper than',
      'a fact that can never expire. Reach for `file` only when you looked and no single declaration',
      'owns the rule, and for neither only when the rule is genuinely true of the whole repository',
      '("we use commonjs everywhere", "never add a dependency without asking"). Those exist and are',
      'fine; what is not fine is defaulting to them because naming the declaration took a step.',
      'A rule that mentions a declaration is almost always ABOUT that declaration: "cacheSet takes',
      'ttl in milliseconds" is a fact about cacheSet, not a fact about the repository.',
      'The same applies to an open_loop when it is about something specific: "hold off on touching',
      'the payment module for now, mid-audit" should still pass `symbol` or `file` for the payment',
      'module, not just the body — an anchored loop resurfaces exactly when you are looking at the',
      'code it is about (see kind:"open_loop" below), not only at the start of a session. Do this on',
      'the spot, in the same call that opens the loop; do not treat "anchors to nothing" as the',
      'default just because the loop itself has no expiry. This still applies when the wording is',
      'vague and names nothing itself — "yeah just hold that off for now" or "leave it, we\'ll deal',
      'with it later" said right after looking at a file/symbol means THAT one; resolve the referent',
      'from what you were just discussing and call this tool, do not let vagueness be a reason to',
      'stay silent.',
      'A symbol that does not exist still stores, as status:"unanchored" — that is how a stale',
      'instruction is found, not an error. An open_loop given a `symbol`/`file` that the graph does',
      'not know still opens too, with `anchored:false` and a `missing` reason — the note itself is',
      'never lost, it just will not resurface at that code and needs restating once the code exists.',
      'By default this resolves the target repository from YOUR working directory. If your cwd is',
      'not a checkout of the repo the fact is about — a different project\'s session, a notes',
      'directory, a subagent — pass `repo` with the repository\'s name instead of letting the call',
      'fail or guessing at a path.',
      'Do NOT record what the code already says, a one-off instruction for this task, or anything',
      'you inferred rather than observed. A wrong memory is worse than no memory.',
      'Importing someone else\'s written rule (a line from CLAUDE.md/AGENTS.md) is different from',
      'stating your own: you did not observe it, so before storing it, read the code it names and',
      'pass `verified` with what you found — see that field\'s own description. Skipping this and',
      'storing an imported rule at full authority with no check is exactly the stale-instruction',
      'problem this tool exists to fix, just moved one step earlier.',
      'A fact you get back from explore/neighbours/recall may carry an "(unconfirmed since <date>)"',
      'marker — the code it is about changed body since it was last checked. Resolve it yourself, as',
      'part of the work, the moment you have enough information to judge it: pass `fact_id` (the',
      '`p#N` id shown next to it) with `confirm:true` if you looked and it still holds, or with',
      '`verified:"contradicted"` if it does not — see `fact_id`\'s own description for the batched',
      'form when a node surfaces more than one flagged fact at once. Do this silently; do not stop',
      'and ask, and do not report it mid-task — see `fact_id` for the one line it belongs in at the',
      'end.',
    ].join(' '),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          minLength: 1,
          description: 'The rule, in the developer\'s own words where they stated it. One sentence. Not a summary of the code. Omit entirely when this call is a `fact_id`/`confirm` verdict on an existing fact — there is nothing new to store.',
        },
        fact_id: {
          description: 'Resolve a verdict against an EXISTING fact instead of storing a new one — pair with `confirm:true` (still accurate) or `verified:"contradicted"` (no longer accurate). One id, or an array to report on several flagged facts from the same look in ONE call — never loop this tool once per fact. When an array, `verified`/`note` may each be a single value applied to every id, or an array aligned position-for-position (confirmed on one, contradicted on another) — an array MUST be exactly as long as `fact_id`, or the whole call is rejected rather than guessing which id a short array meant. The convenience form — omit `fact_id` and pass `symbol`/`file` instead — only works when exactly one flagged fact exists at that coordinate; otherwise this call is rejected with the ids to choose from, never guessed.',
          oneOf: [
            { type: 'integer' },
            { type: 'array', items: { type: 'integer' }, minItems: 1 },
          ],
        },
        confirm: {
          type: 'boolean',
          description: 'Facts only (never an open_loop — that only ever takes `resolve`). Pair with `fact_id` (or a resolvable `symbol`/`file`): you just read the code behind an "(unconfirmed since …)" flag and it is still accurate. Clears the flag in place — no new fact, no duplicate. This is the default verdict when `fact_id` is given with no `verified` at all; pass `verified:"contradicted"` instead when the code no longer matches.',
        },
        kind: {
          type: 'string',
          enum: ['law', 'hazard', 'ritual', 'tombstone', 'correction', 'open_loop'],
          description: 'law: the developer said so. hazard: this bites. ritual: how a command is run here. tombstone: tried and abandoned. correction: you were corrected. open_loop: a sticky note / unfinished task to resurface until done (not a rule to obey) — pass resolve:true to cross one off. If it is about specific code, pass symbol/file too so it resurfaces there, not only at session start.',
        },
        resolve: {
          type: 'boolean',
          description: 'open_loop only: mark the loop DONE instead of opening one. Match by loop_id, or by restating its body. Idempotent — closing an already-closed loop is a no-op.',
        },
        loop_id: {
          type: 'integer',
          description: 'open_loop + resolve: the loop#N to close, if you have it. Otherwise the body is matched.',
        },
        symbol: {
          type: 'string',
          description: 'The declaration this fact is ABOUT — the coordinate to prefer over every other, and the only one that makes the fact expire on its own. A fact/hazard anchored here dies when that declaration is rewritten or deleted; an open_loop anchored here resurfaces when that declaration is visited. Pass the bare name as it is declared (`cacheSet`, not `cacheSet()` or `cache.cacheSet`). If the rule names or describes one function, class or method, that is this field — look the name up with explore/search_code rather than leaving it empty. Leave it empty only when you checked and no single declaration owns the rule.',
        },
        file: {
          type: 'string',
          description: 'Repository-relative path this is about — the FALLBACK for when you looked and no single declaration owns the rule ("keep this file under 200 lines", a rule about a config or schema file). It is weaker than `symbol`: a file anchor survives a rename of the code inside it, so the fact outlives what it describes. Passing this does not stop a declaration being resolved from the body, but naming the declaration yourself is more reliable. Same effect as `symbol` for an open_loop: it resurfaces there instead of expiring.',
        },
        repo: {
          type: 'string',
          description: 'Name of the repository this is about, when your own working directory is NOT a checkout of it (a different project\'s session, a scratch/notes directory, a subagent). Omit when your cwd IS the repo the fact is about — that is the common case and it is resolved from cwd automatically. Must match a repository already in the graph; run overview to see the names.',
        },
        // NO default. validate.js materialises a schema default into every call, so a default here
        // would make every authored fact claim to be user-stated — including ones the agent wrote
        // on its own initiative, which are the ones that most need to be distinguishable.
        source: {
          type: 'string',
          enum: ['user', 'import', 'hook'],
          description: 'user: the developer stated it in this session. import: read out of an instruction file. Omit if unsure.',
        },
        verified: {
          description: 'Two uses. (1) Importing a rule someone else wrote (a CLAUDE.md/AGENTS.md line) rather than stating '
            + 'your own — read the current code the rule names FIRST, then say what you found. "confirmed": you read it and '
            + 'the code still does this. "contradicted": you read it and the code now does something else — it is still '
            + 'stored (so the disagreement is on record) but held back from every future reader until a human settles it. '
            + '"unverifiable": you could not check (no single piece of code to read, or it is too indirect) — stored but '
            + 'never delivered as law. Omit entirely for your own first-hand observations, where there is nothing to read '
            + 'and check against — you already know it because you just watched it happen. '
            + '(2) With `fact_id`: your verdict on an existing flagged fact — "confirmed" (same as `confirm:true`) or '
            + '"contradicted". With an array `fact_id`, pass either one value for all of them or an array aligned '
            + 'position-for-position, when the verdicts genuinely differ from the same look. Judge the fact\'s claim AS A '
            + 'WHOLE, not just its opening clause: a fact recording "X had no timeout — fixed by adding one" is '
            + 'CONFIRMED, not contradicted, when the timeout is still there — the fix holding IS the claim being true. '
            + '"contradicted" means the code now disagrees with what the fact asserts, not that the historical problem '
            + 'it describes is resolved (resolved is the whole point of a hazard-plus-fix fact).',
          oneOf: [
            { type: 'string', enum: ['confirmed', 'contradicted', 'unverifiable'] },
            { type: 'array', items: { type: 'string', enum: ['confirmed', 'contradicted', 'unverifiable'] }, minItems: 1 },
          ],
        },
        note: {
          description: 'With verified:"contradicted"/"unverifiable" (either use above): one sentence on what you actually '
            + 'found (what the code does now, or why you could not tell). Shown next to the fact. Array form aligns '
            + 'position-for-position with an array `fact_id`, same as `verified`.',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
        },
        detail: DETAIL_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'file_symbols',
    title: 'Symbols in a file',
    description: [
      'Everything the graph extracted from one file, with line ranges. Answers "what is in here?"',
      'without reading the whole file, and gives you the exact symbol names the other tools want.',
      'Use it to disambiguate when neighbours reports a symbol defined in several places.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Repository-relative path as it appears in the graph.' },
        node_types: { type: 'array', items: { type: 'string' }, description: 'Optional filter, e.g. ["METHOD","CLASS"].' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        detail: DETAIL_ARG,
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'overview',
    title: 'Orient in a repository',
    description: [
      'What matters in this repository, without needing to know a name first.',
      'Every other tool needs a query or a symbol you already know; this is the one to call on',
      'your FIRST turn in an unfamiliar codebase, or before planning a change.',
      'Returns: the declarations the most code depends on (weighted by what the dependency is,',
      'and ignoring unresolved guesses); the declarations that historically change TOGETHER, mined',
      'from git history; import cycles; and the node and edge counts by type.',
    ].join(' '),
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name to scope to. Omit when the store holds one repository.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        detail: DETAIL_ARG,
      },
      additionalProperties: false,
    },
  },
]);

const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));

// Lite mode (KORAGRAPH_MCP_LITE=1): a CLI-first install keeps the graph reachable in an editor
// through a minimal MCP surface instead of the full nine tools. Every tool definition and the
// instruction block are re-billed on every turn as cached context, so a smaller advertised surface
// is a smaller always-on cost. Lite advertises only the three verbs an agent reaches for unprompted,
// each with a one-line description, and a two-line instruction block; the other verbs stay reachable
// through the CLI (`koragraph <verb>`) and through getTool, so a direct call to one still validates.
const LITE_TOOL_NAMES = Object.freeze(['explore', 'recall', 'remember']);
const LITE_DESCRIPTIONS = Object.freeze({
  explore: 'Take a symbol or a plain-English phrase and get the ranked declarations plus the source, callers and callees of the top hits, in one call. Reach for it before grep to find where something is or how it works. Returns file:line; read the file yourself.',
  recall: 'Recall what was learned the hard way about this code: a past failure and its fix, a hazard, a stated rule, an open loop. Call it first when a symbol is unfamiliar or an error looks familiar; silence just means nothing was recorded.',
  remember: 'Save a durable, code-anchored fact about this repository to koramemory: a rule the developer stated, a hazard that cost time, an approach that failed. Anchor it to the declaration it is about via `symbol` so it follows a rename and expires with the code.',
});
const LITE_INSTRUCTIONS = [
  'Koragraph serves this repository as a resolved code graph plus a durable memory of what was',
  'learned here. Call recall first when a symbol is unfamiliar or an error looks familiar; use',
  'explore before grep to find code; use remember to save a code-anchored fact. Every result is',
  'file:line — read the file yourself.',
].join(' ');

function isLiteMode() {
  return process.env.KORAGRAPH_MCP_LITE === '1' || process.env.KORAGRAPH_MCP_LITE === 'true';
}

function serverInstructions() {
  return isLiteMode() ? LITE_INSTRUCTIONS : SERVER_INSTRUCTIONS;
}

function listTools() {
  const lite = isLiteMode();
  const tools = lite ? TOOLS.filter((t) => LITE_TOOL_NAMES.includes(t.name)) : TOOLS;
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: lite && LITE_DESCRIPTIONS[t.name] ? LITE_DESCRIPTIONS[t.name] : t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

function getTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

module.exports = {
  SERVER_INFO, SERVER_INSTRUCTIONS, TOOLS, TOOL_NAMES, listTools, getTool,
  isLiteMode, serverInstructions,
};
