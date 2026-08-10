#!/usr/bin/env bash
# CI が出した prerelease を**手元へ落として起動させる**(#88、2026-08-10)。
#
# user 指示「ビルド通ってるんだから、あなたの環境に落として試せばいいんじゃない?」──
# CI の 1 回転は 25 分。ブラウザのフラグ・待ち時間・観測点を詰めるのに毎回それを
# 払う理由が無い。**落としてしまえば秒で回る。**
#
# ⚠ artifact は API 経由でしか取れず、この箱からは api.github.com が 403。
#    一方 **in-scope repo の github.com は 200** なので release 資産なら届く(実測)。
#
# 使い方:
#   bash build/office-wasm/fetch-and-run.sh            # 落として probe
#   PKC3_BOOT_TIMEOUT_MS=60000 bash …/fetch-and-run.sh # 待ちを変えて試す
#   bash build/office-wasm/fetch-and-run.sh --keep     # 再取得せず手元のを使う
set -euo pipefail

REPO=${PKC3_LO_REPO:-sm06224/PKC3}
TAG=${PKC3_LO_TAG:-lo-wasm-dev}
DIR=${PKC3_LO_DIR:-/tmp/lo-wasm}
URL="https://github.com/$REPO/releases/download/$TAG/lo-wasm-qt6.zip"

if [ "${1:-}" != "--keep" ] || [ ! -d "$DIR" ]; then
  mkdir -p "$DIR"
  echo "取得: $URL"
  curl -sSL --fail --max-time 900 -o /tmp/lo-wasm-qt6.zip "$URL"
  # ⚠ **落ちてきたものが zip か確かめる** ── 404 の HTML を掴んで
  #    「壊れている」と読み違えない(font のサイズ計測で 1 度やった)
  if ! head -c 2 /tmp/lo-wasm-qt6.zip | grep -q 'PK'; then
    echo 'ERROR: zip ではない。中身:' >&2
    head -c 300 /tmp/lo-wasm-qt6.zip >&2
    exit 1
  fi
  rm -rf "$DIR"; mkdir -p "$DIR"
  unzip -q /tmp/lo-wasm-qt6.zip -d "$DIR"
fi

echo '=== 落ちてきた一式 ==='
ls -la "$DIR"
# 起動に不可欠な 5 つ(上流の install list より)
for f in soffice.js soffice.wasm soffice.data soffice.data.js.metadata qt_soffice.html; do
  test -f "$DIR/$f" || { echo "ERROR: $f が無い" >&2; exit 1; }
done

echo '=== 起動 probe ==='
# ⚠ 手元は /opt/pw-browsers/chromium(フル chromium)。CI は channel:chromium。
#    **どちらで測ったかは probe が JSON に残す**
PKC3_CHROMIUM=${PKC3_CHROMIUM:-/opt/pw-browsers/chromium} \
  node "$(dirname "$0")/boot-probe.mjs" "$DIR" "$DIR/boot-probe.json"
