/**
 * リーン集約の核となる domain 型(P3 設計メモ §1)。
 *
 * ⚠ **EntryMeta に body フィールドは存在しない**(意図的)。
 * body に触れられるのは AppState.openBody 経路だけであり、
 * 「未読の body を書く」経路が型レベルで構成できない ── PKC2 lazy 失敗
 * (同期型のまま裏で抜く → 未読 body を空保存する穴 S3)との決別点。
 * この不在は tests/core/entry-meta-pin.test.ts で pin する。
 */
export interface EntryMeta {
  lid: string;
  title: string;
  archetype: string;
  createdAt: string | null;
  updatedAt: string | null;
  entryOrder: number;
  /** フレーバー抽出列(frontmatter 由来 ── 正本は body、抽出は FlavorSpec に一元化) */
  status: string | null;
  date: string | null;
  archived: boolean;
  /**
   * 🔴 **本文の文字数**(2026-08-19、2 ペインの作り直し)。`null` = **まだ数えていない**。
   *
   * ⚠ これは**本文そのものではない** ── 上の「body を持たない」規律は保たれる
   *   (数だけでは本文を復元できないので、未読 body を書く経路は作れない)。
   * 🔑 保存のたびに worker が数えて列へ置く(`task_total` と同じ形)── 一覧の
   *   SELECT で `length(body)` を計算すると、**面を開くたびに全本文を読む**
   *   ことになる(#212 の穴)。
   * ⚠ **`0` と `null` を潰さない** ── `0` は「空のノート」、`null` は
   *   「旧ビルドが書いた行でまだ数えていない」。潰すと埋め直す行が分からなくなる。
   */
  bodyChars: number | null;
}

export interface Relation {
  id: string;
  fromLid: string;
  toLid: string;
  kind: string;
  createdAt: string | null;
  updatedAt: string | null;
}
