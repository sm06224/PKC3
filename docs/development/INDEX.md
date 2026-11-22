# 現役の正本 doc(地図)

`docs/development/` の doc は `src/`・`tests/` から参照されているので**動かさない**。ここは「いま正本として読むもの」だけを 1 枚に並べる(30 行以内を保つ)。

| 主題 | 正本 | 一緒に見る物 |
|---|---|---|
| 方針・アーキテクチャ・端末間の同期(段 1〜3 は §12.1) | `pkc3-major-upgrade-design-2026-07.md` | `CLAUDE.md` §2 |
| 画面の規則(業務画面・4 型のボタン・段差) | `ui-refresh-design-2026-11.md`(#1982) | `src/styles/tokens.css`、`tests/adapter/lowq-boundary.test.ts` |
| 無人同期(段 4) | `sync-unattended-design-2026-11.md`(#2000) | #2000 の裁定コメント |
| ノートのタブ | `note-tabs-design-2026-11.md` | |
| 画面の言葉 | `src/features/ui-terms.ts`(`STANDARD_TERMS` / `BANNED_TERMS`) | `ui-terms-rename-2026-10.md`(旧語の対応表) |
| マニュアルの書き方 | `manual-style-2026-09.md` | `docs/manual.md`、`tests/docs-parity.test.ts` |
| 操作の置き場(そのボタンはそこに在るべきか) | `operation-model-2026-08.md` | `tests/action-outlets.test.ts` |
| 定常の性能 | `perf-survey-2026-10.md` | `.claude/skills/perf-measurement/SKILL.md` |
| `.claude` 資産の再編 | `claude-assets-refresh-2026-10.md` | `.claude/skills/knowledge-reflection/SKILL.md` |
| 直近の引き継ぎ | `session-handoff-2026-11-03.md` | 以後は引き継ぎ PR が正本 |

- 台帳(live tracking)は GitHub Issues: `#1852`(合意済み項目の台帳)・`#1163`(Gemini への依頼)。
- `measurements/` は計測の生データ、`archived/` は役目を終えた doc、`images/` は doc とマニュアルの図。
- 上の表に無い `*-design-*.md` / `*-measure-*.md` は、その機能を触るときの経緯資料(正本ではない)。
