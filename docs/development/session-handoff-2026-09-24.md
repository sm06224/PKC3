# セッション引き継ぎ 2026-09-24

> ⚠ **この doc は要約とポインタである。** 罠と規律の正本は `CLAUDE.md` と `.claude/` に在る
> (前セッションぶんは PR #1035 で反映済み)。前回は `session-handoff-2026-09-21.md`(#1028)──
> そこの「裁定待ち 1 件(段⑤-2)」は **2026-09-21 に裁定が出て #1031 で着地した**。

## 🔴 最初の仕事: **あり**

**#1038(台帳③: PKC2 の「使いやすさ・統一感」を PKC3 で再現する)の段 0 = 落差を数える。**

| | |
|---|---|
| **どこから** | [#1038](https://github.com/sm06224/PKC3/issues/1038) の「段 0」の表(6 つの次元)。⚠ **判定の規則 5 つを先に読む** ── これを飛ばすと #180 と同じ「機能の袋」に戻る |
| **どうやる** | `pkc3-surveyor` と `pkc2-surveyor`(どちらも read-only / `model: sonnet`)を**次元ごとに並列**で投げ、突き合わせる。⚠ **1 件 1 grep で検算**してから表に書く |
| **完了条件** | 落差表が #1038 にコメントとして載り、**1 行ごとに「PKC の思想①〜⑥のどれから導かれるか」と「渡し先(#1017 / #582 / #1029 / 新規)」が書けている**こと |
| **その次** | 段 1 = **設計 doc 1 本**にまとめ、**1 度で**裁定を仰ぐ(⚠ 設問を小出しにしない / 設問には理由を 1 行添える) |

🔑 **user の言葉の解釈**(2026-09-24):PKC2 は触っていて使いやすく、画面の統一感も高い。
PKC2 の最大の不満(保存領域の脆さ)は PKC3 が既に解いているので、**PKC2 の手触り × PKC3 の土台**が
揃えば完成形になる。⚠ 一度に入れず、**噛み砕いて**(何が良かったのかを言葉にしてから)入れる。

⚠ **`pkc2-surveyor` は PKC2 側の資産である**(`/home/user/PKC2/.claude/agents/pkc2-surveyor.md`)──
PKC3 の `.claude/agents/` には**無い**。箱に PKC2 が clone されていないと呼べないので、
先に `ls -d /home/user/PKC2` で確かめる(無ければ `add_repo` → clone)。

⚠ **user に「PKC2 のここが良い」と聞き直さない。** 読むのは PKC2 の実装と、この repo に既に在る
user の言葉である(CLAUDE.md 2026-09-21「聞く前に『聞かずに決まる材料』を数える」)。

## 現在の状態(実測 2026-09-24 21:30 UTC ごろ)

| | |
|---|---|
| main の HEAD | `8f3f1f9` Bump the minor-and-patch group with 2 updates (#1036) ── dependabot の auto-merge(9/24 04:13) |
| 作業 branch | `claude/focused-hypatia-lxphbr`(この引き継ぎ PR のぶんだけ main より先。⚠ merge したら `origin/main` から張り直す) |
| `/dev/` | 🔴 **`284b01a`(9/22)を配ったまま** ── `8f3f1f9` の `Deploy Pages` run が **1 件も無い**。原因と直し方は **#1039**。⚠ 配る物の差は 0(開発用依存だけ)なので**今回に限り実害は無い** |
| 本番 `/` | 🔴 **v3.2.0(8/29)のまま**。引き金(`v*` tag / `release.yml`)は user の示唆待ち ── 打たない |
| `Nightly` | run #61(`8f3f1f9`)**success**(9/24 21:04) |
| open PR | dependabot 3 件のみ(#1037 vitest 5 / #1003 mermaid 12 / #1001 upload-artifact 7)── **3 件とも major**。触っていない |
| 予約 | **無し**(check-in の trigger は削除済み / PR の購読も解除済み) |

## このセッションで着地したもの

| PR | main | 何が変わったか |
|---|---|---|
| [#1030](https://github.com/sm06224/PKC3/pull/1030) | `4ddf9cf` | #1029 設計 doc + 段 A(絵の付け忘れ 3 件 + 指の押し所 24px の門)/ 段 B(右の列を 6 つの塊に。区切りは線ではなく間) |
| [#1031](https://github.com/sm06224/PKC3/pull/1031) | `b2f8d43` | #1017 段⑤-2(画面の字を名前の規則へ)+ #1029 段 D-1(帯ごとの絵の揃い)+ 書き出し smoke 7 本の繋ぎ直し |
| [#1033](https://github.com/sm06224/PKC3/pull/1033) | `7d57ef3` | #1029 段 C(幅の下限を 2 段で受ける / 塊を `entry-actions.ts` へ寄せる)。⚠ **手 1(名前を短くする)は実測で取り下げ** |
| [#1034](https://github.com/sm06224/PKC3/pull/1034) | `84ca047` | **#1032** ノートを閉じてコレクションの画面へ戻れるようにした(左の列の何も無い所 / `deselect-entry`) |
| [#1035](https://github.com/sm06224/PKC3/pull/1035) | `284b01a` | `.claude更新` ── CLAUDE.md 3 件 + スキル 6 本(⚠ commit の題名は「5 つ」と数え違えている。中身は 6 本) |

### 🔴 この 4 日でいちばん大きかったのは #1032 である

ノートを 1 件でも選ぶと中央はそのノートになり、**コレクション全体の書き出しへ読み込み直す以外に
戻れなかった** ── 命令(`DESELECT_ENTRY`)は在るのに、**撃つ口が画面に 1 つも無かった**。
⚠ これは #1038(統一感の台帳)がこれから数える層の、**実例そのもの**である
(機能は在る / 動線も在るように見える / **戻り道だけが無い**)。

## 🔴 裁定待ち: **無し**(⚠ 催促する物も無い)

- **#1029 段 E(書き出しを束ねる)は取り下げた** ── 手元の根拠 3 つ(#491 / 自分が本文に書いた注意 /
  user の「サブメニュー化は乱暴」)が全部同じ側を指していた。**覆る条件**は #1029 の最後のコメント
- **#1029 段 D-2(絵の混在をやめる)は保留** ── 右の列の絵を持たない物に**新しい図案を焼き足す**
  必要があり、焼いてから 8 幅で測らないと「絵のぶん横が伸びて段が増える」が言えない(段 C と同じ轍)
- **#1017 は ⓪〜⑤ の全段が着地済み**。残っているのは「マニュアルの『言葉の意味』へ 39 語を足す」で、
  これは**見え方の変更**なので次にまとめて出す

## 測って「問題なし / そうではなかった」と分かったこと(再調査させないために)

| 何 | 結論 |
|---|---|
| **右の列に塊の見出しを置く** | 🔴 **置けない。** 実ブラウザ 8 幅の A/B で **+2〜4 段**増えた。右の列は `minmax(220px, 15vw)` で **220 → 288px しか広がらない**ので、見出しのぶん塊が他の塊と相乗りできなくなる(`button-rhythm-design-2026-09.md` §4.0-a) |
| **`Escape` を「ノートを閉じる」の既定にする** | 🔴 **できない。** `keymap.ts` 自身の検めが断る ── `global` はどの文脈とも重なるので `row-cancel` と衝突する。**鍵は置かず**、近道の設定で user が割り当てる形にした |
| **左の列の「何も無い所」** | 🔴 **表の外だった。** 実測で `filer-table` は **53px**、その下に **126px** の余白 ── 器を `browse-host` にして解けた(unit は器へ直に click を撃つので緑のままだった) |
| **CI の `verify`** | 実測 **約 4.5 分**。⚠ 押してすぐ引くと「凍っている」と見分けが付かない ── 引くのは `list_workflow_jobs`(step の時刻が読める) |

## やらないと決めたこと(理由つき)

- **ボタンの名前を短くする / 塊の見出しを出す**(#1029 段 C 手 1)── 上の実測。⚠ 門を外した理由は
  `entry-actions.ts` の同じ場所に残してある(次に読む人が同じ実測をやり直さないため)
- **書き出しをサブメニューへ束ねる**(#1029 段 E)── 上の裁定待ちの項
- **dependabot の major 3 件** ── 主題の外。`mermaid` 12 は配る物に入るので、触るなら単独の PR で
- **PKC2 に手を出す** ── read-only 参照のみ(user 指示 2026-07-30)

## `.claude` / `CLAUDE.md` に入っているもの(正本はそちら。PR #1035)

| 罠 | どこへ |
|---|---|
| 自分の案を repo の門が断ったら、**門ではなく案を疑う**(1 日で 3 回、案が誤りだった) | `CLAUDE.md` |
| 聞く前に「**聞かずに決まる材料**」を数える(user 指示 2026-09-21) | `CLAUDE.md` |
| **回している最中に file を書き換えない**(2 回踏んで 22 分捨てた) | `CLAUDE.md` |
| unit の click は「その場所が実在するか」を確かめない(`elementFromPoint` で前提を assert) | `.claude/skills/smoke-testing/SKILL.md` |
| `SURVIVED` の 10 個目の顔 ── 門が「その file 自身の字面」を読んでいた | `.claude/skills/mutation-testing/SKILL.md` |
| お知らせの回転で触る **4 つ目**の場所(`KNOWN_BANNED` の件数) | `.claude/skills/notice-writing/SKILL.md` |
| CI の完了は**ポーリングせずに 1 回だけ起きて**待つ | `.claude/skills/github-tools/SKILL.md` |
| 受け取った実装は**依頼文ではなく設計 doc の条件**に照らす | `.claude/skills/subagent-scale/SKILL.md` |
| `Write` の前に `git log -1 -- <path>` | `.claude/skills/source-editing/SKILL.md` |

## 🔴 次のセッションへの注意

- **branch は 1 本**(`claude/focused-hypatia-lxphbr`)。この引き継ぎ PR を merge したら
  `git fetch --prune origin` → `git checkout -B claude/focused-hypatia-lxphbr origin/main`
  (⚠ `--prune` に refspec を付けない ── 付けると消えた remote branch の残骸が生き、次の push が
  `(stale info)` で断られる)
- **重い作業はサブエージェント**(全量 `npm test` / build は haiku の `pkc3-runner`、
  範囲を切った smoke は sonnet の `pkc3-smoker`、実装は sonnet の `pkc3-implementer`。書く物は worktree)
- **merge は委任済み**(CI green + mergeable で squash)。**本番の引き金は user の示唆待ち**
- **全量 smoke は `Smoke (手動)` を押したときだけ**。途中は `node scripts/pick-smoke.mjs --run`、
  フルは着地の直前に 1 回
