#!/usr/bin/env bash
# Fair, library-scoped whole-graph quality for one repo, one system (koragraph).
# Reuses the validated referees + edge-compare-generic.py + score-decls.py; the
# only added step is scope-filter.py (see KNOWN-BIASES: docs/config/test files
# are referee "declarations" that don't belong in a library-quality headline).
#
#   measure.sh <name> <repoPath> <libPrefix> <koragraphDb> <lang> <outDir>
#
# lang: python (more added as edge referees land). Emits <outDir>/<name>.json
# with LIB and full-repo scores for decls + edges, plus the repo SHA.
set -euo pipefail
NAME=$1; REPO=$2; LIB=$3; DB=$4; LANG=$5; OUT=$6
ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # test/benchmark: referees in $ROOT/scripts, scorers in $ROOT/langquality
# External toolchains default under ~/.koragraph-bench but are overridable (see run/SETUP.md).
COMPETITORS="${KG_COMPETITORS:-$HOME/.koragraph-bench/competitors}"
mkdir -p "$OUT"
SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo "unknown")

EXCLUDE=""
case "$LANG" in
  python)
    DECL_REF=(python3 "$ROOT/scripts/ast-referee-cpython.py")
    EDGE_REF=(python3 "$ROOT/scripts/edge-referee-cpython.py") ;;
  go)
    # Go tests are co-located *_test.go; exclude them + examples for a library scope.
    EXCLUDE="_test.go,/examples/"
    [ -x /tmp/lq/ast-goast ] || (cd "$ROOT/scripts/ast-referee-goast" && go build -o /tmp/lq/ast-goast .)
    [ -x /tmp/lq/edge-goast ] || (cd "$ROOT/scripts/edge-referee-goast" && go build -o /tmp/lq/edge-goast .)
    DECL_REF=(/tmp/lq/ast-goast)
    EDGE_REF=(/tmp/lq/edge-goast) ;;
  java)
    # ast-referee.py is tree-sitter-java (independent of koragraph's regex scanner);
    # edge-referee-java.py needs python tree_sitter_java (the graphify venv has it).
    # Both java referees are python tree-sitter and need tree_sitter_java, which
    # lives in the graphify venv (system python3 silently yields 0 declarations).
    GFPY="$COMPETITORS/.venv-graphify/bin/python3"
    DECL_REF=("$GFPY" "$ROOT/scripts/ast-referee.py")
    DECL_EXTRA="--lang java"   # ast-referee.py reads repo as argv[1], so --lang goes last
    EDGE_REF=("$GFPY" "$ROOT/scripts/edge-referee-java.py") ;;
  typescript|javascript)
    # The tsc referees need TypeScript 5.x (not tsgo); installed in the bench dir.
    export TSC_REFEREE_PATH="$ROOT/scripts/tsc-referee/node_modules/typescript"
    DECL_REF=(node "$ROOT/scripts/ast-referee-tsc.js")
    EDGE_REF=(node "$ROOT/scripts/edge-referee-tsc.js")
    DECL_EXTRA="--lang $LANG"; EDGE_EXTRA="--lang $LANG" ;;
  ruby)
    # Ripper is Ruby's own (MRI) parser — independent of koragraph's tree-sitter-ruby.
    RB=/opt/homebrew/opt/ruby/bin/ruby; [ -x "$RB" ] || RB=ruby
    DECL_REF=("$RB" "$ROOT/scripts/referee-ruby.rb")
    EDGE_REF=("$RB" "$ROOT/scripts/referee-ruby.rb")
    DECL_EXTRA="--mode decls"; EDGE_EXTRA="--mode edges" ;;
  php)
    # php-ast (nikic) is PHP's own compiler AST — independent of koragraph's tree-sitter-php.
    DECL_REF=(php "$ROOT/scripts/ast-referee-phpast.php")
    EDGE_REF=(php "$ROOT/scripts/edge-referee-phpast.php") ;;
  csharp)
    # Roslyn (the C# compiler's own parser) — independent of koragraph's tree-sitter-c_sharp.
    CSDLL="${KG_CSHARP_REFEREE_DLL:-$ROOT/scripts/csharp-referee/bin/Release/net10.0/referee.dll}"
    export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
    DECL_REF=(dotnet "$CSDLL"); EDGE_REF=(dotnet "$CSDLL")
    DECL_EXTRA="--mode decls"; EDGE_EXTRA="--mode edges" ;;
  rust)
    # syn (the Rust ecosystem's parser) — independent of koragraph's tree-sitter-rust.
    RSBIN="${KG_RUST_REFEREE_BIN:-$ROOT/scripts/rust-referee/target/release/referee}"
    DECL_REF=("$RSBIN"); EDGE_REF=("$RSBIN")
    DECL_EXTRA="--mode decls"; EDGE_EXTRA="--mode edges" ;;
  *) echo "lang $LANG not wired yet" >&2; exit 2 ;;
esac

"${DECL_REF[@]}" "$REPO" --out "$OUT/$NAME.decl-truth.json" ${DECL_EXTRA:-} >/dev/null
"${EDGE_REF[@]}" "$REPO" --out "$OUT/$NAME.edge-truth.json" ${EDGE_EXTRA:-} >/dev/null
node "$ROOT/langquality/dump-koragraph.js" --db "$DB" \
  --out-edges "$OUT/$NAME.kora-edges.json" --out-decls "$OUT/$NAME.kora-decls.json"

flt() { python3 "$ROOT/langquality/scope-filter.py" --in "$1" --prefix "$2" --exclude "$EXCLUDE" --out "$3"; }
for f in decl-truth edge-truth kora-edges kora-decls; do
  flt "$OUT/$NAME.$f.json" "$LIB" "$OUT/$NAME.$f.lib.json"
done

score() { # scope-suffix
  local s=$1
  echo "===== $NAME [$s] edges ====="
  python3 "$ROOT/scripts/edge-compare-generic.py" \
    --truth "$OUT/$NAME.edge-truth$s.json" --decl-truth "$OUT/$NAME.decl-truth$s.json" \
    --system koragraph="$OUT/$NAME.kora-edges$s.json" --out "$OUT/$NAME.edge-cmp$s.json"
  echo "===== $NAME [$s] decls ====="
  python3 "$ROOT/langquality/score-decls.py" \
    --truth "$OUT/$NAME.decl-truth$s.json" \
    --system koragraph="$OUT/$NAME.kora-decls$s.json" --out "$OUT/$NAME.decl-cmp$s.json"
}
score ".lib"
score ""

python3 - "$OUT/$NAME.json" "$NAME" "$SHA" "$LIB" "$LANG" \
  "$OUT/$NAME.edge-cmp.lib.json" "$OUT/$NAME.decl-cmp.lib.json" \
  "$OUT/$NAME.edge-cmp.json" "$OUT/$NAME.decl-cmp.json" <<'PY'
import json,sys
out,name,sha,lib,lang,el,dl,ef,df=sys.argv[1:10]
def L(p): return json.load(open(p))
res={"repo":name,"sha":sha,"lib_prefix":lib,"lang":lang,
     "lib":{"edges":L(el)["planes"]["koragraph"],"decls":L(dl)["systems"]["koragraph"]},
     "full":{"edges":L(ef)["planes"]["koragraph"],"decls":L(df)["systems"]["koragraph"]}}
json.dump(res,open(out,"w"),indent=2)
print("wrote",out)
PY
