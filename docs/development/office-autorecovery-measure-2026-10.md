# Office(LO wasm)の自動回復(AutoRecovery)実測 ── #1228 段 0

数字と手順だけを書く(判断は書かない)。製品コードは 1 行も変えていない。
probe は `build/office-wasm/autorecovery-probe.mjs`。

## どの版で測ったか

| 項目 | 値 |
|---|---|
| 一式 | `lo-wasm-dev` release の `lo-wasm-qt6.zip`(92,871,394 byte)。`build-info.json` の `version` = `lo-0c031979e70b-run34848755531` / `lo_sha` = `0c031979e70b51745c324c59c72069a0c99d57a9` / `built_at` = 2026-09-14T15:47:00Z / 全部 flag false(`save_trace` 含む) |
| 目録の総数 | 2,028 file(`soffice.data.js.metadata`) |
| 窓 | `public/office/host.html`(main `df4f25ac` のまま。複製も改変もしていない) |
| ブラウザ | `/opt/pw-browsers/chromium`(フル Chromium・headless)。`crossOriginIsolated` = true |
| 箱 | 4 コア。**測っている間 load average は 17〜24**(他の作業と同居)── 時間の値は荒い |
| 文書 | 自作 fixture のみ(`seed.odt` 8,926 byte / `seed.docx` 5,024 byte。本文は 2 段落の英字) |

手順(再現):

1. 一式を `curl -sSL --cacert /root/.ccr/ca-bundle.crt` で `releases/download/lo-wasm-dev/lo-wasm-qt6.zip` から取る → 展開 → `inject/ipag.ttf` を足す → `node build/office-wasm/make-pages-bundle.mjs <展開先> <出力>`(20 秒)
2. fixture は native `soffice --convert-to`(`libreoffice-writer` を `apt-get install` した)
3. `node build/office-wasm/autorecovery-probe.mjs <出力> <文書> <out.json> <待つ秒>`(`PKC3_FRAMES=1` を渡した回だけ版面の絵の sha256 先頭 12 桁を採る。画像は保存しない)

## 設定の名前(同梱の `share/registry/main.xcd` を読んだ結果)

| 場所 | 名前 | 型 / 既定 | スキーマの説明 |
|---|---|---|---|
| `/org.openoffice.Office.Recovery/AutoSave` | `Enabled` | bool / **true** | 変更された文書を一定間隔で自動保存するか |
| 同上 | `TimeIntervall` | int / **10**(分) | 間隔(分)。スキーマに最小値の制約は書かれていない |
| 同上 | `UserAutoSaveEnabled` | bool / false | 説明なし |
| `/org.openoffice.Office.Recovery/RecoveryInfo` | `Enabled` | bool / true | 回復機能の有効 |
| `/org.openoffice.Office.Common/Save/Document` | `AutoSave` | bool / false | **`Not used anymore`** |
| 同上 | `AutoSaveTimeIntervall` | int / 10 | **`Not used anymore`** |

依頼文の `AutoSave` / `AutoSaveTimeIntervall` は最後の 2 行(スキーマ自身が「使われていない」と書く側)。
生きている側の名前は `Recovery/AutoSave` の `Enabled` / `TimeIntervall`。

設定の入れ方: `host.html` の `loadSavedProfile` が読む `localStorage['pkc3-office-profile']` に xcu を置く
(`seedWindowSize` が `callMain` の前に `/instdir/user/registrymodifications.xcu` へ書く実経路)。
起動直後の FS を読み直して、`TimeIntervall` = 1 が xcu に入っていることを毎回確かめた(`xcuAtBoot`)。

## 1〜5 の表

観測点 3 つ: ① FS の出来事(`FS.open` / `close` / `rename` / `unlink` / `mkdir` を包んで時刻つきで記録。
`/instdir/share` と `/instdir/program` は除く)② 15 秒おきの FS 全走査(起動後に増えた / 変わった file)
③ `registrymodifications.xcu` に `RecoveryList` が出たか。窓の main thread は 20ms 刻みの heartbeat と longtask。

| 回 | 設定 | 文書 | 変更を入れたか | 観測した長さ(文字を打った後) | `/instdir/user/**` への新しい書き込み | 増えた file | `RecoveryList` |
|---|---|---|---|---|---|---|---|
| A | `Recovery/AutoSave` `Enabled`=true / `TimeIntervall`=**1** | `.odt` | 打った(版面の絵が入れ替わった = 届いた) | **約 220 秒** | **0 件** | **0 件** | 無し |
| B | 同上 | `.docx` | 打った(届いた) | **約 310 秒** | **0 件** | **0 件** | 無し |
| C | **何も足さない**(既定 `Enabled`=true / 10 分) | `.odt` | 打った(届いた) | **約 795 秒**(= 13 分。10 分を 3 分超える) | **0 件** | **0 件** | 無し |

(`/instdir/user/**` で見えた出来事は、窓自身が 3 秒おきに `registrymodifications.xcu` を**読む**だけ。
A 83 回 / B 116 回 / C 293 回 ── どれも read のみ、size は 18,2xx のまま不変。)

| # | 問い | 値 |
|---|---|---|
| 1 | timer が wasm で回るか | **この一式・この条件では backup は 1 件も書かれなかった**(A / B / C)。⚠ 「timer が回っていない」ではなく「**回っても書くものが出なかった**」までしか言えない(timer 自体を直接見る観測点は無い)。同梱 `services.rdb`(197,218 byte)には `com.sun.star.comp.framework.AutoRecovery` / `AutoRecovery` の字が **UTF-8 でも UTF-16LE でも 0 件**(同じ rdb に `Desktop` は 7 件)。`soffice.wasm` には `com.sun.star.frame.AutoRecovery` が ASCII で 1 件・`AutoRecovery` が 5 件在る(リンクされた字であって、登録された証拠ではない) |
| 2 | backup の置き場 | **自動回復の backup は観測できなかったので「どこ」は言えない**。⚠ 参考(別物): 対照群の**明示の Ctrl+S**(下)で、LO は `/instdir/user/backup/seed.odt.bak`(保存**前**の版 = 8,926 byte)を作り、保存の最後(+約 0.8 秒)に **消した**。`/instdir/user/backup/` というディレクトリ自体は保存で `mkdir` される |
| 3 | 開ける形式か | **測れなかった**(1 件も書かれなかったため `.odt` / `.docx` どちらも backup の形式は不明)。参考: 上の `.bak` は元の `.odt` と同じ大きさ(8,926)= 元形式のコピー |
| 4 | 書く間 main thread が何 ms 塞がるか | 自動回復では**測れなかった**(書き込みが無い)。参考(明示の Ctrl+S 1 回、`.odt` 8.9 KB → 9.9 KB): FS の出来事は押下の +78 ms〜+798 ms(temp 作成 → 元 file を `.bak` へ → temp へ書く(+180〜+710 ms)→ `rename` → `.bak` を消す)。同じ区間の heartbeat 途切れ **250 ms / 464 ms**、longtask **113 / 247 / 451 ms**。`office-save-watch.js` 43-44 の「0.35 秒級」と同じ桁。⚠ 負荷が高い箱での 1 回きり |
| 5 | 設定できる最小間隔 | スキーマは `xs:int`(分)で最小値の制約なし。`1` は xcu に入り(`xcuAtBoot`)、LO が受理したかは分からない。⚠ **効果が観測できなかったので「最小 1 分で効く」とは言えない**。`0` / 小数 / 負は**試していない** |

### 対照群(「観測点が壊れていない」の確認)

明示の Ctrl+S(`PKC3_AR_SCENARIO=save`、`.odt` に 12 文字を打ってから)で、**同じ hook と heartbeat が保存の出来事を拾った**:
`/tmp/lu*.tmp` 作成 → `/work/seed.odt` open → `/instdir/user/backup/seed.odt.bak` open/close → `/work/lu*.tmp` に 9,900 byte →
`rename` → `.bak` unlink。`saved` の放送(host → PKC の受け渡し)も 1 件(size 9,900)出た。
つまり A / B / C の「0 件」は、**観測点が見えないのではなく、書き込みが起きなかった**。

### 読み直し(A の後、`PKC3_AR_REVISIT=1`)

32 秒待って(退避が `localStorage` に出る時間)読み直し → 8.8 秒で版面が出て、状態は `表示中`、版面の絵は**起動直後の絵と同じ**(= 打った字は戻らない)。
`registrymodifications.xcu` に `RecoveryList` が無かったので、回復の窓が出る条件を作れておらず、**「退避された設定で回復の窓が出るか」は測れなかった**。
(`docrecovery*.ui` 4 本は一式に入っている。窓の題名の取得は 0 文字で、観測点としては役に立たなかった。)

## 6. 隣の穴 2 つ(smoke の再現)

どちらも `PKC3_AR_SCENARIO=stopband|replace`(`PKC3_AR_MODE=none` = 設定は足さない)。実物の一式・`host.html` で、本体の代役は同一 origin の別 tab
(放送の封筒は `OfficeWindow` と同じ)。⚠ **本体の UI(添付の「Office で開く」)は通していない**。本体側の振る舞いは、実物の `OfficeWindow` クラスを一時の vitest で直接叩いて確かめた(file は消した)。

### ① 停止の帯の「読み込み直す」 → 文書が渡らず Start Center になる ── **再現した**

| 段 | 観測 |
|---|---|
| 前 | `__loDocPath` = 設定済み / `/work` に 1 件 / `ready-for-document` の回数(`sessionStorage`)= 1 / 窓の URL = `host.html?await-doc=1&name=…` / 状態 `表示中` |
| 帯を出す | wasm 由来の `ErrorEvent`(`RuntimeError: function signature mismatch`)で状態 `停止`。ボタンは `読み込み直す` / `設定を初期化して開き直す` の 2 つ |
| 押す | 帯の `読み込み直す` → 同じ URL(`?await-doc=1&name=…`)のまま作り直し |
| 後(押して 49 秒) | 状態 `表示中`、**`__loDocPath` = 無し / `/work` = 無し**(文書が渡っていない)/ `ready-for-document` の回数 = **2**(窓は再び「ちょうだい」と言った) |
| 本体側(クラスを直接叩いた) | `open({bytes})` → 1 回目の `ready-for-document` で `document` を **1 通**送る → 2 回目の `ready-for-document` では **0 通**(`pendingDoc` は送った時点で手放される。`office-window.ts` 336-339 `sendDocument`) |

材料: `public/office/host.html` 209-210(`again` → `location.reload()`)/ 1463(`await-doc` のとき 15 秒待ち、来なければ `resolve(null)` = Start Center)/
`src/adapter/platform/office/office-window.ts` 322-331(`receive`: `ready-for-document` → `askedForDoc = true; sendDocument()`)・336-339(`pendingDoc = null` にして送る)。
同じ `location.reload()` は `host.html` 261(`degrade` の帯)/ 1054(設定の初期化の帯)/ 1321(`showRestartBand`)/ 1378(準備が終わっていない帯)にも在り、URL に `await-doc` が付いている窓では同じ形になる(今回は 209-210 だけ実測。他は読んだだけ)。

### ② 窓が開いているときに別の添付を開くと、未保存が確認なしで消える ── **再現した**

| 段 | 観測 |
|---|---|
| 前 | `.odt` を開いた窓に 12 文字を打った(版面の絵が入れ替わった = 届いた)。`/work/seed.odt` は **size 8,926 / mtime 不変**(保存していない)。`saved` の放送 0 件 |
| 操作 | 本体の代役が `focus-request` + `reload-request {name:'other-seed.odt', awaitDoc:true}` を放送(`OfficeWindow.open()` が窓の開いているときに送る 2 通と同じ。実物のクラスで確認: `already-open` → この 2 通) |
| 結果 | **124 ms で `location.replace`**(`framenavigated` 1 回)。`dialog`(`beforeunload` の確認)**0 件**。`saved` の放送 **0 件**。新しい窓は `?name=…&await-doc=1` で開き直し、文書は渡った(`__loDocPath` 設定済み)。打った 12 文字は **どこにも残っていない**(保存も放送もされていない) |

材料: `public/office/host.html` 171-174(`reload-request` → `location.replace`。未保存の確認なし)/ 485-489(`beforeunload` は `watch.pendingCount() === 0 && !busy` なら何もしない = **渡している最中の保存**だけを守る。LO の中の未保存は見ない)/
`src/adapter/platform/office/office-window.ts` 216-228(`isProbablyOpen()` のとき `focus-request` + `reload-request` を放送)。
⚠ Playwright の自動操作での 1 回。本物のブラウザ・user の `beforeunload` の扱い(操作済みでないと出ない等)での差は見ていない。

## 設計に効く事実(3 つまで)

1. この一式では、LO の自動回復は**既定でも(10 分)、1 分に絞っても、`.odt` / `.docx` とも、書き込みを 1 件も起こさなかった**(220〜795 秒)。同じ観測点は明示の保存なら鳴る。
2. 生きている設定の名前は `Recovery/AutoSave` の `Enabled` / `TimeIntervall`(`Common/Save/Document` の `AutoSave*` はスキーマが「Not used anymore」)。窓の既存の設定退避(`pkc3-office-profile`)がそのまま設定の入れ口として使える。
3. 明示の保存 1 回は LO の中の `/instdir/user/backup/<名前>.bak`(保存前の版)を一時的に作って消し、保存の区間で窓の main thread を 250〜460 ms 塞ぐ(この箱・1 回)。

## 測れなかったもの・読んでいないもの

- 自動回復の backup の**置き場 / 形式 / 塞ぎ時間 / 最小間隔の効き**(書き込みが無かったため)。`TimeIntervall` = 0 や小数、`UserAutoSaveEnabled` = true、`.xlsx` / `.pptx` は**試していない**。
- 「回復の窓が出るか」(`RecoveryList` を作れなかったため)。
- この一式は `cui/ui/querydialog.ui` が 0 件(完全一致)なので、`.docx` の**明示保存**は訊かれる / 落ちる側のはず(今回は `.docx` を保存していない)。
- LO のソース(`framework/source/services/autorecovery.cxx`)・上流の clone は**読んでいない**。「なぜ書かれなかったか」の原因(サービスが登録されていない / timer が発火しない / 無操作の判定 など)は**未特定**。上の rdb の字の有無は材料であって原因ではない。
- 実機(macOS / DPR 2 / user の環境)は見ていない。この箱の headless Chromium 1 種類のみ(`chromium_headless_shell` では回していない)。
- 落ちた回数: A / B / C / 対照群 / 隣の穴 2 つとも、各 1 回(繰り返しは無い)。`memory access out of bounds` は console に出ていない(版面を押していない)。
