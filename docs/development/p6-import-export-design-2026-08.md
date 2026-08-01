# P6: import / export ── 設計(2026-08)

正本 doc §11 の P6。PKC2 実地調査(2026-08-01、pkc2-surveyor ── export 全 9 形式の
生成コードと importer 受理器を file:line で確認)に基づく。
方針の前提: **import は PKC2 全形式を受理して新スキーマへ変換、export は一方通行
(PKC3 export を PKC2 に読ませない)**(user 裁定 2026-07-30)。

## 1. 受理する形式(最小完全集合)

PKC2 の version 判定は `#pkc-meta` の `schema`(数値)で、**全歴史を通じて 1 のまま**
── schema=1 だけ受理すれば PKC2 の全 export をカバーする。

| # | 形式 | 中身 | 規模 |
|---|---|---|---|
| 1 | 単一 HTML | `<script id="pkc-data" type="application/json">` に `{ container, export_meta }` 素 JSON(`<\/script` エスケープのみ)。asset は per-asset gzip+base64 / 無圧縮 base64 の 2 態(8MB 超添付が 1 つでもあると全体無圧縮)。light mode は assets 空 | M |
| 2 | pkc2-package ZIP v1 | manifest.json + container.json(assets 空化)+ assets/&lt;key&gt;.bin(生バイナリ)。**stored mode のみ(deflate 不要)**。pre-migration backup / folder-sink autosave も同形式 = 救出経路の正本 | M |
| 3 | .text.zip / .textlog.zip | manifest + body.md verbatim / textlog.csv(固定 header、flags 列優先・important fallback)+ assets | S〜M |
| 4 | batch 4 形式(texts / textlogs / mixed / folder-export v1・v2) | 外側 manifest.format 判別 + #3 へ委譲。folder-export は folders[] 階層復元 | S |
| 5 | .entry.zip(pkc2-entry-bundle) | entry.json = Entry verbatim。⚠ assets/&lt;key&gt; は**拡張子なし・base64 テキスト格納**(他形式と違う)。PKC2 自身は import 不可の形式だが、読むのは最も簡単 ── 受理して差別化 | S |

**捨てる形式(根拠)**: FSA local-folder 直読(folder-sink が常時完全 ZIP を同フォルダに
置く設計で ZIP 受理が完全代替)/ IDB 内部形式(export に現れない + 別 origin で原理的に
読めない)/ 素の textlog.csv・body.md 単体(PKC2 にも単体 import 経路が無い。生 md は
P7 の md ハンドラ)/ docx 等 one-way 出力 / capture JSON(transport 再建の段まで保留)。

## 2. 判別(PKC2 より 1 段頑健に)

拡張子 → **magic**(`PK\x03\x04` = ZIP / `<` = HTML / `{` = JSON)→ ZIP は
manifest.json の `format` 文字列(全形式が自己記述的)。HTML は DOMParser +
slot id(`#pkc-meta` で app='pkc2' & schema=1 を厳格検証 → `#pkc-data` textContent →
`<\/script>` 復元 → JSON.parse → 最小 shape 検証)── **regex 抜出はしない・script は
一切実行しない**(PKC2 importer と同じ contract。ビルド産物 / runtime export の
2 shell 変種で `#pkc-data` contract は同一)。

## 3. 変換パイプライン(順序が本体)

```
受理(#2 判別)
→ ① textlog permalink 対応表の構築(fromPkc2 より前段 ── 変換で log id が
   body から消えるため、id → 節見出しの対応は id が残っているうちにしか作れない。
   entry:X#log/<id> / #log/<a>..<b> / #day/<date> / #log/<id>/<slug> /
   legacy 裸 fragment / fragment-only の全変種。id は [A-Za-z0-9_-]+ の
   opaque token 前提 ── ULID 形で gate しない(PKC2 自身が legacy id の
   全形式を「未解明の曖昧点」と明記している))
→ ② fromPkc2(flavor 変換 ── 既存 FlavorSpec.fromPkc2。JSON body 5 種:
   todo / textlog / form / attachment / spreadsheet。text 系は verbatim。
   legacy 素通し規約も flavor 側に既実装: 非 JSON todo → open、等)
→ ③ attachment legacy data(body 内 base64)の externalize ── bytes を
   AssetBlobStore へ移してから fromPkc2 に渡す(fromPkc2 は data 入りを
   throw する契約 ── S3 型の bytes 黙殺を構造的に拒否済み)
→ ④ asset key の全再採番 + body 参照書換(keyMap 方式 ── PKC2 の bundle
   import と同じ。missing key は書き換えず broken のまま保持 = 壊れシグナルの
   保存)。旧 key 3 系統(ast- / att-* / thumb- + 派生)は入力として受理する
   だけで、出力は PKC3 の 1 規則(ast-<ts36>-<rand>)
→ ⑤ system entries の除外: __about__ は再生成対象 / __flags__ は破棄
   (PKC2 固有 flag の値袋 ── PKC3 は 15 個制限の別体系)/ __settings__ は
   theme・locale の写像を後続判断(P6 では破棄し、settings 表が立つ段で再訪)
→ ⑥ bulk 書込(bulkUpsertEntries / bulkUpsertRelations / putBlob+putAssetMeta)
   ── 1 行ずつ書かない(journal 増幅の教訓)
```

- relations は kind をそのまま写す(structural / categorical / semantic /
  temporal / provenance)。entry_order は meta.entry_order があれば採用、
  無ければ配列順
- merge import(既存 container への overlay)は P6 の scope 外(PKC2 の
  merge は import 後の container 操作。必要になったら PKC2 merge-planner の
  意味論 ── lid remap / asset dedupe / revisions drop ── を参考に別途)

## 4. PKC2 revisions の扱い ── ✅ 裁定済(user 2026-08-01)

> **「revisions の考え方は持ち込む、ただし前に言ったように jujutsu 的に
> 遡及パッチを持つ結論ではなかったか?」**(user 2026-08-01)

**持ち込む。ただし P5c の鎖へ符号化する**(全文では積まない)。

当初この節は「捨てる / 持ち込む」の二択で書かれていたが、**天秤が嘘だった**。
「持ち込むと保存量が増える」という側の重さは、取込経路だけが全文
(`kind='full'`)で積む設計だったことに由来しており、P5c で決めた
「tip = `entries.body` / 履歴 = 逆向きパッチ」に合流させれば消える。
全文で積む経路(旧 `bulkAddRevisions`)は**削除した** ── 残すと取込だけが
設計から外れ、PKC2 と同じ「履歴が本文の N 倍」に戻る。

実装(`importRevisionChains`):

- 変換は**本文と同じ経路**を通す(`convertBody`)── 通さないと履歴だけ
  JSON 文字列が残り、古い版の `asset:` 参照が書き換わらず GC に消される
- 並びは `created_at` 昇順(同時刻は元の並び)。**時刻は捏造しない** ──
  PKC2 の `created_at` をそのまま持ち込む
- 無変更の版は畳む(PKC2 は本文が変わらなくても snapshot を作りうる)。
  最新版が tip と同じなら、その版は履歴として持つ意味がないので落とす
- **既に履歴を持つ entry には積まない** ── 既存の鎖に割り込むと符号化の前提
  (隣接する版の差分)が崩れる
- 保持上限を超えた古い版は捨て、**件数を可視化する**(黙って落とさない)
- PKC2 の `Revision` は title / archetype を持たないので、履歴行には entry の
  値を入れる(「その時の題名」は PKC2 側に情報が無い ── 復元できない事実)

取り込んだ鎖は既存の checkpoint 経路と自然に合流する(取込後の編集で頭が伸びる)。

⚠ 帰結: **PKC2 の trash(entries に居ない lid の revisions)は取り込まれない**。
PKC2 の container に居ない entry の履歴は、鎖の基準となる tip が無いため。

## 5. PKC3 export(P6c で実装)

1. **可搬 HTML**: PKC3 スキーマの `{ container, export_meta }` を同じ
   `#pkc-data` 方式で埋め込む(PKC2 に読ませない前提なので schema は
   `pkc3`/`3` を刻む ── PKC2 importer は app='pkc2' 厳格一致で自然に拒否する)
2. **アーカイブ ZIP**(バックアップ正本): manifest + container.json +
   assets/(生バイナリ)。stored mode
3. **md ZIP**: 全 body = markdown なので「1 entry = 1 .md + frontmatter」が
   自然形。PKC2 の bundle 群のような per-archetype CSV は作らない

## 6. 着地計画

- ✅ **P6a**(着地 #33): 変換 core(①〜⑥)+ textlog anchor 対応表 + fixture pin。
  I/O を持たない純関数なので単独で pin できる
- ✅ **P6b**(本段): 判別器(magic → manifest.format、拡張子を信じない)+
  HTML 受理器(DOMParser・厳格検証)+ **取込の実行部と UI 配線**
  (asset 1 件ずつ復号 → Blob → bulk 書込 → 再読込)。単独で
  「PKC2 の単一 HTML を取り込んで使える」まで到達する。
  ⚠ 当初計画では P6b = bundle 系だったが、**実行部と UI 配線を先に閉じた** ──
  受理器だけ増やしても user は 1 件も取り込めず、「読めたつもり」の検証もできない
- **P6c**: ZIP 系(pkc2-package + bundle 系 #3〜#5)+ folder 階層復元。
  現状は ZIP magic を検出した時点で**可視で断る**(黙って落とさない)。
  設計は `p6c-zip-import-design-2026-08.md`(**裁定待ち 4 件**)。
  ⚠ **8 形式すべて実体未確認** ── コードから読んだ事実であって実測ではない
- **P6d**: PKC3 export 3 形式
- fixture の variant(ゼロ件次元を作らない): light / readonly / gzip+base64 /
  無圧縮(8MB 超)/ revisions 入り / legacy data 直埋め attachment /
  legacy log-<ts>-<n> id 混在 textlog / 旧 tag_filter の saved_searches。
  実物 fixture は PKC2 の dist 産物 + 合成で賄い、実運用 export の検品は
  user の手元データで行う(裁定時に依頼)

## 7. 残課題・記録

- ✅ P5a review F4(rev_order 一意性): `importRevisionChains` は「既に履歴を
  持つ entry には積まない」ので、採番は常に 1..m の新規で衝突しない
- spreadsheet の数式セル格納表現は fixture で確認(PKC2 spreadsheet-body.ts の
  「rows のセル文字列に生で入る」前提の検証)
- subset export の app_icon_asset_key 閉包漏れ(PKC2 側の既知の縁)──
  PKC3 は missing asset を broken-ref として可視受理するので実害は限定的
- P6b の実行部で確定した規約(P6c もこれに従う):
  - **bytes を先に、参照を後に書く**。逆順にすると「参照はあるが bytes が無い」
    entry が残る ── 逆向き(参照なし bytes)は明示 purge で回収できる
  - **取込は asset gate の内側**(attach / purge と排他)。取込は
    putBlob → entry 書込の間に「bytes はあるが参照が無い」窓を持つので、
    その窓で整理が走ると取込中の bytes を消す(P4b review F1 と同型)
  - **判別できない入力は書込前に可視で断る**。ZIP は「不明」に混ぜず ZIP として
    断る(user が原因を誤解しない文言にする)
  - 復号済み base64 を配列に溜めない(1 件ずつ Blob 化してその場で手放す)
