/** @vitest-environment happy-dom */
/**
 * 🔴 **ログの日の行(器)**(#1441 案 b)。規則は `tests/features/log-days.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  applyHeadingFold,
  revealBlock,
  toggleHeadingFold,
  toggleLogDay,
} from '../../src/adapter/ui/render/heading-fold';
import { LOG_DAYS_HOST_ATTR } from '../../src/adapter/ui/render/log-days';
import { applyBlocks, EMPTY_VIEW } from '../../src/adapter/ui/render/apply-blocks';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const LOG =
  '<h2>2026-10-09 09:00:00</h2><p>a1</p>' +
  '<h2>2026-10-09 10:00:00</h2><p>a2</p>' +
  '<h2>2026-10-10 09:00:00</h2><p>b1</p>' +
  '<h2>2026-10-10 10:00:00</h2><p>b2</p>';

function host(html: string, log = true): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  if (log) el.setAttribute(LOG_DAYS_HOST_ATTR, '');
  return el;
}
const rows = (h: HTMLElement): HTMLElement[] =>
  [...h.querySelectorAll<HTMLElement>('[data-pkc-log-day]')];
const shown = (h: HTMLElement): string[] =>
  [...h.children]
    .filter((c) => c.tagName === 'P' && !(c as HTMLElement).hidden)
    .map((c) => c.textContent ?? '');

describe('ログの日の行(器) #1441', () => {
  it('日が変わる所の直前にだけ行が出る(2 日 × 2 件 = 2 行)', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    expect(rows(h).map((r) => r.textContent)).toEqual(['2026-10-09(金)', '2026-10-10(土)']);
    for (const r of rows(h)) expect(r.nextElementSibling!.tagName).toBe('H2');
    expect(h.children[0]).toBe(rows(h)[0]);
    expect(h.children[5]).toBe(rows(h)[1]);
  });

  it('ログでないノート(印が無い器)には出さない / 付いていた行は外す', () => {
    const h = host(LOG, false);
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(0);
    h.setAttribute(LOG_DAYS_HOST_ATTR, '');
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(2);
    h.removeAttribute(LOG_DAYS_HOST_ATTR);
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(0);
  });

  it('時刻見出しが無い `##` だけのノートには出さない', () => {
    const h = host('<h2>章</h2><p>x</p><h2>節</h2><p>y</p>');
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(0);
  });

  it('本文の字は変わらない(行を除いた innerHTML は行が無い器と同じ)', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    const plain = host(LOG, false);
    applyHeadingFold(plain);
    const strip = (el: HTMLElement): string => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll('[data-pkc-log-day]').forEach((r) => r.remove());
      return c.innerHTML;
    };
    expect(strip(h)).toBe(strip(plain));
    expect(h.querySelector('h2')!.textContent).toBe('2026-10-09 09:00:00');
  });

  it('button で、押すと日の追記がまとめて隠れ、もう一度押すと戻る(双方向)', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    const first = rows(h)[0]!;
    expect(first.tagName).toBe('BUTTON');
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(first.getAttribute('data-pkc-action')).toBe('toggle-log-day');
    expect(shown(h)).toEqual(['a1', 'a2', 'b1', 'b2']);

    toggleLogDay(first);
    expect(shown(h)).toEqual(['b1', 'b2']);
    const heads = [...h.querySelectorAll<HTMLElement>('h2')];
    expect(heads.map((x) => x.hidden)).toEqual([true, true, false, false]);
    expect(rows(h).every((r) => !r.hidden)).toBe(true);
    expect(rows(h)[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(rows(h)[1]!.getAttribute('aria-expanded')).toBe('true');

    toggleLogDay(rows(h)[0]!);
    expect(shown(h)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(heads.every((x) => !x.hidden)).toBe(true);
    expect(rows(h)[0]!.getAttribute('aria-expanded')).toBe('true');
  });

  it('時刻見出しの畳みと喧嘩しない ── 日を開いても、畳んでいた追記は畳んだまま', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    const heads = [...h.querySelectorAll<HTMLElement>('h2')];
    toggleHeadingFold(heads[0]!);
    expect(shown(h)).toEqual(['a2', 'b1', 'b2']);
    toggleLogDay(rows(h)[0]!);
    expect(shown(h)).toEqual(['b1', 'b2']);
    toggleLogDay(rows(h)[0]!);
    expect(shown(h)).toEqual(['a2', 'b1', 'b2']);
    expect(heads[0]!.hasAttribute('data-pkc-folded')).toBe(true);
  });

  it('日を畳んでも、別の日の畳んでいる追記は畳んだまま(畳みの集合は足し算)', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    const heads = [...h.querySelectorAll<HTMLElement>('h2')];
    toggleHeadingFold(heads[2]!); // 9/10 09:00 を畳む(b1 が隠れる)
    toggleLogDay(rows(h)[0]!); // 9/9 を畳む
    expect(shown(h)).toEqual(['b2']);
  });

  it('⚠ 前の追記を畳んでも、次の日の行は隠れない', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    const heads = [...h.querySelectorAll<HTMLElement>('h2')];
    toggleHeadingFold(heads[1]!);
    expect(rows(h).every((r) => !r.hidden)).toBe(true);
  });

  it('描き直し(冪等)で行は増えず、畳みは引き継がれる', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    toggleLogDay(rows(h)[1]!);
    applyHeadingFold(h);
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(2);
    expect(shown(h)).toEqual(['a1', 'a2']);
  });

  it('行が差し替わって消えた後も、日で畳みを引き継ぐのではなく、消えた行の畳みは忘れる(新しく開いた状態)', () => {
    // 行ごと外された(= 畳みの印も無い)なら、新しく置く行は開いている
    const h = host(LOG);
    applyHeadingFold(h);
    toggleLogDay(rows(h)[0]!);
    rows(h).forEach((r) => r.remove());
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(2);
    expect(shown(h)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('追記(末尾に新しい日が増える)でも既存の行は使い回し、新しい日の行が足される', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    const before = rows(h);
    h.insertAdjacentHTML('beforeend', '<h2>2026-10-11 08:00:00</h2><p>c1</p>');
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(3);
    expect(rows(h)[0]).toBe(before[0]);
    expect(rows(h)[2]!.textContent).toBe('2026-10-11(日)');
  });

  it('目次から畳んだ日の中へ飛ぶと、日が開く(そこまでの道)', () => {
    const h = host(LOG);
    applyHeadingFold(h);
    toggleLogDay(rows(h)[0]!);
    const target = h.querySelectorAll('p')[1]!;
    expect(revealBlock(h, target)).toBe(true);
    expect(shown(h)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('畳める見出しが無いログ(中身が空の追記だけ)でも行は出る', () => {
    const h = host('<h2>2026-10-09 09:00:00</h2><h2>2026-10-10 09:00:00</h2>');
    expect(applyHeadingFold(h)).toBe(0);
    expect(rows(h)).toHaveLength(2);
  });

  it('⚠ 同じ日が離れて 2 度出ても、連なりごとに畳みを持つ(`day#n` の n が効く)', () => {
    // 9/9 | 付録(時刻でない ##)| 9/9 ── 同じ日の連なりが 2 つ
    const h = host(
      '<h2>2026-10-09 09:00:00</h2><p>x1</p><h2>付録</h2><p>mid</p><h2>2026-10-09 18:00:00</h2><p>x2</p>',
    );
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(2);
    toggleLogDay(rows(h)[1]!); // 後ろの連なりだけ畳む
    applyHeadingFold(h);
    applyHeadingFold(h);
    expect(shown(h)).toEqual(['x1', 'mid']);
    expect(rows(h)[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows(h)[1]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('🔴 `#` の章を畳むと、中の日の行も一緒に隠れる(行だけ残さない)。日の畳みでは行は隠れない', () => {
    const h = host('<h1>題</h1><p>前書き</p>' + LOG);
    applyHeadingFold(h);
    expect(rows(h)).toHaveLength(2);
    toggleHeadingFold(h.querySelector('h1')!);
    expect(rows(h).every((r) => r.hidden), '章を畳んだのに日の行が残っている').toBe(true);
    toggleHeadingFold(h.querySelector('h1')!);
    expect(rows(h).every((r) => !r.hidden)).toBe(true);
    toggleLogDay(rows(h)[0]!);
    expect(rows(h).every((r) => !r.hidden), '日の畳みで行が自分を隠した').toBe(true);
  });
});

/** 実物の描画 + 差分描画(`applyBlocks`)を通す ── 台は `renderMarkdown` が焼いた物。 */
describe('ログの日の行 × 差分描画 #1441', () => {
  const md = (entries: string[]): string => entries.join('\n\n') + '\n';
  const E = [
    '## 2026-10-09 09:00:00',
    'a1',
    '## 2026-10-09 10:00:00',
    'a2',
    '## 2026-10-10 09:00:00',
    'b1',
    '## 2026-10-10 10:00:00',
    'b2',
  ];
  const render = (m: string): string => renderMarkdown(m, { sourceLineAnchors: false });
  function liveHost(): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute(LOG_DAYS_HOST_ATTR, '');
    document.body.append(el);
    return el;
  }

  it('🔴 追記しても全塊を作り直さず、行は同じ実体のまま、畳みも残る', () => {
    const h = liveHost();
    const first = applyBlocks(h, render(md(E)), EMPTY_VIEW);
    applyHeadingFold(h);
    const before = rows(h);
    expect(before).toHaveLength(2);
    toggleLogDay(before[0]!);
    toggleHeadingFold(h.querySelectorAll('h2')[2]!);
    const r = applyBlocks(h, render(md([...E, 'b3 の追記'])), first.view);
    applyHeadingFold(h);
    expect(r.replaced, '行があるせいで差分が丸ごとへ倒れた').toBe(1);
    expect(rows(h)).toEqual(before);
    expect(rows(h)[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(h.querySelectorAll('h2')[2]!.hasAttribute('data-pkc-folded')).toBe(true);
  });

  it('🔴 境目の追記を直しても、次の日の行は同じ実体のまま(作り直して焦点を失わない)', () => {
    const h = liveHost();
    const first = applyBlocks(h, render(md(E)), EMPTY_VIEW);
    applyHeadingFold(h);
    const rowB = rows(h)[1]!;
    rowB.focus();
    const E2 = [...E];
    E2[3] = 'a2 を直した';
    const r = applyBlocks(h, render(md(E2)), first.view);
    applyHeadingFold(h);
    expect(r.replaced).toBe(1);
    expect(rows(h)[1], '次の日の行が作り直された').toBe(rowB);
    expect(rowB.nextElementSibling!.tagName).toBe('H2');
    expect(rowB.nextElementSibling!.textContent).toBe('2026-10-10 09:00:00');
    expect(document.activeElement).toBe(rowB);
  });

  it('🔴 偽造: 本文の `:::format{log-day=1}` は行ではない ── 塊は消えず、差分も生きる', () => {
    const forged = md([...E, ':::format{log-day=1}\n偽の塊。\n:::']);
    const html = render(forged);
    expect(html, '前提が崩れている(塊に data-pkc-log-day が焼かれていない)').toContain(
      'data-pkc-log-day="1"',
    );
    const h = liveHost();
    const first = applyBlocks(h, html, EMPTY_VIEW);
    const block = h.querySelector('[data-pkc-log-day="1"]')!;
    applyHeadingFold(h);
    expect(block.isConnected, '偽造の塊が行として消された').toBe(true);
    expect(rows(h).filter((r) => r !== block)).toHaveLength(2);
    const r = applyBlocks(h, render(md([...E, ':::format{log-day=1}\n偽の塊。\n:::', '足した段落'])), first.view);
    applyHeadingFold(h);
    expect(r.replaced, '偽造の印で差分が死んだ').toBe(1);
    // 偽造の塊を「押しても」畳まれない(行ではない)
    toggleLogDay(block);
    expect(block.hasAttribute('data-pkc-day-folded')).toBe(false);
  });
});
