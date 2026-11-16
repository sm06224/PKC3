/**
 * 🔴 **いま読んでいる見出しを、画面の位置から選ぶ**(#1168 で クイック目次に入れた判定を、#1966 2-B で
 *   右のペインの目次と共有するために切り出した)。判定は **ここ 1 か所**(`quick-toc.ts` と
 *   `inspector-toc-spy.ts` が同じ関数を呼ぶ ── 2 つの目次で光る章が食い違わない)。
 *
 * ⚠ 採寸は `getBoundingClientRect` ── 呼び側が **1 描画フレームに 1 回まで**に間引く(rAF)。
 * ⚠ **畳んだ章の中の見出し**は箱が無い(0×0)ので数えない ── 数えると位置が 0 になって
 *   「先頭の見出し」と取り違える。畳んだ章の見出しは、親の見出しが代わりに光る。
 * ⚠ **IntersectionObserver は使わない**(`mermaid-hydrate.ts` の注意)── 位置は自分で採る。
 *
 * 🔴 **段組み**(#505)では送りが**横**で、見出しは「列の位置」で並ぶ。器は `bodyHost`(横送りの持ち主)になり、
 *   鍵は「左端からの距離 × 桁 + 列の中の高さ」。⚠ 引用の中の見出しのように字下げされた物は、
 *   `COLUMN_LEFT_TOLERANCE` までは同じ列と見なす近似である(それ以上の字下げは次の列として数えうる)。
 */
import { activeHeadingIndex } from '../../../features/markdown/active-heading';

/** 段組みが効いている面の印(`read-columns.ts` の `COLUMNS_ON_ATTR` と同じ字)。 */
const COLUMNS_ON_SELECTOR = '[data-pkc-columns-on]';
/** 縦送り: 画面の上から何割の所に引いた線を、越えた最後の見出しを「いま読んでいる」とする。 */
const PROBE_RATIO = 0.2;
/** 段組み: 器の左端からこの距離(px)までの列を「いまの列」とする(字下げ・端数の逃げ)。 */
const COLUMN_LEFT_TOLERANCE = 24;
/** 段組み: 「列の位置」と「列の中の高さ」を 1 本の昇順の鍵にするための桁。 */
const COLUMN_STRIDE = 100_000;
/** 末尾判定の端数(px)。 */
const END_SLACK = 2;

/**
 * @param headingEls 見出し(文書の並び順)
 * @param bodyHost 本文の器(段組みの横送りの持ち主。末尾の判定に下端を使う)
 * @param scroller 縦に送る器。⚠ `bodyHost` と同じ物でもよい(編集のプレビューは自分で送る)
 * @returns `headingEls` の添字。どれも線を越えていなければ `-1`
 */
export function pickActiveHeading(
  headingEls: readonly HTMLElement[],
  bodyHost: HTMLElement,
  scroller: HTMLElement,
): number {
  const columns = bodyHost.closest(COLUMNS_ON_SELECTOR) !== null;
  const frame = columns ? bodyHost : scroller;
  const fr = frame.getBoundingClientRect();
  const idxs: number[] = [];
  const keys: number[] = [];
  let prev = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < headingEls.length; i++) {
    const r = (headingEls[i] as HTMLElement).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let key = columns ? Math.round(r.left - fr.left) * COLUMN_STRIDE + (r.top - fr.top) : r.top - fr.top;
    // 昇順を保証する(二分探索の前提)── 浮動や字下げで逆転しても前の値で止める
    if (key < prev) key = prev;
    prev = key;
    idxs.push(i);
    keys.push(key);
  }
  const probe = columns
    ? COLUMN_LEFT_TOLERANCE * COLUMN_STRIDE + (COLUMN_STRIDE - 1)
    : frame.clientHeight * PROBE_RATIO;
  let hit = activeHeadingIndex(keys, probe);
  /**
   * ⚠ **いちばん下まで送ったら最後の見出し**。最後の節が短いと、その見出しは
   *   画面の上の線まで**永久に届かない**(最後の見出しへ飛んでも、1 つ前が光る)。
   *   ⚠ 先頭も同じ ── 最初の見出しの上に題名などが在ると、先頭まで戻しても線に届かない。
   *   ⚠ **送れない(全部収まっている)ときは当てない** ── 「末尾にいる」が常に真になる。
   * 🔴 **末尾の判定は器の `scrollHeight` ではなく「本文の下端が画面に入ったか」**で見る ──
   *   `scrollHeight` には**本文の外の子**(開いた目次のポップオーバー自身)が入るので、
   *   開いた瞬間に「底まで 130px 足りない」と読んで末尾の規則が外れる(実ブラウザで実測)。
   *   段組みの横送りは `bodyHost` 自身の幅で見る(外の子が混ざらない)。
   *   ⚠ 器と本文が同じ物(編集のプレビュー)なら、器の下端は常に画面の中なので `scrollHeight` で見る。
   */
  if (keys.length > 0) {
    const pos = columns ? frame.scrollLeft : frame.scrollTop;
    const room = columns ? frame.scrollWidth - frame.clientWidth : frame.scrollHeight - frame.clientHeight;
    const atEnd = columns
      ? room > END_SLACK && pos >= room - END_SLACK
      : bodyHost === frame
        ? room > END_SLACK && pos >= room - END_SLACK
        : pos > END_SLACK && bodyHost.getBoundingClientRect().bottom <= fr.top + frame.clientHeight + END_SLACK;
    if (atEnd) hit = keys.length - 1;
    else if (room > END_SLACK && pos <= END_SLACK && hit < 0) hit = 0;
  }
  return hit < 0 ? -1 : (idxs[hit] as number);
}
