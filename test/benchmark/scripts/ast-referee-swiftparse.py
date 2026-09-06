#!/usr/bin/env python3
"""Independent Swift declaration oracle from `swiftc -dump-parse`.

koragraph, GitNexus and Graphify all parse Swift with tree-sitter, so a tree-sitter referee would
grade systems that share a grammar (the trap the C#/ctags sections document). `swiftc -dump-parse`
is the Swift compiler's OWN parser and needs no build/typecheck/import resolution — it reads each
file standalone, the way ctags does for C — so it answers "what does this file declare?" for every
branch without a configured build, and shares no lineage with tree-sitter.

Taxonomy (mapped into the {types,methods,fields,constants} shape score-decls.py consumes):
    types      struct · class · enum · protocol · actor
    methods    func · constructor(init) · subscript
    fields     var/let stored properties (pattern binding)
    constants  enum cases (enum_element_decl)

Excluded: extension_decl (extends an existing type, declares no new type), parameters, locals,
operator/precedencegroup decls, and the blank name.

  ast-referee-swiftparse.py <repoPath> [--out truth.json]
"""
import json, os, re, subprocess, sys

DECL_RE = re.compile(r'\((\w+_decl)\b.*?range=\[([^\]]+)\].*?"([^"]*)"')
KIND = {
    'struct_decl': 'types', 'class_decl': 'types', 'enum_decl': 'types',
    'protocol_decl': 'types', 'actor_decl': 'types',
    'func_decl': 'methods', 'constructor_decl': 'methods', 'subscript_decl': 'methods',
    'var_decl': 'fields',
    'enum_element_decl': 'constants',
}


def base_name(kind, raw):
    n = (raw or '').strip()
    if kind in ('func_decl', 'constructor_decl', 'subscript_decl'):
        n = n.split('(')[0].strip()   # mag() / freefn(a:) -> mag / freefn ; init() -> ''
        if not n:
            n = 'init' if kind == 'constructor_decl' else ('subscript' if kind == 'subscript_decl' else '')
    return n


def file_of(rangestr, repo):
    # range=[/abs/path/File.swift:1:1 - line:1:59] -> repo-relative path
    path = rangestr.split(':')[0]
    try:
        return os.path.relpath(path, repo)
    except ValueError:
        return path


def main():
    repo = sys.argv[1]
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None
    files = []
    for root, dirs, names in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in ('.git', '.build', 'build', '.swiftpm')]
        for nm in names:
            if nm.endswith('.swift'):
                files.append(os.path.join(root, nm))
    truth = {'repo': os.path.basename(repo), 'lang': 'swift', 'referee': 'swiftc -dump-parse',
             'files': len(files), 'parse_errors': 0,
             'types': [], 'methods': [], 'fields': [], 'constants': []}
    for fp in files:
        p = subprocess.run(['swiftc', '-dump-parse', fp], capture_output=True, text=True)
        text = p.stdout
        if not text:
            truth['parse_errors'] += 1
            continue
        # Walk the S-expression by indentation so a declaration is counted only when it is a
        # top-level or type member — never a local inside a function/closure/accessor body. Every
        # local let/var sits under a `brace_stmt` (a statement block); excluding those keeps the
        # field plane to real properties, matching "Excluded: locals" in the other referees. Also
        # dedup by range: swiftc prints enum elements twice (nested and flattened) with one range.
        seen = set()
        stack = []  # (indent, node_type)
        BODY = {'brace_stmt', 'closure_expr'}
        for line in text.splitlines():
            om = re.match(r'^(\s*)\((\w+)', line)
            if not om:
                continue
            indent, ntype = len(om.group(1)), om.group(2)
            while stack and stack[-1][0] >= indent:
                stack.pop()
            inside_body = any(t in BODY for _, t in stack)
            stack.append((indent, ntype))
            dm = DECL_RE.search(line)
            if not dm:
                continue
            kind, rng, raw = dm.group(1), dm.group(2), dm.group(3)
            plane = KIND.get(kind)
            if not plane or inside_body:
                continue
            name = base_name(kind, raw)
            if not name or name == '_':
                continue
            key = (kind, rng, name)
            if key in seen:
                continue
            seen.add(key)
            truth[plane].append({'file': file_of(rng, repo), 'name': name, 'kind': kind})
    if out:
        json.dump(truth, open(out, 'w'))
    print(json.dumps({'files': truth['files'], **{k: len(truth[k]) for k in ('types','methods','fields','constants')}}))


if __name__ == '__main__':
    main()
