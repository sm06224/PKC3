# セッション引き継ぎ(2026-08-07)

> 手順の正本は `.claude/skills/session-handoff/SKILL.md`(`/handoff`)。
> 本 doc は**状態と残件**を持つ。**罠と手順は `.claude/` と `CLAUDE.md` に在る** ──
> ここには要約とポインタだけ置く(2026-08-04 の doc が存在しない `.claude/` を指して
> 罠がどこにも残らないところだったので、その反省)。

## 🔴 最初の仕事: **なし。user の裁定待ちが 2 件**

催促はしない。裁定が来るまで実装に入らない。

| # | 裁定してほしいこと | 選択肢 |
|---|---|---|
| 1 | **PR #90 に 3 主題が同居している**のを剥がすか | (a) そのまま着地させる (b) **別ブランチの許可**をもらって `.claude/` と箱の hotfix を別 PR へ剥がす |
| 2 | **記法の縮小 6 件**(`docs/development/notation-shrink-survey-2026-08.md` §5) | doc に各案の材料あり。⚠ 前回のレビューで**縮小そのものが否定された**ので、蒸し返す前に doc を読むこと |

⚠ **1 は次セッションが勝手に決めない。** ブランチは `claude/…` 1 本に固定されており、
別ブランチへ push するには user の明示許可が要る(system prompt の制約)。

## 現在の状態(2026-08-07 時点で実測)

- **main**: `1a8c599` 画面から印刷すると 1 頁しか出ず、+++ の改頁がどの面でも起きていなかった (#89)
- **作業 branch**: `claude/pkc3-handover-review-qc825j`(**未 push 0 件**・clean)
- **open PR**: **#90**(7 commit・CI 走行中)。⚠ **3 主題が同居**している:
  | commit | 主題 |
  |---|---|
  | `faea4d2` | 本文 CSS の焼き込み(**主題**) |
  | `a8c4144` | レビュー 1 巡目の指摘 7 件 |
  | `64b8ffc` | 箱の同意の見張りの位置(**別件・hotfix**) |
  | `dbf9668` | レビュー 2 巡目の指摘 6 件 |
  | `95865e2` | **`.claude/` 一式(#91)**(**別件**) |
  | `abd8727` | 紙のリンク色の裁定を記録 |
  | `007bcf5` | 教訓を資産へ分割(本引き継ぎの前段) |
- **open issue**: #88(Office wasm・着手は明示 go 待ち)/ #91(`.claude/` ── 本 PR で解決)

## このセッションで着地したもの

`03f3d8c` 外部画像の同意 / `ae3df07` CLAUDE.md 検証の規律 +3 /
`a59f9e0` 記法縮小の調査 doc / `f20752a` nightly の probe が旧い意味論を検定していた /
`5d1bcfe` 目次と本文の読み手を 1 本化(実バグ 13 類)/
`97bd7b6` Tier 1 の囲いを走査器が見るように / `1a8c599` 印刷

## PR #90 で直したもの(未着地)

**配った HTML の本文が素のまま出ていた。** 実ブラウザで 21 の観測点を測ると **17 が
違っていた** ── `:::note` は枠も地も無く段落と区別できず、タスク行は丸ポチとチェック欄が
二重、圏点が付かず、`_3` の高さが 0、表の罫の色が違う。`app.css` の
`.pkc-md-rendered` 前置き 116 本を build 時に抜いて書き出し HTML へ焼き、
**見た目の正本を 1 本**にした。

副産物 2 件: 箱(html fence)の CSP 違反の見張りが user の中身より後ろに登録されていて
**3 回に 1 回、画像の同意の帯が出なかった**(製品の穴)/ 添付ボタンと切替ボタンの
退行 2 件を実測で見つけて直した。

**変異 32 件すべて KILLED**。unit 2085 件 / smoke 88 件が**両ブラウザ**で green。

## 残件(「やる」と決まっているもの。この順)

1. **PR #90 を着地させる** ── CI green を確認して squash merge(merge は委任済み)。
   ⚠ merge 後は **branch を main から作り直す**(merge 済み PR に積まない)
2. **nightly の smoke flake**(2026-08-05 から) ── `boot-edit.smoke.spec.ts` の
   `clickReal` → `scrollIntoViewIfNeeded` → `Element is not attached to the DOM`。
   ⚠ **test を緩める前にアプリ側を疑う**(`.claude/skills/smoke-testing/` の
   「flake に見えるものが製品の穴だったことがある」── 今回それで 1 件見つかった)
3. **`.b` の重複 45 本の掃除** ── 焼き込みで死んだ `.b` 規則が残っている。
   ⚠ **一本ずつの確認が要る**(`.b` にしか無い規則も混じっている)。
   `tests/features/markdown-css-parity.test.ts` が死んだ複製を pin し続けている問題も同時に
4. **ライブエディタの入れ子 4 形 + `:::foo`(未知名)** ── `tests/features/live-editor-balance.test.ts`
   の `ok:false` 5 件。⚠ `:::foo` を直すには「renderer が畳む名前の集合」が要り、
   `source-blocks.ts` が明記した「表を持ち込まない」判断を覆すことになる = 裁定が要る
5. **`pages.yml` の重複した TODO コメント 4 行**(些末)

## 測って「問題なし」と分かったこと(再調査しない)

- **`closeOver`(トークンの推移閉包)は循環でも停止する** ── `want` は単調増加で
  上界が有限
- **`startsAtBody` の境界文字クラスに誤検知は無い** ── 15 形を実行して確認
- **`64b8ffc` の見張りの位置に残る窓は無い** ── head の並びは
  `charset → viewport → CSP → 見張り → style`。script より前に画像を要求しうるものが無い
- **plugin の `config.root` 配線は test で証明されている** ── `configResolved` を
  無視する実装では落ちる
- **配る量**: cap 残量 **712.4 KB(11.9%)**。焼き込みは +12.2 KB

## やらないと決めたこと

- **`.b` を全部消して焼いた分だけにする** → `.b` にしか無い規則があり、一本ずつの
  確認が要る(残件 3 へ)
- **`perf-measurement` スキルを PKC3 に作る** → 今回 perf の作業をしていないので、
  書くと実測に基づかない手順になる。計測規律の正本は当面 `CLAUDE.md` 冒頭
  (⚠ その旨をプロセス指示に明記した)

## 踏んだ罠(**正本は `.claude/` と `CLAUDE.md`**。ここは索引)

| 罠 | 正本 |
|---|---|
| 片側を直したら対称の反対側を疑う(**PKC3 最頻**) | `CLAUDE.md` / `.claude/skills/mutation-testing/` |
| 裁定は受け取った場で起票する(会話に流すと消える) | `CLAUDE.md` / `.claude/skills/knowledge-reflection/` |
| user に見える仕様をレビュー応答の commit で決めない | `CLAUDE.md` / `.claude/skills/pr-landing/` |
| 編集ツールが制御文字を生バイトで書く | `.claude/skills/source-editing/` |
| template literal にバッククォートを書かない(**5 度目**) | `.claude/skills/source-editing/` |
| flake に見えるものが製品の穴 | `.claude/skills/smoke-testing/` |
| 変異が「当たっていない」ことを見分ける | `.claude/skills/mutation-testing/` |
| 実体を作ってから導線を書く | `.claude/skills/knowledge-reflection/` |

## 資産(`.claude/`)── このセッションで作った

| | |
|---|---|
| agents | `pkc3-reviewer` `pkc3-surveyor`(**read-only**)/ `pkc3-implementer` `pkc3-verifier`(🔴 **worktree 必須**) |
| skills | `subagent-scale` `mutation-testing` `smoke-testing` `source-editing` `pr-landing` `session-handoff` `knowledge-reflection` |
| commands | `/fanout` `/review` `/mutate` `/handoff` `/claude-update` |

🔴 **新方針(user 指示 2026-08-07・不可侵)**: 「PKC3 はより発展させてサブエージェントを
大量にスケールさせながら**物量と試行と思考**で推し勝つ」。手順は `subagent-scale`。
⚠ 「思考」= **返ってきたものを 1 件ずつ自分で再現する**。今回の実測で、レビュー指摘
15 件のうち **2 件は前提か結論がずれていた** ── 鵜呑みにしたら正しい実装を壊していた。
