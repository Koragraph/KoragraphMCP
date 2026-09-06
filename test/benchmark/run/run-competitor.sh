#!/usr/bin/env bash
# Head-to-head: dump one competitor's graph for one repo, at the same library scope koragraph is
# scored at, into the shared {decls}/{imports,inheritance,calls} JSON shape. Cache hygiene: the
# competitor index is written into the checkout, dumped, then DELETED so a later koragraph ingest
# of the same checkout can't swallow it as source.
#   run-competitor.sh <codegraph|gitnexus|graphify> <name> <repoPath> <libPrefix> <lang>
# Paths are configurable via env (see run/SETUP.md): KG_COMPETITORS, KG_OUT.
set -uo pipefail
SYS=$1; NAME=$2; REPO=$3; LIB=$4; LANG=$5
BENCH="$(cd "$(dirname "$0")/.." && pwd)"
SCR="$BENCH/scripts"; HB="$BENCH/langquality"
OUT="${KG_OUT:-$BENCH/results}"; mkdir -p "$OUT"
COMP="${KG_COMPETITORS:-$HOME/.koragraph-bench/competitors}"
CG="${KG_CODEGRAPH_BIN:-$COMP/codegraph/node_modules/.bin/codegraph}"
GF="${KG_GRAPHIFY_BIN:-$COMP/.venv-graphify/bin/graphify}"
GN_CLI="${KG_GITNEXUS_CLI:-$COMP/gitnexus/node_modules/gitnexus/dist/cli/index.js}"
# GitNexus's dumper shells out to a `gitnexus` executable; ours is `node <cli>`, so wrap it.
GNW="$OUT/.gitnexus-wrapper.sh"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$GN_CLI" > "$GNW"; chmod +x "$GNW"

case "$SYS" in
  codegraph)
    rm -rf "$REPO/.codegraph"
    CODEGRAPH_TELEMETRY=0 "$CG" init --force "$REPO" >/dev/null 2>&1 || { echo "$SYS init FAIL"; exit 1; }
    python3 "$SCR/ast-dump-codegraph.py"  --repo "$REPO" --out "$OUT/$NAME.$SYS-decls.json" 2>/dev/null
    python3 "$SCR/edge-dump-codegraph.py" --repo "$REPO" --out "$OUT/$NAME.$SYS-edges.json" 2>/dev/null
    rm -rf "$REPO/.codegraph" ;;
  gitnexus)
    rm -rf "$REPO/.gitnexus"
    node "$GN_CLI" analyze "$REPO" >/dev/null 2>&1 || { echo "$SYS analyze FAIL"; exit 1; }
    RB=$(basename "$REPO")   # resolve_repo maps the checkout basename -> the registered repo name
    GITNEXUS_BIN="$GNW" python3 "$SCR/ast-dump-gitnexus.py"  --repo "$RB" --out "$OUT/$NAME.$SYS-decls.json" --gitnexus "$GNW" 2>/dev/null
    GITNEXUS_BIN="$GNW" python3 "$SCR/edge-dump-gitnexus.py" --repo "$RB" --out "$OUT/$NAME.$SYS-edges.json" --gitnexus "$GNW" 2>/dev/null
    rm -rf "$REPO/.gitnexus" ;;
  graphify)
    rm -rf "$REPO/graphify-out"
    PYTHONHASHSEED=0 "$GF" update "$REPO" --no-cluster >/dev/null 2>&1 || { echo "$SYS update FAIL"; exit 1; }
    python3 "$SCR/ast-dump-graphify.py"  --graph "$REPO/graphify-out/graph.json" --out "$OUT/$NAME.$SYS-decls.json" 2>/dev/null
    python3 "$SCR/edge-dump-graphify.py" --graph "$REPO/graphify-out/graph.json" --out "$OUT/$NAME.$SYS-edges.json" 2>/dev/null
    rm -rf "$REPO/graphify-out" ;;
  *) echo "unknown system $SYS"; exit 2 ;;
esac

EX=""; [ "$LANG" = go ] && EX="_test.go,/examples/"
python3 "$HB/scope-filter.py" --in "$OUT/$NAME.$SYS-decls.json" --prefix "$LIB" --exclude "$EX" --out "$OUT/$NAME.$SYS-decls.lib.json" 2>/dev/null
python3 "$HB/scope-filter.py" --in "$OUT/$NAME.$SYS-edges.json" --prefix "$LIB" --exclude "$EX" --out "$OUT/$NAME.$SYS-edges.lib.json" 2>/dev/null
echo "$SYS dumped+scoped for $NAME"
