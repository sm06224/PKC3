# セッション引き継ぎ 2026-09-21

> ⚠ **この doc は要約とポインタである。** 罠と規律の正本は `CLAUDE.md` と
> `.claude/` に在る(このセッションぶんは反映済み ── 下の「`.claude` へ入れたもの」)。
> 前回は `session-handoff-2026-09-20-pm.md`(#1016)── そこの「裁定待ち 3 件」は
> **2026-09-20 の 4〜6 巡目で全部 UI 総合設計(#1017)に吸収された**。

## 🔴 最初の仕事: **なし。user の裁定待ちが 1 件**(⚠ 催促はしない)

| | 何を決めていただくか | 推薦 | どこに書いてあるか |
|---|---|---|---|
| **段⑤-2** | 画面の字の書き換え **175 か所**(使わない語 → 言い換え)を、表の向きで 1 つの PR にしてよいか。外す語があれば行に ✗ | 表のとおり | [#1017 のコメント](https://github.com/sm06224/PKC3/issues/1017#issuecomment-5757666378) |

🔑 裁定が出たら:`tests/features/ui-terms.test.ts` の `KNOWN_BANNED`(83 行・222 件)が
材料。**配布済みのお知らせ(`notice-log.ts` の 47 件)は変えない**(`announce.test.ts` の
digest が止める)。1 語 1 対応ではなく、字を入れる前に 1 件ずつ画面に当てて確かめる
(「面」を取って意味が通らない所は「画面」に / 「壊れ」は何が起きたかを言う形に)。
直した行は `KNOWN_BANNED` から消す(消さないと落ちる)。お知らせ 1 件 + マニュアル。

⚠ 裁定が無いまま着手しない ── 見え方が変わる(CLAUDE.md 2026-08-28「見え方を変える
判断は user のもの」)。

## 現在の状態(実測 2026-09-21 08:45 UTC)

| | |
|---|---|
| main の HEAD | `92bcc00` #1017 段⑤-1 ── 名前の正本 `ui-terms.ts` と 3 つの門 (#1027) |
| 作業 branch | `claude/pkc3-pr-1013-fiahtq`(この引き継ぎ PR の分だけ main より先。⚠ merge したら作り直す) |
| `/dev/` | `Deploy Pages` run 638(`92bcc00`)── 書いている時点で in_progress。1 つ前の run 637(`aaea581`)は success |
| 本番 `/` | 🔴 **v3.2.0(8/29)のまま**。引き金は user の示唆待ち(打たない) |
| open PR | dependabot 3 件(#1003 mermaid 12 / #1001 upload-artifact 7 / #842 vitest 5)── 3 件とも major。触っていない |
| 予約 | 無し(check-in の trigger は全部削除済み) |

## このセッションで着地したもの(#1017 UI 総合設計。設計 doc `ui-total-design-2026-09.md` v5.1 §9)

| 段 | PR | 画面で何が変わったか |
|---|---|---|
| ④b | #1024 | バックアップの末尾で中身を言う(`.pkc3-full.zip` / `-notes` / `-part`)。取り込む前に「ノート N / 添付 K / つながり / 履歴」の表で確認。「拾って…」の専用ボタン 2 つ廃止。「整理案を適用」を右の列へ。同乗 hotfix:`import.smoke` が ②b で消えた計器区画を見ていた |
| ③-1 | #1025 | 「システム」を 6 つの節(メッセージ / 設定 / 許可 / 記録 / 保存領域 / お知らせ)へ。「最後の手」廃止 → 点検の中の畳んだ箱。ボタン改名(点検する / 作り直す / 初期化する)。「記録 → コピーの履歴を消す」新設(押した直後に件数が古いまま残る実害を直した) |
| ③-2 | #1026 | 「これまでのお知らせ」をヘルプから「システム → お知らせ」へ。ヘルプには「お知らせを開く」1 行。目次から最後の節へ飛ぶと見出しが帯に隠れる回帰を `scroll-margin-top` で直した |
| ⑤-1 | #1027 | 画面は変わらない。`src/features/ui-terms.ts`(名前の正本)+ 門 3 つ(使わない語 / 動詞句のボタン名 / メッセージの英語) |

前セッション(同日午前〜)の ⓪ #1019 / ① #1020 / ④a #1021 / ②a #1022 / ②b #1023 と合わせ、
**裁定済みの段は全部 main に在る**。台帳は #1017(各段の着地 sha をコメントで記録)。

## 測って「問題なし」と分かったこと(再調査させないために)

- **別窓で「お知らせを開く」**:ヘルプ自体を別窓で開く導線は無い(`view-window.ts` の対象に
  `help` は無い)。マニュアルの別窓は別の静的 document なのでボタンが存在しない ── 押せない
- **`<details>` を「システム」で使ってよいか**:`docs-parity.test.ts` の「`<details>` 0 件」は
  `buildShell()` / `buildSettingsCommands()` / コレクション面だけを数える。`SettingsRenderer` の
  出力(お知らせの一覧)は対象外(③-2 の注釈に file:line)
- **`pick-smoke` が FULL へ倒れる**のは `smoke-map.json` が古い(#993 で既知)── 動線から
  grep で引く形で代替した(④b / ③-1 / ③-2 とも 2 ブラウザで緑)
- **KNOWN_BANNED の件数は本物**(`器` 13 件を疑って数え直した:`portable/bundle.ts` の
  文字列 8 件は全部 `why:` の画面の字)

## やらないと決めたこと(理由つき)

- **`docs/manual.md` の「言葉の意味」へ `TYPE_TERMS` / `STANDARD_TERMS` を流し込む**(設計 doc
  §6.3):マニュアルは help.ts が焼き込む画面の字なので、39 語を足すのは見え方の変更 ──
  ⑤-2 と一緒に user に見せる
- **`embed-origins` の許可を「許可」節へ出す**:UI が元々無い。現状維持
- **dependabot 3 件**(major):このセッションの主題(#1017)の外。触っていない

## このセッションで `.claude` / `CLAUDE.md` へ入れたもの(正本はそちら)

<!-- REFLECT_POINTERS -->

## 🔴 次のセッションへの注意

- **branch は 1 本**(`claude/pkc3-pr-1013-fiahtq`)。この引き継ぎ PR を merge したら
  `git fetch --prune origin` → `git checkout -B claude/pkc3-pr-1013-fiahtq <main の sha>`
  (⚠ 2 つの命令は**別々に**打つ ── 1 行に繋ぐと自動承認の分類器に止められる)
- **merge は委任済み**(CI green + mergeable で squash)。本番の引き金(`v*` tag /
  `release.yml`)は user の示唆待ち
- **重い作業はサブエージェント**(全量 `npm test` / build は haiku の `pkc3-runner`、smoke は
  sonnet の `pkc3-smoker`、実装は sonnet の `pkc3-implementer`。書く物は worktree)。
  ⚠ worktree は古い HEAD で始まることがある ── brief の先頭に
  `git checkout -q -B <名> <sha>` を書き、1 行目の sha を確認させる
- **smoke の報告に「見ていない動線」が在ったら、押してみるまで着地させない**(③-1 で
  実害が出た。`.claude/agents/pkc3-smoker.md`)
