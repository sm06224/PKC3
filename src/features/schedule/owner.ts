/**
 * 🔴 **担当**(#283。エントリ / グループを「タスク」として扱う ── 状態・期日に並べる 3 つ目の属性)。
 *
 * ## どこに書くか(記法を増やさず、今ある 2 か所に乗せる)
 *
 * - **ノート 1 件の担当**: 前書きの `owner: 田中`(`schedule-keys.ts` の `SCHEDULE_KEYS.owner`)。
 *   グループ(スマートフォルダ・フォルダの表紙のノート)も普通のノートなので、同じ書き方で担当が付く。
 * - **チェック項目 1 行の担当**: 行の中に `担当:田中`(全角コロンも可)。⚠ 字は札にそのまま残す
 *   (外すと、どこに担当が書いてあるか本文を開かないと分からない)。
 * - 行に書いてなければ、**そのノートの `owner:` を引き継ぐ**(ノート単位で割り振って、行は例外だけ書く)。
 *
 * ## 🔑 正本は字
 *
 * 名前は連絡先のノートの題名と**字で**突き合わせる(`contactLidFor`)。連絡先が無くても書ける。
 * 別の ID を持たない ── 名前を直したら、連絡先の題名も直せば追いつく。
 *
 * 🔑 pure module(DOM も保存も知らない)。
 */

/** チェック項目の中の `担当:名前`。名前は空白・句読点・`#` / `@` の手前まで。 */
const LINE_OWNER = /(?:^|[\s　])担当[:：][ 　]*([^\s　,、。;；#@]+)/;

/** 行の字から担当を読む。無ければ `null`。 */
export function ownerOfText(text: string): string | null {
  const m = LINE_OWNER.exec(text);
  return m === null ? null : m[1]!;
}

/** 担当の選択肢(重複を除き、字コードの順)。 */
export function ownerChoices(owners: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const o of owners) if (typeof o === 'string' && o !== '') set.add(o);
  // 🔑 字コード順(ICU の有無で順が変わらない ── 同じ入力はどの端末でも同じ並び)
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 絞り込みの値。`null` = 全員、`''` = 担当なし、それ以外 = その名前。 */
export type OwnerFilter = string | null;

/** その担当(`null` = 無し)が、絞りを通るか。 */
export function passesOwnerFilter(owner: string | null | undefined, filter: OwnerFilter): boolean {
  if (filter === null) return true;
  if (filter === '') return owner === null || owner === undefined || owner === '';
  return owner === filter;
}

/**
 * 担当の名前に一致する連絡先のノートの lid を返す(名前 = 題名が**完全一致**)。無ければ `null`。
 * @param cards 連絡先の走査の札(`contactScan.cards`。連絡先かどうかを決めるのは `contact-card.ts`)
 */
export function contactLidFor(
  owner: string,
  cards: Iterable<{ readonly lid: string; readonly name: string }>,
): string | null {
  for (const c of cards) if (c.name.trim() === owner) return c.lid;
  return null;
}
