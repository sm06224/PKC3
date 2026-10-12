# F-2 完全埋め込み HTML ── 実測 2 点と設計(2026-08-05)

> 正本 doc `pkc3-major-upgrade-design-2026-07.md` **§9.2 ①(可搬単一 HTML・主)** が
> 未実装だったことへの対応。指示書は PR #72。
>
> ✅ **2026-08-25 に着地**(#400 段①〜⑤、PR #409 / #416)。
> ⚠ **本 doc は「そのとき測ったこと」の記録である** ── 実装で変わった 2 点は
> 下の「## 7. 着地時に変わったこと」に書いた。**§4 の裁定案をそのまま読まないこと。**

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


---

## 7. 着地時に変わったこと(2026-08-25)

⚠ **§4 の裁定案は 2 つ変わった。どちらも実測が決めた** ── 提案のまま読むと外す。

### 7-1. 裁定 A を狭めた ── 可搬バンドルは **OPFS を試さない**

§4-1 は「同じ 1 個のファイルで、boot 時に OPFS が取れたかで経路が決まる」と
書いていたが、**取れたときのほうが困る**ことが分かった:

- `file://` では原理的に取れない(§1 の実測)
- `https://` に置いたときは、**その origin の本体の DB を開いてしまう**
  (器の名前が `pkc3` で同じなので)

つまり**どちらでも試す理由が無い**。試さないほうが経路が 1 本で済み、
§4-1 自身の「2 つ作ると『どっちを配ったか』の事故が生まれる」と同じ向きである。

⚠ 帰結として `:memory:` は **fallback ではなく選んだ形**になったので、
`fallbackReason` を載せない ── 載せると状態行に `⚠ SecurityError …` と出て、
**選んだ形を事故として告げる**ことになる。

### 7-2. 裁定 C を強めた ── 器の名前空間は**正しさの要件**である

§5 が「**2 タブで同じバンドル … ここは実装前に測る**」と書いていたので測った
(2026-08-25、実 Chromium)── **前提が 1 つ間違っていた**:

| 問い | 結果 |
|---|---|
| `navigator.locks` は `file://` で使えるか | ✅ とれた |
| 2 タブで `location.origin` は | `["file://", "file://"]` |
| 🔴 **別ディレクトリの別ファイル**同士で IDB は | 🔴 **共有される** |

§4-3 は名前空間を「データ混在の防止」という**設計の一項目**として挙げていたが、
実測はもっと強いことを言っている ── **切らなければ、その端末の可搬バンドル全部が
互いを上書きする**。だから切ったのは器だけではない:

| 何 | 名前 | 切らないとどうなるか |
|---|---|---|
| IndexedDB の器 | `pkc3-bundle-<id>` | 別のバンドルの DB 画像を上書きする |
| 書込リースの鍵 | `pkc3-writer-<id>` | 別のバンドルを開いている間、開けない |
| タブ間の放送路 | `pkc3-store-proxy-<id>` | **別のバンドルのタブを holder と見なす** |
| sqlite の器 | `pkc3-<id>` | `https://` に置いたとき本体の DB を開く |

🔑 **「これが分かったら覆る」**: ブラウザが `file://` に per-file の storage bucket を
与えるようになったら、器と鍵の名前空間は要らなくなる。⚠ ただし**既に配った 1 枚の
器が変わる**ので、そのときは移行が要る(黙って切り替えると user のノートが消える)。

### 7-3. 雛形の id は**固定**にした

書き出しは 1 回ごとに新しい id を焼くが、**雛形(`fold.mjs` が畳んだ素の 1 枚)は
固定の `pkcb-template`** である。⚠ 中身の hash から導くと、**アプリを更新して
落とし直した瞬間に前の版で書いたノートが行方不明**になる ── user から見れば
「新しいのを開いたら空だった」である。

### 7-4. §5「測っていないこと」のうち、片付いたもの / まだのもの

| 何 | いま |
|---|---|
| 2 タブで同じバンドル | ✅ 測った(7-2)。writer lease は張れる |
| Firefox / Safari の `file://` | ❌ **まだ**(同梱が Chromium だけ)。⚠ IDB も取れない環境では、器へ書けない旨が状態行に出る形にはなっている |
| 33MB を超える DB | ✅ **測った**(40 / 80 / 150 / 300MB。7-4a)。**壊れた物は無かった**が、起動の待ちが**DB の大きさより速く伸びる**(300MB で 74 秒)。上限の断りは 395MB で働いた |
| assets が大きいバンドルの boot | ✅ **測った**(添付の総量 50 / 200MB。7-4b)。**壊れた物は無かった**。⚠ 添付 1 件が大きい形・本文から参照される形・履歴や つながり が在る形は**測っていない**(7-4c) |

#### 7-4a. 33MB を超える DB(#1416、2026-10-12)

**環境**:main の `1bc739a5` を `npm run build` + `npm run build:portable` した物。Linux 4 コア / 16GB、
Chromium 1194(同梱のフル版、headless)、Playwright の persistent context。アプリは `vite preview`
(COOP/COEP 付き)から開き、書き出した 1 枚は `file://` と、ヘッダを何も足さない自前の node の HTTP 配信の
2 通りで開いた。**走りごと(書き出す / 開く / 取り込み直す)に新しい profile**。
**入れ物の作り方**:生成した日本語・英語まじりの PKC-Markdown(見出し・箇条書き・表・コード・チェックリスト、
1 ノート約 8KB の text)を `writeArchive` で `.pkc3-full.zip` にし、アプリの取り込みから入れた
(つながり・履歴は 0 件)。**書き出しは右の列の実際のボタン**、**取り込み直しは「取り込み」に 1 枚を選ぶ道**(#1552)。

⚠ **DB の大きさ = 書き出した 1 枚の中の DB 画像のバイト数**(HTML の base64 の字数 × 3/4)。本文の約 3.3 倍
(検索の索引ぶん)で、1 ノート約 26KB。MB は 10^6 バイト。「Pss」は browser・renderer・worker・gpu を足した
**プロセス木の Pss**(JS の heap だけでは worker の中の wasm が見えない ── 開いた後の JS heap は 7〜23MB
のままで、書き出し・取り込みの峰でも 42〜264MB。`:memory:` の DB は worker の wasm に在る)。空のアプリの Pss は添付なし小 DB の走りで 約 310〜470MB
(別に空の走りは測っていない)。

| DB | ノート | 1 枚 | 書き出し(押す → 保存) | 書き出しの Pss 峰 | 開く `file://` / http(最初の一覧まで) | 開いた後の静止 Pss(5 秒) | 1 件足した峰 Pss | 読み直し(2 回目の起動) | 取り込み直し(選ぶ → 確認 + 確認 → 完了) | 取り込みの Pss 峰 |
|---|---|---|---|---|---|---|---|---|---|---|
| 40.0MB | 1,500 | 66.2MB | 4.1 秒 | 885MB | 4.0〜4.4 秒 / 4.1 秒 | 543MB | 760MB | 3.6 秒 | 1.8 + 4.1 秒 | 833MB |
| 79.5MB | 3,000 | 118.9MB | 7.2 秒 | 1,215MB | 8.7〜9.1 秒 / 8.7 秒 | 726〜735MB | 1,136〜1,313MB | 7.7〜8.8 秒 | 3.7 + 8.9 秒 | 1,239MB |
| 148.4MB | 5,700 | 210.7MB | 17.0 秒 | 1,708MB | 23.2 秒 / 23.7 秒 | 1,040〜1,058MB | 1,949〜2,037MB | 23.4 秒(file)/ 24.1 秒(http) | 6.3 + 18.6 秒 | 1,848MB |
| 295.3MB | 11,400 | 406.7MB | 40.0 秒 | 2,589MB | **74.2 秒** / ─(測っていない) | 1,314MB | **3,669MB** | **76.1 秒** | 12.0 + 38.9 秒 | 3,195MB |
| 414.6MB(`humanBytes` で 395.4MB) | 16,000 | ─ | **断られた**(下記) | ─ | ─ | ─ | ─ | ─ | ─ | ─ |

読み方 ──
- **どの大きさでも、書き出した 1 枚は `file://` でも http でも起動し、ノートは全件出て、1 件足して読み直しても
  残った**(N+1 件)。取り込み直しも全件戻った。ページ側のエラーは 0 件
  (http の走りで出た `unsupported MIME type ('text/html')` は、**自前の配信が全部の path に同じ HTML を返した**ためで、
  アプリの不具合ではない)
- 🔴 **起動の待ちが DB の大きさより速く伸びる**:1MB あたり 40MB で 0.10 秒、80MB で 0.11 秒、150MB で 0.16 秒、
  300MB で 0.25 秒。**読み直しも同じ時間**(76 秒)なので、器に書いた後の 2 回目でも速くならない。
  ⚠ **どこが遅いかは切り分けていない**(HTML の読み込み / base64 の復号 / 器への書込み / sqlite の復元 / 一覧の描画の
  どれか。§3 の「起動時の復元は 33MB で 50ms」はこの待ちに入っていない物の値)
- 保存の山:1 件足したときの Pss 峰が、静止より **+220MB(40MB)〜+2,350MB(300MB)** 上がる
  (DB 画像を丸ごと作るため。§3 の「wasm heap は縮まない」の延長)。300MB で 3.7GB なので、**メモリの少ない端末では
  ここが先に詰まる**可能性がある(この箱は 16GB で、詰まった走りは無い)
- 書き出しは DB の大きさにほぼ比例(40MB で 4 秒 → 300MB で 40 秒)。取り込み直しも同じ向き
- **上限の断り**:`MAX_EMBED_TEXT_CHARS` から出る境目は 402,653,166 バイト(`image-export-limit.ts`)。
  414.6MB の DB は書き出しが**断られ**、状態行に「いまの中身(395.4 MB)は「PKC3 入り HTML」に入れられません。…」
  と出た(静かに焼いて開けない 1 枚を作る形ではなかった)。**295.3MB は通り、414.6MB は断られた** ──
  境目そのもの(402.7MB)の上下は**測っていない**

#### 7-4b. 添付の総量が大きいバンドル(#1416、2026-10-12)

同じ環境。ノート 100 件(DB 3.0MB)に、**乱数で埋めた 2MB の添付**(png / pdf の頭の印だけ付けた)を 25 件 / 100 件入れた
(= 総量 50MB / 200MB)。添付はどのノートからも参照していない。

| 添付の総量 | 1 枚 | 書き出し | 書き出しの Pss 峰 | 開く `file://` / http | 器へ戻った添付(開いた直後に IDB を数えた) | 静止 Pss | 読み直し | 取り込み直し(選ぶ → 確認 + 確認 → 完了) | 取り込みの Pss 峰 |
|---|---|---|---|---|---|---|---|---|---|
| 50MB(25 件) | 83.6MB | 4.9 秒 | 594MB | 3.0〜3.2 秒 / 3.4 秒 | 25 件 / 50.0MB | 401〜468MB | 1.8〜2.1 秒 | 3.1 + 1.7 秒(添付 25 件) | 727MB |
| 200MB(100 件) | 283.7MB | 18.0 秒 | 716MB | 7.8 秒 / 12.5 秒 | 100 件 / 200.0MB | 664MB | 6.5 秒(file)/ 5.5 秒(http) | 7.3 + 5.6 秒(添付 100 件) | 1,607MB |

読み方 ──
- **添付は全件が器の Blob に戻り**(件数もバイト数も一致)、取り込み直しも 25 / 100 件が戻った
- 添付が主役のバンドルは、**同じ 1 枚の大きさでも DB が主役のバンドルより軽い**:静止 Pss は 283.7MB の 1 枚で 664MB
  (DB 295MB の 406.7MB の 1 枚では 1,314MB)。1 件ずつ流す作り(`portable-assets.ts`)のとおり、
  書き出しの JS heap 峰も 42〜59MB で、総量に比例して伸びていない

#### 7-4c. 測っていないこと(正直に)

- **Firefox / Safari / 実機(iPhone など)**。この走りは Chromium 1 種だけ(#1416 の (a)。端末が要る)
- **添付 1 件が大きい形**(1 件 100MB 超など)。2MB の添付の数だけを増やした。1 件の添付の読み戻しの上限
  (`tooBigToReadBack`)は添付にも掛かるが、境目の上下は走らせていない
- **本文から参照される添付 / 描画される画像・pdf**。乱数のバイト列で、描画は見ていない
- **つながり・履歴が在る DB**。0 件で作った(履歴は DB を膨らませる ── §2.2 の「ゼロ件の次元」)。
  DB が同じ大きさでも、ノート数・履歴の多さで起動の待ちが変わるかは分からない
- **1 件足したときの保存の所要**。画面の「保存中」の印が出なかったので所要は測れず、
  「5 秒待てば残る」ことだけ見た。⚠ **未確認の観測が 1 つ**:80MB の走りで、確定の約 0.5 秒後に読み直したら
  足したノートが残らなかった(同じ 80MB で 5 秒待った走りは残った。40MB は 1.5 秒で残った)。
  再現の回数は 1 回で、閉じる合図の後にどこまで書き終えるかは**調べていない**
- **起動が遅い理由**(7-4a の 🔴)。**1 回の走りの値**が大半(n=1。40 / 80MB の開く走りは 2〜3 回で、幅を表に書いた)
- 開いた後の静止は 5 秒の窓だけ。**長時間の編集セッションは測っていない**
- この箱の他のプロセスは止めたが、同時に走らせたものが無いことまでは保証しない
