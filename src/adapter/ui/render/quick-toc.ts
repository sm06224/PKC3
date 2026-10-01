/**
 * Quick Table of Contents (ToC) Popover (Issue #1130).
 *
 * 長文ノート閲覧時、本文プレビュー画面に目次ポップオーバーボタンを配置し、
 * インスペクターを開かずにワンタップで目的の見出しへジャンプできるようにする。
 */
import { activeHeadingIndex } from '../../../features/markdown/active-heading';
import { extractHeadingText } from './heading-anchor';

/** 現在地の印(目次の行に付く)。CSS(`app.css`)が読む。 */
const ACTIVE_ATTR = 'data-pkc-active';
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

export interface QuickTocItem {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

export interface QuickTocHandle {
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly popover: HTMLElement;
  dispose: () => void;
  update: () => void;
}

/**
 * @param scroller 実際にスクロールする器(#1168)。渡すと、**目次を開いている間だけ**
 *   その送りを見て、いま読んでいる見出しの行へ `data-pkc-active` を付ける。
 *   ⚠ 省略できる(2 引数の呼び出しはこれまでどおり ── 印は付かない)。
 */
export function installQuickToc(
  container: HTMLElement,
  bodyHost: HTMLElement,
  scroller?: HTMLElement,
): QuickTocHandle {
  const doc = container.ownerDocument;

  const wrapper = doc.createElement('div');
  wrapper.className = 'pkc-quick-toc';
  wrapper.hidden = true;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'pkc-quick-toc-btn';
  button.setAttribute('aria-label', '目次を開く');
  button.setAttribute('title', '目次を開く');
  button.setAttribute('aria-expanded', 'false');

  const icon = doc.createElement('span');
  icon.className = 'pkc-quick-toc-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '≡';

  const label = doc.createElement('span');
  label.className = 'pkc-quick-toc-label';
  label.textContent = '目次';

  button.append(icon, label);

  const popover = doc.createElement('div');
  popover.className = 'pkc-quick-toc-popover';
  popover.hidden = true;

  const header = doc.createElement('div');
  header.className = 'pkc-quick-toc-header';

  const title = doc.createElement('span');
  title.className = 'pkc-quick-toc-title';
  title.textContent = '目次';

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pkc-quick-toc-close';
  closeBtn.setAttribute('aria-label', '目次を閉じる');
  closeBtn.textContent = '×';

  header.append(title, closeBtn);

  const list = doc.createElement('ul');
  list.className = 'pkc-quick-toc-list';

  popover.append(header, list);
  wrapper.append(button, popover);

  container.append(wrapper);

  /** 目次の行と、その行が指す見出し(同じ添字で対になる)。update() が組み直す。 */
  let itemEls: HTMLElement[] = [];
  let headingEls: HTMLElement[] = [];
  let activeIdx = -1;

  /**
   * 🔴 **いま読んでいる見出しの行へ印を付ける**(#1168)。
   *
   * ⚠ 採寸は `getBoundingClientRect` ── 開いている間の送りごと(rAF で間引く)にしか
   *   走らない。閉じている間は 1 度も呼ばれない(下の `startTracking` / `stopTracking`)。
   * ⚠ **畳んだ章の中の見出し**は箱が無い(0×0)ので数えない ── 数えると位置が 0 になって
   *   「先頭の見出し」と取り違える。畳んだ章の見出しは、親の見出しが代わりに光る。
   * ⚠ **IntersectionObserver は使わない**(`mermaid-hydrate.ts` の注意)── 位置は自分で採る。
   *
   * 🔴 **段組み**(#505)では送りが**横**で、見出しは「列の位置」で並ぶ。器は
   *   `bodyHost`(横送りの持ち主)になり、鍵は「左端からの距離 × 桁 + 列の中の高さ」。
   *   ⚠ 引用の中の見出しのように字下げされた物は、`COLUMN_LEFT_TOLERANCE` までは
   *   同じ列と見なす近似である(それ以上の字下げは次の列として数えうる)。
   */
  const refreshActive = (reveal: boolean): void => {
    if (scroller === undefined) return;
    const columns = bodyHost.closest(COLUMNS_ON_SELECTOR) !== null;
    const frame = columns ? bodyHost : scroller;
    const fr = frame.getBoundingClientRect();
    const idxs: number[] = [];
    const keys: number[] = [];
    let prev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < headingEls.length; i++) {
      const r = (headingEls[i] as HTMLElement).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      let key = columns
        ? Math.round(r.left - fr.left) * COLUMN_STRIDE + (r.top - fr.top)
        : r.top - fr.top;
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
     */
    if (keys.length > 0) {
      const pos = columns ? frame.scrollLeft : frame.scrollTop;
      const room = columns
        ? frame.scrollWidth - frame.clientWidth
        : frame.scrollHeight - frame.clientHeight;
      const atEnd = columns
        ? room > END_SLACK && pos >= room - END_SLACK
        : pos > END_SLACK && bodyHost.getBoundingClientRect().bottom <= fr.top + frame.clientHeight + END_SLACK;
      if (atEnd) hit = keys.length - 1;
      else if (room > END_SLACK && pos <= END_SLACK && hit < 0) hit = 0;
    }
    const next = hit < 0 ? -1 : (idxs[hit] as number);
    for (let i = 0; i < itemEls.length; i++) {
      const li = itemEls[i] as HTMLElement;
      const link = li.firstElementChild;
      if (i === next) {
        li.setAttribute(ACTIVE_ATTR, '');
        link?.setAttribute('aria-current', 'location');
      } else {
        li.removeAttribute(ACTIVE_ATTR);
        link?.removeAttribute('aria-current');
      }
    }
    // 目次の中が長くて、光った行が見えない所にあるときだけ寄せる(変わったときと開いた直後)
    if (next >= 0 && (reveal || next !== activeIdx)) {
      /**
       * ⚠ **`scrollIntoView` は使わない** ── 目次は `position: sticky` の箱の中に在り、
       *   `scrollIntoView` は**祖先のスクロール全部**(= 本文の送り)まで動かす。
       *   実ブラウザで、開いた瞬間に本文が末尾付近へ飛んだ(実測)。動かすのは
       *   ポップオーバー自身の送りだけにする。
       */
      const el = itemEls[next] as HTMLElement;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (top < popover.scrollTop) popover.scrollTop = top;
      else if (bottom > popover.scrollTop + popover.clientHeight) {
        popover.scrollTop = bottom - popover.clientHeight;
      }
    }
    activeIdx = next;
  };

  // ── 送りの購読 ── 🔴 開いている間だけ(閉じている間は 1 本も張らない)
  let rafId: number | null = null;
  let tracking: HTMLElement[] = [];
  const requestFrame =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
  const cancelFrame =
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);
  const onScroll = (): void => {
    if (rafId !== null) return;
    rafId = requestFrame(() => {
      rafId = null;
      refreshActive(false);
    });
  };
  const startTracking = (): void => {
    if (scroller === undefined || tracking.length > 0) return;
    // 縦送りは `scroller`、段組みの横送りは `bodyHost` ── scroll は泡立たないので両方に張る
    tracking = scroller === bodyHost ? [scroller] : [scroller, bodyHost];
    for (const t of tracking) t.addEventListener('scroll', onScroll, { passive: true });
    refreshActive(true);
  };
  const stopTracking = (): void => {
    for (const t of tracking) t.removeEventListener('scroll', onScroll);
    tracking = [];
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
  };

  const closePopover = (): void => {
    if (!popover.hidden) {
      popover.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }
    stopTracking();
  };

  const togglePopover = (ev: MouseEvent): void => {
    ev.stopPropagation();
    const willOpen = popover.hidden;
    popover.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) startTracking();
    else stopTracking();
  };

  const onDocClick = (ev: MouseEvent): void => {
    if (!wrapper.contains(ev.target as Node)) {
      closePopover();
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      closePopover();
    }
  };

  button.addEventListener('click', togglePopover);
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closePopover();
  });
  doc.addEventListener('click', onDocClick);
  doc.addEventListener('keydown', onKeyDown);

  const update = (): void => {
    const headings = bodyHost.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    const items: QuickTocItem[] = [];
    const found: HTMLElement[] = [];

    for (const h of headings) {
      const id = h.id.trim();
      if (!id) continue;
      const text = extractHeadingText(h);
      if (!text) continue;
      const level = parseInt(h.tagName.slice(1), 10) || 1;
      items.push({ id, text, level });
      found.push(h);
    }

    list.textContent = '';
    itemEls = [];
    headingEls = found;
    activeIdx = -1;

    if (items.length === 0) {
      wrapper.hidden = true;
      closePopover();
      return;
    }

    wrapper.hidden = false;

    for (const item of items) {
      const li = doc.createElement('li');
      li.className = 'pkc-quick-toc-item';
      li.setAttribute('data-pkc-toc-level', String(item.level));

      const link = doc.createElement('button');
      link.type = 'button';
      link.className = 'pkc-quick-toc-link';
      link.setAttribute('data-pkc-action', 'toc-jump');
      link.setAttribute('data-pkc-toc-slug', item.id);
      link.textContent = item.text;
      link.title = item.text;

      link.addEventListener('click', () => {
        closePopover();
      });

      li.append(link);
      list.append(li);
      itemEls.push(li);
    }

    // 開いている間に本文が描き直されたら、印も付け直す(組み直した行には印が無い)
    if (!popover.hidden) refreshActive(true);
  };

  update();

  const dispose = (): void => {
    stopTracking();
    button.removeEventListener('click', togglePopover);
    doc.removeEventListener('click', onDocClick);
    doc.removeEventListener('keydown', onKeyDown);
    wrapper.remove();
  };

  return {
    element: wrapper,
    button,
    popover,
    dispose,
    update,
  };
}
