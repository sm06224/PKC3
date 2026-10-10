# PR 着地まわりの事故 ── 直し漏れ・編集ツール・merge 直後・CI の赤・branch の扱い ── 事故の記録

> 手順は [`../SKILL.md`](../SKILL.md)。ここは**事故の記録**(日付と issue 番号つき)。
> 🔑 読む条件:挙動や字を「裏返した」と書こうとした瞬間 / 1 か所を直した瞬間 / PR を merge した直後 /
> review の応答 commit で user に見える仕様を変えようとした瞬間。
> 追加の読む条件:`data-pkc-action` / 動的な class / 設定 / 常に出る帯・お知らせを足した瞬間 / push・commit の直前 /
> 1 本の branch に別主題を停める・cherry-pick する瞬間 / `git push` が `(stale info)` で落ちた瞬間。

目次:

- 片側を直したら、対称の反対側を疑う
- 挙動や字を「裏返した」ら、`tests/` を全数 grep する(単体が落ちた分は「全部」ではない)
- user に見える仕様を、レビュー応答の commit の中で決めない
- 編集ツールが制御文字を生バイトで書く
- flake に見えるものが製品の穴だった
- merge した直後、`main` に立ったまま次の仕事を始めない
- 門は、止めるはずの操作を本物の道具で 1 回通して確かめる(`main` 上の commit を断る hook)
- 🔴 押し所(`data-pkc-action`)を足したら、**`tests/` を全部回す**(2026-09-16)
- 🔴 「いつも出る」ようにした物は**共有面**である ── 着地前にフル smoke(2026-09-26)
- 🔴 **お知らせを 1 件足すだけでも「共有面」である**(2026-10-03、PR #1313)
- 🔴 画面に出た赤を消してから commit する(2026-08-14)
- 🔴 **`npm test` も `npm run lint` も、型を見ていない**(2026-08-22)
- 🔴 `tests/fixtures/**` に **`.js` / `.ts` の断片**を置くと、`npm run lint` がそれを構文解析して落ちる(2026-10-05、PR #1358)
- 🔴 commit と push の前に `git status -sb` を読む ── HEAD が detached なら push は何も運ばない(2026-10-03)
- 🔑 1 本の branch で主題を 2 つ以上並行させる ── **local branch に停めて、merge 後に載せ直す**(2026-09-02)
- 🔴 remote 追跡 ref の残骸で push が `(stale info)` になる ── 5 度の記録(2026-08-22 / 2026-08-30 / 2026-09-14 ×2)

## 片側を直したら、対称の反対側を疑う

- **型**:同じ欠陥が対称の位置(兄弟の面・もう一方の経路・書き出し側)に残る。
- **見分け方**:「A を直した」と書いた瞬間に「B はどうか」を問える。test の import 一覧に直し忘れた面が出る。
- **直し方**:「A を直した」と書いた瞬間に B を grep する。1 巡目の修正は、2 巡目の対象である。

🔴 **片側を直したら、対称の反対側を必ず疑う**(2026-08-07)。検品を「出力の文字列を
見る」形に直したのに、**トークンだけ直して規則は需要側の数を見たまま**だった ──
組み立てを消すと検品が合格し、**規則 0 本の CSS が出荷される**(実測)。
🔑 **1 巡目の修正は、2 巡目の対象である**

⚠ **同じ日に 3 回踏んだ。**(1) 情報ペインとファイラの「器を捨てない」を直したのに
**本文の面が同型のまま残り**、回帰 test も**その 2 面しか import していなかった** ──
保存直後の「編集」が無言の dead click になっていた (2) `:::` の空行正規化は
在るのに**改頁(`+++`)側に無く**、素直に書くと改頁が消えて `auto` の字が出ていた
(3) parity test は `app.css` 側だけコメントを剥いでいて、**書き出し側は剥いでいなかった**。
🔑 **「A を直した」と書いた瞬間に「B はどうか」を grep する**。
とくに **test の import 一覧**は、直し忘れた面が一目で分かる場所である

## 挙動や字を「裏返した」ら、`tests/` を全数 grep する(単体が落ちた分は「全部」ではない)

- **型**:落ちた test を直して満足した / grep を打たなかった / grep を打ったが `head` で切った。
- **見分け方**:裏返した挙動や字を pin している検査が、unit・smoke・別の階層(`tests/build/` など)に残る。
- **直し方**:「裏返した」と書いた瞬間に、**書き換えた字**で `tests/` を再帰 grep する(`head` を付けない)。直し方は「字を戻す」ではなく、主張が強くなったなら test も強いほうへ書き直す。

🔴 **4 回目は「単体が落ちてくれた」ことで数え上げを止めた**(2026-09-16、#682 段③c)。
⚠ 挙動を**裏返した**(「選べる物が 1 つなら選び所を隠す」をやめた)とき、
**その古い挙動を pin していた unit 3 本が落ちてくれた**ので書き直した ──
🔴 **そこで満足して `tests/smoke` を 1 度も grep しなかった。**
実ブラウザの検査(`attach.smoke.spec.ts`)に `.xlsx` で `toBeHidden()` を
要求する行が残っており、**着地前 smoke が落ちて初めて分かった**。
🔑 **落ちた test は「見つかった分」であって「全部」ではない。**
⚠ unit と smoke は**走る場所が違う**ので、片方だけ直しても**もう片方は緑にならない**
(むしろ赤くなって気づけたのは幸運で、比較が「含む」なら静かに通っていた)。
🔑 機械的な合図:**「挙動を裏返した」と書いたら、`tests/` を全数 grep して
落ちるべき検査を数え上げる** ── 数え上げの終わりは「grep が 0 件」であって、
「走らせた test が緑」ではない

🔴 **5 回目は、その戒めを書いた 2 時間後に踏んだ**(2026-09-16、#918 段⑤d-2)。
⚠ 4 回目は「落ちた test を直して満足した」だが、こちらは**grep を 1 度も打っていない**
── 構造 1 枚の見出しを `表 / ビュー:` から `表 / ビュー / 本文の表:` へ裏返し、
**触った層の test だけ回して push した**(全量はサブエージェントに投げてあり、
**結果を待たなかった**)。🔴 **CI が赤くなって初めて分かった** ──
古い字を pin していたのは `tests/features/schema-digest.test.ts` の 2 件で、
**1 回の grep(`grep -rn '表 / ビュー' src/ tests/ docs/`)で 5 行**出る。
🔑 だから合図を**時点**で書き直す:**「裏返した」と書いた瞬間に grep する** ──
⚠ 「全量を投げてあるから」は理由にならない(**投げた結果を待たずに push する**なら、
投げていないのと同じである)。
🔑 そして**直し方は「字を戻す」ではなかった** ── 本文の csv が 0 件の相手で
「本文の表」と名乗ると**0 件の物を数えたように読める**ので、
**数えた物の名前だけを書く**形にした(落ちた test は「期待値が古い」ではなく
「**実装の字が間違っている**」と教えていた)

🔴 **6 回目 ── grep は打った。`head -10` で切った**(2026-09-20、#1014)。
⚠ 5 回目は*grep を打っていない*だが、こちらは**打って、答えを自分で切り落とした**。
実例:`build/portable/fold.mjs` の**門のエラーメッセージ**を書き換えたとき、
`grep -rln "fold.mjs\|portable" tests/ | head -10` を打ち、**出た 10 件のうち 2 件**を回した。
🔴 実際の当たりは **29 件**で、pin を持つ `tests/build/portable-fold.test.ts` は
**27 行目**だった ── **切った側に在った**。⚠ 次に打った
`grep -rln "build/portable" tests/*.ts` も外した:**`tests/*.ts` は下の階層へ降りない**
ので `tests/build/` が丸ごと見えない(再帰なら 5 件出る)。**CI が赤くなって分かった**。
🔑 **検算は 2 つ**:
① 🔴 **数え上げの grep に `head` を付けない。** 切った 10 件は**答えの顔**をしており、
⚠ **何件切ったかは画面に出ない** ── 件数が要るなら `| wc -l` を併せて打つ。
② 🔑 **引くのは「触った file の名前」ではなく「書き換えた字」である** ──
この件なら `grep -rn '解決式に当たらなかった' tests/` が **1 行**返す(1 秒・切る余地なし)。
⚠ file 名で引くと**広すぎて切りたくなる**のが、そもそもの入口である。
🔑 そして**直し方は「字を戻す」ではない**(5 回目と同じ結論)── 門の主張が
「名前で始まる chunk だけ見る」から「**どの chunk にも残さない**」へ**強くなった**
のだから、test も**強いほうへ**書き直す(古い字へ戻すと、直した意味が消える)。

## user に見える仕様を、レビュー応答の commit の中で決めない

- **型**:レビューへの応答として、見た目や挙動の仕様をその場で変えた。
- **見分け方**:応答 commit の差分に、user に見える変更(色・字・挙動)が混ざっている。
- **直し方**:会話で 1 行確認してから入れる。

🔴 **user に見える仕様を、レビュー応答の commit の中で勝手に決めない。**
会話で 1 行確認する(2026-08-07「紙のリンクを黒に落とす判断の取り下げ」で踏み、
確認した結果 **A: このまま**が裁定された)

## 編集ツールが制御文字を生バイトで書く

- **型**:編集ツールが、escape を書いたつもりの箇所に制御文字の生バイトを埋める。
- **見分け方**:`repo-hygiene` の走査に引っかかる / `od -c` で生バイトが見える。
- **直し方**:書き換えたらバイト走査する(`source-editing/`)。

🔴 **編集ツールが制御文字を生バイトで書くことがある。** escape を書いたつもりでも
入る(1 セッションで 3 回)── 書き換えたら**バイト走査する**
(`source-editing/`)。⚠ 制御文字を避けられるなら私用領域(``)を使う

## flake に見えるものが製品の穴だった

- **型**:間欠で落ちる test を、環境の揺れと読んで緩めた。
- **見分け方**:`Element is not attached to the DOM` のような症状。再現しなくても正体がある。
- **直し方**:test を緩める前にアプリ側を疑う。要素が作り直される経路のように、原因をコードで名指しできるまで追う。

⚠ **flake に見えるものが製品の穴だったことがある**(2026-08-07、`external-images` /
`boot-edit` の **2 件**)。**test を緩める前にアプリ側を疑う**。直したら
**確定的に鳴る unit** を足す ── ただし「字面の位置」で pin すると、位置を保って
挙動を壊す変異が生き延びる。
🔑 `boot-edit` の `Element is not attached to the DOM` は**再現しなくても**
正体があった ── 「1 回通ったから直った」ではなく、**要素が作り直される経路**を
コードで名指しできるまで追う(retry で消せる症状は、原因の側に門を置く)

## merge した直後、`main` に立ったまま次の仕事を始めない

- **型**:PR を squash merge して main へ checkout し、そのまま次の実装に入った。
- **見分け方**:`git status -sb` が指定 branch でなく main を指す / push が `(stale info)` で落ちる。
- **直し方**:`git fetch --prune origin && git checkout -B <指定 branch> origin/main` を 1 息で打つ。push は branch 名を明示する。

🔴 **merge した直後、`main` に立ったまま次の仕事を始めない**(2026-09-12。
**指定 branch を外して main へ 2 commit 直に積んだ**)。⚠ 判断を誤ったのではない ──
PR を squash merge したので `main` へ checkout して同期し、**そのまま**次の実装に入った
(reflog: commit は **15:06 / 15:09**、branch を戻したのは **15:10**)。
🔑 **危ないのは「作業の開始」ではなく「merge の直後」**である ── 始めるときには
branch を確かめるが、**merge の後にもう一度確かめる習慣が無かった**。
🔑 手順 ①**同期を checkout で終わらせない**:
`git fetch --prune origin && git checkout -B <指定 branch> origin/main` まで 1 息で打つ
(**main に立っている時間を作らない**)。
🔴 **`--prune` に refspec を付けない**(2026-09-14 に**この 1 語で 3 手溶かした**)──
merge した瞬間に GitHub は remote の branch を消すが、手元の `origin/<branch>` は
**消える前の sha を指したまま残る**。⚠ `git fetch --prune origin main` と書くと
**`origin/main` しか掃除しない**ので残骸が生き、次の push が `(stale info)` で断られる
── そこから `--force-with-lease` を撃っても、**相手が居ないので永久に通らない**。
🔑 **refspec を落とすだけで、この経路が構造から消える**(戒めを覚えていなくてよい)。
症状と診断は [`../SKILL.md`](../SKILL.md)「remote 追跡 ref も掃除する」(**5 度踏んでいる**)。
②🔑 **push は branch 名を明示して打つ**
(`git push -u origin <指定 branch>`)── main に居ても**押すのはローカルの指定 branch**
なので「Everything up-to-date」で済み、**事故にならない**。⚠ 危ないのは素の `git push`。
🔴 **そして文言を 3 か所目にしない** ── `.githooks/pre-commit` が
**`main` の上の commit を断る**(`npm ci` の `prepare` が `.git/hooks/` へ写す。
門は `tests/repo-hygiene.test.ts`)。
⚠ 禁止が解ける条件も書く:**`PKC3_ALLOW_MAIN_COMMIT=1`** を付ければ通る ──
塞ぎたいのは**惰性**であって、必要な操作ではない

## 門は、止めるはずの操作を本物の道具で 1 回通して確かめる(`main` 上の commit を断る hook)

- **型**:門を手で関数として走らせて緑にしたが、git を通る本物の経路を 1 度も通っていなかった。
- **見分け方**:test が `sh .githooks/pre-commit` のように手で呼んでいる / 門が守るべき場所でだけ居なくなる。
- **直し方**:`git switch main && git commit --allow-empty` のように、止めるはずの操作を本物の道具で 1 回やる。

🔴 **その門の 1 稿目は、守るべき場所でだけ居なくなる形だった**(同日。
**書いた 10 分後に、実際に commit が通って分かった**)。
1 稿目は `git config core.hooksPath .githooks` で掛けたが、⚠ **hooksPath は
作業ツリーの中を指す** ── `git checkout main` すると `.githooks/pre-commit` ごと
消えるので、**main の上でだけ hook が居ない**(⚠ git は「hook が無い」を
**黙って通す**)。🔑 写す先を **`.git/hooks/`**(checkout で変わらない)にして解けた。
🔴 **test は緑だった** ── hook を `sh .githooks/pre-commit` と**手で走らせて**
いたので、**git を通る本物の経路を 1 度も通っていなかった**(CLAUDE.md「検証の規律」§2「経路が一度も
通っていない」)。⚠ 3 方向(断る / 通す / 抜け道)を揃えても、**経路が違えば
全部同じ嘘**である。
🔑 検算は 1 つ:**その門が止めるはずの操作を、本物の道具で 1 回やってみる**
(`git switch main && git commit --allow-empty`)── 手で関数を呼ぶのは、
門が在ることの確認であって、**門が掛かっていることの確認ではない**。
⚠ そして**この誤りは「対策済み」の顔で残る**(commit も CLAUDE.md も
「hook で断る」と書いてある)── 自分で通してみるまで、誰も気づけない

## 🔴 押し所(`data-pkc-action`)を足したら、**`tests/` を全部回す**(2026-09-16)

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

## 🔴 「いつも出る」ようにした物は**共有面**である ── 着地前にフル smoke(2026-09-26)

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

(判定の規則は [`../SKILL.md`](../SKILL.md)「共有面に当たる変更」。)

## 🔴 **お知らせを 1 件足すだけでも「共有面」である**(2026-10-03、PR #1313)

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

## 🔴 画面に出た赤を消してから commit する(2026-08-14)

🔴 **画面に出た赤を消してから commit する**(2026-08-14)。eslint の赤を**見たまま**
commit して CI を赤くした。⚠ **2 件のうち 1 件は様式ではなく実害**だった ── 窓の題名を
採る式が template literal の中に在るので `\s` が**リテラルに食われて `s` になり**、
「文字 s の連続」を置換する正規表現になっていた。⚠ たまたま該当が無く**出力が変わらない**
ので、**赤を消さなければ永久に露見しない**形だった。
🔑 **ツールの赤は「様式の小言」ではない。1 件ずつ中身を読んでから消す。**
🔑 1 件直したら**その command をもう一度回す**(1 件目の陰に 2 件目が居る)。

## 🔴 **`npm test` も `npm run lint` も、型を見ていない**(2026-08-22)

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
⚠ これは `../SKILL.md`「画面に出た赤を消してから commit する」の「1 件直したらその command をもう一度回す」の**別の面**である
── あちらは「同じ command の 2 件目」、こちらは「**別の command が見ていない次元**」。

## 🔴 `tests/fixtures/**` に **`.js` / `.ts` の断片**を置くと、`npm run lint` がそれを構文解析して落ちる(2026-10-05、PR #1358)

Emscripten の minify 後の字を**断片のまま**(`…HEAPU32)[ptr+4>>>2>>>0]=value};var …`)fixture に置き、file-targeted の
`npx eslint <触った file>` だけ回して push した → CI の `verify` が `tests/fixtures/emscripten/*.js` の Parsing error で赤。
🔑 **字のまま切り出した物は `.txt` にする**(構文として完全でない物を `.js` と名乗らせない)。
🔑 **push の前は `npm run lint`(全量)を回す** ── file-targeted は **触っていない file**(fixture / 生成物)を見ない。
⚠ これは 本 file「`npm test` も `npm run lint` も型を見ていない」の隣の穴 ── あちらは「別の command」、こちらは「同じ command の**範囲**」。

## 🔴 commit と push の前に `git status -sb` を読む ── HEAD が detached なら push は何も運ばない(2026-10-03)

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

## 🔑 1 本の branch で主題を 2 つ以上並行させる ── **local branch に停めて、merge 後に載せ直す**(2026-09-02)

### 🔴 基点の古い commit を新しい main に載せたら、**全量 unit を 1 回回してから** PR にする(2026-10-03、PR #1306)

agent の worktree は依頼を出した時点の main から作られる。その間に別の PR が着地すると、
agent が回した「全量緑」は**着地前の main に対して**であって、載せ直した後の版は誰も回していない。
実例:#529 Q3 の agent(基点 `f4abb337`)が位置の変数 `--pkc-place-x` を足し、その間に着地した
#1304 の test が「色の変数が無い」を **`--pkc-place` の前方一致**で見ていた ── cherry-pick 後に
依頼者が回したのは notice の門 + 触った file の test だけで、**CI で初めて赤くなった**。
🔑 検算は 1 つ:**agent の基点 sha と、載せる先の main の sha が違うか。** 違うなら
① その間に着地した PR が触った file を `git diff --stat <基点>..origin/main` で数え、
② 全量 unit を runner(haiku)に投げて緑を見てから push する(3 分。CI の赤 1 回のほうが高い)。
⚠ 「触った file の test は緑」は、**相手側の test が自分の file を見ている**形を拾えない。


### 🔴 検査が落ちたまま `git checkout <別 branch>` しない(2026-10-02)

お知らせを足して全数検査を回し、**1 件落ちたので commit せずに**元の branch へ `git checkout` した ──
git は未 commit の変更を**黙って持ち越す**ので、お知らせの編集が**別の branch の作業ツリーに乗った**
(気づいたのは次の `git status`)。落ちた検査が負荷の timeout だったので、戻って単独で回し直して commit した。
🔑 branch を替える前に **`git status --short | grep -v '^??'` が空**であることを見る。空でないなら
commit(WIP でよい)してから替える。⚠ `git stash` は箱の中で共有される(worktree の注意書き)── 使わない。

### 停める手順と、載せ直しで踏んだ罠(2026-09-02 ほか)

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

## 🔴 remote 追跡 ref の残骸で push が `(stale info)` になる ── 5 度の記録(2026-08-22 / 2026-08-30 / 2026-09-14 ×2)

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
