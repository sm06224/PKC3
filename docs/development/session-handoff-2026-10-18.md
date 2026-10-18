# セッション引き継ぎ 2026-10-18

## 最初の仕事: あり

**PR #1871 を着地させる → 台帳 #1852 の残りの束を上から順に入れる。**

1. **PR #1871**(束 M1 + 一括操作のバー + この引き継ぎ doc)を取り込む。
   - CI(`verify` / `audit`)は head `333bfa3a` で緑だった(この doc の commit で再び回る)。
   - 🔴 **全量の smoke が赤(534 passed / 4 failed、`2c892db6` で 1 回だけ回した。再実行していない)**。この PR はスクロール位置の記憶(`scroll-memory.ts`)・保存の代理(`store-proxy.ts`)・`main.ts` という共通の部分に触れているので、**4 件が main でも落ちるかを先に確かめる**(main の `4f2aa496` で同じ 4 spec だけを回す)。main でも落ちるなら別件、この PR でだけ落ちるなら直してから着地:
     - `organize.smoke.spec.ts:223` まとめて選んで、まとめてゴミ箱へ入る ──「2 番目が消えていない」(⚠ 一括操作のバーと記憶の直しに最も近い。最有力)
     - `task-checkbox.smoke.spec.ts:15` チェックを押すと本文に残り、開き直しても消えない ──「右の列にチェック項目の行が出ていない」
     - `schedule.smoke.spec.ts:1107` 予定の面で「足す」を押すと、今日の束に出る ──「『明日』を選んだのに今日のまま」
     - `preview.smoke.spec.ts:122` ワーカーの動きが「メッセージ → 処理の記録」に流れる ──「ワーカーの動きが記録に届いていない」
     - ログは前のセッションの箱にしか無く、もう取れない。回し直して読む
   - 既知の別件:`office-entry.smoke:164` は main でも間欠に落ちる。`pdf-reader.smoke:117`(一括のバーが行を覆う)は **この PR で直した**ので、落ちたら本物。
   - 4 件が片付いて CI も緑なら squash merge(`expectedHeadSha` は 40 字で)。merge したら台帳 #1852 の M1 に印を付ける(main の log から sha を引く)。
2. 台帳 #1852 の未着手の束を上から:**P1(AI の道具)→ Q1(板・アプリ・連絡先)→ R1(記法・章リンク)→ F1(取り込みの入口)→ F2(単独 PR)→ B2(単独 PR)→ U1 の残り → 317 → 入った束の残り**。
   - P1 は前のセッションで着手したが途中で止めた(**何も残っていない**。最初から)。
   - 完了条件:束ごとに 1 PR で main に入り、台帳の行に PR 番号と main の sha が付く。

## 現在の状態(2026-10-18 03:00Z ごろ、実測)

- main の HEAD:`4f2aa496` 2 ペインと録音の直し(台帳 #1852 束 N1・O1)(#1870)
- open PR:#1871(この PR。`claude/sleepy-lovelace-7a2ran`)/ dependabot の #1760(happy-dom 21)と #1435(setup-node 6)── どちらも手を付けていない
- 作業 branch:`claude/sleepy-lovelace-7a2ran` のみ(ローカルの stage-* branch と worktree は全部消した)

## このセッションで main に入ったもの(全部 台帳 #1852)

| PR | 束 | main |
|---|---|---|
| #1866 | L1 メッセージ・L2 お知らせ | f6da41bc |
| #1867 | K2 書き出し・J2 添付の差し替え | 87732bbe |
| #1868 | L3 設定・N2 フォルダ | f9cb089a |
| #1869 | S1 狭い画面・T1 PDF / Office | 8ebd765b |
| #1870 | N1 2 ペイン・O1 録音 | 4f2aa496 |

(それより前の束は台帳 #1852 の本文に PR 番号と sha つきで在る)

## 束の進め方(このセッションで固まった手順)

1. **依頼の本文と回答**:#1163 のコメント(依頼の見出しは `## 依頼 NNN` の形もある)と、Gemini の回答コメント 6229453688 / 6232869654 / 6234253317。前のセッションは scratchpad に `c2.json`(#1163 のコメント全部)と `ans.txt`(回答)を落としていた ── **箱が替わると消える**ので、`issue_read get_comments` で取り直して scratchpad に置く。
2. **決まり**:依頼 73〜163 は「推薦」に従う / 164〜372 は Gemini の回答に従う / 食い違えば**番号の後の物**が勝つ(台帳の末尾に解決済みの 2 件)。
3. **実装は `pkc3-implementer`(worktree 隔離)へ 2 束ずつ**。依頼文には「着手前に `src/` を grep して既に在る物は対象外」「お知らせ・CHANGELOG は触らない」「全量 test / build / smoke は回さない」「返す形(表 / 守っていない物 / 矛盾 / 罠 / smoke の動線 / sha)」を書く。⚠ 起動前に `cd /home/user/pkc3-editor`(cwd が repo の外だと worktree が作れない)。
4. **着地**:`git fetch --prune origin && git checkout -B claude/sleepy-lovelace-7a2ran origin/main` → cherry-pick → 衝突は**個数の pin**(`tests/operation-table.test.ts` の unregistered など / `tests/action-scope-survey.test.ts` / `docs/development/operation-model-2026-08.md`)に出るので、両側のコメントを合わせ、test を回して Received を読む → tsc と該当 test。
5. **smoke は `pkc3-smoker` に動線を名指し**して回す(spec 名ではなく「押す → 何が出る」で書く)。共通の部分を触った PR だけ全量を 1 回。
6. **お知らせ**:`.claude/skills/notice-writing/add-notice.py`(6 項目まで・題名は重複なし・バッククォートや ' を書かない・使わない語は ui-terms の門が落とす)。
7. push → PR → `subscribe_pr_activity` → CI 緑で squash merge → 台帳を更新。

## 裁定待ち(user が決める。催促しない)

台帳 #1852 の「入れる前に確かめる物」の 4 件(過去の決定を変えるので、こちらからは入れない):

- 237・74-2:狭い画面の「横向きにすると直ります」の字を見直すか
- 332:PDF を F5 で読み直したとき、同じ PDF を渡し直すか(今はわざと渡し直していない)
- 182:「ノートを作る」の既定のキーを Alt+N に替えるか
- 261・310:記号のキーだけ、キーに印字された字で見るか(割り当て済みの人の意味が変わる)

## 踏んだ罠(資産へ入れた物はポインタだけ)

- 「判定が誤っていた」を「画面に出ていた」と書いた → `.claude/rules/verification.md` §4.6 の末尾
- 個数の pin の衝突は、束を 2 本続けて入れると毎回出る(上の手順 4)。Received を読んで直す ── 推測で書かない
- 依頼 51-4 A で移動の知らせを「入れました」→「移しました」にしたとき、unit・smoke・マニュアルの 3 か所に旧い字が残っていた(grep で全部潰した)

## やらないと決めたこと

- dependabot の #1760 / #1435:台帳の束を優先した。happy-dom の大きな版上げは unit 全体に効くので、束とは別の PR で扱う
