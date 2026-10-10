/**
 * 🔴 **読んでいた場所を「先頭の塊 + その塊の中のずれ」で憶える**(#1490)。
 *
 * ⚠ 送り量(px)だけで憶えると、戻ったときに**上側の塊の高さが違う**と別の行が出る ──
 *   図の多い長いノート(20,000 行)で、別のノートを選んでから戻ると約 1,600 行先へ飛んでいた。
 *   離れるときに焼けていた図が、戻った直後はまだ原文のまま(高さが違う)だからである。
 * 🔑 塊の行番号(`data-pkc-source-line`)は本文が同じなら変わらないので、それを目印にする。
 *   戻した後に上側の図が焼けて高さが変わっても、ブラウザのスクロールアンカーが目印の塊を保つ。
 * ⚠ 配置を持たない環境(happy-dom)や、目印が見つからないときは `null` ── 呼び手は px で戻す。
 */
export interface ReadAnchor {
  /** 画面の先頭にある塊の、原文の開き行。 */
  readonly line: number;
  /** その塊の上端から、画面の上端までのずれ(px)。 */
  readonly offset: number;
}

const LINE_ATTR = 'data-pkc-source-line';

/** 器の中での塊の上端(送り量と同じ座標)。 */
function contentTop(el: HTMLElement, scroller: HTMLElement, scrollerTop: number): number {
  return el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
}

/**
 * いま画面の先頭にある塊を目印として返す。
 * ⚠ 読むのは塊の位置だけ(配置は呼び手が `scrollTop` を読んだ時点で済んでいる)。
 *   塊は上から順に並ぶので二分探索する ── 20,000 塊でも 15 回ほどしか読まない。
 */
export function captureReadAnchor(host: HTMLElement, scroller: HTMLElement): ReadAnchor | null {
  const blocks = host.children;
  if (blocks.length === 0) return null;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const top = scroller.scrollTop;
  let lo = 0;
  let hi = blocks.length - 1;
  let found = -1;
  // 下端が画面の上端より下にある最初の塊
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = (blocks[mid] as HTMLElement).getBoundingClientRect();
    if (r.bottom - scrollerTop > 0) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found < 0) return null;
  // 行番号を持つ塊まで下へ進む(持たない塊は目印にできない)
  for (let i = found; i < blocks.length; i++) {
    const el = blocks[i] as HTMLElement;
    const raw = el.getAttribute(LINE_ATTR);
    if (raw === null) continue;
    const line = Number(raw);
    if (!Number.isInteger(line)) continue;
    // ⚠ 配置を持たない環境(高さが全部 0)では、上の二分探索が 1 塊も選ばないので、ここへは来ない
    return { line, offset: top - contentTop(el, scroller, scrollerTop) };
  }
  return null;
}

/**
 * 目印の塊のいまの位置から、戻す送り量を返す。見つからなければ `null`(呼び手は px で戻す)。
 * ⚠ 本文が入った**後**に呼ぶ。読むのは 1 塊の位置だけ。
 */
export function resolveReadAnchor(
  host: HTMLElement,
  scroller: HTMLElement,
  anchor: ReadAnchor,
): number | null {
  const want = String(anchor.line);
  for (const child of host.children) {
    if (child.getAttribute(LINE_ATTR) !== want) continue;
    const el = child as HTMLElement;
    if (el.getBoundingClientRect().height === 0) return null;
    const scrollerTop = scroller.getBoundingClientRect().top;
    return Math.max(0, contentTop(el, scroller, scrollerTop) + anchor.offset);
  }
  return null;
}
