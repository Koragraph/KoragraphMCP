<?php
/**
 * PRIMARY ground truth for PHP — from PHP's own compiler, via the `ast` extension.
 *
 * Why this exists. Koragraph reads PHP with a line-based scanner and Graphify reads it with
 * tree-sitter, so unlike Go the two systems do not share a parser — but tree-sitter-php is still
 * Graphify's own grammar, and grading them with it would score one side by its own definition of
 * a declaration. `ext/ast` exposes the abstract syntax tree the PHP compiler itself builds, so
 * this referee is not a reimplementation of PHP's grammar: it IS PHP's grammar. It needs no
 * autoloader, no composer install and no include path — it parses one file at a time.
 *
 * Universal Ctags is the second referee (`ast-referee-ctags.py --lang php`).
 *
 * TAXONOMY — fixed here, before any measurement, and mirrored in that referee's header.
 *
 *   types      class · interface · trait · enum (PHP 8.1). NAMED only.
 *   methods    every named function declaration: a class/interface/trait/enum method, an
 *              abstract method signature, and a `function` declared at file scope OR inside a
 *              function body — PHP declares the latter into the global namespace at runtime, so
 *              it is a real declaration, and both referees emit it.
 *   fields     class properties · class constants · enum cases · promoted constructor
 *              properties (`__construct(private Logger $log)`), which declare a real property
 *              with no other syntax — the same rule the TypeScript taxonomy already applies to
 *              constructor parameter properties.
 *   constants  file/namespace-level `const X = 1` and `define('X', 1)`.
 *
 * Excluded, and why: anonymous classes (`new class {}`), closures and arrow functions — no
 * stable identifier to match on, the same exclusion computed property names get in TypeScript;
 * `use` imports and the `namespace` clause (not declarations of program entities); parameters
 * that are not promoted; and top-level `$var = ...` assignments, which are statements executed
 * in global scope rather than declarations — PHP spells a declared constant `const`/`define`.
 *
 *   php ast-referee-phpast.php <repoPath> [--out truth.json]
 */

if (!extension_loaded('ast')) {
    fwrite(STDERR, "the `ast` extension is required: pecl install ast\n");
    exit(1);
}

$repo = $argv[1] ?? null;
if ($repo === null) {
    fwrite(STDERR, "usage: php ast-referee-phpast.php <repoPath> [--out f.json]\n");
    exit(1);
}
$outPath = null;
foreach ($argv as $i => $a) {
    if ($a === '--out') {
        $outPath = $argv[$i + 1] ?? null;
    }
}

// Must mirror ast-dump.js's php skip set exactly, or truth and output are taken over different
// file sets and every score is meaningless. `vendor` is a dependency tree, not this project's
// source, and laravel and phpunit both carry one.
const SKIP = ['.git', 'node_modules', 'target', 'build', 'vendor', '.gradle', 'out'];

$out = [
    'repo' => $repo, 'lang' => 'php', 'referee' => 'php ext/ast (the PHP compiler AST)',
    // ext/ast exposes the compiler's AST at a versioned shape, and PHP's own grammar changes
    // between minor releases. Both pins belong in the truth file or a published number carries
    // no provenance.
    'referee_version' => 'php ' . PHP_VERSION . ' / ext-ast ' . (phpversion('ast') ?: 'unknown')
        . ' / ast-node-version 110',
    'files' => 0, 'parse_errors' => 0, 'total_bytes' => 0, 'error_bytes' => 0,
    'error_files' => [], 'types' => [], 'methods' => [], 'fields' => [], 'constants' => [],
];

function walkFiles(string $root): array {
    $paths = [];
    $it = new RecursiveIteratorIterator(
        new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
            function ($current) {
                return !($current->isDir() && in_array($current->getFilename(), SKIP, true));
            }
        )
    );
    foreach ($it as $f) {
        if ($f->isFile() && strtolower($f->getExtension()) === 'php') {
            $paths[] = $f->getPathname();
        }
    }
    sort($paths);
    return $paths;
}

/** php-ast reports a class's own line; the name of an anonymous class is a generated string. */
function isAnonymous(ast\Node $n): bool {
    return (bool) ($n->flags & ast\flags\CLASS_ANONYMOUS);
}

function classKind(ast\Node $n): string {
    if ($n->flags & ast\flags\CLASS_INTERFACE) return 'interface';
    if ($n->flags & ast\flags\CLASS_TRAIT) return 'trait';
    if ($n->flags & ast\flags\CLASS_ENUM) return 'enum';
    return 'class';
}

const PROMOTION_FLAGS = 7; // MODIFIER_PUBLIC | MODIFIER_PROTECTED | MODIFIER_PRIVATE

/**
 * One walk over the tree. `$owner` is the innermost NAMED type, which is what a field belongs
 * to; a method inside an anonymous class keeps its own name (it is a real, findable declaration)
 * but reports no owner.
 */
function walk($node, string $rel, ?string $owner, array &$out): void {
    if (!($node instanceof ast\Node)) return;
    $kind = $node->kind;
    $line = $node->lineno;

    switch ($kind) {
        case ast\AST_CLASS:
            $name = $node->children['name'] ?? null;
            $nextOwner = $owner;
            if (is_string($name) && $name !== '' && !isAnonymous($node)) {
                $out['types'][] = [
                    'file' => $rel, 'name' => $name, 'kind' => classKind($node),
                    'line' => $line, 'end_line' => $node->endLineno ?? $line,
                ];
                $nextOwner = $name;
            } else {
                $nextOwner = null;
            }
            foreach ($node->children as $c) {
                if (is_array($c)) { foreach ($c as $cc) walk($cc, $rel, $nextOwner, $out); }
                else walk($c, $rel, $nextOwner, $out);
            }
            return;

        case ast\AST_METHOD:
        case ast\AST_FUNC_DECL:
            $name = $node->children['name'] ?? null;
            if (is_string($name) && $name !== '') {
                $out['methods'][] = [
                    'file' => $rel, 'name' => $name,
                    'kind' => $kind === ast\AST_METHOD ? 'method' : 'function',
                    'owner' => $kind === ast\AST_METHOD ? $owner : null,
                    'line' => $line, 'end_line' => $node->endLineno ?? $line,
                ];
            }
            // A promoted constructor parameter declares a property and has no other syntax.
            if ($kind === ast\AST_METHOD && strcasecmp((string) $name, '__construct') === 0) {
                $params = $node->children['params'] ?? null;
                if ($params instanceof ast\Node) {
                    foreach ($params->children as $p) {
                        if (!($p instanceof ast\Node) || !($p->flags & PROMOTION_FLAGS)) continue;
                        $pn = $p->children['name'] ?? null;
                        if (is_string($pn) && $pn !== '') {
                            $out['fields'][] = [
                                'file' => $rel, 'name' => $pn, 'kind' => 'promoted_property',
                                'owner' => $owner, 'line' => $p->lineno,
                            ];
                        }
                    }
                }
            }
            break;

        case ast\AST_PROP_ELEM:
            $name = $node->children['name'] ?? null;
            if (is_string($name) && $name !== '') {
                $out['fields'][] = ['file' => $rel, 'name' => $name, 'kind' => 'property',
                                    'owner' => $owner, 'line' => $line];
            }
            break;

        case ast\AST_ENUM_CASE:
            $name = $node->children['name'] ?? null;
            if (is_string($name) && $name !== '') {
                $out['fields'][] = ['file' => $rel, 'name' => $name, 'kind' => 'enum_case',
                                    'owner' => $owner, 'line' => $line];
            }
            break;

        case ast\AST_CLASS_CONST_GROUP:
            foreach (($node->children['const']->children ?? []) as $el) {
                $n = $el->children['name'] ?? null;
                if (is_string($n) && $n !== '') {
                    $out['fields'][] = ['file' => $rel, 'name' => $n, 'kind' => 'class_constant',
                                        'owner' => $owner, 'line' => $el->lineno];
                }
            }
            return;

        case ast\AST_DECLARE:
            // `declare(strict_types=1);` is a COMPILER DIRECTIVE, and php-ast models its
            // directive list as an AST_CONST_DECL — so every PHP file in existence looked like
            // it declared a constant named `strict_types`. That was 216 of monolog's 216
            // "constants", one per file, which is the ratio that gave it away. Only the block
            // form `declare(ticks=1) { ... }` has real statements under it, and those are in
            // `stmts`, so `declares` is skipped and `stmts` is walked.
            walk($node->children['stmts'] ?? null, $rel, $owner, $out);
            return;

        case ast\AST_CONST_DECL:
            foreach ($node->children as $el) {
                if (!($el instanceof ast\Node)) continue;
                $n = $el->children['name'] ?? null;
                if (is_string($n) && $n !== '') {
                    $out['constants'][] = ['file' => $rel, 'name' => $n, 'kind' => 'const',
                                           'line' => $el->lineno];
                }
            }
            return;

        case ast\AST_CALL:
            // `define('NAME', value)` is the other way PHP declares a global constant. Only a
            // literal first argument is a declaration this benchmark can match on — a computed
            // name has no stable identifier, exactly like a computed property in TypeScript.
            $fn = $node->children['expr'] ?? null;
            $fname = ($fn instanceof ast\Node && isset($fn->children['name']))
                ? $fn->children['name'] : null;
            if (is_string($fname) && strcasecmp($fname, 'define') === 0) {
                $args = $node->children['args'] ?? null;
                $first = ($args instanceof ast\Node) ? ($args->children[0] ?? null) : null;
                if (is_string($first) && $first !== '') {
                    // A namespaced define() writes the fully-qualified name; the scanner and
                    // ctags both report the literal, so the literal is what is matched on.
                    $out['constants'][] = ['file' => $rel, 'name' => $first, 'kind' => 'define',
                                           'line' => $line];
                }
            }
            break;
    }

    foreach ($node->children as $c) {
        if (is_array($c)) { foreach ($c as $cc) walk($cc, $rel, $owner, $out); }
        else walk($c, $rel, $owner, $out);
    }
}

$unadjudicated = [];
foreach (walkFiles($repo) as $path) {
    $src = @file_get_contents($path);
    if ($src === false) continue;
    $rel = ltrim(substr($path, strlen($repo)), DIRECTORY_SEPARATOR);
    $out['files']++;
    $out['total_bytes'] += strlen($src);
    try {
        $tree = ast\parse_code($src, version: 110, filename: $path);
    } catch (Throwable $e) {
        // A file the PHP compiler itself rejects. Recorded rather than skipped silently: which
        // files the referee gives up on is the first question to ask of any new language.
        $out['parse_errors']++;
        $out['error_bytes'] += strlen($src);
        $out['error_files'][] = $rel;
        // The referee produced NO truth for this file, so every correct extraction in it scores
        // as a fabrication. phpunit ships a fixture using PHP 8.5 first-class partial function
        // application (`foo(?)`) that this PHP build's own parser rejects, and it charged us 6
        // false positives for reading it correctly. The whole file is recorded as an
        // unadjudicated range instead — ast-layer-compare.py drops those from truth, Koragraph
        // and Graphify alike, the same treatment C# gives a `#if`-disabled region.
        $unadjudicated[$rel] = [[1, PHP_INT_MAX]];
        continue;
    }
    walk($tree, $rel, null, $out);
}

$kinds = [];
foreach (['types', 'methods', 'fields', 'constants'] as $plane) {
    foreach ($out[$plane] as $item) {
        $k = "$plane:{$item['kind']}";
        $kinds[$k] = ($kinds[$k] ?? 0) + 1;
    }
}
ksort($kinds);
$out['kind_breakdown'] = $kinds;
$out['disabled_ranges'] = $unadjudicated ?: new stdClass();
$out['counts'] = [
    'files' => $out['files'], 'types' => count($out['types']),
    'methods' => count($out['methods']), 'fields' => count($out['fields']),
    'constants' => count($out['constants']), 'parse_errors' => $out['parse_errors'],
    'error_byte_pct' => $out['total_bytes']
        ? round(100.0 * $out['error_bytes'] / $out['total_bytes'], 2) : 0.0,
];

if ($outPath) {
    file_put_contents($outPath, json_encode($out));
}
echo json_encode(['counts' => $out['counts'], 'kinds' => $kinds], JSON_PRETTY_PRINT), "\n";
