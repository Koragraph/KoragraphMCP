#!/usr/bin/env python3
"""Dump a GitNexus index's EDGES into the {imports, inheritance, calls} shape the
langquality comparer (edge-compare-generic.py) consumes, so GitNexus is scored
edge-for-edge like koragraph/CodeGraph/Graphify.

GitNexus stores every edge as a single `CodeRelation` relationship whose kind is
the `r.type` property (LadybugDB, not Neo4j — `type(r)`/`:Symbol` don't exist).
Distinct kinds seen: STEP_IN_PROCESS, HAS_METHOD, DEFINES, MEMBER_OF, CALLS,
ACCESSES, CONTAINS, HAS_PROPERTY, IMPORTS, EXTENDS, METHOD_OVERRIDES. The three
that correspond to the comparer's planes:
  imports      IMPORTS               (file = importer, name = imported module)
  inheritance  EXTENDS, IMPLEMENTS   (file = child, child/base names)
  calls        CALLS                 (file = caller, caller/callee names)
METHOD_OVERRIDES/ACCESSES/HAS_* are deliberately excluded — none is an oracle
edge plane (mirrors the CodeGraph references/decorates exclusion).

`cypher` returns a markdown table; the parser and paging match ast-dump-gitnexus.

  edge-dump-gitnexus.py --repo <checkout dir name> --out <edges.json>
                        [--gitnexus <bin>]
"""
import argparse
import json
import os
import subprocess
import sys

PAGE = 400
PLANE_KINDS = {"imports": ["IMPORTS"], "inheritance": ["EXTENDS", "IMPLEMENTS"], "calls": ["CALLS"]}


def cypher(gn_bin, repo, query):
    p = subprocess.run([gn_bin, "cypher", query, "--repo", repo],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"FATAL: gitnexus cypher failed for {repo}:\n{p.stderr[:800]}")
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise SystemExit("FATAL: non-JSON from gitnexus cypher (output truncates on large "
                         "result sets — reduce PAGE).")
    if isinstance(d, dict) and d.get("error"):
        raise SystemExit(f"FATAL: cypher error: {d['error'][:800]}")
    return d


def rows(d):
    # An empty result set comes back as a JSON list ([]) rather than the usual
    # {markdown,row_count} dict — e.g. a WHERE r.type='IMPLEMENTS' with no matches.
    if isinstance(d, list):
        return [x for x in d if isinstance(x, dict)]
    lines = [l for l in (d.get("markdown") or "").split("\n") if l.strip()]
    if len(lines) < 2:
        return []
    header = [c.strip() for c in lines[0].strip().strip("|").split("|")]
    out = []
    for ln in lines[2:]:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) != len(header):
            raise SystemExit(f"FATAL: cypher row has {len(cells)} cells, header {len(header)} "
                             f"— a value probably contains '|'. row: {ln[:300]}")
        out.append(dict(zip(header, cells)))
    expected = d.get("row_count")
    if expected is not None and len(out) != expected:
        raise SystemExit(f"FATAL: parsed {len(out)} rows but row_count={expected}")
    return out


def cypher_all(gn_bin, repo, body):
    out, skip = [], 0
    while True:
        got = rows(cypher(gn_bin, repo, f"{body} SKIP {skip} LIMIT {PAGE}"))
        out.extend(got)
        if len(got) < PAGE:
            break
        skip += PAGE
    return out


def resolve_repo(gn_bin, want):
    p = subprocess.run([gn_bin, "list"], capture_output=True, text=True)
    if p.returncode != 0:
        return want
    name, by_dir, names = None, {}, set()
    for line in p.stdout.splitlines():
        s = line.strip()
        if s.startswith("Path:"):
            if name:
                by_dir[os.path.basename(s.split("Path:", 1)[1].strip().rstrip("/"))] = name
        elif s and ":" not in s and not s.startswith("Indexed Repositories"):
            name = s
            names.add(s)
    if want in names:
        return want
    if want in by_dir:
        return by_dir[want]
    raise SystemExit(f"FATAL: no indexed GitNexus repo for '{want}'. Registered: {sorted(names)}")


def clean(v):
    return None if v in (None, "", "null") else v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gitnexus", default=os.environ.get("GITNEXUS_BIN", "gitnexus"))
    a = ap.parse_args()
    a.repo = resolve_repo(a.gitnexus, a.repo)

    # census of edge kinds so a paged dump can be checked for completeness
    census = {r["t"]: int(r["c"]) for r in rows(cypher(
        a.gitnexus, a.repo,
        "MATCH ()-[r:CodeRelation]->() RETURN DISTINCT r.type AS t, count(*) AS c ORDER BY c DESC"))}

    out = {"imports": [], "inheritance": [], "calls": []}
    for kind in PLANE_KINDS["imports"]:
        for r in cypher_all(a.gitnexus, a.repo,
                            f"MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = '{kind}' "
                            f"RETURN a.filePath AS file, b.name AS name"):
            if clean(r.get("file")) and clean(r.get("name")):
                out["imports"].append({"file": r["file"], "name": r["name"]})
    for kind in PLANE_KINDS["inheritance"]:
        for r in cypher_all(a.gitnexus, a.repo,
                            f"MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = '{kind}' "
                            f"RETURN a.filePath AS file, a.name AS child, b.name AS base"):
            if clean(r.get("file")) and clean(r.get("child")) and clean(r.get("base")):
                out["inheritance"].append({"file": r["file"], "child": r["child"], "base": r["base"]})
    for kind in PLANE_KINDS["calls"]:
        for r in cypher_all(a.gitnexus, a.repo,
                            f"MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = '{kind}' "
                            f"RETURN a.filePath AS file, a.name AS caller, b.name AS callee"):
            if clean(r.get("file")) and clean(r.get("caller")) and clean(r.get("callee")):
                out["calls"].append({"file": r["file"], "caller": r["caller"], "callee": r["callee"]})

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w"))
    sys.stderr.write(
        f"[gitnexus-edge-dump:{a.repo}] {len(out['imports'])} imports, "
        f"{len(out['inheritance'])} inheritance, {len(out['calls'])} calls "
        f"(census IMPORTS={census.get('IMPORTS', 0)} EXTENDS={census.get('EXTENDS', 0)} "
        f"CALLS={census.get('CALLS', 0)}) -> {a.out}\n")


if __name__ == "__main__":
    main()
