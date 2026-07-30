# PKC3 メジャーバージョンアップ設計 ── 継承・刷新・是正(2026-07)

> **Status**: 設計 doc(**P0 = 本 doc の裁定。裁定前に実装しない**)
> **本 doc は PKC3 の founding doc**。PKC2 リポジトリは参照のみ(read-only)で、
> PKC3 の開発はすべて本リポジトリで行う。
> **調査根拠**: 2026-07-30 に PKC2 を 4 方面(storage / 交換形式 / PKC-Markdown・基本機能 /
> 依存・CI)から実地調査した結果に基づく。evidence の file:line は
> [`sm06224/PKC2`](https://github.com/sm06224/PKC2) の現 HEAD(2026-07-30 時点)を指す。

## 0. user 指示(2026-07-30。本 doc の与件・不可侵)

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

加えて、storage の方向 ①〜⑤(user 指示 2026-07-27。不可侵、CLAUDE.md 記載)を全部引き継ぐ:
ゼロコピーと速やかな破棄 / 依存削減 ≠ 依存全廃(静的ビルドなら問題ない)/ 小さかろうが積む /
JSON をそのままコンテナにしない(内部表現の話。交換形式の JSON は残る)/ boot 窓だけで測らない。

## 1. PKC3 の位置づけと戦略

| 論点 | 判断 | 理由 |
|---|---|---|
| リポジトリ | 新規 `sm06224/PKC3`。PKC2 は現行のまま残す | **in-place 移行を捨てる**のが最大の設計利得。旧ビルド互換(Invariant 5「互換は双方向」)は「PKC2 が PKC2 のデータを読み続ける」ことで構造的に満たされ、S1〜S4 型の移行事故クラス(移行専用書込経路の穴)が発生しえない |
| データ移行経路 | **交換形式のみ**(PKC2 export → PKC3 import) | 必然でもある: Pages 配信の PKC3 は origin が異なり、PKC2 の IndexedDB は原理的に直接読めない。互換の主戦場を交換形式に固定する(wasm-sqlite 設計 doc §6 の裁定を継承) |
| コード戦略 | PKC2 スナップショットを出発点に、**背骨(storage / persistence / メモリ像)を差し替える外科手術**。from-scratch 書き直しはしない | src ≈ 13.5 万行 + test 10,973 件は資産。ContainerStore / StorageAdapter / pkc-data-source という seam が既にあり、手術面が明確 |
| v3.0.0 スコープ | **機能同等(feature parity)+ storage 刷新 + §4 の是正。新機能ゼロ** | 「フューチャー機能を盛り込みすぎない」(user 指示 2026-07-30)。PKC2 のプライム・ディレクティブ(機能を足さない)は PKC3 v3.0 スコープにもそのまま効く |

## 2. 継承するもの(発想はそのまま)

| 資産 | PKC2 実体 | PKC3 での扱い |
|---|---|---|
| **可搬式埋め込み形式** | 単一 HTML の `<script id="pkc-data" type="application/json">` に `{container, export_meta?}`。SLOT 契約 6 要素(pkc-root/data/meta/core/styles/theme、`src/runtime/contract.ts:5-12`)。pkc-data boot = **view-only**(開いただけで受信側 IDB を汚さない、明示 Import / Rehydrate で昇格) | **発想ごと維持**。SLOT 契約・view-only 不変条件・system entries merge(ビルド正本の About/Settings 反映)をそのまま持ち込む |
| **交換形式** | export HTML(full/light × editable/readonly)/ ZIP `pkc2-package` v1(manifest + container.json + assets/*.bin、stored mode 自前実装)/ バンドル 5 系統(text / textlog / entry / mixed / folder-export) | **読み書き両対応で互換維持**(§8 に契約表)。 |
| **PKC-Markdown** | markdown-it v14 + 独自 inline 8 種 + block 方言 + fence 規約 + リンク scheme(entry:/pkc://asset:)。実体は「preprocessor(PUA sentinel + lineMap)→ markdown-it → postprocessor」のパイプライン全体(`src/features/markdown/markdown-render.ts` 4,191 行)。方言は表示経路と AST export 経路(docx/pptx)に**二重実装** | **パイプライン丸ごと移植**(パーサだけ差し替えると sentinel / lineMap / source-line anchor 契約が壊れる)。二重実装も現状のまま持ち込み、IR 統一(`markdown.use_ir` scaffolding)は凍結継続 |
| **基本機能** | archetype **12 種**(CLAUDE.md 記載の 8 + spreadsheet + system-* 3。`src/core/model/record.ts:7-31`)+ presenter 6 登録 + text fallback / view 5 種(detail/calendar/kanban/filer/launcher)/ relations / revisions / workspace | 全部維持。**spreadsheet を漏らさない**(CLAUDE.md の 8 種表記は実態と乖離) |
| **大物機能** | mermaid / chart.js / docx / pptxgenjs / Office export(2026-07-01 user 裁定: keep・強化対象) | keep 裁定を継承 |
| **transport** | PKC-Message v1(envelope 10 種)/ v2(JSON-RPC 2.0)/ pkc-ext §3.8 wire(host-push、pull 経路なし、Tier S 封じ込め)。**fail-closed 既定**(空 allowlist = 全 deny、origin ピン留め、flood guard) | wire 契約・セキュリティ既定ごと維持。既存拡張 HTML がそのまま動くこと |
| **アーキテクチャ規約** | 5-layer(core ← features ← adapter)/ `data-pkc-*` セレクタ / pure reducer + Renderer/ActionBinder/Presenter 分離 | 維持(§3.5 のメモリ像変更に合わせて reducer の持つ集約が「リーン」になる) |
| **計測資産と規律** | `tests/bench/` 14 本 + `storage-arch-bench`(A〜E 構成・io・syscall・sink)+ perf-measurement skill の規律(対照群 / persistent profile / fixture のゼロ次元 / boot 窓で定常を語らない) | **P2 で最初に移植**。PKC3 の全段階の DoD は計測で書く |
| **provenance** | pkc-meta(app/version/schema/kind(dev/stage/product)/timestamp/source_commit/code_integrity SHA-256) | 維持。Pages の dev 版 / product 版の区別にそのまま使う(§7) |
| **巨大 export の実戦傷 3 点** | #960 parts 分割(V8 文字列長上限)/ #962 64MB Blob 畳み(peak 非比例)/ #966 8MB 超で全体無圧縮 | 実装は変わっても**性質を要件として継承**: 「単一巨大文字列を作らない・総量比例のヒープを持たない」 |
| **backup ゲートの流儀** | pre-migration-backup(バックアップ ZIP を書けたことを確認するまで移行しない) | PKC3 では import / 破壊的操作の安全網として流儀を継承 |

## 3. 刷新 ①: storage(最重点)

`storage-wasm-sqlite-design-2026-07.md`(裁定済みの方向)を PKC3 の文脈で再定義する。
**PKC2 との決定的な違い: 移行コードが 1 行も要らない。** PKC3 には旧データが存在しないので、
「最初から sqlite が正本」で始められる(PKC2 案の P5 移行ゲートが丸ごと消える)。

### 3.1 確定している実測(PKC2 の失敗の形 = PKC3 の受け入れ基準)

| PKC2 実測(500MB fixture、PR #1040) | 根本原因 | PKC3 での姿 |
|---|---|---|
| 毎起動 ~85MB の JSON を丸ごと parse | container = 単一 JSON record | `SELECT`(body 列を読まない)── boot は O(メタ) |
| revisions 80MB が JS heap に永続常駐 | 同上 | COUNT + 要求時 1 行読み |
| 初回索引構築で RSS 1.5〜1.6GB(OOM) | asset = base64 文字列 | bytes は Blob record(heap ±0) |
| 定常 RSS 1.0GB | 上記の合成 | 常駐は「リーン集約」のみ(§3.5) |
| 1 編集で container 全量書き(#1021/#1024 で対症済) | 同上 | 行単位 UPDATE ── 構造的に消滅 |

### 3.2 構成: ハイブリッド(ゼロコピー 2 原則に従属)

| データ | 置き場 | 実測根拠 |
|---|---|---|
| entries(meta + body)/ revisions / relations / workspace / settings / flags | **wasm-sqlite**(official `@sqlite.org/sqlite-wasm`、OPFS SAHPool VFS) | 実ディスクで投入 2,295ms / cold 22ms / 追記 200ms(300MB、redesign doc §A.1 D 腕)── 実用水準 |
| asset の bytes | **Blob storage**(IDB Blob record。`saveAssetBlob` seam の型を継承) | BLOB を WASM に入れると読み ~9 倍 + リニアメモリ常駐 +246MB 級。IDB Blob は heap ±0・読み 0.8ms・syscall 最少(§A.1/A.2/A.9) |

メモリ 2 原則(wasm-sqlite doc §2)を全判断の上位に置く: **bytes は必要な瞬間だけ・必要な範囲だけ /
生成物はライフサイクル終端で即破棄**(stmt finalize 徹底・WASM バッファ copy-out 後即解放・
ObjectURL は所有者が revoke)。

### 3.3 スキーマ v1

wasm-sqlite 設計 doc §3 の DDL を継承し、user 指示(flags と設定の分離)を反映して 1 点変更する:
`kv` 1 表に混ぜず **`settings`(正規設定)と `flags`(実験)を別表にする**(§5)。
assets 表は bytes を持たない(meta + Blob storage へのポインタ行のみ)。

### 3.4 実行形態: storage worker

OPFS SAHPool(`createSyncAccessHandle`)は Worker 必須。したがって **sqlite は専用 Worker 内で
動き、メインスレッドは query/command の message API を叩く**。副産物として保存・読み込みの
CPU コスト(直列化・圧縮)がメインスレッドから構造的に出ていく(PKC2 で「体感の主因は描画」
だったことと合わせ、main thread は描画に専念できる)。

### 3.5 メモリ像: リーン集約(app 層への波及の本丸)

reducer / Renderer の**発想は維持**する。変わるのは reducer が持つ集約の中身:

- **常駐**: entries の **meta のみ**(lid/title/archetype/dates/order)+ relations + counters。
  15,000 entries でも数 MB
- **需要駆動**: body(選択・編集・検索時に store へ query)/ revisions(viewer を開いた時だけ)/
  asset bytes(ObjectURL 経由、表示中のみ)
- PKC2 の `lazy_entry_bodies` が退役に終わったのは「単一 JSON 前提の上に後付け」だったから
  (未読 body の穴 = S3)。PKC3 は**需要駆動が正規形**なので、「hydrate 済みか」という
  中間状態そのものが型から消える(body を持つのは editor / presenter のローカルスコープだけ)

ここが P3(app 層接続)の実工数の大半になる。renderer / search / export の同期的
`container.entries[].body` 参照を、非同期 query に置き換える境界設計が必要。

### 3.6 書込増幅と syscall(A.7 / A.9 の宿題を持ち込む)

- 「**ディスク I/O に負荷をかけたくない。ゆるいストリーミング圧縮とチャンクパックは
  スケールのために必須**」(user 指示、redesign doc §A.7。撤回されていない)── sqlite でこの軸を
  満たす手段(journal_mode / WAL / synchronous / page_size)は **io-bench の型で実測してから決める**
  (P2 DoD)。per-record IDB が LevelDB の WAL+SST で実書込 ~70% 増幅した轍を、SQLite の
  journal で再演しないこと
- §A.9 の D 腕は **syscall chatter が全フェーズで桁違い**(読み 5,783 vs E 97)だった。ただし
  あの計測は 300MB の media BLOB を sqlite に入れた workload であり、PKC3 のハイブリッド
  (sqlite は MB 級の構造データのみ)には直接適用できない。**PKC3 の実 workload で
  run-syscall-profile を再計測する**(P2 DoD。憶測で「解決した」と言わない)

### 3.7 revisions: zstd グループ圧縮

587 倍(zstd3)は snapshot 群の**一括**圧縮の数字で、行単独圧縮では取れない(§A.3)。
→ app 層 codec で **segment BLOB(snapshot 群をグループ化)にしてから sqlite に格納**。
PKC2 segments 実装(~1MB パック + CompressionStream)の設計を zstd で置き換えて継承する。
zstd ライブラリの選定(`@bokuweb/zstd-wasm` 系 / 将来のフレーバー SQLite = sqlite-zstd 静的リンク)
は P5 で実測して決める。フレーバー SQLite(sqlite-vec / FTS5 焼き込み)は**設計済み拡張点のまま凍結**
(採用トリガは性能でなく機能。§A.5 の裁定を継承)。

### 3.8 並行性・耐久性(redesign doc §A.8 の設計判断を継承)

- **多重タブ**: SAHPool は実質単一接続。**Web Locks API の writer リース**(アクティブタブが
  書込権、他タブは読取 + BroadcastChannel 追従)を最初から入れる
- **durability**: 通常 relaxed 相当 + 要所(import 完了・明示保存)のみ厳格化の二段構え
- **eviction 保護**: `navigator.storage.persist()` 要求

### 3.9 環境戦略

第一候補 = OPFS SAHPool(**crossOriginIsolated 不要の非 Atomics 構成**。GitHub Pages は
COOP/COEP ヘッダを制御できず、単一 HTML も同様なので、これは選択でなく必須条件)。
P2 の最初に実機確認し、OPFS 不可環境(古いブラウザ / 私的モード)は IDB 上の VFS へ fallback。
成立しなければ IDB-VFS が主経路になる(wasm-sqlite doc §8-1 の未確定を P2 冒頭で潰す)。

## 4. 是正: 「作り込みすぎてかえって悪かった部分」を持ち込まない

すべて「JSON 内部表現 + base64 文字列」という土台の上に積まれた**補償機構**であり、
土台を変える PKC3 では**構造ごと不要になる**。個別の延命をしない(user 指示 2026-07-30)。

| 補償機構(PKC2 実体) | 何の緩和だったか | PKC3 |
|---|---|---|
| layout marker 3 種(`__pkc_split__` / `__pkc_layout__` 2〜5 / `__pkc_bodyseg__`)+ サイドカー 5 種(`__entry__:` / `__rev__:` / `__body__:` / `__rel__:` / `__order__:`)+「サイドカーがあれば正本、無ければ inline」の合流読み(`idb-store.ts:274-348`) | 単一 JSON record の部分読み・部分書きの欠如 | **持ち込まない**。sqlite の行と index が正規形。#1022(合流読みが旧ビルドで静かに欠損)の事故クラスも同時に消える |
| segments バケット(~1MB gzip パック、追記規約、compaction) | 同上(書込増幅の緩和) | 実装は持ち込まない。**設計だけ** §3.7 の zstd グループ圧縮として継承 |
| asset working-set(48MB budget、`asset-working-set.ts:47`)+ 4MB 描画閾値 / 8MB export 無圧縮閾値(#964/#966 止血) | base64 文字列が heap を通ること | **概念ごと消滅**(Blob + ObjectURL でサイズ非依存)。ただし 8MB 無圧縮は **PKC2 互換 export の出力契約としてのみ**残す(§8.2) |
| 形式切替 flag の系譜(`differential_save` / `lazy_entry_bodies`、いずれも retired。退役に 4 経路合成 + pin test が要った) | 形式が複数あること自体 | **形式は 1 つ**。切替 flag を作らない(「形式 flag は戻し道とセットでしか作れない」を PKC3 の規律として明文化) |
| storage backend の user 選択 4 種(idb / opfs / fsa / memory、`storage-backend.ts:32-45`) | 単一 record 形式の性能問題からの逃げ道 | **sqlite 一本 + Blob storage**。memory は test 専用に残す。FSA folder sink(フォルダ同期バックアップ)だけは用途が別(可搬バックアップ)── 残すか裁定(§10-4) |
| flags 85 個(実測。`defineFlag` 走査 2026-07-30) | 「設定」「出荷済み機能の toggle」「実験」の未分離 | §5 で分離・予算化 |
| doc/コメントと実態の乖離(CLAUDE.md「OPFS は seam 予約のみ」実は実装済 / ci.yml の stale コメント 2 箇所 / 8 archetype 表記) | ── | PKC3 の founding doc は本 doc と実地調査を正とし、**乖離を移植しない** |

**スコープ外の是正(裁定事項)**: `renderer.ts` 12,523 行 / `action-binder.ts` 11,939 行の
単一 file 肥大は「悪い部分」ではあるが、storage 手術と独立の純リファクタは v3.0 スコープに
**入れない**ことを推奨(手術と同時にやると事故率が上がる。§10-6)。

## 5. flags と正規設定の分離(user 指示 2026-07-30)

**実態**: PKC2 の flag は 85 個。内訳はおよそ ── (a) **実質「設定」**(theme.* / filer.thumb.* /
caret_indicator.* / tag.* / guardrail 閾値 / debounce 等の tuning knob)が ~35、(b) **出荷済み
機能の toggle**(shell.* 30 個、text.* 5 個など、畳まれなかった feature flag)が ~45、
(c) 実験・scaffolding(markdown.use_ir、retired 2 種)が ~5。

**PKC3 モデル**:

| | 正規設定(settings) | flags |
|---|---|---|
| 目的 | user の恒久的な好み・調整 | 実験・段階導入・障害時の緊急脱出弁 |
| 置き場 | sqlite `settings` 表 + 設定 UI(system-settings 継承) | sqlite `flags` 表 + URL/`?pkc-debug` 導線 |
| 寿命 | 無期限 | **各 flag に「畳む条件」の宣言必須**(既定化 or 削除の期日・条件をメタとして持つ) |
| 予算 | なし | **最大 15 個。CI test で pin**(`getRegisteredFlags().length <= 15` を assert し、超えたら CI が落ちる) |

**移行方針**: (a) は settings へ / (b) は既定 ON で焼き込み、toggle 自体を削除(裁定で「OFF に
したい」ものだけ settings へ)/ (c) 実験中のみ flag 枠を使う。v3.0 出荷時点の flag は
storage fallback 系など**数個**に収まる見込み(15 は上限であって目標ではない)。

## 6. 依存方針の転換(受容モード)

**PKC2 の実態**: prod 依存 6 個のみ(chart.js / docx / markdown-it / markdown-it-footnote /
mermaid / pptxgenjs)。更新は self-hosted Renovate「主権モード」= 全 update が dashboard
approval 必須 + 7 日 cooldown、Dependabot は 2026-05-17 に撤退済み。SBOM なし。

**PKC3 の方針**(user 指示: 依存は性能のために致し方なし、SBOM + GitHub の依存 PR で定期更新):

| 項目 | 提案 |
|---|---|
| 依存更新 | **Dependabot version updates**(GitHub ネイティブの「依存 PR」)週次、npm + github-actions の 2 ecosystem、minor/patch はグループ化。security updates は即時。CI 全 green の minor/patch は auto-merge、major は手動 review(裁定 §10-2。Renovate 主権モードの緩和でも同じ運用は組めるが、GITHUB_TOKEN では CI が auto-trigger されない既知制約があり、能動運用には Dependabot が素直) |
| SBOM | **CycloneDX** を release workflow で生成(npm 内蔵 `npm sbom` か `@cyclonedx/cyclonedx-npm`)し **GitHub Release に添付**。dependency graph / Dependabot alerts は常時 ON |
| 新規依存(性能のため) | `@sqlite.org/sqlite-wasm`(official ビルド。storage-arch-bench D 腕で検証済みの構成)/ zstd-wasm 系(P5 で実測選定)。既存 prod 6 依存は継承 |
| 衛生 | `engines` + `.nvmrc`(Node 24)を**宣言する**(PKC2 は CI の '24' だけが正で未宣言)/ `.npmrc` に `ignore-scripts=true`(postinstall 面の封鎖)/ `npm audit --audit-level=high` blocking gate 継承 |
| tripwire | size budget は**手違い検出**として継承(撤廃しない・報告は残量で書く、の運用ごと)。Pages 配信で code splitting する場合は初期チャンク budget に読み替える |

⚠ 引き継ぐ地雷のメモ: happy-dom 経由の `ws` ≤8.20.1 HIGH は dev 側限定で、`ws` を上げると
happy-dom の WebSocket 解決が壊れる既知問題(PKC2 `ci.yml:93-97`)。PKC3 でも audit gate は
`--omit=dev` で開始する。

## 7. GitHub Pages デプロイ(dev 版とプロダクト版)

**前提制約**: Pages はカスタムヘッダ不可 → COOP/COEP なし → crossOriginIsolated 不成立 →
SharedArrayBuffer 不可。**§3.9 の非 Atomics SAHPool 構成はここでも必須**(単一 HTML と同じ
制約なので、storage 設計は配信形態に依らず一本で済む)。

**サイト構成案**(単一 Pages site、Actions deploy):

```
https://sm06224.github.io/PKC3/        ← プロダクト版(最新 release tag、kind: product)
https://sm06224.github.io/PKC3/dev/    ← dev 版(main HEAD、kind: dev)
```

- workflow: push(main)と release(publish)で起動。dev 版は main HEAD をビルド、
  プロダクト版は最新 release tag をビルドし、1 つの Pages artifact に合成して
  `actions/deploy-pages` でデプロイ。kind / timestamp / code_integrity の刻印(pkc-meta 流儀)で
  どちらの版かを機械判別できる
- PKC2 の smoke 運用で確立した「**CI artifact に private data を載せない**」(2026-05-05
  user direction)を Pages workflow にも適用(デプロイ対象はビルド生成物のみ)
- PKC2 の公開導線(PKC-Public の安定版 / DEV / マニュアル 3 URL、renderer.ts にハードコード)は
  PKC2 のまま触らない。PKC2 側の告知面に PKC3 リンクを足すかは着地後に裁定

**配信形態(裁定 §10-1)**:

| | 案 A: マルチファイル静的ビルド(推奨) | 案 B: 単一 HTML を配信(PKC2 同形) |
|---|---|---|
| sqlite3.wasm | 別ファイル → `instantiateStreaming`(base64 デコードも一括 heap 載せも無し ── メモリ 2 原則に合致) | base64 焼き込み(+~1.2MB、起動時に全量デコード) |
| code splitting | 可(mermaid ~3MB を遅延チャンク化 ── PKC2 は inlineDynamicImports で「lazy import してもサイズは同梱」だった) | 不可(単一 IIFE) |
| 実装 | Pages 用と可搬 HTML 用の 2 ビルドプロファイル | 1 プロファイル(PKC2 pipeline 流用) |

**どちらの案でも「可搬式単一 HTML」は export 機能として維持する**(発想はそのまま)。
export された HTML は wasm を内蔵し、file:// で自立動作する ── これが PKC2 の成果の核であり、
配信形態の選択とは独立に守る。

## 8. 交換形式の互換契約(import / export)

### 8.1 PKC3 が読むもの(受理層)

| 形式 | 契約(PKC2 実装の罠込みで要件化) |
|---|---|
| PKC2 export HTML | `app:'pkc2'` + `schema:1` を**明示受理**して昇格 import(PKC2 の importer は厳密一致 reject なので、PKC3 側に受理層がないと移行経路が存在しない)。**shell 2 変種**(平文 pkc-core / gzip+loader)両対応。`<\/script>` エスケープ復元。`export_meta.asset_encoding` は artifact 全体で 1 つ(gzip+base64 / base64) |
| PKC2 ZIP(pkc2-package v1) | stored mode(method 0)を必ず受理。container_id 新規採番(PKC2 の意味論を維持) |
| バンドル 5 系統(.text.zip / .textlog.zip / entry / .mixed.zip / .folder-export.zip v1|2) | additive・failure-atomic の意味論ごと受理 |

### 8.2 PKC3 が書くもの

- **PKC3 形式 export**(`app:'pkc3'`, schema v1 から開始): 既定。HTML(可搬式)/ ZIP
- **PKC2 互換 export**(明示メニュー): `app:'pkc2'` / `schema:1` に**降格して書く**。stored-mode
  ZIP・`<\/script>` エスケープ・asset_encoding 単一・8MB 超で全体無圧縮、という**旧 reader の
  読める形**を厳守。これが PKC3 における「互換は双方向」の形 ── **user はいつでも PKC2 に
  戻れる**(旧 pkc2.html を手元に残す運用の継承)
- sqlite ファイル(.sqlite3)そのままの持ち出しは拡張点として予約(裁定 §10-5)

### 8.3 判定法と pin

各形式の DoD に「**この変更を知らない読み手(旧 pkc2.html)がこのファイルを読んだら何が
見えるか**」を書き出す(Invariant 5 の判定法を継承)。PKC2 互換 export は
**旧ビルドの読み方を再現して assert する pin test**(`differential-save-retirement.test.ts` の型)を
最低 1 件持つ。

## 9. 段階計画(小さく積む ── 各段階が単独で着地し、単独で計測できる)

| 段階 | 内容 | DoD(計測・test) |
|---|---|---|
| **P0** | 本 doc の裁定 | ── |
| **P1** | repo bootstrap: PKC2 スナップショット移植 + toolchain(vite 8 / TS 6 / vitest 4 / Node 24 宣言付き)+ CI(PKC2 ci.yml から stale を除去した版)+ Dependabot + SBOM + Pages workflow | dev 版 URL で現行機能が動く(storage はまだ PKC2 形式のまま)。CI 全 green。SBOM が Release に付く |
| **P2** | 計測ハーネス移植(boot-rss / storage-write-io / edit-main-thread-block / storage-arch-bench + **継続使用の編集セッション腕**)+ sqlite core(worker + SAHPool 実機確認が最初 / schema v1 / store API) | 非 Atomics SAHPool の成立可否が確定。PKC2 500MB fixture のベースライン(RSS 1.5〜1.6GB / 定常 1.0GB / boot 936ms 等)を PKC3 計器で再現取得 |
| **P3** | **リーン集約への app 層接続**(meta 常駐 / body 需要駆動 / 検索・export の query 化)| boot O(メタ) を実測で確認。**編集セッション N 分の RSS 時系列**が PKC2 比で下がる(boot 窓だけで語らない ── user 指示⑤) |
| **P4** | assets: sqlite meta 行 + Blob storage(ObjectURL 描画、revoke 規律) | 500MB fixture で asset 起因の RSS 山が消える。#964/#966 型の閾値が存在しないこと |
| **P5** | revisions: COUNT / 要求時読み + zstd グループ圧縮(ライブラリ実測選定込み) | revisions 常駐 0。ディスク列が圧縮されている(587x は fixture 依存なので実データ系で再測) |
| **P6** | 交換形式: §8.1 受理層 + §8.2 PKC2 互換 export + pin test | PKC2 実 export 資産(HTML 2 変種 / ZIP / バンドル 5 系統)の roundtrip が通る。旧 pkc2.html が PKC2 互換 export を読める(pin) |
| **P7** | v3.0.0: Pages プロダクト版 + マニュアル + 移行ガイド(PKC2 → export → PKC3 import の導線) | product URL 稼働。release に SBOM / provenance |

P1〜P2 は並行可。P3 が最大工数(§3.5)。**「効果が小さい」は棄却理由にしない**
(積み上げ先 = 本 doc。user 指示③)。

## 10. 裁定をもらいたい点

1. **Pages 配信形態**: 案 A(マルチファイル、推奨)か案 B(単一 HTML 配信)か(§7)
2. **依存更新の運用**: Dependabot へ乗り換え(提案)か、Renovate 主権モードの緩和か。
   minor/patch の auto-merge を許すか(§6)
3. **PKC2 リポジトリの扱い**: 保守モード(bug fix のみ受け付け)を推奨。凍結(アーカイブ)まで
   進めるかは PKC3 着地後に再裁定でよいか
4. **FSA folder sink**(フォルダ同期バックアップ)を PKC3 に持ち込むか(§4。可搬バックアップと
   しての用途は残るが、storage backend 一本化の例外になる)
5. **sqlite ファイル export** を製品機能にするか、拡張点の予約に留めるか(§8.2)
6. **純リファクタ(renderer / action-binder の分割)を v3.0 スコープに入れない**、で良いか(§4)
7. **flags 15 個の運用ルール**(§5 の表: 畳む条件の宣言必須 + CI pin)で良いか
8. **PKC3 の識別子**: `app:'pkc3'` / schema v1 / DB 名・localStorage prefix `pkc3.` / 生成物
   `pkc3.html` で良いか

## 11. 参照(すべて PKC2 リポジトリ側。read-only)

- [`storage-wasm-sqlite-design-2026-07.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/storage-wasm-sqlite-design-2026-07.md) ── storage 方向の正本(user 指示 2026-07-27)。
  本 doc §3 はこれの PKC3 文脈への再定義
- [`storage-v3-redesign-2026-07.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/storage-v3-redesign-2026-07.md) ── 実測の全記録(§A.1 アーキ 5 構成 / §A.3 zstd /
  §A.5 フレーバー SQLite / §A.7 書込増幅 / §A.8 並行性 / §A.9 syscall)
- [`storage-default-layout-decision-2026-07-26.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/storage-default-layout-decision-2026-07-26.md) ── 棄却済みの案(再提案しない)
- [`session-handoff-2026-07-26.md`](https://github.com/sm06224/PKC2/blob/main/docs/development/session-handoff-2026-07-26.md) ── 直近の着地と教訓
- [`docs/spec/schema-migration-policy.md`](https://github.com/sm06224/PKC2/blob/main/docs/spec/schema-migration-policy.md) ── schema 単調・明示 reject の規約(§8 の下敷き)
- [`docs/spec/pkc-message-api-v2.md`](https://github.com/sm06224/PKC2/blob/main/docs/spec/pkc-message-api-v2.md) ── transport の正本(§2 継承)
- [PKC2 CLAUDE.md](https://github.com/sm06224/PKC2/blob/main/CLAUDE.md) Invariant 5 ──「互換は双方向」の判定法(§8.3 に継承)
