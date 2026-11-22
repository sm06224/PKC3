/** @vitest-environment happy-dom */
/**
 * 🔴 **ログを新しい順に並べる**(#2018 1。user 裁定 2026-11-22)── 読む面の見た目だけ(CSS の `order`)。
 *
 * 守る主張:
 * 1. 新しい順では、1 件(親の `##` + 配下の追いログ)ごとに裏返る。前置きはいつも先頭、並べ替えのボタンと「すべて」の行はその上。
 *    日の行は、その日のいちばん新しい件の手前へ(月の行はさらにその手前)
 * 2. 古い順(既定)・ログでない面では `order` を 1 つも残さない(通常のノートの流れを変えない)
 * 3. DOM の並び・本文の字は変えない
 * 4. 並べ替えのボタンと設定画面の列は同じ 1 つを読み書きする(どちらで変えても、もう片方に映る)
 *
 * ⚠ 実際に上下が入れ替わって見えることは実ブラウザで見る(`tests/smoke/log-order.smoke.spec.ts`)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHeadingFold } from '../../src/adapter/ui/render/heading-fold';
import { LOG_DAYS_HOST_ATTR, LOG_ORDER_ATTR, syncLogOrderAttr } from '../../src/adapter/ui/render/log-days';
import { appLogOrder } from '../../src/adapter/ui/render/log-order-setting';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildChoiceRow } from '../../src/adapter/ui/render/choice-buttons';
import { LOG_ORDER_SELECT_FIELD, LOG_ORDER_VALUE_ATTR } from '../../src/adapter/ui/render/settings/log-order';

// 前置き / 10-09 の 2 件(1 件目は入れ子つき)/ 10-10 の 1 件
const HTML =
  '<p id="pre">まえがき</p>' +
  '<h2 id="a">2026-10-09 09:00:00</h2><p id="a1">朝</p><h3 id="a2">2026-10-09 09:30:00</h3><p id="a3">追い</p>' +
  '<h2 id="b">2026-10-09 18:00:00</h2><p id="b1">夜</p>' +
  '<h2 id="c">2026-10-10 08:00:00</h2><p id="c1">翌朝</p>';

function host(log = true, desc = true): HTMLElement {
  const h = document.createElement('div');
  if (log) h.setAttribute(LOG_DAYS_HOST_ATTR, '');
  if (desc) h.setAttribute(LOG_ORDER_ATTR, 'desc');
  h.innerHTML = HTML;
  document.body.append(h);
  return h;
}
const order = (h: HTMLElement, sel: string): number => Number((h.querySelector<HTMLElement>(sel)!).style.order);
/** 見た目の並び(`order` の昇順、同じなら DOM の順)。 */
function visual(h: HTMLElement): string[] {
  const kids = [...h.children] as HTMLElement[];
  return kids
    .map((k, i) => ({ k, i, o: Number(k.style.order || 0) }))
    .sort((x, y) => x.o - y.o || x.i - y.i)
    .map(({ k }) => k.id || k.getAttribute('data-pkc-log-day') || k.getAttribute('data-pkc-field') || k.tagName);
}

beforeEach(() => {
  document.body.textContent = '';
  localStorage.clear();
});
afterEach(() => localStorage.clear());

describe('applyLogOrder', () => {
  it('🔴 新しい順: 件ごとに裏返り、入れ子は親と一緒、前置きは先頭、日の行はその日のいちばん新しい件の手前', () => {
    const h = host();
    applyHeadingFold(h);
    expect(visual(h)).toEqual([
      'log-order',
      'pre',
      '2026-10-10',
      'c',
      'c1',
      '2026-10-09',
      'b',
      'b1',
      'a',
      'a1',
      'a2',
      'a3',
    ]);
    // 🔑 DOM の並びは変えない(差分描画・刻印・畳みが今のまま数える)
    expect([...h.querySelectorAll('h2,h3,p')].map((e) => e.id)).toEqual(['pre', 'a', 'a1', 'a2', 'a3', 'b', 'b1', 'c', 'c1']);
  });

  it('🔴 古い順(既定)では order を 1 つも残さない / 新しい順から戻すと全部外れる', () => {
    const h = host();
    applyHeadingFold(h);
    expect(order(h, '#a')).toBeGreaterThan(order(h, '#c'));
    h.removeAttribute(LOG_ORDER_ATTR);
    applyHeadingFold(h);
    expect([...h.children].filter((c) => (c as HTMLElement).style.order !== '')).toEqual([]);
  });

  it('⚠ 対照群: ログでない面は印があっても並べ替えない(ボタンも出さない)', () => {
    const h = host(false, true);
    applyHeadingFold(h);
    expect([...h.children].filter((c) => (c as HTMLElement).style.order !== '')).toEqual([]);
    expect(h.querySelector('[data-pkc-field="log-order"]')).toBeNull();
  });

  it('記録が 1 件のログにはボタンを出さない(並べ替えるものが無い)', () => {
    const h = document.createElement('div');
    h.setAttribute(LOG_DAYS_HOST_ATTR, '');
    h.innerHTML = '<h2>2026-10-09 09:00:00</h2><p>a</p>';
    applyHeadingFold(h);
    expect(h.querySelector('[data-pkc-field="log-order"]')).toBeNull();
  });
});

describe('並べ替えのボタンと設定画面(双方向)', () => {
  function setup() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const h = document.createElement('div');
    h.setAttribute(LOG_DAYS_HOST_ATTR, '');
    h.innerHTML = HTML;
    syncLogOrderAttr(h);
    applyHeadingFold(h);
    const settings = document.createElement('div');
    settings.append(
      buildChoiceRow({
        field: LOG_ORDER_SELECT_FIELD,
        ariaLabel: 'ログの並び',
        action: 'set-log-order',
        dataAttr: LOG_ORDER_VALUE_ATTR,
        choices: [
          { id: 'asc', label: '古い順' },
          { id: 'desc', label: '新しい順' },
        ],
        currentId: 'asc',
      }),
    );
    root.append(h, settings);
    document.body.append(root);
    bindActions(root, new Dispatcher());
    const btn = (): HTMLElement => h.querySelector<HTMLElement>('[data-pkc-field="log-order"]')!;
    const pressed = (): string | null =>
      settings.querySelector(`[${LOG_ORDER_VALUE_ATTR}][aria-pressed="true"]`)?.getAttribute(LOG_ORDER_VALUE_ATTR) ?? null;
    return { h, settings, btn, pressed };
  }

  it('🔴 ボタンを押すと新しい順になり、設定画面の列も「新しい順」が押された形になる / もう一度で戻る', () => {
    const { h, btn, pressed } = setup();
    expect(btn().textContent, '既定は古い順').toBe('古い順');
    btn().click();
    expect(appLogOrder.order()).toBe('desc');
    expect(localStorage.getItem('pkc3.log-order')).toBe('desc');
    expect(h.getAttribute(LOG_ORDER_ATTR)).toBe('desc');
    expect(btn().textContent).toBe('新しい順');
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(pressed()).toBe('desc');
    expect(order(h, '#a')).toBeGreaterThan(order(h, '#c'));
    btn().click();
    expect(appLogOrder.order()).toBe('asc');
    expect(h.hasAttribute(LOG_ORDER_ATTR)).toBe(false);
    expect(pressed()).toBe('asc');
    expect([...h.children].filter((c) => (c as HTMLElement).style.order !== '')).toEqual([]);
  });

  it('🔴 設定画面で「新しい順」を押すと、開いているログの面が並び替わり、ボタンの字も変わる', () => {
    const { h, settings, btn } = setup();
    settings.querySelector<HTMLElement>(`[${LOG_ORDER_VALUE_ATTR}="desc"]`)!.click();
    expect(appLogOrder.order()).toBe('desc');
    expect(h.getAttribute(LOG_ORDER_ATTR)).toBe('desc');
    expect(btn().textContent).toBe('新しい順');
    expect(order(h, '#a')).toBeGreaterThan(order(h, '#c'));
  });
});

describe('CSS: flex はログの新しい順だけ(通常のノートの流れを 1px も変えない)', () => {
  it('🔴 `display: flex` を持つ規則で `data-pkc-log-days` を含む選択子は、すべて `[data-pkc-log-order=\'desc\']` で絞っている', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
    const logFlex = rules.filter((r) => /display:\s*flex/.test(r.body) && r.sel.includes('data-pkc-log-days'));
    // 空振り防止: 新しい順の規則そのものは在る
    expect(logFlex.length, '新しい順の規則が見つからない(検査の空振り)').toBeGreaterThan(0);
    for (const r of logFlex) {
      for (const one of r.sel.split(',')) expect(one, `ログの面を flex にする選択子が新しい順で絞られていない: ${one}`).toContain("[data-pkc-log-order='desc']");
    }
    // 子の余白を変える規則も新しい順だけ
    const margin = rules.filter((r) => /margin-block-end/.test(r.body) && r.sel.includes('data-pkc-log-days'));
    expect(margin.length).toBeGreaterThan(0);
    for (const r of margin) expect(r.sel).toContain("[data-pkc-log-order='desc']");
  });
});
