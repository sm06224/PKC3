#!/usr/bin/env python3
"""#199 の**直し**。画像入り Word 文書が永久に開かない原因を、待ちの側で塞ぐ。

🔴 **これは計装ではない。既定で当たる。**

## 何が起きているか(2026-08-24、名前入りの一式で stack を撮って確定した)

自作 1,782 バイトの docx(DrawingML の画像 1 枚)を渡すと、**生きている pthread 2 本**の
うち 1 本が次の場所で止まったまま戻らない(60 秒でも 13 分でも同じ):

    $emscripten_futex_wait
    $__timedwait_cp
    $__pthread_cond_timedwait
    $std::__2::condition_variable::wait(...)
    $osl_waitCondition
    $Scheduler::IdlesLockGuard::IdlesLockGuard()          <- ここ
    $sw::DocumentLayoutManager::DelLayoutFormat(SwFrameFormat*)
    $SwXShape::dispose()
    $writerfilter::dmapper::GraphicImport::lcl_attribute(...)
    $writerfilter::ooxml::OOXMLPropertySet::resolve(...)
    ...

⚠ **対照群**(同じ一式で `.odt` を渡した回)では、この worker に stack が**無い**
── 取り込みが終わって消えている。差は 1 本ぶん、しかも 1 枚の stack である。

## なぜ永久に待つのか(上流を読んだ。推測で書いていない)

`vcl/source/app/scheduler.cxx:280-299`:

    Scheduler::IdlesLockGuard::IdlesLockGuard()
    {
        ...
        osl_atomic_increment(&rSchedCtx.mnIdlesLockCount);
        if (!Application::IsMainThread())
        {
            pSVData->m_inExecuteCondtion.reset();
            Application::PostUserEvent({});
            SolarMutexReleaser releaser;
            pSVData->m_inExecuteCondtion.wait();      <- ここで待つ
        }
    }

待っている `m_inExecuteCondtion` を **set する場所は上流全体で 1 か所しかない**
(`vcl/source/app/svapp.cxx:366`)。そしてそれは、

    void Application::Execute()
    {
        if (!pSVData->mpDefInst->DoExecute(nExitCode))    <- 偽のときだけ中へ入る
        {
            ...
            while (!mbAppQuit)
            {
                Application::Yield();
                SolarMutexReleaser releaser;
                pSVData->m_inExecuteCondtion.set();       <- 唯一の set
            }
        }
        ...
    }

つまり **`DoExecute()` が偽を返す構成でしか set されない**。ところが wasm では:

- `vcl/qt5/QtInstance.cxx:343-347` ── `__EMSCRIPTEN__` かつ JSPI 無しなら
  `m_bUseSystemLoop = true` を**無条件で**立てる
- `vcl/qt5/QtInstance.cxx:831-847` ── `DoExecute()` は `m_bUseSystemLoop` を
  そのまま返す(真)。しかも `QApplication::exec()` は emscripten では
  **JS 例外でスタックを巻き戻して戻ってこない**(`O3TL_UNREACHABLE`)

⇒ **`m_inExecuteCondtion` は一度も set されない。**
⇒ メインスレッド以外から `IdlesLockGuard` を作ると、**必ず永久に待つ。**

🔑 **これは画像固有の欠陥ではない。** 画像入り docx は
`SwXShape::dispose()` 経由でたまたまこの門を踏むだけで、
**メインスレッド外で `IdlesLockGuard` を作る経路はすべて同じ形で止まる**。
#199 の全数表(VML は開く / media 無しは開く / xlsx は開く / odt は開く)は、
**「その経路がこの門を踏むかどうか」1 つで全部説明が付く。**

## 直し ── 「決して満たされない条件」を待たない

システムのイベントループで走っている構成では、待っている条件は
**原理的に set されない**。だから待たない ──
`mnIdlesLockCount` の増加(= idle を走らせない、という当の目的)はそのまま残す。

⚠ **何を失うかを書いておく。** 上流のコメントが言う目的は
「ネストしたイベントループの中で、走っている idle が何かを待っている最中に
この錠が効いてしまうのを防ぐ」である。待たないと、その一瞬に錠が効きうる。
🔑 ただし**天秤の反対側は「必ず永久に固まる」**であって、比べる余地は無い。

⚠ **`Application::IsMainThread()` の側は触らない** ── メインスレッドから作った
ときは元から待たない(`if` の外)。変えるのは**待つ側の枝だけ**である。

## 確かめ方

    node build/office-wasm/open-doc-probe.mjs <pack> /tmp/img.docx /tmp/r.json 90

`opened` が付けば直っている(直す前は 780 秒でも付かない)。
🔑 **対照群を同じ腕で回す**(`.odt` / 画像なしの docx)── どちらも開き続けること。
"""

import sys
from pathlib import Path

SRC = "vcl/source/app/scheduler.cxx"

# ⚠ 錨は**実行する行のかたまり**。関数まるごとにしない(上流が前後を変えても当たる)。
ANCHOR = """        pSVData->m_inExecuteCondtion.reset();
        // Put an empty event to the application's queue, to make sure that it loops through the
        // code that sets the condition, even when there's no other events in the queue
        Application::PostUserEvent({});
        SolarMutexReleaser releaser;
        pSVData->m_inExecuteCondtion.wait();
"""

REPLACE = """        // ── PKC3 #199: システムのイベントループでは、この条件は決して set されない ──
        // m_inExecuteCondtion を set するのは Application::Execute() の中の
        // `if (!DoExecute(...))` の枝だけ(上流全体で 1 か所)。ところが Emscripten の
        // Qt6 は m_bUseSystemLoop=true を立てるので DoExecute() は真を返し、その枝へ
        // 入らない。つまりここで待つと**必ず永久に固まる**(画像入り docx が開かない
        // 実害として出ていた)。錠そのもの(mnIdlesLockCount)は上で立てているので、
        // 「idle を走らせない」という目的は待たなくても果たせる。
        if (!Application::IsUseSystemEventLoop())
        {
            pSVData->m_inExecuteCondtion.reset();
            // Put an empty event to the application's queue, to make sure that it loops through
            // the code that sets the condition, even when there's no other events in the queue
            Application::PostUserEvent({});
            SolarMutexReleaser releaser;
            pSVData->m_inExecuteCondtion.wait();
        }
"""

MARK = "PKC3 #199: システムのイベントループでは"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-idles-lock.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")
    # ⚠ 二重当てを止める(冪等ではない ── if が入れ子になる)
    if MARK in text:
        print(f"ERROR: {SRC} に既に直しが入っている(二重当て)", file=sys.stderr)
        return 1
    hits = text.count(ANCHOR)
    if hits != 1:
        print(
            f"ERROR: 錨が {hits} 件({SRC})── 上流が形を変えた。当て先を読み直すこと",
            file=sys.stderr,
        )
        return 1
    path.write_text(text.replace(ANCHOR, REPLACE), encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は
    #    全部通り、CI 全緑のまま直しが artifact に 1 バイトも入らない)
    if MARK not in path.read_text(encoding="utf-8"):
        print(f"ERROR: 書き戻し後の {SRC} に直しが無い(write が落ちている)", file=sys.stderr)
        return 1
    print(f"patched: {SRC}(#199 の直し ── 決して満たされない条件を待たない)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
