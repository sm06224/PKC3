/**
 * 🔴 **同じものを 2 回取り込んだことに気づけるようにする**(#399 ②)。
 *
 * ## user の物語
 *
 * バックアップを取り込んだが、うまくいったか不安でもう一度取り込んだ。
 * → **全部 2 部になった。何も言われない。**
 *
 * ## 🔑 いまの挙動は「安全側」に倒してある ── その代償である
 *
 * `existing-lids.ts` は既存 lid と衝突したら**必ず新しい lid を採番**する。
 * 🔴 **これは正しい**(直前 #328 は逆で、既存を**黙って上書き**していた ──
 * データが消えるほうが、増えるより悪い)。
 * ⚠ ただし「**上書きしない**」と「**同じ物だと気づく**」は別である。
 *
 * ## ⚠ この段でやるのは「言うこと」だけ
 *
 * 🚫 **勝手に取り込まない、を既定にしない** ── そちらへ倒すと
 * 「**黙って取り込まれない**」になり、いまより悪い(増えたのは見えるが、
 * 入らなかったのは見えない)。選ばせるのは段②。
 *
 * ## 🔑 全部の本文を読まない
 *
 * 「同じ内容か」を知るには本文が要るが、**全件読むのは高い**。
 * ⚠ そこで **文字数で先に絞る** ── 文字数が違う本文は、絶対に同じではない。
 * 🔑 `EntryMeta.bodyChars` は常駐の集約が既に持っているので、**ただで使える**。
 *
 * 🔑 **pure module**。
 */

/** 取り込もうとしている 1 件。 */
export interface IncomingEntry {
  readonly lid: string;
  readonly title: string;
  readonly body: string;
}

/** 既に在る 1 件(本文は読んでいない)。 */
export interface ExistingHead {
  readonly lid: string;
  /**
   * 本文の文字数。⚠ **`null` = 分かっていない**(常駐の集約がまだ持っていない)。
   * 🔴 分からないものは**絞りから外さない** ── 外すと「重なっているのに
   *   数えられなかった」が黙って起きる(**数が過少になる向き**の誤り)。
   */
  readonly bodyChars: number | null;
}

/**
 * **本文を読む価値のある既存 lid**だけを返す。
 *
 * ⚠ 文字数が 1 件も一致しなければ**空**が返る ── そのとき読みは 0 回で済む。
 * ⚠ 取り込む側が 0 件でも空(読む理由が無い)。
 */
export function narrowByLength(
  incoming: readonly IncomingEntry[],
  existing: readonly ExistingHead[],
): readonly string[] {
  if (incoming.length === 0) return [];
  const wanted = new Set<number>();
  for (const e of incoming) wanted.add(e.body.length);
  const out: string[] = [];
  // ⚠ **`null` は必ず読む** ── 長さで否定できないので、外すと数が過少になる
  for (const h of existing) if (h.bodyChars === null || wanted.has(h.bodyChars)) out.push(h.lid);
  return out;
}

/** 同じ内容だった 1 件。 */
export interface DuplicateHit {
  /** 取り込もうとしている側の題名(user に見せるのはこちら)。 */
  readonly title: string;
  /** 既に在るほうの lid。 */
  readonly existingLid: string;
}

/**
 * **中身が 1 バイトも違わない**ものだけを数える。
 *
 * ⚠ 「似ている」は数えない ── 題名だけ同じ / 前半だけ同じ、を数え始めると
 *   user は**数字を信じられなくなる**(「2 件と言われたが違った」)。
 * ⚠ 取り込む 1 件に既存が複数当たっても **1 件**と数える(user が知りたいのは
 *   「いくつ増えたか」であって、組み合わせの数ではない)。
 */
export function findDuplicates(
  incoming: readonly IncomingEntry[],
  existingBodies: ReadonlyMap<string, string>,
): readonly DuplicateHit[] {
  /** 本文 → 既存 lid。⚠ 同じ本文の既存が複数在ってもよい(最初の 1 件を指す)。 */
  const byBody = new Map<string, string>();
  for (const [lid, body] of existingBodies) if (!byBody.has(body)) byBody.set(body, lid);
  const out: DuplicateHit[] = [];
  for (const e of incoming) {
    const hit = byBody.get(e.body);
    if (hit !== undefined) out.push({ title: e.title, existingLid: hit });
  }
  return out;
}

/**
 * user に見せる 1 行を組む。⚠ **件数だけで終わらせない** ── 何が重なったか
 * 分からないと、user は**全部を目で確かめる**ことになる。
 *
 * @returns 出す文。重なりが無ければ `null`(黙る)
 */
export function duplicateNote(hits: readonly DuplicateHit[], cap = 3): string | null {
  if (hits.length === 0) return null;
  const names = hits.slice(0, cap).map((h) => `「${h.title}」`).join('、');
  // ⚠ **切ったことを言う**(黙って切ると「これで全部」と読まれる)
  const rest = hits.length > cap ? ` ほか ${hits.length - cap} 件` : '';
  return `同じ内容のノートが ${hits.length} 件ありました(${names}${rest})── 取り込みは止めていないので、要らないほうは消してください`;
}
