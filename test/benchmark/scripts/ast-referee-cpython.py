#!/usr/bin/env python3
"""Second, independent ground truth for Python — from CPython's own `ast` module.

Why this exists. A tree-sitter referee is only independent of a system that does not parse with
tree-sitter. Koragraph's Python path is tree-sitter (as of 2026-08-16), so a tree-sitter referee
grades two systems that share a parser and can only disagree about which nodes to keep. CPython's
`ast` is the definition of what a Python declaration is, and neither system uses it.

Emits the same JSON shape as ast-referee.py, implementing the same inclusion rules restated in
the compiler's vocabulary. Run with any Python 3; no third-party dependency.

TAXONOMY — fixed before scoring, applied identically to Koragraph and to Graphify.
  types      every `class` statement, at any nesting depth.
  methods    every `def`/`async def`, plus a name bound directly to a `lambda`.
  fields     class attributes (a name bound in a ClassDef's scope) and instance attributes
             (`self.x = ...` anywhere in the class), first binding only, class attribute wins.
  constants  a name bound in the module's scope.
  SCOPE, not syntactic nesting, decides the plane: `if`, `try`, `with`, `for` and `while`
  introduce no scope in Python, so a binding under one of them at module level is a module
  constant. Every element of a tuple/list/starred target is a separate binding.
  Excluded: `_`, `__all__`, imports, `del`, augmented assignment, walrus, comprehension and
  loop variables, function parameters, and any name bound inside a function body.

Usage: python3 koragraph_api/scripts/ast-referee-cpython.py <repoPath> [--out truth.json]
"""
import ast
import json
import os
import sys

SKIP = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out",
        "__pycache__", ".tox", ".venv", "venv", "site-packages"}
EXTS = (".py", ".pyi")


def walk_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP]
        for f in filenames:
            if f.endswith(EXTS):
                yield os.path.join(dirpath, f)


def unparse(node):
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def collect(tree, rel, out):
    # Parent links, so a node can find its enclosing class the way the tree-sitter referee does.
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def enclosing_class(node):
        cur = parents.get(node)
        while cur is not None:
            if isinstance(cur, ast.ClassDef):
                return cur
            cur = parents.get(cur)
        return None

    # Where a name lands is decided by SCOPE, not by the syntactic parent. `if`, `try`, `with`,
    # `for` and `while` introduce no scope in Python, so an assignment inside one at module
    # level binds a module-level name — `dir(module)` lists it and `symtable` reports it. The
    # earlier `parents.get(node) is Module` test therefore excluded from truth every constant
    # under `if TYPE_CHECKING:`, `try: import ... except ImportError:` and `with`, on both
    # sides at once: 376 declarations across this corpus, and they cluster exactly where a
    # settings or compatibility module keeps its configuration.
    SCOPES = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)

    def enclosing_scope(node):
        cur = parents.get(node)
        while cur is not None:
            if isinstance(cur, SCOPES):
                return cur
            cur = parents.get(cur)
        return None

    # A tuple or list target binds each of its elements: `a, b = f()` declares two names, and
    # `self.x, self.y = 0, 0` declares two attributes. Skipping any target that was not a bare
    # Name dropped both forms from truth entirely.
    def bound_names(target):
        if isinstance(target, ast.Name):
            return [("name", target.id, target)]
        if isinstance(target, ast.Attribute):
            if isinstance(target.value, ast.Name) and target.value.id == "self":
                return [("attr", target.attr, target)]
            return []
        if isinstance(target, (ast.Tuple, ast.List)):
            return [b for elt in target.elts for b in bound_names(elt)]
        if isinstance(target, ast.Starred):
            return bound_names(target.value)
        return []

    class_attr_keys = set()
    self_attrs = {}
    pending = []

    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            out["types"].append({
                "file": rel, "name": node.name, "kind": "class",
                "line": node.lineno, "end_line": getattr(node, "end_lineno", node.lineno),
            })

        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            cls = enclosing_class(node)
            args = unparse(node.args) or ""
            out["methods"].append({
                "file": rel, "name": node.name, "kind": "function",
                "owner": cls.name if cls else None,
                "params": " ".join(args.split()),
                "line": node.lineno, "end_line": getattr(node, "end_lineno", node.lineno),
            })

        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            value = node.value
            annotation = getattr(node, "annotation", None)
            for target in targets:
                for form, name, _t in bound_names(target):
                    if form == "name":
                        if not name or name == "_" or name == "__all__":
                            continue
                        # Only a whole-target lambda is a callable declaration; an element of a
                        # tuple unpack has no single value to inspect.
                        if isinstance(value, ast.Lambda) and isinstance(target, ast.Name):
                            cls = enclosing_class(node)
                            out["methods"].append({
                                "file": rel, "name": name, "kind": "lambda_fn",
                                "owner": cls.name if cls else None,
                                "params": " ".join((unparse(value.args) or "").split()),
                                "line": node.lineno,
                                "end_line": getattr(node, "end_lineno", node.lineno),
                            })
                            continue
                        owner = enclosing_scope(node)
                        if isinstance(owner, ast.Module):
                            out["constants"].append({"file": rel, "name": name,
                                                     "kind": "module_constant", "line": node.lineno})
                            continue
                        if not isinstance(owner, ast.ClassDef):
                            continue
                        key = (id(owner), name)
                        if key in class_attr_keys:
                            continue
                        class_attr_keys.add(key)
                        pending.append(({"file": rel, "name": name, "owner": owner.name,
                                         "type": unparse(annotation) if isinstance(target, ast.Name) else None,
                                         "kind": "class_attribute",
                                         "line": node.lineno}, key))
                    else:
                        cls = enclosing_class(node)
                        if cls is None:
                            continue
                        key = (id(cls), name)
                        if key in self_attrs:
                            continue
                        self_attrs[key] = {"file": rel, "name": name, "owner": cls.name,
                                           "type": None, "kind": "instance_attribute",
                                           "line": node.lineno}

    for field, _key in pending:
        out["fields"].append(field)
    for key, field in self_attrs.items():
        if key in class_attr_keys:
            continue
        out["fields"].append(field)


# `ast` is the compiler front end, so this referee can only see what THIS interpreter can parse.
# Measured on django: CPython 3.9 yields 32,052 truth methods and 3.13 yields 32,603 — ten files
# use syntax 3.9 cannot read, and declarations both systems correctly extracted from them scored
# as false positives against the older truth. Graphify's method precision on that repo reads
# 98.3% under 3.9 and 100.0% under 3.13, without Graphify changing at all. macOS still ships
# 3.9 as `/usr/bin/python3`, so this is the default a reader lands on.
REQUIRED_PY = (3, 13)


def assert_interpreter():
    if sys.version_info[:2] < REQUIRED_PY:
        sys.exit(f"ast-referee-cpython: needs CPython >= {REQUIRED_PY[0]}.{REQUIRED_PY[1]}, "
                 f"running {sys.version.split()[0]}. An older interpreter cannot parse newer "
                 "syntax and silently produces a SMALLER truth set, which inflates both systems' "
                 "apparent false positives. Published numbers used 3.13.9.")


def main():
    assert_interpreter()
    repo = sys.argv[1]
    out_path = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    out = {"repo": repo, "lang": "python", "referee": "cpython-ast",
           "referee_version": f"cpython {sys.version.split()[0]}",
           "files": 0, "parse_errors": 0, "types": [], "methods": [], "fields": [],
           "constants": []}

    for path in walk_files(repo):
        try:
            src = open(path, "rb").read()
        except Exception:
            continue
        out["files"] += 1
        try:
            tree = ast.parse(src, filename=path)
        except (SyntaxError, ValueError):
            # Python 2 files, and files using syntax newer than this interpreter.
            out["parse_errors"] += 1
            continue
        collect(tree, os.path.relpath(path, repo), out)

    kinds = {}
    for plane in ("types", "methods", "fields", "constants"):
        for item in out[plane]:
            k = item.get("kind")
            if k:
                kinds[f"{plane}:{k}"] = kinds.get(f"{plane}:{k}", 0) + 1
    out["counts"] = {"files": out["files"], "types": len(out["types"]),
                     "methods": len(out["methods"]), "fields": len(out["fields"]),
                     "constants": len(out["constants"]),
                     "parse_errors": out["parse_errors"]}
    out["kind_breakdown"] = dict(sorted(kinds.items()))
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(out, fh)
    print(json.dumps({**out["counts"], "kinds": out["kind_breakdown"]}, indent=2))


if __name__ == "__main__":
    main()
