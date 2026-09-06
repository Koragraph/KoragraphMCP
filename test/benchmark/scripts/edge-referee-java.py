#!/usr/bin/env python3
"""Ground truth for the EDGE planes of a Java repository, from tree-sitter-java.

The declaration referee (`ast-referee.py --lang java`) grades the NODES of a code graph. This one
grades the edges — the part that makes it a graph rather than a symbol table, and the part a
blast-radius or call-chain query actually traverses. It is the Java sibling of
edge-referee-cpython.py and emits the identical JSON shape so one scorer serves both.

WHY tree-sitter and not javac. The Go and Python referees use the language's own compiler front
end, which is strictly better: it cannot disagree with the language. Java has no equivalent that
is cheap here — javac needs a resolved classpath, and a referee that needs the build to succeed
stops being a referee for arbitrary checkouts. tree-sitter-java is what this repository already
uses for Java ground truth (`ast-referee.py`), and reusing it keeps the declaration and edge
truth sets on one grammar so a disagreement between the two planes is never a grammar artefact.
The tradeoff is named rather than hidden: this referee shares a grammar with any system under
test that also parses Java with tree-sitter, so it cannot adjudicate a dispute that is really a
dispute about the grammar. The Go referee exists partly to give one language in the programme an
oracle that has no such shared blind spot.

Three planes, each chosen because the grammar answers it EXACTLY — no heuristics, no resolution:

  imports      (file, name)            one row per import_declaration. `name` is the FULL dotted
                                       path as written, `static` stripped and `.*` preserved:
                                       "java.util.List", "java.util.Arrays.asList",
                                       "java.io.*". The Python referee truncates `import a.b.c`
                                       to `a` because there the leading component is the
                                       distributed package; a Java import names one specific
                                       type or member, and truncating to `java` would collapse
                                       every JDK dependency in the repo into a single edge. A
                                       full path is losslessly truncatable by a scorer; the
                                       reverse is not, so the referee keeps the information.
                                       Static and on-demand imports are NOT distinguishable in
                                       the fixed output shape — the `.*` suffix is the only
                                       signal, and `static` is dropped because it qualifies how
                                       the name is used, not what is depended on.

  inheritance  (file, child, base)     ONE ROW PER BASE, so `class A extends B implements C, D`
                                       yields three rows. Covers `extends` on a class,
                                       `implements` on a class, enum or record, and `extends` on
                                       an interface (which in Java is multiple inheritance of
                                       interface type). Bases keep only the FINAL COMPONENT with
                                       type arguments stripped: `java.util.List<String>` ->
                                       `List` — same rule and same reason as the Python referee,
                                       which keeps `ABC` from `abc.ABC`: the systems under test
                                       resolve to a symbol name, not a dotted path, and
                                       demanding the dotted form would score the import style
                                       rather than the edge.

                                       Note the contrast with the Go referee, where inheritance
                                       is embedding and interface satisfaction is unstateable.
                                       In Java `implements` is written down, so it is here.

  calls        (file, caller, callee)  a method_invocation. `caller` is the enclosing
                                       method_declaration or constructor_declaration name (bare
                                       `m`, not `A.m`, mirroring the Python referee, which
                                       pushes the bare def name), or "<initializer>" for a call
                                       in a field initialiser, a static/instance initialiser
                                       block, or an annotation default — Java's analogue of the
                                       Python referee's "<module>", which is likewise the code
                                       that runs with no named function around it. A lambda does
                                       NOT open a new caller scope, mirroring the Python
                                       referee's treatment of a lambda; a method declared inside
                                       an anonymous class body does, because it is a real
                                       method_declaration.

                                       `callee` is the invocation's `name` field — the final
                                       component. `obj.h()` -> `h`, `a.b.C.f()` -> `f`.
                                       NAME-LEVEL, deliberately: the grammar cannot say which
                                       `get` is meant without a classpath and a type checker, so
                                       anything stricter would score our resolution guess
                                       against another system's.

                                       EXCLUDED, and this is the one place the Java plane is
                                       deliberately narrower than the Python one: `new Foo()`
                                       (object_creation_expression) and `super(...)`/`this(...)`
                                       (explicit_constructor_invocation). Python's grammar cannot
                                       tell construction from invocation — `Foo()` is an
                                       ast.Call — so the Python referee counts it. Java's grammar
                                       can, and Koragraph models instantiation as its own
                                       INSTANTIATES edge rather than as CALLS, so folding
                                       constructions into this plane would charge a correct
                                       extraction as a miss. Consequence, stated because it
                                       matters to anyone comparing across languages: Java and
                                       Python call counts are not comparable per-KLOC.

PARSE FAILURES: recorded in parse_errors, never silently dropped. tree-sitter always returns a
tree, doing local error recovery, so this referee flags any file whose tree contains an ERROR
node AND still emits what did parse — a scorer can exclude those files or accept the partial
rows, but cannot fail to notice them. (The Python referee's `ast` is all-or-nothing and so
emits nothing for a failed file; the difference is in the parser, not the policy.)

SKIP mirrors edge-referee-cpython.py's set exactly, plus Java build output dirs, so every side of
the comparison sees the same files.

Zero network, zero LLM.

  .venv-graphify/bin/python koragraph_api/scripts/edge-referee-java.py <checkout> --out truth-edges.json
"""
import argparse, json, os, sys

from tree_sitter import Language, Parser

# edge-referee-cpython.py's SKIP verbatim, plus Java build output. The Python-only entries are
# kept so both referees skip the same path in a polyglot checkout. `bin`/`out`/`target`/`build`
# hold .class files, and `.mvn`/`gradle` hold wrapper scripts — none contain .java sources.
SKIP = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out",
        ".gitnexus", "graphify-out", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache",
        "bin", ".mvn", "gradle"}

# A call in one of these has a name to attribute it to; anything else is <initializer>.
CALLER_DECLS = ("method_declaration", "constructor_declaration", "compact_constructor_declaration")

# Every declaration form that can name a supertype, and the grammar's spelling of `implements`
# on each. `interface_declaration` carries its bases under an `extends_interfaces` child rather
# than a named field, which is why the lookup below is by child type and not by field name.
TYPE_DECLS = ("class_declaration", "interface_declaration", "enum_declaration",
              "record_declaration")


def text(node, src):
    return src[node.start_byte:node.end_byte].decode("utf8", "replace")


def simple_name(t):
    """Final component of a type reference, type arguments stripped.

    `java.util.List<String>` -> `List`, `Map.Entry<K,V>` -> `Entry`, `int[]` -> `int`.
    Matches the Python referee's rule of keeping only the symbol name.
    """
    t = t.split("<", 1)[0].strip()
    t = t.replace("[]", "").strip()
    t = t.rsplit(".", 1)[-1].strip()
    return t


def type_list_names(node, src):
    """The type names in a `type_list` (the body of `implements A, B` / `extends J, K`)."""
    names = []
    for child in node.named_children:
        nm = simple_name(text(child, src))
        if nm:
            names.append(nm)
    return names


def child_of_type(node, kind):
    for c in node.children:
        if c.type == kind:
            return c
    return None


def import_name(node, src):
    """Full dotted path of an import_declaration, `static` and `;` removed, `.*` preserved."""
    raw = text(node, src).strip()
    if raw.endswith(";"):
        raw = raw[:-1]
    parts = raw.split()
    if parts and parts[0] == "import":
        parts = parts[1:]
    if parts and parts[0] == "static":
        parts = parts[1:]
    return "".join(parts).strip()


def collect(root, src, out, rel):
    # Explicit stack carrying the enclosing caller down, so a nested/anonymous-class method
    # correctly becomes the caller for calls inside it.
    stack = [(root, "<initializer>")]
    while stack:
        node, caller = stack.pop()

        if node.type == "import_declaration":
            nm = import_name(node, src)
            if nm:
                out["imports"].append({"file": rel, "name": nm})

        elif node.type in TYPE_DECLS:
            child = node.child_by_field_name("name")
            child = text(child, src) if child else None
            if child:
                sup = node.child_by_field_name("superclass")
                if sup is not None:
                    for c in sup.named_children:  # skips the `extends` keyword token
                        nm = simple_name(text(c, src))
                        if nm:
                            out["inheritance"].append(
                                {"file": rel, "child": child, "base": nm})
                for holder in (node.child_by_field_name("interfaces"),
                               child_of_type(node, "extends_interfaces")):
                    if holder is None:
                        continue
                    tl = child_of_type(holder, "type_list")
                    if tl is None:
                        continue
                    for nm in type_list_names(tl, src):
                        out["inheritance"].append({"file": rel, "child": child, "base": nm})

        elif node.type == "method_invocation":
            n = node.child_by_field_name("name")
            if n is not None:
                out["calls"].append(
                    {"file": rel, "caller": caller, "callee": text(n, src)})

        inner = caller
        if node.type in CALLER_DECLS:
            n = node.child_by_field_name("name")
            if n is not None:
                inner = text(n, src)

        # Reversed, so the LIFO stack yields children in source order — the rows then read in
        # file order like the Python referee's, which makes two truth sets diffable by eye.
        for c in reversed(node.children):
            stack.append((c, inner))


def referee_version():
    from importlib.metadata import PackageNotFoundError, version
    parts = []
    for pkg in ("tree-sitter", "tree-sitter-java"):
        try:
            parts.append(f"{pkg} {version(pkg)}")
        except PackageNotFoundError:
            parts.append(f"{pkg} unknown")
    return " / ".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkout")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    import tree_sitter_java
    parser = Parser(Language(tree_sitter_java.language()))

    out = {"imports": [], "inheritance": [], "calls": [], "parse_errors": [], "files": 0,
           "referee": "tree-sitter-java", "referee_version": referee_version()}

    paths = []
    for root, dirs, files in os.walk(a.checkout):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            if f.endswith(".java"):
                paths.append(os.path.join(root, f))
    paths.sort()

    for p in paths:
        with open(p, "rb") as fh:
            src = fh.read()
        rel = os.path.relpath(p, a.checkout)
        out["files"] += 1
        tree = parser.parse(src)
        if tree.root_node.has_error:
            out["parse_errors"].append(rel)
        collect(tree.root_node, src, out, rel)

    json.dump(out, open(a.out, "w"))
    sys.stderr.write(
        f"[edge-truth] {out['files']} files: {len(out['imports'])} imports, "
        f"{len(out['inheritance'])} inheritance, {len(out['calls'])} calls, "
        f"{len(out['parse_errors'])} parse errors -> {a.out}\n")


if __name__ == "__main__":
    main()
