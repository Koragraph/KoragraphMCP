#!/usr/bin/env python3
"""Ground truth for the EDGE planes of a Python repository, from CPython's own `ast`.

Declaration benchmarks grade the NODES of a code graph. They say nothing about the edges, which
are the part that makes it a graph rather than a symbol table — and edges are what a blast-radius
or call-chain query actually traverses. This is the referee for those.

Same referee philosophy as the declaration benchmark: the language's own compiler front end, no
build configuration, no dependency resolution, so it reads every file exactly as written.

Three planes, each chosen because `ast` answers it EXACTLY — no heuristics, no resolution guesses:

  imports      (file, module)          `import x`, `from x import y` -> the module x.
                                       Relative imports keep their dots so `from . import a` and
                                       `from .a import b` stay distinguishable.
  inheritance  (file, child, base)     class C(B) -> one edge per base. Attribute bases keep only
                                       the final component (`abc.ABC` -> `ABC`) because the
                                       systems under test resolve to a symbol name, not a dotted
                                       path, and demanding the dotted form would score the naming
                                       convention rather than the edge.
  calls        (file, caller, callee)  a Call node inside a function/method body. `caller` is the
                                       enclosing def (or '<module>'), `callee` is the called
                                       name's final component. NAME-LEVEL, deliberately: `ast`
                                       cannot resolve which `send` is meant without a type
                                       checker, so anything stricter would grade our guess against
                                       another guess.

`--skip` mirrors the declaration harness's skip set so all sides see the same files.

  edge-referee-cpython.py <checkout> --out truth-edges.json
"""
import argparse, ast, json, os, sys

SKIP = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out",
        ".gitnexus", "graphify-out", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache"}


def enclosing_name(stack):
    return stack[-1] if stack else "<module>"


def final(node):
    """Final component of a dotted or plain name, or None."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def walk_file(path, rel, out):
    try:
        src = open(path, "r", encoding="utf-8", errors="replace").read()
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        out["parse_errors"].append(rel)
        return

    stack = []

    class V(ast.NodeVisitor):
        def visit_Import(self, n):
            for a in n.names:
                out["imports"].append({"file": rel, "name": a.name.split(".")[0]})
            self.generic_visit(n)

        def visit_ImportFrom(self, n):
            mod = ("." * (n.level or 0)) + (n.module or "")
            if mod:
                out["imports"].append({"file": rel, "name": mod.split(".")[0] if not n.level else mod})
            self.generic_visit(n)

        def visit_ClassDef(self, n):
            for b in n.bases:
                nm = final(b)
                if nm:
                    out["inheritance"].append({"file": rel, "child": n.name, "base": nm})
            stack.append(n.name)
            self.generic_visit(n)
            stack.pop()

        def _fn(self, n):
            stack.append(n.name)
            self.generic_visit(n)
            stack.pop()

        visit_FunctionDef = _fn
        visit_AsyncFunctionDef = _fn

        def visit_Call(self, n):
            nm = final(n.func)
            if nm:
                out["calls"].append({"file": rel, "caller": enclosing_name(stack), "callee": nm})
            self.generic_visit(n)

    V().visit(tree)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkout")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    out = {"imports": [], "inheritance": [], "calls": [], "parse_errors": [], "files": 0,
           "referee": "CPython ast", "referee_version": sys.version.split()[0]}
    for root, dirs, files in os.walk(a.checkout):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            if not f.endswith(".py"):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, a.checkout)
            out["files"] += 1
            walk_file(p, rel, out)

    json.dump(out, open(a.out, "w"))
    sys.stderr.write(
        f"[edge-truth] {out['files']} files: {len(out['imports'])} imports, "
        f"{len(out['inheritance'])} inheritance, {len(out['calls'])} calls, "
        f"{len(out['parse_errors'])} parse errors -> {a.out}\n")


if __name__ == "__main__":
    main()
