---
description: 変異試験を回す(実装をわざと壊して test が落ちるか確かめる。KILLED / SURVIVED / NOT-APPLIED の 3 値)
---

対象: $ARGUMENTS(未指定なら「この PR で足した / 触った機構」を列挙してから始める)

手順は `.claude/skills/mutation-testing/SKILL.md` に従ってください。
以下はその上に置くガードレールです。

- **ハーネスは file に出す**(`cp .claude/skills/mutation-testing/templates/mutate.py
  /tmp/mut-<主題>.py`)。その場の shell に書くと、引用で変異が当たらないまま
  「生存」と読む
- **変異は「この PR が守ると言っている機構」から作る**。PR 本文の主張を 1 つずつ
  裏返すと、だいたい過不足ない一覧になる
- **経路が複数あるものは経路ごとに 1 件**(CLAUDE.md「同じ値を複数の描画経路へ
  渡すものは、経路ごとに pin する」)
- **検品する側・test する側にも当てる** ── 検査関数を常に合格にする / `this.error` を
  消す。これが `SURVIVED` なら、その検品は出荷を止めない
- 🔴 **`NOT-APPLIED` を合格と読まない。** アンカーを直して**やり直す**
- **smoke に当てるなら `npm run build` を挟む**(`dist/` を配信するので source では届かない)
- 結果は PR 本文に **KILLED 件数と「何を壊したか」**で書く。⚠ 生き延びたものが
  在ったなら、**どう直したか**まで書く ── そこがこの作業の中身である
