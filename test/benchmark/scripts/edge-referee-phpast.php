<?php
// Independent PHP EDGE oracle for the langquality benchmark, from PHP's own
// compiler via the `ast` extension (nikic/php-ast) — a different implementation
// from koragraph's tree-sitter-php, so a genuinely independent referee. Mirrors
// ast-referee-phpast.php (declarations); this emits {imports,inheritance,calls}.
//
//   php scripts/edge-referee-phpast.php <repo> --out edges.json

if (!extension_loaded('ast')) { fwrite(STDERR, "FATAL: php-ast extension not loaded\n"); exit(1); }

$repo = $argv[1] ?? null;
$outIdx = array_search('--out', $argv, true);
$out = $outIdx !== false ? ($argv[$outIdx + 1] ?? null) : null;
$SKIP = ['vendor', 'tests', 'test', 'Tests', 'node_modules', 'examples', '.git'];

function final_name($n) {
    $parts = explode('\\', (string)$n);
    return trim(end($parts));
}

$imports = [];
$inheritance = [];
$calls = [];
$parse_errors = [];
$fileCount = 0;

function walk($node, $file, $cls, $meth) {
    global $imports, $inheritance, $calls;
    if (!($node instanceof ast\Node)) return;
    $k = ast\get_kind_name($node->kind);
    switch ($k) {
        case 'AST_USE_ELEM':
            $nm = trim((string)($node->children['name'] ?? ''));  // full FQN — koragraph emits the same
            if ($nm) $imports[] = ['file' => $file, 'name' => $nm];
            break;
        case 'AST_CLASS':
        case 'AST_INTERFACE':
        case 'AST_TRAIT':
            $name = $node->children['name'] ?? null;
            if ($name) {
                $ext = $node->children['extends'] ?? null;
                if ($ext instanceof ast\Node) {
                    $inheritance[] = ['file' => $file, 'child' => $name, 'base' => final_name($ext->children['name'] ?? '')];
                }
                $impl = $node->children['implements'] ?? null;
                if ($impl instanceof ast\Node) {
                    foreach ($impl->children as $i) {
                        if ($i instanceof ast\Node) $inheritance[] = ['file' => $file, 'child' => $name, 'base' => final_name($i->children['name'] ?? '')];
                    }
                }
            }
            foreach ($node->children as $c) if ($c instanceof ast\Node) walk($c, $file, $name ?: $cls, null);
            return;
        case 'AST_METHOD':
        case 'AST_FUNC_DECL':
            $mn = $node->children['name'] ?? null;
            foreach ($node->children as $c) if ($c instanceof ast\Node) walk($c, $file, $cls, $mn ?: $meth);
            return;
        case 'AST_METHOD_CALL':
        case 'AST_STATIC_CALL':
            $callee = $node->children['method'] ?? null;
            if (is_string($callee) && ($meth || $cls)) $calls[] = ['file' => $file, 'caller' => $meth ?: $cls, 'callee' => $callee];
            break;
        case 'AST_CALL':
            $expr = $node->children['expr'] ?? null;
            if ($expr instanceof ast\Node && isset($expr->children['name']) && ($meth || $cls)) {
                $calls[] = ['file' => $file, 'caller' => $meth ?: $cls, 'callee' => final_name($expr->children['name'])];
            }
            break;
        case 'AST_NEW':
            $c = $node->children['class'] ?? null;
            if ($c instanceof ast\Node && isset($c->children['name']) && ($meth || $cls)) {
                $calls[] = ['file' => $file, 'caller' => $meth ?: $cls, 'callee' => final_name($c->children['name'])];
            }
            break;
    }
    foreach ($node->children as $c) if ($c instanceof ast\Node) walk($c, $file, $cls, $meth);
}

$rii = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($repo, FilesystemIterator::SKIP_DOTS));
foreach ($rii as $f) {
    if ($f->getExtension() !== 'php') continue;
    $rel = ltrim(str_replace($repo, '', $f->getPathname()), '/');
    $skip = false;
    foreach ($SKIP as $s) if (in_array($s, explode('/', $rel), true)) { $skip = true; break; }
    if ($skip) continue;
    try {
        $ast = ast\parse_code(file_get_contents($f->getPathname()), 110);
    } catch (Throwable $e) { $parse_errors[] = $rel; continue; }
    $fileCount++;
    walk($ast, $rel, null, null);
}

$result = ['imports' => $imports, 'inheritance' => $inheritance, 'calls' => $calls,
           'parse_errors' => $parse_errors, 'files' => $fileCount, 'referee' => 'php-ast', 'referee_version' => phpversion('ast')];
fwrite(STDERR, "[edge-truth] $fileCount files: " . count($imports) . " imports, " . count($inheritance) . " inheritance, " . count($calls) . " calls\n");
if ($out) file_put_contents($out, json_encode($result));
