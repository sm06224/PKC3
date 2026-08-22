/**
 * 🔴 **別のタブ / 窓が書いたことを、編集中のタブへ届ける**(#178。2026-08-22)。
 *
 * ## なぜ要るのか
 *
 * 他タブの書込(`changed` の放送)は `main.ts` で **`reloadSnapshot` を頼むだけ**
 * で、**編集中はまるごと先送り**されていた。だから編集中のタブは
 * 「自分が読んだ後に誰かが書いた」ことを**最後まで知らない** ── 保存すると
 * 相手の版を上書きし、しかも**何も出ない**。
 *
 * ⚠ #300 段③ で組み込みアプリが**既定で別窓**になったので、これは
 * 「多重タブを使う人だけ」の話ではなくなった ── **カレンダーで日付を付ける動線
 * そのもの**がこれを踏む(本文を書いている窓の隣で、別窓が同じノートを書く)。
 *
 * ## ここが持つ判断は 3 つだけ
 *
 * ① **編集中でなければ何もしない** ── `ready` は `reloadSnapshot` が先送りなしで
 *    面倒を見る。両方で受けると、同じ問いに答える口が 2 つになる(CLAUDE.md §7)
 * ② **自分が編集しているノートが対象でなければ、本文を取りに行かない**
 *    ── 他人のノートの本文を読むのは丸損である(`lids === null` = 「全部」は
 *    範囲が読めないので、取りに行く側へ倒す)
 * ③ 読めなかったら黙って何もしない(消えた行の `changed` が届いた回)
 *
 * ⚠ **印を立てるところ(reducer)は別**である ── ここは「誰に聞くか」だけを決める。
 */

/** ⚠ 差し替えられる形にしておく(`main.ts` はどの test からも実行されない)。 */
export interface RemoteChangeDeps {
  /** いま編集中のノート。編集中でなければ `null`。 */
  readonly editingLid: () => string | null;
  readonly getBody: (lid: string) => Promise<string | null>;
  /** 届いた disk の内容を state へ渡す(`REMOTE_BODY_CHANGED`)。 */
  readonly apply: (lid: string, body: string) => void;
}

/**
 * 他タブの書込の知らせを受ける。
 *
 * @param lids 変わったノート。`null` = **範囲が分からない**(全部かもしれない)
 * @returns 本文を取りに行ったか(test の観測点 ── 「無駄に読んでいない」を見る)
 */
export async function noteRemoteChange(
  lids: readonly string[] | null,
  deps: RemoteChangeDeps,
): Promise<boolean> {
  const lid = deps.editingLid();
  if (lid === null) return false; // ① 編集中でなければ reloadSnapshot の仕事
  if (lids !== null && !lids.includes(lid)) return false; // ② 自分のノートではない
  const body = await deps.getBody(lid);
  if (body === null) return true; // ③ 消えていた ── 黙って何もしない
  deps.apply(lid, body);
  return true;
}
