#!/usr/bin/env python3
"""Deterministic call tracer for koragraph runtime-observed edges.

Runs a Python command (a test suite, a script, or a module) IN-PROCESS with sys.setprofile
installed, and records the SET of caller -> callee function-call edges that actually happened.
setprofile is exhaustive, not sampled, so for a deterministic test run the recorded set is
deterministic — the property a runtime-edge plane needs and that a CPU profiler cannot give.

Only calls whose BOTH ends live inside the repository root are recorded; stdlib and site-packages
frames are dropped, so the output maps cleanly onto the declarations koragraph already indexed.

Usage:  python tracer.py <out.json> <repo_root> -- <command...>
  command forms:  python <file.py> [args] | python -m <module> [args] | pytest [args] | <file.py>
Writes JSON: {"edges": [{"caller":{...},"callee":{...}}, ...], "calls": <observed edge count>}.
The command's own exit status is written to the JSON, never propagated, so a failing test suite
still yields the edges it exercised before failing.
"""
import json
import os
import runpy
import sys


def _norm(root, filename):
    # Frozen and synthetic code objects (`<frozen importlib._bootstrap>`, `<string>`, `<stdin>`)
    # carry a name in angle brackets, not a path — drop them before any filesystem resolution, or
    # they resolve against the cwd and masquerade as repo files when the cwd IS the repo root.
    if not filename or filename.startswith("<"):
        return None
    try:
        real = os.path.realpath(filename)
    except (ValueError, OSError):
        return None
    # Genuinely under the repo root — not stdlib, not site-packages, not another checkout.
    if real != root and not real.startswith(root + os.sep):
        return None
    rel = os.path.relpath(real, root)
    if rel.startswith("..") or os.path.isabs(rel):
        return None
    return rel.replace(os.sep, "/")


    # Comprehensions and lambdas run in their own frames but are lexically part of the function that
    # contains them, so a `[f(x) for x in xs]` shows up as `owner -> <listcomp> -> f`. Attributing the
    # call to the real enclosing function recovers the `owner -> f` edge the graph actually models. A
    # module top-level frame is NOT a declaration, so a call made from module scope is left unattributed.
SYNTHETIC = frozenset({"<genexpr>", "<listcomp>", "<dictcomp>", "<setcomp>", "<lambda>"})


def run(out_path, repo_root, command):
    root = os.path.realpath(repo_root)
    edges = {}  # (caller_tuple, callee_tuple) -> None, a set that also dedupes

    def real_caller(frame):
        f = frame.f_back
        # Step over lexically-inner comprehension/lambda frames to the enclosing declaration; do NOT
        # step over an external or module frame — that would misattribute a call to a distant ancestor.
        while f is not None and f.f_code.co_name in SYNTHETIC:
            f = f.f_back
        if f is None:
            return None
        code = f.f_code
        if code.co_name == "<module>":
            return None
        file = _norm(root, code.co_filename)
        if file is None:
            return None
        return (file, code.co_name, code.co_firstlineno)

    def profile(frame, event, arg):
        if event != "call":
            return
        callee_code = frame.f_code
        if callee_code.co_name in SYNTHETIC or callee_code.co_name == "<module>":
            return  # a call INTO a comprehension or a module body is not a declaration call
        callee_file = _norm(root, callee_code.co_filename)
        if callee_file is None:
            return
        caller = real_caller(frame)
        if caller is None:
            return
        key = (caller, (callee_file, callee_code.co_name, callee_code.co_firstlineno))
        edges[key] = None

    exit_status = 0
    error = None
    sys.setprofile(profile)
    try:
        _dispatch(command, root)
    except SystemExit as e:
        exit_status = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException as e:  # a failing test run still yields the edges it reached
        sys.setprofile(None)
        exit_status = 1
        import traceback
        error = "".join(traceback.format_exception(type(e), e, e.__traceback__))[-2000:]
    finally:
        sys.setprofile(None)

    out = {
        "edges": [
            {
                "caller": {"file": c[0], "name": c[1], "line": c[2]},
                "callee": {"file": d[0], "name": d[1], "line": d[2]},
            }
            for (c, d) in edges
        ],
        "calls": len(edges),
        "exit_status": exit_status,
        "error": error,
    }
    with open(out_path, "w") as fh:
        json.dump(out, fh)


def _run_script(script, args):
    # `python run.py` prepends the script's own directory to sys.path; runpy.run_path does not, so
    # a sibling import (`from calc import ...`) fails unless we replicate it.
    sys.path.insert(0, os.path.dirname(os.path.realpath(script)) or ".")
    sys.argv = [script] + list(args)
    runpy.run_path(script, run_name="__main__")


def _dispatch(command, root):
    if not command:
        raise SystemExit(0)
    # `python -m mod` and `pytest` resolve imports from the cwd (the repo root we run under).
    if "" not in sys.path and os.getcwd() not in sys.path:
        sys.path.insert(0, "")
    head = command[0]
    if head in ("python", "python3", sys.executable, os.path.basename(sys.executable)):
        rest = command[1:]
        if rest and rest[0] == "-m":
            module = rest[1]
            sys.argv = [module] + rest[2:]
            runpy.run_module(module, run_name="__main__", alter_sys=True)
        elif rest:
            _run_script(rest[0], rest[1:])
        else:
            raise SystemExit(0)
    elif head == "pytest":
        import pytest  # noqa: WPS433 — only imported when actually tracing pytest
        sys.argv = ["pytest"] + command[1:]
        raise SystemExit(pytest.main(command[1:]))
    elif head.endswith(".py"):
        _run_script(head, command[1:])
    else:
        # An unknown runner (a module name, a console script) — best effort as a module.
        sys.argv = list(command)
        runpy.run_module(head, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    argv = sys.argv[1:]
    if len(argv) < 3 or "--" not in argv:
        sys.stderr.write("usage: tracer.py <out.json> <repo_root> -- <command...>\n")
        sys.exit(2)
    sep = argv.index("--")
    out_path, repo_root = argv[0], argv[1]
    run(out_path, repo_root, argv[sep + 1:])
