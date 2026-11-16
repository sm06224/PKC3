/** @vitest-environment happy-dom */
/**
 * 🔴 **右のペインの目次の現在地**(#1966 2-B 案 1)。
 *
 * user 指示 2026-11-16 の 2 つの条件を直接見る:
 * - **採寸は 1 描画フレームに 1 回まで**(送りの `scroll` が何回来ても、rAF 1 本・見出しの採寸 1 巡)
 * - **本文の送りに触らない**(書くのは目次の枠の `scrollTop` だけ)
 *
 * ⚠ happy-dom は配置を持たないので、位置(`getBoundingClientRect`)は送り量から作る ── 見出しは本文の上端から
 *   `TOPS` の位置に在り、器を `scrollTop` 送るとその分だけ上へ動く。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSPECTOR_TOC_ACTIVE_ATTR,
  installInspectorTocSpy,
  requestInspectorTocSpy,
  type InspectorTocSpy,
} from '../../src/adapter/ui/render/inspector-toc-spy';

const TOPS = [100, 900, 1700, 2500];
const SLUGS = ['a', 'b', 'c', 'd'];
const VIEW_H = 500;
const ROW_H = 20;
const TOC_H = 40; // 目次の枠は 2 行分しか見えない

let spy: InspectorTocSpy | null = null;
let frames: Array<() => void> = [];
let headingReads = 0;

function rect(top: number, height: number, width = 100): DOMRect {
  return { top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function setup() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.innerHTML = `
    <aside data-pkc-region="sidebar"><div data-pkc-field="list"><div>ノート</div></div></aside>
    <main data-pkc-region="detail">
      <div data-pkc-field="detail-body">${SLUGS.map((s) => `<h2 id="${s}">${s}</h2>`).join('')}</div>
      <div data-pkc-region="split-frame"><div data-pkc-field="split-body"><h2 id="b">b</h2></div></div>
    </main>
    <aside data-pkc-region="inspector"><dl><dt>目次</dt><dd data-pkc-field="inspector-toc">${SLUGS.map(
      (s) =>
        `<div data-pkc-field="inspector-toc-item"><button data-pkc-field="inspector-toc-link" data-pkc-toc-slug="${s}">${s}</button></div>`,
    ).join('')}</dd></dl></aside>`;
  document.body.append(root);
  const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
  const body = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  const box = root.querySelector<HTMLElement>('[data-pkc-field="inspector-toc"]')!;
  const sidebarList = root.querySelector<HTMLElement>('[data-pkc-field="list"]')!;
  const pinned = root.querySelector<HTMLElement>('[data-pkc-region="split-frame"]')!;

  Object.defineProperty(detail, 'clientHeight', { configurable: true, value: VIEW_H });
  Object.defineProperty(detail, 'scrollHeight', { configurable: true, value: 3000 });
  detail.getBoundingClientRect = () => rect(0, VIEW_H);
  body.getBoundingClientRect = () => rect(-detail.scrollTop, 3000);
  body.querySelectorAll<HTMLElement>('h2').forEach((h, i) => {
    h.getBoundingClientRect = () => {
      headingReads += 1;
      return rect(TOPS[i]! - detail.scrollTop, 30);
    };
  });
  // 目次の枠: 2 行分の高さ、行は 20px ずつ
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: TOC_H });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: ROW_H * SLUGS.length });
  box.getClientRects = () => [rect(600, TOC_H)] as unknown as DOMRectList;
  box.getBoundingClientRect = () => rect(600, TOC_H);
  box.querySelectorAll<HTMLElement>('[data-pkc-field="inspector-toc-item"]').forEach((item, i) => {
    item.getBoundingClientRect = () => rect(600 + i * ROW_H - box.scrollTop, ROW_H);
  });

  spy = installInspectorTocSpy(
    root,
    (cb) => {
      frames.push(cb);
      return frames.length;
    },
    () => {},
  );
  flush(); // 入れた直後の 1 回
  headingReads = 0;
  const scrollTo = (el: HTMLElement, top: number): void => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll')); // ⚠ 泡立たない(実物と同じ)── 捕捉段で拾えるかを見る
  };
  return { root, detail, box, sidebarList, pinned, scrollTo };
}

function flush(): number {
  const n = frames.length;
  const run = frames;
  frames = [];
  for (const f of run) f();
  return n;
}

function active(root: HTMLElement): string[] {
  return [...root.querySelectorAll(`[${INSPECTOR_TOC_ACTIVE_ATTR}]`)].map(
    (el) => el.firstElementChild?.getAttribute('data-pkc-toc-slug') ?? '',
  );
}

beforeEach(() => {
  frames = [];
  headingReads = 0;
});
afterEach(() => {
  spy?.dispose();
  spy = null;
});

describe('現在地の印', () => {
  it('🔴 線(画面の上 2 割)を越えた最後の見出しの行が光り、aria-current が付く', () => {
    const { root, detail, scrollTo } = setup();
    scrollTo(detail, 850); // b は 900 → 50(線 100 の上)、c は 850 で線の下
    flush();
    expect(active(root)).toEqual(['b']);
    const link = root.querySelector('[data-pkc-toc-slug="b"]')!;
    expect(link.getAttribute('aria-current')).toBe('location');
    expect(root.querySelectorAll('[aria-current]').length, '光る行は 1 本だけ').toBe(1);
    scrollTo(detail, 1650);
    flush();
    expect(active(root), '送っても印が動かない').toEqual(['c']);
    expect(root.querySelector('[data-pkc-toc-slug="b"]')!.hasAttribute('aria-current'), '前の印が残った').toBe(false);
  });

  it('⚠ 先頭まで戻したら最初の見出し / 末尾まで送ったら最後の見出し', () => {
    const { root, detail, scrollTo } = setup();
    scrollTo(detail, 2500);
    flush();
    expect(active(root)).toEqual(['d']);
    scrollTo(detail, 0);
    flush();
    expect(active(root)).toEqual(['a']);
  });
});

describe('🔴 採寸は 1 描画フレームに 1 回まで(user 指示 2026-11-16)', () => {
  it('同じフレームに scroll が 10 回来ても、rAF は 1 本・見出しの採寸は 1 巡', () => {
    const { detail, scrollTo } = setup();
    for (let i = 0; i < 10; i++) scrollTo(detail, 800 + i * 10);
    expect(flush(), 'scroll ごとに rAF を積んだ').toBe(1);
    expect(headingReads, '1 フレームで見出しを何度も採寸した').toBe(TOPS.length);
    // 次のフレームは、また送られたときだけ
    expect(flush(), '送っていないのに採寸した').toBe(0);
  });

  it('⚠ 本文と関係ない送り(左の一覧・目次の枠そのもの・留めた枠)では採寸しない', () => {
    const { sidebarList, box, pinned, scrollTo } = setup();
    scrollTo(sidebarList, 300);
    scrollTo(box, 10);
    scrollTo(pinned, 400);
    expect(flush(), '本文でない送りで rAF を積んだ').toBe(0);
    expect(headingReads).toBe(0);
  });

  it('⚠ 右のペインを畳んでいる(目次の箱が無い)ときは見出しを採寸しない', () => {
    const { detail, box, scrollTo } = setup();
    box.getClientRects = () => [] as unknown as DOMRectList;
    scrollTo(detail, 900);
    flush();
    expect(headingReads).toBe(0);
  });
});

describe('🔴 本文の送りに触らない(目次の枠だけを送る)', () => {
  it('光った行が目次の枠の下に隠れていたら、枠の中だけを送って見せる ── 本文の scrollTop は変わらない', () => {
    const { root, detail, box, scrollTo } = setup();
    expect(box.scrollTop).toBe(0);
    scrollTo(detail, 1650); // c(3 行目 = 枠の外)
    flush();
    expect(active(root)).toEqual(['c']);
    expect(detail.scrollTop, '目次の追従で本文が送られた').toBe(1650);
    // c の行は 40..60(枠 0..40)── 下端を枠の下端へ合わせる = 20 送る
    expect(box.scrollTop, '目次の枠が光った行へ寄っていない').toBe(ROW_H);
    // 先頭へ戻ると a の行(0..20)へ戻る
    scrollTo(detail, 0);
    flush();
    expect(box.scrollTop).toBe(0);
    expect(detail.scrollTop).toBe(0);
  });

  it('⚠ 光る章が変わらない送りでは、目次の枠を動かさない(手で目次を送って読んでいるのを引き戻さない)', () => {
    const { detail, box, scrollTo } = setup();
    scrollTo(detail, 1650);
    flush();
    box.scrollTop = 0; // user が目次を手で上へ戻した
    scrollTo(detail, 1660); // まだ c の中
    flush();
    expect(box.scrollTop, '同じ章の送りで目次の枠を引き戻した').toBe(0);
  });
});

describe('描き直しの後', () => {
  it('🔑 requestInspectorTocSpy() で、送らなくても印を付け直す(作り直した行に印が無い回)', () => {
    const { root, detail, scrollTo } = setup();
    scrollTo(detail, 850);
    flush();
    // 目次を作り直した形(印の無い新しい行)
    for (const item of root.querySelectorAll(`[${INSPECTOR_TOC_ACTIVE_ATTR}]`)) item.removeAttribute(INSPECTOR_TOC_ACTIVE_ATTR);
    requestInspectorTocSpy();
    requestInspectorTocSpy();
    expect(flush(), '描き直しの依頼も 1 フレームに畳む').toBe(1);
    expect(active(root)).toEqual(['b']);
  });

  it('⚠ dispose した後は送りを拾わない', () => {
    const { detail, scrollTo } = setup();
    spy!.dispose();
    spy = null;
    scrollTo(detail, 900);
    requestInspectorTocSpy();
    expect(flush()).toBe(0);
  });
});
