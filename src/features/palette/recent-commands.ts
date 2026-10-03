/**
 * 「最近使った操作」── 左の列の探す欄に **`>` だけ**を打ったとき、**と**、「操作を探す」
 * (Ctrl+Shift+P)を開いたとき、一覧の先頭に出す(#274 段①の続き。🟣 Gemini 裁定 A、2026-10-02 /
 * Q1 = A・Q3 = A、2026-10-03)。**pure module**。
 *
 * ## 🔴 憶えるのは操作の **id** だけ
 *
 * ⚠ 名前(label)は改名で変わる。id で憶えれば、改名後もそのまま同じ操作が出る。
 * ⚠ 憶えるのは「この一覧から実行した」ときだけ(置き場は端末ごと、
 *   `adapter/platform/recent-commands-store.ts`)。**container に入れない** ──
 *   `search-log.ts` と同じ判断(何を使っていたかは、書き出しに同乗させる物ではない)。
 *
 * ## 🔴 「名前がまだ無い」かどうかの判定は、ここ 1 か所
 *
 * `>` の後ろが空(空白だけを含む)のときだけ節を出す。**1 字でも打ったら出さない** ──
 * 絞り込み中に別の節が混ざると、「打った字で探した結果」が読めなくなる。
 * ⚠ 判定を描画側にも書くと、片方だけ空白の扱いが違う日が来る(§7)ので、
 *   `splitRecentRows` が `query` ごと受けて決める。
 *
 * ## 🔴 消えた操作・いま押せない操作は出さない
 *
 * 憶えた id が、いまの一覧に無い(版が変わって消えた)ときは落とす。
 * ⚠ 一覧から消えた id を出すと、押せない行が「最近使った」に居座る。
 * 🔴 **いま押せない(`ready` が偽)操作も節から外す**(#274 Q1 = A。2026-10-03)── 節の先頭が
 *   押せない行だと、そこで `Enter` / `↓` が空振りする。⚠ **記録は消さない**(押せるように
 *   なれば、また出る)。外した行は `rest` に残る(普通の一覧では理由つきで並ぶ)。
 *   ⚠ **5 件は「押せる物だけで」数える**(押せない行が枠を食って 3 件しか出ない、を作らない)。
 *
 * ## 🔴 記録は 1 つ(左の列の `>` と、操作を探す面の両方が使う)
 *
 * 置き場(`recent-commands-store.ts`)は 1 つ。どちらの面から実行しても同じ記録に積み、
 * どちらの面でも同じ節が出る(#274 Q3 = A)。
 */

/** 節に出す上限。⚠ 5 件は見立て(一覧の頭に置いて邪魔にならない数)。 */
export const RECENT_COMMANDS_MAX = 5;
/**
 * 憶える件数。🔴 **出す上限より多く憶える**(UX レビュー 2026-10-03、PR #1318)── 節は「押せる物だけ」で
 * 5 件まで出すので、憶えるのも 5 件だと、押せない行のぶん節が 3 件・2 件へ縮む(穴埋めの元が無い)。
 * 10 は「編集中の操作 5 つと閲覧中の操作 5 つを行き来しても、どちらの面でも 5 件出る」見立て。
 */
export const RECENT_COMMANDS_KEEP = 10;

/** 節の見出し。 */
export const RECENT_COMMANDS_HEADING = '最近使った操作';

/**
 * 実行した操作を積む。**新しい順**の配列を返す。
 *
 * ⚠ 同じ id を 2 行にしない(既に在れば先頭へ動かす)。⚠ 元の配列を壊さない。
 * ⚠ 空の id は積まない(渡された配列をそのまま写して返す)。
 */
export function pushRecentCommand(
  list: readonly string[],
  id: string,
  max = RECENT_COMMANDS_KEEP,
): string[] {
  if (id === '') return [...list];
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

/**
 * 一覧を「最近使った節」と「残り」に割る。
 *
 * @param query `>` の後ろの字(`commandQueryOf` の結果)
 * @param rows いまの操作の一覧(絞り込み済み。⚠ `ready` = いま押せるか)
 * @param ids 憶えている id(新しい順)
 * @returns `recent` = 節に出す行(新しい順・最大 `max`)/ `rest` = 残り(元の並びのまま)。
 *   ⚠ 節に出した行は `rest` から外す(同じ操作が 2 行並ばない ── 行を `data-pkc-command` で
 *   引く側も、↓ で降りる焦点も、1 つの操作を 1 行として扱える)。
 */
export function splitRecentRows<T extends { readonly id: string; readonly ready: boolean }>(
  query: string,
  rows: readonly T[],
  ids: readonly string[],
  max = RECENT_COMMANDS_MAX,
): { readonly recent: readonly T[]; readonly rest: readonly T[] } {
  if (query.trim() !== '') return { recent: [], rest: rows };
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const recent: T[] = [];
  for (const id of ids) {
    if (recent.length >= max) break;
    const row = byId.get(id);
    // 🔴 いまの一覧に無い id(消えた操作)・いま押せない行は落とす(記録は消さない)。⚠ 重複も 1 つに
    if (row === undefined || !row.ready || recent.includes(row)) continue;
    recent.push(row);
  }
  if (recent.length === 0) return { recent: [], rest: rows };
  const used = new Set(recent.map((r) => r.id));
  return { recent, rest: rows.filter((r) => !used.has(r.id)) };
}
