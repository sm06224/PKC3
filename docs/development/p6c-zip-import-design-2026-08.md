# P6c: PKC2 の ZIP 系取込 ── 設計(2026-08)

> `p6-import-export-design-2026-08.md` §6 の **P6c**。P6b で「ZIP magic を検出したら
> 可視で断る」ところまで着地済み(`src/adapter/ui/actions/import-pkc2.ts`)。
> 本書はその断りを外して受理器を積むための設計。裁定は全件決着(§5)。
> **段① の ZIP reader は着地済み** ── 以降は形式ごとの受理器を積む段。

## 0. 検証の強さ(埋めた風にしない)

| 印 | 意味 |
|---|---|
| ✔ | PKC2 の該当ファイルを開いて確認した |
| ▲ | `file:line` は示すが、別パスの調査由来で本書では再確認していない |
| ✖ | **実体未確認** ── PKC2 が実際に吐いたファイルを 1 バイトも見ていない |

🔴 **8 形式すべてが ✖ である。** 生成コードは全形式について実在を確認したが、
実出力の検品は誰もしていない。本書の「バイトレイアウト」は**コードから読み取った
事実**であって実測ではない。§5-⑤ に現物入手の依頼を置く ── これが推定を事実に
変える最短路である。

---

## 1. 形式一覧(`detect-format.ts` の `MANIFEST_FORMAT` 全 8 件)

すべてフラット(ZIP のディレクトリ entry を持たない)。`html` は P6b 着地済みの参考行。

| # | manifest.format | ZIP レイアウト | body 形式 | asset 格納 | PKC3 での変換先 |
|---|---|---|---|---|---|
| 0 | (なし・HTML) | ── | `#pkc-data` の素 JSON | base64 / gzip+base64 | **着地済**(P6b) |
| 1 | `pkc2-package` | `manifest.json` / `container.json` / `assets/<key>.bin` | Container 全体(entry.body は JSON 文字列値) | **生バイナリ**・`.bin` 固定 | `container.json` → `convertPkc2Container` **そのまま** |
| 2 | `pkc2-text-bundle` | `manifest.json` / `body.md` / `assets/<key><ext>` | **markdown verbatim**(frontmatter 含む) | 生バイナリ・拡張子付き | **合成 container**(§2-4)を組んで convert |
| 3 | `pkc2-textlog-bundle` | `manifest.json` / `textlog.csv` / `assets/<key><ext>` | **CSV**(RFC4180 / CRLF / 全 quote / 固定 8 列) | #2 と同一 | CSV → textlog body JSON へ逆写像 → `fromPkc2` |
| 4 | `pkc2-texts-container-bundle` | `manifest.json` + `<slug>-<date>.text.zip` × N(**ZIP-in-ZIP**) | 内側 #2 | 内側 #2 | 内側を再帰展開 → **1 個の合成 container にまとめて 1 回 convert** |
| 5 | `pkc2-textlogs-container-bundle` | `manifest.json` + `.textlog.zip` × N | 内側 #3 | 内側 #3 | #4 と同型 |
| 6 | `pkc2-mixed-container-bundle` | `manifest.json` + `.text.zip` / `.textlog.zip` 混在 | 内側 #2 / #3 | 内側 #2 / #3 | #4 と同型 |
| 7 | `pkc2-folder-export-bundle` | `manifest.json` + 上記 + **`.entry.zip`**(v2 のみ) | 内側 #2 / #3 / #8 | 内側に委譲 | #4 + `folders[]` → folder entry + `structural` relation |
| 8 | `pkc2-entry-bundle` | `manifest.json` / `entry.json` / `assets/<key>`(**拡張子なし**) | `entry.json` = Entry 丸ごと | 🔴 **base64 文字列を UTF-8 テキストとして格納** ✔(entry-bundle.ts:72) | assets は decode せず base64 のまま渡す |

### 実装が事故る点

- **#8 の格納規約は他 7 形式と非互換**。ヘッダコメント(entry-bundle.ts:13)と実装
  (:72 `textToBytes`)は**互いに整合している**ので、バグと断ずる根拠はコードに無い。
  PKC3 は「コードを正」とし、`pkc2-entry-bundle` なら**常に base64 とみなす**。
  失敗しても raw bytes へフォールバックしない ── 「たまたま base64 文字集合だった
  テキストファイル」と区別が付かないため(推測分岐を作らない)
- **#8 は top-level に現れない**(単独 DL 導線が無く、呼び出しは folder-export.ts:199 ▲)。
  `detectPkc2Format` は 1 段ぶんの `manifestFormat` しか受けないので、
  **呼び出し側がネストの各段で呼ぶ**。この前提を detect-format.ts のコメントに追記する
- **#7 の version は動的**(`otherCount > 0 ? 2 : 1` ▲)。v2 = `.entry.zip` 同梱の印。
  `other_count` は 0 のとき key ごと消えるので、「v1 に無い」は欠損ではなく仕様
- **#8 と #7-v2 は PKC2 自身が読み戻せない** ▲(batch-import.ts:374-380 が archetype
  `'other'` を無言 skip)。PKC3 が受理すれば差分になるが、**round-trip の参照実装が
  存在しない**ので検証の当てが無い(§5-④)
- **manifest のカウンタ 4 種を PKC2 importer は照合していない** ▲。PKC3 は照合して
  warning に出す(§4-L)

### 同じ入口に落ちてくる、PKC2 由来でない ZIP

🔴 **「PKC2 が出す ZIP は全部 manifest.json を持つ」は成り立たない。**
`.xlsx` が PKC2 自前の ZIP writer を使っている ✔(spreadsheet-presenter.ts:45, :1762)。
`.docx` / `.pptx` は外部ライブラリ経由で deflate 圧縮の ZIP になる ▲。

→ root に `[Content_Types].xml` があれば **「これは Office 文書です。取込対象では
ありません」と名指しで断る**。「manifest.json が無い = 不明」に混ぜると user は原因を
誤解する(P6b で確立した「ZIP は ZIP として断る」の延長)。

---

## 2. ZIP 展開器 ── 依存を増やさずに書けるか

### 2-1. 結論: 書ける

| 対象 | 必要なもの | 追加依存 | 焼込量 |
|---|---|---|---|
| **store(method 0)** | EOCD 探索 → CD 走査 → local header skip → `Blob.slice` | **ゼロ** | ~150 行 |
| **deflate(method 8)** | `new DecompressionStream('deflate-raw')` | **ゼロ**(ブラウザ標準) | **1 行** |
| CRC-32 検証 | 256 語テーブル + 1 pass | ゼロ | ~20 行 |
| ZIP64 | 実装しない(検出して断る) | ゼロ | ~5 行 |

- ZIP の method 8 は **raw deflate(zlib ヘッダなし)**。`'deflate'` ではなく
  **`'deflate-raw'`** が正しい指定 ── ここを間違えると全 decode が失敗する
- PKC3 は既に `DecompressionStream('gzip')` を使っている。同じ API の format 違いなので
  **依存も bundle も 1 バイト増えない**(単一 HTML に静的に焼ける ── user 裁定
  2026-07-27 ② の条件を満たす)
- PKC2 の writer は method 0 固定 ▲ なので、deflate が効くのは
  **user が ZIP ツールで開いて再梱包した場合**。PKC2 はこれを throw して断っていた ▲
  → §5-① の裁定事項
- ✅ `'deflate-raw'` は**同梱 Chromium(141)で往復を実測**(gzip / deflate / deflate-raw
  の 3 形式すべて ok)。⚠ ただし**対応下限の版は未確認**のまま ── 対象ブラウザ表を
  決める段で確認する(§5-⑥)

### 2-2. reader は PKC2 から流用 + 3 点の修正

PKC2 の streaming reader(zip-package.ts:477-588 ▲)が骨格として使える。
**そのまま写すと事故る箇所が 3 つある**:

| # | PKC2 | PKC3 | 根拠 |
|---|---|---|---|
| M1 | 入力が `File` | **`Blob`**(`File extends Blob` なので呼び出しは不変) | ZIP-in-ZIP で内側を `new Blob([bytes])` にして**同じ reader を再入**できる。これが無いと内側を全量展開する羽目になる ✔ :477 |
| M2 | general purpose flag(CD の `pos+8`)を**読まない**。名前は常に UTF-8 decode | flag bit 11 を読む。**立っていない かつ 名前に非 ASCII** → 「文字コードを判別できない ZIP」として断る | ✔ :515-524 が pos+8 を読み飛ばしている |
| M3 | **CRC-32 を検証しない**(writer は書く) | 検証する。不一致は断る | ✔ 照合コードが両経路に無い。破損検知が `JSON.parse` 失敗頼みだと、**asset だけ壊れた ZIP が無言で欠けた添付になる** |

**そのまま流用してよい部分**: CD の値を正とする(data descriptor で local header の
size が 0 になっても CD には入っている ✔)/ EOCD は末尾 65557 バイト以内を後方走査 ✔ /
進捗コールバックの粒度。

**断る条件**(すべて可視・黙って落とさない): ZIP64 / method が 0・8 以外 /
flag bit 0(暗号化)/ CD signature 不正 / EOCD なし。

### 2-3. メモリ規律 ── base64 を一切経由しない

PKC2 の ZIP import は読みが streaming なのに、出口で `assets[key] = bytesToBase64(...)`
して Record に全量溜めている ✔(zip-package.ts:265)。総 asset バイト × 4/3 が常駐する。
**PKC3 はここを構造ごと捨てる**:

```
ZIP(Blob)
 └ CD 走査(名前と offset だけ ── バイトは読まない)
 └ manifest.json / container.json → 全読み(小さい)
 └ assets/* → 1 件ずつ:
      Blob.slice(dataStart, dataEnd)        ← コピーしない(Blob は view)
      → method 8 なら DecompressionStream
      → putBlob(newKey, blob)               ← そのまま渡す
      → 参照を手放す
```

ピークは「最大 asset 1 件 + CD」に有界。ZIP-in-ZIP でも「最大の内側 ZIP 1 個 +
その中の最大 asset 1 件」。**例外は #8 のみ**(中身が base64 テキストなので +4/3 が
発生するが、`.folder-export.zip` の内側にしか現れず 1 entry 単位なので許容)。

### 2-4. 🔴 P6a の API に穴がある(P6c の 1 手目)

`ConvertResult.assets` は `{ key(新), base64, mime }` で、**旧 key を返さない** ✔。
`keyMap` は関数内ローカル。→ **ZIP のバイトは convert の外にある**ので、
`assets/<oldKey>.bin` をどの新 key に紐づけるか実行部から引けない。

```ts
export interface ConvertedAsset {
  key: string;        // 新
  oldKey: string;     // ★追加 ── ZIP のファイル名から引くため
  base64: string;     // ZIP 経路では '' を渡す(bytes は外で流す)
  mime: string;
}
```

`convertPkc2Container` に `assets: Record<oldKey, ''>`(キーだけの空 Record)を渡せば、
既存コードは `assetsIn[oldKey] ?? ''` でそのまま動く。**P6a を pin した test に影響
するので最初にやる**(後回しにするほど手戻りが大きい)。

もう 1 点、**mime の出所が bundle 系では違う**: package は attachment body から回収 ✔ /
bundle は **`manifest.assets[key].{name, mime}`** ▲(attachment entry が存在しない)。
→ `ConvertOptions` に `mimeHint?: Record<oldKey, {name, mime}>` を足し、bundle では
manifest を優先する(競合しない ── bundle に attachment entry は無い)。

### 2-5. 合成 container(#2〜#8 は `container.json` を持たない)

PKC3 側で `Pkc2Container` 形の合成物を組み立てて convert に渡す。

```
.text.zip 1 個 →
  entries: [
    { lid: <合成>, archetype:'attachment', title: meta.name,
      body: JSON.stringify({ name, mime, size, asset_key: <oldKey> }) },   × N
    { lid: manifest.source_lid, archetype:'text',
      title: manifest.source_title || '(無題)', body: <body.md 全文> }
  ]
  relations: []
  assets: { <oldKey>: '' }   // bytes は ZIP から直接流す
```

⚠ **「JSON body を作っている」ように見えるが規律違反ではない。** これは *PKC2 入力の
写し*であって、`getFlavor('attachment').fromPkc2` を通した後の PKC-Markdown だけが
保存される。**この 1 行を明記しておかないと、次のセッションが「JSON body を作るな」の
一言で正しい実装を壊す。**

- `lid`: PKC2 の bundle importer は捨てていた ▲ が、PKC3 は `manifest.source_lid` を
  使う(convert が衝突時に再採番する)。attachment は lid を持たないので合成する
- `size`: manifest に無いので**展開後のバイト長**(PKC2 と同じ ✔)
- batch 形式(#4〜#7)は **内側ぶんを 1 個の合成 container にまとめて 1 回 convert**。
  entry ごとに convert すると lid 衝突検査と asset key 採番検査が分断される

---

## 3. 実装順(基準 = 他形式の土台になるか)

> user が実際に持っているデータ量では決めない。**土台性の順**に積む。
> 各段が単独で着地・単独で test できる。

| 段 | 内容 | なぜこの順か |
|---|---|---|
| ✅ ① | **ZIP reader**(`src/features/import/zip-reader.ts`)── Blob ベース / store + deflate / CD 正 / CRC 検証 / M1〜M3 込み | 全 8 形式の土台。形式知識ゼロの純機構なので合成 ZIP fixture だけで pin できた(21 件)。deflate も受理(§5-①)|
| ② | **`pkc2-package`**(#1) | **変換 core をそのまま再利用できる唯一の形式**。ここで §2-4 の API 変更と「ZIP → putBlob の streaming 経路」を確立する ── **bundle 系全部の土台**。かつ user のバックアップ正本なので、**ここまでで「PKC2 から救出できる」が成立する** |
| ③ | **`.text.zip`(#2)→ `.textlog.zip`(#3)** | §2-5 の合成 container 規約を単体 2 形式で確立してから batch へ。text が先なのは #3 が CSV 逆写像を追加で要求するため |
| ④ | **batch 3 形式**(#4 / #5 / #6) | 段③の再帰適用のみ。新概念は「内側 ZIP を Blob 化して reader を再入」の 1 点(M1 で用意済み)。3 形式は外側 manifest の形が違うだけで処理は同一 ── 1 段で 3 形式片付く |
| ⑤ | **`folder-export` v1**(#7) | 段④ + 階層復元。`folders[]` → folder entry + `structural` relation。PKC3 は relation 表を直接持つので PKC2 の dispatch 経路 ▲ より素直に書ける |
| ⑥ | **`pkc2-entry-bundle`(#8)+ v2** | 最後。残るのは「`entry.json` を entries[] に足す」「assets を base64 として読む」の 2 点だけ。PKC2 に import 経路が無く(round-trip の参照実装なし)、格納規約が違い、実体を 1 件も見ていない ✖ |

⚠ P6 doc §1 は #8 を「読むのは最も簡単」と書いている ▲。**簡単さと土台性は別**。
#8 を先にやっても他形式は 1 ミリも進まない。

---

## 4. 危険な縁 ── 静かにデータを落としうる箇所

各行の扱いを **断る / warning / 仕様として受ける** のいずれかに必ず倒す。
**「黙って落とす」を 1 つも残さない。**

| # | 縁 | PKC2 | PKC3 |
|---|---|---|---|
| A | **asset key ⇄ ファイル名の突合失敗**。bundle は `assets/<key><ext>` で、読み側が `^([A-Za-z0-9_-]+)\.[A-Za-z0-9]{1,8}$` で拡張子を剥がす ▲。key に `.` や非 ASCII が入ると**マッチせず無言欠落** | 参照が壊れたまま残る ✔ | **突合方式を変える**: `manifest.assets` の各 key について「`assets/<key>` で始まる ZIP entry」を全部列挙。0 件 → warning、**2 件以上 → ambiguous として断る**、1 件のときだけ採用 |
| B | manifest にあって ZIP に無い asset | keyMap に入れず参照を温存(意図的 ✔) | **同じ挙動**(壊れシグナルの保存)+ **key と件数を warning** |
| C | ZIP にあって manifest に無い `assets/*` | 無言で無視 ▲ | **warning**(「入れたのに入らない」を検知できるように) |
| D | `manifest.json` / `container.json` の重複 | first-wins + warning ▲ | **断る**。どちらが正か決められない = 片方を静かに捨てる方が危険 |
| E | asset key の重複 | 常に「同一内容」扱いの first-wins。**バイト比較していない** ✔。型にある conflict コードは一度も emit されない | first-wins + warning(内容が違う可能性を文言に含める)。**PKC2 の spec 表を信じて conflict 検出を移植しない** |
| F | 不正 key(空 / `.` / `..` / `/` `\`) | package 経路だけ skip + warning ✔、**bundle 経路は通らない** ▲ | **全形式で共通に通す**。PKC3 は ZIP パスを FS に書かないので traversal 自体は無害だが、key として不正なものは断る |
| G | **文字コード**。flag bit 11 を書くが読まない ✔ | 第三者 ZIP が文字化け | **M2**: bit 11 なし かつ 非 ASCII → 断る |
| H | **CRC 未検証** ✔ | asset だけ壊れると**無言で欠けた添付** | **検証する。不一致は断る** |
| I | ZIP64 / 未知の圧縮 / 暗号化 | ZIP64 は処理コード自体が無い ▲ / method≠0 は throw または skip+warning ✔ | **すべて名指しで断る**。skip(黙って欠落)は選ばない |
| J | 圧縮 warning が別の code に詰め替えられている ✔ | 分類が嘘 | **移植しない**。warning は原因ごとに分ける |
| K | **階層復元の flat fallback**。判定が拒否すると**黙って平坦取込** ▲ | user は「フォルダが消えた」としか分からない | **必ず見せる**:「フォルダ構造を復元できませんでした(理由: …)。N 件を平坦に取り込みます」。判定は移植ではなく**再設計**(PKC2 の判定は仕様ではない) |
| L | manifest カウンタ未照合 ▲ | ズレていても成功 | **照合して不一致なら warning**(断らない ── 正当な差がありうる) |
| M | 空フォルダが落ちる(「選択 entry の祖先」しか作らない ▲) | 中身の無いフォルダが復元されない | `folders[]` を**全部**作る(PKC3 は取込対象を絞らないので祖先制限が不要) |
| N | 多重構造親(`parentOf` が Map 後勝ちで 1 entry = 1 親 ▲) | bundle 経由では 2 親目が消える | **仕様として書く**(bundle 経由は 1 親 / package 経由なら relations がそのまま来る)。warning にはしない ── 形式の限界であって取込の失敗ではない |
| O | `app_icon_asset_key` の閉包漏れ ✔(asset-scan は attachment の `asset_key` しか見ない) | bundle にアイコンが入らない | keyMap に無いのに body が参照している → **warning**(「アイコン画像が見つかりません」) |
| P | #8 の base64-as-text ✔ | 読む実装が無い | **推測分岐を作らない**。常に base64 とみなし、decode 失敗は断る |
| Q | `.text.zip` の frontmatter thumbnail 欠落 ▲ | thumbnail だけで参照される asset が bundle に入らず、`missing_asset_keys` にも載らない | **取込側では検出できない**(manifest に載っていない)。doc に「bundle 経由では thumbnail が落ちる」と書き、**package 経由を推奨する導線にする** |
| R | revisions を捨てたことの不可視化 | ── | P6 §4 (b) を踏襲しつつ**捨てた件数を warning に出す**。⚠ 帰結として **PKC2 の trash(entries に居ない lid)は取り込まれない** |
| T | failure 粒度 | batch は failure-atomic ▲ | §5-③ の裁定事項(**推奨は atomic**) |

---

## 5. 未確定事項

### ✅ 決着済み(2026-08-01)

当初 4 件を「裁定待ち」として挙げたが、**実質的な裁定事項は 1 件だけだった**。
残り 3 件は私が決めるか、前提が崩れて質問ごと消えた。

**① deflate(method 8)を受理する** ── 私の判断。`DecompressionStream('deflate-raw')`
の 1 行・追加依存ゼロで、user が ZIP ツールで再梱包したファイルが読めるようになる。
「機能を足す」ではなく同じ入口の頑健性。

**② PKC2 revisions を持ち込む(鎖へ符号化する)** ── ✅ user 裁定 2026-08-01。
詳細は `p6-import-export-design-2026-08.md` §4。ZIP 経路(`container.json` の
`revisions`)も HTML 経路と**同じ `importRevisionChains` に合流させる**
── 経路ごとに履歴の入り方が違う状態を作らない。

**③ ZIP-in-ZIP の失敗粒度** ── **質問ごと消えた**。atomic を推した理由は
「部分取込 → 再実行で重複が増える」だったが、asset を content addressing に
した(user 指示 2026-08-01「ZFS と同じ発想」)ので、再実行は同じ key に書くだけの
no-op になる。粒度はデータの正しさの問題ではなく「途中まで入ったものが見えた方が
便利か」だけの話 ── **partial + 可視の進捗**で進める。

**④ #8 / #7-v2 を受理するか** ── 私の判断。**段⑥に置き、実体が手に入らなければ
着地させない**(round-trip の参照実装も実体も無いものを、検証の当てなく出荷しない)。

### 🔬 追加調査(コードから読めない)

⑤ 🔴 **実体 fixture を 1 個ずつもらう(最優先)**。推定を一気に事実に変える最短路。
とくに次の 3 つは**コードからは存在の有無すら判定できない**:
  (a) 2026-04-12 以前の writer が書いた mtime 0/0 の古い `.pkc2.zip` ▲
  (b) `folders[]` を持たない旧 `.folder-export.zip`(コードは常に出力・doc は optional ▲)
  (c) legacy inline `data` 入り attachment を含む container

⑥ `DecompressionStream('deflate-raw')` の**対応下限の版**。
   同梱 Chromium 141 での往復は実測済み(2026-08-01)だが、下限は未確認。

⑦ `classifyFolderRestore` / `buildBatchImportPlan` ── どんなときに階層復元が
拒否されるか。**再設計する前提なら読まなくてよい**が、「PKC2 で復元できたものが
PKC3 で復元できない」退化を避けたいなら読む。

### 🔧 実装判断(裁定不要だが明記が要る)

⑧ ✅ `ConvertedAsset` の `oldKey` は**着地済み**(content addressing の実装で
前倒しになった)。ZIP 経路は `assets/<oldKey>.bin` をこの値で突合する
⑨ `ConvertOptions.mimeHint`(bundle 系の mime は manifest 由来)
⑩ bundle 由来 attachment の `size` は展開後バイト長(PKC2 と同じ ✔)
⑪ title fallback の文言(PKC2 は `'Imported text'` ✔ → PKC3 は `(無題)`)
⑫ `detectPkc2Format` をネストの各段で呼ぶ前提を doc / コメントに追記

---

## 6. 参照(`file:line`)

- `PKC2/src/adapter/platform/entry-bundle.ts:72` ── `data: textToBytes(bytes)`。
  `bytes` は base64 文字列。**base64-as-text 格納は実在する** ✔
- `PKC2/src/adapter/ui/spreadsheet-presenter.ts:45, :1762` ── `.xlsx` が
  `createZipBlob` を使う。**manifest.json を持たない** ✔
- `PKC2/src/adapter/platform/zip-package.ts:515-524` ── CD の general purpose flag を
  読んでいない ✔ / `:239-240` ── `assets/` 配下で `.bin` 以外を無警告で無視 ✔ /
  `:265` ── 読みは streaming なのに**出口で全量 base64 常駐** ✔ /
  `:273-283` ── 圧縮方式の warning を別 code に詰め替え ✔
- `PKC2/src/features/asset/asset-scan.ts:96-105` ── attachment は `asset_key` のみ。
  **`app_icon_asset_key` は参照として数えない** ✔
- `PKC2/src/adapter/platform/text-bundle.ts:119-160` ── `missing_asset_keys` は原文基準、
  `body_length` は compact 後(非対称は意図的)✔ / `:453-472` ── 実体が無い key は
  keyMap に入れず参照温存、`size` は展開後バイト長 ✔
- `PKC3/src/features/import/pkc2-convert.ts` ── `ConvertedAsset` に `oldKey` が無い(§2-4)
- `PKC3/src/` に **ZIP reader は存在しない**
