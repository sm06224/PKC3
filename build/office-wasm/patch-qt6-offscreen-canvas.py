#!/usr/bin/env python3
"""LibreOffice の **Qt6 + WebAssembly** 経路の取りこぼし・その 2(#88、2026-08-10)。

症状(run 31350624048 実測): ビルドは通り、Qt の `onLoaded` も発火するのに
**画面に何も出ない** ── `#screen` の中の canvas は **0 枚**、`window.Module` も未設定。
console には 1 行だけ:

    pthread_create: could not find canvas with ID "#qtcanvas" to transfer to thread!

原因: `desktop/Executable_soffice_bin.mk:66-70` が、`PROXY_TO_PTHREAD` かつ GUI 有りの
とき **`-sOFFSCREENCANVAS_SUPPORT=1 -sOFFSCREENCANVASES_TO_PTHREAD=#qtcanvas`** を渡す。
`#qtcanvas` は **Qt5 の shell が持っていた canvas の id** で、
**Qt6 は `#screen` の中へ動的に canvas を作る**(`qtbase` を `qtcanvas` で grep して 0 件、
`OFFSCREENCANVAS` / `PROXY_TO_PTHREAD` も 0 件 ── Qt6 はこの機構を一切使わない)。

🔴 **これは警告ではなく致命傷である。** emscripten の `libpthread.js:730` は
canvas が見つからないと `error = EINVAL; break;` として **`pthread_create` を失敗させる**。
`-sPROXY_TO_PTHREAD=1` では**その pthread が `main()` 本体**なので、
**LibreOffice の main が 1 度も走らない**。観測(onLoaded だけ出て canvas 0)と一致する。

直し: この 2 つのフラグを **Qt5 のときだけ**渡す。Qt6 では渡さなければ
`transferredCanvasNames` が空になり、ループごと通らないので pthread_create が成功する。

⚠ 上流の条件は `$(if $(DISABLE_GUI),,…)` で **Qt5/Qt6 を区別していない**。
つまり Qt6 経路が最後まで通されていないことの 3 つ目の表れである
(1 つ目 = FreeType、2 つ目 = 例外モデル)。

⚠ **当たったことを確かめてから当てる**(空振りを合格と読まない)── 錨が 1 個
無ければ異常終了する。
"""

import sys
from pathlib import Path

ANCHOR = (
    '\t        -sOFFSCREENCANVAS_SUPPORT=1 -sOFFSCREENCANVASES_TO_PTHREAD=\\#qtcanvas)) \\'
)
REPLACEMENT = (
    '\t        $(if $(filter TRUE,$(ENABLE_QT5)),'
    '-sOFFSCREENCANVAS_SUPPORT=1 -sOFFSCREENCANVASES_TO_PTHREAD=\\#qtcanvas))) \\'
)


def main(argv: list[str]) -> int:
    root = Path(argv[1] if len(argv) > 1 else '.')
    target = root / 'desktop' / 'Executable_soffice_bin.mk'
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
