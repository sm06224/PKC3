# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository (PKC3).

## 0. このファイルの原則（肥大化・サボタージュ防止）

- **このファイルは 300 行未満に保つ**。日付つきの反省文・失敗物語（「1 巡目は… 2 巡目は…」）を追記してはならない。
- **手順は `.claude/skills/*/SKILL.md`、層別の検査・実装ルールは `.claude/rules/*.md`** に置く。
- **戒めを「実装しない理由」「質問へ逃げる理由」「項目を勝手に落とす理由」に曲解することを厳禁とする**（§3「自走と完遂の規律」を最優先で守ること）。

## 1. Language & UI Terminology Policy

- Internal reasoning MUST be in American English.
- Final output MUST be in Japanese.

### 🔴 user に見える字は標準の日本語 IT 用語で書く（造語・直訳の禁止）

- **画面の文字列・マニュアル・お知らせ・Office の窓・README・Issue のコメントや設問**には、英語を 1 対 1 で和語に写した造語（近道キー / 鍵 / 面 / 口 / 器 / 印 / 帯 / 一式 / 焼く / 栞 / 留める / 写し / 窓 / 雛形 / 検める 等）を一切出さない。
- 正本は `src/features/ui-terms.ts`（`STANDARD_TERMS` = 使う語、`BANNED_TERMS` = 使わない語と言い換え）と `docs/manual.md`「言葉の意味」。`tests/features/ui-terms.test.ts` の `KNOWN_BANNED` は **0 件**を保つ。
- **標準の日本語 IT 用語を使う**（カタカナ語でよい）: ショートカットキー / ウィンドウ / 別ウィンドウ / 画面 / ペイン / ボタン / バー / タブ / メニュー / テンプレート / バックアップ / スタック / ブックマーク / ビルド / バージョン / コピー / 一覧 / 確認。

## 2. 方針・アーキテクチャの不変量（founding / 不可侵）

> **北極星: 速く、安く、必要十分、利便性最大。「最強のノートアプリにするんだー」**
> 正本 doc: `docs/development/pkc3-major-upgrade-design-2026-07.md`

1. **PKC2 (`sm06224/PKC2`) は read-only 参照のみ**: 手を出さない。丸写し禁止（古い設計・積み上げで遅くなる実装を持ち込まない）。PKC2 は機能の袋ではなく**動線**で読む（①入口は多く判定は 1 か所 ②作業が画面をまたいで続く ③開かずに追記・差し挟みで済ませる道がある）。
2. **層とデータ形式**: `core ← features ← adapter`（`core` に browser API を入れない）。**全 body = PKC-Markdown、アーキタイプ = フレーバー**（`FlavorSpec`）。JSON 文字列 body を作らない。
3. **PKC を「型システム」として体系立てて整理する**:
   - 領域（`user` | `system`）× 型の体系で画面・ファイル・操作を導く。
   - システム用ノート（メッセージ集積地）は user の一覧・フォルダ・検索に混ざらない `system` 領域に置く。
   - ステータスバーを一時メッセージの置き場にしない（メッセージ・エラーはシステムのメッセージ集積地へ保管し、ステータスバーは現在の状態表示に使う）。
   - バックアップは二重拡張子（`*.pkc3-full.zip` / `*.pkc3-part.zip` / `*.pkc3-notes.zip`）で中身の型を明示し、取り込み側は旧 `.pkc3.zip` を含めすべて受ける。
4. **Storage とメモリ管理**:
   - wasm-sqlite（OPFS SAHPool・専用常駐 worker）+ IDB Blob のハイブリッド。
   - **ゼロコピー・生成物のライフサイクル終端での即破棄**（`URL.revokeObjectURL` 等）。
5. **重い処理はワーカーへ・ワーカーは使い捨てにする**:
   - 計算ワーカー（描画・圧縮・符号化・DuckDB 等）は **①遅延起動 ②起動待ちジョブのバッファ ③アイドル時（または設定時間経過時）の terminate とメモリ解放** を備える（機構: `src/adapter/platform/worker-lease.ts`）。
   - 飛んでいるジョブがある間は kill しない。terminate 時は待ちジョブを必ず reject する。sqlite storage worker は DB lease を握るため常駐（対象外）。
6. **図は「描いたら焼く」**:
   - 画面に置くのは **SVG ではなく PNG ラスタの `<img>` 1 枚**（GPU 合成に乗せる）。SVG（ベクタ）は書き出し時のみ。
   - キャッシュ鍵には **原文 + テーマ + 幅 + devicePixelRatio** を含め、bytes は IDB Blob に置き、ObjectURL は表示終端で revoke する。
7. **配る量は気にしない。効くのは定常**:
   - **「配布サイズが増えるから入れない」を判断理由にしてはならない**。効くのは継続使用時の常駐メモリと操作の応答時間。
   - size cap（`scripts/check-dist.mjs`）は重い依存の誤取込や生成物取り違えを検出する tripwire であり、通常の機能追加で触れたら引き上げてよい（撤廃はしない）。
8. **フラグ予算**:
   - **flags は最大 15 個**（`tests/flag-budget.test.ts` で pin）+ 各 flag に畳む条件（`foldWhen`）の宣言必須。正規設定（`settings`）と分離する。
   - **URL クエリパラメータの切替はフラグ扱い**（15 枠に数え、フラグ画面からパラメータ付き再起動させる）。パーマリンク / ディープリンク以外にクエリパラメータを抜け穴として使わない（`tests/features/flags.test.ts`）。
9. **記法と動線**:
   - **記法 1 つは user の動線 1 つ**。こちら側の都合（段数・維持コスト）で記法を減らさない。ただしバグや誤った挙動の修正は躊躇なく行う。
   - **片道の操作を作らない**（画面から置けるなら画面から外せるようにする。双方向が既定）。
10. **目指す姿は「業務画面」**:
    - 高密度だが詰まっていない / 同じものが常に同じ場所にある（モードで配置が変わらない）/ 1 画面で完結する / マウスだけで完結しキーボードはショートカット / 地は無彩色、色は情報にだけ使う。
    - **補助的な物が主の作業領域（中央ペインの本文）を奪わない**。予定表・連絡先などの組み込みアプリの基本は**別ウィンドウ**としつつ、**左ペインのタブも残す**（別ウィンドウがブロックされたときの退避先は中央ペインではなく左ペインのタブにする）。
11. **Office（LibreOffice wasm）は凍結**（user 指示 2026-10-25「時間のかかる office は後回しに / ArtCraft のオフィススイートを導入する可能性が高いので一旦凍結しましょう。あちらは rust ネイティブで web アプリネイティブなので、将来性がありそう」）:
    - LO / Qt の patch・焼き直し（`office-wasm-build.yml`）・office-pack の配布・probe の調査を新しく始めない。配布済みの一式はそのまま使う。
    - Office に触る issue（#774 / #121 / #431 等）は凍結のまま残し、閉じない。凍結を解くのは user の明示指示のみ。
    - 動いている PKC3 側の Office の入口が壊れたときのバグ修正だけは、§3 どおり直してよい。

## 3. 🔴 自走と完遂の規律（サボタージュ防止・最重要）

過去の教訓の拡大解釈による「質問逃げ」「勝手なスコープ縮小・項目間引き」「実機確認を理由にした未実装・Issue 放置」を固く禁ずる。

1. **合意・裁定済みの項目（`#1852` / `#1163` / 個別 Issue）を勝手に落とさない・縮小しない**:
   - 台帳や Issue で決まった項目・サブ項目（例: `50-2`〜`60-5` 等）を、「保存の形を変えるので見送り」「過去の決定に触れるので確認待ち」「文言だけで足りる」「実機確認が先」などの理由を自作して**未実装のまま間引いたり、完了 `[x]` と偽ったりすることを厳禁とする**。
   - 実装中に既存の全数ピン留めテスト（`operation-table` / `action-scope-survey` / `body-css` / `smoke-budget` 等）が鳴った場合は、**「門が断ったから案を取り下げる」のではなく、正当な機能追加・UI 追加に伴う事実の更新としてテスト側の数値・一覧を更新する**こと。
2. **不具合修正・合意済み改善で「見え方が変わる」を理由に手を止めない**:
   - バグ修正・動線の欠陥修正・すでに方針が決まった改善において、「見え方や文言が変わるから user / Gemini に聞く」として作業を止めたり質問を乱発したりしない。
   - 業務画面の原則と既存 UI トーンに合わせて**最良の実装を直接入れ**、お知らせ（`src/features/notice/notice-log.ts`）に記録して `/dev/` へ出す（user が実機で見て気になれば指摘する運用）。
   - 事前に判断を仰ぐのは **①不可逆なデータ破壊・本番リリース（`/`）②まったく新規で複数の相反する設計がありコードや既存方針から決まらない場合** のみ。聞くときは必ず「画面で何が起きるか」の言葉で書き、自分の推薦 1 つと理由を添える。
3. **「実機でしか確かめられない」を未実装や Issue クローズの言い訳にしない**:
   - ブラウザ固有挙動（`Ctrl+Shift+V`、`Ctrl+N`/`Ctrl+L`/`Ctrl+D`、動画・音声シーク、`file://`、印刷、モバイル幅等）であっても、**コードの実装と単体 / DOM / ヘッドレスで可能な検証はすべて実装・完遂する**。
   - 「実機で確かめられないから実装しない」「`#1610` へ転記して元の Issue を閉じる」ことを禁ずる。実装を入れたうえで実機確認のみが残る場合は、Issue を閉じずにラベル（`cowork確認` または `実機報告待ち`）で区別する。
4. **「済んだ」と書くときは観測点（commit SHA / PR 番号 / テスト結果）を伴わせる**:
   - まだ merge されていない PR を「着地済み」と書いたり、実装していない項目を `[x]` にしない。

## 4. 🔒 機密資料の取り扱い（user 指示 2026-08-15。不可侵・削除禁止）

user が「漏らすな」と渡した資料（機密資料）には次を絶対遵守する:
1. **中身をどこにも出さない**: repo（commit / issue / PR / doc / test fixture / お知らせ）、スクショ、会話要約のすべてに出さない。本文だけでなく題名・見出し・部品名・寸法・言い換え・要約も出さない。
2. **作業は repo の外でやる**: `/tmp/...` 等の専用ディレクトリに置き、`git add` の届かない所で完結させる。
3. **観測点は中身に依存しないものだけ**: スクショを撮らない・画素を読まない・本文を読まない・console は非 ASCII 行を捨てる。
4. **原因は「自作の対照群」で再現してから報告する**: 機密資料に 1 文字も触れず、自作の最小ファイルで再現させてから Issue / PR を書く。
5. **使い終わったら痕跡ごと廃棄する**: 資料本体・派生ファイル・ブラウザ profile・log・スクショをすべて消す。
6. **同じハーネスで機密資料を扱うときは、撮影の口自体を渡さない**。

## 5. Build, Test & Verification Workflow

```bash
npm run dev        # Vite dev server
npm run build      # Vite build → dist/
npm test           # vitest run (単体・全数検査)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src tests build scripts (build/ と scripts/ も対象)
```

### テストと Smoke の回し方

- **日常の編集時**: 触った層の単体テスト（`npx vitest run <path>`）+ `npm run typecheck` + `npm run lint`。
- **UI の押し所（`data-pkc-action`）・動的クラス（`.pkc-*`）・設定キー・reducer action を足したとき**:
  - 全数検査（`action-outlets` / `operation-table` / `action-scope-survey` / `markdown-css-parity` / `body-css` / `store-fallback` / `settings-file` / `body-write-block-lid`）が動くため、push 前に **`node scripts/test-pr.mjs origin/main`**（または `npx vitest run tests/`）を回して連動する表・件数を更新する。
- **実ブラウザ smoke**:
  - 自動 CI でフル smoke は走らせない（`smoke.yml` は `workflow_dispatch` のみ）。
  - 途中は対象範囲のみ引く（`node scripts/pick-smoke.mjs --run` または `pkc3-smoker` で対象 spec を指定）。
  - 共有面（boot / renderer / storage / CSS / shell / お知らせ追加）を触った PR の着地前に 1 回だけフル smoke を回す。
- **委任の境界（dev と本番）**:
  - **`/dev/`（`main` への squash merge）**: Claude に委任済み。CI green + レビュー完了後、自分で squash merge して `main` を同期する。
  - **`/`（本番リリース: `v*` tag の push / `release.yml` の dispatch）**: **user の明示的な示唆を待つ**（自分から実行しない。`package.json` / `APP_VERSION` / `notice-log.ts` / `CHANGELOG.md` の準備までは進めてよい）。

## 6. 検証の規律（10 の型 ── 詳細は `.claude/rules/*.md`）

> 通っている test が別の理由で緑になっていないか（空振り・未実行）を常に検算する。

| # | 型 | 要点 | 詳細ルール |
|---|---|---|---|
| 1 | **検査の空振り** | 代替物（静的ファイル・初期値・豆腐・コメント内の文字列）で満たされない条件にする。CSS/YAML の検査はコメントを剥がして対象行に絞る | `.claude/rules/verification.md` §1 |
| 2 | **経路の未実行** | 分岐が実際に通ったか・fixture の次元が非ゼロかを確かめる | `.claude/rules/verification.md` §2 |
| 3 | **変異試験の罠** | NOT-APPLIED と SURVIVED を区別し、作業ツリーを `finally` で確実に復元する | `.claude/rules/verification.md` §3 |
| 4 | **観測点の選び方** | 対照群を揃え、下流（保存・描画）まで通して測る | `.claude/rules/verification.md` §4 |
| 5 | **環境差** | 手元（フル Chromium）と CI（`headless_shell`）の差（`beforeprint`/`afterprint` 等）に注意する | `.claude/rules/workflows.md` |
| 6 | **shell と CI** | `\| tail` や末尾 `echo` で終了コードを消さない。`pkill` で自分のコマンドラインを巻き込まない | `.claude/rules/workflows.md` |
| 7 | **複数の場所** | 同じ判定は 1 関数へ寄せる。読む側と書く側の門・世代管理を対称にする。`?.` で `null` が `catch` を素通りしないようにする | `.claude/rules/src-invariants.md` |
| 8 | **上流の取り込み** | ファイル実在ではなくビルド登録（`*.mk` 等）と配布目録を集合で突合する | `.claude/rules/workflows.md` |
| 9 | **編集の作法** | 制御文字の生バイトを入れない。既存ファイルにフォーマッタを全面適用しない | `.claude/skills/source-editing/SKILL.md` |
| 10 | **置き換えの作法** | native 機能を自前 UI に替えるときは「ついでに提供していた性質」（背面抑止・直列化・フォーカス復帰・`textContent`）を落とさない | `.claude/rules/src-invariants.md` |

## 7. `.claude` 資産一覧

### サブエージェント（`.claude/agents/`）

書き込み権のあるエージェントは必ず **`isolation: "worktree"`** で起動する。

| ファイル | 役割 | 隔離 | model |
|---|---|---|---|
| `.claude/agents/pkc3-reviewer.md` | 着地前の敵対的コードレビュアー（実装・テストの空振り検査） | read-only | sonnet |
| `.claude/agents/pkc3-ux-reviewer.md` | user 目線の動線・UX レビュアー | read-only | sonnet |
| `.claude/agents/pkc3-surveyor.md` | 実地調査員（`file:line` で根拠収集） | read-only | sonnet |
| `.claude/agents/pkc3-implementer.md` | 実装担当（渡された主題を完遂してテスト付きで返す） | worktree | sonnet |
| `.claude/agents/pkc3-verifier.md` | 変異試験の実行 | worktree | haiku |
| `.claude/agents/pkc3-smoker.md` | 対象範囲の実ブラウザ smoke 実行 | worktree | sonnet |
| `.claude/agents/pkc3-runner.md` | 全量 test / build / 指定 smoke の機械的実行 | worktree | haiku |

### スキル（`.claude/skills/*/SKILL.md`）とルール（`.claude/rules/*.md`）

- スキル:
  - `.claude/skills/subagent-scale/SKILL.md` (`/fanout`)
  - `.claude/skills/mutation-testing/SKILL.md` (`/mutate`)
  - `.claude/skills/perf-measurement/SKILL.md` (`/measure`)
  - `.claude/skills/smoke-testing/SKILL.md`
  - `.claude/skills/cowork-verification/SKILL.md`
  - `.claude/skills/source-editing/SKILL.md`
  - `.claude/skills/notice-writing/SKILL.md`
  - `.claude/skills/pr-landing/SKILL.md`
  - `.claude/skills/github-tools/SKILL.md`
  - `.claude/skills/sandbox-hygiene/SKILL.md`
  - `.claude/skills/office-oracle/SKILL.md`
  - `.claude/skills/session-handoff/SKILL.md` (`/handoff`)
  - `.claude/skills/knowledge-reflection/SKILL.md` (`/claude-update`)
  - `.claude/skills/gemini-outsourcing/SKILL.md`
- ルール（対象 path を触るときに自動参照）:
  - `.claude/rules/verification.md` (`tests/**`)
  - `.claude/rules/src-invariants.md` (`src/**`)
  - `.claude/rules/workflows.md` (`.github/**`, `scripts/**`, `build/**`)
