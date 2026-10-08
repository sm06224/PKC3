#!/bin/bash
# 並列に回す: batch.sh JOBS [PACK] [P]   (JOBS の各行: tag<TAB>doc<TAB>steps-json。P = 同時に走らせる本数。既定 3)
# env は go.sh と同じ(PKC3_PROBE_DIR / PKC3_PROBE_PACK / PKC3_PROBE_OUT)
HERE=$(cd "$(dirname "$0")" && pwd)
PROBE_DIR=$(realpath "${PKC3_PROBE_DIR:-$PWD}")
OUT=$(realpath -m "${PKC3_PROBE_OUT:-$PROBE_DIR/logs}")
export PKC3_PROBE_DIR=$PROBE_DIR PKC3_PROBE_OUT=$OUT
PACK=${2:-$PKC3_PROBE_PACK}; P=${3:-3}
if [ -z "$1" ] || [ -z "$PACK" ]; then echo "usage: batch.sh JOBS [PACK] [P]  (PACK 省略時は PKC3_PROBE_PACK)" >&2; exit 2; fi
mkdir -p "$OUT"
n=0
while IFS=$'\t' read -r t d s; do
  "$HERE/go.sh" "$t" "$d" "$s" "$PACK" &
  n=$((n+1))
  if (( n >= P )); then wait -n; n=$((n-1)); fi
done < "$1"
wait
echo "batch done" > "$OUT/batch-$(basename "$1").done"
