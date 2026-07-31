# P3 app 層設計 ── リーン集約接続と総合的見直し(2026-07)

> **Status**: 設計メモ。正本 doc(`pkc3-major-upgrade-design-2026-07.md`)§3 / §5 / §11-P3 の
> 実行詳細。スコープ自体は P0 裁定済み(全面委任)── 本メモは「どうやるか」の正本。
> 根拠: PKC2 実地調査(2026-07-30、renderer 12,523 行 / action-binder 11,939 行 /
> markdown-render 4,191 行の 3 層パイプライン / 4 surface / 表示・AST 二重実装)と
> P2 の実測群(p2 log)。

## 0. 原則(変えないもの / 変えるもの)

- **変えない(発想維持)**: pure reducer + Dispatcher / Renderer・ActionBinder・Presenter の
  三権分立 / `data-pkc-*` セレクタ規約(test 資産の書式互換)/ 5-layer 構造
- **変える(user 指示 4「古い設計や積み上げで遅くなる実装はダメ」)**: メモリ像
  (container 丸ごと → リーン集約)/ 描画モデル(毎回全構築 → region 差分)/
  file 構成(万行 file → view・機能単位の module)

## 1. リーン集約 ── AppState の形と body の同期境界

**AppState が持つもの**(15,000 entries でも数 MB):

| field | 中身 | 出所 |
|---|---|---|
| `entryMetas: Map<lid, EntryMeta>` + `order: lid[]` | title / archetype / dates / entry_order / **抽出列(status・date・archived)** | `listEntryMetas`(body 非読込) |
| `relations` | 関係の全量(数百 KB 級 → 常駐可。肥大したら SQL 化 ── §6) | store |
| `openBody: { lid, body, baseline } \| null` | **選択中 entry の body だけ**(editor / presenter の作業域) | `getBody`(選択時) |
| UI state | selectedLid / viewMode / phase / 各 view の表示状態 | runtime-only(PKC2 と同じ) |

**持たないもの**: 全 body / revisions / asset bytes / 「Container」という丸ごと集約そのもの。
revision 件数や asset 一覧はビューが表示時に query する(P2 実測: COUNT 252ms / meta 6ms)。

**同期境界(PKC2 lazy 失敗との決定的な違い)**:

- PKC2 の `lazy_entry_bodies` は `Container.entries[].body: string` という**同期型を保ったまま**
  裏で中身を抜いた。「hydrate 済みか」という中間状態が全経路に漏れ、未読 body を空として
  保存しうる穴(S3)になり退役した
- PKC3 は**型で分離する**: `EntryMeta` に body フィールドが**存在しない**。body に触れるのは
  `openBody` 経路だけで、保存は `openBody` からのみ。**「未読の body を書く」経路が
  型レベルで構成できない**
- reducer は純粋のまま: 非同期(store query)は dispatcher の外の **effect 層**が行い、
  `BODY_LOADED` 等の SystemCommand で reducer に還流する(PKC2 の Dispatchable 流儀を維持)。
  SELECT_ENTRY → (effect: getBody) → BODY_LOADED → editing 可、の一方向

## 2. renderer / action-binder の解体と差分描画

PKC2 の実態: 単一 renderer.ts 12,523 行、編集の開始・確定のたびサイドバー全行を再構築
(#1030 系 ──「体感の主因は描画」の実測)。これを持ち込まない。

- **module 境界**: `src/adapter/ui/render/` に shell(枠、初回のみ)/ sidebar / detail /
  calendar / kanban / filer / launcher。`src/adapter/ui/actions/` に機能別 action module
  (event delegation + `data-pkc-action` テーブルは登録制で維持)
- **差分描画の方式**: region 購読 + 断面指紋。「region ごとに (state 断面) → DOM」の純関数は
  維持しつつ、**断面が前回と同一なら DOM に触れない**(指紋 = region が依存する field の
  浅い比較。PKC2 #1031 の「派生値の指紋」の教訓を最初から設計に入れる)。全再構築は
  view 切替時のみ
- **仮想化はしない**: PKC2 実測で確定側の内訳は Layout/Style 支配ではなかった(= 仮想化の
  領域ではない)。必要が数字で出たら計測してから(「効果が小さいからやらない」ではなく
  「測ってから積む」)
- DoD 計器: 編集開始・確定時に**サイドバー DOM ノードが再生成されない**こと
  (PKC2 `sidebar-reuse-dom-check` の型を移植)

## 3. フレーバー presenter(全 body = PKC-Markdown)

```ts
interface FlavorSpec {
  archetype: string;
  /** frontmatter → 抽出列。唯一の抽出関数(worker には抽出済み値だけ渡る) */
  extract(body: string): { status: string | null; date: string | null; archived: boolean };
  /** PKC2 形式の body から PKC-Markdown への変換(P6 import が使う) */
  fromPkc2(body: string): string;
  renderBody(...): void;
  renderEditorBody(...): void;
  collectBody(...): string;
}
```

- **抽出の一元化(storage review #2 の解消点)**: 保存経路は必ず
  `collectBody → extract → upsertEntry`。抽出列と frontmatter の一致は
  **roundtrip pin test**(body を書いて読み戻し、extract 再適用で列と一致)で守る。
  変換(fromPkc2)と抽出(extract)を同じ FlavorSpec に同居させ、二重表現の乖離
  (PKC2 #1022 型)を構造的に防ぐ
- 具体形:

| flavor | PKC-Markdown 表現 | 編集 UI |
|---|---|---|
| todo | frontmatter(status / date / archived)+ 本文 | kanban トグル = frontmatter 書換の構造化操作 |
| textlog | 日時見出し節(`## YYYY-MM-DD HH:mm:ss` 規約 ── 秒まで。高頻度ログの弁別、PKC2 textlog-readability-hardening の教訓。P3-4 で確定) | 追記 = 末尾節 append |
| spreadsheet | csv fence(render 指定)+ frontmatter(数式・グラフ定義) | grid editor が fence 内容を編集 |
| form | frontmatter フィールド群 + 本文(機械可読 ── 将来のダッシュボード / 帳票の読み口) | フィールド UI |
| attachment | frontmatter(asset_key / mime)+ 説明 markdown | 表示は `lendObjectUrl`(dispose 規律) |
| text / folder / generic / opaque | ほぼそのまま | text fallback |

- P3-4 review で確定した残課題(P3-5 / P6 で拾う):
  - **P3-5**: `parseFrontmatter` は fence 直後の空行 1 個を swallow する ── 本文先頭が
    空行の body を `setFrontmatter` 系で書き換えると先頭空行が確定的に落ちる。
    frontmatter 書換 UI(editor / kanban トグル)を実装するときに parse view ではなく
    原文 splice で書くこと
  - **P6**: textlog の PKC2 ログ id は fromPkc2 で復元不能になる ── ログ単位 permalink の
    リンク書換は import パイプライン内で **fromPkc2 より前段**に置く(ordering 制約)
  - **P6**: attachment の未知 field は `attachment.extra`(JSON scalar)に保全される ──
    importer はこれを落とさず新スキーマへ運ぶ

## 4. PKC-Markdown パイプラインの移植単位

- **移植単位 = `renderMarkdown()` パイプライン丸ごと**(行単位 preprocessor(PUA sentinel
  U+E110〜 + lineMap)→ markdown-it → postprocessor)。パーサだけの差し替えは
  sentinel / lineMap / source-line anchor 契約が壊れるため禁止(調査で確定した罠)
- 依存: markdown-it v14 + markdown-it-footnote を P3 で追加(受容モードの範囲)
- **表示経路を先に移植**。AST export(docx / pptx)は後段(P3 後半〜P6)、IR 統一
  (`markdown.use_ir` scaffolding)は凍結継続 ── 統一は工数対効果を測ってから
- surface は **center pane 先行**。Viewer popup / Split View / entry-window は §5 の後半単位
- 移植 DoD に調査の罠リストを組み込む: `hasMarkdownSyntax` の方言判定更新 /
  `collectSourceLineAttrs` を outermost 要素へ / `asset:` は resolver 前提 /
  寛容 parse(PKC2005〜2011)の挙動互換

## 5. 実装順(小さく積む ── 各単位が単独着地・単独計測)

| 単位 | 内容 | DoD |
|---|---|---|
| P3-1 | リーン集約 AppState + reducer + effect 層(body load) | 「未読 body を書く経路が型で不在」を test で pin。同期 invariant(storage review #5)の直列化もここで |
| P3-2 | shell + sidebar render(meta のみ・差分描画) | 15,000 件で編集開始/確定時のサイドバー再構築 0(DOM 同一性計器) |
| P3-3 | PKC-Markdown パイプライン移植 + text presenter | PKC2 方言リファレンスの render fixture 一致 |
| P3-4 | FlavorSpec 5 種(todo / textlog / form / attachment / spreadsheet) | 抽出 roundtrip pin test |
| P3-5 | detail view + editor(openBody 経路) | 編集セッション計器で p50 維持(±向きのみ) |
| P3-6 | calendar / kanban(抽出列 SQL query 駆動) | 15,000 件で描画 O(表示分) |
| P3-7 | filer / launcher / 残 UI | ── |
| P3-8 | Viewer popup / Split View / entry-window + 視覚 smoke 導入(shinsatsu 改修版、PR gate 外) | 視覚 parity 最小 1 件 |

各単位: 全 gate + 必要な実ブラウザ probe + 計器再実行。実装 PR は着地前に code review
エージェント(storage core と同じ運用)。

## 6. 未確定(実装しながら計測で決める)

- relations の常駐 vs SQL query 化(まず常駐 ── 肥大が数字で出たら移す)
- `listEntryMetas` 15,000 行 573ms の postMessage 直列化(必要なら chunk / 列転送)
- リース待ちタブの読取追従(BroadcastChannel)の UX
