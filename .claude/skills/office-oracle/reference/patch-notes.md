# LibreOffice / Qt / Emscripten への patch の記録 ── 時系列 ── 事故の記録

> 手順は [`../SKILL.md`](../SKILL.md)。ここは**事故の記録**(日付と issue 番号つき)。
> 🔑 読む条件:`build/office-wasm/patch-lo-*.py` / `qtbase-patch-*.py` / `emsdk-patch-*.py` を足す・変える瞬間 /
> wasm の停止(`memory access out of bounds` / `unaligned accesses` / 無言の固まり)の原因を読む瞬間。
> ⚠ 各節の「焼く前」は**書いた日の状態**である。その後の焼きの結果は各 issue(#1344 / #1393 / #1396 / #1402 / #1408 / #1429)で確かめる ── ここは更新していない。

目次:

- 🔴 LO の直しは **「文書が開くか」を最初の門にする**(2026-10-04、#121 / PR #1342 → #1343)
- 🔴 JSPI の suspend は **LIFO で起こす** ── Emscripten の C stack は 1 本(2026-10-05、#1344 v1 → v2)
- 🔑 **Emscripten の library JS も、焼いた `soffice.js` を置換して直せる**(2026-10-05、#1344 (a')。PR #1358)
- 🔴 同じ上流 file を触る patch は、**どの順でも出力が同一**であることを test で pin する(2026-10-05)
- 🔴 #1393 / #1396 の LO 側の直し 3 本(2026-10-07。⚠ 焼く前 ── 効くかは未測定)
- 🔴 #1393 形 B の門 `patch-lo-tooltip-guard.py`(2026-10-07。⚠ 焼く前 ── 門は**ぶら下がりを捕まえない**)
- 🔴 #1402 の印と null 門 `patch-lo-grip-guard.py`(2026-10-07。⚠ 直しではなく**主に印**)
- 🔴 #1393 / #1396 / #117 の原因側の直し `patch-lo-timer-mutex.py`(2026-10-07。⚠ 焼く前 ── 🟡 推測。塞ぐのは**半分だけ**)
- 🔴 #1408 の印 `patch-lo-yield-wait.py`(2026-10-07。⚠ 焼く前 ── **直しではなく印**。行き先は 🟡 推測)
- 🔴 #1402 の閉じた直後の停止 ── 計装 3 本 `patch-lo-surface-trace.py` / `patch-lo-sdpr-trace.py` / `patch-lo-gfxdata-trace.py`(2026-10-07。⚠ 焼く前 ── **直しではなく印**。行き先は 🟡 推測)
- 🔴 #1408 (c) の直し `patch-lo-hop-borrow.py`(2026-10-08。35 本目。⚠ 焼く前 ── 🟡 推測ではなく**実測した stack への直し**。効いたかは次の節の焼き)
- 🔴 #1408 (c) を焼いた結果と副作用 ── 固まりは消え、main の待ちが長くなった(2026-10-08、#1429)

## 🔴 LO の直しは **「文書が開くか」を最初の門にする**(2026-10-04、#121 / PR #1342 → #1343)

> ⚠ **この節の `patch-lo-yield-proxy-guard.py`(PR #1342)は revert 済み ── main に無い。** 以下はなぜ revert したかの記録である。

PR #1342(`patch-lo-yield-proxy-guard.py`:main thread の入れ子 `Yield` で user event を dispatch しない)は
**unit・変異試験・コンパイルを全部通った**のに、焼いたら **文書が 1 件も開かなかった**
(run 37239228503 の probe:全腕が判定不能、「印」が**起動 7 秒**で出ていた)。
原因:**読み込み中の入れ子 `Yield` も user event を処理しており、それが進行に必要**だった ──
検査は「止めたい経路が止まるか」しか見ておらず、**止めてはいけない経路**(読み込み)を 1 つも通っていなかった。
🔑 **probe の判定表には、まず対照群 C(文書が開いて、外へ字が出る)を置く** ── C が落ちた回は
**他の腕の結果を 1 つも読まない**(§6、CLAUDE.md §4「対照群が届かない回は判定不能」)。
🔑 **直しは「広い門」より「落ちる 1 か所だけ」** ── PR #1343 は `ImplHandleExtTextInput` の**1 か所**を
Emscripten のときだけ `break` にした。広い門は、**計装で見えていない経路まで一緒に止める**。
⚠ #1342 は revert した(`patch-lo-yield-proxy-guard.py` は main に無い)。

## 🔴 JSPI の suspend は **LIFO で起こす** ── Emscripten の C stack は 1 本(2026-10-05、#1344 v1 → v2)

1. **Emscripten 4.0.10 `src/lib/libasync.js` の JSPI(`ASYNCIFY=2`)は、export を
   `Asyncify.makeAsyncFunction` = `WebAssembly.promising(original)` で包むだけ**で、C の shadow stack pointer の
   **保存も復元もしない**(2026-10-05 に raw.githubusercontent.com から読んだ)。
   🔴 だから **suspend した stack が 2 本在るとき、外側を先に起こすと、外側の関数の return が sp を内側の frame より
   上へ戻し、以後の呼び出しが内側の frame を踏む**。起こす順は **LIFO**(内側が JS へ戻ってから外側)でなければならない。
2. 🔑 **壊れ方の署名**:`RuntimeError: operation does not support unaligned accesses`(V8 の unaligned atomic の trap)が、
   **壊れた object の atomic store を踏む所**(#1344 では `QEventLoop::exit(int)` ← `QMenu::hideEvent`)で出る。
   **その数 ms 前に外側が返っている**(`PKC3-UEV wait-out`)。
   この署名を見たら **「壊れた番地 = LIFO 違反」を第一容疑**にする。観測点:run 37267668276 の probe
   (scratchpad 121k)、B2 / B2w の **9 回全部**。
3. 🔴 **v2 の焼き(run 37303396759)で同じ署名が再発した**(B2w 8 round 中 2 round。B2 / B2k / C は全部通った)。
   trap round の uev trace:項目を押した瞬間に **LO main loop(`ImplYield`、nest=1)の `wait-out` が `exec-ret` より前**に返り、
   直後の dispatch がメニューを閉じに行って落ちる。通った round は `exec-ret` → `PKC3-CLIP` → `wait-out` の順。
   = **メニューの計算が生きている間に main loop が起こされる**経路が、Qt 側の LIFO では閉じない。
4. 🔑 **構造(焼いた soffice.js と LO 0c031979 の原文で実測)**。推測ではなく、次の grep で数える:
   - promising export = `grep -o 'exportPattern=/[^/]*/' soffice.js` → **3 種**:`main` / `_emscripten_check_mailbox`(proxy queue の口)/
     `qstdweb::EventListener` の invoker(**DOM event の口** ── だから pointer の callback は main と別の計算として suspend できる)。
   - Suspending import = `grep -o '\w*\.isAsync=true' soffice.js` + `function __asyncjs__\w+` → **5 種**:`__asyncjs__qt_asyncify_suspend_js` /
     `emscripten_promise_await` / `emscripten_sleep` / `fd_sync` / `emscripten_idb_*`。
   - 🔴 LO `vcl/qt5/QtInstance.cxx`(JSPI 構成 `HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD`)は
     **`ProcessEvent` を `eventHandlerThread` へ proxy し、main thread は `emscripten_promise_await` で止まる**。`DoYield` の枝 B は逆向き
     (handler thread → main へ proxy。main は mailbox の計算の中で `ImplYield` → Qt の wait)。
   - だから **main thread の 1 本の shadow stack の上に、main / mailbox / DOM event の計算が、Qt の suspend と `promise_await` の
     2 種類の止まり方で積み重なる**。Qt 側の LIFO(v2)も sp の門(v3)も **Qt 側の起こし**しか見ていない ──
     `promise_await` の起こしは Emscripten の promise が直に起こすので、下で止まっている計算を踏みうる。
5. **v3(PR #1356)= sp の門**:suspend で `stackSave()` を控え、tick で同じ値へ戻るまで起こさない(Gemini Q2c)。
   `stackSave` が無ければ門なし(1 度 warn)。250 周戻らなければ `PKC3-UEV sp-defer … dir=above|unwound` を出し 100 ms に間引く。
   ⚠ **`dir=unwound`(sp が top.sp より高い = 上書きされた後)は直っていない** ── trap が診断つきの hang に変わるだけ。
   v3 の JS を v2 の一式に当てた probe は 44 round 通ったが **門が閉じた回は 0** ── 「普段を変えない」は言えても「trap を止めた」は**言えない**。
   残る手(Qt の patch で `promise_await` も同じ stack に載せる / LO の proxy をやめる / Emscripten 側)は #1344 コメント 5998799530 で Gemini に問うた。
6. 経緯と置き場:PR #1350(v1。全部起こす)→ PR #1353(v2。LIFO)→ PR #1356(v3。sp の門)。patch は
   `build/office-wasm/qtbase-patch-asyncify-nested.py`、test は `tests/office-asyncify-nested-patch.test.ts`
   (偽 `setTimeout` の台に**原本 / v1 / v2** を同じ場面で回す形 ── **対照群を 2 つ**持つ。v3 で shadow stack の模型を足した)。
   ⚠ 変異試験で**普段の経路**を通していなかった件は `mutation-testing/reference/incidents.md`「場面が『入れ子』しか無く、普段の経路を 1 度も通っていない」、模型の「止まり直し」は同「『定数と符号』を 1 つも pin していない」。

## 🔑 **Emscripten の library JS も、焼いた `soffice.js` を置換して直せる**(2026-10-05、#1344 (a')。PR #1358)

`probe-log.md`「JS だけの差分は、焼かずに…」の節は Qt の `EM_JS` だが、**LO にも Qt にも無い関数**(`_emscripten_promise_await` = Emscripten の `src/lib/libpromise.js`)も同じ ──
`--js-library` で上書きするには LO の link 行へ手を入れる必要が在り、`--post-js` では `wasmImports` に束ねられた後になる。
**焼けた `soffice.js` の字を置換する**のがいちばん確実で、手元で検めた置換(121q)と workflow の置換が**同じ script**になる。
道具は `build/office-wasm/patch-soffice-js-promise-await.mjs`(錨 = minify 後の字 1 字違わず / 印 `pkc3PaGuard`)。

🔴 **当てる先は「配る一式」である**(`workdir/installation/LibreOffice/emscripten/soffice.js`。zip はここから作る)。
`instdir/program/soffice.js` を直しても **`make instsetoo_native` が集め直す**ので、集める前に当てると素通りする ──
1 稿目はまさにその順で書いてあり、着地前レビューが拾った(CLAUDE.md §8「tripwire は直した結果が届いたかに置く」の実例)。
🔑 **集めた後に当てて、同じ file で印の出現回数を数える**(minify 後は 1 行なので `grep -c` では数えられない ── `grep -o | wc -l`)。

🔴 **錨が無いときだけでなく、`stackSave` の定義が無いときも落とす**。置換後の JS は `typeof stackSave` で保険を掛けるが、
それは**実行時に名前が届かなかったとき**の保険であって、焼いた物の検品ではない ── 検品で素通りさせると「門が黙って無くなる」形になる。
`var stackSave=()=>_emscripten_stack_get_current();` を script が要求し、fixture にも同じ 1 行を実物から写してある。

🔑 **置換は「足すだけ」にして、それを test で pin する**(足した字を抜くと錨そのものに戻る / `out.replace(REPLACEMENT, ANCHOR) === ORIG`)。
元の関数の動きを 1 字も変えていないことが、「対照 = 原文」の主張の土台になる。

### 🔑 `PKC3-UEV pa-defer` の読み方

| 行 | 意味 |
|---|---|
| `pa-defer n=1 sp=… want=… dir=above` | proxy の結果が返ったが、**上に別の計算の frame が生きている**(sp が控えより低い)ので起こさなかった。**門が効いた回** |
| `pa-defer n=250 … dir=above` | 約 1 秒(250 周)戻らない。以後 100 ms に間引く。⚠ 1 秒を超えて続くなら、上の計算が終わらない(メニューが開いたまま等)── 異常ではない |
| `pa-defer … dir=unwound` | sp が控えより**高い**= 自分の frame がもう無い。起こさない。⚠ これが出たら**別の欠陥**(v3 の `sp-defer dir=unwound` と同じ向き)── 門は守るが原因は直っていない |
| `pa-defer end n=N` | 上が返って起こした。`n=1` の対が 1 つ在ること |

🔑 **「止めた」と書けるのは `pa-defer n=1` → `end` の対が 1 件以上在り、その回の faults が 0 のとき**(121q: 18 round 中 3 round で対、faults 0)。
対が 0 件の緑は「経路を踏んでいない」でしかない(`probe-log.md` の「JS だけの差分は…」の節と同じ)。

## 🔴 同じ上流 file を触る patch は、**どの順でも出力が同一**であることを test で pin する(2026-10-05)

`patch-lo-ime-nowait.py` と `patch-lo-idles-trace.py` は**同じ `winproc.cxx`** を触る。
⚠ 「include は無ければ足す」と書くと、**当てる順で出力が変わる**(先に当てた側が足した include を
後の側が「在る」と見て足さない、またはその逆 ── 出力が当てた順に依る)。
🔑 **include は無条件に足し、印を付ける**(在るかを見ない)。そのうえで次の 3 つを test で pin する:
①**錨が交わらない**(2 つの patch の置換前の字が重ならない)②**挿入点が別**
③ **両順(A→B / B→A)で出力が同一**(`diff -r` が 0)。形は `tests/office-ime-nowait-patch.test.ts`。
⚠ 片方の patch を単独で test するだけでは、**もう片方が先に当たった版**を 1 度も通らない
(CLAUDE.md §2 の「通っていない経路」と同型)。

## 🔴 #1393 / #1396 の LO 側の直し 3 本(2026-10-07。⚠ 焼く前 ── 効くかは未測定)

JSPI の Qt backend では、レイアウトの Idle(`InterimItemWindow::m_aLayoutIdle`)が dispose / entry 操作の**途中**に main スレッドから割り込める。
`~Task` の後しか見ない #117 の直しは、この途中を塞いでいない。**別の file・別の主張**なので 3 本に分けた(1 patch = 1 主張):

| patch | 触る所 | 主張 | 印 |
|---|---|---|---|
| `patch-lo-layout-guard.py` | `InterimItemWindow::Layout()` の `Stop()` の直後 | dispose 中(`m_xContainer` 無し)は返す | `PKC3-LAYOUTGUARD:` を出す |
| `patch-lo-hscroll-hdl.py` | `~SalInstanceScrolledWindow()` | 上流の戻し忘れ(横の `ScrollHdl`)を戻す | 出さない(停止の有無で見る) |
| `patch-lo-viewdata-gone.py` | `SvTreeListBox::getPreferredDimensions` | view data の無い entry / model の無い箱を飛ばす | `PKC3-VIEWDATAGONE:` を出す |

🔑 焼いて停止の回に `PKC3-VIEWDATAGONE` が **0 回**のまま落ちたら、3 本目の推測(view data が無い瞬間)が外れている ──
`m_pModel` null か `m_pImpl` null(`iconview.cxx:144`)側へ門を足す(#1396 のコメントの「覆る条件」)。
test は `tests/office-layout-guard-patch.test.ts` / `office-hscroll-hdl-patch.test.ts` / `office-viewdata-gone-patch.test.ts`
(fixture は上流 `7f96a38cf750` の file そのままの抜粋)。

## 🔴 #1393 形 B の門 `patch-lo-tooltip-guard.py`(2026-10-07。⚠ 焼く前 ── 門は**ぶら下がりを捕まえない**)

閉じている最中に `ToolTip::maShowTimer` が main スレッドへ SolarMutex なしで発火し、`ToolTip::DoShow()`(`SlsToolTip.cxx`)が
`GetPageObjectLayouter()` を null 検査なしで使って `PageObjectLayouter::GetBoundingBox` で落ちる(30 回に 1 回)。
`!pWindow` の検査の直後に 5 つ見る門を足し、当たればそのツールチップ 1 回だけ出さず返る。印は `PKC3-TOOLTIPGUARD: DoShow skipped why=N`(**20 回まで**。上限は印だけ)。

| `why=` | 見るもの |
|---|---|
| 1 | `pWindow->isDisposed()` |
| 2 | `!pWindow->IsReallyVisible()` |
| 3 | `!mpDescriptor` |
| 4 | `!mpDescriptor->GetPage()` |
| 5 | `!…GetPageObjectLayouter()` |

🔑 **次の焼きの読み方**: 1〜5 のどれかが出て落ちない → 門が効いた(出た番号が「空だった物」)。
🔴 **どれも 0 回のまま落ちる → 門は原因に届いていない**(解放済みの `SdPage` / `PageObjectLayouter` を指したままの**ぶら下がり**は、null でも破棄済みでもないので素通りする)。
そのときは timer を dispose で止める側へ直す。害は「そのツールチップが 1 回出ない」だけ。
test は `tests/office-tooltip-guard-patch.test.ts`(fixture は上流 `d6226c1a` の `SlsToolTip.cxx` の抜粋。当て済みは **SKIP(exit 0)**)。

## 🔴 #1402 の印と null 門 `patch-lo-grip-guard.py`(2026-10-07。⚠ 直しではなく**主に印**)

Impress を開くと約 3 % で `SalGraphics::DrawPolyLine`(非 virtual の wrapper)← `OutputDevice::DrawPolygon(tools::Polygon)`(hairline)←
`SplitWindow::ImplDrawGrip` で落ちる。塗り(`DrawPolyPolygon`)が main スレッドへ hop する間に `mpGraphics` が変わりうるのに、縁を引く直前で誰も再検査しない
(`vcl/source/outdev/polygon.cxx`)。縁の直前に ① `mpGraphics` が null なら縁を引かず返る ② `before gfx=… dev=… stackfree=…` を **100 回まで**出し、
`DrawPolyLine` から戻ったら `after` を出す(旗が立った回だけ)。

🔑 **次の焼きの読み方**: `mpGraphics null after fill` が出る → null 門が効いた / `before` が出て `after` が出ないまま落ちる → 落ちたのは `DrawPolyLine` の中
(`gfx=` が前の回と違うかを見る)/ `before` が出ず落ちる → この経路ではない。
🔴 **解放済みの `SalGraphics` を指したままの `mpGraphics` は直せない**(null 門は素通りする)── 停止が残るのは想定内で、印が目的。
test は `tests/office-grip-guard-patch.test.ts`(fixture は上流 `d6226c1a` の `polygon.cxx` の抜粋)。

## 🔴 #1393 / #1396 / #117 の原因側の直し `patch-lo-timer-mutex.py`(2026-10-07。⚠ 焼く前 ── 🟡 推測。塞ぐのは**半分だけ**)

JSPI かつ PROXY_TO_PTHREAD でない wasm では、`QtTimer::timeoutActivated()`(`vcl/qt5/QtTimer.cxx`)が **SolarMutex を取らずに** main スレッドで走る
(上流が前処理で `SolarMutexGuard` を外し「too brittle」の TODO を書いている)。`Scheduler::CallbackTaskScheduling` は task の走査・`UpdateMinPeriod()`・`pTask` の選択を
mutex なしで進め、`pTask->Invoke()` の周りでだけ取る(`scheduler.cxx` の 407-417 / 522-533 / 611)。その間に LO のスレッドが窓を dispose し Task を delete すると、
解放済みの Idle(`null function or function signature mismatch`)/ 破棄中の `InterimItemWindow::Layout` / dispose 後のツールチップの timer になる、という読み。
直しは `#if` の**偽の側**(`#else`)で mutex を**待たずに**試す:`IsCurrentThread()` が真(main が持っている = `QtYieldMutex` の借りている状態)なら今まで通り /
`tryToAcquire()` が偽(LO のスレッドが持っている)なら `m_aTimer.start(1)` で 1 ms 後に張り直して返る / 取れたら RAII で `release()`。
印は `PKC3-TIMERMUTEX: skipped #N … t=<ms>` / `ran under mutex (skipped so far N) ran=M t=<ms>`(どちらも最初の 20 回 + 100 回ごと。上限は印だけ ── skip の累計 `N` で 1 ms の再武装の頻度を読む)。
🔑 `t=` は `steady_clock` の ms(wasm ではページ開始から)。#1408(最初の Tab の直後に無言で固まる、1/30)で、固まった後に **skip の行が続く = LO スレッドが鍵を持ったまま戻らない** /
**止まる = main の timer が返っていない** を読み分けるため(以前の 1000 回ごとでは 372 → 1000 の間が無音だった)。🔴 鍵の所有者の thread id は上流に読み出し口が無く(`m_nThreadId` は private)出せない。

🔑 **次の焼きの読み方**(印は各 patch の `PKC3-*` の回数):
`PKC3-TASKGONE` / `PKC3-LAYOUTGUARD` / `PKC3-TOOLTIPGUARD` / `PKC3-VIEWDATAGONE` が **0 に近づく** → 原因は「走査と選択 → `Invoke`」の間だった(この直しが効いた)。
**減らない** → LO のスレッド自身が mutex を手放す所(`EmscriptenLightweightRunInMainThread` / `QtInstance.cxx` の `DoYield` の枝 B)が残っている ── この直しはそこを塞がない。
`PKC3-TIMERMUTEX: skipped` が 1 回も出ないなら、この直しは効く場面に 1 度も入っていない。
test は `tests/office-timer-mutex-patch.test.ts`(fixture は上流 `d6226c1a` の `QtTimer.cxx` の全文。当て済みは **SKIP(exit 0)**)。

## 🔴 #1408 の印 `patch-lo-yield-wait.py`(2026-10-07。⚠ 焼く前 ── **直しではなく印**。行き先は 🟡 推測)

Impress の読み込み中(約 13 秒)に 1/30 で無言で固まる。直前まで timer は鍵を取れずに skip し続け、その後 `m_aTimer.start(1)` 自体が止まる = main の event loop が回らない。
候補は、main の別の入口が `QtYieldMutex::doAcquire`(`vcl/qt5/QtInstance.cxx`)の main の枝で、LO スレッドの鍵を `m_InMainCondition.wait`(述語つき・無期限)で待ったまま戻らないこと。
`wait` の**外側の前後**に `PKC3-YIELDWAIT: enter #N t=<ms> held_by_lo=1 wake=<0/1> closure=<0/1>` と
`leave #M (enter #N) t=<ms> waited=<ms> closure=<0/1>` を足す(連番は enter / leave で別。**3000 回までは毎回**、その後 100 回ごと、
`waited` が 100 ms を超えた leave は必ず)。`held_by_lo` は `tryToAcquire` が偽の枝なので構成上いつも 1。
🔑 **読み方**: 固まった run の最後の行が `enter #N` で同じ N の `leave` が無い = **main はその wait で止まっている**(決め手)。
leave が出た後に無音なら、main は別の所で止まっている(この印は指さない)。⚠ 3000 回目より後に固まれば enter は 100 回に 1 回しか出ない ──
最後の leave の `#M` と timer の最後の行(`PKC3-TIMERMUTEX: skipped #N … t=`)の時刻を突き合わせて読む。
test は `tests/office-yield-wait-patch.test.ts`(fixture は上流 `d6226c1a` の `QtInstance.cxx` の 95〜205 行 = `tests/fixtures/office-lo/QtYieldMutex.excerpt.cxx`。
手元の stub harness では compile と enter/leave の出方を確かめた ── 本物の header ではまだ)。

## 🔴 #1402 の閉じた直後の停止 ── 計装 3 本 `patch-lo-surface-trace.py` / `patch-lo-sdpr-trace.py` / `patch-lo-gfxdata-trace.py`(2026-10-07。⚠ 焼く前 ── **直しではなく印**。行き先は 🟡 推測)

Office を閉じた直後に、本体スレッドが `ThumbnailView::Paint` ← `createPixelProcessor2DFromOutputDevice` で `memory access out of bounds`(先の grip-guard とは別の経路)。
候補は 2 つ: ① `QtSvpSalFrame::DoHandleResizeEvent`(`vcl/qt5/QtSvpSalFrame.cxx`)が **main で SolarMutex なしに** 新しい cairo surface へ差し替えて古い物を捨てる間に、
本体が `GetGraphicsData()` で受け取った生の `pSurface` を `CairoPixelProcessor2D` の ctor が読む ② `OutputDevice::GetSystemGfxData`(`vcl/source/outdev/outdev.cxx`)が
`ApplyFullDamage()`(SolarMutex を手放す hop)の**後**に `mpGraphics` を読み直す間に、`WindowOutputDevice::AcquireGraphics` の奪取で null にされる。

| patch | 当て先 / 印 | 内容 |
|---|---|---|
| `patch-lo-surface-trace.py` | `QtSvpSalFrame.cxx` / `PKC3-SURFACE:` | `resize before`(作った後・差し替えの前)/ `resize after`(`m_pSurface.reset` の後)/ `resize destroy old=X`(`copySource` の後 = 古い surface が捨てられる直前)。毎回出す(頻度が低い) |
| `patch-lo-sdpr-trace.py` | `processor2dtools.cxx` / `PKC3-SDPR:` | `enter #N outdev= type=`(**`HasMirroredGraphics()` の前**)と `made #N outdev= valid=`(ctor の直後)。300 回まで毎回・以後 50 回ごと・**2 秒空いたら必ず・`outdev` が前回出した物と変わったら必ず・前の呼び出しから 100 ms 空いたら必ず**(閉じた直後の連続描画の先頭と相手の入れ替わりを拾う) |
| `patch-lo-gfxdata-trace.py` | `outdev.cxx` / `PKC3-GFXDATA:` | `ApplyFullDamage` の前後で `mpGraphics` が**変わったときだけ** `gfx changed before= after=`(0 行なら変わっていない)+ 🔴 **after が null なら空の `SystemGraphicsData()` を返して落ちない**(門)+ 返す直前の `surface outdev= gfx= surface=`(300 回まで毎回・50 回ごと・2 秒空いたら必ず・**`pSurface` が前回出した値と変わったら必ず** = resize の直後の最初の読み) |

🔑 **次の焼きの読み方**: `t=` は 3 本とも同じ `steady_clock` の ms。
`PKC3-SDPR: enter #N` があって `made #N` が無いまま落ちる → 落ちたのは `HasMirroredGraphics()` か ctor の中 / `surface=X` が `PKC3-SURFACE: resize destroy old=X` の `t=` より**後**に読まれている → 捨てた surface を読んだ(①)/
`gfx changed … after=(nil)` が出る → ② が当たり、門が効いた(落ちる回が減る)/ どれも出ずに落ちる → 候補が外れ。
🔴 **直らないもの**: 門は null のときだけ。`pSurface` が差し替えで捨てられた物を指す競合(①)は印だけで直さない。出ない形は 1 つだけ: 同じ `outdev` / 同じ `pSurface` への呼び出しが 100 ms 未満の間隔で続く塊の**途中**(50 回の倍数でも前回の出力から 2 秒未満でもない回)で落ちたとき。そのときは最後の行の `t=` と落ちた時刻の差で読む。
test は `tests/office-surface-trace-patch.test.ts` / `office-sdpr-trace-patch.test.ts` / `office-gfxdata-trace-patch.test.ts`(fixture は上流 `d6226c1a` の抜粋 `tests/fixtures/office-lo/{QtSvpSalFrame,processor2dtools,outdev}.excerpt.cxx`。
3 本の `pPkc3Ms`(`steady_clock` の ms)が一致することは `tests/office-trace-clock-parity.test.ts` が見る。共有の道具は `tests/helpers/office-lo-patch.ts` ── 当てた後の関数を**型だけ stub に替えて g++ でコンパイルして走らせる**(`-Wall -Wextra -Werror`。g++ が無い箱では skip。本物の LO の header ではない)。
`PKC3_LO_UP=<上流 d6226c1a の木>` を渡すと実 file にも当たる)。ヘルパー関数を作らない(lambda を関数の中に置く)ので `check-patch-scope.py` の SPECS / FIXES には載せていない(grip-guard / timer-mutex と同じ)。

## 🔴 #1408 (c) の直し `patch-lo-hop-borrow.py`(2026-10-08。35 本目。⚠ 焼く前 ── 🟡 推測ではなく**実測した stack への直し**。効いたかは次の節の焼き)

150 本の焼きで 1/150(y7-61)、Impress の起動中に無言で固まった形:main の Qt イベントが SolarMutex を持ったまま別の `osl::Mutex`(Z)を busy-wait し、本体スレッドは
Z を持ったまま lightweight の hop(`QtInstance::EmscriptenLightweightRunInMainThread_`)の `SolarMutexReleaser` の戻りで SolarMutex を取り直せない = **鍵の順序の逆転**。
hop が SolarMutex を**手放す隙**が素(#1402 の「描画の途中で鍵が手放される」隙も同じ)。直しは**手放さず main に貸す**:Releaser をやめ、main の lambda で
`QtYieldMutex::m_bNoYieldLock` を立てて func を走らせ、戻す(重い経路 `doAcquire` と同じ作法)。
🔴 **持っていない呼び手がありうる**(旗を立てると鍵なしで走る)── hop の前に本体で `IsCurrentThread()` を取り、持っているときだけ借りる。持っていないときは従来どおり main が `SolarMutexGuard` で取る
(`SolarMutexReleaser` は持っていなければ何もしないので、挙動は変わらない)。旗の戻しはデストラクタ(func が投げても戻る)。入れ子(旗が既に立っている)は触らない。
⚠ 原文の 10 行は **`#if 0` ... `#else` の中にそのまま残し**、`#else` の側に新しい呼び出しを足す(🔴 `emscripten_sync_run_in_main_runtime_thread` は**関数ではなく可変長 macro**(4.0.10 `threading_legacy.h:180`)。macro の引数は `( )` しか守らず `{ }` は守らない ── ①`#if` を呼び出しの引数の中に挟まない ②**lambda を macro の引数に直書きしない**(中の最上位カンマで引数が割れ `expected '}' before ')' token`。1 稿目はこれで焼きが必ず落ちる形だった ── 着地前レビューが g++ で再現。直しは lambda を関数ポインタに受けてから渡す)。harness は macro を fixture `tests/fixtures/emscripten/threading_legacy-4.0.10.excerpt.h` の字のまま持つ(関数 stub にすると割れを見逃す))。
言えないこと:本物の header でのコンパイル / 鍵なしで走る呼び手の有無(静的には数え切れない)/ 借りている間に main が func の中でイベントループを回す場合 / `DoYield` の枝 B と `ProcessEvent` の suspend は別。
🔑 **次の焼きの読み方**:150 本で固まりの stack に `SolarMutexReleaser の戻り ← QtYieldMutex::doAcquire` が残るか。残れば別の手放し口(枝 B 等)。
test は `tests/office-hop-borrow-patch.test.ts`(fixture は上流 `d6226c1a` の `QtInstance.cxx` の 207〜266 行 = `tests/fixtures/office-lo/QtInstance-hop.excerpt.cxx`。
g++ + pthread の stub harness で、借りて走る / 持っていない呼び手は従来どおり / 入れ子 / 投げても旗が戻る を、**当てていない原文を対照群**にして確かめた)。

## 🔴 #1408 (c) を焼いた結果と副作用 ── 固まりは消え、main の待ちが長くなった(2026-10-08、#1429)

**結果**(dev-hop = run 37712665674、main `b5e4fb22`、LO `d6226c1a`、300 本):

| 症状 | 直す前 | (c) |
|---|---|---|
| 起動中の固まり(B2) | 2/240 | **0**/300 |
| 閉じた後の OOB(#1402) | 4/270 | **0** |
| docking 配置の OOB | 1/210 | **0** |

**副作用**(#1429):main の `QtYieldMutex::doAcquire` の待ち(`PKC3-YIELDWAIT`)が長くなった。

| | 計装 pack(借りる前) | (c) |
|---|---|---|
| p50 | 50 ms | **220 ms** |
| 最大 | 0.9 s | **7.4 s**(CPU が混むと 14.9 s) |
| 1 秒超 | (記録なし) | 各 run に 1 回(読み込み中、経過 4.5 s 付近) |
| 読み込み時間 p50 | 14.2 s | 15.0 s |

待っている相手は PKC 側の JS の橋渡し(embind の getter → `framework::OComponentAccess::createEnumeration`)。

**作法**(本体は上の節。要点だけ):
- `emscripten_sync_run_in_main_runtime_thread` は**可変長 macro**(4.0.10 `system/include/emscripten/threading_legacy.h:180`)。macro の引数に `#if` を挟まない / **lambda(最上位カンマを含みうる)を引数に直書きしない**(関数ポインタに受けてから渡す)。
- 「借りる」作法は `QtYieldMutex::m_bNoYieldLock` を立てて func を走らせること(`doAcquire` の closure と同じ)。旗はデストラクタで戻す。

**test の罠**:
- harness が macro を**関数として stub** すると、macro の引数が割れる誤りを見逃す(PR #1423 の 1 稿目は、それで焼きが落ちる形だった)。実物の `#define` を fixture(`tests/fixtures/emscripten/threading_legacy-4.0.10.excerpt.h`)に写して harness に取り込む。
- g++ の文言を読む test は **`LC_ALL=C`** で引用符を固定する。CI は UTF-8 locale で `‘}’` を出す(PR #1423 の verify で踏んだ)。

**名前の解決**(wasm の stack の関数名を `dl-names` で引くとき):計装 pack(#1421)は vcl の `outdev.cxx` の patch で関数が 1 つ増え、**44509 より上の添字が +1 ずれる**。
`dl-names`(`d6226c1a`、run 37685470296)で引くときは `doAcquire`(193216)/ hop(193127)/ `QtTimer::timeoutActivated`(197773)の **3 点で整合を取ってから**読む。

**全スレッドの dump**(`PKC3_STACKDUMP=all`):`--remote-debugging-port=0` + `Target.setAutoAttach {flatten:true}` で worker(pthread)にも attach する。
`Debugger.enable` は**固まる前に**有効化しておく(固まった page は enable を処理しない)。`Atomics.wait` 中の worker は pause しない(`NO PAUSE` と出る)。
🔑 道具は `build/office-wasm/probe/`(`README.md` に回し方・環境変数・印の読み方・名前の解き方・集計)。`lib.mjs` が `PKC3_JSBEAT` / `PKC3_STACKDUMP` を読み、`alldump.mjs` が全 target の stack を取る。
