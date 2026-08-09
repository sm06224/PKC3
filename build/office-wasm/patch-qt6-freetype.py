#!/usr/bin/env python3
"""LibreOffice の **Qt6 + WebAssembly** 経路の取りこぼしを当てる(#88、2026-08-09)。

症状(run 31307638176 実測): 2h40m かけて全部コンパイルしたあと、**最後の
`soffice.js` のリンクで**落ちる ──
`wasm-ld: undefined symbol: FT_Outline_Transform`(ほか `FT_*` 多数、すべて
`libcairo-lo.a(cairo-ft-font.c.o)` 由来)。

原因: `vclplug_qt6` は headless のとき **cairo を externals に取る**のに、
**cairo が要求する freetype を取っていない**。Qt5 のリンク行には
`-lQt5FontDatabaseSupport` が在って Qt 側の freetype で解決されるが、
**Qt6 のリンク行(`configure.ac:14313`)にはフォント系が 1 つも無い**。

🔑 **LO 自身の freetype を使う** ── cairo は meson ビルド時に LO の freetype
instdir を指して構成される(`external/cairo/ExternalProject_cairo.mk`)ので、
Qt 同梱の別版を混ぜない。

⚠ **`use_static_libraries` で足してはいけない**(最初そう書いて誤りだった)。
`StaticLibrary_freetype` が建つのは `COM=MSC` のときだけで、Emscripten では
**ExternalProject**(`external/freetype/Module_freetype.mk`)。だから上流の
`vcl/Library_vcl.mk` の条件が `WNT-TRUE` なのは理由がある。正しい口は
**externals** ── `RepositoryExternal.mk` の `gb_LinkTarget__use_freetype` が
`FREETYPE_LIBS` をリンク行へ足し、`solenv/gbuild/static.mk` が
**実行ファイルに externals を当て直す**ので `soffice_bin` まで届く。

⚠ **当たったことを確かめてから当てる**(空振りを合格と読まない)── 錨が 1 個
無ければ異常終了する。上流が形を変えたら、黙って素通りするのではなく気づきたい。
"""

import sys
from pathlib import Path

ANCHOR = '    $(if $(filter TRUE,$(ENABLE_CAIRO_CANVAS) $(USE_HEADLESS_CODE)),cairo) \\'
REPLACEMENT = '    $(if $(filter TRUE,$(ENABLE_CAIRO_CANVAS) $(USE_HEADLESS_CODE)),cairo freetype) \\'


def main(argv: list[str]) -> int:
    root = Path(argv[1] if len(argv) > 1 else '.')
    target = root / 'vcl' / 'Library_vclplug_qt6.mk'
    src = target.read_text(encoding='utf-8')

    if REPLACEMENT in src:
        print('already patched')
        return 0

    hits = src.count(ANCHOR)
    if hits != 1:
        print(f'ERROR: anchor found {hits} times (expected 1) in {target}', file=sys.stderr)
        print('上流が形を変えた可能性がある。素通りさせず、ここで止める。', file=sys.stderr)
        return 1

    target.write_text(src.replace(ANCHOR, REPLACEMENT, 1), encoding='utf-8')
    print(f'patched {target}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
