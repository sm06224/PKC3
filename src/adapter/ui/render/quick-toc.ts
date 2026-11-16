/**
 * Quick Table of Contents (ToC) Popover (Issue #1130).
 *
 * 長文ノート閲覧時、本文プレビュー画面に目次ポップオーバーボタンを配置し、
 * インスペクターを開かずにワンタップで目的の見出しへジャンプできるようにする。
 * 🔑 押しは本文の右上の隅に留まる(#1178)── 「先頭へ戻る」と同じ右の列(`app.css`)。
 */
import { extractHeadingText } from './heading-anchor';
import { pickActiveHeading } from './active-heading-dom';

/** 現在地の印(目次の行に付く)。CSS(`app.css`)が読む。 */
const ACTIVE_ATTR = 'data-pkc-active';

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

/** 一覧の id を作る通し番号(同じ document に複数の目次が居ても id が重ならない)。 */
let popoverSeq = 0;

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
  button.setAttribute('aria-controls', `pkc-quick-toc-popover-${++popoverSeq}`);

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
  popover.id = button.getAttribute('aria-controls') ?? '';

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

  // 🔴 **先頭に置く**(#1178)── `sticky; top` は通常の位置より下へしか動けない。
  //   末尾の子だと、送った先では押しが画面の外に居る。高さ 0 なので本文は押し下げない。
  container.prepend(wrapper);

  /** 目次の行と、その行が指す見出し(同じ添字で対になる)。update() が組み直す。 */
  let itemEls: HTMLElement[] = [];
  let headingEls: HTMLElement[] = [];
  let activeIdx = -1;

  /**
   * 🔴 **いま読んでいる見出しの行へ印を付ける**(#1168)。
   *
   * ⚠ 採寸は `getBoundingClientRect` ── 開いている間の送りごと(rAF で間引く)にしか
   *   走らない。閉じている間は 1 度も呼ばれない(下の `startTracking` / `stopTracking`)。
   * 🔑 畳んだ章・段組みの扱いは `pickActiveHeading`(`active-heading-dom.ts`)の注記を参照。
   */
  const refreshActive = (reveal: boolean, frameStamp?: number): void => {
    if (scroller === undefined) return;
    // 🔑 判定は右のペインの目次と同じ 1 本(`active-heading-dom.ts`)
    const next = pickActiveHeading(headingEls, bodyHost, scroller, frameStamp);
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
    rafId = requestFrame((t?: number) => {
      rafId = null;
      refreshActive(false, t);
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
      // 🔴 焦点が一覧の中に居たまま隠すと、焦点は <body> へ落ちる(Esc・行の押しの後に Tab が頭からになる)。
      //   一覧の外から閉じた回(外の押し)は焦点に触らない。⚠ `preventScroll` ── 行を押した直後の送りと争わない。
      const hadFocus = popover.contains(doc.activeElement);
      popover.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (hadFocus) button.focus({ preventScroll: true });
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
    // 🔴 開いている間だけ捕捉段で止める(開いているノートまで閉じない)。閉じているときの `Esc` は通す。
    if (ev.key === 'Escape' && !popover.hidden) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closePopover();
    }
  };

  button.addEventListener('click', togglePopover);
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closePopover();
  });
  doc.addEventListener('click', onDocClick);
  doc.addEventListener('keydown', onKeyDown, true);

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

    headingEls = found;

    if (items.length === 0) {
      list.textContent = '';
      itemEls = [];
      activeIdx = -1;
      wrapper.hidden = true;
      closePopover();
      return;
    }

    if (wrapper.hidden) wrapper.hidden = false;

    /**
     * 🔴 **行を丸ごと作り直さない**(#1467 段 3-i)── この `update` は本文を描き直すたびに呼ばれる
     *   (`detail.ts`)ので、`list.textContent = ''` → 見出しごとに `append` だと、20,000 行の
     *   ノートでは描き直し 1 回に 600 個の `<li>` を挿していた(trace: MAIN への挿入 600 回)。
     *   見出しの列を前と index で突き合わせ、同じ位置は属性と字だけ直し(同じ値なら触らない)、
     *   足りない末尾を足し、余りを消す。
     * ⚠ 使い回した行の**印**(いま読んでいる章)は触らない ── 閉じた一覧は見えず、開き直すと
     *   `startTracking` の `refreshActive(true)` が全行を付け直す。開いたまま描き直された回は
     *   下の `refreshActive(true)`。
     */
    const next: HTMLElement[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      let li = itemEls[i];
      let link: HTMLButtonElement;
      // ⚠ `isConnected` で見ない ── 器が document に繋がっていない回(test の素の器)は全行が「作り直し」へ落ちて増殖する(レビューで実測)
      if (li === undefined || li.parentNode !== list) {
        li = doc.createElement('li');
        li.className = 'pkc-quick-toc-item';
        link = doc.createElement('button');
        link.type = 'button';
        link.className = 'pkc-quick-toc-link';
        link.setAttribute('data-pkc-action', 'toc-jump');
        link.addEventListener('click', () => {
          closePopover();
        });
        li.append(link);
        list.append(li);
      } else {
        link = li.firstElementChild as HTMLButtonElement;
      }
      if (li.getAttribute('data-pkc-toc-level') !== String(item.level)) {
        li.setAttribute('data-pkc-toc-level', String(item.level));
      }
      if (link.getAttribute('data-pkc-toc-slug') !== item.id) link.setAttribute('data-pkc-toc-slug', item.id);
      if (link.textContent !== item.text) link.textContent = item.text;
      if (link.title !== item.text) link.title = item.text;
      next.push(li);
    }
    for (let i = itemEls.length - 1; i >= items.length; i--) itemEls[i]?.remove();
    itemEls = next;
    if (popover.hidden) activeIdx = -1;

    // 開いている間に本文が描き直されたら、印も付け直す(組み直した行には印が無い)
    if (!popover.hidden) refreshActive(true);
  };

  update();

  const dispose = (): void => {
    stopTracking();
    button.removeEventListener('click', togglePopover);
    doc.removeEventListener('click', onDocClick);
    doc.removeEventListener('keydown', onKeyDown, true);
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
