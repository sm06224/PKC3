---
description: セッションの技術的知見を .claude 資産へ簡潔に統合・整理する（肥大化・反省文の追記は厳禁）
---

対象: $ARGUMENTS（未指定なら「このセッションで得た技術的知見の統合と古い記述の整理」）

手順は `.claude/skills/knowledge-reflection/SKILL.md` に従ってください。

- **反省文・失敗物語の追記は厳禁**: 日付つきの長文エピソード（「1 巡目は…」等）や、実装の手を止める禁止規則（「見え方が変わるから聞く」「門に断られたら取り下げる」等）を絶対に書かない。
- **行数上限を守る**: `CLAUDE.md` は 300 行未満、`.claude/rules/*.md` は各 150 行未満、各 `SKILL.md` は 250 行未満。足すときは既存の項目に統合し、古い記述を削る。
- **機械化できるものはテストへ**: 散文の戒めを増やすより、単体テストや lint で守る。
- **検算**:
  ```bash
  grep -rhoE '(PKC2:)?\.claude/[A-Za-z0-9./_-]*' CLAUDE.md docs .claude/skills .claude/agents .claude/commands \
    | grep -v '^PKC2:' | sed 's/[.,)。]*$//' | sort -u \
    | while read p; do [ -e "$p" ] || echo "無い $p"; done
  npx vitest run tests/flag-budget.test.ts tests/repo-hygiene.test.ts
  ```
