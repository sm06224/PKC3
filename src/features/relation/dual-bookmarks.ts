/**
 * 🔴 **2 ペインファイラの「留めた場所」**(#273 残件。user 指示 2026-08-19
 * 「往年の FD などを見習ってください / OS のファイラと同じことができないといけません」)。
 *
 * ## 何のために在るか
 *
 * 深い所に置いた作業用のフォルダへ、**毎回パンくずを辿らずに**行けるようにする。
 * 古典の 2 ペインファイラ(Total Commander / Double Commander / FAR / Krusader)は
 * 例外なく持っており、**帯 1 本 + 1 打鍵**というのが共通の形である。
 *
 * ## ⚠ 決めごと
 *
 * - 🔑 **留めるのは「場所」だけ**(フォルダの lid)── ノートを留める道は
 *   別に在る(左の列で開ける)。ここは**行き先**の話である
 * - ⚠ **ルート(`null`)は留めない** ── パンくずの左端が常にルートなので、
 *   1 押しで行ける所を帯に並べても枠を食うだけである
 * - 🔴 **置けるなら外せる**(user 指示 2026-08-23「なんで双方向にする発想が
 *   でねぇんだよ!」)── 留める口と外す口は**必ず対で**置く
 * - ⚠ **消えたフォルダの分も落とさない**(この module では)── 落とすのは
 *   描く側の仕事である。ここで黙って消すと、**取り違えて消した直後に
 *   ゴミ箱から戻した**ときに留めが復活しない
 *
 * ⚠ **pure module**。browser API も dispatch も触らない。
 */

/**
 * 留められる上限。
 * ⚠ 上限は**手違いの検出**である ── 押し続けて 500 件になると帯が版面を食い尽くす
 * (`MAX_TABS` と同じ理由)。⚠ 超えたら**古いほうから捨てる**のではなく
 * **足すのを断る** ── 黙って消えると「留めたのに無い」になる。
 */
export const MAX_BOOKMARKS = 20;

/** 保存の形を読む。⚠ **どんな壊れ方でも空へ落ちる**(留めが読めないだけで面が死なない)。 */
export function decodeBookmarks(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== 'string' || x === '') continue;
      if (out.includes(x)) continue;
      out.push(x);
      if (out.length >= MAX_BOOKMARKS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export const encodeBookmarks = (list: readonly string[]): string => JSON.stringify([...list]);

/**
 * 留める / 外すを 1 本で決める(押し口は 1 つ ── 同じボタンが二役)。
 * @returns 変わらないときは**同じ配列**を返す(描き直しの判定に使える)
 */
export function toggleBookmark(list: readonly string[], lid: string): string[] {
  if (lid === '') return [...list];
  if (list.includes(lid)) return list.filter((x) => x !== lid);
  // ⚠ 上限で断る(黙って古いものを捨てない)
  if (list.length >= MAX_BOOKMARKS) return [...list];
  return [...list, lid];
}

/** 留めてあるか。⚠ 判定はここ 1 か所(押し口の字と帯の並びが食い違わないように)。 */
export const isBookmarked = (list: readonly string[], lid: string | null): boolean =>
  lid !== null && list.includes(lid);
