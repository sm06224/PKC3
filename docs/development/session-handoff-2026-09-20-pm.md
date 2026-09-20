# セッション引き継ぎ 2026-09-20(午後)

> ⚠ **この doc は要約とポインタである。** 罠と規律の正本は `CLAUDE.md` と
> `.claude/` に在る(このセッションぶんは反映済み)。午前の引き継ぎは
> `session-handoff-2026-09-20.md`(#1013)── そこの「最初の仕事」2 つは**両方済んだ**。

## 🔴 最初の仕事: **なし。user の裁定待ちが 3 件**(⚠ 催促はしない)

| | 何を決めていただくか | 推薦 | どこに書いてあるか |
|---|---|---|---|
| **A / B** | 起動の検めが壊れを見つけたときの**知らせの見え方**(A: 知らせが消えた後の印 / B: 知らせから押し先へ) | **A-2 + B-1** | [PR #1015](https://github.com/sm06224/PKC3/pull/1015) の「user の裁定待ち」/ [#1007 のコメント](https://github.com/sm06224/PKC3/issues/1007#issuecomment-5750259849) |
| **#1007 段②** | [設計 doc](./durability-oplog-design-2026-09.md) の画面の字と、上限 8 MB / 500 件 | doc のとおり | #1007 |
| **#1010 A / B** | 「区画」という内部の語 / 保存が止まったときの断り書きが押せない | A-1 / B-1 | #1010 |

🔑 裁定が要らず着手してよいもの(順に):
1. **#1007 段③**(`synchronous` は FULL のまま「測って決めた」と書いて pin する)
2. **段① の既知の穴**(下)── ⚠ ただし段② と設計が絡むので、段② の裁定が出てからのほうが手戻りが少ない
3. 🔴 **段④ は user にしかできない**(実機で「壊れていないか調べる」の出力)

## 現在の状態(実測 2026-09-20 14:05 UTC)

| | |
|---|---|
| main の HEAD | `1d14211` #1007 段① ── 起動のたびに、中身が壊れていないかを自動で軽く検める (#1015) |
| 作業 branch | `claude/pkc3-pr-1013-fiahtq`(main と同じ sha。⚠ この引き継ぎ PR を merge したら作り直す) |
| `/dev/` | `Deploy Pages` run 627(`1d14211`)**success**。⚠ 実物の bundle は箱から取れない(proxy が `github.io` を拒む)── job の緑まで |
| 本番 `/` | 🔴 **v3.2.0(8/29)のまま**。引き金は user の示唆待ち |
| open PR | dependabot 3 件(#1003 mermaid 12 / #1001 upload-artifact 7 / #842 vitest 5)── 3 件とも major |

## このセッションで着地したもの

| PR | main | 中身 |
|---|---|---|
| [#1015](https://github.com/sm06224/PKC3/pull/1015) | `1d14211` | **#1007 段①** ── 起動して 5 秒後、7 日に 1 度、表ごとに `quick_check` を回す。壊れは一時の知らせに、無事なら `settings` 表に印。cap 8800 → 9300 KB |

### 段① の既知の穴(#1007 に記録済み)

**1 表の中は割り込めない。** follower の保存は `StoreProxy` の 10 秒で切られるので、数 GB の `entries` を検めている最中に重なると**偽の失敗**が出うる。候補:① 検め中だけ proxy の timeout を伸ばす ② worker 側で検めの request を後回しにする ③ rowid で割る(sqlite に口が無い)。

## 測って「問題なし」と分かったこと(再調査させないために)

| 測ったこと | 結果 |
|---|---|
| 同梱 sqlite 3.53 は `PRAGMA quick_check(<表>)` を受けるか | 🟢 受ける。**その表と索引だけ**を見る(壊した PK 索引を `quick_check("entries")` が名指し、他の表は `ok`)。無い表は `no such table` で落ちる |
| 表ごとに分けると遅いか | node で 20 万行の表 23 ms、丸ごと 14 ms ── 差は無い |
| `OP_FAILED` の帯は「赤い帯」か | 🔴 **灰色**(`--muted` / `surface-2`)。しかも `SELECT_ENTRY` が `error: null` で消す |
| `StoreProxyHost` は follower の数を知っているか | 🔴 知らない(台帳が無い)── 「follower が居るときだけ検めを避ける」は今の形では書けない |
| `isolation: "worktree"` の agent は何から切られるか | 🔴 **常に `origin/main`**(5 本の reflog)。HEAD でも upstream でもない |

## やらないと決めたこと(理由つき)

- **「書込 N 回」の検め条件** ── 永続の書込カウンタは書込ごとに 1 行増える。日数だけにした
- **検めで壊れを見つけても書き込みを止めない** ── 門は worker の `dbCorrupt` の 1 か所(2 か所目を作らない)
- **表ごとの検めで freelist / page count の整合を見ない** ── 押した検めは丸ごとのまま

## このセッションで `.claude` / `CLAUDE.md` へ入れたもの(正本はそちら)

| 置き場 | 何を足したか |
|---|---|
| `.claude/skills/subagent-scale/` | 🔴 **worktree は常に `origin/main` から切られる**(HEAD でも upstream でもない)── 依頼文に sha を書き、agent に `git checkout <sha>` させる。⚠ 1 稿目は「upstream だから」と書いて外した |
| `.claude/agents/pkc3-ux-reviewer.md` | 知らせは「出るか」ではなく「**いつ消えるか**」で読む(`OP_FAILED` は選択で消える / `showStatus` は次の知らせまで残る) |

## 🔴 次のセッションへの注意

- **cwd が `/home/user` に戻ることがある** ── `isolation: "worktree"` が「hook が無い」と言って落ちたら、まず `pwd`
- **サブエージェントの依頼文には必ず base の sha を書く**(上の worktree の罠)
- **配る量の cap 残量は 504 KB(5.4%)** ── 次の数 PR は触れない
