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
import { crossesLogRecord, LOG_DAYS_HOST_ATTR, LOG_ORDER_ATTR, syncLogOrderAttr } from '../../src/adapter/ui/render/log-days';
import { appLogOrder } from '../../src/adapter/ui/render/log-order-setting';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildChoiceRow } from '../../src/adapter/ui/render/choice-buttons';
import { LOG_ORDER_SELECT_FIELD, LOG_ORDER_VALUE_ATTR } from '../../src/adapter/ui/render/settings/log-order';
import { installSectionBox } from '../../src/adapter/ui/render/section-box';
import { installCodeBox } from '../../src/adapter/ui/render/code-box';

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

describe('編集の箱も見た目の順を継ぐ(着地前レビュー ⚠2)', () => {
  /** 刻印つきの新しい順のログ(1 件目 = 行 0〜2、2 件目 = 行 4〜6)。 */
  function stamped(): HTMLElement {
    const h = document.createElement('div');
    h.setAttribute(LOG_DAYS_HOST_ATTR, '');
    h.setAttribute(LOG_ORDER_ATTR, 'desc');
    h.innerHTML =
      '<h2 data-pkc-source-line="0">2026-10-09 09:00:00</h2><p data-pkc-source-line="2">古い</p>' +
      '<h2 data-pkc-source-line="4">2026-10-10 09:00:00</h2><div class="pkc-md-block" data-pkc-md-block-kind="code" data-pkc-source-line="6" data-pkc-source-end="8"><pre><code>x</code></pre></div>';
    document.body.append(h);
    applyHeadingFold(h);
    return h;
  }

  it('🔴 章の箱は置き換えた見出しの order を継ぐ(0 のまま先頭へ飛ばない)', () => {
    const h = stamped();
    const want = h.querySelectorAll<HTMLElement>('h2')[0]!.style.order;
    expect(want, '前提: 新しい順の order が付いていない').not.toBe('');
    installSectionBox(h, { from: 0, to: 4, text: '## 2026-10-09 09:00:00\n\n古い\n' });
    const box = h.querySelector<HTMLElement>('[data-pkc-region="section-draft"]')!;
    expect(box, '前提: 箱が置かれていない').not.toBeNull();
    expect(box.style.order).toBe(want);
  });

  it('🔴 コードの箱も置き換えた塊の order を継ぐ', () => {
    const h = stamped();
    const want = h.querySelector<HTMLElement>('.pkc-md-block')!.style.order;
    expect(want).not.toBe('');
    const ta = installCodeBox(h, { line: 6, text: '```\nx\n```' });
    expect(ta, '前提: コードの箱が置かれていない').not.toBeNull();
    const box = ta!.closest<HTMLElement>('[data-pkc-region]')!;
    expect(box.parentElement).toBe(h);
    expect(box.style.order).toBe(want);
  });
});

describe('CSS: 紙は書いた順(着地前レビュー 🔴1)', () => {
  it('🔴 印刷の節で、新しい順の器を block に `!important` で戻している(画面の flex は後ろに在るので素の宣言では負ける)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf('@media print');
    expect(at, '印刷の節が無い').toBeGreaterThanOrEqual(0);
    const print = css.slice(at);
    expect(print).toMatch(/\[data-pkc-log-days\]\[data-pkc-log-order='desc'\]\s*\{\s*display:\s*block\s*!important;/);
    expect(print).toMatch(/\[data-pkc-field='log-order'\],\s*\[data-pkc-log-all\]\s*\{\s*display:\s*none\s*!important;/);
  });
});

describe('新しい順で、記録の境目をまたぐ塊の移動を断る(#2018 フォロー)', () => {
  // 生の body の行(frontmatter なし): 0 前置き / 2 ## a / 4 a1 / 6 a2 / 8 ## b / 10 b1
  function stampedLog(desc: boolean): HTMLElement {
    const h = document.createElement('div');
    h.setAttribute(LOG_DAYS_HOST_ATTR, '');
    if (desc) h.setAttribute(LOG_ORDER_ATTR, 'desc');
    h.innerHTML =
      '<p data-pkc-source-line="0">まえがき</p>' +
      '<h2 data-pkc-source-line="2">2026-10-09 09:00:00</h2><p data-pkc-source-line="4">a1</p><p data-pkc-source-line="6">a2</p>' +
      '<h2 data-pkc-source-line="8">2026-10-10 09:00:00</h2><p data-pkc-source-line="10">b1</p>';
    document.body.append(h);
    applyHeadingFold(h);
    return h;
  }
  it('🔴 記録の中の上下は通す(見た目と DOM の順が同じ)', () => {
    const h = stampedLog(true);
    expect(crossesLogRecord(h, 0, 6, 6, 4), 'a2 を a1 の前へ').toBe(false);
    expect(crossesLogRecord(h, 0, 4, 4, 7), 'a1 を a2 の後へ').toBe(false);
  });
  it('🔴 記録の境目をまたぐ移動は断る(上へ = 前の記録・前置きへ / 下へ = 次の記録へ / 記録の頭ごと)', () => {
    const h = stampedLog(true);
    expect(crossesLogRecord(h, 0, 4, 4, 2), 'a1 を a の見出しの前(前置き)へ').toBe(true);
    expect(crossesLogRecord(h, 0, 6, 6, 11), 'a2 を b1 の後(次の記録)へ').toBe(true);
    expect(crossesLogRecord(h, 0, 2, 7, 12), '記録 a の頭(章ごと)を下へ').toBe(true);
  });
  it('⚠ 対照群: 古い順では今までどおり全部通す', () => {
    const h = stampedLog(false);
    expect(crossesLogRecord(h, 0, 4, 4, 2)).toBe(false);
    expect(crossesLogRecord(h, 0, 6, 6, 11)).toBe(false);
    expect(crossesLogRecord(h, 0, 2, 7, 12)).toBe(false);
  });
  it('frontmatter の行数ぶん、座標をずらして読む', () => {
    const h = stampedLog(true);
    // 生の body に frontmatter が 3 行ある形(描いた塊の刻印は剥いだ側)
    expect(crossesLogRecord(h, 3, 7, 7, 5)).toBe(true);
    expect(crossesLogRecord(h, 3, 9, 9, 7)).toBe(false);
    // 入れる側だけ frontmatter を読み忘れると取り違える形(a2 を b1 の後へ = 次の記録)
    expect(crossesLogRecord(h, 3, 9, 9, 14)).toBe(true);
    expect(crossesLogRecord(h, 3, 7, 7, 10)).toBe(false);
  });
});
