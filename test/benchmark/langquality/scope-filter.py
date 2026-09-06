#!/usr/bin/env python3
"""Filter a referee-truth or system-dump JSON to files under a path prefix.

The lang-quality oracles walk the whole repo, but a fair "graph quality" headline
scopes to the library package (src/flask, httpx/, ...) — docs/conf.py, setup.py
and examples/ are module-level-assignment noise the CPython referee labels as
declarations, and test/ is nested-handler-heavy (see KNOWN-BIASES). This produces
a scoped copy that the UNMODIFIED edge-compare-generic.py / score-decls.py then
consume, so the validated scorers are reused verbatim.

  python3 scope-filter.py --in truth.json --prefix src/flask --out truth.lib.json
"""
import argparse
import json

# every list-of-{file,...} key any referee or dump emits
FILE_LIST_KEYS = ["imports", "inheritance", "calls", "types", "methods",
                  "fields", "constants", "decls", "nodes", "parse_errors"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--prefix", required=True,
                    help="keep only entries whose file starts with this (comma-separated for "
                         "multiple; empty string keeps all paths)")
    ap.add_argument("--exclude", default="",
                    help="drop entries whose file contains any of these substrings "
                         "(comma-separated) — e.g. '_test.go,/examples/' for Go, whose tests are "
                         "co-located *_test.go files rather than a tests/ dir")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    prefixes = tuple(p for p in a.prefix.split(",") if p)
    excludes = tuple(e for e in a.exclude.split(",") if e)
    d = json.load(open(a.inp))

    def keep(f):
        if not isinstance(f, str):
            return False
        if prefixes and not f.startswith(prefixes):
            return False
        return not any(e in f for e in excludes)

    for k in FILE_LIST_KEYS:
        v = d.get(k)
        if isinstance(v, list):
            d[k] = [x for x in v if (keep(x) if isinstance(x, str) else keep(x.get("file", "")))]
    json.dump(d, open(a.out, "w"))


if __name__ == "__main__":
    main()
