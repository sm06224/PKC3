/** @vitest-environment happy-dom */
/**
 * 🔴 ノートのタブ列の描画(#1982 段 5-3)。台は実物(shell + NoteTabsBar + binder)。
 * 守る: 0/1 枚では描かない / 2 枚以上で出る / ピン留め先頭 / aria-selected = 有効 / 編集中 ● / 別ウィンドウ /
 * 押すと有効 / × で閉じる / 題名の変更に追従。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { NoteTabsBar } from '../../src/adapter/ui/render/note-tabs';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid, title: 't-' + lid, archetype: 'text', createdAt: null, updatedAt: null,
    entryOrder: order, status: null, date: null, archived: false, bodyChars: null,
  };
}

function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const bar = new NoteTabsBar(regions.noteTabs);
  d.onState((s) => bar.render(s));
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2), meta('c', 3)], relations: [] });
  const host = regions.noteTabs;
  const tabs = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
  const names = (): string[] =>
    tabs().map((t) => t.querySelector('[data-pkc-field="note-tab-title"]')!.textContent ?? '');
  return { d, host, tabs, names };
}

describe('ノートのタブ列', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('0 枚・1 枚では描かない(hidden で中身も無い)', () => {
    expect(t.host.hidden).toBe(true);
    expect(t.host.children.length).toBe(0);
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(t.d.getState().noteTabs.tabs.length).toBe(1);
    expect(t.host.hidden).toBe(true);
    expect(t.host.children.length).toBe(0);
  });

  it('2 枚以上で出る。tablist / tab / aria-selected が有効なタブと一致する', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    expect(t.host.hidden).toBe(false);
    expect(t.host.getAttribute('role')).toBe('tablist');
    expect(t.names()).toEqual(['t-a', 't-b']);
    expect(t.tabs().map((x) => x.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(t.tabs()[1]!.title).toBe('t-b');
    t.d.dispatch({ type: 'NOTE_TAB_ACTIVATE', lid: 'a' });
    expect(t.tabs().map((x) => x.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('ピン留めが先頭に並ぶ(印は aria-hidden)', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'SET_NOTE_PINS', lids: ['b'] });
    expect(t.names()).toEqual(['t-b', 't-a']);
    const pin = t.tabs()[0]!.querySelector('[data-pkc-field="note-tab-pin"]');
    expect(pin?.getAttribute('aria-hidden')).toBe('true');
    expect(t.tabs()[1]!.querySelector('[data-pkc-field="note-tab-pin"]')).toBeNull();
  });

  it('編集中のタブだけに ● が付く(aria-hidden + 名前に「編集中」)', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    expect(t.host.querySelector('[data-pkc-field="note-tab-dirty"]')).toBeNull();
    t.d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: 'x' });
    t.d.dispatch({ type: 'START_EDIT' });
    expect(t.d.getState().phase).toBe('editing');
    const dots = t.host.querySelectorAll('[data-pkc-field="note-tab-dirty"]');
    expect(dots.length).toBe(1);
    expect(dots[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(dots[0]!.textContent).toBe('●');
    expect(t.tabs()[1]!.getAttribute('aria-label')).toContain('編集中');
  });

  it('別ウィンドウのタブは「別ウィンドウで開いています」を出す', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    expect(t.host.querySelector('[data-pkc-field="note-tab-external"]')).toBeNull();
    t.d.dispatch({ type: 'NOTE_TAB_EXTERNAL', lid: 'b', external: true });
    const ext = t.host.querySelector('[data-pkc-field="note-tab-external"]');
    expect(ext?.textContent).toBe('別ウィンドウで開いています');
    expect(t.tabs()[1]!.title).toContain('別ウィンドウで開いています');
  });

  it('タブを押すと有効になり、× で閉じる', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.tabs()[0]!.click();
    expect(t.d.getState().noteTabs.active).toBe('a');
    expect(t.d.getState().selectedLid).toBe('a');
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
    const close = t.host.querySelector<HTMLElement>('[data-pkc-action="close-note-tab"][data-pkc-note-tab="c"]')!;
    expect(close.getAttribute('aria-label')).toBe('タブを閉じる');
    close.click();
    expect(t.d.getState().noteTabs.tabs.map((x) => x.lid)).toEqual(['a', 'b']);
    expect(t.names()).toEqual(['t-a', 't-b']);
  });

  it('🔴 × は押したタブを閉じる(有効なタブ・選択中のノートではない)', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
    expect(t.d.getState().selectedLid).toBe('c');
    t.host.querySelector<HTMLElement>('[data-pkc-action="close-note-tab"][data-pkc-note-tab="a"]')!.click();
    expect(t.d.getState().noteTabs.tabs.map((x) => x.lid)).toEqual(['b', 'c']);
    expect(t.d.getState().selectedLid).toBe('c');
    // 押したタブを有効にする側も同じ(有効でない b を押す)
    t.tabs()[0]!.click();
    expect(t.d.getState().selectedLid).toBe('b');
  });

  it('🔴 列の中に一覧の行の印(data-pkc-entry)を置かない(右クリック・ドラッグの汎用の受け手に拾わせない)', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    expect(t.host.querySelectorAll('[data-pkc-note-tab]').length).toBe(4); // 空振り防止
    expect(t.host.querySelector('[data-pkc-entry]')).toBeNull();
  });

  it('🔑 Tab キーで止まるのは有効なタブ 1 つ(× は止めない)', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    const stops = [...t.host.querySelectorAll<HTMLElement>('button')].filter((b) => b.tabIndex >= 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute('data-pkc-note-tab')).toBe('b');
    expect(stops[0]!.getAttribute('role')).toBe('tab');
  });

  it('🔴 作り直してもフォーカスを落とさない(押したタブへ / 閉じたら有効なタブへ)', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
    const a = t.tabs()[0]!;
    a.focus();
    a.click(); // 有効が変わる → 作り直し
    expect(t.tabs()[0]).not.toBe(a); // 空振り防止: 実際に作り直された
    expect((document.activeElement as HTMLElement).getAttribute('data-pkc-note-tab')).toBe('a');
    expect((document.activeElement as HTMLElement).getAttribute('data-pkc-field')).toBe('note-tab-select');
    const x = t.host.querySelector<HTMLElement>('[data-pkc-action="close-note-tab"][data-pkc-note-tab="a"]')!;
    x.focus();
    x.click();
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).getAttribute('data-pkc-note-tab')).toBe(
      t.d.getState().noteTabs.active,
    );
  });

  it('🔑 姿が変わらない dispatch では作り直さない(押している最中・打鍵ごとに DOM を捨てない)', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    const first = t.host.children[0];
    // state は動くが、タブの姿は変わらない(タブに無い c をピン留め)
    const before = t.d.getState();
    t.d.dispatch({ type: 'SET_NOTE_PINS', lids: ['c'] });
    expect(t.d.getState()).not.toBe(before); // 空振り防止: 描き手は呼ばれている
    expect(t.host.children[0]).toBe(first);
  });

  it('題名の変更に追従する', () => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'b', title: '新しい題' });
    expect(t.names()).toEqual(['t-a', '新しい題']);
    expect(t.tabs()[1]!.title).toBe('新しい題');
  });
});

describe('タブ列の CSS(コメントを剥がして pin)', () => {
  it('🔴 印刷ではタブ列を出さない(`!important` で ── 画面の規則は詳細度が高く、しかも後ろに在る)', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
    const start = css.indexOf('@media print');
    expect(start).toBeGreaterThan(0);
    // ⚠ 字があるかだけ見ると、詳細度・順番で負けて紙に出ていても緑だった(smoke で見つかった)。
    //   画面の規則が印刷の節より後ろ・高い詳細度であることを前提として確かめ、だから !important が要る
    const screenAt = css.indexOf("[data-pkc-region='note-tabs']:not([hidden])", start);
    expect(screenAt, '前提: 画面の規則が印刷の節より後ろに在る').toBeGreaterThan(start);
    const print = blocksFor(css.slice(start), "[data-pkc-region='note-tabs']").join('\n');
    expect(print, '印刷の節で、タブ列を !important で消していない').toMatch(/display:\s*none\s*!important/);
  });

  const css = stripComments(readFileSync('src/styles/app.css', 'utf8'));
  it('現在のタブは左端の内側の線(accent)+ 太字 + 選択の地', () => {
    const cell = blocksFor(css, "[data-pkc-field='note-tab'][data-pkc-active]").join('\n');
    expect(cell).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--accent\)/);
    expect(cell).toMatch(/background:\s*var\(--pkc-selected-bg\)/);
    const sel = blocksFor(
      css,
      "[data-pkc-field='note-tab'][data-pkc-active] [data-pkc-field='note-tab-select']",
    ).join('\n');
    expect(sel).toMatch(/font-weight:\s*600/);
  });
  it('列は折り返さず横スクロール・hidden を display で打ち消さない', () => {
    const row = blocksFor(css, "[data-pkc-region='note-tabs']:not([hidden])").join('\n');
    expect(row).toMatch(/flex-wrap:\s*nowrap/);
    expect(row).toMatch(/overflow-x:\s*auto/);
    // ⚠ 画面の規則だけを見る(印刷の節は「紙では消す」ために display を書く)
    expect(withoutMedia(css)).not.toMatch(/\[data-pkc-region='note-tabs'\]\s*\{[^}]*display/);
  });
  it('hover は surface-hover + muted の対', () => {
    const h = blocksFor(css, "[data-pkc-field='note-tab']:hover").join('\n');
    expect(h).toMatch(/background:\s*var\(--surface-hover\)/);
    expect(h).toMatch(/--muted:\s*var\(--pkc-muted-on-mark\)/);
  });
});
