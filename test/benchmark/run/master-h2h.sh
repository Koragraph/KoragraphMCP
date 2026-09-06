#!/usr/bin/env bash
# Full head-to-head across the launch corpus (3 repos/language, core edge-oracle languages):
# koragraph vs CodeGraph / GitNexus / Graphify — one oracle, one scorer, one library scope for
# every system. Emits per-repo {decls,edges} comparison JSON + a consolidated results/summary.tsv.
# Idempotent (skips a repo already in the TSV) and watchdog-guarded (a wedged ingest can't stall it).
#
# Config (env, all optional): KG_REPO (koragraph checkout; default: this repo),
# KG_CORPUS (pinned corpus; default ~/.koragraph-bench/corpus), KG_COMPETITORS, KG_OUT, KG_DB_DIR.
set -uo pipefail
BENCH="$(cd "$(dirname "$0")/.." && pwd)"
KG_REPO="${KG_REPO:-$(cd "$BENCH/../.." && pwd)}"
CORPUS="${KG_CORPUS:-$HOME/.koragraph-bench/corpus}"
HB="$BENCH/langquality"; SCR="$BENCH/scripts"
OUT="${KG_OUT:-$BENCH/results}"; DBD="${KG_DB_DIR:-/tmp/kg-h2h}"
export NODE_PATH="$KG_REPO/node_modules" LLM_EXTRACTION=off KG_OUT="$OUT"
mkdir -p "$OUT" "$DBD"
TSV="$OUT/summary.tsv"
[ -f "$TSV" ] || echo -e "lang\trepo\tplane\tkoragraph_R\tkoragraph_P\tcodegraph_R\tcodegraph_P\tgitnexus_R\tgitnexus_P\tgraphify_R\tgraphify_P" > "$TSV"

run_to(){ local s=$1; shift; ("$@") & local p=$!; (sleep "$s"; kill -9 "$p" 2>/dev/null) & local w=$!; wait "$p" 2>/dev/null; local rc=$?; kill -9 "$w" 2>/dev/null; return $rc; }

# lang|repo|libPrefix — see corpus-manifest.tsv for pinned SHAs/remotes.
REPOS=(
  "python|requests|src/requests" "python|flask|src/flask" "python|httpx|httpx"
  "go|cobra|" "go|viper|" "go|zap|"
  "java|jsoup|src/main/java" "java|commons-lang|src/main/java" "java|gson|gson/src/main/java"
  "php|guzzle|src" "php|monolog|src" "php|carbon|src"
  "ruby|sinatra|lib" "ruby|rack|lib" "ruby|faraday|lib"
  "rust|clap|clap_builder/src" "rust|bytes|src" "rust|anyhow|src"
  "csharp|Newtonsoft.Json|Src/Newtonsoft.Json" "csharp|Polly|src" "csharp|serilog|src"
  "typescript|zod|packages/zod/src" "typescript|class-validator|src" "typescript|class-transformer|src"
  "javascript|commander|lib" "javascript|express|lib" "javascript|koa|lib"
)

emit(){ python3 - "$2" "$1" "$3" "$4" "$TSV" <<'PY'
import json,sys
lang,name,ej,dj,tsv=sys.argv[1:6]
rows=[]
try:
    e=json.load(open(ej))["planes"]
    for plane in ("imports","inheritance","calls_intra_repo"):
        r=[lang,name,plane]
        for s in ("koragraph","codegraph","gitnexus","graphify"):
            v=e.get(s,{}).get(plane,{}); r+=[v.get("recall",""),v.get("precision","")]
        rows.append(r)
except Exception: pass
try:
    d=json.load(open(dj)).get("systems",{})
    r=[lang,name,"decls_pooled"]
    for s in ("koragraph","codegraph","gitnexus","graphify"):
        v=d.get(s,{}).get("pooled",{}); r+=[v.get("recall",""),v.get("precision","")]
    rows.append(r)
except Exception: pass
open(tsv,"a").write("".join("\t".join(str(x) for x in r)+"\n" for r in rows))
PY
}

for row in "${REPOS[@]}"; do
  IFS='|' read -r LANG NAME LIB <<< "$row"
  REPO="$CORPUS/$NAME"
  grep -q "^$LANG	$NAME	" "$TSV" 2>/dev/null && { echo "[$LANG/$NAME] scored, skip"; continue; }
  [ -d "$REPO/.git" ] || { echo "[$LANG/$NAME] NO REPO at $REPO"; continue; }
  echo "===== $LANG / $NAME ====="
  DB="$DBD/$NAME.db"
  [ -f "$DB" ] || run_to 240 env KORAGRAPH_DB="$DB" node "$KG_REPO/bin/koragraph.js" ingest "$REPO" >/dev/null 2>&1
  [ -f "$DB" ] || { echo "  ingest FAILED/timed out"; echo -e "$LANG\t$NAME\tINGEST_FAIL\t\t\t\t\t\t\t\t" >> "$TSV"; continue; }
  run_to 300 bash "$HB/measure.sh" "$NAME" "$REPO" "$LIB" "$DB" "$LANG" "$OUT" >/dev/null 2>&1 || echo "  measure FAILED"
  for s in codegraph gitnexus graphify; do run_to 420 bash "$BENCH/run/run-competitor.sh" "$s" "$NAME" "$REPO" "$LIB" "$LANG" >/dev/null 2>&1 || echo "  $s FAILED/timeout"; done
  DSYS=(--system koragraph="$OUT/$NAME.kora-decls.lib.json"); ESYS=(--system koragraph="$OUT/$NAME.kora-edges.lib.json")
  for s in codegraph gitnexus graphify; do
    [ -f "$OUT/$NAME.$s-decls.lib.json" ] && DSYS+=(--system $s="$OUT/$NAME.$s-decls.lib.json")
    [ -f "$OUT/$NAME.$s-edges.lib.json" ] && ESYS+=(--system $s="$OUT/$NAME.$s-edges.lib.json")
  done
  python3 "$HB/score-decls.py" --truth "$OUT/$NAME.decl-truth.lib.json" "${DSYS[@]}" --out "$OUT/$NAME.alldecl.json" >/dev/null 2>&1
  python3 "$SCR/edge-compare-generic.py" --truth "$OUT/$NAME.edge-truth.lib.json" --decl-truth "$OUT/$NAME.decl-truth.lib.json" "${ESYS[@]}" --out "$OUT/$NAME.alledge.json" >/dev/null 2>&1
  emit "$NAME" "$LANG" "$OUT/$NAME.alledge.json" "$OUT/$NAME.alldecl.json"
  echo "  scored."
done
echo "===== MASTER H2H DONE ====="
