#!/usr/bin/env bash
# C / C++ / Swift DECLARATIONS head-to-head. These languages have no build-free independent EDGE
# oracle, so only declarations are scored. Oracle: Universal Ctags (C/C++), `swiftc -dump-parse`
# (Swift). koragraph vs every competitor that indexes the language. Appends decls_pooled rows to
# results/summary.tsv. Same env config as master-h2h.sh.
set -uo pipefail
BENCH="$(cd "$(dirname "$0")/.." && pwd)"
KG_REPO="${KG_REPO:-$(cd "$BENCH/../.." && pwd)}"
CORPUS="${KG_CORPUS:-$HOME/.koragraph-bench/corpus}"
HB="$BENCH/langquality"; SCR="$BENCH/scripts"
OUT="${KG_OUT:-$BENCH/results}"; DBD="${KG_DB_DIR:-/tmp/kg-h2h}"
export NODE_PATH="$KG_REPO/node_modules" LLM_EXTRACTION=off KG_OUT="$OUT"
mkdir -p "$OUT" "$DBD"
TSV="$OUT/summary.tsv"
run_to(){ local s=$1; shift; ("$@") & local p=$!; (sleep "$s"; kill -9 "$p" 2>/dev/null) & local w=$!; wait "$p" 2>/dev/null; local rc=$?; kill -9 "$w" 2>/dev/null; return $rc; }

# lang|repo|lib|reftype(ctags|swift)
REPOS=(
  "c|jansson|src|ctags" "c|json-c||ctags" "c|zlib||ctags"
  "cpp|fmt|include|ctags" "cpp|json|include|ctags" "cpp|spdlog|include|ctags"
  "swift|SwiftyJSON|Source|swift" "swift|swift-argument-parser|Sources|swift" "swift|swift-snapshot-testing|Sources|swift"
)
for row in "${REPOS[@]}"; do
  IFS='|' read -r LANG NAME LIB REF <<< "$row"
  REPO="$CORPUS/$NAME"
  grep -q "^$LANG	$NAME	decls_pooled" "$TSV" 2>/dev/null && { echo "[$LANG/$NAME] scored, skip"; continue; }
  [ -d "$REPO/.git" ] || { echo "[$LANG/$NAME] NO REPO"; continue; }
  echo "===== $LANG / $NAME ====="
  DB="$DBD/$NAME.db"
  [ -f "$DB" ] || run_to 300 env KORAGRAPH_DB="$DB" node "$KG_REPO/bin/koragraph.js" ingest "$REPO" >/dev/null 2>&1
  [ -f "$DB" ] || { echo "  ingest fail"; continue; }
  if [ "$REF" = swift ]; then run_to 300 python3 "$SCR/ast-referee-swiftparse.py" "$REPO" --out "$OUT/$NAME.decl-truth.json" >/dev/null 2>&1
  else run_to 300 python3 "$SCR/ast-referee-ctags.py" "$REPO" --out "$OUT/$NAME.decl-truth.json" >/dev/null 2>&1; fi
  node "$HB/dump-koragraph.js" --db "$DB" --out-edges "$OUT/$NAME.kora-edges.json" --out-decls "$OUT/$NAME.kora-decls.json" >/dev/null 2>&1
  for s in codegraph gitnexus graphify; do run_to 420 bash "$BENCH/run/run-competitor.sh" "$s" "$NAME" "$REPO" "$LIB" "$LANG" >/dev/null 2>&1 || echo "  $s failed"; done
  flt(){ python3 "$HB/scope-filter.py" --in "$1" --prefix "$LIB" --exclude "" --out "$2" >/dev/null 2>&1; }
  flt "$OUT/$NAME.decl-truth.json" "$OUT/$NAME.decl-truth.lib.json"
  flt "$OUT/$NAME.kora-decls.json" "$OUT/$NAME.kora-decls.lib.json"
  DSYS=(--system koragraph="$OUT/$NAME.kora-decls.lib.json")
  for s in codegraph gitnexus graphify; do [ -f "$OUT/$NAME.$s-decls.lib.json" ] && DSYS+=(--system $s="$OUT/$NAME.$s-decls.lib.json"); done
  python3 "$HB/score-decls.py" --truth "$OUT/$NAME.decl-truth.lib.json" "${DSYS[@]}" --out "$OUT/$NAME.alldecl.json" >/dev/null 2>&1
  python3 - "$NAME" "$LANG" "$OUT/$NAME.alldecl.json" "$TSV" <<'PY'
import json,sys
name,lang,dj,tsv=sys.argv[1:5]
try:
    d=json.load(open(dj)).get("systems",{})
    r=[lang,name,"decls_pooled"]
    for s in ("koragraph","codegraph","gitnexus","graphify"):
        v=d.get(s,{}).get("pooled",{}); r+=[v.get("recall",""),v.get("precision","")]
    open(tsv,"a").write("\t".join(str(x) for x in r)+"\n")
except Exception as e: print("  score fail",e)
PY
  echo "  scored."
done
echo "===== CC-SWIFT DECLS DONE ====="
