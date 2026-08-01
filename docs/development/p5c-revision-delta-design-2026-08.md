# P5c: revision の持ち方 ── jujutsu 由来のモデル + 逆向き差分ストレージ(2026-08)

> **user 指示 ①(2026-08-01、不可侵)**: 「revision の持ち方を考えてください。
> git 的にしたいけど、普段は不要。理想は必要な時だけロード。
> 差分のみ保持、パッチ遡及ベース」
>
> **user 指示 ②(2026-08-01、不可侵)**: 「git よりも新しい jujutsu を参考に
> できないか?git も限界が見えている。PKC はさらに先を目指してる」

## 1. jujutsu の「先」はストレージではなくモデル層にある

まず切り分ける。**jj の既定バックエンドは git オブジェクトそのもの**
(差分・圧縮・content-addressing は git と同一)。つまり jj が git を超えている
のは**保存形式ではなく、履歴の扱い方(モデル)**である。jj 固有の 4 点:

| # | jj のモデル | git の限界 |
|---|---|---|
| A | **作業コピーがコミット**(index / staging が無い。編集は常に自動スナップショットされ、作業コミットが amend され続ける) | 作業ツリーが履歴の外にある「宙ぶらりんの状態」。dirty / stash / index の三重管理 |
| B | **operation log と万能 undo**(コンテンツ変更だけでなく「操作」自体を記録し、`jj undo` / `op restore` でリポジトリ状態ごと巻き戻す) | reflog は低水準の部分的な代替でしかなく、「さっきの操作を取り消す」が一般化されていない |
| C | **change ID が書き換えを跨いで安定**(amend / rebase してもその変更の同一性が保たれる。commit hash は変わる) | rebase すると別物になり、「同じ変更」を指す識別子が無い |
| D | **conflict が一級市民**(衝突は commit の中に構造として記録され、操作を止めない。後から解消できる) | 衝突は操作を失敗させ、作業を止める |

**PKC3 への含意**: 差分の形(逆向き差分チェーン)は git 由来のままで正しい ──
「recent が安い / 古い側から捨てられる」という性質は単一ユーザーの有限容量アプリに
最適である。**先へ行くべきなのは A・B・(将来 D)**。

## 2. 採用①: tip = 現在の body(A ── 作業コピーはコミット)

前案(本 doc 初版)は「anchor を revisions 表の中に置いて自己完結させる」と
していた。理由は「toggle / rename が entries.body を書き換えるとチェーンが壊れる」
から。**jj のモデルはこれを回避ではなく解決する** ── 作業コピーがコミットなら、
本文が動いたときは**チェーンを壊すのではなく tip を amend すればよい**。

```
entries.body            = tip(= 最新状態の全文。既に存在する。複製ゼロ)
revisions(古い順に)    = 逆向きパッチのみ(全文は原則持たない)
  rev#k は「rev#(k+1) の状態から遡るパッチ」、鎖の頭は tip から遡る
```

**帰結: 全文コピーが 1 部も増えない。**「差分のみ保持」という指示に文字どおり
到達する(前案は全文 anchor を 1 部持っていた ── 本案がこれを supersede する)。

## 3. 採用②: checkpoint と amend の 2 モード(A の運用形)

jj では「編集は常にスナップショットされ、区切るかどうかは別」。PKC3 に写すと:

| 書込 | モード | 履歴 |
|---|---|---|
| COMMIT_EDIT(変更あり) | **checkpoint** | 1 件伸びる(P5b の「変更ありの commit だけ刻む」を維持) |
| todo toggle / rename / 復元の書込 | **amend** | 伸びない。tip の位置だけ動き、鎖の頭のパッチが張り替わる |
| 新規作成 / import | — | 鎖なし(tip のみ) |

- **amend の中身**: 鎖の頭が復元する状態 S を 1 回だけ materialize し、新 tip との
  逆向き差分に張り替える(1 patch 適用 + 1 diff)。**S は変わらない** ── 過去の状態は
  絶対値であり、変わるのは「tip からの符号化」だけ。だから toggle は履歴を汚さずに
  鎖も壊さない
- **構造的に破れなくする**: 鎖の維持は **worker の `upsertEntry` が同 tx で行う**
  唯一の場所にする(旧 body は worker が同 tx で読める ── app 層の協力に依存しない)。
  P5b の `addRevision` op は `upsertEntry(entry, { checkpoint: true })` に畳んで**消す**
  (op が 1 つ減る = 削る側の変更)
- **削除**: entry 行が消えて tip が無くなるので、削除時は tip を `kind='full'` 行として
  materialize する(= 現在の trash snapshot と同じ)。鎖はそこを新しい base として
  完結する。復元は逆(full 行が tip に戻る)。**混在チェーン(full が途中にある)は合法**

## 4. ストレージ(前案から維持)

- `kind` 列('full' | 'patch'。NULL = full 扱い)を schema v3 で追加 ──
  **判定は列の実在・1 tx**(P5a F1 で確立した migration 原則)。v2 の既存行は
  すべて full = そのまま合法(書換 migration 不要)
- パッチは行ベースの編集スクリプト(JSON)。行末を含めて分割(`(?<=\n)` 方式)し
  **CRLF / 末尾改行まで byte 一致**で復元(lossless)。実装は純 TS・依存追加なし
- **hash 検証**(git 的整合性): 復元後の全文 hash が行の `content_hash` と一致
  しなければ**可視エラー**。壊れた鎖から誤った本文を黙って返さない(S3 規律)。
  不一致が出たらそこより古い側を「復元不能」と表示する(嘘をつくより欠測を出す)
- **prune が鎖を壊さない**: 依存は「古い → 新しい」の一方向。最古から消す分には
  残りが常に完結する ── 逆向きを選ぶ最大の理由
- 容量の見積り(**未実測・probe で確認する**): 10KB の note を 200 バイト程度ずつ
  編集する典型なら、100 件保持で「全文 100 部 ≒ 1MB」→「tip 10KB + パッチ 100 個
  ≒ 数十 KB」の桁。**数字は P5c-3 の probe で出してから主張する**

## 5. 採用③(⚖ 要 go): operation log = 万能 undo(B ── git に無い本丸)

jj の最大の発明であり、**「PKC が git の先を目指す」という言葉に最も直接に応える
のがこれ**。コンテンツの履歴(revisions)とは**別の軸**として、アプリ操作そのものを
記録する:

```
operations(cid, id, seq, kind, ts, payload, undone_by)
  kind: create / delete / rename / toggle / restore / import / purge / gc / …
  payload: 逆操作に必要な最小情報(delete → 対応する trash revision id、
           rename → 旧 title、import → 生成した lid 集合、…)
```

- **undo は履歴を書き換えず、逆操作を新しい operation として積む**(jj と同じ)。
  だから「undo の undo」も自然に成立する
- **revisions では取り消せないものが取り消せる**: entry の削除・一括 import・
  ゴミ箱を空にする(= 不可逆と記録され undo 不可、と**明示**できることも価値)・
  復元操作そのもの
- 保持は有界(直近 N 件 / M 時間)。**boot では読まない**(履歴 panel と同じく要求時)
- UI: Ctrl+Z は textarea の undo と衝突するので奪わない。「操作履歴」パネル +
  明示「元に戻す」。⚠ これは**新機能**なので、CLAUDE.md の「新機能を盛り込みすぎない」
  に従い**user の明示 go があるまで実装しない**(seam と設計だけ確定させる)

## 6. 将来の seam(⚖ 要 go・P7 以降)

- **first-class conflict(D)**: 多タブ / 多デバイスで**保存を失敗させない**。衝突は
  「両者を保持した conflict revision」として記録し、本文には双方を可視で残して後から
  解消する。ノートアプリで「競合で保存できません」は最悪の体験であり、ここは git より
  jj の思想が明確に正しい。ただし現状は writer lease(単一書き手)で足りているので、
  同期を作る段まで**着手しない**
- **operation log による並行制御**: jj は複数プロセスの並行操作を op log の head を
  マージして解決する。PKC3 の lease(排他)の代替になりうるが、これも同期の段の話
- **change ID(C)**: 既に revision 行は安定 id を持つ。amend で行を**削除・再挿入
  しない(UPDATE で維持)**という規約だけ守れば C の性質は満たされる ── 本案に織り込み済み

## 7. 採らないもの(理由)

| jj の要素 | 採らない理由 |
|---|---|
| anonymous head / 名前なしブランチ、rebase・squash ワークフロー | 単一ユーザーのノートに分岐操作の語彙は要らない。UI 複雑度に見合わない |
| evolog(1 つの変更の amend 履歴) | 「履歴の履歴」は必要十分の外。amend は tip の符号化変更にすぎず、見せる価値が薄い |
| content-addressed オブジェクト + GC | sqlite 行 + prune で同じ目的を、有限容量アプリにはより素直に達成できる |
| 分散同期・push/pull | 将来領域(正本 doc §10)。着手は user の明示 go |

## 8. ⚖ 裁定事項

1. **保持上限**: (a) 100 件へ引き上げ(推奨。差分化で 1 件の桁が下がる)/
   (b) 無制限 + 明示 purge(完全に git 的。entry あたり合計 bytes の tripwire とセット)/
   (c) 20 のまま
2. **operation log(§5)の go**: 作る / 作らない / 後の段で再訪
3. **P6 の PKC2 revisions**: 捨てる(推奨・現状の P6a 実装)/ 新形式に変換して持ち込む

## 9. 実装順(1・2 は裁定不要 ── 方向が確定しているため先行できる)

1. **P5c-1**: 純 TS の行 diff/patch(`features/revision/line-patch.ts`)+ lossless pin
   (CRLF / 末尾改行 / 空文字 / 単一行巨大 / 全置換 の縁)
2. **P5c-2**: worker の `upsertEntry` に鎖維持(checkpoint / amend)を統合、
   `getRevision` をチェーン復元 + hash 検証に、`addRevision` op を畳んで削除、schema v3。
   worker unit(実物 node 実走)で mutation を pin
3. **P5c-3**: probe に「tip + パッチ N」の容量と復元時間の実測を追加(nightly)。
   ここで初めて容量の数字を主張する
4. (裁定後)P5c-4: operation log + 万能 undo
