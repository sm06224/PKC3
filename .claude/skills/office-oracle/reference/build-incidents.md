# Office 一式の取得・焼き・配布の事故 ── 事故の記録

> 手順は [`../SKILL.md`](../SKILL.md)。ここは**事故の記録**(日付と issue 番号つき)。
> 🔑 読む条件:「この箱では取れない」と書こうとした瞬間 / tag を組み立てる・推測する瞬間 / 焼きを dispatch する・待つ見込みを書く瞬間 /
> `qtbase-patch-*.py` を足す・変える瞬間 / 詰め込みの一覧(`.mk`)を足す瞬間。

目次:

- 🔴 「取れない」と 2 回続けて誤った結論を書いた(2026-08-17)
- 🔴 調査用の焼きは **`lo-wasm-dev` に出ない**(2026-08-30 に踏みかけた)
- 🔴 tag 名は flag から**合成される** ── 推測せず、release の本文で run を確かめる(2026-10-04)
- 🔑 Qt / LO の上流 source は **raw.githubusercontent.com から取れる**(2026-10-05 実測)
- 🔴 焼きの所要は「cache が当たるか」で **8 倍**違う ── flag の有無では読めない(2026-10-04 / 訂正 2026-10-05)
- 🔴 `qtbase-patch-*.py` を足す・変えると **Qt を焼き直す**(数時間)(2026-10-05)
- 🔴 詰め込みの命令行は **128 KiB** で切れる(2026-08-30、#591)

## 🔴 「取れない」と 2 回続けて誤った結論を書いた(2026-08-17)

⚠ 2026-08-17 に **2 回続けて誤った結論**を書いた:

1. 「Pages から取れない(`000`)/ git にも pack は無い」→ **原理的に測れない**と書いた
2. その後 `/tmp` の残骸で立ったので「**実物が残っていたから立った**」と書いた
   ── つまり「**次からは取れない**」と読める形で残した

**どちらも誤り。** 正しくは **release 資産を curl で引ける**。

## 🔴 調査用の焼きは **`lo-wasm-dev` に出ない**(2026-08-30 に踏みかけた)

`office-wasm-build.yml` は**調査用のスイッチが入ると別の tag へ出す**。
⚠ `lo-wasm-dev` を引いて「焼いたはずの物が入っていない」と読むのが罠である ──
実際、名前つきの焼きが成功した直後に `lo-wasm-dev` を引いたら
**別 run(前の焼き)の中身**が返ってきた。

## 🔴 tag 名は flag から**合成される** ── 推測せず、release の本文で run を確かめる(2026-10-04)

上の表は 2 つだけだが、実際は `office-wasm-build.yml` が **flag ごとの接尾辞をこの順で連ねる**
(`SAFE_SUFFIX`、1045〜1054 行):`-safeheap` → `-names`(`profiling_funcs`)→ `-imetrace` → `-savetrace` →
`-idlestrace` → `-schedtrace` → `-cliptrace`(`clip_trace`)→ `-menutrace`(`menu_trace`)→ `-uevtrace`(`uev_trace`)。
tag は **`lo-wasm` + 接尾辞**(例: `lo-wasm-names-cliptrace-menutrace`)で、**全部 OFF のときだけ `lo-wasm-dev`**。
⚠ 2026-10-04 に **`lo-wasm-dev-menutrace`**(`dev` に接尾辞を足した形)を引いて **404** を踏んだ ──
`dev` は「全部 OFF」の名前であって、接尾辞の前置きではない。
🔑 **tag を推測しない。** `mcp__github__get_release_by_tag` の body(「run NNN / commit SHA」)で
**その run の物か**を確かめてから zip を落とす(落とした後は上の `build-info.json` の `run_id`)。

## 🔑 Qt / LO の上流 source は **raw.githubusercontent.com から取れる**(2026-10-05 実測)

`curl -sSL --cacert /root/.ccr/ca-bundle.crt https://raw.githubusercontent.com/qt/qtbase/6.9/src/corelib/kernel/qeventdispatcher_wasm.cpp`
が **200 / 22 KB**。🔑 **「Qt 側は読めない」と書く前に取る**(`../SKILL.md`「取れないと書く前に」と同じ向き)。
#1344 では Qt の dispatcher の `qt_asyncify_resume_js` の **`suspendId` 照合**(入れ子 suspend で
**外側の frame の起こしを捨てる**)を、**この file の 20 行**で確定できた。
⚠ scratchpad に置いた写しは**箱が作り直されると消える** ── 根拠にするなら
**fixture として test に入れる**(`tests/fixtures/qtbase/qeventdispatcher_wasm.cpp`)。
⚠ 枝(`6.9`)は焼きの `qt_ref` と**揃える**(違う枝を読んで確定すると、焼いた物と別の source を根拠にする)。

## 🔴 焼きの所要は「cache が当たるか」で **8 倍**違う ── flag の有無では読めない(2026-10-04 / 訂正 2026-10-05)

| 焼き | 所要(観測点) |
|---|---|
| 計装 flag(`profiling_funcs` / `clip_trace` / `menu_trace` / `uev_trace`)つき、続けて焼いた回 | **23〜35 分**(run 37222907850 = 23 分 / run 37246370234 = 29 分) |
| flag 全 OFF(配布用、tag `lo-wasm-dev`)── 2026-10-04 | 🔴 **3h49m**(run 37205634760、make 14:02→17:51Z) |
| flag 全 OFF(配布用)── 2026-10-05、計装つきの焼きの直後 | 🟢 **35 分**(run 37250135375、01:07→01:42Z) |

⚠ 2026-10-04 の版のこの節は「**flag を全部外すと Qt6 の cache も外れて約 4 時間**」と書いていた ──
🔴 **翌日の実測で外れた**(同じ flag 全 OFF が 35 分)。4 時間だったのは **flag のせいではなく、
その日の cache が別の理由で外れていた**(何が鍵かは未確定 ── 推測を書かない)。
🔑 **読み方**:所要は **cache が当たるか**で決まり、それは事前には読めない。だから
① 焼いたら **run の `make` step の時刻**で「暖かかったか」を記録する(23〜35 分 = 当たり / 3〜4 時間 = 外れ)
② check-in は **45 分**で張り、外れていたら 45 分ごとに再 arm する(待っている間は別の仕事をする)
③ 「検証は計装つき → OK なら配布用」の **2 段**はそのまま正しい ── 理由は速さではなく
**計装の印で直りを読んでから配る**ためである。

## 🔴 `qtbase-patch-*.py` を足す・変えると **Qt を焼き直す**(数時間)(2026-10-05)

Qt の cache 鍵は **`hashFiles('build/office-wasm/qt-wasm-configure.args', 'build/office-wasm/qtbase-patch-*.py')`**
(`office-wasm-build.yml` の `key:`。`qt-…` と `ccache-lo-qt6-…` の 2 種)。
`patch-lo-*.py` は **LO の** patch なので Qt の cache は当たったまま(23〜35 分)。
🔑 だから **Qt 側の直しは 1 焼きに束ねる** ── 2 本を別々に焼くと **Qt を 2 回建てる**。
⚠ 束ねる前に `qtbase-patch-*.py` の既存の名前を `ls` する(足した file も**変えた file も**鍵を動かす)。

⚠ **2026-10-07 訂正: 鍵に hash は無い**(`office-wasm-build.yml` の :267 は `ccache-lo-qt6-nd-${{ inputs.qt_ref }}-${{ github.sha }}`。
`-nd-` の depend mode を切った鍵で、Qt の patch を触っても LO の ccache は復元される)。下の段落は 2026-10-05 時点の記述として残す。
🔴 **`ccache-lo-qt6-…` は LO の compile cache である ── 同じ hash を含むので、Qt の patch を触ると
LO 側もほぼ全量 compile になる**(2026-10-05 実測、#1344)。上の「Qt を焼き直す」は **Qt だけではない**。
観測点:run 37267668276(main 4e57bd4f、`qtbase-patch-asyncify-nested.py` を足した直後)──
Qt host 15 分 + Qt wasm 11 分 + **LO make 3 時間 37 分**(06:00:56Z → 09:38:22Z)、**合計 4 時間 15 分**。
`ccache を復元` step は **1 秒で終わっている**(= 何も復元していない)。
鍵は `office-wasm-build.yml` 255 行
`ccache-lo-qt6-${{ inputs.qt_ref }}-${{ hashFiles('build/office-wasm/qt-wasm-configure.args', 'build/office-wasm/qtbase-patch-*.py') }}-${{ github.sha }}`、
`restore-keys` も**同じ hash までしか遡らない**(`CCACHE_DEPEND` の罠のため**意図的** ── 同 file 240〜247 行のコメント)。
🔑 **qtbase patch の変更は 1 回の焼きに束ねる**(v1 → v2 のように 2 回焼くと **8 時間半**)。
🔑 見込みは **「Qt 26 分 + LO 3.6 時間」**と書く(Qt だけの 26 分と書くと、待つ時間を桁で外す)。
⚠ 上の 2026-10-04 の「flag 全 OFF の焼きが 3h49m」は、この鍵が動いた(`qtbase-patch-backspace` などの追加)ことが
**原因だった可能性**があるが、**未確認**(推測。その run の cache 復元が一致だったかを見れば決着する)。

🔑 Qt の patch の一覧(2026-10-07 時点で 6 本):`asyncify-nested`(#1344)/ `backspace`(#433)/ `ime-panel` / `inputcontext` /
`ecmastring-threadsafe`(#1394。`qcore_wasm.cpp` の関数内 static な `emscripten::val` を、main と pthread の両方から
呼ばれても `invalid handle` にならないよう毎回 `module_property` を取る形へ。test は `tests/office-ecmastring-threadsafe-patch.test.ts`)/
`wake-async`(#1408。`wakeEventDispatcherThread()` の resume の依頼を、別スレッドからは `runOnMainThreadAsync` に ──
同期だと main の SolarMutex の busy-wait と相互待ちになる。Qt 6.10 も別スレッドからの起こしは非同期(main からも非同期だが、ここでは main は従来どおり同期のまま)。⚠ `asyncify-nested` の**後**にしか当たらない
(錨が 3 行)。test は `tests/office-wake-async-patch.test.ts`)。

🔑 **emsdk への patch**(Qt の patch ではない。本数の pin に載らない名前 `emsdk-patch-*`):`build/office-wasm/emsdk-patch-proxying.py`(#1408)。
emscripten 4.0.10 の `system/lib/pthread/proxying.c` の `emscripten_proxy_finish` を、`pthread_cond_signal` → `pthread_mutex_unlock`
の順へ(`cancel_ctx` も同じ順。5.0.5 の #26582 と同じ。unlock の後だと、待つ側が先に起きて捨てた condvar を signal しに行って固まる)。
workflow は patch の後に **cache の `libc-mt*.a` / `libc_optz-mt*.a` を消す**(proxying.c は libc の archive に入っていて、cache に在れば作り直されない。
消せば最終 link が build する)。make の後に「patch より新しいか」を診断で出す。test は `tests/office-proxying-patch.test.ts`。

## 🔴 詰め込みの命令行は **128 KiB** で切れる(2026-08-30、#591)

焼きが `make` の 15 分で落ち、こう出た:

```
make[1]: *** [static/CustomTarget_emscripten_fs_image.mk:1985: … ] Error 127
```

⚠ **`Error 127` を「command not found」と読まない。** 実体は
**`/bin/sh: Argument list too long`** で、make はこれを 127 で報告する。

### なぜ起きるか

上流の recipe は `--preload $(shell cat $^)` と書く ── **make が展開する**ので
**数千の path が recipe の行にそのまま並ぶ**。recipe は `&&` / `||` を含むので
make は `/bin/sh -c "<行まるごと>"` で起動する = **行全体が 1 引数**。

🔑 ここで効くのは `ARG_MAX`(約 2MB)ではなく **`MAX_ARG_STRLEN` = 128 KiB**
(1 引数の上限)である。⚠ **この違いを知らないと「件数が少ないから関係ない」と
読み違える**(実際に 1 度そう判断して、正解を自分で潰した)。

### 余裕を数える(足す前に)

```bash
python3 -c "
import json; d=json.load(open('<pack>/soffice.data.js.metadata'))
n=[f['filename'].lstrip('/') for f in d['files']]
b=sum(len(x)+1 for x in n)
print(f'{len(n):,} file / {b:,} byte / 128KiB まで残り {131072-b:,}')"
```

実測(LO 47104c82): **1,993 file = 130,251 byte ── 残り 821 byte しか無い**。
⚠ **1 file 平均 65 byte なので、13 file 足せば溢れる。**

### 直っている形(`patch-lo-fsimage-cmdline.py`)

    --preload $(shell cat $^)   →   --preload $$(cat $^)

展開を **make から shell へ移す** ── recipe の行が短いままなので、上限が
`ARG_MAX`(約 2MB)側になる。⚠ 語の分割は変わらない(`$(shell …)` の出力も
shell が分割していた)。

### 🔑 手元で確かめる(30 秒。焼かなくてよい)

```bash
cd /tmp && for n in 129000 133000; do
  printf 'all:\n\t@cd . && /bin/true %s || echo fallback\n' "$(head -c $n < /dev/zero | tr '\0' x)" > Mk
  make -f Mk >/dev/null 2>&1; echo "$n -> exit=$?"
done
# 129000 -> exit=0 / 133000 -> exit=2(`Argument list too long` / Error 127)
```

⚠ **診断の grep はこの行を拾わない** ── `Argument list too long` には
`error:` も `***` も無い。だから workflow の診断に「**落ちた行の手前 80 行**」を
出す段を置いてある(2026-08-30)。**型に当たらないエラーこそ読みたい。**
