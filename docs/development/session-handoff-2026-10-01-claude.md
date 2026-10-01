# セッション引き継ぎ 2026-10-01 ── Claude 向け(Gemini の提案を着陸させる)

> ⚠ **この doc は要約とポインタである。** 罠と規律の正本は `CLAUDE.md` と `.claude/` に在る。
> 相方(Gemini)向けの doc は `docs/development/session-handoff-2026-10-01-gemini.md`、
> 対話の場と台帳は **issue #1163**。前回の引き継ぎは `session-handoff-2026-09-29.md`(#1154 / #1155)。

## 🔴 最初の仕事: **あり ── `[Gemini 提案]` の issue を着陸させる**

user 指示(2026-10-01、こちらの解釈):**Gemini が発見・起票した issue を Claude が実装する。
ただし issue の解決は Gemini の革新性を壊さないように、Claude がうまく着陸させること。
2 者は issue コメントで対話してよい。**

- 入口: GitHub の open issue のうち題名が `[Gemini 提案]` で始まる物(#1163 の表にも並ぶ)。
  **🔵 着陸案のコメントがまだ無い物**から、起票の古い順に
- **1 件も無いとき: 指示待ち**(自分で提案を作って埋めない。#1087 の続行も user の指示があってから)
- 完了条件(1 件あたり): 着陸案 → 実装 PR → merge → issue に観測点 → close → #1163 の表を更新

## 1. 「着陸させる」とは何か(この仕事の芯)

🔑 **壊してはいけないのは「革新の核」であって、Gemini の実装案ではない。** Gemini の issue は
「革新の核」と「譲れる部分」を分けて書く約束になっている(Gemini 向け doc §6)。
核を守り、譲れる部分で PKC の制約に合わせる。

| やってよい | やってはいけない |
|---|---|
| 置き場を変える(本文を奪う形 → 右の列 / 別ウィンドウ / 左のタブ) | 核を落として「できる範囲」だけ実装し、黙って閉じる |
| 段に割る(段① で核、段② で周辺)── **段② を issue に残す** | 双方向の物を片道にする(置けるのに外せない) |
| 記法を足す / 既存の記法に乗せる | 記法を減らす・既存の書き方を変える(user 裁定 2026-08-07) |
| ワーカーへ逃がす / PNG に焼く / 遅延起動にする | 「重いから」で機能を削る(user 指示 2026-08-03) |
| 既存の判定・口へ寄せる(2 か所目を作らない) | 新しい概念を user に見せて堅牢化する(却下済み 2026-09-20) |
| 設定で選べる形にして既定は user に聞く | 見え方(大きさ・色・配置・並び・名前)を自分で決める(user 指示 2026-08-28) |

🔴 **判定は 1 つ:「Gemini がこの着地を見て、自分の提案だと分かるか」。** 分からないなら、
それは着陸ではなく別の物を作っている。

## 2. 1 issue の手順

1. **前提を検算する**(1 件 1 grep)。Gemini の「無い」「遅い」「壊れている」を実装で確かめる。
   外れていたら 🔵 コメントで事実を返す(提案を否定するのではなく、前提を直して**提案を生かす道**を探す)
2. **既存の裁定と線を当てる**: `CLAUDE.md` の不可侵指示(記法 / 配る量 / ワーカー / 図 / JSON body /
   URL パラメータ / 業務画面 / 別ウィンドウ / 双方向 / 見え方は user)。当たる所を列挙する
3. **🔵 着陸案を issue に書く(実装の前)**。型:

   ```
   🔵 Claude: 着陸案

   ## 核と読んだもの(Gemini の言葉を引いて 1 行)
   ## 守り方(核をどう実装に写すか)
   ## 折り合い(PKC の線に触れる所と、どう変えるか。変える理由を 1 行ずつ)
   ## 段割り(段① / 段②。段② は別 issue にする)
   ## 質問(Gemini に 1〜3 問。無ければ「無し」)
   ## 🟡 user 裁定が要る物(見え方 / 不可逆 / 裁定を覆す。無ければ「無し」)
   ```

4. **Gemini の返事を 1 往復待つ**。⚠ 返事が無いまま次のセッションになったら、
   **核を守る側の読みで進めてよい**(前提を issue に書いてから)。待ちで止めない
5. **実装 → 着地前の自前検証 → PR → CI 緑 → squash merge → main 同期**
   (手順は `.claude/skills/pr-landing/SKILL.md`。branch は 1 本固定なので 1 PR ずつ)
6. **issue に観測点を 1 行(PR 番号 / main の sha)→ close → #1163 の表を更新**。
   Gemini は理由つきで reopen してよい ── reopen されたら 2 へ戻る
7. 着陸できないと判断したら **🟡 user 裁定待ち** と書いて止まる。黙って閉じない・黙って縮めない

## 3. 着地の門(落ちる所を先に知っておく)

| 門 | いま | 触れたとき |
|---|---|---|
| アプリ本体の配る量 cap(`scripts/check-dist.mjs`、9300 KB) | **残り 305.9 KB(3.3%)** ── 次の機能で触れる可能性が高い | 取り違えでなければ**引き上げてよい**(tripwire であって規律ではない。user 指示 2026-07-26 / 08-03)。残量を KB と % で報告 |
| 持ち歩ける 1 枚の雛形 cap(同、11200 KB) | 9900.7 KB。⚠ **release の zip でしか鳴らない**(#1157) | 同上。本番配布の日に止まるので、大きい依存を足したら手元で `VITE_PKC_KIND=product npm run build && npm run build:portable` → `check-dist.mjs product` を 1 回 |
| smoke の起動予算(`scripts/smoke-budget.mjs`) | **504 / 504(残り 0)** | 新しい起動を足さず、既存の道中に assert を足す。どうしても要るなら理由 1 行で上げる |
| 本文 CSS の規則数(`tests/build/body-css.test.ts`、< 220) | 約 208 | `:is()` で束ねる。動的に付ける `.pkc-*` は `tests/features/markdown-css-parity.test.ts` の `STYLED_ELSEWHERE` へ登録 |
| お知らせ(`src/features/notice/notice-log.ts`、30 件) | 満杯 | 1 件足したら最古を `CHANGELOG.md` へ移し `DROPPED` / `KNOWN` / `ui-terms` の件数を直す(`.claude/skills/notice-writing/SKILL.md`) |
| README の現況 | `tests/docs-parity.test.ts` が「v<版> を」の字を pin | README を触ったら docs-parity を回す(2026-09-29 に 1 度落とした) |
| 画面の字 | `src/features/ui-terms.ts`(使わない語 / 動詞句 / 英語識別子の門) | 新しいボタン名は用語集から。造語を足さない |

着地前の自前検証(規律の要約。正本は `CLAUDE.md`「検証の規律」):
- 直した層の unit を自分で / **全量 `npm test` と build とフル smoke はサブエージェント(sonnet / haiku)へ**
- **変異試験**を 1〜3 件(`.claude/skills/mutation-testing/SKILL.md`)── 自分が足した門だけでなく、置き忘れた門を疑う
- 視覚を持つ変更は**名指しの spec だけ**の実ブラウザ smoke(`pkc3-smoker`、worktree 隔離)。動線の良し悪しは `pkc3-ux-reviewer` と対で
- user に見える変更は**お知らせ + マニュアル**を同じ PR で
- **挙動を裏返したら `tests/` を全数 grep**(unit と smoke は走る場所が違う)

## 4. 対話の作法(Gemini と)

- コメントの **1 行目は必ず `🔵 Claude:`**(同じアカウントで投稿するので、これが身元)
- 質問は**具体的に 1〜3 問**。「どう思いますか」は投げない
- 好みの衝突(見え方)は 2 者で決めない ── 🟡 で user へ。設問は**画面で何が起きるかの言葉**で、
  理由 1 行と推薦 1 つを添える(`CLAUDE.md`「user に判断を仰ぐ設問は、画面で何が起きるかで書く」)
- Gemini の前提が外れていても、**提案の意図を生かす読み替え**を先に探す(字義で突っ返さない ──
  「意図を読む」は user 確立のルール)
- 「済んだ」と書くときは観測点(PR / sha / run)を同じ文に貼る。貼れないなら未来形で書く

## 5. 現在の状態(実測 2026-10-01)

| 項目 | 値 |
|---|---|
| main の HEAD | `8218a494`(dependabot 3 件の後。製品の最後の変更は `facc7928` #1153) |
| 本番 `/` | **v3.3.0(2026-09-29、Release run 36518880340 / Deploy Pages run 36520606697 success)** |
| `/dev/` | main HEAD を配り済み(push ごとに `pages.yml`) |
| open PR | dependabot のみ(vitest 5 / mermaid 12 / upload-artifact 7 ── いずれも major、触っていない) |
| open issue | 約 55 件。`[Gemini 提案]` は**まだ 0 件**(Gemini のセッションが起票する) |
| 台帳 | #1163(協働)/ #1087(リファクタ・高速化・提案。前セッションで 5 件着地)/ #1038 / #1017 / #1029 |
| 作業 branch | 固定 1 本(session の指定 branch)。merge 後は `git fetch --prune origin && git checkout -B <branch> origin/main` |

## 6. 前セッション(2026-09-29)で踏んだ罠(正本へのポインタ)

| 罠 | 正本 |
|---|---|
| 引き継ぎ doc の候補表に**着地済みの issue が 3 件**残っていた(前セッション自身が閉じた物)。着手前に issue の state を 1 件ずつ見る | `CLAUDE.md`「古い調査から起票するときは、起票の直前に現状を確かめる」 |
| 本番リリースの Deploy Pages が**雛形の cap**で止まった(release の zip でしか鳴らない計器) | #1157 / `scripts/check-dist.mjs` の `PORTABLE_CAP_KB` の注釈 |
| README を触って `docs-parity` を回さず CI を赤にした | `tests/docs-parity.test.ts`「README の現況の版」 |

## 7. やらないこと

- Gemini の issue が無いときに自分で提案を作って着手する(user の指示待ち)
- 本番リリースの引き金(`v*` tag / `release.yml`)を自分から引く(user の示唆を待つ ── 2026-08-19)
- `sm06224/PKC2` を書き換える
- Gemini の核を落として「部分実装で close」する
