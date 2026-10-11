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
  // ⚠ 畳んだ章(`hidden`)の塊は高さ 0 で、位置の並びが崩れる ── 高さを持つ次の塊で比べる
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let m = mid;
    let r = (blocks[m] as HTMLElement).getBoundingClientRect();
    while (r.height === 0 && m < hi) r = (blocks[++m] as HTMLElement).getBoundingClientRect();
    if (r.height === 0) {
      hi = mid - 1; // mid〜hi は全部高さ 0 ── 答えは左にしか無い
    } else if (r.bottom - scrollerTop > 0) {
      found = m;
      hi = mid - 1;
    } else {
      lo = m + 1;
    }
  }
  if (found < 0) return null;
  // 行番号を持つ塊まで下へ進む(持たない塊は目印にできない)
  for (let i = found; i < blocks.length; i++) {
    const el = blocks[i] as HTMLElement;
    const raw = el.getAttribute(LINE_ATTR);
    if (raw === null) continue;
    // ⚠ 畳んだ章の塊(高さ 0)は目印にしない ── 戻ったときは開いているので位置が合わない
    if (el.getBoundingClientRect().height === 0) continue;
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


/**
 * 🔴 **戻した後に塊の高さが変わったら、目印の位置へ合わせ直す**(#1525)。
 *
 * ⚠ 戻す瞬間(`resolveReadAnchor`)は、目印の塊が**まだ仮の高さ**だと「塊の中のずれ」が
 *   塊の外へはみ出す(図は焼けるまで低い)── ブラウザのスクロールアンカーは**その時点で見えている
 *   塊**を保つだけなので、後ろの塊に固定されて**元の行より後ろ**が出た
 *   (実ブラウザ:図 40 個・約 2,000 行で +74 行、20,000 行で +1,572 行)。
 * 🔑 器(本文)の高さが変わるたびに、目印の位置から送り量を引き直す。
 * ⚠ **読んでいる人の手・アプリ内の移動を奪わない** ── 止める条件は 3 つ:
 *   ① 送り・押下・キー・タッチが**文書のどこかに**入った(目次・探す・リンク先の列など、器の外から始まる移動も含む。
 *      `search-jump.ts` の `scrollToHit` と同じく `ownerDocument` で聞く)
 *   ② **自分が書いていない送り**が起きた(`scrollIntoView` など、入力の無い移動)。
 *      ⚠ 高さが変わった直後の送りはブラウザのスクロールアンカーの調整なので数えない
 *   ③ {@link HOLD_MS} が過ぎた(焼き上がりを待つ上限。常駐させない)。
 */
export const HOLD_MS = 8000;
/** 合わせ直しの許容(px)。これ以下のずれでは書かない(書くと無用なスクロールが起きる)。 */
export const HOLD_TOLERANCE_PX = 1;

/** 合わせ直すか。`want` が取れない(目印が消えた)/ 許容内なら `null`。 */
export function realignTarget(want: number | null, current: number): number | null {
  if (want === null) return null;
  return Math.abs(want - current) > HOLD_TOLERANCE_PX ? want : null;
}

export interface ReadAnchorHold {
  dispose(): void;
}

export const HOLD_STOP_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export function installReadAnchorHold(
  host: HTMLElement,
  scroller: HTMLElement,
  anchor: ReadAnchor,
): ReadAnchorHold {
  const doc = scroller.ownerDocument;
  let done = false;
  // 自分が最後に置いた送り量と、そのときの本文の高さ(②の見分けに使う)
  let lastSet = scroller.scrollTop;
  let lastHeight = scroller.scrollHeight;
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => realign());
  const timer = setTimeout(() => stop(), HOLD_MS);
  function stop(): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ro?.disconnect();
    for (const ev of HOLD_STOP_EVENTS) doc.removeEventListener(ev, stop, true);
    scroller.removeEventListener('scroll', onScroll);
  }
  function onScroll(): void {
    if (done) return;
    const h = scroller.scrollHeight;
    if (h !== lastHeight) {
      // 高さが変わった直後の送りは、ブラウザのスクロールアンカーの調整(次の合わせ直しで上書きする)
      lastHeight = h;
      return;
    }
    if (Math.abs(scroller.scrollTop - lastSet) > HOLD_TOLERANCE_PX) stop();
  }
  function realign(): void {
    if (done) return;
    const to = realignTarget(resolveReadAnchor(host, scroller, anchor), scroller.scrollTop);
    if (to !== null) {
      scroller.scrollTop = to;
      lastSet = scroller.scrollTop; // ⚠ 書いた値ではなく、丸められた後の値
    }
    lastHeight = scroller.scrollHeight;
  }
  for (const ev of HOLD_STOP_EVENTS) doc.addEventListener(ev, stop, { capture: true, passive: true });
  scroller.addEventListener('scroll', onScroll, { passive: true });
  ro?.observe(host);
  return { dispose: stop };
}
