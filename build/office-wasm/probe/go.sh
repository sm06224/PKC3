#!/bin/bash
# 1 本回す: go.sh TAG DOC 'STEPS-json' [PACK]
#   → $PKC3_PROBE_OUT/TAG.json / TAG.log / TAG.console.log と $PKC3_PROBE_OUT/shots/TAG-*.png
# env: PKC3_PROBE_DIR(既定 = カレント。文書は $PKC3_PROBE_DIR/fx/DOC)/ PKC3_PROBE_PACK(PACK 省略時。一式の dir)
#      PKC3_PROBE_OUT(既定 = $PKC3_PROBE_DIR/logs)
HERE=$(cd "$(dirname "$0")" && pwd)
PROBE_DIR=$(realpath "${PKC3_PROBE_DIR:-$PWD}")
OUT=$(realpath -m "${PKC3_PROBE_OUT:-$PROBE_DIR/logs}")
TAG=$1; DOC=$2; export STEPS="$3"; PACK=${4:-$PKC3_PROBE_PACK}
if [ -z "$TAG" ] || [ -z "$DOC" ] || [ -z "$PACK" ]; then echo "usage: go.sh TAG DOC 'STEPS-json' [PACK]  (PACK 省略時は PKC3_PROBE_PACK)" >&2; exit 2; fi
PACK=$(realpath "$PACK")
mkdir -p "$OUT"
export CONSOLE_LOG=$OUT/$TAG.console.log; : > "$CONSOLE_LOG"
cd "$HERE" || exit 2
timeout -k 10 500 node run.mjs "$PACK" "$PROBE_DIR/fx" "$DOC" "$OUT/$TAG.json" "$OUT/shots" "$TAG" > "$OUT/$TAG.log" 2>&1
echo "exit=$?" >> "$OUT/$TAG.log"
