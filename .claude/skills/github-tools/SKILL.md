---
name: github-tools
description: この箱から GitHub を叩くときの道具立てと罠。api.github.com への直 curl は塞がれ `gh` CLI も無いので MCP の github tool を使う。issue を閉じるときに本文を消す / 監視ループが想定外の応答に沈黙する、という消えた物が戻らない型の事故がある。「issue にコメント」「issue を閉じる」「run を引く」「CI を見る」「PR を読む」という文脈で必ず使う。
---

# GitHub を道具として叩く(PKC3)

> ⚠ **これは PR の着地とは別の主題である**(2026-09-05 に `pr-landing` から切り出した ──
> 1 枚 1 主題)。ここに在る罠は**起票・棚卸し・調査**でも同じように踏む。
> 着地の手順そのものは `.claude/skills/pr-landing/SKILL.md`。

## 0. 🔴 何で叩くか

- 🚫 **`https://api.github.com` への直 curl は塞がれている** ── `GH_TOKEN` は env に
  在るのに、返るのは `{"message": "GitHub access is not enabled for this session. ..."}`
- 🚫 **`gh` CLI は無い**(2026-09-05 に再確認: `gh: command not found`)
- 🟢 **MCP の github tool を使う**(`actions_list` / `pull_request_read` /
  `issue_write` / `add_issue_comment` / `list_workflow_jobs` ...)

⚠ **「読む手段が無い」と書く前に、MCP tool の一覧を見る。**
🔑 それでも無いなら、**無い経路を数えて書く**(CLAUDE.md §4「取れないで終わらせる前に、
取り方を数え上げる」)。

## 🔴 監視ループは「想定外の応答」を必ず 1 行吐かせる

⚠ 上の塞がった curl を **poll ループに入れて 6 分捨てた**(2026-08-13)。
書いたのはこういう形:

```bash
st=$(curl … | python3 -c "…print(d.get('status'), d.get('conclusion'))")
case "$st" in
  "completed "*) echo "CI 完了"; exit 0 ;;
  poll-error)    echo "poll-error" ;;      # ← ここに来ない
esac
```

エラー JSON にも `status` キーが**無いだけで parse は通る**ので、
`None None` が出て**どの case にも当たらず、黙って次の周回へ行く**。
⚠ **「何も鳴らない」が「まだ走っている」と見分けられない。**
🔑 poll ループは **想定外の応答を必ず 1 行吐かせる**(`*) echo "想定外: $st" ;;`)。
「成功の合図だけを grep する監視は、crash と hang に対して沈黙する」の同型である。


## 🔴 引いた識別子と状態は、書く前に確かめる

規律の正本は `CLAUDE.md`(「渡す URL は、渡す前に実在と中身を確かめる」/
「同じ検算を『状態』にも当てる」)。手順としてはこれだけ:

- **番号**(PR / issue / run / commit / tag)は **branch や id から引いてから**書く ──
  「その番号を、いま自分はどこから読んだか」を言えないなら書かない
- **「着地した」「済んだ」は観測点を 1 つ挙げてから**書く
  (`pull_request_read` の `merged` / `origin/main` の log)

## 🔴 計器が凍ることがある ── 同じ id を 2 度引いて同じなら、別の口から引く

`get_workflow_run` / `get_workflow_job` が**同じ凍った記録**を返し、
`updated_at` が何分も動かないことがある(2026-08-27、#481。job の timeout は 10 分
なのに 13 分 `in_progress` に見えた)。⚠ **2 度引いても同じ嘘が返る**ので、
「一次情報を引いた」だけでは足りない。

🔑 **`list_workflow_jobs`(run の id で job を一覧する)から引き直す** ──
このときは `completed / success` が返った(実所要 6m36s)。
⚠ **タイムアウトを超えて見えることを「異常の証拠」に数えない**(2 度誤った)。

## 🔴 落ちた job を再実行すると、唯一の証拠が消える

`get_job_logs` は**再実行で上書きされる**(2026-08-29、#561 で `failed_jobs: 0` が
返った)。🔑 **再実行を押す前に、落ちた job のログを丸ごと控える。**
⚠ 「flake に見えても 1 回だけ再実行してよい」は、**控えたあとの話**である。

## ⚠ issue にコメントするつもりで**本文を上書きしない**

`issue_write` の `method: "update"` に `body` を渡すと、**本文がまるごと置き換わる**。
2026-08-13 に #134 の症状表を消した(復元済み)。
🔑 コメントは **`add_issue_comment`**。`update` を使うのは題名を変えるときと、
**本文そのものを書き直すと決めたとき**だけである。

🔴 **同じ日に 2 度目 ── 踏むのは「閉じるとき」である**(#145)。
`state: "closed"` を渡すのに `issue_write` を使うので、**ついでに結末も `body` へ
書きたくなる**。そこが罠で、調査の記録がまるごと消える。
🔑 **閉じるのは 2 手に分ける**: ①結末を `add_issue_comment` ②`issue_write` で
`state` **だけ**(`body` を渡さない)。⚠ 1 回目の教訓を書いた本人が踏んだので、
「気をつける」ではなく**手順を 2 手に割る**ことで止める。

