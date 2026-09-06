#!/usr/bin/env python
"""Second, independent ground truth for C and C++ — from Universal Ctags.

Why this exists. Koragraph's C/C++ path is tree-sitter, and so is Graphify's, so a tree-sitter
referee grades two systems that share a grammar. That is the situation the TypeScript section
identified and the C# section proved dangerous: a shared parser hides every defect that lives
where the parser itself gives up, and on this corpus tree-sitter gives up a lot — it reports a
parse error over 48.6% of leveldb's bytes and 26% of redis's `.c` files.

Universal Ctags is a mature, hand-written declaration indexer with no tree-sitter lineage, and
it is built for exactly the question this benchmark asks: what does this file declare? It does
not need include paths, a compilation database, or a build — which is what rules out a
compiler-grade referee here. clang parses ONE preprocessor configuration and needs the project
configured; ctags reads every branch, as tree-sitter does, so the two referees are answering
the same question rather than two different ones.

Implements the taxonomy fixed in ast-referee.py's `── C / C++ ──` header, in ctags' kinds:

    types      struct · union · enum · class · typedef · alias
    methods    function · prototype · function-like macro
    fields     member · enumerator
    constants  object-like macro

Excluded here as there: file-scope variables (`variable`, `externvar`), labels, locals,
parameters, and `header` (an include, not a declaration).

── Go ───────────────────────────────────────────────────────────────────────

`--lang go` makes this the SECOND referee for Go; the primary is `ast-referee-goast/`, built on
go/parser. Both are needed for the same reason C# needed Roslyn: Koragraph and Graphify both
parse Go with tree-sitter, so a tree-sitter referee grades two systems sharing a grammar.

Same taxonomy as the go/ast referee, in ctags' kinds:

    types      struct · interface · type (a defined type over any underlying type) · talias
    methods    func · methodSpec
    fields     member · anonMember (an embedded field; its name IS the unqualified type name)
    constants  const · var (package level — ctags does not tag declarations inside a body)

Excluded there and here: `package`, `packageName` (the package clause and an import's local
name — not declarations of program entities), `receiver` (off by default, and a parameter),
`unknown`, and the blank identifier `_`, which has no stable name to match on.

── PHP ──────────────────────────────────────────────────────────────────────

`--lang php` makes this the SECOND referee for PHP; the primary is `ast-referee-phpast.php`,
built on the PHP compiler's own AST (`ext/ast`). Same taxonomy, in ctags' kinds:

    types      class · interface · trait          (ctags has NO enum kind for PHP — see below)
    methods    function                           (method vs function separated by scopeKind)
    fields     variable (a property, when its scope is a class/trait/interface) ·
               define at class scope (a class constant)
    constants  define at namespace/file scope

Excluded there and here: `alias` (a `use` import), `namespace`, `local`, ctags' generated
`AnonymousClassNNNN` name, and a `variable` at file scope — a top-level `$x = 1` is a statement
executed in global scope, not a declaration.

**Two known blind spots, both confirmed on a probe file before measuring.** ctags has no PHP
`enum` kind at all: a PHP 8.1 `enum Level: int { case Debug; }` yields no type, no cases, and
files its methods under the enclosing namespace. And it does not model promoted constructor
properties (`__construct(private Logger $log)`). Both are real declarations, both are emitted by
the primary referee, and §4 of the paper section accounts for every instance.

── Kotlin ───────────────────────────────────────────────────────────────────

`--lang kotlin` makes this the SECOND referee for Kotlin; the primary is
`ast-referee-ktpsi/`, built on the Kotlin compiler's own PSI. Same taxonomy, in ctags' kinds:

    types      class · interface · object · typealias
    methods    method
    fields     constant · variable, when the scope is a class/interface/object
    constants  constant · variable, when the scope is a package (file level)

Excluded there and here: `package`, and anything whose scope is a `method` — ctags DOES report
declarations inside a function body for Kotlin (unlike its Go and PHP parsers), and a local
`val` is not a declaration of a program entity.

**One known blind spot, confirmed on a probe file before measuring.** ctags has no enum-entry
kind for Kotlin: `enum class Level { DEBUG, INFO }` yields the type but neither constant. Both
are real declarations, both are emitted by the primary referee, and §4 of the paper section
accounts for every instance.

  .venv-graphify/bin/python ast-referee-ctags.py <repoPath> [--lang cpp|go|php|kotlin] [--out t.json]
"""
import collections
import json
import re
import os
import subprocess
import sys
import tempfile


# The file list handed to `ctags -L` used to be a fixed name in $TMPDIR. Two languages run
# concurrently — which is the obvious thing to do with ten of them and the thing the README
# invites — then write the same path, and whichever process reads it second adjudicates the
# other language's file set. It fails silently, as a wrong truth file rather than an error.
def _write_listing(paths, tag):
    fd, path = tempfile.mkstemp(prefix=f"ctags_{tag}_", suffix=".txt")
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(paths))
    return path

EXTS = (".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx")
SKIP = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out",
        "deps", "third_party", "thirdparty", "cmake-build-debug", ".deps"}

PHP_EXTS = (".php",)
PHP_SKIP = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out"}

# `variable` and `define` are routed by scope, not by kind alone, so they are resolved below.
PHP_KIND_PLANE = {
    "class": ("types", "class"),
    "interface": ("types", "interface"),
    "trait": ("types", "trait"),
    "function": ("methods", None),
    "variable": ("fields", "property"),
    "define": (None, None),
}
PHP_MEMBER_SCOPES = {"class", "interface", "trait", "enum"}

KT_EXTS = (".kt", ".kts")
KT_SKIP = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out"}

KT_KIND_PLANE = {
    "class": ("types", "class"),
    "interface": ("types", "interface"),
    "object": ("types", "object"),
    "typealias": ("types", "typealias"),
    "method": ("methods", "method"),
    "constant": (None, None),   # routed by scope below
    "variable": (None, None),
}
KT_MEMBER_SCOPES = {"class", "interface", "object", "enum"}

GO_EXTS = (".go",)
GO_SKIP = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out"}

GO_KIND_PLANE = {
    "struct": ("types", "struct"),
    "interface": ("types", "interface"),
    "type": ("types", "type"),
    "talias": ("types", "talias"),
    "func": ("methods", None),          # split below into function / method by scopeKind
    "methodSpec": ("methods", "methodSpec"),
    "member": ("fields", "member"),
    "anonMember": ("fields", "anonMember"),
    "const": ("constants", "const"),
    "var": ("constants", "var"),
}

KIND_PLANE = {
    "struct": ("types", "struct"),
    "union": ("types", "union"),
    "enum": ("types", "enum"),
    "class": ("types", "class"),
    "typedef": ("types", "typedef"),
    "alias": ("types", "alias"),
    "function": ("methods", "function_definition"),
    "prototype": ("methods", "function_declaration"),
    "member": ("fields", "member"),
    "enumerator": ("fields", "enumerator"),
    # `macro` covers both spellings; the two are separated below by the presence of a
    # signature, because a function-like macro is invoked with an argument list and is how C
    # spells an inline function.
    "macro": (None, None),
}


# Blocks that are a SCOPE rather than a function body. A prototype inside one of these is a
# real declaration; `extern "C" {` is here because a prototype inside a linkage block is
# file-scope, and treating it as nesting would drop every declaration in a C header included
# from C++.
TRANSPARENT_BLOCK = re.compile(
    r"\b(class|struct|union|enum|namespace)\b|extern\s*\"C(\+\+)?\"")


def brace_depths(path):
    """{line number -> FUNCTION-BODY depth at that line}.

    Counting all braces is not enough. A member prototype inside `class X { ... }` and a macro
    invocation inside a test body are both at brace depth > 0, and ctags' `scope` field cannot
    separate them either — it reports `scope: json` for `json::from_bjdata(x);` used as a CALL
    inside a test, exactly as it would for a real member. So each `{` is classified from the
    statement that introduces it: a class/struct/union/enum/namespace block is transparent, an
    `extern "C"` linkage block is transparent, and anything else is a function body.
    """
    try:
        with open(path, encoding="utf8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return {}
    depths = {}
    stack = []          # block kinds, innermost last
    func_depth = 0
    line = 1
    i, n = 0, len(text)
    at_line_start = True
    while i < n:
        depths.setdefault(line, func_depth)
        ch = text[i]
        if ch == "\n":
            line += 1
            at_line_start = True
            i += 1
            depths.setdefault(line, func_depth)
            continue
        if at_line_start and ch in " \t":
            i += 1
            continue
        if at_line_start and ch == "#":
            while i < n:
                if text[i] == "\n":
                    if text[i - 1:i] == "\\":
                        line += 1
                        i += 1
                        continue
                    break
                i += 1
            continue
        at_line_start = False
        if ch == "/" and text[i + 1:i + 2] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "/" and text[i + 1:i + 2] == "*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            line += text.count("\n", i, j)
            i = j
            continue
        if ch in "'\"":
            q, i = ch, i + 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == q:
                    i += 1
                    break
                if text[i] == "\n":
                    line += 1
                i += 1
            continue
        if ch == "{":
            head = text[max(0, i - 400):i]
            cut = max(head.rfind(";"), head.rfind("}"), head.rfind("{"))
            head = head[cut + 1:]
            transparent = bool(TRANSPARENT_BLOCK.search(head))
            stack.append("type" if transparent else "func")
            if not transparent:
                func_depth += 1
            i += 1
            continue
        if ch == "}":
            if stack:
                if stack.pop() == "func":
                    func_depth = max(0, func_depth - 1)
            i += 1
            continue
        i += 1
    return depths


def walk_files(root, exts=EXTS, skip=SKIP):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for f in filenames:
            if f.endswith(exts):
                yield os.path.join(dirpath, f)


def run_go(repo, out_path):
    """Go needs none of the C/C++ machinery below it: ctags does not tag declarations inside a
    Go function body (verified — a local `type`/`const`/`var` produces no tag), so there is no
    brace-depth filter, and Go has no preprocessor, so there is nothing unadjudicable."""
    paths = sorted(walk_files(repo, GO_EXTS, GO_SKIP))
    listing = _write_listing(paths, "go")

    proc = subprocess.run(
        # `Z` puts the scope kind on every tag, which is the only thing that separates a
        # `func` with a receiver (a method) from a package-level one. `F` is carried over from
        # C/C++ out of caution; Go has no `static`, so it changes nothing here, but leaving it
        # off is the mistake that hid most of redis.
        ["ctags", "--output-format=json", "--languages=Go",
         "--fields=+neKSZ", "--extras=+F", "-L", listing, "-f", "-"],
        capture_output=True, text=True, check=False)

    out = {"repo": repo, "lang": "go", "referee": "universal-ctags",
           "referee_version": f"universal-ctags {assert_ctags()}",
           "files": len(paths), "parse_errors": 0,
           "types": [], "methods": [], "fields": [], "constants": []}
    seen_files = set()

    for line in proc.stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            t = json.loads(line)
        except ValueError:
            continue
        if t.get("_type") != "tag":
            continue
        kind, name = t.get("kind"), t.get("name")
        # `_` is legal for a func, a var and a field, and Go code declares it constantly —
        # `var _ Iface = (*Impl)(nil)` is the standard interface assertion. It has no stable
        # identifier, so it is excluded on every side rather than matched by position.
        if not name or name == "_" or kind not in GO_KIND_PLANE:
            continue
        rel = os.path.relpath(t["path"], repo)
        seen_files.add(rel)
        line_no = t.get("line")
        plane, sub = GO_KIND_PLANE[kind]
        scope, scope_kind = t.get("scope"), t.get("scopeKind")
        if kind == "func":
            sub = "method" if scope_kind in ("struct", "interface", "type") else "function"
        entry = {"file": rel, "name": name, "kind": sub, "line": line_no}
        if plane == "methods":
            entry.update({"owner": (scope or "").split(".")[-1] or None,
                          "end_line": t.get("end") or line_no,
                          "params": " ".join((t.get("signature") or "()").strip("()").split())})
        elif plane == "types":
            entry["end_line"] = t.get("end") or line_no
        elif plane == "fields":
            entry.update({"owner": (scope or "").split(".")[-1] or None,
                          "type": t.get("typeref")})
        out[plane].append(entry)

    kinds = {}
    for plane in ("types", "methods", "fields", "constants"):
        for item in out[plane]:
            if item.get("kind"):
                kinds[f"{plane}:{item['kind']}"] = kinds.get(f"{plane}:{item['kind']}", 0) + 1

    out["disabled_ranges"] = {}
    out["counts"] = {
        "files": len(paths), "types": len(out["types"]), "methods": len(out["methods"]),
        "fields": len(out["fields"]), "constants": len(out["constants"]),
        "files_with_a_tag": len(seen_files), "parse_errors": 0, "error_byte_pct": 0.0,
    }
    out["kind_breakdown"] = dict(sorted(kinds.items()))
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(out, fh)
    print(json.dumps({**out["counts"], "kinds": out["kind_breakdown"]}, indent=2))


def run_php(repo, out_path):
    paths = sorted(walk_files(repo, PHP_EXTS, PHP_SKIP))
    listing = _write_listing(paths, "php")

    proc = subprocess.run(
        ["ctags", "--output-format=json", "--languages=PHP",
         "--fields=+neKSZ", "--extras=+F", "-L", listing, "-f", "-"],
        capture_output=True, text=True, check=False)

    out = {"repo": repo, "lang": "php", "referee": "universal-ctags",
           "referee_version": f"universal-ctags {assert_ctags()}",
           "files": len(paths), "parse_errors": 0,
           "types": [], "methods": [], "fields": [], "constants": []}
    seen_files = set()

    for line in proc.stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            t = json.loads(line)
        except ValueError:
            continue
        if t.get("_type") != "tag":
            continue
        kind, name = t.get("kind"), t.get("name")
        if not name or kind not in PHP_KIND_PLANE:
            continue
        # ctags invents a name for `new class { ... }`. The taxonomy excludes anonymous types on
        # every side — there is no identifier to match on.
        if name.startswith("AnonymousClass"):
            continue
        scope_kind = t.get("scopeKind")
        plane, sub = PHP_KIND_PLANE[kind]
        if kind == "function":
            sub = "method" if scope_kind in PHP_MEMBER_SCOPES else "function"
        elif kind == "variable":
            # A file-scope `$x = 1` is a statement in global scope, not a declaration.
            if scope_kind not in PHP_MEMBER_SCOPES:
                continue
        elif kind == "define":
            # ctags uses one kind for a class constant and a global constant; only the scope
            # separates them, and the taxonomy files them in different planes.
            plane, sub = (("fields", "class_constant") if scope_kind in PHP_MEMBER_SCOPES
                          else ("constants", "const"))
        rel = os.path.relpath(t["path"], repo)
        seen_files.add(rel)
        line_no = t.get("line")
        entry = {"file": rel, "name": name, "kind": sub, "line": line_no}
        owner = (t.get("scope") or "").split("\\")[-1].split("::")[-1] or None
        if plane in ("methods", "fields"):
            entry["owner"] = owner
        if plane in ("methods", "types"):
            entry["end_line"] = t.get("end") or line_no
        out[plane].append(entry)

    kinds = {}
    for plane in ("types", "methods", "fields", "constants"):
        for item in out[plane]:
            if item.get("kind"):
                kinds[f"{plane}:{item['kind']}"] = kinds.get(f"{plane}:{item['kind']}", 0) + 1

    out["disabled_ranges"] = {}
    out["counts"] = {
        "files": len(paths), "types": len(out["types"]), "methods": len(out["methods"]),
        "fields": len(out["fields"]), "constants": len(out["constants"]),
        "files_with_a_tag": len(seen_files), "parse_errors": 0, "error_byte_pct": 0.0,
    }
    out["kind_breakdown"] = dict(sorted(kinds.items()))
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(out, fh)
    print(json.dumps({**out["counts"], "kinds": out["kind_breakdown"]}, indent=2))


def run_kotlin(repo, out_path):
    paths = sorted(walk_files(repo, KT_EXTS, KT_SKIP))
    listing = _write_listing(paths, "kt")

    proc = subprocess.run(
        ["ctags", "--output-format=json", "--languages=Kotlin",
         "--fields=+neKSZ", "--extras=+F", "-L", listing, "-f", "-"],
        capture_output=True, text=True, check=False)

    out = {"repo": repo, "lang": "kotlin", "referee": "universal-ctags",
           "referee_version": f"universal-ctags {assert_ctags()}",
           "files": len(paths), "parse_errors": 0,
           "types": [], "methods": [], "fields": [], "constants": []}
    seen_files = set()

    for line in proc.stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            t = json.loads(line)
        except ValueError:
            continue
        if t.get("_type") != "tag":
            continue
        kind, name = t.get("kind"), t.get("name")
        if not name or kind not in KT_KIND_PLANE:
            continue
        scope_kind = t.get("scopeKind")
        # Unlike its Go and PHP parsers, ctags' Kotlin parser DOES emit declarations from
        # inside a function body — a local `fun` arrives with scopeKind `method` and a local
        # `val` with the same. The taxonomy excludes them on every side.
        if scope_kind == "method":
            continue
        # ctags' Kotlin parser names every lambda `<lambda>` and emits it as a method — 3,525
        # of them across this corpus. It is not an identifier, the same reason C's `__anon`
        # structs and PHP's `AnonymousClassNNNN` are dropped.
        if name == "<lambda>":
            continue
        plane, sub = KT_KIND_PLANE[kind]
        if kind in ("constant", "variable"):
            plane = "fields" if scope_kind in KT_MEMBER_SCOPES else "constants"
            sub = "property" if plane == "fields" else ("const" if kind == "constant" else "var")
        rel = os.path.relpath(t["path"], repo)
        seen_files.add(rel)
        line_no = t.get("line")
        entry = {"file": rel, "name": name, "kind": sub, "line": line_no}
        owner = (t.get("scope") or "").split(".")[-1] or None
        if plane in ("methods", "fields"):
            entry["owner"] = owner
        if plane in ("methods", "types"):
            entry["end_line"] = t.get("end") or line_no
        out[plane].append(entry)

    kinds = {}
    for plane in ("types", "methods", "fields", "constants"):
        for item in out[plane]:
            if item.get("kind"):
                kinds[f"{plane}:{item['kind']}"] = kinds.get(f"{plane}:{item['kind']}", 0) + 1

    out["disabled_ranges"] = {}
    out["counts"] = {
        "files": len(paths), "types": len(out["types"]), "methods": len(out["methods"]),
        "fields": len(out["fields"]), "constants": len(out["constants"]),
        "files_with_a_tag": len(seen_files), "parse_errors": 0, "error_byte_pct": 0.0,
    }
    out["kind_breakdown"] = dict(sorted(kinds.items()))
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(out, fh)
    print(json.dumps({**out["counts"], "kinds": out["kind_breakdown"]}, indent=2))


_OBJC_MARKER = re.compile(r"^\s*(?:@interface|@implementation|@protocol)\b|^\s*#\s*import\s+<(?:Foundation|UIKit|Cocoa)/",
                          re.M)


def _objc_files(root):
    """Files that are Objective-C, not C or C++.

    ctags is invoked `--languages=C,C++`, so an Objective-C method can never enter truth — while
    Graphify content-sniffs `.h` and routes Objective-C headers to its own ObjC extractor. Every
    node it correctly produced there was therefore scored as a fabrication: 1,062 of its 1,417
    nodes under protobuf's `objectivec/` directory, which alone owned the worst type-precision
    figure in the benchmark. Penalising a competitor for a language our referee was told not to
    read is not a defensible comparison, so these files are excluded from every side. Excluding
    beats enabling ctags' ObjC parser here because Koragraph's C/C++ plane does not model
    Objective-C either — the comparison would then be unfair in the other direction.
    """
    out = {}
    for path in walk_files(root):
        if not path.endswith((".h", ".m", ".mm")):
            continue
        try:
            with open(path, "r", encoding="utf8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        if _OBJC_MARKER.search(text):
            out[os.path.relpath(path, root)] = [[1, 10 ** 9]]
    return out


def _if_zero_ranges(root):
    """Line ranges inside `#if 0` / `#if FALSE` blocks, per file relative to root.

    Only the literal never-true conditions. `#ifdef FOO` is a configuration choice — some
    build enables it, and both tools reporting its contents is correct — whereas `#if 0` is
    the comment-out idiom and nothing inside it is ever compiled. Directive nesting is tracked
    so an inner `#if`/`#endif` cannot close the outer block early, and `#else`/`#elif` at the
    block's own depth ends the dead branch.
    """
    dead = collections.defaultdict(list)
    never = re.compile(r"^\s*#\s*if\s+(?:0|FALSE|false)\s*$")
    directive = re.compile(r"^\s*#\s*(if|ifdef|ifndef|else|elif|endif)\b")
    for path in walk_files(root):
        try:
            with open(path, "r", encoding="utf8", errors="replace") as fh:
                lines = fh.read().split("\n")
        except OSError:
            continue
        rel = os.path.relpath(path, root)
        depth = 0
        start = None
        for i, line in enumerate(lines, 1):
            m = directive.match(line)
            if not m:
                continue
            kw = m.group(1)
            if kw in ("if", "ifdef", "ifndef"):
                if start is None and never.match(line):
                    start, depth = i, 0
                elif start is not None:
                    depth += 1
            elif kw == "endif":
                if start is not None:
                    if depth == 0:
                        dead[rel].append([start, i])
                        start = None
                    else:
                        depth -= 1
            elif kw in ("else", "elif") and start is not None and depth == 0:
                dead[rel].append([start, i])
                start = None
        if start is not None:
            dead[rel].append([start, len(lines)])
    return dead


# The toolchain this referee's output depends on. ctags' C/C++ parser changes between
# releases and it adjudicates the largest declaration set in the benchmark, so a reader on a
# different version is not reproducing our numbers — they are producing their own.
REQUIRED_CTAGS = "6.2.1"


def ctags_version():
    try:
        out = subprocess.run(["ctags", "--version"], capture_output=True, text=True).stdout
    except OSError:
        return None
    m = re.search(r"Universal Ctags (\d+\.\d+\.\d+)", out)
    return m.group(1) if m else None


def assert_ctags():
    """Fail CLOSED. Previously this referee ran whatever `ctags` was on PATH: with BSD/Exuberant
    ctags (which is `/usr/bin/ctags` on macOS) it produced an EMPTY truth set and exit code 0,
    and `ast-bench.sh` redirects its stderr — so every C/C++ cell silently read 0.0% for both
    systems and looked like a result. A benchmark that reports 0.0% when its referee is missing
    is worse than one that crashes."""
    v = ctags_version()
    if v is None:
        sys.exit("ast-referee-ctags: Universal Ctags not found on PATH. `/usr/bin/ctags` on macOS "
                 "is BSD ctags and produces an EMPTY truth set silently. Install Universal Ctags "
                 f"{REQUIRED_CTAGS} (brew install universal-ctags).")
    if v != REQUIRED_CTAGS:
        sys.stderr.write(f"ast-referee-ctags: WARNING Universal Ctags {v}, published numbers used "
                         f"{REQUIRED_CTAGS}. Truth will differ; do not compare against published "
                         "C/C++ figures.\n")
    return v


def main():
    ctags_v = assert_ctags()
    repo = sys.argv[1]
    out_path = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "cpp"
    if lang == "go":
        return run_go(repo, out_path)
    if lang == "php":
        return run_php(repo, out_path)
    if lang == "kotlin":
        return run_kotlin(repo, out_path)

    paths = sorted(walk_files(repo))
    listing = _write_listing(paths, "cpp")

    proc = subprocess.run(
        ["ctags", "--output-format=json", "--languages=C,C++",
         # Prototypes are off by default; they are half the declarations in a C header.
         "--kinds-C=+p", "--kinds-C++=+p",
         # `S` is the signature, which separates `#define MIN(a,b)` from `#define MAX`.
         # `F` is the file-scope extra. Without it ctags drops every `static` declaration,
         # which in redis is most of the codebase — 2,396 methods, 433 types and 833 macros
         # were missing before this was set, and the gap read as tree-sitter fabricating.
         "--fields=+neKS", "--extras=+F", "-L", listing, "-f", "-"],
        capture_output=True, text=True, check=False)

    out = {"repo": repo, "lang": "cpp", "referee": "universal-ctags",
           "files": len(paths), "parse_errors": 0,
           "types": [], "methods": [], "fields": [], "constants": []}
    seen_files = set()

    for line in proc.stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            t = json.loads(line)
        except ValueError:
            continue
        if t.get("_type") != "tag":
            continue
        kind = t.get("kind")
        name = t.get("name")
        if not name or kind not in KIND_PLANE:
            continue
        # ctags invents a name for an anonymous struct/union/enum (`__anon00a7c8390103`).
        # The taxonomy excludes anonymous types — they have no identifier to match on — so
        # these are dropped rather than scored as declarations neither tool can name.
        if name.startswith("__anon"):
            continue
        rel = os.path.relpath(t["path"], repo)
        seen_files.add(rel)
        line_no = t.get("line")
        end = t.get("end") or line_no

        if kind == "macro":
            if t.get("signature"):
                out["methods"].append({
                    "file": rel, "name": name, "owner": None,
                    "params": " ".join((t.get("signature") or "()").strip("()").split()),
                    "kind": "function_macro", "line": line_no, "end_line": end,
                })
            else:
                out["constants"].append({
                    "file": rel, "name": name, "kind": "macro", "line": line_no,
                })
            continue

        plane, sub = KIND_PLANE[kind]
        entry = {"file": rel, "name": name, "kind": sub, "line": line_no}
        if plane == "methods":
            entry.update({"owner": t.get("scope"), "end_line": end,
                          "params": " ".join((t.get("signature") or "()").strip("()").split())})
        elif plane == "types":
            entry["end_line"] = end
        else:
            entry.update({"owner": t.get("scope"), "type": t.get("typeref")})
        out[plane].append(entry)

    # ctags files a macro INVOCATION inside a function body as a prototype: `CAPTURE(x);`
    # and `CHECK_THROWS_WITH_AS(...);` in a test body look exactly like `int foo(int);` to a
    # parser that has not expanded the macro. On nlohmann-json that is 2,565 of its 2,885
    # apparent prototypes — 89% of the plane — and every one is a call, not a declaration.
    # The second referee settles which reading is right: tree-sitter parses them as
    # `expression_statement > call_expression`, not as declarations.
    #
    # The discriminator is brace depth, computed here rather than taken from either parser,
    # because it is lexical structure and not a judgement about what a declaration is:
    #
    #   function-body depth 0 -> a file-scope, namespace-scoped or member prototype. Keep.
    #   function-body depth > 0 -> inside a function body. Drop.
    #
    # Containment inside a ctags `function` span was tried first and is not enough: ctags does
    # not record a macro-defined block (`TEST_CASE("parsing") { ... }`) as a function, so the
    # 2,565 invocations inside doctest and Catch blocks have no enclosing function tag at all.
    #
    # AST_KEEP_BODY_PROTOTYPES=1 turns this rule OFF. It exists so ast-sensitivity.py can report
    # what the rule is worth to each side instead of the paper asserting it — a taxonomy decision
    # that moves a published digit has to be measurable, not just argued for.
    depth_by_file = {}
    before = len(out["methods"])
    kept = []
    for m in out["methods"]:
        if (os.environ.get("AST_KEEP_BODY_PROTOTYPES") == "1"
                or m["kind"] != "function_declaration" or not m.get("line")):
            kept.append(m)
            continue
        depths = depth_by_file.get(m["file"])
        if depths is None:
            depths = depth_by_file[m["file"]] = brace_depths(os.path.join(repo, m["file"]))
        if depths.get(m["line"], 0) <= 0:
            kept.append(m)
    out["methods"] = kept
    out["prototypes_dropped_inside_bodies"] = before - len(out["methods"])

    # A declaration written THROUGH a macro cannot be adjudicated by anything that has not
    # expanded the macro, and the two readings differ irreconcilably. curl generates its whole
    # option enum this way:
    #
    #     #define CURLOPT(na,t,nu) na = t + nu
    #     typedef enum { CURLOPT(CURLOPT_WRITEDATA, CURLOPTTYPE_CBPOINT, 1), ... } CURLoption;
    #
    # ctags reports 312 enumerators all named `CURLOPT`; a grammar reports the first argument,
    # `CURLOPT_WRITEDATA`, which is the option a reader would search for. Neither is wrong and
    # neither is the declaration — that only exists after preprocessing. So the lines are
    # recorded as unadjudicated and excluded from EVERY tool, the same treatment SQL gives a
    # statement no dialect parser can read and C# gives a `#if`-disabled region. curl's
    # `#define BIT(x) bool x:1` struct members are the same construct.
    macro_names = {c["name"] for c in out["constants"]}
    macro_names |= {m["name"] for m in out["methods"] if m["kind"] == "function_macro"}
    unadjudicated = collections.defaultdict(list)
    for plane in ("types", "methods", "fields", "constants"):
        keep = []
        for item in out[plane]:
            if (item["name"] in macro_names and item.get("kind") not in ("macro", "function_macro")
                    and item.get("line")):
                unadjudicated[item["file"]].append([item["line"], item["line"]])
            else:
                keep.append(item)
        out[plane] = keep
    # `#if 0 ... #endif` is C's comment-out idiom, and the two sides read it differently by
    # construction: ctags evaluates the directive and reports nothing inside, while a
    # tree-sitter grammar — which is what BOTH systems under test parse with — does not
    # preprocess and reports every declaration in the dead branch. That is a definitional
    # difference, not an extraction failure, so the lines are excluded from every tool. redis's
    # `intsetRepr` and `error` live in such a block and were scored as fabrications against us;
    # Graphify, parsing the same way, would be charged for them identically.
    disabled = _if_zero_ranges(repo)
    for f, ranges in disabled.items():
        unadjudicated[f].extend(ranges)
    objc = _objc_files(repo)
    for f, ranges in objc.items():
        unadjudicated[f].extend(ranges)
    out["referee_version"] = f"universal-ctags {ctags_v}"
    if not any(out[pl] for pl in ("types", "methods", "fields", "constants")):
        sys.exit("ast-referee-ctags: produced ZERO declarations. Refusing to emit an empty truth "
                 "set — scored, it reads as 0.0% for both systems and looks like a result.")
    out["disabled_ranges"] = {k: v for k, v in unadjudicated.items()}
    out["macro_generated_declarations_excluded"] = sum(len(v) for v in unadjudicated.values())
    out["if_zero_blocks_excluded"] = sum(len(v) for v in disabled.values())
    out["objc_files_excluded"] = len(objc)

    kinds = {}
    for plane in ("types", "methods", "fields", "constants"):
        for item in out[plane]:
            k = item.get("kind")
            if k:
                kinds[f"{plane}:{k}"] = kinds.get(f"{plane}:{k}", 0) + 1

    out["counts"] = {
        "files": len(paths), "types": len(out["types"]), "methods": len(out["methods"]),
        "fields": len(out["fields"]), "constants": len(out["constants"]),
        "files_with_a_tag": len(seen_files), "parse_errors": 0, "error_byte_pct": 0.0,
    }
    out["kind_breakdown"] = dict(sorted(kinds.items()))
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(out, fh)
    print(json.dumps({**out["counts"], "kinds": out["kind_breakdown"]}, indent=2))


if __name__ == "__main__":
    main()
