/** @vitest-environment happy-dom */
/**
 * 🔴 **ログの月別 / すべて畳む / すべての見出しを畳む**(#1441)。日の行の基本は `log-days.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  allHeadingFoldState,
  applyHeadingFold,
  revealBlock,
  toggleAllHeadingFolds,
  toggleAllLogDays,
  toggleHeadingFold,
  toggleLogDay,
} from '../../src/adapter/ui/render/heading-fold';
import { LOG_DAYS_HOST_ATTR } from '../../src/adapter/ui/render/log-days';

const LOG =
  '<h2>2026-10-09 09:00:00</h2><p>a1</p>' +
  '<h2>2026-10-09 10:00:00</h2><p>a2</p>' +
  '<h2>2026-10-10 09:00:00</h2><p>b1</p>' +
  '<h2>2026-10-10 10:00:00</h2><p>b2</p>';

const MULTI =
  '<h2>2026-09-30 09:00:00</h2><p>s1</p>' +
  '<h2>2026-10-01 09:00:00</h2><p>o1</p>' +
  '<h2>2026-10-02 09:00:00</h2><p>o2</p>' +
  '<h2>2026-10-02 18:00:00</h2><p>o3</p>';

function host(html: string, log = true): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  if (log) el.setAttribute(LOG_DAYS_HOST_ATTR, '');
  return el;
}
const q = (h: HTMLElement, sel: string): HTMLElement[] => [...h.querySelectorAll<HTMLElement>(sel)];
const rows = (h: HTMLElement): HTMLElement[] => q(h, '[data-pkc-log-day]');
const monthRows = (h: HTMLElement): HTMLElement[] => q(h, '[data-pkc-log-month]');
const allRows = (h: HTMLElement): HTMLElement[] => q(h, '[data-pkc-log-all]');
const shown = (h: HTMLElement): string[] =>
  [...h.children]
    .filter((c) => c.tagName === 'P' && !(c as HTMLElement).hidden)
    .map((c) => c.textContent ?? '');

describe('ログの月別 #1441', () => {
  it('1 つの月に収まるログには月の行を出さない / 2 日では「すべて」も出さない', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    expect(monthRows(h)).toHaveLength(0);
    expect(allRows(h)).toHaveLength(0);
  });

  it('2 つ以上の月にまたがると、各月の最初の日の行の手前に月の行が出る(日の行は残る)', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    expect(monthRows(h).map((r) => r.textContent)).toEqual(['2026年9月', '2026年10月']);
    for (const m of monthRows(h)) {
      expect(m.tagName).toBe('BUTTON');
      expect(m.nextElementSibling!.hasAttribute('data-pkc-log-day')).toBe(true);
      expect(m.getAttribute('data-pkc-action')).toBe('toggle-log-day');
    }
    expect(rows(h)).toHaveLength(3);
  });

  it('月の行を押すと、その月の追記と日の行がまとめて隠れ、もう一度で戻る(双方向)', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    toggleLogDay(monthRows(h)[1]!);
    expect(shown(h)).toEqual(['s1']);
    expect(rows(h).map((r) => r.hidden)).toEqual([false, true, true]);
    expect(monthRows(h).every((r) => !r.hidden)).toBe(true);
    expect(monthRows(h)[1]!.getAttribute('aria-expanded')).toBe('false');
    toggleLogDay(monthRows(h)[1]!);
    expect(shown(h)).toEqual(['s1', 'o1', 'o2', 'o3']);
    expect(rows(h).every((r) => !r.hidden)).toBe(true);
  });

  it('月を開くと、日ごとの畳みは残っている', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    toggleLogDay(rows(h)[1]!);
    toggleLogDay(monthRows(h)[1]!);
    expect(shown(h)).toEqual(['s1']);
    toggleLogDay(monthRows(h)[1]!);
    expect(shown(h)).toEqual(['s1', 'o2', 'o3']);
  });

  it('目次から畳んだ月の中へ飛ぶと、月が開く', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    toggleLogDay(monthRows(h)[1]!);
    expect(revealBlock(h, h.querySelectorAll('p')[2]!)).toBe(true);
    expect(shown(h)).toEqual(['s1', 'o1', 'o2', 'o3']);
  });

  it('描き直しで月の行は増えず、畳みを引き継ぐ', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    toggleLogDay(monthRows(h)[0]!);
    applyHeadingFold(h);
    applyHeadingFold(h);
    expect(monthRows(h)).toHaveLength(2);
    expect(monthRows(h)[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(shown(h)).toEqual(['o1', 'o2', 'o3']);
  });

  it('本文は変わらない(月・すべての行を除くと、行が無い器と同じ)', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    const plain = host(MULTI, false);
    applyHeadingFold(plain);
    const strip = (el: HTMLElement): string => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll('[data-pkc-log-day],[data-pkc-log-month],[data-pkc-log-all]').forEach((r) => r.remove());
      return c.innerHTML;
    };
    expect(strip(h)).toBe(strip(plain));
  });
});

describe('ログの「すべて折りたたむ / すべて出す」 #1441', () => {
  it('3 日以上で先頭に 1 本出て、押すと日と月が全部畳まれ、もう一度で全部戻る', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    expect(allRows(h)).toHaveLength(1);
    const all = allRows(h)[0]!;
    expect(h.firstElementChild).toBe(all);
    expect(all.textContent).toBe('すべて折りたたむ');
    expect(all.getAttribute('data-pkc-action')).toBe('toggle-log-day-all');
    toggleAllLogDays(h);
    expect(shown(h)).toEqual([]);
    expect(allRows(h)[0]!.textContent).toBe('すべて出す');
    expect(monthRows(h).every((r) => !r.hidden)).toBe(true);
    toggleAllLogDays(h);
    expect(shown(h)).toEqual(['s1', 'o1', 'o2', 'o3']);
    expect(allRows(h)[0]!.textContent).toBe('すべて折りたたむ');
  });

  it('1 つでも開いていれば、押すと全部畳む(一部だけ畳んだ状態からの「すべて」)', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    toggleLogDay(rows(h)[0]!);
    toggleAllLogDays(h);
    expect(shown(h)).toEqual([]);
    expect(rows(h).filter((r) => r.hidden)).toHaveLength(3);
  });

  it('描き直しで「すべて」の行は 1 本のまま、字も状態に追いつく', () => {
    const h = host(MULTI);
    applyHeadingFold(h);
    toggleAllLogDays(h);
    applyHeadingFold(h);
    applyHeadingFold(h);
    expect(allRows(h)).toHaveLength(1);
    expect(allRows(h)[0]!.textContent).toBe('すべて出す');
  });

  it('偽造: 本文の塊に付けた `data-pkc-log-all` は「すべて」の行ではない', () => {
    const h = host(MULTI);
    const p = h.querySelector('p')!;
    p.setAttribute('data-pkc-log-all', '');
    applyHeadingFold(h);
    expect(allRows(h).filter((r) => r !== p)).toHaveLength(1);
    expect(h.contains(p)).toBe(true);
  });
});

describe('すべての見出しを畳む / 出す #1441 (a)', () => {
  const NOTE = '<h1>A</h1><p>a</p><h2>A-1</h2><p>a1</p><h1>B</h1><p>b</p>';
  it('畳める見出しが 2 つに満たなければ出さない(null)', () => {
    expect(allHeadingFoldState(host('<h1>A</h1><p>a</p>', false))).toBeNull();
  });
  it('押すと全部畳み、もう一度で全部出す(双方向)', () => {
    const h = host(NOTE, false);
    applyHeadingFold(h);
    expect(allHeadingFoldState(h)).toBe('fold');
    expect(toggleAllHeadingFolds(h)).toBe(true);
    expect(allHeadingFoldState(h)).toBe('unfold');
    expect(q(h, 'p').every((p) => p.hidden)).toBe(true);
    expect(toggleAllHeadingFolds(h)).toBe(false);
    expect(q(h, 'p').every((p) => !p.hidden)).toBe(true);
  });
  it('一部だけ畳んであれば「畳む」側に倒れる(全部出すではない)', () => {
    const h = host(NOTE, false);
    applyHeadingFold(h);
    toggleHeadingFold(h.querySelectorAll('h1')[1]!);
    expect(allHeadingFoldState(h)).toBe('fold');
    expect(toggleAllHeadingFolds(h)).toBe(true);
  });
});
