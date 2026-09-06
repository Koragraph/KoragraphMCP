#!/usr/bin/env python
"""Ground truth for the AST layer, from tree-sitter — the same grammars Graphify itself
parses with, so neither side is scored against its own notion of what a declaration is.

Emits one JSON object: every method, type and field the grammar finds, keyed so both
Koragraph and Graphify output can be matched against it.

Usage:
  .venv-graphify/bin/python koragraph_api/scripts/ast-referee.py <repoPath> [--out f.json]
  .venv-graphify/bin/python koragraph_api/scripts/ast-referee.py <repoPath> --lang typescript
"""
import json
import os
import sys

from tree_sitter import Language, Parser

# Kept per language: the Java set is frozen because the published Java numbers were produced
# with exactly these exclusions, and widening it would silently move them.
SKIP_JAVA = {".git", "node_modules", "target", "build", "vendor", ".gradle", "out"}
SKIP_TS = SKIP_JAVA | {"dist", "coverage", ".next", "bazel-out", ".angular"}

# ── Java ─────────────────────────────────────────────────────────────────────

TYPE_DECLS = {
    "class_declaration": "class",
    "interface_declaration": "interface",
    "enum_declaration": "enum",
    "record_declaration": "record",
    "annotation_type_declaration": "annotation",
}


def name_of(node, src):
    n = node.child_by_field_name("name")
    return src[n.start_byte:n.end_byte].decode("utf8", "replace") if n else None


def text_of(node, src):
    return src[node.start_byte:node.end_byte].decode("utf8", "replace") if node else None


def enclosing_type(node, src):
    """Nearest enclosing named type, or a synthetic name for anonymous/enum-constant scopes."""
    cur = node.parent
    while cur is not None:
        if cur.type in TYPE_DECLS:
            return name_of(cur, src)
        if cur.type == "object_creation_expression":
            return "<anonymous>"
        if cur.type == "enum_constant":
            return f"<enum_constant:{name_of(cur, src)}>"
        cur = cur.parent
    return None


def collect_java(root, src, out, rel):
    stack = [root]
    while stack:
        node = stack.pop()
        for c in node.children:
            stack.append(c)

        if node.type in TYPE_DECLS:
            nm = name_of(node, src)
            if nm:
                out["types"].append({
                    "file": rel, "name": nm, "kind": TYPE_DECLS[node.type],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif node.type in ("method_declaration", "constructor_declaration"):
            nm = name_of(node, src)
            params = node.child_by_field_name("parameters")
            ptext = src[params.start_byte:params.end_byte].decode("utf8", "replace") if params else "()"
            if nm:
                out["methods"].append({
                    "file": rel, "name": nm, "owner": enclosing_type(node, src),
                    "params": " ".join(ptext.strip("()").split()),
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                    "is_ctor": node.type == "constructor_declaration",
                })

        # `constant_declaration` is how the grammar names a field declared in an interface
        # body (`String KEY = "x";` — implicitly public static final). Counting only
        # `field_declaration` under-reported the truth by 1,457 fields on dubbo alone and made
        # correct extractions look like false positives. The referee was wrong, not the tool.
        # An enum constant is a field by the JLS (8.9.3: implicitly `public static final`), and
        # the TypeScript (`enum_member`) and C# (`enum_member_declaration`) referees already
        # model it as one. Java was the sole exception, so Graphify's 1,985 correct enum-constant
        # extractions had nowhere to land and were charged as spurious types.
        elif node.type == "enum_constant":
            nm = name_of(node, src)
            if nm:
                out["fields"].append({
                    "file": rel, "name": nm, "type": None, "kind": "enum_constant",
                    "owner": enclosing_type(node, src), "line": node.start_point[0] + 1,
                })

        elif node.type in ("field_declaration", "constant_declaration"):
            # One field_declaration can declare several names: `int x, y;`
            for d in node.children_by_field_name("declarator"):
                n = d.child_by_field_name("name")
                if n is None:
                    continue
                t = node.child_by_field_name("type")
                out["fields"].append({
                    "file": rel, "name": src[n.start_byte:n.end_byte].decode("utf8", "replace"),
                    "type": src[t.start_byte:t.end_byte].decode("utf8", "replace") if t else None,
                    "owner": enclosing_type(node, src),
                    "line": node.start_point[0] + 1,
                })


# ── TypeScript ───────────────────────────────────────────────────────────────
#
# Inclusion rules, written down because they change both sides' scores (see §1.2 of
# docs/research/EXTRACTION_TYPESCRIPT_KORAGRAPH_VS_GRAPHIFY.md):
#
#   types   — the five named type-introducing declarations: class, abstract class,
#             interface, enum, type alias. TS has no separate "record"/"annotation".
#   methods — a *named binding whose value is a function*, plus every declared callable
#             signature. That single rule covers class methods, interface method
#             signatures, overload signatures, ambient function signatures, standalone
#             functions, object-literal methods, `const f = () => {}` and the class-property
#             arrow (`handle = (e) => {}`) that React and Angular use as a method.
#             The rule is deliberately value-based, not type-based: `c: () => void` in an
#             interface declares no function, only a type, so it is a field.
#   fields  — named *members of a type* that are not callable bindings: class properties,
#             interface property signatures, enum members, and TypeScript's constructor
#             parameter properties (`constructor(private svc: Svc)`), which declare a real
#             class field with no other syntax for it.
#
#   constants — added 2026-08-16 as a fourth plane; see the `ts_module_level` block below.
#             A top-level binding whose value is not a function (`const MAX = 5`). It is
#             neither a type member nor callable, so it belongs in neither plane above.
#
# Deliberately excluded: bindings inside a function body (locals, not declarations); unnamed
# construct/index/call signatures; computed property names (`[Symbol.iterator]()`), which have
# no stable identifier to match on.

TS_TYPE_DECLS = {
    "class_declaration": "class",
    "abstract_class_declaration": "class",
    "interface_declaration": "interface",
    "enum_declaration": "enum",
    "type_alias_declaration": "type_alias",
}

TS_FUNCTION_VALUES = {"arrow_function", "function_expression", "function",
                      "generator_function"}

TS_CALLABLE_DECLS = {
    "function_declaration": "function",
    "generator_function_declaration": "function",
    "function_signature": "function_signature",
    "method_definition": "method",
    "method_signature": "method_signature",
    "abstract_method_signature": "abstract_method",
}

# `number` is here because a numeric property name (`{ 42: string }`) is a stable identifier,
# unlike a computed one. Omitting it was the only disagreement between this referee and the
# TypeScript compiler referee on the whole corpus — 5 fields out of 2,613 on zod.
TS_NAME_NODES = {"identifier", "property_identifier", "type_identifier",
                 "shorthand_property_identifier", "private_property_identifier", "number"}


def ts_name(node, src):
    # `name` in TypeScript, `key` on a `pair`, and `property` on JavaScript's
    # `field_definition` — the JS grammar names that field differently from the TS one, which
    # silently zeroed the whole JavaScript field plane until it was checked against a class
    # that plainly has fields.
    n = (node.child_by_field_name("name") or node.child_by_field_name("key")
         or node.child_by_field_name("property"))
    if n is None:
        return None
    if n.type == "string":
        frag = next((c for c in n.children if c.type == "string_fragment"), None)
        return text_of(frag, src) if frag else None
    if n.type not in TS_NAME_NODES:
        return None  # computed / destructured — no stable identifier
    return text_of(n, src)


def ts_enclosing_type(node, src):
    cur = node.parent
    while cur is not None:
        if cur.type in TS_TYPE_DECLS:
            return ts_name(cur, src)
        if cur.type in ("object", "class"):
            return "<anonymous>"
        cur = cur.parent
    return None


def ts_params(node, src):
    p = node.child_by_field_name("parameters")
    if p is None:
        p = next((c for c in node.children if c.type == "formal_parameters"), None)
    t = text_of(p, src) or "()"
    return " ".join(t.strip("()").split())


def collect_typescript(root, src, out, rel):
    stack = [root]
    while stack:
        node = stack.pop()
        for c in node.children:
            stack.append(c)

        t = node.type

        if t in TS_TYPE_DECLS:
            nm = ts_name(node, src)
            if nm:
                out["types"].append({
                    "file": rel, "name": nm, "kind": TS_TYPE_DECLS[t],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t in TS_CALLABLE_DECLS:
            nm = ts_name(node, src)
            if nm:
                out["methods"].append({
                    "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                    "params": ts_params(node, src), "kind": TS_CALLABLE_DECLS[t],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t in ("variable_declarator", "public_field_definition", "pair"):
            nm = ts_name(node, src)
            if not nm:
                continue
            val = node.child_by_field_name("value")
            is_fn = val is not None and val.type in TS_FUNCTION_VALUES
            if is_fn:
                out["methods"].append({
                    "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                    "params": ts_params(val, src),
                    "kind": ("class_property_fn" if t == "public_field_definition"
                             else "const_fn" if t == "variable_declarator" else "object_prop_fn"),
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })
            elif t == "variable_declarator" and ts_module_level(node):
                out["constants"].append({
                    "file": rel, "name": nm, "kind": "module_constant",
                    "line": node.start_point[0] + 1,
                })
            elif t == "public_field_definition":
                ann = node.child_by_field_name("type")
                out["fields"].append({
                    "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                    "type": text_of(ann, src), "kind": "class_property",
                    "line": node.start_point[0] + 1,
                })

        elif t == "property_signature":
            nm = ts_name(node, src)
            if nm:
                ann = node.child_by_field_name("type")
                out["fields"].append({
                    "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                    "type": text_of(ann, src), "kind": "property_signature",
                    "line": node.start_point[0] + 1,
                })

        elif t == "enum_body":
            for c in node.named_children:
                if c.type == "enum_assignment":
                    nm = ts_name(c, src)
                elif c.type in ("property_identifier", "identifier"):
                    nm = text_of(c, src)
                else:
                    continue
                if nm:
                    out["fields"].append({
                        "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                        "type": None, "kind": "enum_member",
                        "line": c.start_point[0] + 1,
                    })

        # TypeScript parameter properties: `constructor(private readonly svc: Svc)` declares
        # a class field and there is no other syntax that declares it. Angular and NestJS
        # express nearly all dependency injection this way, so omitting them would erase most
        # of the field plane on exactly the dialects this corpus is built to cover.
        elif t in ("required_parameter", "optional_parameter"):
            modified = any(c.type in ("accessibility_modifier", "readonly", "override_modifier")
                           for c in node.children)
            in_ctor = (node.parent is not None and node.parent.type == "formal_parameters"
                       and node.parent.parent is not None
                       and node.parent.parent.type == "method_definition"
                       and ts_name(node.parent.parent, src) == "constructor")
            if modified and in_ctor:
                pat = node.child_by_field_name("pattern")
                if pat is not None and pat.type == "identifier":
                    ann = node.child_by_field_name("type")
                    out["fields"].append({
                        "file": rel, "name": text_of(pat, src),
                        "owner": ts_enclosing_type(node, src),
                        "type": text_of(ann, src), "kind": "parameter_property",
                        "line": node.start_point[0] + 1,
                    })


# ── driver ───────────────────────────────────────────────────────────────────

# ── JavaScript ───────────────────────────────────────────────────────────────
#
# Same rule as TypeScript §1.2, minus the forms JavaScript does not have (interface, enum,
# type alias, property signature, parameter property) and plus the one it does: a function
# assigned to a member. `exports.f = function () {}` and `Foo.prototype.bar = fn` ARE the
# declaration in CommonJS and prototype-era code — most of express and lodash is written that
# way and nothing else declares those functions.
#
# The accepted assignment shapes are exactly Graphify's own four (engine.py
# #_js_member_assignment_target): `this.X`, `exports.X`, `module.exports.X`, `Foo.prototype.X`.
# Taking a looser rule — any `obj.x = fn` — would count locals and callbacks as declarations
# and would score the competitor against a definition it does not use.

JS_TYPE_DECLS = {"class_declaration": "class"}

JS_CALLABLE_DECLS = {
    "function_declaration": "function",
    "generator_function_declaration": "function",
    "method_definition": "method",
}


def js_assignment_member(node, src):
    """(kind, name) for an `X = <function>` whose left side is one of the four accepted
    member shapes; None for anything else."""
    left = node.child_by_field_name("left")
    if left is None or left.type != "member_expression":
        return None
    prop = left.child_by_field_name("property")
    obj = left.child_by_field_name("object")
    if prop is None or obj is None or prop.type not in ("property_identifier", "private_property_identifier"):
        return None
    name = text_of(prop, src)
    if obj.type == "this":
        return ("this_member", name)
    if obj.type == "identifier":
        return ("exports_member", name) if text_of(obj, src) == "exports" else None
    if obj.type == "member_expression":
        inner_obj = obj.child_by_field_name("object")
        inner_prop = obj.child_by_field_name("property")
        if inner_obj is None or inner_prop is None:
            return None
        ip = text_of(inner_prop, src)
        if inner_obj.type == "identifier":
            if text_of(inner_obj, src) == "module" and ip == "exports":
                return ("exports_member", name)
            if ip == "prototype":
                return ("prototype_member", name)
    return None


def collect_javascript(root, src, out, rel):
    stack = [root]
    while stack:
        node = stack.pop()
        for c in node.children:
            stack.append(c)
        t = node.type

        if t in JS_TYPE_DECLS:
            nm = ts_name(node, src)
            if nm:
                out["types"].append({
                    "file": rel, "name": nm, "kind": JS_TYPE_DECLS[t],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t in JS_CALLABLE_DECLS:
            nm = ts_name(node, src)
            if nm:
                out["methods"].append({
                    "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                    "params": ts_params(node, src), "kind": JS_CALLABLE_DECLS[t],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t in ("variable_declarator", "field_definition", "pair"):
            nm = ts_name(node, src)
            if not nm:
                continue
            val = node.child_by_field_name("value")
            if val is not None and val.type in TS_FUNCTION_VALUES:
                out["methods"].append({
                    "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                    "params": ts_params(val, src),
                    "kind": ("class_property_fn" if t == "field_definition"
                             else "const_fn" if t == "variable_declarator" else "object_prop_fn"),
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })
            elif t == "field_definition":
                out["fields"].append({
                    "file": rel, "name": nm, "owner": ts_enclosing_type(node, src),
                    "type": None, "kind": "class_property",
                    "line": node.start_point[0] + 1,
                })
            elif t == "variable_declarator" and ts_module_level(node):
                out["constants"].append({
                    "file": rel, "name": nm, "kind": "module_constant",
                    "line": node.start_point[0] + 1,
                })

        elif t == "assignment_expression":
            val = node.child_by_field_name("right")
            if val is None or val.type not in TS_FUNCTION_VALUES:
                continue
            m = js_assignment_member(node, src)
            if m:
                out["methods"].append({
                    "file": rel, "name": m[1], "owner": ts_enclosing_type(node, src),
                    "params": ts_params(val, src), "kind": m[0],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })


# ── Python ───────────────────────────────────────────────────────────────────
#
# Same shape as the other languages: types, callables, and named members of a type.
#
#   types   — `class_definition`, at any depth (module level, nested, inside a function).
#   methods — `function_definition`, at any depth, which covers `def`, `async def`, methods,
#             nested functions and closures; plus a `lambda` bound to a name, which is the same
#             value-based rule the JS/TS sections use.
#   fields  — Python has no field *declaration* syntax, so the declaration is the first
#             assignment. Two forms count, both deduped per (class, name) because one attribute
#             assigned in three methods is one attribute:
#               • a class-body assignment — `x = 1`, `x: int = 0`, and the bare annotation
#                 `x: int` that dataclasses and typed attributes use;
#               • `self.NAME = ...` anywhere inside the class's own methods, which is how
#                 essentially every instance attribute in Python is introduced.
#             A class-body name wins over a `self.` one of the same name.
#
# Deliberately excluded: module-level variables (`CONST = 1`) — not members of a type, matching
# the JS/TS rule; the string entries inside `__slots__` (the `__slots__` assignment itself is a
# field, its contents are literals); `global`/`nonlocal` rebinding; and attributes introduced on
# some other object (`obj.x = 1`), which are not declarations of this class.

PY_ASSIGN_SKIP = {"_", "__all__"}


# ── Module constants (TypeScript / JavaScript / Python) ──────────────────────
#
# A fourth plane, added 2026-08-16. A *module constant* is a name bound at the top level of a
# module whose value is not a function — `const MAX = 5`, `export const ROUTES = [...]`,
# `TIMEOUT = 30`. It is not a member of a type, so it is not a field, and it is not callable,
# so it is not a method; earlier revisions of this method excluded it from truth entirely,
# which meant Graphify's 12,634 such nodes on the JavaScript corpus scored as false positives
# when they are a real plane it emits and Koragraph did not.
#
# Restricted to the top level on purpose. A binding inside a function is a local, and counting
# those would make every temporary variable a declaration.

def ts_module_level(node):
    """True when a variable_declarator's declaration sits directly in the module body."""
    decl = node.parent
    if decl is None or decl.type not in ("lexical_declaration", "variable_declaration"):
        return False
    holder = decl.parent
    if holder is not None and holder.type == "export_statement":
        holder = holder.parent
    return holder is not None and holder.type == "program"


def py_enclosing_class(node, src):
    cur = node.parent
    while cur is not None:
        if cur.type == "class_definition":
            return ts_name(cur, src), cur
        cur = cur.parent
    return None, None


def py_params(node, src):
    p = node.child_by_field_name("parameters")
    t = text_of(p, src) or "()"
    return " ".join(t.strip("()").split())


def collect_python(root, src, out, rel):
    class_body_fields = set()   # (class_start, name) declared in the class body
    self_fields = {}            # (class_start, name) -> first node seen
    pending = []

    stack = [root]
    while stack:
        node = stack.pop()
        for c in node.children:
            stack.append(c)
        t = node.type

        if t == "class_definition":
            nm = ts_name(node, src)
            if nm:
                out["types"].append({
                    "file": rel, "name": nm, "kind": "class",
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t == "function_definition":
            nm = ts_name(node, src)
            if nm:
                owner, _ = py_enclosing_class(node, src)
                out["methods"].append({
                    "file": rel, "name": nm, "owner": owner, "kind": "function",
                    "params": py_params(node, src),
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t == "assignment":
            left = node.child_by_field_name("left")
            if left is None:
                continue
            value = node.child_by_field_name("right")

            if left.type == "identifier":
                name = text_of(left, src)
                if not name or name in PY_ASSIGN_SKIP:
                    continue
                if value is not None and value.type == "lambda":
                    owner, _ = py_enclosing_class(node, src)
                    out["methods"].append({
                        "file": rel, "name": name, "owner": owner, "kind": "lambda_fn",
                        "params": " ".join((text_of(value.child_by_field_name("parameters"), src) or "").split()),
                        "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                    })
                    continue
                # A class-body assignment: parent chain is expression_statement -> block ->
                # class_definition. Anything deeper is a local, not a class attribute.
                #
                # A chained assignment nests: `a = b = c` parses as
                # assignment(a, assignment(b, c)), so every target after the first has an
                # `assignment` parent and failed this test. flask declares seven dict methods
                # on one such line; only the first was counted. Climb the chain first.
                cur = node
                while cur.parent is not None and cur.parent.type == "assignment":
                    cur = cur.parent
                stmt = cur.parent
                blk = stmt.parent if stmt is not None else None
                if blk is not None and blk.type == "module":
                    out["constants"].append({
                        "file": rel, "name": name, "kind": "module_constant",
                        "line": node.start_point[0] + 1,
                    })
                    continue
                if blk is not None and blk.parent is not None and blk.parent.type == "class_definition":
                    key = (blk.parent.start_byte, name)
                    if key in class_body_fields:
                        continue
                    class_body_fields.add(key)
                    pending.append({
                        "file": rel, "name": name, "owner": ts_name(blk.parent, src),
                        "type": text_of(node.child_by_field_name("type"), src),
                        "kind": "class_attribute", "line": node.start_point[0] + 1,
                        "_key": key,
                    })

            elif left.type == "attribute":
                obj = left.child_by_field_name("object")
                attr = left.child_by_field_name("attribute")
                if obj is None or attr is None or obj.type != "identifier":
                    continue
                if text_of(obj, src) != "self":
                    continue
                name = text_of(attr, src)
                owner, cls = py_enclosing_class(node, src)
                if not name or cls is None:
                    continue
                key = (cls.start_byte, name)
                if key in self_fields:
                    continue
                self_fields[key] = {
                    "file": rel, "name": name, "owner": owner, "type": None,
                    "kind": "instance_attribute", "line": node.start_point[0] + 1,
                    "_key": key,
                }

    for f in pending:
        f.pop("_key", None)
        out["fields"].append(f)
    for key, f in self_fields.items():
        if key in class_body_fields:
            continue
        f.pop("_key", None)
        out["fields"].append(f)


# ── C# ───────────────────────────────────────────────────────────────────────
#
#   types   — class, interface, struct, record, record struct, enum, and `delegate`, which
#             declares a named type and which Graphify's config does not list.
#   methods — method, constructor, destructor, operator, conversion operator, and local
#             function. Property accessors are NOT separate methods: a property is one member,
#             and `{ get; set; }` usually declares no body at all.
#   fields  — field declarations (one per declarator: `string _a, _b;` is two), properties
#             (including expression-bodied `public int X => _x;`), event fields, enum members,
#             and a record's positional parameters, which declare real members and have no
#             other declaring syntax — the same rule as TypeScript's parameter properties.
#
# Deliberately excluded: indexers and operators-as-fields (no stable name), and `constants`,
# which is empty for C# because the language has no module-level binding — a `const` lives in a
# type and is already a field.

CS_TYPE_DECLS = {
    "class_declaration": "class",
    "interface_declaration": "interface",
    "struct_declaration": "struct",
    "record_declaration": "record",
    "record_struct_declaration": "record",
    "enum_declaration": "enum",
    "delegate_declaration": "delegate",
}

CS_CALLABLE_DECLS = {
    "method_declaration": "method",
    "constructor_declaration": "constructor",
    "destructor_declaration": "destructor",
    "operator_declaration": "operator",
    "conversion_operator_declaration": "operator",
    "local_function_statement": "local_function",
}


def cs_enclosing_type(node, src):
    cur = node.parent
    while cur is not None:
        if cur.type in CS_TYPE_DECLS:
            return name_of(cur, src)
        cur = cur.parent
    return None


def cs_params(node, src):
    p = node.child_by_field_name("parameters")
    if p is None:
        p = next((c for c in node.children if c.type == "parameter_list"), None)
    t = text_of(p, src) or "()"
    return " ".join(t.strip("()").split())


def collect_csharp(root, src, out, rel):
    stack = [root]
    while stack:
        node = stack.pop()
        for c in node.children:
            stack.append(c)
        t = node.type

        if t in CS_TYPE_DECLS:
            nm = name_of(node, src)
            if nm:
                out["types"].append({
                    "file": rel, "name": nm, "kind": CS_TYPE_DECLS[t],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })
            # A record's positional parameters declare members with no other syntax.
            if t in ("record_declaration", "record_struct_declaration"):
                plist = next((c for c in node.children if c.type == "parameter_list"), None)
                for prm in (plist.named_children if plist else []):
                    if prm.type != "parameter":
                        continue
                    pn = prm.child_by_field_name("name")
                    if pn is not None:
                        out["fields"].append({
                            "file": rel, "name": text_of(pn, src), "owner": nm,
                            "type": text_of(prm.child_by_field_name("type"), src),
                            "kind": "record_parameter", "line": prm.start_point[0] + 1,
                        })

        elif t in CS_CALLABLE_DECLS:
            nm = name_of(node, src)
            if nm is None and t in ("operator_declaration", "conversion_operator_declaration"):
                op = node.child_by_field_name("operator")
                nm = f"operator{text_of(op, src)}" if op is not None else None
            if nm:
                out["methods"].append({
                    "file": rel, "name": nm, "owner": cs_enclosing_type(node, src),
                    "params": cs_params(node, src), "kind": CS_CALLABLE_DECLS[t],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t in ("field_declaration", "event_field_declaration"):
            vd = next((c for c in node.children if c.type == "variable_declaration"), None)
            vtype = text_of(vd.child_by_field_name("type"), src) if vd is not None else None
            for d in (vd.named_children if vd is not None else []):
                if d.type != "variable_declarator":
                    continue
                dn = d.child_by_field_name("name") or next(
                    (c for c in d.children if c.type == "identifier"), None)
                if dn is None:
                    continue
                out["fields"].append({
                    "file": rel, "name": text_of(dn, src), "owner": cs_enclosing_type(node, src),
                    "type": vtype,
                    "kind": "event" if t == "event_field_declaration" else "field",
                    "line": node.start_point[0] + 1,
                })

        elif t == "property_declaration":
            nm = name_of(node, src)
            if nm:
                out["fields"].append({
                    "file": rel, "name": nm, "owner": cs_enclosing_type(node, src),
                    "type": text_of(node.child_by_field_name("type"), src),
                    "kind": "property", "line": node.start_point[0] + 1,
                })

        elif t == "enum_member_declaration":
            nm = name_of(node, src)
            if nm:
                out["fields"].append({
                    "file": rel, "name": nm, "owner": cs_enclosing_type(node, src),
                    "type": None, "kind": "enum_member", "line": node.start_point[0] + 1,
                })


# ── SQL ──────────────────────────────────────────────────────────────────────
#
# SQL is the first language in this programme where the three-plane model is not obvious, so
# the taxonomy is fixed HERE, before any measurement, and both sides are scored against it.
#
#   types   — named schema objects that declare structure and are NOT invocable by name:
#             CREATE TABLE, CREATE VIEW, CREATE MATERIALIZED VIEW, CREATE TYPE,
#             CREATE DOMAIN, CREATE SEQUENCE, CREATE TRIGGER.
#             A trigger is here, not in methods, because nothing calls it by name — it is
#             bound to a table and fired by the engine. This also matches Graphify's own
#             label convention (a callable is rendered `name()`, everything else bare), so
#             the competitor is not charged for a classification we invented.
#   methods — routines invocable by name with an argument list: CREATE FUNCTION,
#             CREATE PROCEDURE, in all their spellings (OR REPLACE, OR ALTER, IF NOT EXISTS).
#   fields  — the columns a table declares (CREATE TABLE, and ALTER TABLE ... ADD COLUMN),
#             the attributes of a composite CREATE TYPE, and the labels of an enum
#             CREATE TYPE ... AS ENUM. Columns are to a table what fields are to a class.
#   constants — always empty. SQL has no module-level binding; a value lives in a row.
#
# Deliberately EXCLUDED, and why:
#   • CREATE INDEX and every constraint (PRIMARY KEY, FOREIGN KEY, CHECK, UNIQUE) — an
#     attribute of a table rather than an independent declaration, the same call the C#
#     section makes for indexers.
#   • CREATE SCHEMA / DATABASE / ROLE / USER / EXTENSION / POLICY / RULE / OPERATOR /
#     AGGREGATE / CAST / SERVER / PUBLICATION — deployment, permission and extension-point
#     objects, not code declarations.
#   • Every DML statement, and the columns a SELECT projects (derived, not declared).
#   • View column lists — a view's columns come from its query and are not declared.
#
# Name matching is normalised identically on all three sides in ast-layer-compare.py:
# quoting stripped ("x", [x], `x`), schema qualification dropped, lowercased — because SQL
# identifiers are case-insensitive unless quoted and the two tools qualify differently.
#
# ── WARNING: this referee is the WEAK one for SQL. ───────────────────────────
# tree-sitter-sql is Graphify's own grammar, which is why it is kept, but it gives up on a
# great deal of real SQL: PL/pgSQL bodies (dollar-quoted), CREATE DOMAIN, and T-SQL
# `CREATE OR ALTER PROCEDURE` all land in an ERROR node with no recovery. The primary
# referee for SQL is `ast-referee-sqlref.py`, which routes each file to a production
# parser for its dialect (libpg_query for PostgreSQL, ScriptDom for T-SQL). Do not quote a
# SQL number from this file alone.

SQL_TYPE_DECLS = {
    "create_table": "table",
    "create_view": "view",
    "create_materialized_view": "materialized_view",
    "create_type": "type",
    "create_sequence": "sequence",
    "create_trigger": "trigger",
}

SQL_CALLABLE_DECLS = {
    "create_function": "function",
    "create_procedure": "procedure",
}


def sql_obj_name(node, src):
    """The first `object_reference` child — how this grammar spells the declared name."""
    for c in node.children:
        if c.type == "object_reference":
            return text_of(c, src)
    return None


def sql_trigger_name(node, src):
    """A trigger carries two object_references: its own name, then the table it is FOR/ON."""
    seen_kw = False
    for c in node.children:
        if c.type == "keyword_trigger":
            seen_kw = True
        elif seen_kw and c.type == "object_reference":
            return text_of(c, src)
    return None


def sql_columns(node, src, owner, out, rel, kind):
    """Every `column_definition` directly inside this node's `column_definitions` block.
    Constraints live in a sibling `constraints` node, so they are excluded by construction."""
    for block in node.children:
        if block.type != "column_definitions":
            continue
        for cd in block.children:
            if cd.type != "column_definition":
                continue
            nm = next((c for c in cd.children if c.type == "identifier"), None)
            if nm is None:
                continue
            out["fields"].append({
                "file": rel, "name": text_of(nm, src), "owner": owner,
                "type": None, "kind": kind, "line": cd.start_point[0] + 1,
            })


def collect_sql(root, src, out, rel):
    stack = [root]
    while stack:
        node = stack.pop()
        for c in node.children:
            stack.append(c)
        t = node.type

        if t in SQL_TYPE_DECLS:
            nm = sql_trigger_name(node, src) if t == "create_trigger" else sql_obj_name(node, src)
            if not nm:
                continue
            out["types"].append({
                "file": rel, "name": nm, "kind": SQL_TYPE_DECLS[t],
                "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
            })
            if t == "create_table":
                sql_columns(node, src, nm, out, rel, "column")
            elif t == "create_type":
                sql_columns(node, src, nm, out, rel, "type_attribute")
                for block in node.children:
                    if block.type != "enum_elements":
                        continue
                    for lit in block.children:
                        if lit.type != "literal":
                            continue
                        out["fields"].append({
                            "file": rel, "name": text_of(lit, src), "owner": nm,
                            "type": None, "kind": "enum_label",
                            "line": lit.start_point[0] + 1,
                        })

        elif t in SQL_CALLABLE_DECLS:
            nm = sql_obj_name(node, src)
            if nm:
                args = next((c for c in node.children if c.type == "function_arguments"), None)
                out["methods"].append({
                    "file": rel, "name": nm, "owner": None,
                    "params": " ".join((text_of(args, src) or "()").strip("()").split()),
                    "kind": SQL_CALLABLE_DECLS[t],
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t == "alter_table":
            owner = sql_obj_name(node, src)
            for ac in node.children:
                if ac.type != "add_column":
                    continue
                for cd in ac.children:
                    if cd.type != "column_definition":
                        continue
                    nm = next((c for c in cd.children if c.type == "identifier"), None)
                    if nm is not None:
                        out["fields"].append({
                            "file": rel, "name": text_of(nm, src), "owner": owner,
                            "type": None, "kind": "added_column",
                            "line": cd.start_point[0] + 1,
                        })


# ── C / C++ ──────────────────────────────────────────────────────────────────
#
# One language, two grammars: `.c` is parsed with tree-sitter-c and everything else with
# tree-sitter-cpp, because C++ is not a superset of C in either grammar and each errors on the
# other's idioms. A `.h` is ambiguous by design — it is whichever of the two its project
# writes — so it is parsed with C++ and re-parsed with C when C++ errors, keeping the cleaner
# parse. Measured, not assumed: on leveldb's `.cc`/`.h` the C grammar errors on 122 of 132
# files and the C++ grammar on 33; on curl's `.c` the numbers reverse.
#
# Taxonomy, fixed before measuring:
#
#   types   — named type-introducing declarations WITH a definition: `struct`, `union`,
#             `enum` and `class` carrying a body, the name a `typedef` introduces, and C++'s
#             `using X = ...`. A bodyless forward declaration (`struct X;`) introduces an
#             incomplete type and is excluded — it is nearly always followed by the real
#             definition, and counting both would double one declaration. Anonymous
#             struct/union/enum have no name to match on. A `namespace` is a scope, not a type.
#   methods — named functions: a definition (with a body) AND a prototype (without one).
#             A header prototype and its `.c` definition are different (file, name) keys and
#             both count — a C library's API is declared in its header, and a graph that only
#             indexes definitions cannot answer "what does this header expose". C++ member
#             functions, constructors, destructors and operators are here too.
#             Excluded: lambdas (unnamed) and function-POINTER members, which are fields.
#   fields  — members of a struct/union/class, and enumerators.
#   constants — object-like `#define`. A function-like `#define` is a method: it is invoked
#             with an argument list and is how C spells an inline function.
#
# Deliberately excluded: file-scope variables (C gives no way to separate a constant from
# mutable state, and `static int counter;` is not a constant); `using namespace`; friend
# declarations; and template parameters.

C_TYPE_SPECIFIERS = {
    "struct_specifier": "struct",
    "union_specifier": "union",
    "enum_specifier": "enum",
    "class_specifier": "class",
}

C_DECLARATOR_CHAIN = {"pointer_declarator", "array_declarator", "reference_declarator",
                      "parenthesized_declarator", "init_declarator", "attributed_declarator"}

C_NAME_NODES = {"identifier", "field_identifier", "type_identifier", "destructor_name",
                "operator_name", "qualified_identifier"}


def c_declarator_name(node, src):
    """Innermost name of a declarator chain: `*(*fp)(int)` -> `fp`, `Foo::method` -> `method`."""
    cur = node
    seen = 0
    while cur is not None and seen < 24:
        seen += 1
        if cur.type in C_NAME_NODES:
            if cur.type == "qualified_identifier":
                inner = cur.child_by_field_name("name")
                return c_declarator_name(inner, src) if inner is not None else text_of(cur, src)
            return text_of(cur, src)
        nxt = cur.child_by_field_name("declarator")
        if nxt is None:
            nxt = next((c for c in cur.named_children
                        if c.type in C_DECLARATOR_CHAIN or c.type in C_NAME_NODES
                        or c.type == "function_declarator"), None)
        cur = nxt
    return None


def c_function_declarator(node):
    """The `function_declarator` a declaration/field_declaration wraps, if it is a function
    rather than a variable. A function POINTER member (`int (*cb)(void)`) wraps its
    function_declarator inside a parenthesized_declarator, which is what makes it a field."""
    cur = node.child_by_field_name("declarator")
    if cur is None:
        cur = next((c for c in node.named_children
                    if c.type in C_DECLARATOR_CHAIN or c.type == "function_declarator"), None)
    seen = 0
    while cur is not None and seen < 24:
        seen += 1
        if cur.type == "function_declarator":
            inner = cur.child_by_field_name("declarator")
            if inner is not None and inner.type == "parenthesized_declarator":
                return None
            return cur
        if cur.type == "parenthesized_declarator":
            return None
        cur = cur.child_by_field_name("declarator")
    return None


def c_enclosing_type(node, src):
    cur = node.parent
    while cur is not None:
        if cur.type in C_TYPE_SPECIFIERS:
            n = cur.child_by_field_name("name")
            return text_of(n, src) if n is not None else "<anonymous>"
        cur = cur.parent
    return None


def c_params(fn_decl, src):
    p = fn_decl.child_by_field_name("parameters") if fn_decl is not None else None
    return " ".join((text_of(p, src) or "()").strip("()").split())


def collect_c(root, src, out, rel):
    stack = [root]
    while stack:
        node = stack.pop()
        for c in node.children:
            stack.append(c)
        t = node.type

        if t in C_TYPE_SPECIFIERS:
            body = node.child_by_field_name("body")
            n = node.child_by_field_name("name")
            if body is None or n is None:
                continue  # forward declaration or anonymous
            out["types"].append({
                "file": rel, "name": text_of(n, src), "kind": C_TYPE_SPECIFIERS[t],
                "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
            })

        elif t == "type_definition":
            for d in node.children_by_field_name("declarator"):
                nm = c_declarator_name(d, src)
                if nm:
                    out["types"].append({
                        "file": rel, "name": nm, "kind": "typedef",
                        "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                    })

        elif t == "alias_declaration":
            n = node.child_by_field_name("name")
            if n is not None:
                out["types"].append({
                    "file": rel, "name": text_of(n, src), "kind": "alias",
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t == "function_definition":
            fn = c_function_declarator(node)
            nm = c_declarator_name(fn, src) if fn is not None else None
            if nm:
                out["methods"].append({
                    "file": rel, "name": nm, "owner": c_enclosing_type(node, src),
                    "params": c_params(fn, src), "kind": "function_definition",
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })

        elif t in ("declaration", "field_declaration"):
            fn = c_function_declarator(node)
            if fn is not None:
                nm = c_declarator_name(fn, src)
                if nm:
                    out["methods"].append({
                        "file": rel, "name": nm, "owner": c_enclosing_type(node, src),
                        "params": c_params(fn, src), "kind": "function_declaration",
                        "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                    })
                continue
            if t != "field_declaration":
                continue  # a file-scope variable is not a declaration under this taxonomy
            for d in node.children_by_field_name("declarator"):
                nm = c_declarator_name(d, src)
                if nm:
                    out["fields"].append({
                        "file": rel, "name": nm, "owner": c_enclosing_type(node, src),
                        "type": text_of(node.child_by_field_name("type"), src),
                        "kind": "member", "line": node.start_point[0] + 1,
                    })

        elif t == "enumerator":
            n = node.child_by_field_name("name")
            if n is not None:
                out["fields"].append({
                    "file": rel, "name": text_of(n, src), "owner": c_enclosing_type(node, src),
                    "type": None, "kind": "enumerator", "line": node.start_point[0] + 1,
                })

        elif t == "preproc_def":
            n = node.child_by_field_name("name")
            if n is not None:
                out["constants"].append({
                    "file": rel, "name": text_of(n, src), "kind": "macro",
                    "line": node.start_point[0] + 1,
                })

        elif t == "preproc_function_def":
            n = node.child_by_field_name("name")
            if n is not None:
                params = node.child_by_field_name("parameters")
                out["methods"].append({
                    "file": rel, "name": text_of(n, src), "owner": None,
                    "params": " ".join((text_of(params, src) or "()").strip("()").split()),
                    "kind": "function_macro",
                    "line": node.start_point[0] + 1, "end_line": node.end_point[0] + 1,
                })


LANGS = {
    "java": {"exts": (".java",), "collect": collect_java, "skip": SKIP_JAVA},
    "cpp": {"exts": (".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"),
            "collect": collect_c,
            "skip": SKIP_JAVA | {"deps", "third_party", "thirdparty", "cmake-build-debug", ".deps"}},
    "sql": {"exts": (".sql",), "collect": collect_sql,
            "skip": SKIP_JAVA | {"dist", "coverage", "__pycache__"}},
    "csharp": {"exts": (".cs",), "collect": collect_csharp,
               "skip": SKIP_JAVA | {"bin", "obj", "packages", "artifacts"}},
    "python": {"exts": (".py", ".pyi"), "collect": collect_python,
               "skip": SKIP_JAVA | {"__pycache__", ".tox", ".venv", "venv", "site-packages"}},
    "typescript": {"exts": (".ts", ".tsx", ".mts", ".cts"), "collect": collect_typescript,
                   "skip": SKIP_TS},
    "javascript": {"exts": (".js", ".jsx", ".mjs", ".cjs"), "collect": collect_javascript,
                   "skip": SKIP_TS},
}


def walk_files(root, exts, skip):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for f in filenames:
            if f.endswith(exts):
                yield os.path.join(dirpath, f)


def parser_for(lang, path):
    if lang == "java":
        import tree_sitter_java
        return Parser(Language(tree_sitter_java.language()))
    if lang == "csharp":
        import tree_sitter_c_sharp as tcs
        return Parser(Language(tcs.language()))
    if lang == "python":
        import tree_sitter_python as tpy
        return Parser(Language(tpy.language()))
    if lang == "sql":
        import tree_sitter_sql as tssql
        return Parser(Language(tssql.language()))
    if lang == "cpp":
        import tree_sitter_c as tsc
        import tree_sitter_cpp as tscpp
        fn = tsc.language if path.endswith(".c") else tscpp.language
        return Parser(Language(fn()))
    if lang == "javascript":
        # One grammar for all four extensions: tree-sitter-javascript parses JSX natively,
        # unlike tree-sitter-typescript which needs a separate TSX language.
        import tree_sitter_javascript as tjs
        return Parser(Language(tjs.language()))
    import tree_sitter_typescript as tst
    fn = tst.language_tsx if path.endswith(".tsx") else tst.language_typescript
    return Parser(Language(fn()))


# A tree-sitter grammar is a compiled artefact whose node types change between releases, so the
# same repository yields a different truth set on a different grammar version. Every published
# figure this referee produced must carry the runtime and the exact grammar packages that
# produced it, or a reader cannot tell whether a disagreement is their toolchain or our
# extraction.
_GRAMMAR_PKGS = {
    "java": ("tree-sitter-java",), "csharp": ("tree-sitter-c-sharp",),
    "python": ("tree-sitter-python",), "sql": ("tree-sitter-sql",),
    "cpp": ("tree-sitter-c", "tree-sitter-cpp"), "javascript": ("tree-sitter-javascript",),
    "typescript": ("tree-sitter-typescript",),
}


def referee_version(lang):
    from importlib.metadata import PackageNotFoundError, version
    parts = []
    for pkg in ("tree-sitter",) + _GRAMMAR_PKGS.get(lang, ()):
        try:
            parts.append(f"{pkg} {version(pkg)}")
        except PackageNotFoundError:
            parts.append(f"{pkg} unknown")
    return " / ".join(parts)


def main():
    repo = sys.argv[1]
    out_path = None
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]
    lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "java"
    cfg = LANGS[lang]

    # .tsx needs the JSX-aware grammar; parsing it with the plain TypeScript language
    # produces ERROR nodes over every JSX element and silently loses what is inside them.
    parsers = {}

    out = {"repo": repo, "lang": lang, "referee": f"tree-sitter-{lang}",
           "referee_version": referee_version(lang), "files": 0, "parse_errors": 0,
           "total_bytes": 0, "error_bytes": 0, "error_files": [],
           "types": [], "methods": [], "fields": [], "constants": []}

    for path in walk_files(repo, cfg["exts"], cfg["skip"]):
        key = ".tsx" if (lang == "typescript" and path.endswith(".tsx")) else lang
        if lang == "cpp":
            key = ".c" if path.endswith(".c") else "cpp"
        if key not in parsers:
            parsers[key] = parser_for(lang, path)
        with open(path, "rb") as fh:
            src = fh.read()
        tree = parsers[key].parse(src)
        # A `.h` is whichever language its project writes. Parse it as C++ and re-parse as C
        # when C++ errors, keeping the cleaner tree — the same degraded-parse ladder the
        # JavaScript path uses for Flow.
        if lang == "cpp" and path.endswith(".h") and tree.root_node.has_error:
            if ".c" not in parsers:
                parsers[".c"] = parser_for(lang, "x.c")
            alt = parsers[".c"].parse(src)
            if not alt.root_node.has_error:
                tree = alt
        out["total_bytes"] += len(src)
        if tree.root_node.has_error:
            out["parse_errors"] += 1
            out["error_bytes"] += len(src)
            # Which files the referee gives up on is the first question to ask of any new
            # language: where the referee and the extractor fail on the same input, the
            # residual is unmeasurable and defects hide there.
            out["error_files"].append(os.path.relpath(path, repo))
        out["files"] += 1
        cfg["collect"](tree.root_node, src, out, os.path.relpath(path, repo))

    kinds = {}
    for plane in ("types", "methods", "fields", "constants"):
        for item in out[plane]:
            k = item.get("kind")
            if k:
                kinds[f"{plane}:{k}"] = kinds.get(f"{plane}:{k}", 0) + 1

    out["counts"] = {
        "files": out["files"], "types": len(out["types"]),
        "methods": len(out["methods"]), "fields": len(out["fields"]),
        "constants": len(out["constants"]),
        "parse_errors": out["parse_errors"],
        "error_byte_pct": (round(100.0 * out["error_bytes"] / out["total_bytes"], 2)
                           if out["total_bytes"] else 0.0),
    }
    out["kind_breakdown"] = dict(sorted(kinds.items()))
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(out, fh)
    print(json.dumps({**out["counts"], "kinds": out["kind_breakdown"]}, indent=2))


if __name__ == "__main__":
    main()
