#!/usr/bin/env python3
"""#225 の**計装**。非 ODF(alien)の保存が、どの段で落ちているかを割る。

🔴 **既定では 1 バイトも書き換えない**(`PKC3_SAVE_TRACE=1` の回だけ入る)。
⚠ ただし**錨の検査は毎回する** ── 門の下に隠すと、上流が形を変えたときに誰も気づけない
  (`patch-lo-ime-trace.py` と同じ作法)。

## ここまでに分かっていること(#225。実測)

同じ腕・同じ打鍵で 8 通り回した結果、**ODF 3/3 が通り、非 ODF 5/5 が落ちる**
(Writer / Calc / Impress の 3 モジュールとも):

    .odt .ods .odp  → ✅ bytes が増える
    .rtf .doc .docx .xlsx .pptx → 🔴 増えない(4 つは「一般的な I/O エラー」の窓が出る)

⚠ **形式ごとの話ではない** ── `.rtf`(zip ですらない)まで落ち、`.odt`(zip)は通るので、
Word 系フィルタの問題でも zip の問題でもない。

そして「一式に入っていない」型でもない(3 段とも全数で確認済み):
定義(`writer.xcd` に `Flags = IMPORT EXPORT ALIEN …`)/ 登録(`services.rdb` に
`com.sun.star.comp.Writer.WriterFilter`)/ 実体(`soffice.wasm` に `DocxExport`)。

## 🔴 なぜ計装が要るか ── 既存の口が全部死んでいる

| 口 | なぜ使えないか |
|---|---|
| `SAL_WARN` | **焼かれていない**(`ENABLE_SAL_LOG` を渡していない。実物に area 文字列 0 件) |
| `--convert-to` の probe | **対照群(odt)も 0 バイト** ── この一式で命令行の変換経路が動かない |
| `/tmp` の全数走査 | 在る 1 件は**起動直後から在り**、保存で動かない = 保存用の一時ファイルではない |
| 窓の文言 | `ERRCODE_IO_GENERAL` 止まり ── **設定箇所が上流に 20 か所以上ある** |

🔑 だから**エラーが立つ瞬間**を捕まえる。`SfxMedium::SetError` は
**すべての error が通る 1 つの漏斗**である(`sfx2/source/doc/docfile.cxx:554`)。

## 何を読むか(3 点。⚠ これで層が一意に決まる)

    PKC3-SAVE n medium:error a=<errcode>       ← 立った瞬間。**順番**が効く
    PKC3-SAVE n alien:export a=<ok> b=<starone> c=<errcode>
    PKC3-SAVE n medium:commit a=<ok> b=<errcode>

| 読み | 意味 |
|---|---|
| `alien:export a=0` | **書き出しフィルタの中で落ちている** ── 直す場所は writerfilter / oox |
| `alien:export a=1` かつ `medium:commit a=0` | 書き出しは通り、**行き先へ移す所**で落ちている(UCB / MEMFS) |
| `medium:error` が `alien:export` より**前** | 保存に入る前に既に error が立っている(前提が違う) |

⚠ **`a=1` / `a=0` だけで因果を言わない** ── 対照群(`.odt`)を同じ腕で回し、
そちらの並びと突き合わせてから読む(CLAUDE.md §4)。

## ⚠ 当て先が 2 file なので、ヘルパーは 2 つ入る

`static` なので TU ごとに 1 つ持つ(counter も別々)。上限を置く ──
保存は何度も走るので、置かないと log が膨らむ。
"""

import os
import sys
from pathlib import Path

# ⚠ libc だけを使う。embind / DOM / Qt の API をここから呼んではいけない
#    (LO の文脈から `emscripten::val` を触ると `invalid handle` で abort する ── 2026-08-15)。
# 🔴 **文字列手術で組み立てない**(2026-08-24 に踏んだ)。
# ⚠ 1 稿目は `HELPER.replace("}\n}\n", ...)` で msg 版を作ったが、`HELPER` の中に
#   その形が**複数ある**(内側の `if (pLog) {}` と関数の閉じと namespace の閉じ)ので
#   Python の `str.replace` が**全部**に当たり、`pkc3_save_msg` が **2 回定義**された
#   ── **再定義エラーでコンパイル不能**。⚠ 検査は最初の 1 件しか見ないので素通りした。
# 🔑 だから**部品から組む**。同じ形が何回出ようと関係ない。
HELPER_OPEN = """
// ── PKC3 #225 の計装(挙動は変えない。`PKC3_SAVE_TRACE=1` の回だけ入る)──
#include <cstdio>
namespace
{
"""
HELPER_TRACE_FN = """void pkc3_save_trace(const char* what, int a, int b, int c)
{
    static int nSeq = 0;
    if (nSeq >= 400)
        return;
    ++nSeq;
    char line[192];
    // ⚠ 書式はリテラル(`-Wformat-nonliteral` を踏まない)
    std::snprintf(line, sizeof line, "PKC3-SAVE %d %s a=%d b=%d c=%d\\n", nSeq, what, a, b, c);
    std::fputs(line, stderr);
    std::fflush(stderr);
    // 🔑 本命の出口 ── probe が `window.__lo.FS.readFile()` でまとめて読む
    std::FILE* pLog = std::fopen("/tmp/pkc3-save.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}
"""
# 🔴 **message を出すのは、使う TU にだけ**(呼ばない file で `-Wunused-function` を踏む)。
# ⚠ **`OUStringToOString` を使わない** ── `objserv.cxx` に用例が 0 件で、include が
#   届いているか確かめられなかった。`OUString::toUtf8()` は `rtl/ustring.hxx` の
#   メンバなので**必ず在る**(推測で API を渡さない)。
# ⚠ 非 ASCII は `?` へ落とす ── log に本文らしきものを出さない。
HELPER_MSG_FN = """void pkc3_save_msg(const char* what, const OUString& rMsg)
{
    const OString aUtf8 = rMsg.toUtf8();
    char safe[224];
    const char* p = aUtf8.getStr();
    std::size_t k = 0;
    for (; k + 1 < sizeof safe && p[k] != '\\0'; ++k)
    {
        const unsigned char u = static_cast<unsigned char>(p[k]);
        safe[k] = (u >= 0x20 && u < 0x7f) ? p[k] : '?';
    }
    safe[k] = '\\0';
    char line[320];
    std::snprintf(line, sizeof line, "PKC3-SAVE msg %s [%s]\\n", what, safe);
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-save.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}
"""
HELPER_CLOSE = """}
"""
HELPER = HELPER_OPEN + HELPER_TRACE_FN + HELPER_CLOSE
HELPER_MSG = HELPER_OPEN + HELPER_TRACE_FN + HELPER_MSG_FN + HELPER_CLOSE

# ── ① error が立つ瞬間(すべての error が通る 1 つの漏斗)────────────────
MEDIUM_SRC = "sfx2/source/doc/docfile.cxx"
MEDIUM_ANCHOR = """void SfxMedium::SetError(const ErrCodeMsg& rError)
{
    if (pImpl->m_eError == ERRCODE_NONE || (pImpl->m_eError.IsWarning() && rError.IsError()))
        pImpl->m_eError = rError;
}
"""
MEDIUM_REPLACE = (
    HELPER
    + """
void SfxMedium::SetError(const ErrCodeMsg& rError)
{
    // 🔑 **採るのは「立った瞬間」** ── 後から `GetError()` で読むと、最初に立った
    //    error が後の error に上書きされていても分からない(下の if がまさにそれを守る)。
    // ⚠ b は「この呼び出しが実際に採用されたか」── 0 なら**既に別の error が立っている**。
    pkc3_save_trace("medium:error", static_cast<int>(static_cast<sal_uInt32>(rError.GetCode())),
                    (pImpl->m_eError == ERRCODE_NONE
                     || (pImpl->m_eError.IsWarning() && rError.IsError()))
                        ? 1
                        : 0,
                    static_cast<int>(static_cast<sal_uInt32>(pImpl->m_eError.GetCode())));
    if (pImpl->m_eError == ERRCODE_NONE || (pImpl->m_eError.IsWarning() && rError.IsError()))
        pImpl->m_eError = rError;
}
"""
)

# ── ② 非 ODF の書き出しそのもの ────────────────────────────────────────
STORE_SRC = "sfx2/source/doc/objstor.cxx"
EXPORT_ANCHOR = """        // it's a "SaveAs" in an alien format
        if ( rMedium.GetFilter() && ( rMedium.GetFilter()->GetFilterFlags() & SfxFilterFlags::STARONEFILTER ) )
            bOk = ExportTo( rMedium );
        else
            bOk = ConvertTo( rMedium );
"""
EXPORT_REPLACE = (
    """
        // it's a "SaveAs" in an alien format
        // ⚠ **どちらの枝を通ったかも採る**(b)── ExportTo と ConvertTo は別の層である
        const bool bPkc3StarOne
            = rMedium.GetFilter()
              && ( rMedium.GetFilter()->GetFilterFlags() & SfxFilterFlags::STARONEFILTER );
        if ( bPkc3StarOne )
            bOk = ExportTo( rMedium );
        else
            bOk = ConvertTo( rMedium );
        pkc3_save_trace("alien:export", bOk ? 1 : 0, bPkc3StarOne ? 1 : 0,
                        static_cast<int>(static_cast<sal_uInt32>(
                            rMedium.GetErrorIgnoreWarning().GetCode())));
"""
)

# ── ③ 行き先へ移す段 ──────────────────────────────────────────────────
COMMIT_ANCHOR = """        const OUString sName( rMedium.GetName( ) );
        bOk = rMedium.Commit();
        const OUString sNewName( rMedium.GetName( ) );
"""
COMMIT_REPLACE = """        const OUString sName( rMedium.GetName( ) );
        bOk = rMedium.Commit();
        pkc3_save_trace("medium:commit", bOk ? 1 : 0,
                        static_cast<int>(static_cast<sal_uInt32>(
                            rMedium.GetErrorIgnoreWarning().GetCode())),
                        -1);
        const OUString sNewName( rMedium.GetName( ) );
"""

ENTRY_ANCHOR = """{
    SAL_INFO( "sfx.doc", "saving \\"" << rMedium.GetName() << "\\"" );

    UpdateDocInfoForSave();
"""
ENTRY_REPLACE = """{
    SAL_INFO( "sfx.doc", "saving \\"" << rMedium.GetName() << "\\"" );
    // 🔴 **そもそも呼ばれたか**(#225 の 2 巡目)── 1 巡目は alien の枝も
    //    `SfxMedium::SetError` も 0 件だったので、**ここへ来ているのかが未確定**だった。
    pkc3_save_trace("saveto:enter", -1, -1, -1);

    UpdateDocInfoForSave();
"""

# ── ④ shell 側の error の漏斗(medium ではない)────────────────────────
SHELL_SRC = "sfx2/source/doc/objmisc.cxx"
SHELL_ANCHOR = """void SfxObjectShell::SetError(const ErrCodeMsg& lErr)
{
    if (pImpl->lErr == ERRCODE_NONE || (pImpl->lErr.IsWarning() && lErr.IsError()))
    {
        pImpl->lErr=lErr;
    }
}
"""
SHELL_REPLACE = (
    HELPER
    + """
void SfxObjectShell::SetError(const ErrCodeMsg& lErr)
{
    // 🔴 1 巡目で `SfxMedium::SetError` は 0 件だった ── **shell 側の漏斗**を見る
    pkc3_save_trace("shell:error", static_cast<int>(static_cast<sal_uInt32>(lErr.GetCode())),
                    (pImpl->lErr == ERRCODE_NONE
                     || (pImpl->lErr.IsWarning() && lErr.IsError()))
                        ? 1
                        : 0,
                    static_cast<int>(static_cast<sal_uInt32>(pImpl->lErr.GetCode())));
    if (pImpl->lErr == ERRCODE_NONE || (pImpl->lErr.IsWarning() && lErr.IsError()))
    {
        pImpl->lErr=lErr;
    }
}
"""
)

# ── ⑤ 例外で来ているか(**message が読める唯一の場所**)────────────────
SERV_SRC = "sfx2/source/doc/objserv.cxx"
SERV_ANCHOR = """            catch( Exception& e )
            {
                nErrorCode = { ERRCODE_IO_GENERAL, e.Message };
            }
"""
SERV_REPLACE = """            catch( Exception& e )
            {
                // 🔴 **ここに来ているなら message が読める**(#225 の 2 巡目)
                pkc3_save_msg("serv:catch", e.Message);
                nErrorCode = { ERRCODE_IO_GENERAL, e.Message };
            }
"""

# 🔴 **ヘルパーは file scope へ入れる。関数の中に入れてはいけない**(2026-08-24 に踏んだ)。
#
# ⚠ `objstor.cxx` の錨は `SaveTo_Impl` の**中**に在るので、`HELPER + 本体` を 1 つの錨に
#   当てると、名前空間スコープの関数定義が関数本体の内側へ入り **コンパイル不能**になる。
#   ⚠ patch は「当たった」と報告するので、**生成された C++ を検めるまで気づけない**
#   (焼いて 2 時間後に赤で分かる形だった)。
# 🔑 錨を **2 段**に分ける ── ヘルパーは**関数定義の直前**、本体は中。
# 🔑 検算は `build/office-wasm/check-patch-scope.py`(錨を変えたら必ず走らせる)。
# ⚠ `docfile.cxx` の錨は関数まるごとなので、そちらはこの表に入れない
#   (`MEDIUM_REPLACE` が既に HELPER を持っている = file scope)。
HELPER_TARGETS = (
    (STORE_SRC, "bool SfxObjectShell::SaveTo_Impl\n(\n", HELPER),
    # ⚠ objserv だけ msg 版(例外の message を読むのはここだけ)
    (SERV_SRC, "void SfxObjectShell::ExecFile_Impl(", HELPER_MSG),
)
# ⚠ **同じ file の中では、ヘルパーを入れる方を先に当てる**(後の置換はヘルパーを持たない)。
TARGETS = (
    (MEDIUM_SRC, MEDIUM_ANCHOR, MEDIUM_REPLACE, "medium:error"),
    (STORE_SRC, ENTRY_ANCHOR, ENTRY_REPLACE, "saveto:enter"),
    (STORE_SRC, EXPORT_ANCHOR, EXPORT_REPLACE, "alien:export"),
    (STORE_SRC, COMMIT_ANCHOR, COMMIT_REPLACE, "medium:commit"),
    (SHELL_SRC, SHELL_ANCHOR, SHELL_REPLACE, "shell:error"),
    (SERV_SRC, SERV_ANCHOR, SERV_REPLACE, "serv:catch"),
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-save-trace.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    on = os.environ.get("PKC3_SAVE_TRACE") == "1"

    # ⚠ **錨の検査は門の外でやる**(門の下に隠すと上流の変形に誰も気づけない)。
    # ⚠ 同じ file を 2 回触るので、**検査は「当てた後の姿」で数える**必要がある ──
    #    だから読み込みを 1 度にして、in-memory で順に当てる。
    texts: dict[str, str] = {}
    # ⚠ ヘルパーの当て先も**同じ厳しさ**で見る(外れると「呼ぶ側だけ在る」= リンク不能)
    for src, anchor, _h in HELPER_TARGETS:
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        hits = path.read_text(encoding="utf-8").count(anchor)
        if hits != 1:
            print(f"ERROR: ヘルパーの錨が {hits} 件({src})── 上流が形を変えた", file=sys.stderr)
            return 1
    for src, anchor, _replace, _mark in TARGETS:
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        if src not in texts:
            texts[src] = path.read_text(encoding="utf-8")
            # ⚠ 二重当ては止める(冪等ではない ── ヘルパーが 2 つ入る)
            if "pkc3_save_trace" in texts[src]:
                print(f"ERROR: {src} に既に計装が入っている(二重当て)", file=sys.stderr)
                return 1
        hits = texts[src].count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({src})── 上流が形を変えた。"
                "計装の当て先を読み直すこと",
                file=sys.stderr,
            )
            return 1

    if not on:
        print(f"skip: PKC3_SAVE_TRACE!=1(錨 {len(TARGETS)} 件 + ヘルパー {len(HELPER_TARGETS)} 件を確かめた)")
        return 0

    # ⚠ **ヘルパーを先に**(本体の置換より前)── 「呼ぶ側だけ在る」中間状態を作らない
    for src, anchor, helper in HELPER_TARGETS:
        texts[src] = texts[src].replace(anchor, helper + "\n" + anchor, 1)
    for src, anchor, replace, _mark in TARGETS:
        texts[src] = texts[src].replace(anchor, replace, 1)
    for src, text in texts.items():
        path = root / src
        path.write_text(text, encoding="utf-8")
        # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は
        #    全部通り、CI 全緑のまま計装が artifact に 1 バイトも入らない)
        if "pkc3_save_trace" not in path.read_text(encoding="utf-8"):
            print(f"ERROR: 書き戻し後の {src} に計装が無い(write が落ちている)", file=sys.stderr)
            return 1
        print(f"patched: {src}(#225 の計装)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
