/** @vitest-environment happy-dom */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { installQuickToc } from '../../src/adapter/ui/render/quick-toc';

describe('quick table of contents (ToC) popover (Issue #1130)', () => {
  let container: HTMLElement;
  let bodyHost: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    bodyHost = document.createElement('div');
    document.body.append(container, bodyHost);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders quick toc button and remains hidden when there are no headings', () => {
    const handle = installQuickToc(container, bodyHost);

    const wrapper = container.querySelector<HTMLElement>('.pkc-quick-toc');
    const btn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-btn');

    expect(wrapper).not.toBeNull();
    expect(btn).not.toBeNull();
    expect(wrapper?.hidden).toBe(true);

    handle.dispose();
  });

  it('becomes visible and builds toc list when headings are present', () => {
    bodyHost.innerHTML = `
      <h2 id="chapter-1">第一章 概要</h2>
      <p>本文</p>
      <h3 id="section-1-1">1.1 詳細</h3>
      <p>詳細内容</p>
    `;

    const handle = installQuickToc(container, bodyHost);

    const wrapper = container.querySelector<HTMLElement>('.pkc-quick-toc');
    expect(wrapper?.hidden).toBe(false);

    const items = container.querySelectorAll<HTMLElement>('.pkc-quick-toc-item');
    expect(items).toHaveLength(2);

    expect(items[0]?.getAttribute('data-pkc-toc-level')).toBe('2');
    const link1 = items[0]?.querySelector<HTMLButtonElement>('.pkc-quick-toc-link');
    expect(link1?.textContent).toBe('第一章 概要');
    expect(link1?.getAttribute('data-pkc-action')).toBe('toc-jump');
    expect(link1?.getAttribute('data-pkc-toc-slug')).toBe('chapter-1');

    expect(items[1]?.getAttribute('data-pkc-toc-level')).toBe('3');
    const link2 = items[1]?.querySelector<HTMLButtonElement>('.pkc-quick-toc-link');
    expect(link2?.textContent).toBe('1.1 詳細');
    expect(link2?.getAttribute('data-pkc-action')).toBe('toc-jump');
    expect(link2?.getAttribute('data-pkc-toc-slug')).toBe('section-1-1');

    handle.dispose();
  });

  it('toggles popover visibility on button click', () => {
    bodyHost.innerHTML = '<h2 id="chap-1">章 1</h2>';
    const handle = installQuickToc(container, bodyHost);

    const btn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-btn')!;
    const popover = container.querySelector<HTMLElement>('.pkc-quick-toc-popover')!;

    expect(popover.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    // Click to open
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    // Click to close
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    handle.dispose();
  });

  it('closes popover on close button, outside click, escape key, and link click', () => {
    bodyHost.innerHTML = '<h2 id="chap-1">章 1</h2>';
    const handle = installQuickToc(container, bodyHost);

    const btn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-btn')!;
    const popover = container.querySelector<HTMLElement>('.pkc-quick-toc-popover')!;
    const closeBtn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-close')!;
    const link = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-link')!;

    // 1. Close button
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);

    // 2. Outside click
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);

    // 3. Escape key
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.hidden).toBe(true);

    // 4. Link click
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);

    handle.dispose();
  });

  it('removes elements and unbinds listeners on dispose', () => {
    const handle = installQuickToc(container, bodyHost);
    expect(container.querySelector('.pkc-quick-toc')).not.toBeNull();

    handle.dispose();
    expect(container.querySelector('.pkc-quick-toc')).toBeNull();
  });
});

/**
 * 🔴 **いま読んでいる章の強調**(#1168)。
 *
 * ⚠ happy-dom は採寸もスクロールも持たないので、**見出しの位置は
 *   `getBoundingClientRect` を差して**与える(= 器の上端 0 から見た `top`)。
 *   実ブラウザでの噛み合いは `tests/smoke/toc.smoke.spec.ts` が見る。
 */
describe('quick toc: 現在地の強調 (#1168)', () => {
  let container: HTMLElement;
  let bodyHost: HTMLElement;
  let scroller: HTMLElement;
  let tops: number[];

  const rect = (top: number, left = 0, w = 100, h = 20): DOMRect =>
    ({ top, left, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top }) as DOMRect;

  const frame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const items = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.pkc-quick-toc-item'));
  const activeIdx = (): number[] =>
    items().flatMap((li, i) => (li.hasAttribute('data-pkc-active') ? [i] : []));

  /** 器の高さ 500 → 線は上から 100px。見出しは 0 / 400 / 900 の位置から始める。 */
  const place = (...t: number[]): void => {
    tops = t;
    bodyHost.querySelectorAll<HTMLElement>('h2').forEach((h, i) => {
      h.getBoundingClientRect = () => rect(tops[i] as number);
    });
  };

  const open = (handle: { button: HTMLButtonElement }): void => {
    handle.button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    bodyHost = document.createElement('div');
    scroller = document.createElement('div');
    scroller.append(container, bodyHost);
    document.body.append(scroller);
    scroller.getBoundingClientRect = () => rect(0, 0, 600, 500);
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
    bodyHost.innerHTML = `
      <h2 id="a">一章</h2><p>x</p>
      <h2 id="b">二章</h2><p>x</p>
      <h2 id="c">三章</h2><p>x</p>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('開いた直後に、いま読んでいる章の行へ印が付く(1 つだけ)', () => {
    place(-700, -300, 200); // 一章・二章は上へ送られ済み、三章はまだ線(100)の下
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([1]);
    handle.dispose();
  });

  it('送ると、通り過ぎた章の行へ印が移る(前の印は外れる)', async () => {
    place(0, 400, 900);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([0]);

    place(-500, -100, 400); // 二章が線を越えた
    scroller.dispatchEvent(new Event('scroll'));
    await frame();
    expect(activeIdx()).toEqual([1]);

    place(-900, -500, 20); // 三章が線の内側へ入った
    scroller.dispatchEvent(new Event('scroll'));
    await frame();
    expect(activeIdx()).toEqual([2]);
    handle.dispose();
  });

  it('最初の章の手前では、どの行にも印が付かない', () => {
    place(300, 700, 1200);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([]);
    handle.dispose();
  });

  it('いちばん下まで送ったら最後の章(最後の章が線まで届かなくても)', () => {
    place(-900, -500, 400); // 三章は線(100)の下に居る
    Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
    scroller.scrollTop = 1000;
    bodyHost.getBoundingClientRect = () => rect(0, 0, 600, 480); // 本文の下端(480)が画面(500)に入った
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([2]);
    handle.dispose();
  });

  it('途中まで送っただけ(本文の下端がまだ画面の外)では、底の規則を当てない', () => {
    place(-900, -500, 400);
    Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
    scroller.scrollTop = 600;
    bodyHost.getBoundingClientRect = () => rect(0, 0, 600, 900); // 下端 900 > 画面 500
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([1]);
    handle.dispose();
  });

  it('🔴 開いたポップオーバーが scrollHeight を押し広げていても、本文の末尾なら最後の章', () => {
    place(-900, -500, 400);
    // 器の scrollHeight は本文の外の子(ポップオーバー)ぶん +130 大きい: 1000 + 500 < 1630
    Object.defineProperty(scroller, 'scrollHeight', { value: 1630, configurable: true });
    scroller.scrollTop = 1000;
    bodyHost.getBoundingClientRect = () => rect(0, 0, 600, 490);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([2]);
    handle.dispose();
  });

  it('いちばん上まで戻したら最初の章(題名などで最初の見出しが線の下でも)', () => {
    place(150, 900, 1700); // 最初の見出しが線(100)より下
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    scroller.scrollTop = 0;
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([0]);
    handle.dispose();
  });

  it('🔴 光らせるために本文の送りを動かさない(scrollIntoView を呼ばない)', () => {
    const spy = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
    place(-700, -300, 200);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([1]);
    expect(spy).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('全部が収まっていて送れないときは、底の規則を当てない', () => {
    place(0, 100, 250); // 三章は線の下
    Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([1]);
    handle.dispose();
  });

  it('畳んだ章の中の見出し(箱が無い)は数えない', () => {
    place(-700, 0, 300);
    const folded = bodyHost.querySelectorAll<HTMLElement>('h2')[1] as HTMLElement;
    folded.getBoundingClientRect = () => rect(0, 0, 0, 0);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    // 二章は箱が無い → 一章が光る(0 の位置と取り違えて二章が光らない)
    expect(activeIdx()).toEqual([0]);
    handle.dispose();
  });

  it('🔴 閉じている間は scroll を 1 本も購読しない(開くと張り、閉じると外す)', () => {
    place(0, 400, 900);
    const add = vi.spyOn(scroller, 'addEventListener');
    const remove = vi.spyOn(scroller, 'removeEventListener');
    const host = vi.spyOn(bodyHost, 'addEventListener');
    const handle = installQuickToc(container, bodyHost, scroller);
    const scrolls = (spy: typeof add): number =>
      spy.mock.calls.filter((c) => c[0] === 'scroll').length;

    expect(scrolls(add)).toBe(0); // 入れただけ・閉じている
    open(handle);
    expect(scrolls(add)).toBe(1);
    expect(scrolls(host)).toBe(1); // 段組み(横送り)は bodyHost が送る
    expect(remove.mock.calls.filter((c) => c[0] === 'scroll')).toHaveLength(0);

    open(handle); // 閉じる
    expect(remove.mock.calls.filter((c) => c[0] === 'scroll')).toHaveLength(1);

    open(handle); // 開き直し → また張る
    expect(scrolls(add)).toBe(2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(remove.mock.calls.filter((c) => c[0] === 'scroll')).toHaveLength(2);
    handle.dispose();
  });

  it('閉じたあとの scroll では印を動かさない / 開き直した瞬間に最新の位置で付く', async () => {
    place(0, 400, 900);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([0]);
    open(handle); // 閉じる

    place(-900, -500, 20);
    scroller.dispatchEvent(new Event('scroll'));
    await frame();
    expect(activeIdx(), '閉じている間は採寸しない').toEqual([0]);

    open(handle); // 開き直す → すぐ最新
    expect(activeIdx()).toEqual([2]);
    handle.dispose();
  });

  it('dispose で購読も外れ、待っていた採寸も走らない', async () => {
    place(0, 400, 900);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    const remove = vi.spyOn(scroller, 'removeEventListener');
    place(-900, -500, 20);
    scroller.dispatchEvent(new Event('scroll'));
    const lis = items();
    handle.dispose();
    expect(remove.mock.calls.some((c) => c[0] === 'scroll')).toBe(true);
    await frame();
    // 待っていた採寸が走っていれば、三章へ移っている
    expect(lis.map((li) => li.hasAttribute('data-pkc-active'))).toEqual([true, false, false]);
  });

  it('開いている間に本文が描き直されても(update)、組み直した行へ印が付く', () => {
    place(-700, -300, 200);
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([1]);

    // 本文の描き直し: 行が全部作り直される(印は消える)── 開いたままなので付け直す
    handle.update();
    expect(items()).toHaveLength(3);
    expect(activeIdx()).toEqual([1]);
    handle.dispose();
  });

  it('scroller を渡さない 2 引数の呼び出しでは印は付かない(従来どおり)', () => {
    place(0, 400, 900);
    const handle = installQuickToc(container, bodyHost);
    open(handle);
    expect(activeIdx()).toEqual([]);
    handle.dispose();
  });

  it('段組み: 横送りでは「列の位置」で現在地を決める', async () => {
    // 器(bodyHost)が横に送る。見出しは left で並ぶ(left 0 = いまの列)
    const pane = document.createElement('div');
    pane.setAttribute('data-pkc-columns-on', '');
    scroller.append(pane);
    pane.append(bodyHost);
    bodyHost.getBoundingClientRect = () => rect(0, 0, 600, 500);
    const lefts = [-1200, -600, 0]; // 一章・二章は左へ送られ済み、三章がいまの列
    const hs = bodyHost.querySelectorAll<HTMLElement>('h2');
    hs.forEach((h, i) => {
      h.getBoundingClientRect = () => rect(10, lefts[i] as number);
    });
    const handle = installQuickToc(container, bodyHost, scroller);
    open(handle);
    expect(activeIdx()).toEqual([2]);

    lefts.splice(0, 3, -600, 0, 600); // 1 列戻る
    bodyHost.dispatchEvent(new Event('scroll'));
    await frame();
    expect(activeIdx()).toEqual([1]);
    handle.dispose();
  });
});
