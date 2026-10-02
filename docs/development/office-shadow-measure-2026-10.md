# Office(LO wasm)の「影」を JS → LO の `storeToURL` で書けるか ── #1228 段 1'

数字と手順だけを書く(判断は書かない)。製品コード(`src/` / `public/`)は 1 行も変えていない。
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
