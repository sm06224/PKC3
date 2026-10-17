/**
 * 🔴 **開いているノートの行が一覧の画面の外にあるとき、見える所まで送る量**(依頼 277。Gemini 回答 = A)。
 *
 * 絞り込みを変えた後や、リンク・「操作を探す」で別のフォルダのノートを開いた後、
 * 左の一覧は前の位置のままで、開いているノートの行が見えなかった。
 *
 * ⚠ **一部でも見えているなら動かさない** ── 行を押したとき、半分見えていた行が真ん中へ跳ぶと
 *   続けて隣を押そうとして押し間違える(「最近開いた順」で押した行が跳ばないのと同じ向き)。
 * ⚠ 外にあるときは**真ん中**へ(端に寄せると前後の行が見えず、どこに居るか分からない。
 *   画面の外の行は高さが概算なので、端ぴったりに合わせても少しずれる)。
 * ⚠ 画面がまだ無い(高さ 0 ── 隠れている面・スマートフォンで一覧が畳まれている)ときは動かさない。
 * @returns 一覧の `scrollTop` に足す量(0 = 動かさない)
 */
export function revealDelta(
  rowTop: number,
  rowBottom: number,
  viewTop: number,
  viewBottom: number,
): number {
  if (viewBottom - viewTop <= 0) return 0;
  if (rowBottom <= rowTop) return 0;
  if (rowBottom > viewTop && rowTop < viewBottom) return 0;
  return (rowTop + rowBottom) / 2 - (viewTop + viewBottom) / 2;
}
