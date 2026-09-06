#!/usr/bin/env python3
"""Dump a GitNexus index into the SAME node JSON shape `ast-dump.js` emits for Koragraph.

WHY THIS SHAPE, AND WHY NOTHING IN THE COMPARER CHANGES
-------------------------------------------------------
`ast-layer-compare.py` takes `--kora <nodes.json>` and grades it against a referee. Emitting
GitNexus in that same shape means GitNexus is scored by the IDENTICAL matcher, the IDENTICAL
plane definitions and the IDENTICAL truth file, with **zero** edits to the comparer — so every
published Graphify figure reproduces byte-for-byte, and that is the adversarial check
(`--graphify` runs are untouched because this script never touches them).

Run it twice against one truth file — once with Koragraph's dump, once with this one — and the
two `kora` columns are a like-for-like head-to-head.

TAXONOMY MAP — GitNexus label -> Koragraph node_type
-----------------------------------------------------
GitNexus labels its symbol nodes with the declaration kind. The map below is the ONLY
interpretive step, and it is deliberately generous to GitNexus: every label that plausibly
denotes a declaration is counted, so a miss is a real miss and not a taxonomy artifact.

Container / derived nodes are EXCLUDED, which is the symmetry rule the benchmark already
applies to both other systems ("container nodes are not declarations"):
  File, Folder, Community, Process, Section  -- these are GitNexus's clustering and
  execution-flow layer, not declarations, and counting them would inflate its precision
  denominator with things no referee models.

Usage:
  ast-dump-gitnexus.py --repo <gitnexus repo name> --out <nodes.json>
                       [--gitnexus <path to gitnexus bin>] [--labels]
"""
import argparse
import json
import os
import subprocess
import sys

# GitNexus label -> Koragraph node_type. Types plane accepts CLASS/ENTITY/INTERFACE
# (ast-layer-compare.py:607); methods METHOD; fields FIELD; constants CONSTANT.
LABEL_MAP = {
    # types
    "Class": "CLASS", "Struct": "CLASS", "Enum": "CLASS", "Record": "CLASS",
    "TypeAlias": "CLASS", "Type": "CLASS", "Trait": "CLASS", "Protocol": "INTERFACE",
    "Interface": "INTERFACE",
    # `typedef` is the LARGEST type kind in the C/C++ referee's own taxonomy (3,142 of 4,384
    # on this corpus) and `union` is one of its kinds too. Leaving them unmapped scored
    # GitNexus 64.6% on C++ types for declarations it had actually extracted.
    "Typedef": "CLASS", "Union": "CLASS",
    # methods
    "Function": "METHOD", "Method": "METHOD", "Constructor": "METHOD",
    # fields (instance attributes)
    "Property": "FIELD", "Field": "FIELD",
    # constants — GitNexus's `Variable` is module-scope assignments (project,
    # __version__, ...), its constants plane; it keeps `Property` separate for
    # instance attributes. Binning Variable to FIELD double-penalised it exactly
    # as it did CodeGraph (0% constants, diluted field precision) — adversarial
    # audit parity fix, 2026-08-28.
    "Variable": "CONSTANT", "Const": "CONSTANT", "Constant": "CONSTANT",
    # Universal Ctags reports EVERY C/C++ constant as kind `macro` (9,198 of 9,198 here), and
    # GitNexus emits 12,335 `Macro` nodes. Leaving this unmapped scored them 0.1% on a plane
    # they populate — the single worst distortion this map has produced.
    "Macro": "CONSTANT",
}

# Deliberately NOT mapped: `Template`, `Namespace`, `Impl`, `Module`. None is a kind any
# referee in this benchmark emits, so mapping them could only add unmatched nodes and depress
# GitNexus's precision. Excluding them is the generous reading, and `unmapped_labels` still
# reports them so the choice stays visible.

# Not declarations. GitNexus's clustering/flow layer plus file-system nodes.
CONTAINER_LABELS = {"File", "Folder", "Community", "Process", "Section", "Repository"}


# GitNexus's `cypher` tool truncates its markdown response on large result sets: the body is cut
# mid-row and the JSON envelope never closes, so the output is unparseable rather than merely
# short. Measured 2026-08-18 on grpc-go, etcd and hugo. A truncated page would read as a GitNexus
# recall miss it did not actually have, so every query is paged and the pages are re-joined.
PAGE = 400


def cypher(gn_bin, repo, query):
    p = subprocess.run([gn_bin, "cypher", query, "--repo", repo],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"FATAL: gitnexus cypher failed for {repo}:\n{p.stderr[:800]}")
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise SystemExit(
            "FATAL: non-JSON from gitnexus cypher (their output truncates on large result "
            f"sets — page this query):\n{p.stdout[:600]}")
    if "error" in d:
        raise SystemExit(f"FATAL: cypher error: {d['error'][:800]}")
    return d


def cypher_all(gn_bin, repo, query_body, page=PAGE):
    """Run `query_body` paged with SKIP/LIMIT and return the concatenated rows."""
    out, skip = [], 0
    while True:
        d = cypher(gn_bin, repo, f"{query_body} SKIP {skip} LIMIT {page}")
        got = rows(d)
        out.extend(got)
        if len(got) < page:
            return out
        skip += page


def resolve_repo(gn_bin, want):
    """Map a checkout directory name to the name GitNexus registered it under.

    `gitnexus list` prints `<name>` then an indented `Path: <abs path>`. Match on the path's
    final component; fall back to the name itself when it is already registered.
    """
    p = subprocess.run([gn_bin, "list"], capture_output=True, text=True)
    if p.returncode != 0:
        return want
    name, by_dir, names = None, {}, set()
    for line in p.stdout.splitlines():
        s = line.strip()
        if s.startswith("Path:"):
            if name:
                by_dir[os.path.basename(s.split("Path:", 1)[1].strip().rstrip("/"))] = name
        elif s and not s.startswith(("Indexed:", "Commit:", "Stats:", "Clusters:", "Processes:")) \
                and ":" not in s and not s.startswith("Indexed Repositories"):
            name = s
            names.add(s)
    if want in names:
        return want
    if want in by_dir:
        return by_dir[want]
    raise SystemExit(f"FATAL: no indexed GitNexus repo for checkout '{want}'. "
                     f"Registered: {sorted(names)}")


def rows(d):
    """Parse the markdown table GitNexus's cypher tool returns into dicts.

    A cell containing a literal '|' would corrupt this. The parser detects that case (column
    count mismatch) and fails loudly rather than silently dropping or mis-binding a row —
    a dropped declaration would read as a GitNexus recall miss that it did not actually have.
    """
    lines = [l for l in (d.get("markdown") or "").split("\n") if l.strip()]
    if len(lines) < 2:
        return []
    header = [c.strip() for c in lines[0].strip().strip("|").split("|")]
    out = []
    for ln in lines[2:]:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) != len(header):
            raise SystemExit(
                f"FATAL: cypher row has {len(cells)} cells, header has {len(header)}. "
                f"A value probably contains '|'. Refusing to guess.\nrow: {ln[:300]}")
        out.append(dict(zip(header, cells)))
    expected = d.get("row_count")
    if expected is not None and len(out) != expected:
        raise SystemExit(f"FATAL: parsed {len(out)} rows but cypher reported row_count={expected}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True,
                    help="checkout directory name; resolved to the name GitNexus registered")
    ap.add_argument("--out", required=True)
    ap.add_argument("--gitnexus", default=os.environ.get("GITNEXUS_BIN", "gitnexus"))
    ap.add_argument("--labels", action="store_true", help="print the label census and exit")
    a = ap.parse_args()

    # GitNexus registers a repository under ITS OWN notion of the project name, which is not
    # always the checkout directory: `.golden-checkouts/nlohmann-json` registers as `json`.
    # Resolve by path so the caller can keep using directory names.
    a.repo = resolve_repo(a.gitnexus, a.repo)

    census = rows(cypher(a.gitnexus, a.repo,
                         "MATCH (n) RETURN labels(n) AS label, count(*) AS c ORDER BY c DESC"))
    counts = {r["label"]: int(r["c"]) for r in census if r.get("label")}
    if a.labels:
        print(json.dumps(counts, indent=2))
        return

    unmapped = sorted(set(counts) - set(LABEL_MAP) - CONTAINER_LABELS)
    nodes = []
    for label, ntype in LABEL_MAP.items():
        if label not in counts:
            continue
        # GitNexus returns rows only as a '|'-delimited markdown table, so a C++ operator
        # overload whose name literally contains '|' (operator|, operator||, operator|=) splits
        # into extra cells and rows() aborts. Escape '|' in the name inside the query and restore
        # it after parsing — the other columns (path, line numbers) never contain '|'.
        got = cypher_all(a.gitnexus, a.repo,
                         f"MATCH (n:`{label}`) RETURN replace(n.name, '|', '##PIPE##') AS name, "
                         f"n.filePath AS file, n.startLine AS line, n.endLine AS end_line")
        if len(got) != counts[label]:
            raise SystemExit(
                f"FATAL: paged {len(got)} {label} rows but the census says {counts[label]}. "
                f"Refusing to score GitNexus on an incomplete dump.")
        for r in got:
            name, f = r.get("name"), r.get("file")
            if name:
                name = name.replace("##PIPE##", "|")
            if not name or not f:
                continue

            def _int(v):
                try:
                    return int(v) if v not in (None, "", "null") else None
                except ValueError:
                    return None

            nodes.append({
                "file": f, "name": name, "line": _int(r.get("line")),
                "end_line": _int(r.get("end_line")),
                "node_type": ntype, "kind": label.lower(),
                # Raw GitNexus label, kept so a future taxonomy correction can be re-scored
                # from the dump instead of re-indexing every repository. Not having this is
                # what made the Macro/Typedef correction cost a full re-index.
                "gn_label": label,
                # Koragraph telemetry the comparer sums unconditionally
                # (ast-layer-compare.py:739-740). GitNexus does emit CALLS edges; they are
                # simply not collected here because this dump scores the DECLARATION planes.
                # The `calls` telemetry line must therefore be read as "not measured for
                # GitNexus", never as GitNexus finding zero calls.
                "calls": 0, "calls_with_receiver": 0,
            })

    out = {
        "system": "gitnexus",
        "repo": a.repo,
        "nodes": nodes,
        "label_census": counts,
        # Surfaced, never silently dropped: a label we did not map is a potential uncounted
        # declaration plane for GitNexus, i.e. a way this harness could understate them.
        "unmapped_labels": {l: counts[l] for l in unmapped},
        "container_labels_excluded": {l: counts[l] for l in CONTAINER_LABELS if l in counts},
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w"))
    sys.stderr.write(
        f"[gitnexus-dump:{a.repo}] {len(nodes)} declaration nodes "
        f"({sum(1 for n in nodes if n['node_type']=='METHOD')} methods, "
        f"{sum(1 for n in nodes if n['node_type'] in ('CLASS','INTERFACE'))} types, "
        f"{sum(1 for n in nodes if n['node_type']=='FIELD')} fields, "
        f"{sum(1 for n in nodes if n['node_type']=='CONSTANT')} constants) -> {a.out}\n")
    if unmapped:
        sys.stderr.write(f"[gitnexus-dump:{a.repo}] UNMAPPED labels (not counted for them): "
                         f"{out['unmapped_labels']}\n")


if __name__ == "__main__":
    main()
