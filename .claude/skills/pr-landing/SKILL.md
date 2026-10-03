---
name: pr-landing
description: PKC3 の PR を作ってから CI green 確認 → 自己監査 → squash merge → main 同期まで回す手順。merge は user から Claude に委任済み(2026-08-04)だが、止めて裁定を仰ぐ条件がある。1 PR 1 主題の原則と、ブランチが 1 本に固定されているときの折り合いも。「PR を作る」「着地させて」「merge して」「CI 見といて」という文脈で使う。
---

# PR を着地させる(PKC3)

> **user 委任 2026-08-04**: 「**チェックリスト以外はあなたにすべて委任します**」/
> 繰り返し「**main に入れてくれ / Pages で見たいから**」。
> ⚠ 出典タグ付き = 不可侵。**ただし下記「止める条件」は残る。**

## 1. 主題は 1 つ

**1 PR 1 主題。** 既存問題を見つけたら別 PR へ剥がす ── wave に紛れ込ませない。

⚠ **PKC3 は作業ブランチが 1 本に固定されている**(`claude/…`)。別主題を別 PR に
できないことがある。そのときは:

1. **commit を分ける**(主題ごと。commit message に理由まで書く)
2. **PR 本文に「別主題が同居している」と明記**する
3. 剥がしたければ **user に別ブランチの許可を求める**

🔑 それでも**混ぜてはいけないものが 1 つある** ── **導線と実体**。
`CLAUDE.md` が `.claude/…` を指す変更は、**実体と同じ commit**に入れる。
2026-08-07 に、実体をまだ commit していないのに導線だけ commit して amend で剥がした。

## 2. 着地前のチェック(この順で)

**先に**(⚠ どれも**作業ツリーを触る**ので、下の一式より前に済ませる):
- **変異試験**(`.claude/skills/mutation-testing/`)── 生き延びたものが無いこと
- **code review**(`.claude/commands/review.md`)── **修正したら 2 巡目**を回す
- **視覚を持つ変更**なら smoke 最低 1 件(`.claude/skills/smoke-testing/`)

🔴 **順序が逆だと嘘の緑を見る。** 2026-08-10 に、変異試験のスイープの最後で
バックアップが書き戻されて**直したはずの実装が巻き戻り**、そのまま commit して CI が
赤くなった ── 手元では**スイープの前**に緑を見ていたので「通ったのに落ちた」に見える。

### 🔴 押し所(`data-pkc-action`)を足したら、**`tests/` を全部回す**(2026-09-16)

⚠ ボタンを 1 つ足しただけで、**等値で pin している検査 5 つに順に捕まった**:

| # | 何が鳴ったか |
|---|---|
| 1 | 押し所の棚卸し(`collection-commands`)── 並びごと等値 |
| 2 | マニュアル突合(`docs-parity`)── 設定へ逃がした操作の名前 |
| 3 | お知らせ(`announce`)── 枠 30 件と digest |
| 4 | **全数台帳**(`operation-table`)── 名前 + **件数 3 つ** |
| 5 | **受け手の仕分け**(`action-scope-survey`)── 件数 + **doc §7.1 の表** |

🔴 **1・2・3 は手元で直したのに、4・5 で CI を 2 回赤くした。**
⚠ 理由は 1 つ:`tests/adapter/` と `tests/features/` しか回さず、
**`tests/` 直下を 1 度も回していなかった**。

🔑 **検算は「grep では足りない」** ── 4・5 が持っているのは
**件数だけ**(`total: 316` / `N: 138`)で、**足した名前はどこにも書いていない**。
だから `grep -rn "<足した名前>" tests/` は **0 件**を返し、「他に無い」と読んでしまう。

⚠ そして **5 は 2 つ落ちるのが正しい** ── 片方は「実装と pin が一致するか」、
もう片方は「**doc だけが古くなっていないか**」。doc を直さないと、
次に読む人が**古い数を根拠に判断する**。

🔑 **手順:`data-pkc-action` を足したら、`npx vitest run tests/` を 1 回**
(`tests/adapter` / `tests/features` の下だけでは、この 5 つのうち 2 つに届かない)。

### 🔴 UI の口を 1 つ足すと動く**全数検査の一覧** ── 依頼文に写す(2026-10-02)

上の 5 つは 2026-09-16 の実測で、その後も **「触った層だけ回して push → CI 赤」** が続いた
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
上の 5 つの教訓と同じ。件数しか持たない検査は、足した名前を 1 つも書いていない)。
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

### 🔴 「いつも出る」ようにした物は**共有面**である ── 着地前にフル smoke(2026-09-26)

⚠ #1038 段 D(C4)で、**編集中は画面のいちばん下の行に「編集中」が常に出る**ようにした。
触った spec(編集の開始 / 付箋 / お知らせの目次 / 書式 / 追記欄)だけ回して着地させたら、
**main で smoke が 2 本落ちていた**(#1065 で直した):

| 落ちた検査 | 何を前提にしていたか |
|---|---|
| `body-links:202` | 「編集に入った時点ではステータスバーが**見えていない**」 |
| `context-menu:365` | 同上 |

🔴 **しかも片方は、前提を直しただけでは空振りのまま残る形だった** ── 押した後の検査が
「帯が見える」「『編集』の字を含む」で、どちらも**押す前から「編集中」の 1 語に満たされる**
(断り文が出なくても通る)。断り文そのものを見る形に直し、変異で落ちることを確かめた。

🔑 **判定は機械的に**:変更が次のどれかなら、触った spec の外に読み手が居る ── **フルを回す**。
- 今まで**出ていなかった物を、常に出す**ようにした(帯・1 語・印・色)
- 今まで**出ていた物を、出さない / 短く**した
- **既定の見え方**(色・字・位置)を変えた

⚠ 「触った file の spec」では引けない ── 読み手は「ステータスバーが見えていない」を
**前提**として持っているだけで、変えた file の名前も字も含んでいない。

#### 🔴 **お知らせを 1 件足すだけでも「共有面」である**(2026-10-03、PR #1313)

⚠ 起動直後のお知らせのカードは shell の下の行に出て、**読む面の器の高さを食う**(上限 30vh)。
5 項目のお知らせ(1280 幅で 30vh まで伸びる)を足した commit **だけ**で、全量 smoke の
「45 行の章は見出しもボタンも画面に収まる(1280x800)」が落ちた ── 章の箱の上限 `100vh − 300px` が
「読む面の高さは常に viewport − 206px」を前提にしており、**カードが出ている間は偽**だった
(器 560px、見える 526px、箱 530px。見出しが帯の下へ 8px)。bisect:main 緑 / 直しの commit 緑 / お知らせの commit 赤。
🔑 **お知らせは文字列の追加ではなく、起動直後の版面の変更**である ── 字数が増えれば読む面が縮む。
着地前の全量 smoke は**お知らせを足した後の sha**で回す(足す前の sha の緑は、この壊れ方を見ていない)。
🔑 そして直すのは test でもお知らせの字数でもなく**製品**(`100vh` を器の高さと `min()` で結ぶ ──
`read-columns.ts` の `exposePaneHeight` / `--pkc-pane-h`)。CSS で `100vh` から引く規則を書くときは
**「shell の下の行(お知らせ / 注意 / 収録中 / タイマー)が出ている間も成り立つか」**を 1 度問う。

**そのあとに**:

```bash
npm run typecheck && npm run lint && npm test
VITE_PKC_KIND=dev npm run build && node scripts/check-dist.mjs dev
npm run test:smoke
# 実ブラウザ依存に触ったなら CI と同じバイナリでもう 1 回
PKC3_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  npm run test:smoke
```

🔴 **画面に出た赤を消してから commit する**(2026-08-14)。eslint の赤を**見たまま**
commit して CI を赤くした。⚠ **2 件のうち 1 件は様式ではなく実害**だった ── 窓の題名を
採る式が template literal の中に在るので `\s` が**リテラルに食われて `s` になり**、
「文字 s の連続」を置換する正規表現になっていた。⚠ たまたま該当が無く**出力が変わらない**
ので、**赤を消さなければ永久に露見しない**形だった。
🔑 **ツールの赤は「様式の小言」ではない。1 件ずつ中身を読んでから消す。**
🔑 1 件直したら**その command をもう一度回す**(1 件目の陰に 2 件目が居る)。

⚠ `npm run lint` の範囲は **`src tests build scripts`** ── `build/` の赤を
「CI に関係ない」と切り捨てない(CLAUDE.md の記述が `src tests` のままで、実際に踏んだ)。

### 🔴 **`npm test` も `npm run lint` も、型を見ていない**(2026-08-22)

**最後に編集した file が test でも、`typecheck` を回し直す。**

実際に踏んだ形 ── 製品コードを直して `typecheck` を通し、**そのあとに test を書き足し**、
`lint` と `npm test`(4046 件緑)を回して push した。CI は `typecheck` で落ちた:

```
tests/adapter/…test.ts(78,65): error TS2353:
  'deletedAt' does not exist in type 'TrashItem'
```

⚠ **手元の緑が 1 つも鳴らない**のが厄介である ── `vitest` は型を落として実行し、
`eslint` は型を見ない。**test の fixture の型違いは、CI でしか鳴らない。**

🔑 規律は「回す順」ではなく「**最後の編集の後に回す**」:
上の一式は**最後に file を触ったあと**にもう一度通す(1 つ直したら、また通す)。
⚠ これは §「1 件直したらその command をもう一度回す」の**別の面**である
── あちらは「同じ command の 2 件目」、こちらは「**別の command が見ていない次元**」。

## 3. PR 本文に書くこと

- **何が起きていたか(実測)** ── 直す前の値・件数。⚠ 「改善した」ではなく**数字**
- **どう直したか** ── 判断の理由。とくに「**なぜこの形か**」
- **検証** ── 変異 N 件 KILLED / unit 件数 / smoke(どちらのブラウザで通したか)
- **配る量** ── 🔑 「予算内」ではなく **残量(KB と %)**。
  size cap は手違いの検出であって守らせる規律ではない(引き上げ可・撤廃不可)。
  ⚠ **「重いから入れない」を判断理由にしてはならない**(不可侵指示)
- **副作用として意図した変化** ── user に見える変化は隠さず書く
- 末尾に attribution footer(`---` + `_Generated by [Claude Code](https://claude.ai/code)_`)

## 4. merge して main を同期する

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

⚠ 全量 smoke を頼んだ runner に「`git checkout <sha>` してから回せ」と書いたら、runner は
**依頼者の作業ツリーで**それを打った(worktree ではなく)── 私の HEAD は detached になり、
その上に積んだ直しの commit は branch に乗らず、`git push -u origin <branch>` は
**「Everything up-to-date」で成功した顔**をした(`| tail -1` で切っていたので読まなかった)。
PR の head は古い sha のまま、CI もその sha で緑 ── **安全網の check-in で PR の head を引いて初めて気づいた**。
🔑 **手順**:
1. commit の前に **`git status -sb` の 1 行目**を読む ── `## HEAD (no branch)` なら、まず
   `git branch -f <branch> HEAD && git checkout <branch>`(直しは捨てない)
2. push の出力は **`tail -1` で切らない** ── `<old>..<new>  <branch> -> <branch>` の行が無い push は何も運んでいない
3. push したら **PR の `head.sha`** を引いて、自分の `git log -1` と同じかを見る(CI の緑は head の緑でしかない)
4. サブエージェントに `git checkout` を頼むときは、**worktree の path を命令に書く**
   (`cd <worktree> && git checkout …`)── cwd は `/home/user` へ戻ることがあり、戻った先から
   `cd /home/user/PKC3` されると依頼者のツリーが動く(`.claude/agents/pkc3-runner.md` 段 0)

### 🔑 1 本の branch で主題を 2 つ以上並行させる ── **local branch に停めて、merge 後に載せ直す**(2026-09-02)

#### 🔴 基点の古い commit を新しい main に載せたら、**全量 unit を 1 回回してから** PR にする(2026-10-03、PR #1306)

agent の worktree は依頼を出した時点の main から作られる。その間に別の PR が着地すると、
agent が回した「全量緑」は**着地前の main に対して**であって、載せ直した後の版は誰も回していない。
実例:#529 Q3 の agent(基点 `f4abb337`)が位置の変数 `--pkc-place-x` を足し、その間に着地した
#1304 の test が「色の変数が無い」を **`--pkc-place` の前方一致**で見ていた ── cherry-pick 後に
依頼者が回したのは notice の門 + 触った file の test だけで、**CI で初めて赤くなった**。
🔑 検算は 1 つ:**agent の基点 sha と、載せる先の main の sha が違うか。** 違うなら
① その間に着地した PR が触った file を `git diff --stat <基点>..origin/main` で数え、
② 全量 unit を runner(haiku)に投げて緑を見てから push する(3 分。CI の赤 1 回のほうが高い)。
⚠ 「触った file の test は緑」は、**相手側の test が自分の file を見ている**形を拾えない。


#### 🔴 検査が落ちたまま `git checkout <別 branch>` しない(2026-10-02)

お知らせを足して全数検査を回し、**1 件落ちたので commit せずに**元の branch へ `git checkout` した ──
git は未 commit の変更を**黙って持ち越す**ので、お知らせの編集が**別の branch の作業ツリーに乗った**
(気づいたのは次の `git status`)。落ちた検査が負荷の timeout だったので、戻って単独で回し直して commit した。
🔑 branch を替える前に **`git status --short | grep -v '^??'` が空**であることを見る。空でないなら
commit(WIP でよい)してから替える。⚠ `git stash` は箱の中で共有される(worktree の注意書き)── 使わない。

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

⚠ **3 つ踏んだ**(同日):
- 🔴 **`git cherry-pick -q` は無効な option** ── usage を出して**何も付けず**、
  その後ろに `;` で繋いだ typecheck / lint / `npm test` は **main そのものに対して緑**を
  返した。「載った」は `git log --oneline -2` で**目で見てから**検査を回す
- 🔴 **`git add -A` が untracked の doc(230KB の調査 doc)を hotfix commit に巻き込んだ** ──
  気づけたのは commit 直後の `git show --stat` だけ。**名指しで add する**か、
  `git status --short` の `??` を commit の前に読む。⚠ 別主題の doc は**別の PR**である
- ⚠ **この箱は Bash の cwd が `/home/user` へ戻ることがある**(同日 2 回)──
  `git` が `not a git repository` を返し、その後ろの検査が exit 128 / 254 で空振りした。
  git・npm を打つ命令は **`cd /home/user/PKC3 &&` を頭に置く**
- ⚠ **local に停めた commit は push されていない** ── この箱は作り直される(下の節)。
  停めるのは**次の merge を待つ間**に限り、merge が来たらすぐ載せ直して push する
- 🔴 **`git cherry-pick --continue` が commit の題名を食う**(2026-09-21)。
  競合を解いて `GIT_EDITOR=true git cherry-pick --continue` したら、元の題名が
  `#1017 段④b: …` と **`#` で始まっていた**ので、git がコメント行として**削除**し、
  本文の 1 行目が題名になった(`git log --oneline` で発覚)。
  🔑 **題名を `#` で始めない**(`段④b: …(#1017)` の形にする)/ 既に `#` 始まりの
  題名を戻す必要があるなら `git -c core.commentChar=';' cherry-pick --continue` か
  `git commit --cleanup=verbatim` で守る
  - 🔴 **2026-09-26 に `git rebase --continue` で 3 回続けて踏んだ**(#1038 段 D / G / J を
    main へ載せ直したとき)。⚠ **この bullet を読まずに**、題名を全部 `#1038 段…` で
    始めていた。症状は同じ ── 衝突を解いて `GIT_EDITOR=true git rebase --continue` すると、
    題名が消えて**本文の 1 行目が題名になる**(使い捨ての repo で再現:素通しなら消え、
    `-c core.commentChar=';'` なら残る)。
    🔑 **手順にする**:`--continue`(rebase / cherry-pick / merge)は**必ず**
    `git -c core.commentChar=';' -c core.editor=true rebase --continue` の形で打ち、
    直後に `git log --format='%h %s' -3` で**題名を目で見る**。
    ⚠ 消えた題名は `git log -1 --format=%B <元の sha>` から戻せる(元の commit は reflog と
    worktree に残る)── 戻すときは `git commit --amend -F` で。
    🔴 **2026-10-02 にも cherry-pick で再発**(下の「4 回目が起きたら」の条件は既に満ちている ── hook 化は依頼者の判断に返す):smoke spec の衝突を「両方残す」で解き、
    `git -c core.editor=true cherry-pick --continue` と打った ── **`core.commentChar` を落としていた**ので、
    件名が消えて本文の箇条書き(`- place-embed.ts: …`)が件名になった(`git log --oneline` で発覚)。
    🔑 打つ形は**上の 1 本に固定**(`-c core.commentChar=';' -c core.editor=true`)し、直後に
    `git log -1 --format=%s` を見る。落ちていたら push 前に `commit --amend -F` で戻す
    (自分の branch・push 前なので amend してよい)。
    ⚠ **4 回目が起きたら、文言ではなく `commit-msg` の hook で止める**
    (`.githooks/` と `scripts/install-hooks.mjs` の形に倣う)
- 🔴 **cherry-pick の衝突は、「どちらかを選ぶ」ではなく「両方の事実を足す」**(2026-10-02。
  並行した PR の変更は、**台帳の件数や追記の列など同じ行**で衝突しやすい)。
  目的:**片方の事実を黙って落とさない**こと(落とすと、件数や追記が実装と食い違う)。
  🔑 手順:①**件数**(`operation-table` / `action-scope-survey` / `lid-of-node` など)は
  **加算**する(両方の変更ぶんが足された数にする ── どちらか一方の数を採らない)
  ②**追記どうし**(CHANGELOG / 登記表 / `KNOWN` / 注釈の列)は**両方残す**(順序だけ決める)
  ③解いたら `git -c core.editor=true cherry-pick --continue`(題名が `#` 始まりなら
  上の `core.commentChar` を併せる)、直後に `git log --format='%h %s' -3` で目で見る
  ④**衝突を解いた後に件数を数え直す**(加算が合っているかは、全量の unit が教える)。

### ⚠ **remote 追跡 ref も掃除する** ── `--force-with-lease` は**効かない**

> 🔴 **2026-08-22 に 2 度目を踏んだ。** この節は**既に在った**のに、push の直前に
> 読まなかった(症状も手順もここに書いてあるとおりだった)。
> 🔑 **`git push` が `(stale info)` で落ちたら、考える前にこの節へ戻る** ──
> 直前に PR を merge したなら、原因は**ほぼ必ずこれ**である。
>
> 🔴 **2026-08-30 に 3 度目を踏んだ。** 今度は skill を**そもそも開いていない** ──
> `ls-remote` と ancestor 判定で**一から診断し直した**(着く所は同じだが、
> 1 分で済む所に 3 手かけ、`--force-with-lease` を**存在しない相手へ 2 回**投げた)。
> ⚠ **戒めの中身ではなく、引く条件が効いていない。**
> 🔑 だから条件を**行動で**書く ── **PR を merge した直後に次の作業を push するときは、
> `git push` を打つ前に `git fetch --prune origin` を打つ**。
> ⚠ 「落ちたら読む」は、**落ちた時に読むことを覚えていないと効かない**。
> 🔑 `--force-with-lease` を使う前に **`git ls-remote origin <branch>` で相手の実在を見る**
> ── 0 行なら lease は**原理的に成立しない**(force を重ねても永久に通らない)。
>
> 🔴 **2026-09-14 に 4 度目 ── 今度は「読まなかった」のではなく、道具が消した。**
> ⚠ 上の 3 回は**引く条件**の話だったが、この日は条件が発火する手前で潰れた ──
> 私の push は**どんな失敗でも 5 回まで指数 backoff で撃ち直す包み**に入っており、
> `(stale info)` を**通信の不調と同じ扱い**で 5 回投げ直した(**全部同じ理由で落ちる**)。
> 🔴 **画面に出たのは同じ 1 行が 5 回**で、そのぶん「相手が消えている」という
> 手掛かりが**流れて見えなくなった**。
> 🔑 **だから直すのは戒めではなく、包みのほうである** ── 再試行してよいのは
> **通信の形をした失敗だけ**(`Could not resolve host` / `503` /
> `credential service temporarily unavailable` / `Connection reset` / タイムアウト)。
> ⚠ **`rejected` が出たら 1 回目で止める** ── `(stale info)` /
> `(non-fast-forward)` / `(fetch first)` は**待っても消えない**。
>
> ```bash
> # 🔑 再試行してよいのは通信の形だけ。`rejected` は 1 回目で止める
> for i in 1 2 3 4 5; do
>   git push -u origin "$BR" > /tmp/push.log 2>&1 && break
>   if grep -q '! \[rejected\]' /tmp/push.log; then
>     echo "🔴 rejected ── 待っても消えない。この節の先頭へ戻る"; cat /tmp/push.log; break
>   fi
>   sleep $((2 ** i))
> done
> ```
>
> 🔴 **2026-09-14 に 5 度目 ── 包みは直っていた(1 回目で止まった)が、私が読まなかった。**
> ⚠ 止まった後にやったのは、この節を開くことではなく **`--force-with-lease` をもう 1 回**
> (相手が居ないので当然また `(stale info)`)。正体が出たのは 3 手目の
> `git fetch origin <branch>` → `couldn't find remote ref` である。
> ⚠ **4 度目までの直しは全部「読む条件」の話**で、5 度目はその条件が**また効かなかった** ──
> 🔑 **だから戒めを 6 つ目にせず、手順の側を変えた**:CLAUDE.md の merge 直後の同期を
> **`git fetch --prune origin`(refspec 無し)**にした。⚠ 以前は
> `git fetch --prune origin main` と書いてあり、**`origin/main` しか掃除しない**ので
> 残骸が必ず生き残る形だった ── **1 語落とすだけで、この経路が構造から消える**。
>
> 🔑 一般形:**「落ちたらこれを読む」という戒めは、落ちたことが見える形でしか効かない。**
> ⚠ 再試行の包みは**失敗を 1 行から N 行に増やすだけで、内容は同じ**なので、
> **診断すべき失敗ほど埋もれる**(CLAUDE.md §6「shell と CI が『失敗した』を食べる」の
> **再試行版**である ── あちらは exit code、こちらは**画面の可読性**が食われる)。

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

## 5. 🔴 止めて裁定を仰ぐ条件

次のいずれかなら **merge せず会話で** user 判断を仰ぐ:

- **scope drift**(PR の主題から外れたものが入っている)
- **後方互換の破壊**(データ形式・書き出し形式・URL)
- **大規模 refactor** / **不可逆操作**
- **不可侵指示への抵触**(配る量を理由に機能を落とす / ワーカーを常駐させる /
  図を SVG のまま置く / JSON 文字列 body を作る 等)
- **user に見える仕様の変更** ── ⚠ 2026-08-07 に「紙のリンクを黒に落とす判断の
  取り下げ」を**レビュー応答の commit の中で勝手に決め**、レビューに指摘された。
  正しくは会話で 1 行確認する(その結果 A が裁定された)

## 6. CI が赤いとき

🔴 **自分が作った PR は drive-to-green。** 直すか、直せない理由を PR に書く ──
黙って終わらせない。

⚠ **test を緩める前に「アプリ側が正しいか」を疑う。**
2026-08-07 に `external-images` の smoke が CI で 3 回に 1 回落ちたのは flake ではなく
**製品の穴**だった(CSP 違反の見張りが user の中身より後ろに登録されていた)。
環境のせいにして test を緩めていたら、バグごと埋めていた。

## 7. 🔴 merge と「本番リリース」は別物(user 指示 2026-08-19)

**merge = `/dev/` へ配ること。** これは自分の裁定でやってよい。
**本番リリース = `/`(最新の安定 tag)を動かすこと。⚠ user の示唆を待つ。**

本番を動かす操作は **2 つだけ**。どちらも**自分から実行しない**:

1. `v*` tag を push する
2. `release.yml` を `workflow_dispatch` で起動する

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

🔑 **理由は「不可逆」** ── dev は壊しても読み直せば直るが、本番は user の手元へ届いて
取り消せない。規律の正本は `CLAUDE.md`「委任の境界」。
