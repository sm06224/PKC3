---
name: sandbox-hygiene
description: この箱(作業コンテナ)の性質と、手元の物を失わないための規律。コンテナはセッション中に作り直され、push していない commit・node_modules・scratchpad は消える。ディスクは枠制で `df` の見かけと違う。bash の cwd が `/home/user` へ戻ることがある。「消えた」「node_modules が無い」「巻き戻った」「not a git repository」「ディスクが一杯」「一式を落とす」という文脈で必ず使う。
---

# この箱の扱い(PKC3)

> ⚠ **これは PR の着地とは別の主題である**(2026-09-05 に `pr-landing` から切り出した ──
> 1 枚 1 主題)。箱が壊れるのは**どの作業中でも**起きる ── 計測中・調査中・変異試験中に
> 起きたときにここを引けないと、失った物を数え直すところから始めることになる。

## 0. 🔴 3 行でいうと

1. **push していない物は、いつでも消えるものとして扱う**(区切りごとに push)
2. **落とした一式は、測ったら消す** ── 作り直しの引き金はディスクらしい
3. **VCS や npm を打つ命令は `cd <作業ツリー> &&` を頭に置く**(cwd が戻る)

## ⚠ この箱は作り直される ── **push していないものは消える**

2026-08-13 に**セッション中 4 回**、コンテナごと作り直された:
**作業ツリーが古い commit へ巻き戻り**、`node_modules` も scratchpad の
中身も消えていた(⚠ 直前に作った file だけが残る、という中途半端な消え方をする)。

🔑 **区切りごとに push する。** 手元にしか無いものは、いつでも消えるものとして扱う。
🔑 **使い捨てのスクリプトを scratchpad に置いたまま育てない** ── 動いたら
**repo の中の道具へ畳む**(2026-08-13 に探検スクリプトを 1 本失った)。
🔑 **測った数字は、その場で issue / PR へ書く。** 手元の JSON は消える ──
実際 2026-08-13 に対照群の `steady.json` を失ったが、**PR に転記済みだったので
損失ゼロ**だった。次のビルドで tag が上書きされる類の物はとくに。

### 🔴 作り直しの引き金は**ディスク**らしい ── 落としたら消す
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

### 🔴 箱を立て直したら、commit を守る hook が入っているかを見る

```bash
npm ci                                   # ← `prepare` が hook を .git/hooks へ写す
# 手で入れるなら:
node scripts/install-hooks.mjs
```

`.githooks/pre-commit` は **`main` の上の commit を断る**(2026-09-12 に指定 branch を
外して main へ 2 commit 直に積んだ)。

🔴 **写す先が肝である** ── `git config core.hooksPath .githooks` では**動かない**:
hooksPath は**作業ツリーの中**を指すので、`git checkout main` すると
`.githooks/pre-commit` ごと消え、**守るべき場所でだけ hook が居なくなる**
(⚠ git は「hook が無い」を**黙って通す**)。🔑 `.git/hooks/` は checkout で
変わらないので、そこへ写す(`scripts/install-hooks.mjs` が `core.hooksPath` も外す)。

🔑 **掛かっているかを 1 行で確かめる** ── ⚠ 手で `sh` に渡して試しても分からない
(1 稿目はそれで緑だった)。**git に通す**:

```bash
git switch main && git commit --allow-empty -m zz; echo $?   # → 1(断った / 何も積まれない)
git switch -                                                  # 指定 branch へ戻る
```

⚠ 禁止が解ける条件も憶えておく:**`PKC3_ALLOW_MAIN_COMMIT=1`** を付ければ通る。
門は `tests/repo-hygiene.test.ts`(**入れる script を走らせて、入った物を走らせる**)。

## 🔴 bash の cwd が `/home/user` へ戻ることがある

2026-09-02 に**同じセッションで 2 回**踏んだ ── `not a git repository` が返り、
その後ろに `;` で繋いだ検査が **exit 128 / 254 で空振り**した。
⚠ **空振りは「緑」と見分けがつかない**(何も出力せずに終わることがある)。

🔑 **VCS・npm を打つ命令は `cd <作業ツリーの絶対 path> &&` を頭に置く。**
⚠ 繋ぐのは `&&` ── `;` で繋ぐと、`cd` が失敗しても後ろが走る。

🔴 **worktree で走るエージェントはとくに危ない** ── cwd が**依頼者の本体ツリー**へ
戻るので、そこで書き換えると**他人の作業を壊す**。手順は
`.claude/skills/subagent-scale/SKILL.md`「隔離」(事故の記録は `.claude/skills/subagent-scale/reference/worktree-incidents.md`)。

🔴 **戻った cwd は、worktree 隔離そのものを起動不能にする**(2026-09-16 実測)。
cwd が `/home/user` のまま `isolation: "worktree"` を投げると
`Cannot create agent worktree: not in a git repository` で落ちる ──
⚠ この文面は**hook が無いときと同じ**なので、
**「この箱では使えない」と読み違えて要らぬ退避へ倒れる**。
🔑 **投げる前に `cd <作業ツリー>` を 1 回打つ**だけで消える。
🔑 2026-10-02 にも 1 度踏んだ(同じ session で、直前まで起動できていたのに cwd だけ戻っていた)。
**手順は固定**:`Agent` を起動する**直前の Bash** で **`cd /home/user/PKC3 && pwd`** を打つ
(`pwd` の出力で戻っていないことを見る)。

## 🔴 probe は **repo の外を cwd にして**走らせる(2026-09-16)
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

## 🔴 **worktree は溜まる ── 溜まると `npm run build` が落ちる**(2026-09-16 実測)

```
Error: ENOSPC: System limit for number of file watchers reached,
  watch '/home/user/PKC3/.claude/worktrees/agent-…/src/adapter/ui/actions/import-markdown.ts'
```

⚠ **`vite build`(watch モードではない、ふつうのビルド)が落ちる**のが罠である ──
「watcher が足りない」と出るのに、こちらは watch していない。
🔑 実体は **`isolation: "worktree"` のエージェントが置いていった複製**が、
`.claude/worktrees/` に**そのまま残る**ことである。

実測(この日の 1 セッション):

| | 値 |
|---|---|
| 溜まっていた worktree | **75 個** |
| それが食っていたディスク | **11 GB** |
| `fs.inotify.max_user_watches` | 130,092 |
| 掃除した後 | **594 MB** / build は `exit=0` |

⚠ **自分では減らない** ── 依頼したエージェントが終わっても、変更が無いものだけが
自動で畳まれる(**detached HEAD にしたり commit したものは残る**)。
⚠ 残骸は `worktree-agent-*` という **branch** も置いていく(この日は **80 本**)。

🔑 **掃除の手順**(⚠ **いま走っているエージェントの物は残す** ── `ls -lt` で
いちばん新しい物が動いている):

```bash
cd /home/user/PKC3
KEEP=agent-<いま走っている id>
for d in .claude/worktrees/*; do
  [ "$(basename "$d")" = "$KEEP" ] && continue
  git worktree remove --force "$d" 2>/dev/null || rm -rf "$d"
done
git worktree prune
LIVE=$(git worktree list --porcelain | grep '^branch' | sed 's#^branch refs/heads/##')
for b in $(git branch --list 'worktree-agent-*' | tr -d ' *'); do
  echo "$LIVE" | grep -qx "$b" || git branch -D "$b"
done
```

🔑 **合図は 2 つ**:①`ENOSPC` / `watchers` の字を見たら**まずここを数える**
②**エージェントを 10 本投げたら、そのターンの終わりに掃除する**
(⚠ 「あとで」は来ない ── 次に気づくのは build が落ちた日である)。

### 🔴 worktree だけではない ── scratchpad と `/tmp` の「落とした物」が枠を使い切る(2026-10-06 実測)
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

### 🔴 `/tmp` の **24 GB** は vitest の捨て忘れだった ── 殺した走りの数だけ 84 MB 残る(2026-10-07 実測)
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

## ⚠ 失わないための置き場の選び方

| 置く物 | どこへ | なぜ |
|---|---|---|
| 測った数字 | **issue / PR の本文** | 手元の JSON は消える。転記済みなら箱が飛んでも損失ゼロ |
| 育った script | **repo の中の道具**(`scripts/`) | scratchpad に置いたまま育てると 1 本まるごと失う |
| 使い捨ての probe / 変異ハーネス | scratchpad | ⚠ 消えてよい物だけ置く |
| 落とした一式(数百 MB) | `/tmp` ── ただし**測ったら消す** | 枠を食い潰すと箱ごと作り直される |

## 🔴 scratchpad は**セッションをまたいで残る** ── 古い log を計器にしない

⚠ 上の表は「消える」側の話だが、**逆向きの事故**がある ── scratchpad の file は
**箱が作り直されるまで残り続ける**ので、**前のセッションの log が同じ名前で待っている**。

実例(2026-09-14):全量 `npm test` の結果を `full3.log` へ落とし、
**終わるのを待つ間にこう書いた**:

```bash
# 🔴 これが即座に一致した ── 中身は 2 日前の走り
until grep -qE "Tests  " .../scratchpad/full3.log; do sleep 5; done
```

`npm run lint && npm run typecheck && npm test > full3.log` の**前 2 つがまだ走っていた**ので
`>` はまだ効いておらず、**2026-09-12 の残骸**をそのまま読んだ。そこには
**527 file / 9571 件**と書いてあり、直前の走り(**561 / 10119**)と比べて
🔴 **「テストが 548 件減った」= CLAUDE.md §9 の最悪の事故**に見えた。

⚠ **見分けが付かない** ── 中身は本物の vitest の出力で、書式も件数も自然である。
気づけたのは `Start at 02:02:00` が**そのとき時刻より前だった**ことだけで、
確定したのは `stat` の mtime(**2 日前**)である。

🔑 **直し方は 2 つ。どちらも 1 手で済む**:

- **走りごとに名前を変える**(`full-$(date +%s).log` / run id を入れる)──
  ⚠ `full2` `full3` と**手で数える名前**が、まさにこの罠を作る
- **待つ前に消す**(`: > out.log` してから走らせる)── 空なら `until` は一致しない

⚠ **そもそも `until grep` で待たない**のが本筋である(CLAUDE.md
「サブエージェントや CI の完了を `sleep` / ポーリングで待たない」)──
背景実行の**完了通知**を待てば、読むのは必ずその走りの出力になる。

🔑 一般形:**file 名は「いつの走りか」を持たない** ── 中身が本物に見える計器ほど、
**どの走りの物か**を先に確かめる(`stat -c %y`)。

### ⚠ **同じセッションの中でも起きる**(2026-09-16、2 度目)
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

## 🔴 サブエージェントの worktree は**積み上がる** ── 減らすのは `node_modules` だけでよい

⚠ `isolation: "worktree"` で投げたエージェントの作業ツリーは `.claude/worktrees/` に残る。
**自動で消えるのは「1 バイトも変えなかった」物だけ**なので、実際にはほぼ全部残る。

実測(2026-09-14、1 セッションの終盤):

| | |
|---|---|
| worktree の数 | **82** |
| `.claude/worktrees` 全体 | **14G** |
| うち `node_modules` | **9.9G**(59 個) |
| うち `dist` | **2.1G** |
| **残り(= 実体の checkout)** | **約 2G** |
| そのときの空き | **15G** ── ⚠ 箱が作り直される引き金はディスクである(上の節) |

🔑 **消してよいのは `node_modules` と `dist` だけ**(`npm ci` / `npm run build` で戻る):

```bash
cd /home/user/PKC3
rm -rf .claude/worktrees/*/node_modules .claude/worktrees/*/dist
# 実測: 空き 15G → 27G(12G 解放)。checkout 本体は 2.1G 残る
```

🔴 **worktree ごと消さない。** ⚠ 「未回収の仕事が無いこと」は**安く判定できない**:

- `git rev-list --count <head> ^origin/main` は**役に立たない** ── squash merge だと
  元の commit は**永久に main の祖先にならない**ので、着地済みでも「N commit 先行」と出る
- `git diff origin/main <head>` も**役に立たない** ── 古い commit に居るだけで
  巨大な差が出る(実測: 82 個すべてが「差が在る」と判定された)

🔑 判定できないものを消さない。**中身(2G)は残しても箱は保つ**ので、
**作り直せる物だけ落とす**のが釣り合っている。

### 🔴 背景で起動した重い物を、**4 時間半止め忘れた**(2026-09-15)
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

### ⚠ 「走っているエージェントが居ない」は `pgrep` では確かめられない
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

### 🔴 殺すときは、**自分と親を除く**(2026-09-14 に踏んだ ── 同じ罠の 3 度目)
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。

## 🔴 孫は名前が違う ── 親を止めても生き残る(2026-09-16。実測)
詳細(経緯・実測・手順)は [`reference/incidents.md`](reference/incidents.md) の同名の節へ移した。
