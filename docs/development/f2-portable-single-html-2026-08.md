# F-2 完全埋め込み HTML ── 実測 2 点と設計(2026-08-05)

> 正本 doc `pkc3-major-upgrade-design-2026-07.md` **§9.2 ①(可搬単一 HTML・主)** が
> 未実装だったことへの対応。指示書は PR #72。
>
> ⚠ **doc-first**。本 doc は user 裁定を待つ。実装は裁定後。

---

## 0. まとめ(先に結論)

| 問い | 答え |
|---|---|
| ① `file://` で storage は持つか | **OPFS は使えない。IDB は使えて永続する** |
| なぜ OPFS が落ちるか | secure context ではなく **opaque origin(`origin: null`)** |
| ② アプリを 1 ファイルに畳めるか | **畳める。実物を畳んで `file://` で boot させた**(559ms で ready) |
| 正本 doc の「file:// 自立動作」は成立するか | **成立する。ただし形が変わる** ── 永続は OPFS ではなく **IDB の DB 画像** |
| 実装の分量 | **M〜L**(build の単一化 + worker の classic 化 + file:// 永続経路) |

🔴 **正本 doc §9.2 ① の「ストレージへクローン」は書き直しが要る。**
「クローン先」が OPFS 前提だと `file://` では成立しない。

---

## 1. 実測① `file://` で storage は持つか

計測: 同梱 Chromium(`/opt/pw-browsers/chromium`)、persistent profile、
`--no-sandbox` のみ(**追加 flag なし = user がダブルクリックしたとき**)。
対照群として `--allow-file-access-from-files` あり、および `http://` 配信。

### 能力の一覧

| 能力 | `file://`(既定) | `file://` + `--allow-file-access-from-files` | 対照: `http://` |
|---|---|---|---|
| `origin` | **`null`**(opaque) | `file://` | 通常 origin |
| `isSecureContext` | **`true`** | `true` | `true` |
| `crossOriginIsolated` | `false` | `false` | `false` |
| OPFS `getDirectory()`(メイン) | **SecurityError** | OK | OK |
| OPFS `getDirectory()`(worker 内) | **SecurityError** | OK | OK |
| OPFS `createSyncAccessHandle()` | **SecurityError** | OK | OK |
| IndexedDB(メイン / worker) | **OK** | OK | OK |
| localStorage | OK | OK | OK |
| `navigator.locks`(writer lease) | OK | OK | OK |
| `WebAssembly.instantiate` | OK | OK | OK |
| **classic** blob Worker | **OK** | OK | OK |
| **module** blob Worker | **起動しない**(空の error event) | OK | OK |
| 相対 `.js` を `new Worker()` | **SecurityError**(origin null から読めない) | OK | OK |
| `data:` URL の Worker | OK | OK | OK |
| `import()`(blob URL) | OK | OK | OK |

🔑 **`isSecureContext` は `true` である。** PR #72 の想定
(「`file://` は secure context ではないので OPFS が使えない」)は**理由が違う** ──
Chromium は `file:` を potentially trustworthy として扱うので secure context 判定は通り、
落ちているのは **opaque origin にストレージバケットを割り当てない**ほうの規則である。
だから「secure context を満たせば直る」筋の対策(例: 何かを https 化する)は効かない。

### 永続するか(再読込を越えるか)

`file://` origin `null` で 3 回計測(1 回目に書き、2 回目に同じファイルを再読込、
3 回目に**中身が同じ別ファイル**を開く):

| 走り | IDB の読み | localStorage |
|---|---|---|
| 1 回目(`A` を書く) | (無い)→ `A` | `null` → `A` |
| 2 回目(同じファイルを再読込) | **`A`** | **`A`** |
| 3 回目(コピーした別 HTML) | **`A`** | **`A`** |

`navigator.storage.estimate()` は `{"quota":162331904409,"usage":1543,
"usageDetails":{"indexedDB":1543}}` ── **器はある**。

🔴 **3 回目が最重要の危険。** `file://` のストレージは **scheme 全体で 1 個の器**である。
配った HTML を 2 個ダウンロードして両方開くと、**同じ IDB を共有して混ざる**。
→ **DB 名に「そのバンドル固有の id」を含めなければならない**(§4-3)。

---

## 2. 実測② アプリを 1 ファイルに畳めるか

### 現状(対照群)

`VITE_PKC_KIND=product npx vite build` の `dist/` を `file://` で開くと **真っ白**。

```
Access to CSS stylesheet at 'file:///…/assets/index-*.css' from origin 'null'
  has been blocked by CORS policy: Cross origin requests are only supported for
  protocol schemes: chrome, chrome-extension, chrome-untrusted, data, https…
```

JS も同じ理由で落ちる。**単一化は最適化ではなく前提条件**である。
(`assets/*.js` は実測 **105 個**。)

### 畳んだ

`build` に次を足した捨て config で計測(commit していない):

```ts
build: {
  assetsInlineLimit: Number.MAX_SAFE_INTEGER,  // wasm・画像を data: へ
  cssCodeSplit: false,
  rolldownOptions: { output: { inlineDynamicImports: true } },  // = codeSplitting: false
},
worker: { format: 'iife' },                     // worker を classic に
```

結果 ── **105 chunk → app 1 個 + worker 3 個 + CSS 1 個**:

| 生成物 | サイズ |
|---|---|
| `index-*.js`(app 本体・動的 import を全部畳んだもの) | 3.79 MB |
| `storage-worker-*.js`(**sqlite wasm を data: URL で内包**) | 1.43 MB |
| `markdown-worker-*.js` | 0.17 MB |
| `asset-worker-*.js` | 0.94 KB |
| `style-*.css` | 28 KB |

🔑 **wasm は `assetsInlineLimit` で Vite が自動的に `data:application/wasm;base64,…` へ
埋めた。** `fetch(data:)` は `file://` でも許可されているので、追加の細工は要らない
(上の CORS エラーの許可 scheme 一覧に `data` が入っている)。

### 1 個の HTML にして `file://` で起動させた

上記 `dist` を後処理で 1 ファイル(**5.13 MB**)に畳み、`file://` で開いた:

| 観測点 | `file://`(既定) | 対照: 同じファイルを `http://` |
|---|---|---|
| boot | **ready まで 559ms** | ready まで 540ms |
| VFS | `:memory:`(fallback) | `opfs-sahpool` |
| 状態行 | `⚠ SecurityError: It was determined that certain files are unsafe…` | (空・hidden) |
| ノートを 1 件作る | **できる**(一覧 0 → 1) | できる |
| **再読込後** | **0 件 ── 消えた** | **1 件 ── 残った** |

🔑 **既存の fallback 告知がそのまま効いた**(`initStorage` の `fallbackReason` が
状態行に出る)。silent fallback にしていなかったのが、ここで効いている。

### 唯一の source 変更点

app が worker を作る式は、`worker.format: 'iife'` にしても
**`{type:'module'}` のまま**残る(Vite の `worker-import-meta-url` は URL だけ書き換える):

```js
new Worker(new URL(``+new URL(`storage-worker-*.js`,import.meta.url).href,…),{type:`module`})
```

`file://` では **module worker が起動しない**(実測)ので、
`?worker&inline`(classic)へ移すか、`type` を落とす必要がある。
後処理では blob classic worker に差し替えて通した。

残った相対参照は `sqlite3-worker1-*.js` 1 件だけ ──
`sqlite3Worker1Promiser` 用で PKC3 は呼ばない(遅延評価なので boot は壊れない)。
**alias で空 stub に差し替えれば 1.36 MB 減る**(裁定不要の枝葉)。

---

## 3. `:memory:` + IDB 画像にしたときの定常コスト

`file://` では OPFS が無いので、永続は **DB 画像を丸ごと IDB へ書く**しかない。
使い物になるかを測った(本文 = 日本語 1000 字 ≒ 3KB UTF-8、worker 内で計測)。

| 件数 | DB | 1 行 UPDATE | 画像 export | IDB put | **保存の合計** | 起動時の復元(IDB get + deserialize) |
|---|---|---|---|---|---|---|
| 200 | 0.84 MB | 0.4 ms | 3.6 ms | 13.3 ms | **17 ms** | 2.7 + 1.0 ms |
| 1,000 | 4.1 MB | 0.0 ms | 19.5 ms | 86.1 ms | **106 ms** | 4.8 + 1.0 ms |
| 3,000 | 12.4 MB | 0.2 ms | 131.4 ms | 204.2 ms | **336 ms** | 64.8 + 7.5 ms |
| 8,000 | 33.0 MB | 0.2 ms | 362.8 ms | 620.8 ms | **984 ms** | 42.1 + 8.2 ms |

読み方 ──
- **1 行 UPDATE は件数に関係なく 0.2〜0.4 ms。** つまり sqlite 側は無関係で、
  効いているのは**画像を丸ごと書く**ぶんだけ
- 保存コストは **DB サイズにほぼ比例**(33MB で約 1 秒)
- **起動時の復元は安い**(33MB で 50 ms)── 読み側は問題にならない
- ⚠ この 1 秒は **worker の中**なので、メインスレッドの応答は止まらない。
  ただし「保存が終わるまで閉じないで」の窓が 1 秒開く

### 常駐メモリ(user 指示 2026-08-03「効くのは定常」)

⚠ **走りを分けて測った** ── `sqlite3_js_db_export` は画像を wasm heap に丸ごと
割り当てるので、同じ走りで heap を読むと「DB が heap に載るぶん」と
「export が食うぶん」が混ざる。下表は **export を一度もしていない走り**:

| 件数 | DB | `:memory:` の wasm heap | 対照: `opfs-sahpool` |
|---|---|---|---|
| 200 | 0.84 MB | 8.4 MB | 8.4 MB |
| 1,000 | 4.1 MB | 8.4 MB | 8.4 MB |
| 3,000 | 12.4 MB | 14.5 MB | 14.5 MB |
| 8,000 | 33.0 MB | **36.5 MB** | **21.0 MB** |

- 3,000 件までは差が無い(sqlite の page cache に収まる)
- 8,000 件で **+15.5 MB**。`:memory:` は **DB サイズにほぼ 1:1 で常駐が伸びる**、
  OPFS は cache 上限で寝る
- ⚠ export の走りでは `:memory:` が 81 MB まで伸びた(画像 33MB の割当ぶん)。
  wasm heap は**縮まない**ので、保存のたびにピークが常駐に昇格する ──
  §4-2 の「保存は画像を作らない経路を優先する」の根拠

---

## 4. 設計(裁定を仰ぐ点)

### 4-1. 形を 2 つに分ける ── これが本題

実測から、1 個の成果物に**性格の違う 2 つ**が混ざっていることが分かった。

| | **配布バンドル(F-2)** | **静的ホスト版** |
|---|---|---|
| 置き方 | 1 個の `.html` を渡す・USB で持つ | 静的 web サーバ / Pages に置く |
| 開き方 | `file://` ダブルクリック | `https://` |
| storage | **`:memory:` + IDB 画像** | OPFS SAHPool(いまのまま) |
| 保存 | 33MB で約 1 秒(worker 内) | 1 編集 0.2 ms |
| 常駐 | DB サイズにほぼ比例 | cache 上限で寝る |
| 器の分離 | ⚠ **file:// 全体で共有** → id で名前空間を切る | origin で分かれる |

🔴 **裁定を仰ぐ点 A**: この 2 つを **同じ 1 個のファイル**にするか、分けるか。
- **推奨: 同じ 1 個**。中身は同一で、boot 時に「OPFS が取れたか」で経路が決まるだけ。
  実測で「同じファイルが `file://` では `:memory:`、`http://` では OPFS」になることを
  確認済み ── **すでにそう動く**。2 つ作ると「どっちを配ったか」の事故が生まれる

### 4-2. `file://` の永続経路

```
boot:  IDB から画像を読む → sqlite3_deserialize → :memory: の DB として開く   (33MB で 50ms)
保存:  ① まず sqlite に書く(0.2ms・即座に一貫)
       ② 画像の書き出しを **束ねて遅延**(idle / debounce)、worker 内で IDB へ put
```

🔴 **裁定を仰ぐ点 B**: 保存の遅延をどう見せるか。
- 案 1(推奨): **未保存の窓を状態行に出す**(「保存待ち」→「保存済み」)。
  `visibilitychange` / `beforeunload` で強制 flush。窓は debounce のぶんだけ
- 案 2: 毎編集で同期保存。33MB で 1 秒の窓が毎回開く ── 常駐も 1 秒ごとに
  ピークへ昇格するので**推奨しない**

⚠ **画像の割当は heap に残る**(§3)。`sqlite3_js_db_export` の戻りは
即 `Blob` にして手放す ── 2026-07-27 の不可侵指示(生成物のライフサイクル終端で即破棄)
と同じ向き。ただし **wasm heap は縮まない**ので、保存頻度を落とすこと自体が
メモリ対策になる。

### 4-3. 器の名前空間 ── データ混在の防止

`file://` は scheme 全体で 1 個の器(実測)。**バンドル固有の id を DB 名に入れる**:

```
IDB database: pkc3-bundle-<bundle_id>
bundle_id = 書き出し時に生成して HTML に焼き込む(container id + 書き出し時刻の hash)
```

🔴 **裁定を仰ぐ点 C**: 同じバンドルを**2 回ダウンロードした**とき(同じ id)。
- 案 1(推奨): **同じ器を共有する**(= 同じ知識コンテナの続き。id が同じなら同一物)
- 案 2: 開いた瞬間に新しい器へ分岐。「どっちが本物か」が分からなくなるので推奨しない

⚠ どちらでも、**器に入っている DB が「配られた画像より新しい」場合は器を優先する**
(上書きすると user の編集が消える)。判定材料として画像に
`exported_at` と `bundle_id` を持たせる ── **壊れを検出する材料を捨てない**(CLAUDE.md)。

### 4-4. 埋め込む画像と assets

正本 doc §4.6 は「boot でストレージへクローンし **DOM から除去**」。
実測を踏まえた形:

- **sqlite image**: 圧縮して base64 で `<script type="application/octet-stream;base64">` に。
  boot で読み → `deserialize` → **その script 要素を除去**(DOM から外して heap を返す)
- **assets**: `pkc3-html.ts` が既に持っている **3 の倍数チャンク base64** の資産を流用
  (`base64Chunks`)。boot では**全部復号しない** ── IDB Blob へ移すぶんだけ流す
- ⚠ **書き出し側は既に「参照されている添付だけ」を載せる**(`used` keep-set)。
  ここも流用する

### 4-5. 分量と段取り

| 段 | 内容 | 見積り |
|---|---|---|
| ① | build を単一化(`codeSplitting:false` / `assetsInlineLimit` / CSS inline)+ **下限つき tripwire** | S |
| ② | worker を classic 化(`?worker&inline`)+ `sqlite3-worker1` を空 stub に | S |
| ③ | `file://` 永続経路(IDB 画像の boot 復元 / 遅延保存 / 器の名前空間) | M |
| ④ | 書き出し側(アプリ + 画像 + assets を 1 HTML に)| M |
| ⑤ | 検証(`file://` の実 Chromium smoke + 変異試験) | S |

⚠ **① には下限の tripwire を置く**(CLAUDE.md「tripwire は上限だけでなく下限も」)──
単一化は「参照が消えて縮む」方向に壊れるので、
**「hash 付き生成物への参照が 0 件」ではなく「app chunk が inline されていて、
外部 `.js`/`.css` 参照が 0 件」**を検査する。size cap だけでは 0 バイトを通す。

---

## 5. 測っていないこと(断らない)

- **Firefox / Safari の `file://`**。同梱が Chromium だけなので未測。
  Firefox は `file://` の IDB を長く塞いでいた経緯があり、**器が無い可能性**がある
  → 実装時は「IDB も取れない」経路(= 読むだけ・保存不可を明示)を持たせる
- **33MB を超える DB**。8,000 件までしか測っていない。保存が比例で伸びるので
  30,000 件なら約 4 秒 ── 遅延保存が前提になる
- **assets が大きいバンドル**の boot。画像だけを測った(添付 0 件の走り)
  ── ⚠ **添付ゼロは「測っていない次元」**である
- **2 タブで同じバンドル**。`navigator.locks` は `file://` でも動く(実測)ので
  writer lease は張れるが、`:memory:` は**タブごとに別の DB** になる ──
  ここは実装前に測る

---

## 6. 実測の再現手順

計測物は scratchpad(セッション限り)。再現するなら:

1. `probe3.html` 相当 ── `origin` / `isSecureContext` / OPFS(メイン・worker)/
   IDB / locks / WASM / blob worker(classic・module)/ 相対 `.js` worker / `import()`
   を 1 ページで叩き、`document.body.dataset.done` で完了を待つ
2. 永続 ── 同じ persistent profile で「書く → 再読込 → コピーした別ファイル」の 3 走り
3. 単一化 ── §2 の捨て config で build → 後処理で 1 HTML → `file://` と `http://` の両方で boot
4. 定常 ── worker の中で `mode=heap` と `mode=time` を**別の走り**にする(§3 の注意)

⚠ すべて **`--no-sandbox` のみ**で走らせる。`--allow-file-access-from-files` を
付けると origin が `file://` になって **OPFS が通ってしまう** ── user の環境ではないので、
それを既定として測ってはならない。
