# 書けるエージェントの「段 0」── 自分が見ている版と場所を確かめる(事故の記録)

> 手順は 4 本の agent 定義(`pkc3-implementer` / `pkc3-smoker` / `pkc3-verifier` / `pkc3-runner`)の
> 「段 0」に在る(同文)。ここは**なぜその 4 行が要るか**の記録。2026-10-10 に 3 本の agent が
> 持っていた同文 33 行をここへ 1 本にまとめた。

## 型: 隔離された worktree が「依頼者の見ている版」と違う

`isolation: "worktree"` が切る元は、依頼者の作業ツリーの姿とは限らない ── 未 commit の変更は
1 バイトも入らず、HEAD が branch の先端より古いことも、別の branch(`origin/main`)から切られる
こともある(2026-09-20 実測、4 度起きた)。

🔴 どれも「隔離が壊れている」ようには見えない ── `git status` は clean で、file も一式そろっている。
違うのは中身だけなので、そのまま進むと**まだ存在しない物を「確かめました」と返す**ことになる。

- 見分け方: `pwd && git worktree list && git log --oneline -1` の sha が、依頼文の sha と違う
- 直し方: 依頼文に sha が在れば、**自分の worktree の中で** `git fetch origin <branch> && git checkout --detach <sha>`。
  無ければ始めずに依頼者へ返す(2026-10-04 に実際に断られて 1 本空振りした ── 依頼者側の書き方は
  `../SKILL.md`「期待する sha を必ず書く」)
- そのうえで、依頼文が前提にしている物(直したはずの関数名 / 足したはずの file 名)を 1 つ grep する。
  無ければ何も走らせずに止まる

### ⚠ 「無い」の書き方

「自分の箱に無い」を「repo に無い」と書かない ── それは実装の失敗ではなく**調査の結論**の顔で返るので、
依頼者に存在しない手戻りを始めさせる(実際に起きた)。repo 全体を探すなら path で引く
(`git log --all --oneline -- '<path>'`)── この repo の commit の題名は日本語なので、ASCII の file 名で
`grep` しても当たらない。

## 型: 自分の worktree の外で書く・走らせる

- 2026-08-04: 書き込み権のあるエージェントが依頼者の**編集中の file を変異させ、戻さずに終わった**
  (`URL.revokeObjectURL` が消えていた)。自分の変更と混ざるので diff でも気づきにくい。以来
  「書けるエージェントは worktree 隔離」が条件
- 2026-09-25(#1045): 同じ親の下に**別の担当の作業ツリー**が並んでいて、そこで変異を当てた ──
  その担当の途中の編集が、変異の控えで巻き戻された。`pwd` が依頼文の名指しした場所と一致するかを見る
- 2026-10-03: 「sha が違えば `git checkout <sha>`」を**依頼者の作業ツリー(`/home/user/PKC3`)で打った**
  ── 依頼者の HEAD が detached になり、その上に積んだ直しの commit は branch に乗らず、push しても
  「Everything up-to-date」だった(依頼者は安全網の check-in で初めて気づいた)。unit / build / smoke も
  そこで回したので、log と `dist/` が依頼者のツリーへ書かれた

- 見分け方: `pwd` が `/home/user/PKC3/.claude/worktrees/<自分の id>` でない
- 直し方: `/home/user/PKC3` そのものなら **git も npm も打たずに**依頼者へ返す。別の担当の worktree なら
  何も書き換えずに止まる。全部の命令を `cd <自分の worktree> && …` の形で始める(bash の cwd は
  `/home/user` へ戻ることがある ── `.claude/skills/sandbox-hygiene/SKILL.md`)

🔑 規律を守るのは tools の一覧であって、プロンプトの文言ではない(`CLAUDE.md`「資産」)──
だから隔離なしで書けるエージェントを起動しない。起動できないときは read-only の型に下書きさせ、依頼者が当てる。
