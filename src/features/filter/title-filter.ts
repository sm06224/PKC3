/**
 * 絞り込みの**唯一の規則**(P7b 段⑨c / review M-1)。
 *
 * 🔴 **同じ判定を 2 か所に生やさない**(CLAUDE.md の規律)。初版は sidebar の
 * 描画ループの中だけに絞り込みがあり、**削除後の後継選択は絞り込み前の並び**を
 * 見ていた。結果、実証されたとおり:
 *
 * ```
 * A-りんご / B-ひみつ / C-りんご を「りんご」で絞る(見えるのは 2 件)
 * A を削除 → 詳細ペインが **B-ひみつ**(見えていない entry)になる
 * もう一度「削除」を押すと B-ひみつ が消える
 * ```
 *
 * 「見えているもの」を決める規則がここ 1 つになったので、一覧・後継選択・
 * ランチャーが**同じ答え**を返す。
 *
 * 🔑 **pure module**。題名だけを見る ── 本文は常駐していないので、全文検索を
 * ここでやると全 body の読込が要る(それは SQL 側の仕事)。
 */

/** 比較に使う形へ(前後の空白を落として小文字化)。空文字 = 絞り込み無し。 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** ⚠ `query` は **`normalizeQuery` 済み**を渡す(1 打鍵ごとに n 回 trim しない)。 */
export function matchesTitle(title: string, normalizedQuery: string): boolean {
  return normalizedQuery === '' || title.toLowerCase().includes(normalizedQuery);
}

/**
 * 🔴 **題名 + 本文**で見る(#181)。本文の当たりは SQL 側から来た lid の集合で渡す
 * ── 本文は主スレッドに常駐していないので、ここで本文そのものは見られない。
 *
 * ⚠ **規則はこの 1 か所**。絞り込みを描く面は 5 つある(sidebar / launcher /
 * filer / kanban / calendar)ので、面ごとに OR を書くと**必ずどれかが題名だけの
 * まま取り残される**(CLAUDE.md §7 ── 実際 PKC2 で 4 面に散った)。
 *
 * @param bodyHits SQL が返した「本文が当たった lid」。⚠ **null は「まだ返って
 *   いない」**であって「0 件」ではない ── 打った直後は題名の結果だけを見せ、
 *   返ってきたら増える(消えるのではなく増える向きに倒す)。
 */
export function matchesEntry(
  lid: string,
  title: string,
  normalizedQuery: string,
  bodyHits: ReadonlySet<string> | null,
): boolean {
  if (normalizedQuery === '') return true;
  return matchesTitle(title, normalizedQuery) || bodyHits?.has(lid) === true;
}

/**
 * 絞り込みに残る lid を**元の並びのまま**返す。
 *
 * @param titleOf lid → 題名(未知 lid は `undefined` を返してよい ── 落とす)
 */
export function visibleOrder(
  order: readonly string[],
  titleOf: (lid: string) => string | undefined,
  query: string,
): string[] {
  const q = normalizeQuery(query);
  const out: string[] = [];
  for (const lid of order) {
    const title = titleOf(lid);
    if (title === undefined) continue;
    if (!matchesTitle(title, q)) continue;
    out.push(lid);
  }
  return out;
}
