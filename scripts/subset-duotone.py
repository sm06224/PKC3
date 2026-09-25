#!/usr/bin/env python3
"""🔴 **Phosphor Duotone を、オフラインで**部分集合 + 符号位置の付け替えをする
(#1054 段①、2026-09-25)。

`scripts/build-icon-font.mjs`(Node)から**標準入力の JSON**で呼ばれる ──
2 つ目の一覧を持たないため(CLAUDE.md §7)、この script 自身は表を持たない。

入力(stdin, JSON):
    {
      "src": "<Phosphor-Duotone.woff2 の path>",
      "out": "<書き出す path>",
      "requests": [
        {"name": "gear", "sourceUnderlay": 59200, "sourceLine": 59201,
         "targetUnderlay": 57344, "targetLine": 57345},
        ...
      ]
    }

⚠ **符号位置は 10 進整数**で渡す(JSON に `0x` 表記が無いため)。

出力(stdout, JSON): `{"ok": true, "bytes": N, "glyphs": N}` か
`{"ok": false, "error": "..."}`。

## 🔴 決定性(offline・毎回同じ bytes)

- `TTFont(..., recalcTimestamp=False)` ── ⚠ **`Options.recalc_timestamp` だけでは
  足りない**(実測:2 回連続で焼いたら `head.modified` が 12 秒ずれた)。
  `recalcTimestamp` は **`TTFont` 読み込み時の引数**であり、`subset.Options` の
  同名に見える設定とは別物である。
- レイアウト機能(GSUB/GPOS)は丸ごと落とす(リガチャを使わない方針と同じ向き)。
- 符号位置の**付け替え**は `cmap` の全 subtable を**単一の辞書で置き換える**
  ── 元の名前(glyph name)を経由するが、`post` の名前は post-format 3 では
  cmap から**都度合成**されるだけの表示用の値であり、実体は glyph の**番号(GID)**
  で同一なことを実測で確認済み(outline / hmtx が remap 前後で完全一致)。
"""
import json
import sys

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont


def main() -> int:
    payload = json.load(sys.stdin)
    src = payload['src']
    out = payload['out']
    requests = payload['requests']

    wanted_source_cps = sorted(
        {r['sourceUnderlay'] for r in requests} | {r['sourceLine'] for r in requests}
    )

    opts = Options()
    opts.layout_features = []
    opts.notdef_outline = False
    opts.recalc_bounds = True
    opts.recalc_timestamp = False
    opts.name_IDs = []
    opts.name_legacy = False
    opts.glyph_names = False
    opts.desubroutinize = True
    opts.hinting = False
    # ⚠ この書体は独自の `FFTM`(FontForge Time Metadata)を持ち、fontTools は
    #   「subset の仕方を知らない」と warn して落とす ── 実害は無い(タイムスタンプ
    #   相当の私用表で、cmap/glyf のどちらにも関係しない)。stderr は握って読む。
    opts.drop_tables += ['FFTM']

    font = TTFont(src, recalcTimestamp=False)
    subsetter = Subsetter(options=opts)
    subsetter.populate(unicodes=wanted_source_cps)
    subsetter.subset(font)

    cmap = font['cmap']
    remap: dict[int, int] = {}
    for r in requests:
        remap[r['sourceUnderlay']] = r['targetUnderlay']
        remap[r['sourceLine']] = r['targetLine']

    for table in cmap.tables:
        old = table.cmap
        new_map: dict[int, str] = {}
        for source_cp, target_cp in remap.items():
            glyph_name = old.get(source_cp)
            if glyph_name is not None:
                new_map[target_cp] = glyph_name
        table.cmap = new_map

    font.save(out)

    with open(out, 'rb') as fh:
        data = fh.read()
    print(json.dumps({'ok': True, 'bytes': len(data), 'glyphs': font['maxp'].numGlyphs}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 -- Node 側へエラー文言を渡すためだけに握る
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(1)
