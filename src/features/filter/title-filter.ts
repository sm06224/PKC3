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
 * 🔴 **絞り込みが見る相手**。`EntryMeta` がそのまま渡せる形にしてある。
 *
 * ⚠ **位置引数で `title` と `archetype` を並べない** ── どちらも `string` なので、
 *   取り違えても tsc が黙る(「種類で絞ったのに題名で絞れている」は画面上
 *   まったく同じ顔をする)。
 */
export interface FilterTarget {
  readonly lid: string;
  readonly title: string;
  readonly archetype: string;
}

/**
 * 🔴 **絞り込みの条件 ── 語と種類を 1 つの束にする**(#411)。
 *
 * ⚠ **束にしたのは、面ごとに片方だけ渡す事故を止めるため**である。語だけを
 *   引数に取る形のままだと、種類を足したときに**渡し忘れた面だけ絞りが外れる**
 *   ── 症状は「一覧では添付だけなのに、フォルダへ行くと全部出る」で、
 *   user からは**絞りが勝手に解けた**ようにしか見えない(CLAUDE.md §7)。
 */
export interface EntryFilter {
  /** ⚠ **`normalizeQuery` 済み**を入れる(1 打鍵ごとに n 回 trim しない)。 */
  readonly query: string;
  /** SQL が返した「本文が当たった lid」。`null` = **まだ返っていない**。 */
  readonly bodyHits: ReadonlySet<string> | null;
  /**
   * 🔴 **選ばれている種類。空 = 絞らない**(PKC2 と同じ規則)。
   *
   * ⚠ 「1 つも選んでいない」を「1 件も出さない」にしてはいけない ──
   *   user は**壊れたと読む**(そして解き方が画面のどこにも出ていない)。
   */
  readonly kinds: ReadonlySet<string>;
}

/** 種類で絞っていない状態。⚠ 呼び手ごとに `new Set()` を書かない(毎描画の確保になる)。 */
export const NO_KINDS: ReadonlySet<string> = new Set<string>();

/**
 * 🔴 **絞り込みの条件を組む唯一の口**(#411)。`normalizeQuery` をここでやる。
 * ⚠ 呼び手が生の文字列を `query` に入れる事故を、この関数を通すことで防ぐ
 *   (前後に空白が付いた語は**何にも当たらない**ので、症状は「絞ると空になる」)。
 */
export const entryFilterOf = (
  rawQuery: string,
  bodyHits: ReadonlySet<string> | null,
  kinds: ReadonlySet<string>,
): EntryFilter => ({ query: normalizeQuery(rawQuery), bodyHits, kinds });

/**
 * 🔴 **題名 + 本文 + 種類**で見る(#181 / #411)。本文の当たりは SQL 側から来た
 * lid の集合で渡す ── 本文は主スレッドに常駐していないので、ここで本文そのものは
 * 見られない。
 *
 * ⚠ **規則はこの 1 か所**。絞り込みを描く面は 5 つある(sidebar / launcher /
 * filer / 予定 / 2 ペイン)ので、面ごとに OR を書くと**必ずどれかが題名だけの
 * まま取り残される**(CLAUDE.md §7 ── 実際 PKC2 で 4 面に散った)。
 *
 * ⚠ **種類は語より先に見る**(そして語が空でも効く)── 「種類で絞っただけ」の
 *   ときに `query === ''` で早期 return すると、**札を押しても何も変わらない**。
 */
export function matchesEntry(target: FilterTarget, filter: EntryFilter): boolean {
  if (filter.kinds.size > 0 && !filter.kinds.has(target.archetype)) return false;
  if (filter.query === '') return true;
  return matchesTitle(target.title, filter.query) || filter.bodyHits?.has(target.lid) === true;
}

/**
 * 絞り込みに残る lid を**元の並びのまま**返す。
 *
 * 🔴 **本文の当たりもここで見る**(2026-08-15 に修理)。
 * ⚠ 直す前は `matchesTitle` しか見ておらず、**一覧(`matchesEntry`)と答えが
 *   食い違っていた** ── 唯一の呼び手は「削除したあと、次にどれを選ぶか」なので、
 *   **本文だけが当たっているノートを消すと `indexOf` が -1 になり、選択が `null`
 *   へ飛ぶ**(一覧にはまだ行が見えているのに、中央が空になる)。
 * 🔑 この file の冒頭が「面ごとに OR を書くと必ずどれかが取り残される」と
 *   戒めている、その当の事故である ── **判定は `matchesEntry` 1 つに寄せた**。
 *
 * ⚠ **種類の絞りもここを通る**(#411)── 通さないと、添付だけを出しているときに
 *   ノートを消すと、**画面に出ていないノート**が次に選ばれる(上とまったく同じ事故が
 *   軸を変えて戻ってくる)。だから受けるのは題名ではなく **meta** である。
 *
 * @param targetOf lid → 絞り込みが見る相手(未知 lid は `undefined` を返してよい ── 落とす)
 */
export function visibleOrder(
  order: readonly string[],
  targetOf: (lid: string) => FilterTarget | undefined,
  filter: EntryFilter,
): string[] {
  const out: string[] = [];
  for (const lid of order) {
    const target = targetOf(lid);
    if (target === undefined) continue;
    if (!matchesEntry(target, filter)) continue;
    out.push(lid);
  }
  return out;
}
