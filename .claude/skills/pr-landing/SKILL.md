---
name: pr-landing
description: PKC3 の PR を作ってから CI green 確認 → 自己監査 → squash merge → main 同期まで回す手順。merge は user から Claude に委任済み(2026-08-04)だが、止めて裁定を仰ぐ条件がある。1 PR 1 主題の原則と、ブランチが 1 本に固定されているときの折り合いも。「PR を作る」「着地させて」「merge して」「CI 見といて」という文脈で使う。
---

# PR を着地させる(PKC3)

> 事故の記録(着地の事故。日付・issue つき)は [`reference/landing-incidents.md`](reference/landing-incidents.md)(型ごとに並べてある。目次つき)。ここは手順。

> **user 委任 2026-08-04**: 「**チェックリスト以外はあなたにすべて委任します**」/
> 繰り返し「**main に入れてくれ / Pages で見たいから**」。
> ⚠ 出典タグ付き = 不可侵。**ただし下記「止める条件」は残る。**

## 主題は 1 つ

**1 PR 1 主題。** 既存問題を見つけたら別 PR へ剥がす ── wave に紛れ込ませない。

⚠ **PKC3 は作業ブランチが 1 本に固定されている**(`claude/…`)。別主題を別 PR に
できないことがある。そのときは:

1. **commit を分ける**(主題ごと。commit message に理由まで書く)
2. **PR 本文に「別主題が同居している」と明記**する
3. 剥がしたければ **user に別ブランチの許可を求める**

🔑 それでも**混ぜてはいけないものが 1 つある** ── **導線と実体**。
`CLAUDE.md` が `.claude/…` を指す変更は、**実体と同じ commit**に入れる。
2026-08-07 に、実体をまだ commit していないのに導線だけ commit して amend で剥がした。

## 着地前のチェック(この順で)

**先に**(⚠ どれも**作業ツリーを触る**ので、下の一式より前に済ませる):
- **変異試験**(`.claude/skills/mutation-testing/`)── 生き延びたものが無いこと
- **code review**(`.claude/commands/review.md`)── **修正したら 2 巡目**を回す
- **視覚を持つ変更**なら smoke 最低 1 件(`.claude/skills/smoke-testing/`)

🔴 **順序が逆だと嘘の緑を見る。** 2026-08-10 に、変異試験のスイープの最後で
バックアップが書き戻されて**直したはずの実装が巻き戻り**、そのまま commit して CI が
赤くなった ── 手元では**スイープの前**に緑を見ていたので「通ったのに落ちた」に見える。

### 🔴 押し所(`data-pkc-action`)を足したら、**`tests/` を全部回す**

ボタンを 1 つ足しただけで、等値で pin している検査 5 つに順に捕まり、CI を 2 回赤くした(2026-09-16)。
`tests/adapter/` と `tests/features/` しか回さず、`tests/` 直下を 1 度も回していなかった。
`grep -rn "<足した名前>" tests/` は **0 件**を返す(件数しか持たない検査は名前を書いていない)ので、grep では足りない。
→ `reference/landing-incidents.md`「押し所(`data-pkc-action`)を足したら、`tests/` を全部回す」

### 🔴 UI の口を 1 つ足すと動く**全数検査の一覧** ── 依頼文に写す(2026-10-02)

2026-09-16 の実測(上の 5 つの検査に順に捕まった件)の後も **「触った層だけ回して push → CI 赤」** が続いた
(目的:この往復を無くす。implementer へ頼むときは**この表を依頼文へ貼る** ──
相手は依頼文の範囲でしか test を回さない)。口 = 新しい `data-pkc-action` / 新しい class / 新しい設定 1 つ。

| 足した物 | 動く検査(全部 `tests/` の下) | 何を直すか |
|---|---|---|
| **JS がインラインで差す CSS 変数**(CSS 側に定義が無い) | `features/css-vars.test.ts`(**既定値の無い** `var(--x)` だけを「定義が無い」と数える) | 使う側を**既定値つき** `var(--x, fallback)` にする(定義の無い変数は宣言ごと捨てられる) |
| **動的に付ける class**(`.pkc-*`) | `features/markdown-css-parity.test.ts` | `STYLED_ELSEWHERE` へ名指しで登録(上の節) |
| **`data-pkc-action`** | `action-outlets.test.ts`(`OBJECT_LONE` など受け手の仕分け)/ `operation-table.test.ts`(件数)/ `action-scope-survey.test.ts` + `scripts/action-scope-survey.mjs` / `docs/development/operation-model-2026-08.md` §7.1 の表 | 件数と表を**事実が動いた分だけ**直す |
| **ノードから lid を引く新しい口** | `adapter/lid-of-node.test.ts`(寄せた呼び出しの**件数**を pin) | 件数を直す(寄せずに手書きすると落ちる ── 寄せるのが正しい向き) |
| **設定 1 つ**(localStorage に持つ store) | `adapter/store-fallback.test.ts`(控えを持つ store の**全数走査**)/ 設定の持ち出し(`features/settings-file.test.ts` 周辺)の key の件数 | store は fallback を持たせる。持ち出しの件数は直す |
| **reducer の action を 1 つ足す**(`type: 'XXX'`) | `adapter/body-write-block-lid.test.ts`(**編集中に無言で捨てる case の全数 pin**。2026-10-02、#1231 段①の `SET_REVISION_COMPARE` で全量で初めて落ちた) | 読むだけの action なら「無言で捨ててよい側」に名指しで足し、件数を +1。書く action なら `BODY_WRITE_ACTIONS` の側 |

🔑 **手順は 2 つ**:①**触った層だけでなく `npx vitest run tests/` を 1 回**(grep では見つからない ──
2026-09-16 の教訓(reference)と同じ。件数しか持たない検査は、足した名前を 1 つも書いていない)。
②🔴 **数を直すのは「事実が動いた分だけ」**(CLAUDE.md 2026-09-21 の見分け方):
「口を 1 つ足したので 325 → 326」は直す / 「通したいので上限だけ外す」は直さない
(直すとき**何が動いたかを 1 行**添えられないなら、それは緩めている)。

### 🔴 Markdown 本文の動的装飾・CSS クラス（`.pkc-*`）を足したら、`markdown-css-parity` と `body-css` を検める(2026-09-29)

⚠ `app.css` に `.pkc-*` クラスの規則を足した際、**CI/verify で parity 検査に引っかかる**:

| # | 何が鳴るか | 理由と塞ぎ方 |
|---|---|---|
| 1 | `tests/features/markdown-css-parity.test.ts` | **「CSS に誰も出さない pkc-* の規則が残っていない」**。<br>`renderMarkdown` のトークンから直接出力されない動的 DOM デコレータ（`applyTableSort`, `applyExternalLinks` 等）のクラスは、同テストの **`STYLED_ELSEWHERE` に名指しで登録**する。登録しないと orphan として落ちる。 |
| 2 | `tests/build/body-css.test.ts` | **本文 CSS 規則数上限 tripwire**（上限 220 本未満）。<br>`.pkc-md-rendered` 起点の規則数を増やしすぎると落ちる。セレクタを `:is()` 等で集約し、規則数の膨張を防ぐ。 |
| 3 | ESLint `no-useless-assignment` | `let diff = 0; if (...) diff = ...; else diff = ...;` のように全分岐で再代入される変数は無駄な代入エラーになる。三項演算子で `const` 初期化する。 |

🔑 **手順: Markdown の動的クラスや本文 CSS を足したら、`npx vitest run tests/features/markdown-css-parity.test.ts tests/build/body-css.test.ts` を実行し、`npm run lint` を確認する。**

### 🔴 触った spec の外に読み手が居る変更は、着地前に全量の smoke

「いつも出る」ようにした帯が、触っていない spec の「出ていない」という前提を壊した(2026-09-26、#1038 段 D)。
お知らせを 1 件足しただけでも起動直後の版面が変わり、全量 smoke が落ちた(2026-10-03、PR #1313)。
→ `reference/landing-incidents.md`「「いつも出る」ようにした物は共有面である」「お知らせを 1 件足すだけでも「共有面」である」

🔑 **判定は機械的に**:変更が次のどれかなら、触った spec の外に読み手が居る ── **フルを回す**。
- 今まで**出ていなかった物を、常に出す**ようにした(帯・1 語・印・色)
- 今まで**出ていた物を、出さない / 短く**した
- **既定の見え方**(色・字・位置)を変えた

⚠ 「触った file の spec」では引けない ── 読み手は「ステータスバーが見えていない」を
**前提**として持っているだけで、変えた file の名前も字も含んでいない。

🔑 **お知らせを 1 件足すのも共有面**:起動直後のお知らせのカードは shell の下の行に出て、読む面の高さを食う。着地前の全量 smoke は**お知らせを足した後の sha** で回す。
直すのは test でもお知らせの字数でもなく**製品**(`100vh` を器の高さと `min()` で結ぶ ── `read-columns.ts` の `exposePaneHeight` / `--pkc-pane-h`)。
CSS で `100vh` から引く規則を書くときは「shell の下の行(お知らせ / 注意 / 収録中 / タイマー)が出ている間も成り立つか」を 1 度問う。

🔑 CLAUDE.md「ここぞは無条件ではない(2026-09-12)」との折り合い:お知らせを足した sha で回すのは
**起動直後の版面を見る spec**(`grep -rl 'お知らせ\|notice\|toc' tests/smoke` で引く ── system-toc /
help-announce / inspector-fit / 章の箱)でよい。フルは着地直前の 1 回と兼ねる(別に 1 回足さない)。

**そのあとに**:

```bash
npm run typecheck && npm run lint && npm test
VITE_PKC_KIND=dev npm run build && node scripts/check-dist.mjs dev
npm run test:smoke
# 実ブラウザ依存に触ったなら CI と同じバイナリでもう 1 回
PKC3_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  npm run test:smoke
```

### 🔴 画面に出た赤を消してから commit する

**ツールの赤は「様式の小言」ではない。1 件ずつ中身を読んでから消す。** eslint の赤を見たまま commit して CI を赤くし、
2 件のうち 1 件は様式ではなく実害だった(2026-08-14。template literal の中の `\s` が `s` になっていた)。
1 件直したら**その command をもう一度回す**(1 件目の陰に 2 件目が居る)。
→ `reference/landing-incidents.md`「画面に出た赤を消してから commit する」

⚠ `npm run lint` の範囲は **`src tests build scripts`** ── `build/` の赤を
「CI に関係ない」と切り捨てない(CLAUDE.md の記述が `src tests` のままで、実際に踏んだ)。

### 🔴 着地前レビューの直しは **1 commit に束ねる**。お知らせは**未配布なら直してよい**(2026-10-03)

実装 + UX の 2 本のレビューを並走させ、返ってきた指摘を **1 つの commit** で直す(PR #1318 / #1320 で 2 回とも)。
⚠ 片方が返るたびに commit すると、runner の全量を**その回数**だけ回し直すことになる(1 回 15〜20 分)。
🔑 **順番**: ①両方の報告を読む → ②1 grep / 10 行で検算(「断定」の形ほど外れる) → ③束ねて直す → ④触った層の test + 門 + tsc + lint
→ ⑤commit 1 つ → ⑥runner に「全量 unit + **名指し**の smoke」(直した層の消費者を `grep -rl` で引く)── 全量 smoke は元の head の分で足りる
(delta が閉じていると言えるとき。言えないならフル)。

⚠ **お知らせは「配ったら書き換えない」が、PR の中でまだ配っていない物は直してよい**。判定は 1 つ:
`git log --oneline origin/main -S"<id>" -- src/features/notice/notice-log.ts` が **0 行**(announce.test の落ち方の字がそのまま手順になっている)。
0 行なら digest の pin(`tests/adapter/announce.test.ts`)を新しい値へ動かす ── これは「事実が動いた」側の直し。

⚠ 全量 smoke を runner に頼むときは **`timeout: 5400000` と「spec の数を数える」を依頼文に書く** ── `test.use` の spec は最後に回るので、
途中で止まると静かに取りこぼす(`.claude/agents/pkc3-runner.md` 2026-10-03 の節)。

### 🔴 最後に編集した file が test でも、`typecheck` を回し直す

`npm test` も `npm run lint` も型を見ていない。規律は「回す順」ではなく「**最後の編集の後に回す**」(上の一式を、最後に file を触ったあとにもう一度通す)。
製品コードを直して typecheck を通し、そのあと test を書き足して push したら、CI が `TS2353` で落ちた(2026-08-22)。
`tests/fixtures/**` に `.js` / `.ts` の**断片**を置くと `npm run lint` が構文解析して落ちる ── 字のまま切り出した物は **`.txt`** にする。
**push の前は `npm run lint` を全量**(file-targeted は触っていない fixture・生成物を見ない。2026-10-05、PR #1358)。
→ `reference/landing-incidents.md`「`npm test` も `npm run lint` も、型を見ていない」「`tests/fixtures/**` に `.js` / `.ts` の断片を置くと…」

## PR 本文に書くこと

- **何が起きていたか(実測)** ── 直す前の値・件数。⚠ 「改善した」ではなく**数字**
- **どう直したか** ── 判断の理由。とくに「**なぜこの形か**」
- **検証** ── 変異 N 件 KILLED / unit 件数 / smoke(どちらのブラウザで通したか)
- **配る量** ── 🔑 「予算内」ではなく **残量(KB と %)**。
  size cap は手違いの検出であって守らせる規律ではない(引き上げ可・撤廃不可)。
  ⚠ **「重いから入れない」を判断理由にしてはならない**(不可侵指示)
- **副作用として意図した変化** ── user に見える変化は隠さず書く
- 末尾に attribution footer(`---` + `_Generated by [Claude Code](https://claude.ai/code)_`)

## merge して main を同期する

```bash
# CI の結論を待つ（webhook は success を確実には届けない ── 自分で見る）
# green + 下の「止める条件」に当たらないことを確かめてから
#   → squash merge
git fetch origin main && git checkout main && git pull origin main
```

### ⚠ CI の結論は **MCP の github tool で見る**(curl で見ない)

直 curl は塞がれ、`gh` CLI も無い。**道具立てと、監視ループが沈黙する罠**は
`.claude/skills/github-tools/SKILL.md`(2026-09-05 にこの skill から切り出した)。

### 🔴 merge の `502` は「失敗」ではない ── **PR の状態ではなく main を見る**

`merge_pull_request` が `502 Server Error` を返すことがある(2026-08-13 に 2 回)。
このとき **merge は server 側の job として受理済み**で、PR の record だけが遅れる:

| 見たもの | そのとき本当は |
|---|---|
| `502 Server Error` | job が queue に入った(**失敗ではない**) |
| `pull_request_read` → `state: open` / `merged: false` | ⚠ **record が追いついていないだけ** |
| 3 回目の呼び出し → `405 Merge already in progress` | 1 回目が**まだ走っている** |

🔴 **ここで「まだ merge されていない」と読んで撃ち直すと、squash commit が 2 つ並ぶ。**
実際に `18075e1`(実体・12 file)と `34e1705`(**空**)が main に積まれた ──
差分は正しいので **CI も diff も何も鳴らない**。⚠ main の履歴にしか残らない事故である。

🔑 判定は **PR の record ではなく `origin/main` の commit** で採る:

```bash
git fetch origin main && git log --oneline -3 origin/main
```

⚠ `405 Merge already in progress` を見たら、**それは「待て」という意味**である
(`pull_request_read` が `open` を返し続けても、である)。

### 🔴 merge したら、**次の作業に入る前に**必ず branch を作り直す

```bash
git fetch --prune origin && git checkout -B <branch> origin/main && git branch --unset-upstream
```

🔑 **1 息で打つ形(2026-10-02)**。3 つの理由(目的:main に立つ時間と、main へ押す経路を作らない):
① **`--prune` に refspec を付けない**(`origin main` と書くと `origin/main` しか掃除せず、
merge 済みの `origin/<branch>` が生きて次の push が `(stale info)` になる ── 下の節)。
② `checkout -B <branch> origin/main` は **upstream を `origin/main` にする**(実際に
`branch '…' set up to track 'origin/main'` と出る)ので、素の `git push` は **main を指す**。
`--unset-upstream` で外し、push は**必ず `git push -u origin <branch>` と branch 名を明示**する。
③ `fetch` と `checkout` を分けると、その間に main に立つ時間ができる(上の「merge の直後」の事故)。

⚠ **これを飛ばすと、branch に「squash 前の commit」が残る。** そこへ次の作業を
積むと PR がこうなる:

| 症状 | 何が起きているか |
|---|---|
| `mergeable_state: dirty` で **CI が 1 つも走らない** | GitHub が merge commit を計算できない。⚠ 「Actions の障害では」と誤診しやすい |
| CI は走るが **PR の差分に前の PR の file が混ざる** | 内容が同じなので conflict にはならず、**気づけない**。squash の commit message も嘘になる |

🔑 **同じ日に 3 回踏んだ**(2026-08-12)。branch が 1 本に固定されている運用では
**merge と次の作業が必ず隣り合う**ので、`checkout -B` を merge 手順の**一部**として扱う。

剥がし方(作業を捨てずに):
```bash
git stash push -u -m wip            # 未 commit の作業が在るなら
git rebase --onto origin/main <残っている squash 前の commit>
git push --force-with-lease origin <branch>
git stash pop
```

### 🔴 commit と push の前に `git status -sb` を読む ── HEAD が detached なら push は何も運ばない(2026-10-03)

🔑 **手順**:
1. commit の前に **`git status -sb` の 1 行目**を読む ── `## HEAD (no branch)` なら、まず
   `git branch -f <branch> HEAD && git checkout <branch>`(直しは捨てない)
2. push の出力は **`tail -1` で切らない** ── `<old>..<new>  <branch> -> <branch>` の行が無い push は何も運んでいない
3. push したら **PR の `head.sha`** を引いて、自分の `git log -1` と同じかを見る(CI の緑は head の緑でしかない)
4. サブエージェントに `git checkout` を頼むときは、**worktree の path を命令に書く**
   (`cd <worktree> && git checkout …`)── cwd は `/home/user` へ戻ることがあり、戻った先から
   `cd /home/user/PKC3` されると依頼者のツリーが動く(`.claude/agents/pkc3-runner.md` 段 0)

(runner が依頼者の作業ツリーで `git checkout <sha>` を打った件 → `reference/landing-incidents.md`「commit と push の前に `git status -sb` を読む」)

### 🔑 1 本の branch で主題を 2 つ以上並行させる ── **local branch に停めて、merge 後に載せ直す**(2026-09-02)

PR #649(hotfix)の CI を待つ間に Q5 / Q6 を実装した日の形。**designated branch には
open PR の commit しか置かない**(混ぜると PR の差分が別主題を抱える):

```bash
git stash push -u -m wip && git checkout -q -b q5-local && git stash pop   # 停める
git add <名指し> && git commit -F msg.txt                                  # local に commit
git checkout -q <designated>                                               # 元へ戻る(clean)
# … 前の PR が merge されたら …
git fetch --prune origin && git checkout -B <designated> origin/main
git cherry-pick <q5-local の commit>                                       # 載せ直す
git log --oneline -2                                                       # 🔴 載ったことを目で見る
npm run typecheck && npm run lint && npm test                              # 載せ直した後に回す
```

載せ直しまわりの規則(実例は `reference/landing-incidents.md`「1 本の branch で主題を 2 つ以上並行させる」):

- **designated branch には open PR の commit しか置かない**。local に停めた commit は push されていない(この箱は作り直される)── 停めるのは次の merge を待つ間に限り、merge が来たらすぐ載せ直して push する
- 基点の古い commit を新しい main に載せたら、**全量 unit を 1 回回してから** PR にする(agent の基点 sha と載せる先の main の sha が違うなら、その間に着地した PR が触った file を `git diff --stat <基点>..origin/main` で数える。2026-10-03、PR #1306)
- 検査が落ちたまま `git checkout <別 branch>` しない(未 commit の変更が黙って持ち越される)。替える前に `git status --short | grep -v '^??'` が空であること(2026-10-02)。`git stash` は箱の中で共有されるので使わない
- `git cherry-pick -q` は無効な option で何も付けず、後ろの検査が main に対して緑を返す ── 「載った」は `git log --oneline -2` で**目で見てから**検査を回す
- `git add -A` は untracked の別主題 doc を巻き込む ── 名指しで add し、commit 直後に `git show --stat` を見る
- git・npm を打つ命令は `cd /home/user/PKC3 &&` を頭に置く(Bash の cwd が `/home/user` へ戻ることがある)
- `--continue`(rebase / cherry-pick / merge)は **`git -c core.commentChar=';' -c core.editor=true rebase --continue`** の形で打ち、直後に `git log --format='%h %s' -3` で題名を目で見る。題名を `#` で始めない(`段④b: …(#1017)` の形にする)。消えた題名は `git log -1 --format=%B <元の sha>` から戻し、`git commit --amend -F` で直す(2026-09-21 / 2026-09-26 / 2026-10-02。4 回目が起きたら文言ではなく `commit-msg` の hook で止める)
- cherry-pick の衝突は「どちらかを選ぶ」ではなく「**両方の事実を足す**」:件数(`operation-table` / `action-scope-survey` / `lid-of-node` など)は**加算**、追記どうし(CHANGELOG / 登記表 / `KNOWN` / 注釈の列)は**両方残す**。解いた後に件数を数え直す(2026-10-02)

### ⚠ **remote 追跡 ref も掃除する** ── `--force-with-lease` は**効かない**

🔴 **`git push` が `(stale info)` で落ちたら、考える前にこの節へ戻る**(直前に PR を merge したなら、原因はほぼ必ずこれ)。
🔑 **PR を merge した直後に次の作業を push するときは、`git push` を打つ前に `git fetch --prune origin`**(refspec を付けない)。
🔑 `--force-with-lease` の前に `git ls-remote origin <branch>` で相手の実在を見る ── 0 行なら lease は原理的に成立しない。
🔑 push を撃ち直してよいのは**通信の形をした失敗だけ**(`Could not resolve host` / `503` / `credential service temporarily unavailable` / `Connection reset` / タイムアウト)。
`! [rejected]`(`(stale info)` / `(non-fast-forward)` / `(fetch first)`)は待っても消えないので **1 回目で止める**。
5 度踏んだ記録(2026-08-22 / 2026-08-30 / 2026-09-14 ×2)は `reference/landing-incidents.md`「remote 追跡 ref の残骸で push が `(stale info)` になる」。

squash merge のあと、GitHub は **remote の branch を消す**。ところが手元の
`origin/<branch>` は**消える前の commit を指したまま**残るので:

```
$ git push --force-with-lease origin <branch>
 ! [rejected]  (stale info)          ← lease が「まだ在る」と思っている相手が居ない
$ git fetch origin <branch>
 fatal: couldn't find remote ref     ← そもそも消えている
```

正しいのは **prune してから普通に push**(force ではない):

```bash
git fetch --prune origin             # ⚠ refspec を付けない(下記)
git fetch origin main && git checkout -B <branch> origin/main
git push -u origin <branch>          # ← 新規作成として通る
```

🔴 **`--prune` に refspec を付けると、その ref しか掃除しない**(2026-08-13 に
この節を書いた本人が踏んだ)。`git fetch --prune origin main` は
**`origin/main` だけ**を対象にするので、消えた `origin/<branch>` は**残ったまま**。
「もう prune した」と思って `--force-with-lease` を撃ち、また `(stale info)` を
食らう ── 症状が同じなので**同じ罠だと気づけない**。
🔑 prune するときは **`git fetch --prune origin`(refspec なし)**。
確かめ方は `git ls-remote --exit-code --heads origin <branch>`
(remote に在るか無いかを、手元の追跡 ref を経由せずに聞く)。

⚠ **force が要るのは「remote の branch が生きていて、squash 前の commit を
指している」ときだけ**(= PR が open のまま作り直す場面)。そこでは
`--force-with-lease`、ただし**未 merge の commit が乗っているなら force せず
rebase して残す**。

🔑 掃除を怠ると `git status -sb` が `...origin/main` を追う形になり、
stop hook が「未 push の commit がある」と鳴く ── **鳴ったら、まず prune を疑う**。

⚠ **merge 済みの PR に新しい commit を積まない。**

### ⚠ この箱は作り直される ── **push していないものは消える**

⚠ **区切りごとに push する。** 箱の性質(作り直し / ディスクの枠 / cwd が戻る /
戻し方)は `.claude/skills/sandbox-hygiene/SKILL.md`(2026-09-05 にこの skill から
切り出した ── **PR の着地とは別の主題**である)。

### ⚠ issue を触るときの罠

閉じるついでに本文を消す型の事故は `.claude/skills/github-tools/SKILL.md`
(2026-09-05 にこの skill から切り出した)。

## 🔴 止めて裁定を仰ぐ条件

次のいずれかなら **merge せず会話で** user 判断を仰ぐ:

- **scope drift**(PR の主題から外れたものが入っている)
- **後方互換の破壊**(データ形式・書き出し形式・URL)
- **大規模 refactor** / **不可逆操作**
- **不可侵指示への抵触**(配る量を理由に機能を落とす / ワーカーを常駐させる /
  図を SVG のまま置く / JSON 文字列 body を作る 等)
- **user に見える仕様の変更** ── ⚠ 2026-08-07 に「紙のリンクを黒に落とす判断の
  取り下げ」を**レビュー応答の commit の中で勝手に決め**、レビューに指摘された。
  正しくは会話で 1 行確認する(その結果 A が裁定された)

## CI が赤いとき

🔴 **自分が作った PR は drive-to-green。** 直すか、直せない理由を PR に書く ──
黙って終わらせない。

⚠ **test を緩める前に「アプリ側が正しいか」を疑う。**
2026-08-07 に `external-images` の smoke が CI で 3 回に 1 回落ちたのは flake ではなく
**製品の穴**だった(CSP 違反の見張りが user の中身より後ろに登録されていた)。
環境のせいにして test を緩めていたら、バグごと埋めていた。

## 🔴 merge と「本番リリース」は別物(user 指示 2026-08-19)

方針の正本は CLAUDE.md「委任の境界:dev は自分で、本番は user の示唆を待つ」(user 指示 2026-08-19。不可侵)。**merge = `/dev/` へ配ること**(自分の裁定でよい)。
**本番を動かす操作は 2 つだけ**(`v*` tag の push / `release.yml` の `workflow_dispatch`)── どちらも**自分から実行しない**。

⚠ **版を上げるのは配布ではない。** `package.json` / `src/runtime/release-meta.ts` の
`APP_VERSION` を上げ、お知らせ(`notice-log.ts`)と `CHANGELOG.md` を書くところまでは
**準備**なので進めてよい ── 引き金だけ引かずに待つ。

準備の手順(2026-08-19 に実際に踏んだ順):

1. `package.json` と `APP_VERSION` を**両方**上げる(`tests/release-meta.test.ts` が一致を pin)
2. お知らせを 1 件足す。⚠ **記法を書かない**(`**` / バッククォート / `](` は
   `tests/adapter/help-pane.test.ts` が止める ── 素のテキストとして出るため)
3. `CHANGELOG.md` に**同じ見出し**で足す(`tests/docs-parity.test.ts` が対応を縛る)
4. 登記表が **`NOTICE_KEEP_MAX`(10 件 = 画面に出る数)を超えたら、いちばん古い 1 件を落とし**、
   その題名を `docs-parity.test.ts` の `DROPPED` へ 1 行足す
5. `tests/adapter/announce.test.ts` の `KNOWN` を更新
   (足した 1 件の digest を登録 / 落とした 1 件を削除。件数が一致しないと落ちる)

## 型 → 記録

事故の記録は [`reference/landing-incidents.md`](reference/landing-incidents.md)(目次つき)。型から引く:

| 型 | 見分け方 | 手順(この file) | 記録の節 |
|---|---|---|---|
| 片側だけ直した | 兄弟の面・もう一方の経路・書き出し側に同じ欠陥が残る | 「A を直した」と書いた瞬間に B を grep | 「片側を直したら、対称の反対側を疑う」 |
| 挙動や字を裏返したのに grep が足りない | 落ちた test だけ直した / `head` で切った / `tests/*.ts` が階層を降りない | 書き換えた**字**で `tests/` を再帰 grep(`head` を付けない) | 「挙動や字を「裏返した」ら、`tests/` を全数 grep する」 |
| 口を足したのに全数検査に捕まる | `tests/adapter` `tests/features` しか回さず CI が赤 | 上の「UI の口を 1 つ足すと動く全数検査の一覧」+ `npx vitest run tests/` を 1 回 | 「押し所(`data-pkc-action`)を足したら、`tests/` を全部回す」 |
| 見え方が変わるのに触った spec しか回さない | 帯・お知らせ・既定の見え方を変えた | 上の「触った spec の外に読み手が居る変更は…」 | 「「いつも出る」ようにした物は共有面である」ほか |
| 赤を見たまま commit / 型を見ていない | ツールの赤を様式の小言と読む / 最後の編集が test | 「最後の編集の後に回す」 | 「画面に出た赤を消してから commit する」ほか |
| レビュー応答の commit で見え方を決める | 差分に色・字・挙動の変更が混ざる | 下の「止めて裁定を仰ぐ条件」 | 「user に見える仕様を、レビュー応答の commit の中で決めない」 |
| merge 直後に main に立つ / `(stale info)` | 指定 branch を外して main に積む / push が断られる | 「merge したら、次の作業に入る前に必ず branch を作り直す」「remote 追跡 ref も掃除する」 | 「merge した直後、`main` に立ったまま次の仕事を始めない」ほか |
| detached HEAD で push が空振り | `Everything up-to-date` の顔で何も運ばない | 「commit と push の前に `git status -sb` を読む」 | 同名の節 |
| 門を手で呼んで「掛かっている」と読む | hooksPath が作業ツリー内を指し、main 上でだけ hook が消える | 止めるはずの操作を本物の道具で 1 回通す | 「門は、止めるはずの操作を本物の道具で 1 回通して確かめる」 |
| 編集ツールが生バイトを埋める / flake に見える製品の穴 | 書き換え後に制御文字 / CI で間欠に赤 | 書き換えたらバイト走査 / test を緩める前にアプリ側を疑う | 「編集ツールが制御文字を生バイトで書く」「flake に見えるものが製品の穴だった」 |

## 自己点検(PR を出す前)

- [ ] 主題は 1 つ(別主題が同居するなら commit を分け、PR 本文に明記した)。導線(`CLAUDE.md` → `.claude/…`)は実体と同じ commit
- [ ] 変異試験・code review(修正したら 2 巡目)・視覚を持つ変更なら smoke を、**最後の編集の前**に済ませた
- [ ] 口(`data-pkc-action` / 動的 class / 設定)を足したなら `npx vitest run tests/` を 1 回回し、直した数は「何が動いたか」を 1 行言える
- [ ] 最後に file を触った後で `typecheck` / `lint`(全量)/ `npm test` を回し、画面の赤を 1 件ずつ読んだ
- [ ] push の前に `git status -sb` の 1 行目を読み、push 後に PR の `head.sha` を自分の `git log -1` と突き合わせた
- [ ] PR 本文は実測(直す前の値)・理由・検証・**残量(KB と %)**・user に見える変化を書いた
- [ ] merge の `502` は失敗と読まず `origin/main` を見た。merge 後は `git fetch --prune origin && git checkout -B <branch> origin/main && git branch --unset-upstream`
- [ ] 「止めて裁定を仰ぐ条件」に当たらない。本番(tag / `release.yml`)は引いていない
