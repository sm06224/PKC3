# P5c: revision の持ち方 ── 逆向き差分チェーン設計(2026-08)

> **user 指示(2026-08-01、不可侵)**: 「revision の持ち方を考えてください。
> git 的にしたいけど、普段は不要。理想は必要な時だけロード。
> 差分のみ保持、パッチ遡及ベース」

## 0. 現状(P5a/P5b)との差分

既に満たしているもの:
- **普段は不要 / 必要な時だけロード**: boot は revisions に一切触れない。件数・
  一覧(listRevisionMetas)・本文(getRevision)すべて要求時 SQL(P5 設計 §1)
- 刻む縁の間引き(変更ありの commit と削除だけ)、同一内容 skip、明示 purge

満たしていないもの ── **本設計の対象**:
- 各 revision が**全文 snapshot**を持っている(PKC2 の 66.7% 問題の縮小版が残る)
- → **差分のみ保持、パッチ遡及ベース**へ

## 1. モデル: 逆向き差分チェーン(reverse delta)

git の packfile と同じ向き: **新しい側が全文(anchor)、古い側は「1 つ新しい状態
から遡るパッチ」**。

```
revisions(1 entry 分, rev_order 昇順):
  #1 patch(#2 の本文から遡る)
  #2 patch(#3 の本文から遡る)
  #3 full ← anchor(最後に刻んだ時点の全文)
entries.body = 現在の全文(チェーンとは独立)
```

**⚠ anchor は entries.body ではなく revisions 内の最新行に置く(自己完結)**。
entries.body を anchor にすると、revision を刻まない書込(todo toggle の splice /
rename)が起きるたびにチェーンが壊れる。revisions 表を自己完結にすれば、
entries.body がどう動いてもチェーンは不変・検証可能のまま。

- **revision #k の復元**: #k 以上で最も近い `full` 行から始め、パッチを下向きに
  順適用して #k に到達。要求時に該当 entry の行だけ読む(既定の読みはゼロのまま)
- **prune(古い側の削除)がチェーンを壊さない**: 依存は「古い → 新しい」の
  一方向なので、最古から消す分には残りが常に完結(逆向き差分を選ぶ最大の理由)
- **mixed chain は合法**: `full` 行がチェーン途中に何個あってもよい(v2 既存
  データはすべて full ── そのまま合法。復元は最寄りの full から再スタート)

## 2. 書込パス(worker 同 tx、addRevision の置換)

commit(変更前 body = B_old を刻む。新 body = B_new は entries 側):

```
tx {
  tip = 最新 revision 行(あれば)
  if (tip && tip.content_hash === hash(B_old)) → skip(従来どおり)
  if (tip が full) {
    tip.snapshot を「B_old から tip 本文へ遡るパッチ」に書き換え(deltify)
    ── tip の content_hash / title / archetype は不変(意味は変わらない)
  }
  INSERT 新行: kind=full, snapshot=B_old, content_hash=hash(B_old)
  prune(rev_order <= 新 - keepLatest)
}
```

- 1 commit のコスト: tip 全文の読み 1 + 行 diff(O(本文行数))+ 2 行書き。
  すべて worker 内・要求時のみ(boot / 打鍵経路には一切乗らない)
- deleteEntry(trash snapshot)は**今と同じく full を積む**だけ ── 削除済み
  entry のチェーンも自然に「最新 = full」を満たす。purgeTrash 不変
- 復元(前進変異)も同じ addRevision を通る ── 特別扱いなし

## 3. パッチ形式(lossless・自己記述)

行ベースの編集スクリプト。**行末を含めて分割**(`(?<=\n)` 方式 ──
spliceFrontmatterKeys と同じ規律)し、CRLF / 末尾改行の有無まで byte 一致で
復元する。snapshot 列(BLOB affinity)に JSON テキストで格納:

```jsonc
{ "v": 1,                    // パッチ形式 version(将来進化の seam)
  "ops": [ 42,               // 正の数 = 現在側から 42 行 copy
           [-3],             // 負 = 現在側の 3 行を捨てる
           ["古い行\n", "…"] // 配列 = 古い側の行を挿入
         ] }
```

- `kind` 列('full' | 'patch')を v3 migration で追加(判定は列の実在・1 tx ──
  P5a F1 で確立した原則)
- **整合性は git 的に hash で検証**: 復元した全文の hash が行の content_hash と
  一致しなければ**可視エラー**(壊れたチェーンから誤った本文を黙って返さない ──
  S3 規律)。diff/patch 実装は純 TS(Myers 行 diff、依存追加なし)で、
  worker と test の両方から使う
- 効果の桁(设计時見積り・実測は probe で): 典型編集は数行差分 ──
  20 件保持で「full 20 部」→「full 1 部 + 小パッチ 19 個」

## 4. 保持ポリシー ── ⚖ 裁定事項 1

差分化で 1 件あたりが桁で安くなるので、「git 的」に寄せられる:

- **(a) 推奨: keepLatest を 20 → 100 へ引き上げ**(パッチなので容量の桁は
  従来の 20 件分より小さい見込み)。実測(worker unit + 実データ)で数字を
  出してから、さらに緩める判断をする
- (b) 無制限 + 明示 purge のみ(完全に git 的)── 上限なしは PKC2 の轍なので、
  「entry あたりパッチ合計 bytes の tripwire(超過で警告)」とセットなら可
- (c) 現状 20 のまま(容量だけ得る)

## 5. migration と互換

- schema v3: `ALTER TABLE revisions ADD COLUMN kind TEXT`(実在判定・NULL =
  'full' 扱い ── v2 の既存全行は full として合法、書換 migration 不要)
- 新規の addRevision から自然に deltify が始まる(既存 full 行は混在のまま
  正しく復元できる ── §1 mixed chain)
- listRevisionMetas / listTrash / purgeTrash / trash 復元 / P5b UI は**無変更**
  (getRevision の内部だけがチェーン復元になる)

## 6. ⚖ 裁定事項 2: P6 の PKC2 revisions

前回提示の推奨(捨てる)のまま。ただし本設計によって「持ち込む」場合の形も
定義できる: PKC2 の全文 snapshot 列を新チェーンに変換(最新だけ full・古い側を
deltify)して bulkAddRevisions。取込コストは増えるが容量は桁で抑まる。
**裁定があるまで P6a は「捨てる(警告表示)」のまま先行**する。

## 7. 実装順

1. **P5c-1**: 純 TS の行 diff/patch(features/revision/line-patch.ts)+
   lossless pin(CRLF / 末尾改行 / 空文字 / 巨大行の縁)
2. **P5c-2**: worker addRevision の deltify + getRevision のチェーン復元 +
   hash 検証 + schema v3。worker unit(実物 node 実走)で mutation を pin
3. **P5c-3**: probe に「full 1 + patch N」の形と容量の実測を追加(nightly)
