#!/usr/bin/env python3
"""配った一式に、**一覧どおりのダイアログ資源が入っているか**を後条件として主張する(#225)。

🔴 **これは「焼けた」と「届いた」の間に置く検品である。**

## なぜ要るか ── #225 は 3 か月ぶん誰にも鳴らなかった

非 ODF(`.docx` / `.rtf` / `.xlsx` …)の保存が「一般的な I/O エラー」で落ちていた原因は、
**「この形式のままにしますか」と訊くダイアログの `.ui`(`cui/ui/querydialog.ui`)が
一式に入っていなかった**ことだった。⚠ このとき鳴った計器は **1 つも無い**:

- `patch-lo-uifiles.py` の tripwire は **一覧(mk)の側**しか見ない ── 直したのは入力である
- 焼きの検品は **日本語の翻訳(`.mo`)と Langpack** を数えるだけで、**ダイアログ資源は
  1 件も数えていなかった**
- 症状は「保存が落ちる」という**遠く離れた形**でしか出ない(CLAUDE.md §8)

🔑 だから**配る物そのもの**(`soffice.data.js.metadata` = 実際に詰め込まれた目録)を読み、
**一覧と 1 件ずつ突き合わせる**。⚠ 件数ではなく**集合**で見る ── 件数だけの検査は、
同じ数だけ取り違えても緑になる。

## 両方向を見る(片方だけでは足りない)

| 向き | 何を捕まえるか |
|---|---|
| **一覧に在るのに配られていない** | 詰め込みが静かに落とした ── #225 の当の形 |
| **配られたのに一覧に無い** | ⚠ **一覧の読み方(`LINE_RE`)が上流の書き方に付いていけていない**。
  ここを黙って通すと、`patch-lo-uifiles.py` が**読めていない分だけ静かに足りなくなる** |

⚠ 2 つ目は「余分が配られた」ではなく「**こちらが読めていない**」の合図である。
実測(2026-08-24、LO 770ef72c の配った一式 vs 一覧): **両方向とも 0 件 / 1,090 対 1,090**。

## 🔑 一覧の読み方は 2 か所に書かない

「一覧に何が載っているか」は `patch-lo-uifiles.py` の `bundled()` が既に答えている。
⚠ ここで同じ正規表現を書き直すと、**片方だけ上流に追随して食い違う**
(CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ壊しても届かない」)── だから **import する**。
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# 目録の綴りは `/instdir/share/config/soffice.cfg/cui/ui/querydialog.ui`、
# 一覧の綴りは `$(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/cui/ui/querydialog.ui`。
# 🔑 **共通の尻**(`soffice.cfg/` から後ろ)で突き合わせる。
MARK = "/soffice.cfg/"

# 名指しで在ることを主張する 1 件。⚠ 集合の突合が**両方とも空**でも通ってしまう事故を
# 防ぐ錨であり、同時に **#225 の当の file** である(ここが落ちたら保存が落ちる)。
# 🔴 頭と尻を両方留める ── 尻だけだと `recalcquerydialog.ui` に、
#    頭だけだと `querydialog.ui.bak` に当たる(CLAUDE.md §1、2026-08-24 に踏んだ)。
#
# 🔴 **2026-08-28: 上流がこの file を移したので、錨も移した。**
#    実測(LO `570a4c78` → `72012ca1`):`cui/uiconfig/ui/querydialog.ui` は **404** になり、
#    `cui/UIConfig_cui.mk` からも消えた。実体は **`svtools` へ移っている** ──
#    `include/svtools/querydialog.hxx` の `class QueryDialog` が
#    `GenericDialogController(pParent, u"svt/ui/querydialog.ui"_ustr, …)` を読み、
#    `svtools/UIConfig_svt.mk` が登録している(= cfg 上の綴りは `svt/ui/`)。
#    配った一式でも確かめた:旧 `cui/ui/…` 1 件 → 新 `svt/ui/…` 1 件。
#
# 🔑 **この錨が落ちたときの読み方**(次に上流が動かしたとき、ここを読む人へ):
#    「保存が壊れた」と読む**前に**、`.ui` が**移っただけ**かを確かめる ──
#    上流を `grep -rn 'querydialog.ui' include/ svtools/ cui/` で引き、
#    `GenericDialogController(…, u"<どこか>/querydialog.ui"_ustr, …)` の綴りを見る。
#    移っていたらここを直すだけでよい(ビルドは壊れていない)。
#    ⚠ **移動を「消えた」と読むと、直っている物を追いかけて 1 回転捨てる。**
#
# 🔴 **2026-08-28(2 度目): 在り処は「枝によって違う」ので、字を焼き込むのをやめた。**
#    LO **26.8**(安定枝、`63426ccd`)は **`cui/ui/querydialog.ui`** のまま、
#    master(`72012ca1` 以降)は **`svt/ui/querydialog.ui`** ── **どちらも正しい**。
#    ⚠ 字を 1 つ焼き込むと、**枝を替えた焼きが必ず落ちる**(実際 #511 の 26.8 の
#    焼きが 3 時間 37 分かけて成功したのに、ここだけで赤になった)。
#    🔑 だから**上流の実装から引く** ── `GenericDialogController(…, u"…/querydialog.ui"_ustr, …)`
#    の綴りが、その枝で**実際に読まれる**在り処である(CLAUDE.md §8
#    「上流の『入れる物』を数えるときは、file システムではなく**登録**を読む」の同型)。
#    ⚠ 読めなかったときだけ、下の既知の綴りへ落ちる(**判定は止めない**)。
ANCHOR_FALLBACK = ("svt/ui/querydialog.ui", "cui/ui/querydialog.ui")

# 実装から綴りを引くときに見る所。
# 🔴 **file の一覧を手書きしない**(CLAUDE.md §8「**推測の表を作った時点で、
#    読むべき物を読んでいない合図**」)── 在り処が枝で動くのに、置き場の表を
#    焼き込んだら**同じ間違いをもう一段深くやる**だけである。
# 🔑 **名前で探す** ── クラスの実体は `querydialog.hxx` / `.cxx` に在る(枝が変わっても
#    module が変わるだけで、この名前は動いていない)。⚠ 全数 grep はしない
#    (3 時間の焼きの後に数秒で終わること)。
ANCHOR_DIRS = ("include", "svtools", "cui", "vcl", "svx")
ANCHOR_GLOB = "querydialog.*"

ANCHOR_RE = re.compile(r'u"([A-Za-z0-9_/]+/querydialog\.ui)"_ustr')


def anchor_from_source(root: Path) -> tuple[str | None, str]:
    """上流の実装から「実際に読まれる `.ui` の綴り」を引く。

    @returns (綴り, どこから引いたか)。⚠ 引けなければ `(None, 理由)`。
    """
    for d in ANCHOR_DIRS:
        base = root / d
        if not base.is_dir():
            continue
        for f in sorted(base.rglob(ANCHOR_GLOB)):
            if not f.is_file() or f.suffix not in (".hxx", ".cxx", ".hpp", ".cpp"):
                continue
            m = ANCHOR_RE.search(f.read_text(encoding="utf-8", errors="replace"))
            if m:
                return m.group(1), str(f.relative_to(root))
    return None, f"{root} の {'/'.join(ANCHOR_DIRS)} に {ANCHOR_GLOB} が無い"


def _patch_module():
    """`patch-lo-uifiles.py` を読み込む(file 名に `-` が在るので importlib を使う)。

    ⚠ `__pycache__` を作らせない ── ここは **repo の中**(`build/office-wasm/`)を
    読むので、置き土産を残すと作業ツリーが汚れる(実際 1 度残した)。
    """
    sys.dont_write_bytecode = True
    path = HERE / "patch-lo-uifiles.py"
    spec = importlib.util.spec_from_file_location("pkc3_patch_lo_uifiles", path)
    if spec is None or spec.loader is None:  # pragma: no cover - 実運用では起きない
        raise RuntimeError(f"読み込めない: {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def delivered(meta_text: str) -> set[str]:
    """目録(`soffice.data.js.metadata`)が持つ `.ui` を、cfg 上の相対 path で返す。"""
    doc = json.loads(meta_text)
    out: set[str] = set()
    for f in doc.get("files", []):
        name = f.get("filename", "")
        if isinstance(name, str) and name.endswith(".ui") and MARK in name:
            out.add(name.split(MARK, 1)[1])
    return out


def compare(mk_text: str, meta_text: str) -> tuple[set[str], set[str]]:
    """(一覧, 配った物)を返す。判定は呼び側で書く。"""
    mod = _patch_module()
    return set(mod.bundled(mk_text)), delivered(meta_text)


def _some(names: set[str], cap: int = 20) -> str:
    s = sorted(names)
    head = ", ".join(s[:cap])
    return head + (f" …ほか {len(s) - cap} 件" if len(s) > cap else "")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-fs-image-uifiles.py <mk> <soffice.data.js.metadata>", file=sys.stderr)
        return 2

    mk_path, meta_path = Path(sys.argv[1]), Path(sys.argv[2])
    for p in (mk_path, meta_path):
        if not p.is_file():
            print(f"ERROR: {p} が無い", file=sys.stderr)
            return 1

    mod = _patch_module()
    try:
        listed, got = compare(mk_path.read_text(encoding="utf-8"), meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"ERROR: 目録が JSON として読めない: {e}", file=sys.stderr)
        return 1

    print(f"ダイアログ資源: 一覧 {len(listed)} 件 / 配った物 {len(got)} 件")

    # ⚠ **空振り防止を先に置く。** 両方 0 件でも「差は無い」は真になる ──
    #    読めていないことを「一致した」と読まないため(CLAUDE.md §1)。
    floor = mod.FLOOR
    if len(listed) < floor:
        print(f"ERROR: 一覧から {len(listed)} 件しか読めていない(下限 {floor})"
              f" ── LINE_RE が上流の書き方に付いていっていない", file=sys.stderr)
        return 1
    if len(got) < floor:
        print(f"ERROR: 配った物に {len(got)} 件しか入っていない(下限 {floor})", file=sys.stderr)
        return 1

    fail = False
    missing = listed - got
    if missing:
        print(f"ERROR: 一覧に在るのに配られていない {len(missing)} 件: {_some(missing)}", file=sys.stderr)
        fail = True
    extra = got - listed
    if extra:
        print(f"ERROR: 配られたのに一覧に無い {len(extra)} 件: {_some(extra)}"
              f" ── ① 一覧に足す patch が当たっていない"
              f" ② 一覧の読み方が上流の書き方に追随できていない、のどちらか",
              file=sys.stderr)
        fail = True

    # 🔴 名指しの錨 ── #225 の当の file。集合の突合とは別に、これ 1 件は必ず主張する。
    #    🔑 **綴りは上流の実装から引く**(枝によって在り処が違うため ── 上の注記)。
    anchor, whence = anchor_from_source(mk_path.resolve().parents[1])
    if anchor is None:
        # ⚠ 引けなかったことを**黙って通さない** ── どの綴りで判定したかを必ず出す。
        #    🔑 **stdout に出す**(通った回にも読めるように ── 落ちた回だけ読める
        #    診断は、「実装から引けている」という思い込みを直せない)
        print(f"  ⚠ 実装から錨を引けなかった({whence})── 既知の綴りで見る")
    else:
        print(f"  錨は実装から引いた: {anchor}({whence})")
    wanted = (anchor,) if anchor is not None else ANCHOR_FALLBACK
    # ⚠ fallback のときは **どれか 1 つ**在れば良い(枝を跨いで焼くため)。
    #    実装から引けたときは**その 1 つ**を要求する(移動を見逃さない)。
    if not any(w in got for w in wanted):
        print(f"ERROR: {' / '.join(wanted)} が配る一式に無い ── 非 ODF の保存が"
              f"「一般的な I/O エラー」で落ちる(#225)", file=sys.stderr)
        # 🔑 **「消えた」と「移った」を読み分ける材料をその場に出す。**
        #    ⚠ これが無いと、次に読む人は「保存が壊れた」から調べ始める。
        seen = sorted(n for n in got if n.endswith("/querydialog.ui"))
        print(f"  一式に在る querydialog.ui: {seen if seen else '(1 件も無い)'}", file=sys.stderr)
        print("  🔑 上流を grep して在り処を確かめる:"
              " grep -rn 'querydialog.ui' include/ svtools/ cui/", file=sys.stderr)
        fail = True

    if fail:
        return 1
    found = next(w for w in wanted if w in got)
    print(f"  差は両方向とも 0 件 / {found} も在る")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
