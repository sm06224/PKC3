/** @vitest-environment happy-dom */
/**
 * #1087 読み上げ・キーボードの穴 6 件(名前の無いボタン / チェック欄 / 並べ替えの見出し /
 * 目次の焦点 / 「作る」の一覧)。見た目は変えず、属性と焦点だけを見る。
 * 焦点は `document.activeElement`(実際に誰が持っているか)で見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import type { AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildKeymapPanel } from '../../src/adapter/ui/render/keymap-panel';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { installQuickToc } from '../../src/adapter/ui/render/quick-toc';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { chordLabel } from '../../src/features/keymap';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('A1 割り当てを外す「×」に名前がある', () => {
  it('🔴 全部の「×」が、押すと何が起きるかを名前に持つ(「×」のまま読ませない)', () => {
    const map = new Map<string, string>();
    const store = new KeymapStore({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    const drops = [...panel.root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="keymap-drop"]')];
    // 空振り防止 ── 割り当てが 0 件なら全数検査は何も見ない
    expect(drops.length, '前提: 外せる割り当てが 1 つも描かれていない').toBeGreaterThan(10);
    for (const d of drops) {
      const chord = d.getAttribute('data-pkc-chord')!;
      expect(d.getAttribute('aria-label'), `${chord} の「×」に名前が無い`).toBe(
        `${chordLabel(chord)} の割当を外します`,
      );
    }
    panel.dispose();
  });
});

describe('A2 予定の面の ‹ › に名前がある(月単位の送り)', () => {
  it('🔴 前へ / 次へが、見える字(‹ ›)ではなく名前で読める', () => {
    const region = document.createElement('div');
    document.body.append(region);
    new ScheduleRenderer(region, () => new Date(2026, 8, 10)).render({
      ...initialState,
      calendarMonth: { year: 2026, month: 9 },
    });
    const bar = region.querySelector('[data-pkc-field="schedule-toolbar"]')!;
    const prev = bar.querySelector('[data-pkc-action="schedule-nav"][data-pkc-nav-step="-1"]')!;
    const next = bar.querySelector('[data-pkc-action="schedule-nav"][data-pkc-nav-step="1"]')!;
    expect(prev.getAttribute('aria-label')).toBe('前の月');
    expect(next.getAttribute('aria-label')).toBe('次の月');
  });
});

describe('A3 タスクのチェック欄に項目の字が名前として付く', () => {
  const box = (html: string): HTMLInputElement => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.querySelector<HTMLInputElement>('input.pkc-task-checkbox')!;
  };

  it('🔴 記法を除いた字が名前になる(強調・コード・リンクの字は残し、印は落とす)', () => {
    const b = box(renderMarkdown('- [ ] **買う** `milk` と [店](https://example.com)'));
    expect(b.getAttribute('aria-label')).toBe('買う milk と 店');
  });

  it('🔴 属性として安全に出る(引用符・山括弧は escape され、属性を壊さない)', () => {
    const b = box(renderMarkdown('- [x] a"b <i>c</i> & d'));
    expect(b.getAttribute('aria-label')).toBe('a"b c & d'.replace('c', '<i>c</i>'));
    expect(b.hasAttribute('checked')).toBe(true);
  });

  it('🔴 長い項目は 80 字までに切る', () => {
    const b = box(renderMarkdown(`- [ ] ${'あ'.repeat(200)}`));
    const label = b.getAttribute('aria-label')!;
    expect(label.length).toBe(80);
    expect(label.endsWith('…')).toBe(true);
  });

  it('対照群: 字の無い項目には空の名前を付けない / 行番号・索引の属性は変わらない', () => {
    const html = renderMarkdown('- [ ]\n- [ ] 二つ目', { interactiveTasks: true } as never);
    const host = document.createElement('div');
    host.innerHTML = html;
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input.pkc-task-checkbox')];
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.hasAttribute('aria-label')).toBe(false);
    expect(boxes[1]!.getAttribute('aria-label')).toBe('二つ目');
    expect(boxes.map((x) => x.getAttribute('data-pkc-task-index'))).toEqual(['0', '1']);
  });
});

function meta(lid: string, order: number, title: string): EntryMeta {
  return { lid, title, archetype: 'text', order, updatedAt: '2026-01-01T00:00:00Z' } as unknown as EntryMeta;
}

describe('A4 2 ペインの列見出しは、キーボードで並べ替えられ、向きが読める', () => {
  let region: HTMLElement;
  let d: Dispatcher;
  let r: DualFilerRenderer;
  let s: AppState;
  const head = (sort: string): HTMLElement =>
    region.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="left"] th[data-pkc-sort="${sort}"]`,
    )!;
  const press = (el: Element, key: string): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    region = document.createElement('div');
    document.body.append(region);
    d = new Dispatcher();
    // 読み込み前は並べ替えが OP_FAILED になる ── 本物の起動後の状態にしてから押す
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1, 'あ'), meta('b', 2, 'い')], relations: [] });
    bindActions(region, d);
    r = new DualFilerRenderer(region);
    s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1, 'あ'), meta('b', 2, 'い')],
      relations: [],
    }).state;
    r.render(s);
  });

  it('🔴 見出しは Tab の巡回に入り(tabindex 0)、Enter と Space がそれぞれ並べ替えを 1 回だけ撃つ', () => {
    const th = head('title');
    expect(th.getAttribute('tabindex'), '巡回に入らない').toBe('0');
    const spy = vi.spyOn(d, 'dispatch');
    for (const key of ['Enter', ' ']) {
      spy.mockClear();
      th.focus();
      const ev = press(th, key);
      const sorts = spy.mock.calls.map((c) => c[0]).filter((a) => a.type === 'SET_ENTRY_SORT');
      expect(sorts, `${JSON.stringify(key)} で並べ替えが 1 回でない`).toHaveLength(1);
      expect(sorts[0]).toMatchObject({ type: 'SET_ENTRY_SORT', sort: 'title' });
      expect(spy.mock.calls, `${JSON.stringify(key)} が並べ替え以外も撃った`).toHaveLength(1);
      if (key === ' ') expect(ev.defaultPrevented, 'Space でページが送られる').toBe(true);
    }
  });

  it('🔴 aria-sort は今の並びを言う(押した列だけ ascending / descending、他は none)', () => {
    const sortOf = (): string[] => ['title', 'size', 'updated'].map((k) => head(k).getAttribute('aria-sort') ?? '');
    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'title', desc: false }).state;
    r.render(s);
    expect(sortOf()).toEqual(['ascending', 'none', 'none']);
    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'title', desc: true }).state;
    r.render(s);
    expect(sortOf()).toEqual(['descending', 'none', 'none']);
  });
});

describe('A5 目次の一覧を閉じても焦点が <body> へ落ちない', () => {
  let container: HTMLElement;
  let bodyHost: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    bodyHost = document.createElement('div');
    bodyHost.innerHTML = '<h2 id="a">一</h2><p>x</p><h2 id="b">二</h2>';
    document.body.append(container, bodyHost);
  });

  it('🔴 Esc で閉じると、一覧の中にあった焦点が目次のボタンへ戻る', () => {
    const h = installQuickToc(container, bodyHost);
    h.button.click();
    h.popover.querySelector<HTMLElement>('.pkc-quick-toc-link')!.focus();
    expect(h.popover.contains(document.activeElement), '前提: 一覧の中に焦点').toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(h.popover.hidden, '前提: 閉じた').toBe(true);
    expect(document.activeElement).toBe(h.button);
    h.dispose();
  });

  it('🔴 行を押して閉じたときも、焦点はボタンへ戻る(行き先の見出しは焦点を取らない)', () => {
    const h = installQuickToc(container, bodyHost);
    h.button.click();
    const link = h.popover.querySelector<HTMLElement>('.pkc-quick-toc-link')!;
    link.focus();
    link.click();
    expect(h.popover.hidden).toBe(true);
    expect(document.activeElement).toBe(h.button);
    h.dispose();
  });

  it('対照群: 外を押して閉じたとき、外に在った焦点は奪わない', () => {
    const h = installQuickToc(container, bodyHost);
    h.button.click();
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    other.click();
    expect(h.popover.hidden, '前提: 閉じた').toBe(true);
    expect(document.activeElement).toBe(other);
    h.dispose();
  });

  it('aria-controls が一覧の id を指し、開閉で aria-expanded が追従する', () => {
    const h = installQuickToc(container, bodyHost);
    const id = h.button.getAttribute('aria-controls')!;
    expect(id).not.toBe('');
    expect(document.getElementById(id), 'aria-controls の先が実在しない').toBe(h.popover);
    expect(h.button.getAttribute('aria-expanded')).toBe('false');
    h.button.click();
    expect(h.button.getAttribute('aria-expanded')).toBe('true');
    h.dispose();
  });
});

describe('A6 「作る」▼ の一覧', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    bindActions(root, new Dispatcher());
  });
  const pick = (): HTMLElement => root.querySelector<HTMLElement>('[data-pkc-field="create-pick"]')!;
  const menu = (): HTMLElement => root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]')!;

  it('🔴 開くボタンは一覧を持つと名乗り、一覧は開くボタンと同じ名前を持つ', () => {
    expect(pick().getAttribute('aria-haspopup')).toBe('menu');
    expect(menu().getAttribute('aria-label')).toBe(pick().getAttribute('aria-label'));
    expect(menu().getAttribute('aria-label')).not.toBe('');
  });

  it('🔴 Tab で一覧の外へ焦点が出たら閉じる(出た先の焦点は奪わない)', () => {
    pick().click();
    expect(menu().hidden, '前提: 開いた').toBe(false);
    const inside = menu().querySelector<HTMLElement>('button:not(:disabled)')!;
    expect(document.activeElement, '前提: 先頭の項目に焦点').toBe(inside);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    expect(menu().hidden, '外へ出たのに開いたまま').toBe(true);
    expect(pick().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(outside);
  });

  it('対照群: 一覧の中の移動 / ▼ への移動では閉じない', () => {
    pick().click();
    const items = [...menu().querySelectorAll<HTMLElement>('button:not(:disabled)')];
    expect(items.length, '前提: 項目が 2 つ以上').toBeGreaterThan(1);
    items[0]!.focus();
    items[1]!.focus();
    expect(menu().hidden, '中の移動で閉じた').toBe(false);
    pick().focus();
    expect(menu().hidden, '▼ への移動で閉じた').toBe(false);
  });
});
