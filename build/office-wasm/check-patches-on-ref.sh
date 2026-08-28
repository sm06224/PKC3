#!/bin/bash
# 🔴 **焼く前に「パッチが新しい枝にも当たるか」を測る**(#511)。
#
# > user 指示 2026-08-28:「**libreoffice にメジャーバージョンアップが来ています。
# > 本プロジェクトのアップグレードも検討してください**」
#
# ## なぜ要るか
#
# LO の焼きは **30 分〜4 時間**かかる。⚠ ref を変えて投げて、**パッチが 1 本
# 当たらないだけ**で丸ごと捨てることになる ── 2026-08-24 に `patch-lo-uifiles.py`
# の 1 稿目で実際に make ごと止めた(run 32734107620)。
#
# 🔑 パッチが読む file は**数えられる**ので、焼かずに当ててみればよい。
# 実測(2026-08-28、`libreoffice-26-8`):**13 本とも当たる**ことがこれで分かり、
# 焼きを 1 本も捨てずに済んだ。
#
# ## ⚠ 空振りしない作り(CLAUDE.md §1)
#
# - 落とせなかった file が **1 件でもあれば落ちる** ── 「0 件当たった」を
#   「当たらない物が無い」と読ませない
# - `*/UIConfig_*.mk` は **39 本**在るはずなので下限を置く(clone が浅いと 0 本になり、
#   `patch-lo-uifiles.py` 自身の下限で落ちるが、**ここでも鳴らす**)
# - 🔴 **対照群を必ず回す** ── いま焼いている ref(既定 `master`)で緑になることを
#   先に見る。⚠ 見ないと「新しい枝で落ちた」のか「この検査が壊れている」のかが
#   区別できない(2026-08-17「対照群が届かない回は判定不能」)
#
# 使い方:
#
#     build/office-wasm/check-patches-on-ref.sh libreoffice-26-8
#     build/office-wasm/check-patches-on-ref.sh libreoffice-26-8 master   # 対照群を明示
set -uo pipefail

REF="${1:?usage: $0 <ref> [control-ref]}"
CONTROL="${2:-master}"
CA=/root/.ccr/ca-bundle.crt
HERE="$(cd "$(dirname "$0")" && pwd)"

# ⚠ **パッチが読む file をここに書き写さない** ── 増えたら必ず古くなる。
#    パッチ本体から `SRC = "…"` / path のリテラルを拾う(判定は 1 か所)。
mapfile -t FILES < <(python3 - "$HERE" <<'PY'
import re, sys, pathlib
files = set()
for p in sorted(pathlib.Path(sys.argv[1]).glob('patch-lo-*.py')):
    src = p.read_text(encoding='utf-8')
    for m in re.finditer(r'^(?:SRC|MK)\s*=\s*"([^"]+)"', src, re.M):
        files.add(m.group(1))
    for m in re.finditer(r'"((?:[a-z0-9_]+/)+[a-z0-9_]+\.(?:cxx|hxx|mk|ac))"', src):
        files.add(m.group(1))
print('\n'.join(sorted(files)))
PY
)
if [ "${#FILES[@]}" -lt 10 ]; then
  echo "ERROR: パッチから読む file を ${#FILES[@]} 件しか拾えていない(下限 10)" >&2
  echo "  ⚠ この状態では『当たった』を数えられない ── 拾い方を直すこと" >&2
  exit 2
fi

run_ref() {
  local ref="$1" root="/tmp/lo-precheck-$1"
  local miss=0
  rm -rf "$root"; mkdir -p "$root"
  for f in "${FILES[@]}"; do
    mkdir -p "$root/$(dirname "$f")"
    curl -sSfL --cacert "$CA" -o "$root/$f" \
      "https://raw.githubusercontent.com/LibreOffice/core/$ref/$f" \
      || { echo "  MISSING  $f"; miss=$((miss+1)); }
  done
  if [ "$miss" -gt 0 ]; then
    echo "ERROR($ref): 落とせなかった file が $miss 件 ── 上流が場所を変えた" >&2
    return 1
  fi
  # 🔴 **`patch-lo-uifiles.py` は木ぜんぶ(`*/UIConfig_*.mk`)を読む** ── file を
  #    名指しで落とせないので、**blob 無しの浅い clone + sparse checkout** で取る
  #    (実測 5MB。全部 clone すると数 GB)。
  local tree="/tmp/lo-precheck-tree-$ref"
  rm -rf "$tree"
  git clone --filter=blob:none --no-checkout --depth 1 -b "$ref" \
    https://github.com/LibreOffice/core.git "$tree" >/dev/null 2>&1 || {
    echo "ERROR($ref): clone できない" >&2; return 1; }
  ( cd "$tree" \
    && git sparse-checkout init --no-cone >/dev/null 2>&1 \
    && printf '%s\n' '/*/UIConfig_*.mk' '/static/CustomTarget_emscripten_fs_image.mk' \
       | git sparse-checkout set --stdin --no-cone >/dev/null 2>&1 \
    && git checkout HEAD >/dev/null 2>&1 )
  local n; n=$(ls "$tree"/*/UIConfig_*.mk 2>/dev/null | wc -l)
  if [ "$n" -lt 20 ]; then
    echo "ERROR($ref): UIConfig の mk が $n 本しか取れていない(下限 20)" >&2
    return 1
  fi

  # ⚠ 計装(trace)は既定で当てない ── ただし**錨の検査は毎回する**作りなので、
  #    ここで回す意味がある(上流が形を変えたら鳴る)。
  export PKC3_IME_TRACE=0 PKC3_SAVE_TRACE=0 PKC3_IDLES_TRACE=0 PKC3_WASM_SCRIPTING=yes
  local bad=0
  for p in "$HERE"/patch-lo-*.py; do
    local name; name=$(basename "$p")
    local target="$root"
    # ⚠ `uifiles` だけは木のほうへ当てる(`fsimage` を先に当ててから ── 焼きと同じ順)
    if [ "$name" = "patch-lo-uifiles.py" ]; then
      python3 "$HERE/patch-lo-fsimage.py" "$tree" >/dev/null 2>&1
      target="$tree"
    fi
    local out rc
    out=$(python3 "$p" "$target" 2>&1); rc=$?
    printf '  %-34s exit=%s  %s\n' "$name" "$rc" "$(echo "$out" | head -1)"
    [ "$rc" -eq 0 ] || bad=$((bad+1))
  done
  rm -rf "$root" "$tree"
  return "$bad"
}

echo "=== 対照群: $CONTROL ==="
if ! run_ref "$CONTROL"; then
  echo "🔴 対照群が落ちた ── **判定不能**。この検査自身が壊れている" >&2
  echo "  ⚠ 結果を読まないこと(CLAUDE.md §4)" >&2
  exit 1
fi
echo "=== 本題: $REF ==="
if run_ref "$REF"; then
  echo "✅ $REF に 13 本とも当たる(対照群 $CONTROL も緑)"
else
  echo "🔴 $REF で当たらないパッチが在る ── 上の exit≠0 の行を直してから焼く" >&2
  exit 1
fi
