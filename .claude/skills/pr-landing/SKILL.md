---
name: pr-landing
description: PKC3 の PR 作成から CI green 確認 → 自己監査 → squash merge → main 同期までの手順。dev（main）への merge は Claude に委任済み。
---

# PR を着地させる（PKC3）

## 1. 基本原則

- **1 PR 1 主題**（または台帳の 1 束）。別主題が同居する場合は commit を分け、PR 本文に明記する。
- **導線と実体は同じ commit に入れる**: `CLAUDE.md` や doc が `.claude/...` 等を指す変更は、指す先のファイルと同じ commit に入れる。
- **要求された項目をすべて実装してから着地させる**: 台帳の束を着地させるとき、勝手に一部項目を落としたまま「束完了」として閉じてはならない。

## 2. push 前のチェック手順（この順で実行）

1. **変異試験・コードレビュー・対象 smoke**:
   - 重要なロジック変更には変異試験（`.claude/skills/mutation-testing/SKILL.md`）と着地前レビュー（`/review`）を通す。
   - レビュー指摘の修正は 1 つの commit に束ねる。
   - 視覚を持つ変更は対象範囲の smoke（`node scripts/pick-smoke.mjs --run`）を通す。共有面（boot / renderer / storage / CSS / shell / お知らせ追加）を触った場合はフル smoke を 1 回通す。
2. **UI の口・クラス・設定・action を足したときの連動検査**:
   | 追加・変更したもの | 連動して更新・確認する検査 |
   |---|---|
   | インライン CSS 変数 `var(--x)` | `tests/features/css-vars.test.ts`（フォールバック値 `var(--x, fallback)` を付ける） |
   | 動的クラス `.pkc-*` / 本文 CSS | `tests/features/markdown-css-parity.test.ts`（`STYLED_ELSEWHERE` 登録）、`tests/build/body-css.test.ts` |
   | `data-pkc-action` | `tests/action-outlets.test.ts`、`tests/operation-table.test.ts`、`tests/action-scope-survey.test.ts`、`docs/development/operation-model-2026-08.md` §7.1 |
   | 노ードから `lid` を引く呼び出し | `tests/adapter/lid-of-node.test.ts` |
   | `localStorage` 設定 store | `tests/adapter/store-fallback.test.ts`、`tests/features/settings-file.test.ts` |
   | reducer の action (`type: 'XXX'`) | `tests/adapter/body-write-block-lid.test.ts` |
   | お知らせ (`notice-log.ts`) | `CHANGELOG.md`（同見出し）、`tests/docs-parity.test.ts`、`tests/adapter/announce.test.ts`、`tests/adapter/help-pane.test.ts`（記法禁止） |
3. **最後のファイル編集の後に必ず回す一式**:
   ```bash
   npm run typecheck && npm run lint && node scripts/test-pr.mjs origin/main
   VITE_PKC_KIND=dev npm run build && node scripts/check-dist.mjs dev
   ```
   （※ テストファイルだけを直した後でも必ず `npm run typecheck` と `npm run lint` 全量を通す）

## 3. PR 本文に書くこと

- **何をどう直したか**（前後の実測値・判断の理由）
- **検証結果**（単体テスト・smoke・変異試験の結果）
- **配布サイズ残量**（KB と %。通常増加で cap に触れたら `scripts/check-dist.mjs` の cap を引き上げてよい）
- **user に見える変化**（隠さず明記する）

## 4. git push / squash merge / ブランチ再作成の作法

1. **push 前の確認**:
   - `git status -sb` の 1 行目を見て detached HEAD でないことを確認する。
   - push 後は PR の `head.sha` が手元の `git log -1` と一致していることを確認する。
2. **squash merge の `502` 注意**:
   - `merge_pull_request` が `502` や `405 Merge already in progress` を返したときは、サーバ側で処理中のことがあるため即座に再実行せず、`git fetch origin main && git log --oneline -3 origin/main` で `origin/main` に入ったかを確認する。
3. **merge 直後のブランチ再作成（必須・1 息で実行）**:
   ```bash
   git fetch --prune origin && git checkout -B <branch> origin/main && git branch --unset-upstream
   ```
   - `--prune` に `origin main` のような refspec を付けない（消えた `origin/<branch>` が残って次の push が `(stale info)` で拒否されるのを防ぐ）。
   - push 時は必ず `git push -u origin <branch>` とブランチ名を明示する。

## 5. 止めて user の裁定を仰ぐ条件（これ以外は自走して merge する）

- **後方互換の破壊**（既存データ形式・書き出し形式・URL の破壊的変更）
- **不可逆操作**・**本番リリース**（`v*` tag の push / `release.yml` の実行は必ず user の示唆を待つ）
- **アーキテクチャ不変量への抵触**（ワーカー常駐化・図を SVG のまま表示・JSON 文字列 body・15 個を超える flag 等）

※ バグ修正や台帳（`#1852` / `#1163` 等）で合意済みの UI 改善では、「画面の見え方が変わるから」という理由で merge や実装を止めてはならない。
