/** @vitest-environment happy-dom */
/**
 * 🔴 ノートのタブ 段 5-5(#1982): 周辺の整合。台は実物(shell + NoteTabsBar + binder + 本物の Dispatcher)。
 * 守る:
 * 1. 別ウィンドウ: 印の付いたタブを押すと、そのウィンドウを前に出す(タブは動かさない)。頼めなければ普通に有効にする
 * 2. 2 ペイン中: 列は同じ所に灰色(`data-pkc-dimmed`)で出る。押すと通常ビューへ戻ってそのノートを開く(いまのタブでも)
 * 3. スマホ幅: 「開いているノート ▾」が出て、メニューから切替・閉じる。2 枚未満・タブレットでは出ない
 * 4. 右クリックを何も選ばずに閉じたら、元のタブ・選択・履歴へ戻る(履歴に余計な項目を積まない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { NoteTabsBar } from '../../src/adapter/ui/render/note-tabs';
import { appPhone } from '../../src/adapter/ui/render/phone-layout';
import { PHONE_MIN_PX } from '../../src/features/phone-layout';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid, title: 't-' + lid, archetype: 'text', createdAt: null, updatedAt: null,
    entryOrder: order, status: null, date: null, archived: false, bodyChars: null,
  };
}
const MENU = '[data-pkc-region="context-menu"]';

function setup(services: Record<string, unknown> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const bar = new NoteTabsBar(regions.noteTabs);
  d.onState((s) => bar.render(s));
  bindActions(root, d, services, new KeymapStore());
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2), meta('c', 3)], relations: [] });
  const tabBtn = (lid: string): HTMLElement =>
    regions.noteTabs.querySelector<HTMLElement>(`[data-pkc-field="note-tab-select"][data-pkc-note-tab="${lid}"]`)!;
  const row = (lid: string): HTMLElement => {
    const el = document.createElement('div');
    el.setAttribute('data-pkc-action', 'select-entry');
    el.setAttribute('data-pkc-entry', lid);
    root.append(el);
    return el;
  };
  const lids = (): string[] => d.getState().noteTabs.tabs.map((t) => t.lid);
  return { root, d, host: regions.noteTabs, tabBtn, row, lids, regions };
}
const ctx = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
};
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('別ウィンドウのタブ(裁定 5)', () => {
  it('印の付いたタブを押すと、そのウィンドウを前に出す。タブは動かさない', () => {
    const focus = vi.fn(() => true);
    const t = setup({ focusNoteWindow: focus });
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_EXTERNAL', lid: 'a', external: true });
    t.tabBtn('a').click();
    expect(focus).toHaveBeenCalledWith('a');
    expect(t.d.getState().noteTabs.active, 'タブまで動いた(2 か所で開く)').toBe('b');
  });
  it('対照群: 印の無いタブは普通に有効になり、ウィンドウは呼ばない。頼めなかった(false)ときも有効になる', () => {
    const focus = vi.fn(() => false);
    const t = setup({ focusNoteWindow: focus });
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.tabBtn('a').click();
    expect(focus).not.toHaveBeenCalled();
    expect(t.d.getState().noteTabs.active).toBe('a');
    t.d.dispatch({ type: 'NOTE_TAB_EXTERNAL', lid: 'b', external: true });
    t.tabBtn('b').click();
    expect(focus).toHaveBeenCalledWith('b');
    expect(t.d.getState().noteTabs.active, '頼めなかったのに何も起きない').toBe('b');
  });
  it('印は台帳に揃う(外れたら外れる)', () => {
    const t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_EXTERNAL', lid: 'a', external: true });
    expect(t.host.textContent).toContain('別ウィンドウで開いています');
    t.d.dispatch({ type: 'NOTE_TAB_EXTERNAL', lid: 'a', external: false });
    expect(t.host.textContent).not.toContain('別ウィンドウで開いています');
  });
});

describe('2 ペイン中のタブ列(裁定 6)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
  });
  it('列は灰色の印(data-pkc-dimmed)つきで同じ所に出て、タブの説明が戻ることを言う。通常ビューでは付かない', () => {
    expect(t.host.hasAttribute('data-pkc-dimmed')).toBe(false);
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    expect(t.host.hidden).toBe(false);
    expect(t.host.hasAttribute('data-pkc-dimmed')).toBe(true);
    expect(t.tabBtn('a').title).toBe('押すと 2 ペインを閉じてこのノートを開きます');
    // ⚠ 別ウィンドウのタブは 2 ペインの間でも「そのウィンドウへ移る」と言う(押した動きと揃える)
    t.d.dispatch({ type: 'NOTE_TAB_EXTERNAL', lid: 'b', external: true });
    expect(t.tabBtn('b').title).toContain('押すとそのウィンドウへ移ります');
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    expect(t.host.hasAttribute('data-pkc-dimmed')).toBe(false);
    expect(t.tabBtn('a').title).toBe('t-a');
  });
  it('別のタブを押すと通常ビューへ戻ってそのノートを開く', () => {
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    t.tabBtn('a').click();
    expect(t.d.getState().viewMode).toBe('detail');
    expect(t.d.getState().selectedLid).toBe('a');
  });
  it('🔴 いまのタブ(選択中のノート)を押しても通常ビューへ戻る', () => {
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    expect(t.d.getState().noteTabs.active).toBe('b');
    t.tabBtn('b').click();
    expect(t.d.getState().viewMode, '2 ペインのまま').toBe('detail');
    expect(t.d.getState().selectedLid).toBe('b');
  });
  it('対照群: 通常ビューで いまのタブを押しても何も動かない', () => {
    const before = t.d.getState();
    t.tabBtn('b').click();
    expect(t.d.getState()).toBe(before);
  });
});

describe('スマホ幅: 開いているノート ▾', () => {
  const media = (matches: boolean) => ({ matches, addEventListener: () => {}, removeEventListener: () => {} });
  function phoneSetup(width: 'phone' | 'tablet') {
    const t = setup();
    // 見張りは 3 本(`phone-layout.test.ts` と同じ見分け): 対応外 / タブレット(min-width を持つ唯一の 1 本) / スマホ
    appPhone.install(t.root, (q) =>
      media(q.includes(`${PHONE_MIN_PX - 1}px`) ? false : q.includes('min-width') ? width === 'tablet' : width === 'phone'),
    );
    return { t, phone: appPhone };
  }
  const btn = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('[data-pkc-field="phone-note-tabs"]')!;
  const paint = (t: ReturnType<typeof setup>, phone: typeof appPhone, n: number): void => {
    const st = t.d.getState();
    phone.render({
      selectedLid: st.selectedLid,
      viewMode: st.viewMode,
      editing: false,
      title: 't',
      noteTabs: n,
    });
  };
  it('ボタンは器にあり、既定は隠れている', () => {
    const t = setup();
    expect(btn().hidden).toBe(true);
    expect(btn().textContent).toBe('開いているノート ▾');
    expect(btn().getAttribute('data-pkc-action')).toBe('phone-note-tabs');
    void t;
  });
  it('出し入れ: PhoneLayout が実際に描いた結果を見る(スマホで 2 枚以上のときだけ。1 枚・タブレットでは隠れる)', () => {
    const { t, phone } = phoneSetup('phone');
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    paint(t, phone, 2);
    expect(document.querySelector('[data-pkc-region="phone-bar"]')!.hasAttribute('hidden'), '前提: 帯が出ていない').toBe(false);
    expect(btn().hidden).toBe(false);
    paint(t, phone, 1);
    expect(btn().hidden, '1 枚なのに出ている').toBe(true);
    const { t: t2, phone: ph2 } = phoneSetup('tablet');
    t2.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    paint(t2, ph2, 3);
    expect(btn().hidden, 'タブレットは列が出るので要らない').toBe(true);
  });
  it('押すとタブの一覧が出て、押したタブへ切り替わる。2 度目の押下で閉じる', () => {
    const t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    btn().hidden = false;
    btn().click();
    const items = [...document.querySelectorAll<HTMLElement>(`${MENU} [data-pkc-action="activate-note-tab"]`)];
    expect(items.map((i) => i.textContent)).toEqual(['t-a', 't-b']);
    expect(items[1]!.getAttribute('aria-checked'), '現在のタブが分からない').toBe('true');
    expect(document.querySelector(`${MENU} [data-pkc-action="close-note-tab"]`)).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>(`${MENU} [data-pkc-action="reopen-note-tab"]`)!.disabled).toBe(true);
    btn().click();
    expect(document.querySelector(MENU), '2 度目で閉じない(片道)').toBeNull();
    btn().click();
    document.querySelector<HTMLElement>(`${MENU} [data-pkc-action="activate-note-tab"]`)!.click();
    expect(t.d.getState().noteTabs.active).toBe('a');
    expect(t.d.getState().selectedLid).toBe('a');
  });
  it('メニューから閉じる → 閉じたタブを開き直せる', () => {
    const t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    btn().click();
    document.querySelector<HTMLElement>(`${MENU} [data-pkc-action="close-note-tab"]`)!.click();
    expect(t.lids()).toEqual(['a']);
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
    t.d.dispatch({ type: 'NOTE_TAB_CLOSE', lid: 'c' });
    btn().click();
    // 1 枚なのでメニューは出ない(列も出ない)
    expect(document.querySelector(MENU)).toBeNull();
  });
});

describe('右クリックを何も選ばずに閉じたら元へ戻る(5-4 の持ち越し)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b', activate: false });
  });
  const snapshot = () => {
    const s = t.d.getState();
    return { lids: t.lids(), active: s.noteTabs.active, sel: s.selectedLid, past: [...s.selectionHistory.past], future: [...s.selectionHistory.future] };
  };
  it('Esc で閉じると、タブも選択も履歴も右クリックの前のまま', async () => {
    const before = snapshot();
    expect(before).toEqual({ lids: ['a', 'b'], active: 'a', sel: 'a', past: ['a'], future: [] });
    ctx(t.row('c'));
    expect(t.d.getState().selectedLid, '前提: 右クリックで選択が動く').toBe('c');
    expect(t.lids(), '前提: 右クリックでタブが差し替わる').toEqual(['c', 'b']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Esc が効かない台でも、外を押して閉じる経路で確かめる
    if (document.querySelector(MENU) !== null) t.root.click();
    await flush();
    expect(document.querySelector(MENU), '前提: メニューが閉じている').toBeNull();
    expect(snapshot()).toEqual(before);
  });
  it('項目を押した回は戻さない(新しいタブで開く → いままでどおり)', async () => {
    ctx(t.row('c'));
    document.querySelector<HTMLElement>(`${MENU} [data-pkc-action="open-note-new-tab"]`)!.click();
    await flush();
    expect(t.lids().sort()).toEqual(['a', 'b', 'c']);
    expect(t.d.getState().selectedLid).toBe('c');
  });
  it('🔴 選択もタブも動かさない項目(参照をコピー)を押した回も戻さない(押した行のまま)', async () => {
    ctx(t.row('c'));
    const afterRightClick = snapshot();
    document.querySelector<HTMLElement>(`${MENU} [data-pkc-action="copy-entry-ref"]`)!.click();
    await flush();
    expect(document.querySelector(MENU), '前提: 項目を押してメニューが閉じた').toBeNull();
    expect(snapshot()).toEqual(afterRightClick);
    expect(t.d.getState().selectedLid).toBe('c');
  });
  it('閉じる前に別の操作で選択が動いていたら、巻き戻さない', async () => {
    ctx(t.row('c'));
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    t.root.click();
    await flush();
    expect(t.d.getState().selectedLid).toBe('b');
  });
  it('🔴 同じ行を続けて右クリックしても、新しいメニューの裏で選択が戻らない(閉じたときだけ戻る)', async () => {
    const before = snapshot();
    ctx(t.row('c'));
    ctx(t.row('c'));
    await flush();
    expect(document.querySelector(MENU), '前提: 2 度目のメニューが出ている').not.toBeNull();
    expect(t.d.getState().selectedLid, 'メニューが出ているのに選択が戻った').toBe('c');
    t.root.click();
    await flush();
    expect(document.querySelector(MENU)).toBeNull();
    expect(snapshot()).toEqual(before);
  });
  it('メニューを開いたまま別の行を右クリックしても、最初の姿へ戻る', async () => {
    const before = snapshot();
    ctx(t.row('c'));
    ctx(t.row('b'));
    t.root.click();
    await flush();
    expect(document.querySelector(MENU)).toBeNull();
    expect(snapshot()).toEqual(before);
  });
});
