# PKC3 メジャーバージョンアップ設計 v2 ── 継承・刷新・是正(2026-07)

> **Status**: **P0 裁定済み(2026-07-30、§12 裁定記録)── 実装 go**。
> v2 = 2026-07-30 第 2 次 user 指示(全 PKC-Markdown 化 / 総合的見直し必須 /
> boot クローン / export 互換義務解除 / PWA / 将来領域)を反映した改訂。
> v2.1 = 同日の user 裁定(全面委任 + export 方向)を §12 に固定。
> **本 doc は PKC3 の founding doc**。PKC2 リポジトリは参照のみ(read-only)で、
> PKC3 の開発はすべて本リポジトリで行う。
> **調査根拠**: 2026-07-30 に PKC2 を 4 方面(storage / 交換形式 / PKC-Markdown・基本機能 /
> 依存・CI)から実地調査した結果に基づく。evidence の file:line は
> [`sm06224/PKC2`](https://github.com/sm06224/PKC2) の現 HEAD(2026-07-30 時点)を指す。

## 0. user 指示(与件・不可侵)

### 0.1 第 1 次(2026-07-30)

1. 「**PKC2からPKC3にメジャーバージョンアップします。パフォーマンス悪化したストレージ周りの
   設計を刷新します。PKC2の成果である可搬式埋め込み形式の発想とエクスポート形式、
   PKC-Markdownなどの基本機能はPKC3でも維持します。最も力を入れたいのはストレージ周りです。**
   **元のPKC2は依存の作り込みに消極的でしたが、PKC3は依存は性能のために致し方なし、
   SBOMとGitHubの依存prで定期的なアップデートを受け入れる方針です。
   GitHub pagesでdev版とプロダクト版をデプロイします**」(user 指示 2026-07-30)
2. 「**発想はそのままに、インポートエクスポートに互換性、悪い部分や作り込みすぎて
   かえって悪かった部分は直します**」(user 指示 2026-07-30)
3. 「**flagsは最大15個の予算設定とし、フューチャー機能を盛り込みすぎないようにする。
   flagsと正規の設定を分けることとする**」(user 指示 2026-07-30)

### 0.2 第 2 次(2026-07-30)

4. 「**コードを書き直さないというのはダメです。流用は良いが、リファクタリングや
   総合的見直しはしてください。古い設計や積み上げで遅くなる実装はダメです。
   PKC2はそれで失敗しました**」── v1 の「純リファクタはスコープ外(推奨)」は棄却された
5. 「**すべてのアーキタイプはインポート後に新たなスキーマにします。全てをPKC-Markdownで、
   アーキタイプ種別が見せ方や編集の仕方にフレーバーを与えるようにしましょう**」
6. 「**単一HTMLという仕様を最大限に活用するために、埋め込まれたスクリプトや
   埋め込み済みデータベースや基本構造はidbにクローニングし、DOM内に使わないものを
   置かないようにしてください。メモリの節約とクローニング時の安定性のためです**」
7. 「**エクスポート形式がPKC2と互換を持つ必要はありません**」── v1 §8.2 の
   「PKC2 互換 export(降格書き出し)」は不要になった
8. 「**上記は私の想いですが、ひとえに速く安く必要十分に利便性を最大にすればOKです**」
   ── 本 doc 全体の北極星
9. 「**mdファイルに対してサービスハンドラにしたいし、PWAインストールのメタも欲しい**」
10. 「**PKC1から持って来れなかった複合フォームとフォーム記入済みデータからダッシュボードや
    帳票を作成する機能もいつか追加したい。graphapiのアクセストークンを与えたら、
    onenoteとかと接続する機能も欲しいとは思ってる**」──「いつか」= v3.0 に入れない。
    §10 将来領域として拡張点のみ確保(指示 3「盛り込みすぎない」と整合)

### 0.3 継承する不可侵(2026-07-27、PKC2 CLAUDE.md 記載)

ゼロコピーと速やかな破棄 / 依存削減 ≠ 依存全廃(静的ビルドなら問題ない)/ 小さかろうが積む /
JSON をそのままコンテナにしない(内部表現の話)/ boot 窓だけで測らない。
※ ④ 付記の「JSON は交換形式として残る」は PKC2 文脈の裁定。PKC3 では指示 7 により
PKC2 互換義務が解除されたため、PKC3 の export 形式は §9 で新規に裁定する。

## 1. 北極星と戦略

> **速く、安く、必要十分、利便性最大**(user 指示 8)──
> 「**最強のノートアプリにするんだー**」(user 2026-07-30)

| 論点 | 判断 | 理由 |
|---|---|---|
| リポジトリ | 新規 `sm06224/PKC3`。PKC2 は現行のまま残す | in-place 移行を捨てる。旧ビルド互換(PKC2 Invariant 5「互換は双方向」)は「PKC2 が PKC2 のデータを読み続ける」ことで構造的に満たされ、移行事故クラス(S1〜S4 型)が発生しえない |
| データ移行経路 | **PKC3 の import のみ**(PKC2 export → PKC3 import で新スキーマへ変換) | 必然でもある: Pages 配信の PKC3 は origin が異なり、PKC2 の IndexedDB は原理的に直接読めない |
| コード戦略 | **流用 + 総合的見直し**(user 指示 4)。移植単位ごとに「流用 / 再設計 / 廃棄」を判定し、**見直しなしの丸写しを禁止**。「古い設計や積み上げで遅くなる実装」は移植対象から除外(§5 是正一覧 + P3 の見直し工程) | PKC2 の失敗 =「積み上げの温存」。ただし test 資産(10,973 件)と実測で正しさが確認済みの部品は流用してよい ── 速く安く、のため |
| v3.0.0 スコープ | **PKC2 機能の必要十分セット + storage/スキーマ刷新 + 是正 + PWA 化(§8)。それ以外の新機能ゼロ** | 「フューチャー機能を盛り込みすぎない」(指示 3)。将来領域(指示 10)は §10 で拡張点のみ確保 |

## 2. 継承するもの(発想はそのまま)

| 資産 | PKC2 実体 | PKC3 での扱い |
|---|---|---|
| **可搬式埋め込み形式の発想** | 単一 HTML にアプリ + データを埋め込み、file:// で自立動作。`<script id="pkc-data">` + SLOT 契約(`src/runtime/contract.ts:5-12`) | **発想ごと維持**しつつ実装刷新: 埋め込みペイロードは boot でストレージへクローンし DOM から除去(§4.6、user 指示 6)。export・clone は DB から生成(live DOM を読む PKC2 方式は廃止) |
| **PKC-Markdown** | markdown-it v14 + 独自 inline/block 方言 + fence 規約 + リンク scheme(entry:/pkc://asset:)。preprocessor(PUA sentinel + lineMap)→ markdown-it → postprocessor のパイプライン(`markdown-render.ts` 4,191 行) | **方言仕様ごと維持**し、地位はむしろ昇格 ── 全 body の唯一の形式になる(§3)。実装は移植時に見直し(表示 / AST export の二重実装の統一を再評価。ただし工数と計測で判断) |
| **基本機能** | view 5 種(detail/calendar/kanban/filer/launcher)/ relations / revisions / workspace / アーキタイプの見せ方(kanban のトグル、calendar の日付、filer の表示 profile 等) | 機能として全部維持。データ表現は §3 の新スキーマに載せ替え |
| **大物機能** | mermaid / chart.js / docx / pptxgenjs / Office export(2026-07-01 user 裁定: keep・強化対象) | keep 裁定を継承 |
| **transport** | PKC-Message v1/v2 / pkc-ext §3.8 wire(host-push、Tier S 封じ込め)。**fail-closed 既定**(空 allowlist = 全 deny、origin ピン留め、flood guard) | wire 契約・セキュリティ既定ごと維持。既存拡張 HTML がそのまま動くこと |
| **アーキテクチャ規約** | 5-layer / `data-pkc-*` セレクタ / pure reducer + Renderer/ActionBinder/Presenter 分離 | 規約は維持。実装は §5 の見直し対象(肥大 file の解体・描画モデル) |
| **計測資産と規律** | `tests/bench/` 14 本 + `storage-arch-bench`(A〜E 構成・io・syscall・sink)+ perf-measurement 規律(対照群 / persistent profile / fixture のゼロ次元 / boot 窓で定常を語らない) | **P2 で最初に移植**。全段階の DoD は計測で書く |
| **provenance** | pkc-meta(app/version/schema/kind/timestamp/source_commit/code_integrity) | 維持。Pages の dev/product 判別に使う(§8) |
| **巨大 export の実戦傷** | #960 parts 分割 / #962 64MB Blob 畳み / #966 無圧縮 fallback | 実装は変わっても**性質を要件として継承**: 単一巨大文字列を作らない・総量比例のヒープを持たない |
| **backup ゲートの流儀** | pre-migration-backup(バックアップを書けたことを確認するまで進まない) | import / 破壊的操作の安全網として流儀を継承 |

## 3. データモデル v3: 全部 PKC-Markdown、アーキタイプ = フレーバー(user 指示 5)

**原則: entry の body は常に PKC-Markdown テキスト。** PKC2 の「JSON 文字列 body」
(todo / form / spreadsheet)は廃止し、**アーキタイプは「見せ方・編集の仕方」を決める
フレーバー**になる(presenter 選択・編集 UI・抽出フィールド定義)。

| フレーバー | PKC2 の body | PKC3 の表現(案) |
|---|---|---|
| todo | JSON `{status, description, date?, archived?}` | frontmatter(`status` / `date` / `archived`)+ 本文 markdown。kanban のトグルは frontmatter 書換の構造化操作 |
| form | JSON(固定 3 フィールド) | frontmatter のフィールド群 + 本文。**記入済みデータが機械可読**であること ── 将来のダッシュボード / 帳票(§10)がここから読む |
| spreadsheet | JSON `{rows}` + 数式 + グラフ | **csv fence**(PKC-Markdown 既存の renderable fence)+ frontmatter(数式・グラフ定義)。表示・編集は flavor presenter が担う |
| textlog | 専用構造 | 日時見出しの markdown 節(タイムスタンプ規約)。追記 UI は flavor が提供 |
| attachment | asset 参照 | asset リンク markdown + frontmatter meta |
| text / folder / generic / opaque | markdown 系 | ほぼそのまま |

- **変換は import の一回だけ**(user 指示 5「インポート後に新たなスキーマ」)。PKC3 内部に
  旧形式は存在しない ── PKC2 の「サイドカーがあれば正本、なければ inline」型の合流読みを
  最初から作らない
- **一様化の配当**: 検索・revisions(テキスト diff・圧縮効率)・AST export(docx/pptx)・
  AI 連携・md export(§9)がすべて 1 形式に収束する。「速く安く必要十分」の中核
- **速度の担保**: kanban / calendar が毎回全 body を parse しないよう、フレーバーが宣言する
  抽出フィールド(status / date 等)を**保存時に entries 表の列へ抽出して index** する
  (§4.3)。ビューは SQL query で O(表示分)

## 4. storage(最重点)

[PKC2 の wasm-sqlite 設計 doc](https://github.com/sm06224/PKC2/blob/main/docs/development/storage-wasm-sqlite-design-2026-07.md)
(裁定済みの方向)を PKC3 の文脈で再定義する。**PKC3 には旧データが存在しないので、
「最初から sqlite が正本」で始められる(移行コードが 1 行も要らない)。**

### 4.1 確定している実測(PKC2 の失敗の形 = PKC3 の受け入れ基準)

| PKC2 実測(500MB fixture、PR #1040) | 根本原因 | PKC3 での姿 |
|---|---|---|
| 毎起動 ~85MB の JSON を丸ごと parse | container = 単一 JSON record | SELECT(body 列を読まない)── boot は O(メタ) |
| revisions 80MB が JS heap に永続常駐 | 同上 | COUNT + 要求時 1 行読み |
| 初回索引構築で RSS 1.5〜1.6GB(OOM) | asset = base64 文字列 | bytes は Blob record(heap ±0) |
| 定常 RSS 1.0GB | 上記の合成 | 常駐はリーン集約のみ(§4.4) |
| 1 編集で container 全量書き | 同上 | 行単位 UPDATE ── 構造的に消滅 |

### 4.2 構成: ハイブリッド(ゼロコピー 2 原則に従属)

| データ | 置き場 | 実測根拠 |
|---|---|---|
| entries(meta + body)/ revisions / relations / workspace / settings / flags | **wasm-sqlite**(official `@sqlite.org/sqlite-wasm`、OPFS SAHPool VFS) | 実ディスクで投入 2,295ms / cold 22ms / 追記 200ms(300MB、PKC2 redesign doc §A.1 D 腕)── 実用水準 |
| asset の bytes | **Blob storage**(IDB Blob record) | BLOB を WASM に入れると読み ~9 倍 + リニアメモリ常駐 +246MB 級。IDB Blob は heap ±0・読み 0.8ms・syscall 最少(§A.1/A.2/A.9) |

メモリ 2 原則: **bytes は必要な瞬間だけ・必要な範囲だけ / 生成物はライフサイクル終端で即破棄**
(stmt finalize 徹底・WASM バッファ copy-out 後即解放・ObjectURL は所有者が revoke)。

※ user 語彙の「**idb にクローニング**」(指示 6)は「ブラウザ側の永続ストレージ層」の意と
解釈した(構造 = sqlite on OPFS / bytes = IDB Blob のハイブリッド)。文字どおり
IndexedDB 限定の意図であれば、sqlite の置き場を IDB-VFS 側へ寄せる構成も成立する
(性能は P2 で実測比較できる)── §12-2 で確認。

### 4.3 スキーマ v1

PKC2 wasm-sqlite doc §3 の DDL を土台に、本 doc の決定を反映する:

- `entries.body` = **常に PKC-Markdown**(§3)。SELECT では既定で読まない
- フレーバー抽出列(`status` / `date` 等、flavor 宣言に基づき保存時に抽出)+ index
- `settings`(正規設定)と `flags`(実験)を**別表**にする(§6)
- `assets` 表は meta + Blob storage へのポインタ行のみ(bytes を持たない)

### 4.4 実行形態: storage worker + リーン集約

- sqlite は専用 **Worker** 内(OPFS SAHPool は Worker 必須)。メインスレッドは query/command の
  message API。保存・直列化・圧縮の CPU がメインスレッドから構造的に出ていく
- reducer / Renderer の発想は維持し、常駐は**リーン集約**のみ: entries の meta
  (lid/title/archetype/dates/order/抽出列)+ relations + counters。15,000 entries でも数 MB
- body / revisions / asset bytes は需要駆動。PKC2 の `lazy_entry_bodies` が退役に終わったのは
  「単一 JSON 前提の上に後付け」だったから ── PKC3 は需要駆動が正規形なので、
  「hydrate 済みか」という中間状態が型から消える

### 4.5 書込増幅・syscall・圧縮・並行性(PKC2 実測の宿題を持ち込む)

- 「**ディスク I/O に負荷をかけたくない。ゆるいストリーミング圧縮とチャンクパックは必須**」
  (user 指示、PKC2 redesign doc §A.7。撤回されていない)── sqlite の journal_mode / WAL /
  synchronous / page_size は **io-bench の型で実測してから決める**(P2 DoD)
- §A.9 の SQLite WASM syscall chatter(読み 5,783 vs IDB Blob 97)は 300MB media を sqlite に
  入れた workload の数字。PKC3 ハイブリッド(sqlite は MB 級の構造データのみ)の実 workload で
  **run-syscall-profile を再計測**する(P2 DoD。憶測で「解決した」と言わない)
- revisions: **zstd グループ圧縮**(587x は snapshot 群の一括圧縮の数字 ── app 層で
  segment BLOB にしてから sqlite 格納)。ライブラリ選定は P5 で実測
- 多重タブ: SAHPool は実質単一接続 → **Web Locks の writer リース + BroadcastChannel 追従**を
  最初から。durability は要所のみ厳格化の二段構え。`navigator.storage.persist()` 要求
- OPFS 不可環境は IDB-VFS へ fallback。第一候補 = **crossOriginIsolated 不要の非 Atomics
  SAHPool**(GitHub Pages はヘッダ制御不可・単一 HTML も同様なので必須条件)── P2 冒頭で実機確認

### 4.6 可搬 HTML の boot: ストレージへクローンし、DOM に残さない(user 指示 6)

- 可搬 HTML の埋め込みペイロード(アプリ script / **DB image** / 基本構造)は、boot で
  **永続ストレージへクローンしたら DOM から除去**する。巨大 base64 を DOM に常駐させる
  PKC2 方式(メモリを食い、export 時に live DOM を読む不安定さの元)を廃止
- クローンは**冪等**(container_id + content hash をキーに、同じファイルを開き直しても
  増殖しない)。PKC2 の view-only boot が守っていた「開いただけで受信側の環境を汚さない」は、
  読取専用モードではなく**冪等クローン + 容易な破棄**で置き換える(§12-3 で確認)
- export / clone は **DB から生成**(SLOT 契約は生成時の出力仕様として維持)

## 5. 是正: 「古い設計や積み上げで遅くなる実装」を持ち込まない(user 指示 4)

すべて「単一 JSON 内部表現 + base64 文字列」の上に積まれた補償機構、または積み上げで
肥大した実装であり、**個別の延命をしない**。

| 対象(PKC2 実体) | 何が問題だったか | PKC3 |
|---|---|---|
| layout marker 3 種 + サイドカー 5 種 + 「あれば正本、なければ inline」合流読み(`idb-store.ts:274-348`) | 部分読み書きの欠如の補償。旧ビルド静音欠損事故(#1022)の温床 | **持ち込まない**。sqlite の行と index が正規形 |
| segments バケット(~1MB gzip パック + 追記規約 + compaction) | 書込増幅の補償 | 実装は持ち込まず、**設計だけ** §4.5 の zstd グループ圧縮として継承 |
| asset working-set(48MB budget)+ 4MB/8MB 閾値止血 | base64 が heap を通ることの補償 | **概念ごと消滅**(Blob + ObjectURL でサイズ非依存) |
| 形式切替 flag の系譜(`differential_save` / `lazy_entry_bodies`、退役に 4 経路合成 + pin test を要した) | 形式が複数あること自体 | **形式は 1 つ**。切替 flag を作らない |
| storage backend の user 選択 4 種(idb/opfs/fsa/memory) | 単一 record 形式の性能問題からの逃げ道 | **sqlite 一本 + Blob storage**。memory は test 専用。FSA folder sink は §12-6 で裁定 |
| JSON 文字列 body(todo/form/spreadsheet の個別形式) | アーキタイプごとの専用 parse / 専用保存経路の積み上げ | **全 PKC-Markdown + フレーバー**(§3)で一本化 |
| flags 85 個(実測) | 設定・出荷済み toggle・実験の未分離 | §6 で分離・予算化 |
| `renderer.ts` 12,523 行 / `action-binder.ts` 11,939 行の単一 file、編集のたびサイドバー全行再構築だった描画モデル(#1030 系) | 積み上げの温存。「体感の主因は描画」(PKC2 実測)の震源 | **v3.0 スコープ内で見直す**(user 指示 4 で確定)。P3 で module 分割 + 描画モデルの再設計(差分描画。edit-main-thread-block 計器を DoD に) |
| markdown の表示 / AST export 二重実装 | 方言追加のたび二重メンテ | P3 で統一を**再評価**(IR 統合の未完 scaffolding `markdown.use_ir` を土台にするか、二重のまま磨くかは工数と計測で判断) |
| doc / コメントと実態の乖離(「OPFS は seam 予約のみ」実は実装済 / stale CI コメント / 8 archetype 表記) | ── | founding doc(本書)と実地調査を正とし、乖離を移植しない |

## 6. flags と正規設定の分離(user 指示 3)

**実態**: PKC2 の flag は 85 個(2026-07-30 実測)。(a) 実質「設定」(theme / thumb / 閾値等の
tuning knob)~35、(b) 出荷済み機能の畳まれなかった toggle(shell.* 30 個等)~45、(c) 実験 ~5。

| | 正規設定(settings) | flags |
|---|---|---|
| 目的 | user の恒久的な好み・調整 | 実験・段階導入・障害時の緊急脱出弁 |
| 置き場 | sqlite `settings` 表 + 設定 UI | sqlite `flags` 表 + URL/`?pkc-debug` 導線 |
| 寿命 | 無期限 | **各 flag に「畳む条件」の宣言必須** |
| 予算 | なし | **最大 15 個。CI test で pin**(超えたら CI が落ちる) |

移行方針: (a) → settings へ / (b) → 既定 ON で焼き込み、toggle 削除 / (c) のみ flag 枠。
v3.0 出荷時点の flag は数個に収まる見込み(15 は上限であって目標ではない)。

## 7. 依存方針(受容モード)

**PKC2 実態**: prod 依存 6 個。Renovate「主権モード」(全 update approval + 7 日 cooldown)。
Dependabot 撤退済み。SBOM なし。

| 項目 | PKC3 提案 |
|---|---|
| 依存更新 | **Dependabot version updates** 週次(npm + github-actions)、minor/patch グループ化。security updates 即時。CI 全 green の minor/patch は auto-merge、major は手動 review(§12-5) |
| SBOM | **CycloneDX** を release workflow で生成し GitHub Release に添付。dependency graph / Dependabot alerts 常時 ON |
| 新規依存(性能のため) | `@sqlite.org/sqlite-wasm`(official。PKC2 storage-arch-bench D 腕で検証済み)/ zstd-wasm 系(P5 実測選定)。既存 prod 6 依存は継承 |
| 衛生 | `engines` + `.nvmrc`(Node 24)宣言 / `.npmrc` `ignore-scripts=true` / `npm audit --audit-level=high --omit=dev` blocking gate 継承(happy-dom 経由 `ws` の既知地雷メモごと) |
| tripwire | size budget を「手違い検出」として継承(撤廃しない・報告は残量で)。Pages では初期チャンク budget に読み替え |

## 8. 配信: GitHub Pages + PWA(user 指示 1・9)

**前提制約**: Pages はカスタムヘッダ不可 → COOP/COEP なし → **非 Atomics SAHPool 必須**
(§4.5。単一 HTML と同じ制約なので storage 設計は配信形態に依らず一本)。

```
https://sm06224.github.io/PKC3/        ← プロダクト版(最新 release tag、kind: product)
https://sm06224.github.io/PKC3/dev/    ← dev 版(main HEAD、kind: dev)
```

- workflow: push(main)/ release(publish)で起動、1 つの Pages artifact に両版を合成して
  `actions/deploy-pages`。kind / timestamp / code_integrity(pkc-meta 流儀)で機械判別
- **配信形態はマルチファイル静的ビルドで確定的**(v1 の案 A): PWA の service worker は
  独立ファイルが必須であり、単一ファイル配信と両立しない。副次効果として sqlite3.wasm は
  `instantiateStreaming`(base64 デコードも一括 heap 載せも無し)、mermaid ~3MB は
  遅延チャンク化できる(PKC2 は inlineDynamicImports で「lazy import してもサイズ同梱」だった)
- **PWA**(user 指示 9): manifest(install メタ)+ service worker(offline cache)+
  **File Handling API で `.md` のハンドラ登録**(インストール済み PKC3 が md ファイルを
  直接開ける。開いた md は取込 or その場閲覧)。※ file_handlers はインストール済み
  Chromium 系 PWA の機能 ── 対応外ブラウザでは従来どおり drag&drop / picker で md を受ける
- **可搬式単一 HTML は export 機能として維持**(§9)。file:// で SW なしに自立動作 ──
  PKC2 の成果の核は配信形態と独立に守る
- CI artifact に private data を載せない規律(PKC2 2026-05-05 user direction)を Pages workflow にも適用

## 9. import / export(user 指示 7 で v1 から改訂)

### 9.1 import(PKC3 が読むもの → すべて新スキーマへ変換)

| 形式 | 契約 |
|---|---|
| PKC2 export HTML | `app:'pkc2'` + `schema:1` を明示受理。shell 2 変種(平文 pkc-core / gzip+loader)両対応。`<\/script>` エスケープ復元。`asset_encoding` は artifact 全体で 1 つ |
| PKC2 ZIP(pkc2-package v1)| stored mode(method 0)受理。container_id 新規採番 |
| PKC2 バンドル 5 系統 | additive・failure-atomic の意味論ごと受理 |
| 生 md ファイル(単体・複数)| §8 の md ハンドラ / drag&drop と同根。frontmatter があれば流儀どおり解釈 |

import 時に §3 のフレーバー変換(JSON body → PKC-Markdown)を実行。**ここが PKC2 資産の
唯一の入口**であり、変換の正しさは PKC2 実データ由来の fixture で pin する(P6 DoD)。

### 9.2 export(PKC3 独自形式。PKC2 互換の義務なし ── user 指示 7)

| 形式 | 内容 |
|---|---|
| **① 可搬単一 HTML**(主) | アプリ + **sqlite image** + assets を埋め込み。開いた側は boot でストレージへクローンし DOM から除去(§4.6)。file:// 自立動作 ── ✅ **着地**(#400、2026-08-25)。⚠ **クローン先は OPFS ではなく IndexedDB** に変わった(下記) |
| **② 圧縮アーカイブ `.pkc3.zip`**(バックアップ・交換の主形式) | manifest + **sqlite image(圧縮)** + assets/。「sqlite をそのまま吐き出しても良い。ただし可搬を想定して圧縮したアーカイブが望ましい」(user 裁定 2026-07-30)をこの形式で満たす |
| **③ md + assets の ZIP** | 全 body が PKC-Markdown になった配当。人間可読・他ツール / AI 互換の交換形式 |

- 🔴 **① は P6 で落ちていた**(在るのは「閲覧用 HTML」= 読むだけのビューアで、
  アプリも sqlite image も入っていない)。⚠ **`file://` は opaque origin なので OPFS が
  使えない**ことを実測した ── 「ストレージへクローン」の**クローン先が OPFS 前提だと
  成立しない**(IDB は使えて永続する)。実測と設計は
  `f2-portable-single-html-2026-08.md`。②③ は先に実装済み
- ✅ **2026-08-25 に着地**(#400 段①〜⑤)。設計から変わった点は 2 つで、
  どちらも**実測が決めた**:
  1. 🔴 **可搬バンドルは OPFS を試さない**(doc §4-1 の裁定 A を狭めた)──
     `file://` では原理的に取れず、`https://` に置くと**その origin の本体の DB を
     開いてしまう**。試す理由がどちらでも無いので、経路を 1 本にした。
     ⚠ `:memory:` は fallback ではなく**選んだ形**なので `fallbackReason` を載せない
  2. 🔴 **器の名前空間は「あると良い」ではなく正しさの要件**(doc §4-3 を強めた)──
     実測で **`file://` は origin が全部 `file://` に潰れ、別ディレクトリの別 HTML と
     IndexedDB を共有する**ことが分かった。器 / 書込リースの鍵 / タブ間の放送路の
     **3 つとも**、焼き込んだ id で切っている
  - **これが分かったら覆る**: ブラウザが `file://` に per-file の storage bucket を
    与えるようになったら、名前空間の一部は不要になる(いま切っている 3 つのうち
    器と鍵)。⚠ ただし**既に配った 1 枚の器が変わる**ので、そのときは移行が要る
- 機械可読 JSON export は v3.0 では作らない(③ md ZIP が交換を担う。transport の
  JSON payload は別物で維持)。需要が出たら拡張点
- **PKC2 → PKC3 は一方通行**(user 裁定 2026-07-30「PKC3 のエクスポートは、PKC2 に
  インポートしません」)。PKC2 は手元に残り続けるので、戻る必要が構造的に生じない
- 巨大 export の性質要件(§2 実戦傷)は形式に依らず適用

## 10. 将来領域(v3.0 に盛り込まない。新スキーマが排除しないことだけ担保)

| 領域(user 指示 10) | v3.0 で確保する拡張点 | 実装時期 |
|---|---|---|
| **複合フォーム + 記入済みデータ → ダッシュボード / 帳票**(PKC1 由来) | form フレーバーの frontmatter が機械可読であること(§3)+ 抽出列の sqlite query(§4.3)。帳票生成は既存 AST export(docx/pptx)の延長線に置ける | v3.x(裁定で起動) |
| **Graph API トークン → OneNote 等の外部接続** | pkc-ext 流儀の外部コネクタ拡張点(PKC2 の OneNote 送信拡張 v0 #924-925 が先行例)。トークンは settings(§6)に保存する前提の枠だけ | v3.x(裁定で起動) |
| フレーバー SQLite(FTS5 / sqlite-vec 焼き込み) | §4 の VFS/ビルド層に拡張点(PKC2 §A.5 の裁定を継承: 採用トリガは性能でなく機能) | 凍結のまま |

## 11. 段階計画(小さく積む ── 各段階が単独で着地し、単独で計測できる)

| 段階 | 内容 | DoD(計測・test) |
|---|---|---|
| **P0** | 本 doc(v2)の裁定 | ── |
| **P1** | repo bootstrap: toolchain(vite 8 / TS 6 / vitest 4 / Node 24 宣言付き)+ CI + Dependabot + SBOM + Pages workflow(マルチファイル + PWA manifest/SW の骨格) | dev 版 URL で shell が動く。CI 全 green。SBOM が Release に付く |
| **P2** | 計測ハーネス移植(boot-rss / storage-write-io / edit-main-thread-block / storage-arch-bench + **継続使用の編集セッション腕**)+ sqlite core(worker + 非 Atomics SAHPool 実機確認が最初 / schema v1 / store API / journal 設定の実測選定) | SAHPool 成立可否の確定。PKC2 500MB fixture のベースラインを PKC3 計器で再現取得 |
| **P3** | **app 層の総合的見直し + リーン集約接続**(user 指示 4): module 分割(renderer / action-binder 解体)・描画モデル再設計(差分描画)・フレーバー presenter(§3)・検索 / export の query 化 | boot O(メタ)。**編集セッション N 分の RSS 時系列**と long task が PKC2 比で下がる(boot 窓だけで語らない) |
| **P4** | assets: sqlite meta 行 + Blob storage(ObjectURL 描画、revoke 規律) | 500MB fixture で asset 起因の RSS 山が消える。閾値止血が存在しないこと |
| **P5** | revisions: COUNT / 要求時読み + zstd グループ圧縮(ライブラリ実測選定込み) | revisions 常駐 0。実データ系 fixture で圧縮率を再測 |
| **P6** | import(§9.1 受理層 + フレーバー変換)+ export(§9.2 ①②) | PKC2 実 export 資産の roundtrip が新スキーマで通る(fixture pin)。可搬 HTML の boot クローン→DOM 除去が機能 |
| **P7** | v3.0.0: Pages プロダクト版 + PWA 仕上げ(md ハンドラ)+ マニュアル + 移行ガイド | product URL 稼働。install / md ハンドラ動作。release に SBOM / provenance |

P1〜P2 は並行可。P3 が最大工数。**「効果が小さい」は棄却理由にしない**(積み上げ先 = 本 doc)。

## 12. 裁定記録(P0 クリア ── user 裁定 2026-07-30。不可侵)

> 「**idbは例として言いました。私が口を出しすぎて、前回失敗したから任せます**」
> 「**PKC3のエクスポートは、PKC2にインポートしません。なんなら、sqliteをそのまま
> 吐き出しても良い。ただし、可搬を想定して圧縮したアーカイブが望ましい**」
> 「**良いよー任せる!最強のノートアプリにするんだー**」

これにより **P0 はクリア、実装 go**。v2 で挙げた裁定 10 点は、明示裁定 2 件(export /
「idb」は例示)+ 全面委任に基づき以下のとおり確定する(覆せるのは user の明示指示のみ):

| # | 論点 | 確定 |
|---|---|---|
| 1 | データモデル v3 | §3 のとおり採用(spreadsheet = csv fence / textlog = markdown 節 含む) |
| 2 | ストレージ構成 | ハイブリッド(構造 = sqlite on OPFS / bytes = IDB Blob)。「idb」は例示(user 裁定) |
| 3 | view-only の置き換え | 冪等クローン(hash キー・増殖しない・容易な破棄)(§4.6) |
| 4 | export | §9.2 のとおり: ①可搬 HTML ②圧縮アーカイブ(user 裁定を正式化)③md ZIP。JSON export は作らない |
| 5 | 依存更新 | Dependabot 週次 + minor/patch は CI green で auto-merge、major は手動 |
| 6 | FSA folder sink | v3.0 に持ち込まない(②アーカイブ export が代替。需要が出たら拡張点) |
| 7 | PKC2 → PKC3 | **一方通行**(user 裁定) |
| 8 | PKC2 リポジトリ | user 管理(本 repo の外)。PKC3 からは read-only 参照のみ |
| 9 | flags 運用 | 上限 15 を CI test で pin + 各 flag に畳む条件の宣言必須(§6) |
| 10 | 識別子 | `app:'pkc3'` / schema v1 / DB 名・prefix `pkc3.` / 生成物 `pkc3.html` |

## 12.1 追加の裁定 ── **端末をまたぐ同期は任意の設定(既定 OFF)として入れる**(#2000)

> 履歴(1 行): 2026-08-23(#348)に「端末をまたぐ同期は non-goal」と裁定したが、2026-11-21 の user 裁定で**覆した**(下記)。

| # | 論点 | 確定 |
|---|---|---|
| 11 | **端末をまたぐ同期** | ✅ **任意の設定として入れる。既定は OFF = 今までどおり完全にローカル。** フラグではない(正規設定。flags 15 枠は使わない) |
| 11a | 進め方 | 段 1 変更の集合の核 → 段 2 差分ファイル(`*.pkc3-diff.zip`)→ 段 3 フォルダ同期で全データ → 段 4 で通信を使う経路を再検討 |
| 11b | 競合 | **案 A: 両方残す**。競合の一覧に出す。何も失わない |
| 11c | 別の端末で消えた物 | こちらでは**ゴミ箱へ移す**(戻せる) |
| 11d | WebDAV / S3 / P2P | 段 4 まで保留(サーバや他社の接続先が要るため。ブラウザだけで完結する土台は、既定 OFF と、段 2・3 のファイル経由で保つ) |

### 段 1 の設計(`src/features/sync/`)

- **判定は時計ではなく内容の指紋**。各キーを、前回の合意(相手ごと)・こちら・相手の三者で比べる(`change-set.ts`)。`updated_at` は判定に使わない
  (時計ずれ・巻き戻しで取りこぼす / 上書きするため。表示専用)。判定の関数の入力に時刻の欄は無い(型と test で固定)。
- **指紋は 2 つの欄**: `content`(題名・種別・本文)と `place`(親フォルダ)。三者比較は**欄ごと**に行う。
  片方の端末で移動・もう片方で編集をしても自動で合わさり(`merge`)、**同じ欄が両方で違う値になったときだけ**競合にする。
  つながりは作る・消すだけなので `place` を持たず、`content` は定数。
- 分類: 同一内容 → 何もしない / 片方だけ変更 → その版を採る / 欄が別々に変わった → 合わせる / 同じ欄が両方で違う → 競合 /
  相手が消してこちらは未変更 → ゴミ箱へ / 消した側と変えた側 → 競合(消さずに残す)。
- 競合の解き方(案 A): 同じ欄が両方で違う・初回の同期 → こちらを残し相手の版を別ノート(新しい lid)として加える /
  こちらで消し相手が変えた → 相手の版を戻す / こちらが変え相手が消した → こちらを残して送り返す。
- **時計の代わりに「端末 id(端末ごとの乱数)+ 端末ごとの単調な連番」**。連番は端末ごとの順序づけ用で、相手の連番を見たら追い付く。
  **端末をまたいだ連番の大小は比べない**。時計(`deletedAt`)を使うのは古い削除の記録の整理だけ。
- **スキーマは変えない**(`DB_SCHEMA_VERSION` は据え置き)。置き場は `settings` 表:
  端末の物(端末 id・連番)は scope `__sync__`、**ワークスペースごとの物**(削除の記録・相手ごとの前回の合意・相手との対応)は
  scope `__sync__:<cid>`(`syncScope`。`tag-color:<cid>` と同じ作法)。ワークスペースの削除は `deleteContainerRows` がこの区画も消す(実装済み・test あり)。
  理由: 版を上げると旧ビルドが DB を開けなくなる / 同期 OFF の間は行を 1 本も書かない。
- **同期の記録は書き出しに入らない**(test で固定): バックアップ(`.pkc3-*.zip`)は設定の表を読まず、
  人に渡す HTML の DB 画像は `withMessagesRemoved` が `__sync__` 系の行を(確定させずに)除く。
- **削除の記録(墓標)**: 消すとゴミ箱の版が残るが、**ゴミ箱を空にすると消える**。それだけを頼ると、空にした後に他の端末の古いコピーが
  新しいノートとして復活する。だから消した事実(キーと消した時点の指紋・消した日時)を別の行で持ち、期限(180 日)と件数(5000)でだけ捨てる。
  こちらの削除の記録は三者比較(`localTombstones`)に入る: 前回の合意が無く、こちらに無い物は、削除の記録の指紋を基準にする
  (同じ内容が相手にあれば相手へ消去を送る / 違えば「消した側と変えた側」の競合)。
  同期済みの相手には前回の合意との差でも削除が分かる。削除の記録が要るのは、まだ同期していない相手へ伝えるとき。
  日時の無い記録は期限では捨てず、件数の整理では最も古い扱いで先に捨てる。
- **設定キーは段 1 では足さない**(段 1 に効果が無いため)。同期の設定(既定 OFF)は、最初の画面の入口と一緒に段 2 で足す(端末ごとの設定なので、設定ファイルでは移さない側に載せる)。
- **画面の言葉**: 「同期の記録」(前回の合意)・「削除の記録」(墓標)と書く。**「墓標」「基準」「合意」は画面に出さない**。

### 段 2 が守ること(段 1 で決めた約束)

1. **ワークスペースの対応(cid)**: cid は端末ごとに乱数で作られ(`mintContainerId`)、バックアップの `cid` も取り込み先には引き継がれない。
   **端末をまたいで一致しない**。だから差分ファイルは書き出し元の cid と題名を持ち、受け取った端末が
   `__sync__:<自分の cid>` の `pair:<相手の端末 id>` に**相手の cid を記録して対応づける**。初回は同じ題名のワークスペースを提案し、
   user が確認する(別の題名なら選び直す / 新しく作る)。対応が無いまま取り込まない。
2. **種の同期の記録(`seedBaseline`)**: 同じバックアップから復元した 2 台が、記録の無いまま最初の同期をすると、編集したノートが全部競合になる。
   そこで、バックアップ・差分ファイルを**書き出す時点**の指紋の一覧から種を作って記録に書く(書き出す側は書き出し先の端末 id が決まらないので
   指紋の一覧をファイルに添え、取り込む側がそれを元の端末の記録として `seedBaseline` で書く)。復元後の編集を含めない。
   種が無い初回で両方にあって違う物は、安全側で競合にし、`first-sync` と印を付ける(画面は通常の競合と分け「初回の同期」と出せる)。
3. **全件の突き合わせ**: 前回の同期の記録が、整理で捨てた削除の記録より古い端末(180 日・5000 件を超えて同期しなかった端末)は、
   削除の記録だけでは消えた物を拾えない。その場合は**相手の全件**(`remoteIsComplete: true`)で突き合わせる(段 2 で実装する)。
4. **端末 id の重複**: 差分に**自分の id** が来て、その内容が自分の履歴(自分が出した連番・指紋)に無いとき、DB ファイルの複製とみなし**自分の id を作り直す**
   (`isSameDevice`)。作り直した端末は同期の記録を捨て、全件の突き合わせから始める。
5. **全体を復元したら記録を捨てる**: バックアップから全体を復元したとき、その DB の同期の記録(前回の合意)は**捨てる**
   (古い内容が「新しい変更」として相手へ戻るのを防ぐ。復元元の指紋があれば項目 2 の種を書く)。
6. **親が消えた子**: 親フォルダがゴミ箱へ移る(または相手で消える)と、子の親フォルダの宛先が無くなる。取り込み側は子を**ルートへ置く**
   (消さない。place の欄は宛先が無ければルートとして扱う)。
7. **本文が参照する添付が無いとき**: 差分・取り込みで添付の実体が足りなくても、**参照は残し**、取り込み結果に「足りない添付」として一覧で出す(黙って捨てない)。

### 段 2 の実装(差分ファイル `*.pkc3-diff.zip`。#2000)

- **設定 `pkc3.sync`**(既定オフ。端末ごと = `SKIPPED_KEYS`。フラグではない)。オフの間は行を 1 本も書かず、入口(「書き出す ▾」の「差分を書き出す」)も出さない。
  取り込みは**断り、設定の場所を言う**。worker は `syncConfigure` で入 / 切を知り、入のときだけ `deleteEntry` が削除の記録を同じ tx で残す。
- **差分ファイル**: `manifest`(端末 id・連番・元の cid と題名・全件か)+ `container`(変わったノートの本文 / つながり(全件)/ 削除の記録 /
  **全件の指紋**(種・全件の突き合わせ・端末 id の重複の見分け)/ **`peerBase`**(送り手が受け手の版をどう見ていたか)/ 添付の目録)+ `assets/<key>`。
  指紋の一覧が全件あるので、受け手は常に `remoteIsComplete: true` で突き合わせる。本文の無いノートを取り込む判定になったら「取り込めない」と言い、全件の書き出しを案内する。
- **競合の連鎖を止める**: 同じ版から別々に直した後の往復で競合のコピーが増え続けないよう、判定の前に「受け手がまだ相手の見た版のままのキー」だけ、
  相手が見た版を共通の祖先にする(`effectiveBaseline`)。保存する同期の記録は「相手がいま持っている版」(取り込んだ物は取り込み後の指紋、
  こちらだけの変更・合わせた結果・コピーの元は相手の版 → 次の書き出しで差分になる)。
- **ワークスペースの対応**: 取り込み先は**いま開いているワークスペース**。初回は元の題名と並べて確認し、`pair:<相手の端末 id>` に相手の cid を記録する。
  対応済みで cid が違う差分は断る。別のワークスペースへ取り込みたいときは、先に切り替える / 新しく作る。
- **反映**: worker の `syncApply` が 1 つの tx(内容 = `checkpoint: true` で前の本文が履歴に残る → 親フォルダ(宛先が無い・輪ならルート)→ ゴミ箱 → つながり → 同期の記録)。
  失敗したら何も書かない。取り消し(`syncUndo`)は取り込みで変えたノートの前の姿の控えで戻し、**取り込み後に編集したノートは触らない**。取り消しは削除の記録を残さない。
- **競合の一覧**: 相手の版を別ノート(題名の末尾に「(同期の競合 日付)」/ 初回は「(初回の同期の競合 日付)」)として足し、取り込み結果の面に題名つきで並べ、
  メッセージ(system 領域)に件数と検索語を 1 件積む(メッセージは題名を伏せる規則なので、題名は結果の面とコピーのノート自身が持つ)。
- **バックアップの種**: オンの端末の全体のバックアップ(`.pkc3-full.zip`)は `container.json` に `syncSeed`(書き出す時点の指紋 + 端末 id)を添え、
  取り込み側(オン)は lid が変わらずに入ったノートだけを「元の端末の前回の合意」として書く(既に記録があれば書かない)。全体を作り直した(`wipeStorage`)ときは記録ごと消える。

### 運ぶ物の全数表(正本: `change-inventory.ts` の `SYNC_INVENTORY`。test が行の id と順を突き合わせる)

| id | 種類 | 運ぶか | 段 | どう運ぶ / 運ばない理由 |
|---|---|---|---|---|
| `body` | 本文 | 運ぶ | 2 | 内容の指紋で照合し、丸ごと運ぶ。取り込み側は前の本文を履歴へ残す |
| `title` | 題名 | 運ぶ(指紋の一部) | 2 | 内容の欄に入れる。題名だけの変更も拾う |
| `kind` | 種別(フレーバー) | 運ぶ(指紋の一部) | 2 | 内容の欄に入れる。種別を変えると抽出列が変わるので本文と同じ単位 |
| `parent` | 親フォルダ | 運ぶ(指紋の一部) | 2 | 親フォルダの欄に入れる(移動と編集は欄ごとに合わさる)。並び順は端末ごとなので含めない |
| `tags` | タグ | 本文から導かれる | 2 | 本文と一緒に動く |
| `relations` | つながり | 運ぶ | 2 | キーは from / to / 種類(id ではない)。作る・消すだけ |
| `labels` | 色ラベル | 運ぶ | 3 | 生きているノートの色を `lbl:<lid>` のキー(指紋 = 色の番号のハッシュ)で三者比較に載せる。差分ファイルとフォルダ同期の両方に入る |
| `pins` | ピン留め | 運ぶ | 3 | `pin:<lid>`(指紋は定数)。留めた順は運ばず、足すときは末尾へ |
| `revisions` | 履歴(版) | 運ばない | - | 端末固有の差分の鎖。全部はバックアップ(`.pkc3-full.zip`)で運ぶ |
| `assets` | 添付 | 運ぶ | 2 | ハッシュで、相手に無い実体だけ |
| `settings` | 設定・フラグ | 運ばない | - | 端末ごとの見た目・許可。設定ファイルで別に移せる |
| `system-notes` | system 領域のノート | 運ばない | - | アプリ自身の記録で、user のノートではない |
| `trash` | 削除(ゴミ箱) | 運ぶ(削除の記録だけ) | 2 | ゴミ箱の中身は運ばない。受け取り側は自分のゴミ箱へ移す |
| `sync-state` | 同期の記録 | 運ばない | - | 端末ごと(id を共有すると変更が消える) |

段 2 で運ぶのは、本文・題名・種別・親・つながり・添付・削除。段 3 で色ラベル・ピン留めを足した(差分ファイルにも入る)。

⚠ **覆せるのは user の明示指示のみ**(§12 と同じ)。

### 段 3 の実装(フォルダ同期で全データ。#2000)

段 2 と**同じ核**(`planSyncImport` / `syncApply` / `syncUndo`・指紋の三者比較・競合は両方残す・消えた物はゴミ箱)の上に、共有フォルダ経由の同期を足した。

- **置き方**(`features/sync/sync-folder.ts`): 選んだフォルダの中の `pkc3-sync/` に、**端末ごとに 1 つ** `<端末 id>.pkc3-diff.zip`(全件の差分ファイル。書き換えるだけで増えない)と、
  添付の実体 `assets/<key>`(内容で名前が決まるので端末間で共有。無ければ置く)。**他の端末のファイルには書かない** → クラウドの同期が同じファイルを両側から書き換える競合が起きない。
  差分ファイルは添付の**目録だけ**を持ち(`inlineAssets: false`)、実体は `assets/` から引く(hash が目録と合わなければ置かない)。
- **同じファイルを取り込み直さない**: 相手ごとに「取り込んだ最新の連番」を同期の記録(`last:<端末 id>`。`syncApply` の同じ tx で書く)に持ち、ファイルの概要(`readDiffManifest`)の連番がそれ以下なら本体を読まない。
  大きさ + 更新日時が前回と同じファイルは概要も読まない。**変わっていなければ自分のファイルも書き換えない**(自分の控え `out:<連番>` の指紋の要約と、いまの要約が同じなら書かない)。
- **途中までのファイル**: 更新日時が 2 秒以内なら次の回へ。zip として読めなければ(`readDiffManifest` / `readDiffZip` が throw)取り込まず、同じ知らせを繰り返さずに次の回でやり直す。
  ファイルは `createWritable`(閉じるまで元のファイルを残して入れ替える)で書く。失敗したら `abort`。名前が対象外のファイル(クラウドの「競合コピー」など)は見ない。
- **収束の工夫**: ファイルは宛先が 1 台に決まらないので、container に**相手ごとの記録**(`peerBases`: 端末 id → 送り手が相手の版をどう見ていたか)を入れ、受け手が自分の id の分を使う。
  さらに `effectiveBaseline` は「相手が、相手の見た版のまま変えていないキー」も共通の祖先にする(相手のファイルが先に在り、こちらの記録が無いまま最初に取り込むと、こちらの編集が初回の競合になるため)。
- **色ラベル・ピン留め**(`sync-marks.ts`): 生きているノートごとに `lbl:<lid>`(指紋 = 色のハッシュ)・`pin:<lid>`(定数)のキーにして、ノート・つながりと同じ三者比較に載せる。
  差分ファイルにも入る(`container.labels` / `pins`。段 2 のファイルには無い = `null` → 判定に入れず、こちらの印を消さない)。ピン留めの順番は端末ごとなので運ばず、足すときは末尾へ。
  **色の競合は両方残せない**ので、色の番号が大きい方に決める(時計を使わず、どちらの端末で判定しても同じ → 往復で食い違いが残らない)。ゴミ箱のノートの印は運ばず、行は残す(戻すと色も戻る)。
  反映は `syncApply` の同じ tx で、触る前の行を控えて取り消しで戻す。
- **handle の保存と許可**(`platform/sync-folder-store.ts`): handle を IndexedDB(`pkc3-sync-folder`。cid 鍵)に保存し、次の起動で `queryPermission`。`granted` → 再開 / `prompt` → 「許可する」ボタン(押した操作の中で
  `requestPermission`。勝手には求めない)/ 拒否 → 止めて選び直しを案内。「フォルダの設定を外す」で保存も消す(片道にしない)。Firefox / Safari(`showDirectoryPicker` 無し)は理由を言って断り、差分ファイルの方法を案内する。
- **画面**: 設定「端末間の同期」の下(オンのときだけ)に「フォルダを選ぶ… / 許可する / 今すぐ同期 / フォルダの設定を外す」と状態。結果・失敗はメッセージ(system 領域)へ。
  定期の回(1 分ごと・画面が見えたとき)は**確認を出さない**(初めての相手・端末 id の重複は「確認が要る」と状態に出し、「今すぐ同期」で聞く)。変わらない回は結果の面を出さず再読み込みもしない。
  別のタブとは `navigator.locks` で重ならない。設定が切のときは読まず・書かず・タイマーも張らない(保存した handle は残り、入に戻せば再開)。
- **既存の「PC のフォルダ」同期(`title.md`)はそのまま残す**(別の機能・別の入口(PC タブ)。title.md の書き出しに頼る user を壊さない)。全データの同期は端末間の同期の設定の下に置く(同じ設定・同じ核)。
- **古い端末のファイル**: 端末ごとに 1 つなので溜まらない。使わなくなった端末のファイルは、取り込み済みなら手で消してよい(自動では消さない = 共有フォルダへの破壊的な操作を勝手にしない)。
  `assets/` の掃除も手動(内容で名前が決まる共有物で、他の端末が参照中かを知る手段が無い)。
- **限界(未対応・記録)**: ① 「同期の記録を消す」「端末 ID の作り直し」の後、フォルダに残った**古い自分の id のファイル**は別の端末のファイルとして取り込まれ、変えた物が初回の競合になる(手で消す)。
  ② 片方がゴミ箱から戻した物は、もう片方の削除の記録が残っているため次の同期で再び消える(段 2 から続く。削除の記録に「戻した」を持たせる改善が要る)。
  ③ 全件のファイルを毎回書き換えるので、ノートが非常に多いと書き出しが重い(変わったときだけ書く)。端末ごとの差分ファイル(宛先別)は段 4 で通信と一緒に再検討。

## 13. 参照(すべて PKC2 リポジトリ側。read-only)

- [`storage-wasm-sqlite-design-2026-07.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/storage-wasm-sqlite-design-2026-07.md) ── storage 方向の正本(user 指示 2026-07-27)。
  本 doc §4 はこれの PKC3 文脈への再定義
- [`storage-v3-redesign-2026-07.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/storage-v3-redesign-2026-07.md) ── 実測の全記録(§A.1 アーキ 5 構成 / §A.3 zstd /
  §A.5 フレーバー SQLite / §A.7 書込増幅 / §A.8 並行性 / §A.9 syscall)
- [`storage-default-layout-decision-2026-07-26.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/storage-default-layout-decision-2026-07-26.md) ── 棄却済みの案(再提案しない)
- [`session-handoff-2026-07-26.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/session-handoff-2026-07-26.md) ── 直近の着地と教訓
- [`docs/spec/schema-migration-policy.md`](https://github.com/sm06224/PKC2/blob/main/docs/spec/schema-migration-policy.md) ── schema 単調・明示 reject の規約(§9 の下敷き)
- [`docs/spec/pkc-message-api-v2.md`](https://github.com/sm06224/PKC2/blob/main/docs/spec/pkc-message-api-v2.md) ── transport の正本(§2 継承)
- [PKC2 CLAUDE.md](https://github.com/sm06224/PKC2/blob/main/CLAUDE.md) ── 不可侵指示群と Invariant 5 の判定法

#### 🔴 2026-08-22 追記 ── **動線と vision の参照が 1 本も無かった**

⚠ 上の 7 本は**全部 storage / transport / schema** である。この doc は
**PKC2 の「ストレージの物語」だけから組まれていた** ── その結果、移植の台帳(#180)は
機能の一覧になり、**「動線」という語はこの doc に 0 件**のまま進んだ
(user 指摘 2026-08-22「PKC2 の資産をただ機能に分解してテキトーに実装させれば
いいと勘違いしている / 私が動線も気にしろといったのはそういうところだぞ?」)。

**欠けていた参照を足す。**

**① 長期構想(D 系列)── PKC2 が「何を目指していたか」**

- [`docs/vision/pkc-multi-window-architecture.md`](https://github.com/sm06224/PKC2/blob/main/docs/vision/pkc-multi-window-architecture.md)
  ── **D-2**。§3 に「**編集と参照を物理的に分離できる**」「特定 view を常時表示できる
  (TOC / calendar / search)」。⚠ **PKC3 #300 の要望と同じ内容が 2026-04-12 に書かれている**。
  §6 の「変更は main / shared dispatcher 経由で一本化」は、PKC3 の
  `store-proxy.ts`(holder / follower)が**既に実現している**
- [`docs/vision/pkc-message-externalization.md`](https://github.com/sm06224/PKC2/blob/main/docs/vision/pkc-message-externalization.md)
  ── **D-1**。⚠ **2026-08-25 訂正** ── ここは長く「PKC3 では #189 / #195 に対応」と
  書いていたが、**対応付けが違う**(#403 で検算した)。#189 は「PKC3 が iframe に
  **入れられる側**」、#195 は「PKC3 が**ホストになる側**」で、どちらも D-1 が
  言っている **user 対 user のエントリ受け渡し**とは別物である。
  🔑 **D-1 の実体は、アーカイブの import / export**(P6c / P6f)のほうである ──
  「1 個のファイルを渡して、相手が読み込む」がそれに当たる。
  ⚠ 可搬単一 HTML(#400)も同じ系列にある
- [`docs/vision/webrtc-p2p-collaboration.md`](https://github.com/sm06224/PKC2/blob/main/docs/vision/webrtc-p2p-collaboration.md)
  ── **D-3**
- [`docs/vision/pkc-application-scope-vision.md`](https://github.com/sm06224/PKC2/blob/main/docs/vision/pkc-application-scope-vision.md)
  ── scope の定義。⚠ §4 が「**不変**」と宣言した 4 原則のうち **3 つ**
  (single HTML product / container is source of truth / backward compatibility)は
  **PKC3 が意図的に変えたもの**である。§7 のリスク「scope 拡大が single HTML の限界を
  超える可能性」は的中した

**② 動線の正本 ── user への約束**

- [`docs/manual/`](https://github.com/sm06224/PKC2/tree/main/docs/manual) 全 15 章
  ── とくに `03_画面とビュー.md` / `05_日常操作.md`(1118 行)/
  `06_キーボードショートカット.md` / `10_filer_と_graph_と_inventory.md` /
  `13_アプリランチャーと出力機能.md`
- `src/adapter/ui/action-binder.ts`(11,939 行・`case` 245 個)──
  **押した物と起きることの一覧**。動線を数えるならここ

**③ 多窓の実装と、その診断**

- `src/adapter/ui/entry-window.ts` ── `openEntryWindow` / 親子の postMessage 13 種
- `docs/development/vscode-grade-overhaul-2026-05/MASTER.md` §1.1 / §5.1
  ── ⚠ **5 面が同じ markdown を別経路で描いてずれる**という自己診断。
  PKC3 が `index.html` を開く方式を採ったことで**構造的に回避されている**

⚠ **これらを「移植すべき機能の一覧」として読まないこと。** 読み方は
CLAUDE.md「PKC2 は『機能の袋』ではない。動線で読む」(user 指示 2026-08-22)に従う ──
**①その動線が user に届いていたか ②実装形は再現しない**、の 2 段で判定する。

### 段 2 の着地前レビューで固めたこと(#2000)

- **差分は他の端末が作った入力として疑う**: system 領域の lid(`sys-` で始まる物)・`structural` と知らない種類のつながりは、読む側(`readDiffZip`。数は結果に出す)と
  書く側(worker の `applySync`。`realm` が system の行に当たれば tx ごと断る)の両方で除く。親子は各ノートの親フォルダの道(輪・1 親の門)だけが張る(`sync-guard.ts`)。
- **端末 id の重複**: 自分の id の差分でも、元のワークスペースがいまと違えば断る。同じワークスペースで連番が記録に無いときだけ、専用の確認(「この端末が書き出した物に見える・ID を作り直し記録が最初からになる」)を取ってから作り直す。
- **取り消し**: 控えは本文を持たず、履歴の版の id と取り込み直後の指紋(題名・移動・種別も含む)を持つ。指紋が違えば触らない。連番は戻さない(`out:<連番>` の再利用を防ぐ)。
- **計画と反映の間の編集**: 計画時のこちらの指紋を持たせ、worker の tx が測り直す。違えば書かず、相手の版を競合のコピーとして足す(ゴミ箱へ移す判定は移さない)。
- **本文の指紋は worker で測る**(`syncMeasureNotes`)。主スレッドで本文の SHA-256 をしない。削除の記録は 1 回のまとめ書き(端末 id・連番・整理は 1 tx に 1 度)。
- **worker の門**: 設定が切のとき `syncApply` / `syncSnapshot` / `syncCommitExport` / `syncSeed` / `syncMeasureNotes` は断る。入 / 切の通知の失敗はメッセージへ積み、次の操作でやり直す。
- **添付**: 反映のあとに書き、目録の hash と内容が合わない物は置かずに一覧で言う。
- **戻せる**: 設定の「同期の記録を消す」(`syncForget`。端末 id・連番・全ワークスペースの対応・記録・削除の記録。ノートは触らない)。オフにするときにも聞く。
  競合は専用の一覧を持たず、題名に「同期の競合」を付けた別のノートとして残る(取り込み結果のボタンが検索で一覧する)。
