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
| M2 | general purpose flag(CD の `pos+8`)を**読まない**。名前は常に UTF-8 decode | 🔴 **当初の処方が誤りだった**(下記)── flag は見ず、**バイト列が妥当な UTF-8 か**だけで決める | ✔ :515-524 が pos+8 を読み飛ばしている |

> ⚠ **M2 の処方は実測で覆した**(2026-08-01、着地前レビュー)。
> 「bit 11 が立っていない かつ 名前が非 ASCII なら断る」は誤り ──
> **Info-ZIP(Linux / macOS の `zip`)は UTF-8 の名前を bit 11 を立てずに書く**ので、
> 正しい ZIP を丸ごと拒否する。しかも deflate 対応の動機だった「ZIP ツールで
> 再梱包したファイル」がまさにその形。逆に bit 11 さえ立っていれば壊れたバイトが
> U+FFFD で黙って通っていた ── **判定が両方向とも逆**だった。
> 正しい問いは「**バイト列が妥当な UTF-8 か**」で、`TextDecoder('utf-8', {fatal:true})`
> の 1 か所で両方向が直る(CP932 等は妥当な UTF-8 ではないので断れる)。
| M3 | **CRC-32 を検証しない**(writer は書く) | 検証する。不一致は断る | ✔ 照合コードが両経路に無い。破損検知が `JSON.parse` 失敗頼みだと、**asset だけ壊れた ZIP が無言で欠けた添付になる** |

**そのまま流用してよい部分**: CD の値を正とする(data descriptor で local header の
size が 0 になっても CD には入っている ✔)/ EOCD は末尾 65557 バイト以内を後方走査 ✔ /
進捗コールバックの粒度。

**断る条件**(すべて可視・黙って落とさない): ZIP64 / method が 0・8 以外 /
flag bit 0(暗号化)/ **分割書庫(マルチディスク)** / CD signature 不正 / EOCD なし /
CRC 不一致 / **サイズ不一致** / 名前が妥当な UTF-8 でない / **目次と件数の不整合**。

⚠ **EOCD は署名の一致だけで採らない** ── 署名と同じ 4 バイトは本体にもコメントにも
偶然現れる。**comment 長が残りバイトと一致する**候補だけを採る(これが無いと
ZIP ですらないバイナリが「空 ZIP」として通り、上の受理器で「manifest が無い」に
化けて user が原因を取り違える)。

⚠ **前置バイトのある ZIP**(自己解凍書庫)は EOCD の実位置から前置量を逆算して
読む ── 足さないと「壊れています」という**嘘の診断**になる。

⚠ **検証を外す逃げ道は持たない**。`verifyCrc: false` の類はサイズ照合まで一緒に
落として「他人の entry の中身が返る」経路を開ける。CRC は stream で舐めて確かめる
ので、**全量を heap に載せずに検証できる**(下記)。

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

⚠ **素朴に書くとこの主張は成り立たない**(2026-08-01 レビューで計測):
`new Blob([bytes])` は**コピー**なので、store で 2 部・deflate で 3 部になる。
- **store**: slice を stream で舐めて検証し、**slice(view)をそのまま返す** → 0 部
- **deflate**: 展開しながら CRC を計算する(全量を `Uint8Array` に起こしてから
  測らない)→ 返す 1 部のみ

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
| ✅ ③-前半 | **`.text.zip`(#2)**(`src/features/import/pkc2-bundle.ts`)| §2-5 の合成 container 規約を確立。🔑 **`manifest.assets` が key → {name, mime} の正本**と実地確認できたので、§4-A の「拡張子を剥がす突合」問題は**そもそも発生しない**(manifest の key を正として ZIP entry を引く)|
| ✅ ③-後半 | **`.textlog.zip`(#3)**(`textlog-csv.ts` + `readTextlogBundle`)| CSV → PKC2 の TextlogBody JSON へ**逆写像**して合成 container に載せる ── `fromPkc2` がその JSON を取るので textlog 専用の変換を二重に持たない。⚠ 実地確認で判明: **列は固定位置ではなく header 名で引く**(PKC2 の parser も indexOf)。並び替え・追加列に強い。`flags` 列があればそれが正で、**空は「flags 無し」**(`important` に戻らない)|
| ✅ ④ | **batch 3 形式**(#4 / #5 / #6)(`src/features/import/pkc2-container-bundle.ts`)| 段③の再帰適用 + 内側 ZIP の Blob 再入。⚠ **実地で 3 点覆った**(下記)|
| ✅ ⑤ | **`folder-export`**(#7、v1 **と v2**)(`pkc2-folder-export.ts` + `folder-graph.ts`)| 段④ + 階層復元。⚠ **実地で 4 点覆った**(下記)|
| ⑥ | **`pkc2-entry-bundle`(#8)+ v2** | 最後。残るのは「`entry.json` を entries[] に足す」「assets を base64 として読む」の 2 点だけ。PKC2 に import 経路が無く(round-trip の参照実装なし)、格納規約が違い、実体を 1 件も見ていない ✖ |

⚠ P6 doc §1 は #8 を「読むのは最も簡単」と書いている ▲。**簡単さと土台性は別**。
#8 を先にやっても他形式は 1 ミリも進まない。

### 段④ で覆った前提(2026-08-01、PKC2 writer の read-only 実地調査)

**(1) batch 形式は 3 つではなく 4 つ**。`pkc2-folder-export-bundle` も batch である
(`folder-export.ts:55`)。段④ は 3 形式のみ受け、folder-export は**名指しで断る**(段⑤)。

**(2)「3 形式は外側 manifest の形が違うだけ」は誤り** ── field 集合が実際に違う:

| format | 件数の field | `archetype` |
|---|---|---|
| `pkc2-texts-container-bundle` | `entry_count` | **無い**(format から決まる) |
| `pkc2-textlogs-container-bundle` | `entry_count` | **無い** |
| `pkc2-mixed-container-bundle` | `text_count` + `textlog_count`(`entry_count` は**無い**)| **ある** |

さらに **`compact`(外側 top-level)と `compacted`(内側 top-level)は別綴りの別 field**。
`body_length` / `log_entry_count` は**どちらか一方だけ書かれ、他方は key ごと不在**。

**(3) 🔑 asset は内側 ZIP に完全複製される**。1 個の画像を 2 ノートが参照していると、
同じバイナリが 2 つの `.text.zip` に丸ごと入る。PKC2 は取込時にこれを統合せず
**attachment entry 2 個・asset 2 本**を作っていた(共有関係が失われる)。
PKC3 は content addressing で bytes を 1 本に畳み、attachment entry も asset key で
1 件に畳む ── user 指示「ZFS と同じ発想」がそのまま効く箇所。

⚠ その帰結として **同じ key が複数の内側 bundle に出る**。中身が食い違っていたら
片方が黙って消える(= あるノートが別ノートの画像を表示する。見て気づけない破損)。
ZIP の中央ディレクトリは **CRC-32 とサイズを読まずに持っている**ので、そこで照合し、
**食い違ったら断る**。これは §4 行 E(first-wins + warning)の**強化**である ──
E は「PKC2 はバイト比較していない」を前提に書いたが、PKC3 は**読まずに比較できる**。

**(4) ゼロコピーは store に限る**。PKC2 の writer は外側も内側も method 0 固定なので、
内側 ZIP は外側の view・内側の asset はさらにその view で**どの段でもコピーしない**。
⚠ ただし **deflate の内側 ZIP は実体化される**(`DecompressionStream` の出力を Blob に
起こすため)── その経路の常駐量は**測っていない**ので、ゼロコピーを主張しない。

⚠ **メモリは増えないが CPU は倍**(2026-08-01 のレビューで判明)。内側 ZIP を entry と
して読む時に**内側 ZIP 全体**を crc32 で舐め、そのあと個々の asset を読む時に**もう一度**
舐める。段②(単段 `.pkc2.zip`)は 1 回。同環境の実測 **329 MB/s**(64MB を 3 回、
best 194.7ms)なので、1 GB の batch なら **CRC ループぶんだけで +約 3 秒**の追加仕事。
⚠ end-to-end は測っていないので「取込が +3 秒になる」とは言えない ── 言えるのは
「CRC の追加仕事がその量ある」まで。**verify を外す抜け道は作らない**(段①の
review で一度潰した設計判断を、性能を理由に戻さない)。

### 段④ で確定した扱い(2026-08-01)

- **失敗粒度は partial**(§5-③ の裁定どおり)。内側 1 件が未対応形式・破損でも
  **残りは取り込む**。「読めるところだけ読む」が悪いのは*黙って*やるからで、
  どのファイルを何の理由で落としたかを言うなら静かではない。
  ⚠ ただし **全部落ちたら断る** ── 「取込完了 0 件」で成功に見せるのは最悪の結果
- **畳み込みは冗長性を捨てない**。同一判定は中央ディレクトリの crc/size だけで
  bytes を読まないので、**データ部だけが腐って CD が無傷**なら「同一」と判定して
  畳んでしまう。PKC2 は畳まなかったので健全な複製が生き残っていた ── 畳んだうえで
  **複製を控えに持ち**、先頭が読めなければ控えから復元する(PKC2 より弱くしない)
- **ファイル名の正規化ゆれ(NFC / NFD)を吸収する**。macOS の FS / Finder 経由で
  再梱包すると NFD になる。PKC2 の batch filename はノート題名由来なので**日本語
  題名で現実的に踏む** ── 完全一致で断ると「在るファイルを無いと言われる」。
  NFC 副索引で引き直し、当たったら言う。⚠ 畳んでぶつかる 2 件は**曖昧なので拾わない**

### 段⑤ で覆った前提(2026-08-01、PKC2 writer / reader の read-only 実地調査)

**(1) 🔴 writer は循環・自己親・重複 lid・dangling parent を一切防いでいない**
(`folder-export.ts:114-137` に検査が無い)。PKC2 自身が循環の実在を認めている ──
`tree.ts` の "F-cycle hotfix" コメント(循環すると sidebar から component ごと消えた)。
`BULK_MOVE_TO_FOLDER` に自己・循環チェックが無く、folder を自分の子孫へ移せば作れる。

🔴 **PKC3 で循環を作ると filer からフォルダごと消える**。`resolveCanonicalParents` は
「正準親を持たない entry」を root 直下として出すので、循環上の folder は 1 つも root に
出ず、配下ごと不可視になる。`tree.ts` 自身が「木の不変量は relation を**書く側**で
守る ── 読み手は防御のみ」と宣言しているので、**その責務は取込側にある**。
→ `folder-graph.ts` が正規化する。不変条件は「**循環があっても root が必ず 1 つ以上残る**」。

**(2) `folders[]` に親が先に来る保証は無い**(トポロジカルソートしていない。
PKC2 のテストが親→子順に見えるのは fixture の並びのせい)── 順序に依存しない。

**(3) `entries[].parent_folder_lid` は `folders[]` に無い lid を指しうる** ── 2 経路:
親が folder でない(structural は UI から任意の entry 間に張れる)/ 多重親の
last-write-wins が部分木の外を指す。

**(4) v1 の archetype は `'text'` / `'textlog'` の 2 値だけ** ── manifest に書かれるのは
実 archetype ではなく**リテラル**だから。3 つ目の分岐で `other_count++` して v2 になる。

### PKC2 から変えた点(段⑤)

| | PKC2 | PKC3 |
|---|---|---|
| 壊れた辺が 1 本 | **階層を丸ごと捨てて平坦取込**、warning は 1 件で打ち切り | 壊れた辺**だけ**直して木は保つ。直した箇所は全部見せる(§4-K) |
| 空フォルダ | 「選択 entry の祖先チェーン」しか作らず**無言で消える** | **全部作る**(§4-M) |
| `.entry.zip`(v2) | **無言 skip**。件数表示とチェックボックス数が食い違い、理由がどこにも出ない | 名指しで warning + 残りは取り込む(段⑥ で受理予定) |
| 添字 | preview は manifest 添字・取込は「飛ばして詰めた配列」で、planner が圧縮配列を選択添字で引く ── **選んだ entry が落ち、選ばなかった entry が入る**(v2 限定の実バグ) | `main` と manifest entry を**組で持つ**(`InnerBundle`)── 添字空間が存在しないので起こしようがない |

⚠ **`folders` が無い旧 bundle** は平坦取込に落とすが、**必ず言う**(§4-K)。

### 段⑤ で持ち越した損失(形式の限界。取込側では復元できない)

`folder-export` は「階層 + 本文 + 添付」だけの形式で、**container のスナップショットではない**。
export 時点で失われているもの: 非 structural relation(categorical / semantic / temporal)/
revisions / text・textlog の `tags` `color_tag` `display_profile` `created_at` `updated_at`。
⚠ 皮肉な非対称: **v2 の `.entry.zip` の方が text/textlog より情報量が多い**
(`entry.json` が Entry verbatim)── 段⑥ の価値はここにある。

### 🔴 出口の問題(段④ で顕在化、review H-2)

warning を丁寧に作っても、**出口が 1 行だと 1 件目しか user に届かない**。
`notify` は status footer(`textContent` 上書き)なので、`notes[0]` 以外は
console にも state にも残っていなかった。段②までは注意が 1〜2 件だったので
実害が出ていなかっただけで、**段④ で件数が内側 bundle 数に比例した瞬間に効く**。

→ `notices` region(全件を出し、user が閉じるまで残る)を追加した。
**「欠損は必ず warning で可視化」は、出口があって初めて成立する。**

---

## 4. 危険な縁 ── 静かにデータを落としうる箇所

各行の扱いを **断る / warning / 仕様として受ける** のいずれかに必ず倒す。
**「黙って落とす」を 1 つも残さない。**

| # | 縁 | PKC2 | PKC3 |
|---|---|---|---|
| A ✅ | **asset key ⇄ ファイル名の突合失敗**。bundle は `assets/<key><ext>` で、読み側が `^([A-Za-z0-9_-]+)\.[A-Za-z0-9]{1,8}$` で拡張子を剥がす ▲。key に `.` や非 ASCII が入ると**マッチせず無言欠落** | 参照が壊れたまま残る ✔ | **実装済み**。`manifest.assets` の key を**正**として引く(剥がさない)。照合は「`assets/<key>` 完全一致 or `assets/<key>.` 始まり」── 前方一致だけだと key `k1` が `assets/k1x.png` に当たる。0 件 → warning / **2 件以上 → 断る** / 1 件のときだけ採用 |
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

⑤ ✅ **解決(2026-08-02)。実体は自分で作れた** ── user 指摘
「テストデータが欲しいなら PKC2 を自分で動かしたらいいでしょう?」。
**PKC2 をビルドして writer を直接呼ぶ**だけで全 8 形式の実体が出る
(`tests/fixtures/pkc2/`、48KB)。⚠ PKC2 のソースは一切変更していない
(ビルド産物は `git checkout` で復元済み)。生成手順は
`tests/fixtures/pkc2/README.md`。

**結果: 合成 fixture で組んだ 7 形式が、本物の出力を一発で読めた**
(`tests/features/pkc2-real-fixtures.test.ts` 11 件)。ただし
**合成では出せなかった性質**が実物で初めて通った:
  - **ファイル名が日本語**(`議事録-20260731.text.zip`)── slugify が CJK を残す。
    合成 fixture は ASCII 名しか作っていなかった
  - 内側 ZIP が **store で外側に埋まる実バイト列**
  - manifest の field 集合が**実際に**形式ごとに違うことの確認

⚠ **まだ実体で確認できていないもの**(writer が現在の版しか作れないため):
  (a) 2026-04-12 以前の writer が書いた mtime 0/0 の古い `.pkc2.zip`
  (b) `folders[]` を持たない旧 `.folder-export.zip`(現行 writer は必ず出力する)
  (c) legacy inline `data` 入り attachment を含む container
  → いずれも**旧版の writer が要る**ので、合成 fixture で代替したままにする

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
