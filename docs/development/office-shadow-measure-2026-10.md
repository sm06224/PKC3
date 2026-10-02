# Office(LO wasm)の「影」を JS → LO の `storeToURL` で書けるか ── #1228 段 1'

数字と手順だけを書く(判断は書かない)。製品コード(`src/` / `public/`)は 1 行も変えていない(⚠ **この節〜「再現手順」までは段 1' の時点**。製品の窓で測った段 1 は末尾の「段 1」)。
probe は `build/office-wasm/shadow-store-probe.mjs`(段 0 の `autorecovery-probe.mjs` と同じ作法)。
ここで言う「影」は、**保存していない編集中の文書の状態を、保存とは別の path へ書いた控え**のこと。

土台にした事実(#1259、main `5520e04d`): `public/office/office-unsaved.js` の `anyModified(lo)` は
**JS → LO の同期呼び**(`Module.uno_init` / `uno` / `getUnoComponentContext` → Desktop の全文書を列挙 →
`XModifiable.isModified()`)で動く。段 0 doc の「UNO は使えない」は **LO → JS の向き**(listener 登録)の話。

## どの版で測ったか

| 項目 | 値 |
|---|---|
| 一式 | `lo-wasm-dev` release の `lo-wasm-qt6.zip`(92,871,394 byte / sha256 `c5f903c7bcf1126925d983e93c2f89825b9ec6f2a6e61d39c985c7a7b1c3a11e`)。`build-info.json` の `version` = `lo-0c031979e70b-run34848755531` / `lo_sha` = `0c031979e70b51745c324c59c72069a0c99d57a9` / `built_at` = 2026-09-14T15:47:00Z / 全部 flag false(`save_trace` 含む)。**段 0 と同じ版** |
| 組み方 | `inject/ipag.ttf` を足して `build/office-wasm/make-pages-bundle.mjs` で pages 形式にした(段 0 と同じ) |
| 窓 | `public/office/host.html`(main `5520e04d` のまま。複製も改変もしていない) |
| ブラウザ | `/opt/pw-browsers/chromium`(Chromium 141.0.7390.37・headless・フル版)。`crossOriginIsolated` = true。`chromium_headless_shell` では**回していない** |
| 箱 | 4 コア / 16GB。測定中の 1 分平均 load は **1.2〜7.9**(他の作業と同居)── 時間の値は荒い |
| 文書 | **自作の fixture のみ**(probe が native `soffice --convert-to`(LibreOffice 24.2.7.2)で作る。repo に bytes は置かない)。small = 3 段落(`.odt` 9,073 B / `.docx` 4,899 B)、large = 段落 200 個 + 表 1 つ(5 列 × 6 行)+ 画像 1 枚(160×160 の雑音 PNG)(`.odt` 101,520 B / `.docx` 83,624 B)。大きさは run1 の値。fixture は走りごとに作り直すので `.odt` は ±2 B 動く(run2 は 9,071 B / 101,519 B)|
| 回数 | 全量を **2 回**(run1 / run2、各 12 case)。値は両方を併記する。ほかに開発中の試走(数 case ずつ)があり、起動直後の落ち(下記)の数にだけ使った |

## 測り方

1 case = 窓を 1 つ立てる(fixture 1 つ × 腕 1 つ)。立ててから 12 秒待ち、本文が UNO から読めることを確かめてから測る。

| 腕 | 中身 |
|---|---|
| `control` | 影を書かない。「`SHADOWTYPED` を打つ → `X` を打つ → Ctrl+Z」を**他の腕と同じ順番**で通した基線 |
| `asis` | **製品の窓のまま**で `storeToURL` を呼ぶ(`/work/shadow/shadow.<拡張子>`、`FilterName` は元の形式の native 名。1 回目から 2 秒おきに 3 回) |
| `patched` | ⚠ **probe の中だけで** wasm の import `fd_sync` を「何もせず 0 を返す普通の関数」に差し替えてから呼ぶ(`WebAssembly.instantiateStreaming` を包む。`__fsyncPatched` = `env,wasi_snapshot_preview1` で当たったことを毎回確認)。製品の file は触らない。**`asis` の失敗の原因を突き止めた後に足した腕**で、「差し替えれば何が通るか」を見るためのもの |

観測点(全部 UNO への同期呼び + 窓の DOM):

- 書けたか: 呼びの戻り / `FS.readdir('/work/shadow')` / `FS.readFile` で読み戻した bytes(node 側で zip の中央ディレクトリを読み、`mimetype` と body の部品に打った字が入っているかを見る)。さらに一部は FS から落として **native `soffice --convert-to txt`** で開いた
- 塞ぎ時間: 呼びの前後の `performance.now()`(同期呼びなので、その間 main thread は他に何も動かない)+ 窓の 20 ms 刻み heartbeat の最大の途切れ(呼びの後 0.5 秒待って読む)
- 副作用: `XModifiable.isModified()` / `XUndoManager`(`isUndoPossible` / 題名)/ 本文(`XTextRange.getString()`)/ `XTitle.getTitle()`・`XStorable.getLocation()`・`XModel.getURL()` / DOM の `activeElement`(shadow を潜る)・`document.hasFocus()`。**caret の位置は、呼びの後に `X` を打って `SHADOWTYPED` の直後に入るか**で見た
- 対照群: `control` / `isModified()` だけ 30 回 / `PKC3OfficeUnsaved.anyModified(lo)`(穴②の道)30 回 / 何もしない 2 秒の heartbeat × 3

## 結果

### A. 製品の窓のまま(`asis`)── `storeToURL` は **`SuspendError` を投げる**

どの fixture でも 3 回とも `SuspendError: trying to suspend without WebAssembly.promising`(`ok:false`)。ただし**残るものが形式で違う**:

| 形式 | 呼びの戻り | 宛先 `/work/shadow/shadow.*` | 取り残し | 所要 ms(3 回。run1 / run2) |
|---|---|---|---|---|
| small `.odt` | 3/3 例外 | **無い**(3 回とも) | `lu*.tmp` が 1 回ごとに 1 つ(10,162〜10,164 B・3 つ)。**完結した zip・打った字入り** | 502 / 224 / 201 ・ 387 / 208 / 322 |
| large `.odt` | 3/3 例外 | **無い** | `lu*.tmp` 3 つ(103,393〜103,395 B)。完結した zip・打った字入り | 686 / 309 / 346 ・ 530 / 286 / 348 |
| small `.docx` | 3/3 例外 | **在る**(5,441 B。1 回目で既に完結した zip・body に打った字) | 無し | 78 / 28 / 30 ・ 69 / 20 / 20 |
| large `.docx` | 3/3 例外 | **在る**(84,170 B / 84,169 B。完結した zip・打った字) | 無し | 146 / 37 / 35 ・ 114 / 41 / 53 |

- 例外の後も、窓は動いた: 4 fixture × 2 回の全部で、**打鍵が届く / 取り消しが効く**(`control` と同じ値)。`.odt` 2 fixture では**例外の後の Ctrl+S が通った**(`saved` の放送が 1 件・`isModified` 0。small 9,840 / 9,838 B、large 102,246 / 102,244 B)。`.docx` は Ctrl+S を**試していない**(保存の確認が出うる形式)
- 落とした影(`.odt` の取り残し `lu*.tmp` と `.docx` の `shadow.docx`)を native `soffice --convert-to txt` で開くと、先頭が `SHADOWTYPEDshadow seed one` だった(small。`.docx` large の影も先頭が `SHADOWTYPEDparagraph 0 …`)

**例外の出どころ**(⚠ この 1 点だけ別の版で採った): この一式は名前 section が無いので、名前つきの `lo-wasm-names`(`lo_sha` = `95e83feb2e85…`、2026-08-30、**版が違う**)で同じ呼びを `.odt` に当てて `e.stack` を読んだ:
`fsync`(libc)← `osl_syncFile` ← `fileaccess::XStream_impl::waitForCompletion` ← `SwitchablePersistenceStream::waitForCompletion` ← `ZipPackage::writeTempFile` ← `ZipPackage::commitChanges` ← `OStorage_Impl::Commit`。
測った一式の `soffice.js` には `var _fd_sync = function(fd){ … Asyncify.handleSleep(wakeUp => {…}) … }; _fd_sync.isAsync = true`(= wasm の import `fd_sync` が JSPI の suspend 側)と
`async function callMain`(LO の main ループが promising 側)が在る。`/work` と `/tmp` は同じ 1 つの root マウントで `syncfs` を持たない(`FS.lookupPath(...).node.mount.type.syncfs` = 無し)。
`.docx` の例外の stack は**関数番号だけ**で名前が読めない(`.docx` の失敗が同じ `fd_sync` かは、下の `patched` で `fd_sync` の差し替えだけで `ok:true` になったことからしか言えない)。

### B. `fd_sync` を probe の中で差し替えた窓(`patched`)── **書けた**

`storeToURL('file:///work/shadow/…', [FilterName = 元の形式の native 名])`。全 case で `ok:true`。値は **run1 / run2**。

「初回」= 窓を立てて最初の呼び。「連打」= 同じ path へ 2 秒おき 10 回(ms の min / median / max)。「途切れ」= 連打 10 回それぞれの heartbeat 最大途切れ(min / median / max)。

| 形式 × 大きさ | 文書 | 影(初回) | 影を読み戻すと | 初回 ms | 連打 ms | 途切れ ms |
|---|---|---|---|---|---|---|
| `.odt` small | 9,073 B | 10,161 / 10,160 B | zip 完結・`mimetype` = `application/vnd.oasis.opendocument.text`・content.xml に打った字 | 495 / 428 | 213 / 241 / 267 ・ 202 / 217 / 296 | 231 / 263 / 296 ・ 211 / 231 / 309 |
| `.docx` small | 4,899 B | 5,440 / 5,441 B | zip 完結・`[Content_Types].xml` 有り(OOXML)・word/document.xml に打った字 | 80 / 66 | 17.5 / 22.5 / 55.2 ・ 17.3 / 20.8 / 27.0 | 29 / 50 / 84 ・ 33 / 42 / 61 |
| `.odt` large | 101,520 B | 103,393 / 103,392 B | 同上(ODF) | 681 / 501 | 262 / 283 / 381 ・ 264 / 271 / 336 | 282 / 300 / 406 ・ 276 / 289 / 352 |
| `.docx` large | 83,624 B | 84,170 / 84,170 B | 同上(OOXML) | 159 / 148 | 28.5 / 33.4 / 51.6 ・ 29.3 / 39.8 / 51.1 | 47 / 55 / 71 ・ 41 / 66 / 76 |

- **元の形式のまま書けた**: `.odt` は ODF、`.docx` は OOXML(`FilterName` = `MS Word 2007 XML`)の zip。native `soffice` で `--convert-to txt` すると 4 つとも先頭が `SHADOWTYPED…`(small 2 つと large `.docx` を確認。large `.odt` は読み戻した zip の中身まで)
- 連打 10 回 × 4 fixture × 2 回(80 回)で、全部 `ok:true` / 呼びの後も版面が出ている(canvas)/ heartbeat が進み続けた / `isModified` = 1 のまま。ms は**単調には増えていない**(8 組すべてで 10 回が単調増加ではない。前半 5 回と後半 5 回の平均は、6 組で後半が同じか小さく、後半が大きかったのは large `.odt` run1 の 282 → 301 ms と large `.docx` run2 の 37 → 42 ms の 2 組)
- 連打の影の大きさは回ごとに数 byte 動く(small `.odt` 9,936〜9,940 B、large `.odt` 103,004〜103,009 B、`.docx` は 5,428〜5,429 B / 84,155〜84,157 B)
- 初回は連打より遅い(`.odt` small 428〜495 → 202〜296、large 501〜681 → 262〜381。`.docx` small 66〜80 → 17〜55、large 148〜159 → 28〜52)。**窓を立てて最初の 1 回目に限る**かは、初回が 1 case 1 回しか無いので言えない
- 元の文書(`/work/seed.*`)は動かなかった(連打の後・Ctrl+S の前に読んだ大きさが、その走りの fixture と 4 つとも 2 回とも同じ)

### C. 副作用(`asis` と `patched` を `control` と比べた)

4 fixture × 2 腕 × 2 回 = 16 組すべてで、`control` と**同じ**:

| 観測 | 呼びの前(`SHADOWTYPED` を打った後)→ 呼びの直後 | その後 |
|---|---|---|
| ① `isModified()` | **1 → 1**(影を書いても「未保存」は消えない) | `X` を打った後も 1。Ctrl+Z の後は 0(`control` と同じ) |
| ② 取り消し | `isUndoPossible` = 1・直近の action の題名 `タイプ入力:“SHADOWTYPED”` のまま | `X` の後は題名が `…“SHADOWTYPEDX”`。Ctrl+Z で本文が元に戻り(`SHADOWTYPED` が消える)、`redo` = 1(全部 `control` と同じ) |
| ③ 焦点 / caret | `activeElement` = `CANVAS#.qt-window-canvas`・`document.hasFocus()` = true のまま | 呼びの後に `X` を打つと本文は `SHADOWTYPEDX…`(`SHADOWTYPED` の直後)= caret が動いていない |
| ④ 題名 | `XTitle.getTitle()` = `seed.odt` / `seed.docx`・`XStorable.getLocation()` と `XModel.getURL()` = `file:///work/seed.<拡張子>` のまま(**影の path にならない**) | ─ |

- `patched` の `.odt` 2 fixture では、影を 14 回(初回 1 + 変種 3 + 連打 10)書いた後の **Ctrl+S が通った**(`saved` の放送 1 件。small 9,937 / 9,939 B、large 103,006 B ×2。`isModified` 0)
- ⚠ ④は UNO の値。LO のウィンドウ枠の題名の**見た目の字は読んでいない**(段 0 でも 0 文字だった観測点)

### D. 形式の変種(`patched`。同じ「変更あり」の文書へ、影の後に続けて)

| 文書 | `FilterName` | 書かれた物 | small の大きさ / ms(run1・run2) | large の大きさ / ms |
|---|---|---|---|---|
| `.odt` | 渡さない | **ODF**(`writer8` と同じ) | 9,936 / 219 ・ 9,938 / 221 | 103,002 / 337 ・ 103,004 / 265 |
| `.odt` | `MS Word 2007 XML` | OOXML | 5,190 / 52 ・ 5,191 / 49 | 83,901 / 110 ・ 83,902 / 79 |
| `.odt` | `OpenDocument Text Flat XML` | flat XML(zip でない・`<?xml`) | 31,483 / 64 ・ 31,482 / 55 | 183,712 / 136 ・ 183,710 / 105 |
| `.docx` | **渡さない** | 🔴 **ODF**(`mimetype` = `application/vnd.oasis.opendocument.text`。docx ではない) | 9,321 / 453 ・ 9,322 / 387 | 102,837 / 599 ・ 102,837 / 611 |
| `.docx` | `writer8` | ODF | 9,327 / 277 ・ 9,327 / 211 | 102,844 / 304 ・ 102,842 / 318 |
| `.docx` | `OpenDocument Text Flat XML` | flat XML | 33,401 / 60 ・ 33,401 / 52 | 187,153 / 110 ・ 187,155 / 124 |

- 全部 `ok:true`・`isModified` = 1 のまま。元の形式(`.docx`)を保つには **`FilterName` を渡す必要がある**(渡さないと ODF になる)。`.odt` は渡さなくても ODF
- 同じ文書でも **ODF の書き出しは約 200〜600 ms、OOXML / flat XML は約 20〜140 ms** だった。書き出された ODF の zip には `Thumbnails/thumbnail.png` が入っており、見た範囲の OOXML には無い(中身の観測)。**ODF が遅い原因がそれかは測っていない**

### E. 対照群

| 対照 | 値(24 case 通し) |
|---|---|
| 何もしない 2 秒の heartbeat 最大途切れ(20 ms 刻みなので 20 が下限) | 72 回: min **20** / median **23** / max **63**(63・48・47 は 1 分平均 load が 6.8〜7.9 の回で出た) |
| `isModified()` だけ(取得済みの handle・30 回 × 24 case) | median **0〜0.005 ms** / 1 回の max **0.05〜0.13 ms** |
| `PKC3OfficeUnsaved.anyModified(lo)`(穴②の道。毎回 Desktop を列挙・30 回 × 24 case) | min 0.195 ms / median **0.26〜0.51 ms** / 1 回の max **1.1〜9.5 ms**(3 case だけ 3 ms を超えた: 4.5 / 4.5 / 9.5)。穴②の「0.5〜1.6 ms」と同じ桁 |

`storeToURL` の塞ぎ(上の B)は、この基線(heartbeat 20〜30 ms)に対して **17〜700 ms**。

## 分かったこと(測った値から言えること)

1. **製品の窓のままでは、JS から `storeToURL` を呼ぶと必ず `SuspendError` になる**(`.odt` / `.docx`・small / large の 4 fixture × 3 回 × 2 走 = 24 呼びすべて)。`.odt` は宛先に何も書かれず、`lu*.tmp` が取り残される。`.docx` は**例外の後でも宛先に完結した zip が在る**
2. 例外の出どころは wasm の import `fd_sync`(JSPI の suspend 側)。LO の main ループの外から呼ぶ同期呼びでは suspend できない。**`fd_sync` を「何もせず 0 を返す関数」に差し替えるだけで、4 つとも `ok:true` になり、影が書けた**
3. 書けた影は、元の形式の完結した zip で、打った字が入り、native `soffice` で開ける。`.docx` は **`FilterName` を渡さないと ODF で書かれる**
4. 影を書いても、`isModified` は 1 のまま・取り消しは効く・焦点と caret は動かず・題名は変わらない(UNO 観測)。影の後の Ctrl+S(`.odt`)も通った
5. 影は **main thread を呼びの間ずっと塞ぐ**: `.odt` 約 200〜700 ms、`.docx` 約 17〜160 ms(この箱・load 1〜8 の下)。連打(2 秒おき 10 回)で増えず、LO は表示中のままだった

## 分からなかったこと(測れなかった / 読んでいないこと)

- **製品側で `fd_sync` を差し替える方法そのもの**: probe は `host.html` の `WebAssembly.instantiateStreaming` に渡る `imports` を**ページの外から包んだ**だけ。`host.html` 自身の `instantiateWasm` 経路で同じことができるか・LO 自身の保存(Ctrl+S)が `fd_sync` を呼ぶときの意味(`/work` は `syncfs` の無い単一マウントなので no-op と同じ、までは確認)が変わらないかは、**製品の窓では確かめていない**。差し替え後の Ctrl+S は `.odt` だけ通した(`.docx` は未実施)
- 差し替えない道(LO の main ループの中で動かす)は**調べていない**。`SynchronMode=false` を付けた `.uno:SaveAs`(`SaveACopy`)の dispatch は**同期のまま同じ `SuspendError`** になった(試走 1 回・`.odt` small)。`private:stream` + `SequenceOutputStream` への出力も同じ(同じ試走)。それ以上は未探索
- `.docx` の失敗が `fd_sync` 経由かの**直接の証拠**(名前つきの stack)は無い(上記)。名前つきの stack は**別の LO の版**(`95e83feb2e85`)の `.odt` のもの
- 例外の後に **内部状態が汚れていないか**: 打鍵・取り消し・(`.odt` の)Ctrl+S が通ったことしか見ていない。`lu*.tmp` の取り残し以外は FS を網羅していない(`/instdir/user/backup` などは**見ていない**)
- 影の**メモリ**(wasm heap / FS の増え方)は**測っていない**(連打 10 回の FS のファイルは同じ path への上書き)
- 初回が遅い(約 2 倍)のが**窓を立てた直後に限る**か・文書の大きさに比例するかは、1 case あたり初回 1 回なので言えない。ODF が OOXML より遅い**原因**は未特定
- 画像 / 表を含む large でも影は書けたが、**書かれた影の画像・表が元と同じ見た目か**は見ていない(native の txt 化で本文の字だけ確認)
- caret の位置は「打った字がどこに入るか」で、LO の内部のカーソル API では見ていない。焦点は DOM の `activeElement`(LO の内部の焦点ではない)
- `chromium_headless_shell` / 実機(macOS / DPR 2 / 他のブラウザ)は見ていない。この箱の Chromium 141(フル版)のみ
- 起動直後の**打鍵で LO が落ちる回**: large `.docx` の fixture だけで、試走を含め 12 回起動して **4 回**(`RuntimeError: null function or function signature mismatch`。いずれも影を書く前 = `control` 3 回 + `patched` 1 回)。small 2 つと large `.odt` では 0 回。probe は「打った字が届かない回」を作り直して最大 3 回まで測り直す(`attempts` に残す)。落ちる原因は調べていない

## 再現手順

1. 一式を `curl -sSL --cacert /root/.ccr/ca-bundle.crt -o lo.zip https://github.com/sm06224/PKC3/releases/download/lo-wasm-dev/lo-wasm-qt6.zip` → 展開 → `inject/ipag.ttf` を足す → `node build/office-wasm/make-pages-bundle.mjs <展開先> <出力>`
2. native `soffice`(`libreoffice-writer`)を入れる(fixture の変換に使う)
3. `node build/office-wasm/shadow-store-probe.mjs <出力> <out.json>`(全量 12 case ≒ 12 分)。絞るときは `PKC3_SS_CASES=small-odt:asis,small-odt:patched`、連打の回数は `PKC3_SS_REPEAT`、影の実物を落とすのは `PKC3_SS_KEEP=<dir>`(自作 fixture のみ)

---

# 段 1 ── 製品の窓(`host.html`)で測った(着手の条件)

> 段 1' の probe は `host.html` の**外から** `instantiateStreaming` を包んだだけで、製品の窓では確かめていなかった。
> 裁定 A の着手の条件は「製品の窓で ① 差し替えが Ctrl+S(`.odt` / `.docx`)を壊さない ② `.odt` の塞ぎが打鍵の体感に出ない」を**先に実測**すること。
> 数字と手順だけを書く(判断は書かない)。probe は同じ `build/office-wasm/shadow-store-probe.mjs` に腕を足した。

## どの版で測ったか(段 1)

| 項目 | 値 |
|---|---|
| 土台 | main `f24c69e2`(段 0 の sha)。差し替えの口を足した版 = commit `d84181da`(①)/ 影の書き出しまで入れた作業ツリー(②。commit 前の版を `public/` ごと写して配った) |
| 一式・ブラウザ | 段 1' と同じ(`lo-0c031979e70b-run34848755531` / Chromium 141 フル版・headless) |
| 文書 | 自作 fixture(段 1' と同じ small `.odt` 9,07x B / `.docx` 4,89x B)。⚠ **small だけ**(large は測っていない) |
| 対照群 | **元の窓**(`f24c69e2` の `public/` をそのまま `/base/` で配る。差し替えの口も影のコードも無い) |
| 箱 | 4 コア。1 分平均 load は①の間 **7.8〜11.6**・②の間 **2.1〜10**(他の作業と同居)── 時間の値は荒い |

## 差し替えの口の作り(製品側)

- 起動の `instantiateWasm(imports, ok)` に渡る `imports` の `fd_sync` を、**1 度だけ**普通の関数へ差し替える(`public/office/office-shadow.js` の `createSyncGate().wrapImports`)。
  `begin()` 〜 `end()` の間だけ 0 を返し、それ以外は「元の `fd_sync` が MEMFS に対してやっていたこと」と同じ(開いていない fd は EBADF = 8、それ以外は 0。`syncfs` を持つ mount が来たら数える)。
- 実測した事実(`WebAssembly.instantiateStreaming` に渡る `imports` を採った): `env.fd_sync` も `wasi_snapshot_preview1.fd_sync` も **`[object WebAssembly.Suspending]`**(呼べない object)。
  → 起動の後から入れ替えられず、**同じ import で suspend する / しないを切り替えることもできない**。だから「既定は素の `fd_sync`」は**字義どおりには作れない** ── 既定側は「同じ結果を返す普通の関数」である(suspend の 1 回分の待ちが無い)。
- ⚠ 素の側の関数は、この表のどの Ctrl+S でも **1 度も呼ばれなかった**(下の `passed` = 0。LO 自身の保存の `fd_sync` はこの import を通らない)。素の側の分岐(EBADF 判定)を実機で通した記録は無い。

## ① 製品の窓で、差し替えが Ctrl+S を壊さないか

腕: `control` = 元の窓 / `gate` = 製品の窓(口は入っている・影は書かない)/ `shadow` = 製品の窓(打つ → 口を通して影を 1 回 → Ctrl+S)。各 **2 回**(run1 / run2)。
手順: 窓を立てて 12 秒 → `SHADOWTYPED` を打つ → (`shadow` のみ)影を `/tmp/pkc3-shadow/shadow.<拡張子>` へ書く → `Ctrl+S`(`.docx` は 3 秒後に `Alt+e` =「Word 2007 形式を使用する」)→ 保存の放送を最大 40 秒待つ。
観測: 保存の放送 / `isModified` / `/work/seed.*` の mtime と大きさ / 保存された file を FS から読んで zip の中身 / **native `soffice --convert-to txt` で開いて打った字が入っているか**。

| 形式 | 腕 | 回 | 影(書いた時間 / 大きさ) | 保存の放送 | Ctrl+S 後の isModified | 保存前 → 後の大きさ | 保存された file | native soffice | 口(gated / passed) |
|---|---|---|---|---|---|---|---|---|---|
| .odt | control | 1 | ─ | 1 | 0 | 9071 → 10161 B | ODF ・ 字入り ○ | 開けた・字入り | ─ |
| .odt | gate | 1 | ─ | 1 | 0 | 9071 → 10161 B | ODF ・ 字入り ○ | 開けた・字入り | gated 0 / passed 0 |
| .odt | shadow | 1 | 481.6 ms / 10164 B | 1 | 0 | 9071 → 10162 B | ODF ・ 字入り ○ | 開けた・字入り | gated 2 / passed 0 |
| .odt | control | 2 | ─ | 1 | 0 | 9071 → 10163 B | ODF ・ 字入り ○ | 開けた・字入り | ─ |
| .odt | gate | 2 | ─ | 1 | 0 | 9071 → 10163 B | ODF ・ 字入り ○ | 開けた・字入り | gated 0 / passed 0 |
| .odt | shadow | 2 | 485.35 ms / 10162 B | 1 | 0 | 9071 → 10161 B | ODF ・ 字入り ○ | 開けた・字入り | gated 2 / passed 0 |
| .docx | control | 1 | ─ | 1 | 0 | 4899 → 5444 B | ooxml ・ 字入り ○ | 開けた・字入り | ─ |
| .docx | gate | 1 | ─ | 1 | 0 | 4899 → 5444 B | ooxml ・ 字入り ○ | 開けた・字入り | gated 0 / passed 0 |
| .docx | shadow | 1 | 61.02 ms / 5441 B | 1 | 0 | 4899 → 5444 B | ooxml ・ 字入り ○ | 開けた・字入り | gated 1 / passed 0 |
| .docx | control | 2 | ─ | 1 | 0 | 4899 → 5443 B | ooxml ・ 字入り ○ | 開けた・字入り | ─ |
| .docx | gate | 2 | ─ | 1 | 0 | 4899 → 5444 B | ooxml ・ 字入り ○ | 開けた・字入り | gated 0 / passed 0 |
| .docx | shadow | 2 | 97.65 ms / 5441 B | 1 | 0 | 4899 → 5444 B | ooxml ・ 字入り ○ | 開けた・字入り | gated 1 / passed 0 |

- 12 組すべてで、保存の放送が 1 件・`isModified` 0・mtime が動き・保存された file が完結した zip(`.odt` = ODF / `.docx` = OOXML)・native `soffice` で開けて先頭が `SHADOWTYPED…`
- `gate`(口は入っているが影は書かない)は `control` と同じ大きさ(`.odt` 10,161〜10,163 B / `.docx` 5,443〜5,444 B)。口を入れただけでは何も変わらなかった
- `shadow` の影そのもの: `.odt` は ODF(481.6 / 485.4 ms)、`.docx` は OOXML(61.0 / 97.7 ms)、どちらも打った字入り。影の後も `isModified` は 1
- 口のカウンタ(`gated` = 書く間に呼ばれた数 / `passed` = 外で呼ばれた数): `shadow` の `.odt` は gated 2・`.docx` は gated 1、**passed は全 12 組で 0**
- 起動直後の落ち(`RuntimeError`)で測り直した回: `small-odt:ctrls-shadow` の run2 が 1 回(影を書く前。`attempts` に残る)

## ② 打鍵の体感(`.odt` small・3 回)

2 つの測り方を分けた。**自動の契機**(製品の窓の `armShadow` が実際に動く。打ち続ける間は書かない → 3 秒止まると 1 回)と、**書き出しの最中に打ったキー**(probe が書き出しを起こし、80 ms 後にキーを打つ ── 最悪の重なり)。
キーの届き方 = `keydown` の `event.timeStamp`(入力が窓へ着いた時刻。塞がれている間も進む)から、本文(UNO の `getString().length`)が増えたのを 5 ms 刻みで読むまで。対照群 = 元の窓で同じ手順。

### 自動の契機(`e2e`。各 3 回。窓ごとの値)

手順: `SHADOWTYPED` を打つ → 6 秒待つ(最初の影ができる)→ **`a` を 200 ms 間隔で 40 回(約 8.5 秒)** → 止まる → 影の放送を 250 ms 刻みで 6 秒まで待つ → さらに 6 秒待つ → 1.5 秒おきに `x` を 1 つ × 3(書いた後の最初の打鍵)→ 「`z` を打つ → Δ 待つ → `y`」を Δ = 2950 / 3100 / 3400 / 3800 ms で 4 組。

| | 打ち続けた約 8.5 秒の間 | 止まってから影の放送まで | 影の数(棚) | 書き出しの塞ぎ(口の begin 〜 end) | 影の大きさ |
|---|---|---|---|---|---|
| 製品の窓 run1 / run2 / run3 | 書き出し 0 回・口 0 回・放送 0 件(3 回とも) | **3,489 / 3,923 / 3,802 ms** | 放送 1 件・棚 1 file(古い影は消えている) | **198.9 / 274.9 / 201.9 ms** | 10,441 / 10,441 / 10,442 B |
| 元の窓(対照) | ─ | ─(影の口が無い) | ─ | ─ | ─ |

| キーが本文に届くまで(ms) | 書いた後の最初の打鍵(1.5 秒おき × 3) | `z` の Δ 後の `y`(Δ = 2950 / 3100 / 3400 / 3800) |
|---|---|---|
| 元の窓 run1 | 6.7 / 4.8 / 16.4 | 6.6 / 5.1 / 5.1 / 5.3 |
| 元の窓 run2 | 8.0 / 4.5 / 7.6 | 9.8 / 6.2 / 4.9 / 12.7 |
| 元の窓 run3 | 18.3 / 18.9 / 7.7 | 6.1 / 4.7 / 7.7 / 8.4 |
| 製品の窓 run1 | 5.9 / 8.4 / 9.6 | 5.6 / 10.8 / 10.4 / 20.9 |
| 製品の窓 run2 | 22.1 / 7.9 / 7.9 | 11.7 / 13.7 / 8.5 / 6.3(書き出しの区間と重なったと判定された 1 組) |
| 製品の窓 run3 | 9.9 / 5.8 / 8.0 | 6.9 / 5.7 / 8.3 / 4.9 |

- 書いた後の最初の打鍵の中央値: 元の窓 **7.7 ms**(9 値)/ 製品の窓 **8.0 ms**(9 値)。`y` の 12 組ずつ: 元 4.7〜12.7 ms / 製品 4.9〜20.9 ms
- 打ち続けた約 8.5 秒(`a` を 40 回)の間は、口の呼び出し(`gated`)・書き出しの区間・影の放送がどれも **0 件**(3 回とも)。止まってから影の放送まで **3.5〜3.9 秒**(= 静止 3 秒 + 1 秒刻みの見張りの位相 + 書き出し約 0.2〜0.3 秒 + 棚へ置く時間。内訳は分けて測っていない)
- ⚠ 自然な進み方では「`y` が書き出しの最中に当たる」組は 12 組中 1 組(それも書き出しの終わり際)── 重なりの最悪は次の表で別に測った

### 書き出しの最中に打ったキー(`lat`。各 3 回 × 3 打鍵)

影の書き出しを probe が起こし(30 ms 後に始まる)、その 80 ms 後にキーを打つ。キーは塞がれている間は届かず、書き出しが終わってから処理される。

| 腕 | キーが届くまで(ms。9 打鍵) | 書き出し(塞ぎ)(ms。9 回) |
|---|---|---|
| 元の窓(影を書かない) | 14.5 / 10.2 / 4.9 ・ 8.1 / 7.0 / 5.8 ・ 6.1 / 8.7 / 12.3 | ─ |
| 製品の窓(影を書く) | **243.4 / 191.0 / 178.7 ・ 364.2 / 142.1 / 151.2 ・ 406.3 / 201.8 / 323.0** | 292.7 / 228.4 / 234.3 ・ 406.6 / 188.2 / 190.5 ・ 453.1 / 228.8 / 360.9 |

- 9 打鍵すべてが届いた(取りこぼし 0)。遅れは**書き出しの残り時間**で、書き出しの長さ(188〜453 ms)より短かった
- 1 窓の中では **1 回目の書き出しが最長**(3 窓とも: 292.7 → 228.4 / 234.3、406.6 → 188.2 / 190.5、453.1 → 228.8 / 360.9。3 窓目だけ 3 回目が 2 回目より長い)── 段 1' の「初回は遅い」と同じ向き
- 箱の 1 分平均 load は ② の間 **2.1〜10**(他の作業と同居)。時間の値は荒い

## 分からなかったこと(段 1)

- `.docx` の自動の契機 / 打鍵の体感は測っていない(②は `.odt` のみ。`.docx` の塞ぎは段 1' で 17〜160 ms)。large 文書(段落 200 + 表 + 画像)は ①② とも測っていない
- 素の側の関数(EBADF 判定)は、どの Ctrl+S でも呼ばれなかったので**実機で通っていない**。`syncfs` を持つ mount が来たら数えるだけで 0 を返す ── この窓にそんな mount は無い(段 1')が、他の一式で変わるかは見ていない
- LO 自身の保存が `fd_sync` を呼んだかどうか(import を通らないのか、呼ばないのか)は区別していない。分かっているのは**この import 経由では 1 度も呼ばれなかった**こと
- LO が**自分で保存している最中**に影の書き出しが重なったとき(大きい文書の Ctrl+S が 3 秒を超えて続く間に別のキーで静止が成立する等)は測っていない。製品側に「LO の保存の最中を避ける」門は無い
- 打った印は keydown / beforeinput / compositionend / paste / cut / drop。**マウスだけの編集**(ツールバーの太字など)は静止の契機にならない(測っていない)
- 起動直後の落ち(`RuntimeError`)は、元の窓(`ctrls-control`)でも 1 回出た(初回の試走。差し替えの口とは無関係に見えるが、原因は調べていない)

## 再現手順(段 1)

1. 段 1' と同じ一式を `pages` 形式にして `<pack>` に置く。元の窓は `git archive f24c69e2 public` の展開先を `PKC3_SS_BASE_PUBLIC` に渡す(`/base/` で配られる)
2. `PKC3_SS_BASE_PUBLIC=<元の public> PKC3_SS_CASES=small-odt:ctrls-control,small-odt:ctrls-gate,small-odt:ctrls-shadow,… node build/office-wasm/shadow-store-probe.mjs <pack> <out.json>`(①は `small-odt` / `small-docx` × `ctrls-*`、②は `small-odt:e2e-control` / `e2e-shadow` と `lat-control` / `lat-shadow`)
3. ⚠ 走らせている間に `PKC3_PUBLIC` の中身を書き換えない(製品の窓はその場で配られる)── 測る版は先に写してから配る

