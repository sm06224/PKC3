/** @vitest-environment happy-dom */
/**
 * 🔴 ノートのタブの操作(#1982 段 5-4)。台は実物(shell + NoteTabsBar + binder + 本物の Dispatcher)。
 * 守る:
 * - 新しいタブ: Ctrl/⌘+クリック・中ボタン(行・本文のアプリ内リンク)。通常クリックは差し替えのまま
 * - 🔴 在る意味を奪わない: 左の列の表の Ctrl+クリックは「印を付ける」のまま(新しいタブは中ボタン・右クリック)
 * - 右クリック: 行「新しいタブで開く」(いまのタブはそのまま)/ タブ「閉じる・他を閉じる・開き直す」(押したタブが相手・選択は動かない)
 * - キー: Alt+PageDown / Alt+PageUp、操作を探す(dry で押せる / 押せないが分かる)
 * - タブ列: ← → Home End で焦点、Delete で閉じる(一覧の選択は動かない)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { NoteTabsBar } from '../../src/adapter/ui/render/note-tabs';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid, title: 't-' + lid, archetype: 'text', createdAt: null, updatedAt: null,
    entryOrder: order, status: null, date: null, archived: false, bodyChars: null,
  };
}

const MENU = '[data-pkc-region="context-menu"]';

function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const bar = new NoteTabsBar(regions.noteTabs);
  d.onState((s) => bar.render(s));
  const keymap = new KeymapStore();
  bindActions(root, d, {}, keymap);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2), meta('c', 3), meta('d', 4)], relations: [] });
  const tabLids = (): string[] =>
    [...regions.noteTabs.querySelectorAll<HTMLElement>('[data-pkc-field="note-tab-select"]')].map(
      (t) => t.getAttribute('data-pkc-note-tab')!,
    );
  const lids = (): string[] => d.getState().noteTabs.tabs.map((t) => t.lid);
  /** 一覧の行(左の列の表の外 = かんばん等と同じ select-entry) */
  const row = (lid: string, inFiler = false): HTMLElement => {
    const host = document.createElement('div');
    if (inFiler) host.setAttribute('data-pkc-region', 'filer-table');
    const el = document.createElement('div');
    el.setAttribute('data-pkc-action', 'select-entry');
    el.setAttribute('data-pkc-entry', lid);
    host.append(el);
    root.append(host);
    return el;
  };
  const link = (lid: string): HTMLElement => {
    const a = document.createElement('a');
    a.setAttribute('href', 'entry:' + lid);
    a.setAttribute('data-pkc-action', 'navigate-entry-ref');
    a.setAttribute('data-pkc-entry-ref', 'entry:' + lid);
    root.append(a);
    return a;
  };
  const tabBtn = (lid: string): HTMLElement =>
    regions.noteTabs.querySelector<HTMLElement>(`[data-pkc-field="note-tab-select"][data-pkc-note-tab="${lid}"]`)!;
  const key = (init: KeyboardEventInit & { key: string }, target: EventTarget = document.body): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  return { keymap, d, root, host: regions.noteTabs, tabLids, lids, row, link, tabBtn, key };
}

const click = (el: Element, init: MouseEventInit = {}): MouseEvent => {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
};
const aux = (el: Element): MouseEvent => {
  const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  el.dispatchEvent(ev);
  return ev;
};

describe('新しいタブで開く: Ctrl/⌘+クリック・中ボタン', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  });

  it('通常クリックは差し替え(対照群)', () => {
    click(t.row('b'));
    expect(t.lids()).toEqual(['b']);
  });
  it('Ctrl+クリックで新しいタブ(いまのタブは残り、開いたものが有効)', () => {
    const ev = click(t.row('b'), { ctrlKey: true });
    expect(t.lids()).toEqual(['a', 'b']);
    expect(t.d.getState().noteTabs.active).toBe('b');
    expect(t.d.getState().selectedLid).toBe('b');
    expect(ev.defaultPrevented).toBe(true);
  });
  it('⌘(metaKey)+クリックも同じ', () => {
    click(t.row('b'), { metaKey: true });
    expect(t.lids()).toEqual(['a', 'b']);
  });
  it('Ctrl+Shift / Ctrl+Alt は奪わない(他の意味が先)', () => {
    click(t.row('b'), { ctrlKey: true, shiftKey: true });
    click(t.row('c'), { ctrlKey: true, altKey: true });
    expect(t.lids()).toEqual(['c']);
  });
  it('🔴 左の列の表の Ctrl+クリックは「印を付ける」のまま。新しいタブにならない', () => {
    click(t.row('b', true), { ctrlKey: true });
    expect(t.lids(), 'Ctrl+クリックが印を付ける意味を奪われた').toEqual(['a']);
    expect(t.d.getState().selection).toContain('b');
  });
  it('中ボタン(auxclick)で新しいタブ。左の列の表の中でも効く', () => {
    const ev = aux(t.row('b', true));
    expect(t.lids()).toEqual(['a', 'b']);
    expect(ev.defaultPrevented).toBe(true);
  });
  it('中ボタンの mousedown は自動スクロールを止める(対象の上だけ)', () => {
    const down = (el: Element): MouseEvent => {
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
      el.dispatchEvent(ev);
      return ev;
    };
    expect(down(t.row('b')).defaultPrevented).toBe(true);
    const plain = document.createElement('p');
    t.root.append(plain);
    expect(down(plain).defaultPrevented).toBe(false);
  });
  it('本文のアプリ内リンク: Ctrl+クリック・中ボタンで新しいタブ。通常クリックは差し替え', () => {
    click(t.link('b'), { ctrlKey: true });
    expect(t.lids()).toEqual(['a', 'b']);
    aux(t.link('c'));
    expect(t.lids()).toEqual(['a', 'b', 'c']);
    click(t.link('d'));
    expect(t.lids()).toEqual(['a', 'b', 'd']);
  });
  it('別の PKC のリンクは新しいタブにしない(断りは通常のクリックと同じ)', () => {
    const a = t.link('b');
    a.setAttribute('data-pkc-entry-ref', 'pkc://other/entry/b');
    aux(a);
    expect(t.lids()).toEqual(['a']);
  });
  it('編集中は新しいタブも開かない(理由を出し、タブは動かない)', () => {
    t.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    t.d.dispatch({ type: 'START_EDIT' });
    click(t.row('b'), { ctrlKey: true });
    expect(t.lids()).toEqual(['a']);
    expect(t.d.getState().phase).toBe('editing');
  });
});

describe('右クリック: 一覧の行 / タブ', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  });
  const ctx = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  };
  const item = (action: string): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(`${MENU} [data-pkc-action="${action}"]`)!;

  it('行: 「新しいタブで開く」を出し、押すと いまのタブはそのまま + 押した行が新しいタブ', () => {
    ctx(t.row('b'));
    const it1 = item('open-note-new-tab');
    expect(it1.textContent).toContain('新しいタブで開く');
    item('open-note-new-tab').click();
    expect(t.lids(), '右クリックで差し替わった a が戻っていない').toEqual(['a', 'b']);
    expect(t.d.getState().noteTabs.active).toBe('b');
  });
  it('タブ: 3 項目を出す。選択は動かない', () => {
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    ctx(t.tabBtn('a'));
    expect(item('close-note-tab')).not.toBeNull();
    expect(item('close-other-note-tabs')).not.toBeNull();
    expect(item('reopen-note-tab').disabled, '閉じたタブが無いのに押せる').toBe(true);
    // 行のメニュー(選択まで動く)が出ていない
    expect(item('open-note-window')).toBeNull();
    expect(t.d.getState().selectedLid).toBe('b');
  });
  it('タブ: 「タブを閉じる」は押したタブ(有効なタブではない)を閉じる', () => {
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    ctx(t.tabBtn('a'));
    item('close-note-tab').click();
    expect(t.lids()).toEqual(['b']);
  });
  it('タブ: 「他のタブを閉じる」は押したタブだけを残して有効にする。「閉じたタブを開き直す」で 1 枚ずつ戻る', () => {
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
    ctx(t.tabBtn('a'));
    item('close-other-note-tabs').click();
    expect(t.lids()).toEqual(['a']);
    expect(t.d.getState().selectedLid).toBe('a');
    // 戻す(ここは 1 枚なので列は出ていない = 右クリックの口は reopen のキーと同じ action を直に押す)
    t.row('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    document.body.querySelector(MENU)?.remove();
    t.d.dispatch({ type: 'NOTE_TAB_REOPEN' });
    expect(t.lids().length).toBe(2);
  });
  it('タブ: 閉じたタブがあれば「開き直す」が押せて、戻る', () => {
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
    t.d.dispatch({ type: 'NOTE_TAB_CLOSE', lid: 'b' });
    ctx(t.tabBtn('a'));
    expect(item('reopen-note-tab').disabled).toBe(false);
    item('reopen-note-tab').click();
    expect(t.lids()).toContain('b');
    expect(t.d.getState().noteTabs.active).toBe('b');
  });
  it('編集中、他のタブを閉じるは何も閉じない', () => {
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: '本文' });
    t.d.dispatch({ type: 'START_EDIT' });
    ctx(t.tabBtn('a'));
    item('close-other-note-tabs').click();
    expect(t.lids()).toEqual(['a', 'b']);
  });
});

describe('キー: Alt+PageDown / Alt+PageUp と 操作を探す', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
  });
  it('既定の割当は Alt+PageDown / Alt+PageUp のちょうど 2 つ(Alt+数字は作らない)', () => {
    const tabCmds = KEY_COMMANDS.filter((c) => c.id.startsWith('tab-'));
    expect(tabCmds.map((c) => [c.id, c.defaults])).toEqual([
      ['tab-next', ['Alt+PageDown']],
      ['tab-prev', ['Alt+PageUp']],
      ['tab-close', []],
      ['tab-reopen', []],
    ]);
  });
  it('Alt+PageDown で次(端の次は先頭)、Alt+PageUp で前', () => {
    expect(t.d.getState().noteTabs.active).toBe('c');
    const ev = t.key({ key: 'PageDown', code: 'PageDown', altKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(t.d.getState().noteTabs.active).toBe('a');
    t.key({ key: 'PageUp', code: 'PageUp', altKey: true });
    expect(t.d.getState().noteTabs.active).toBe('c');
    t.key({ key: 'PageUp', code: 'PageUp', altKey: true });
    expect(t.d.getState().noteTabs.active).toBe('b');
    expect(t.d.getState().selectedLid).toBe('b');
  });
  it('Alt を伴わない PageDown は奪わない', () => {
    const ev = t.key({ key: 'PageDown', code: 'PageDown' });
    expect(ev.defaultPrevented).toBe(false);
    expect(t.d.getState().noteTabs.active).toBe('c');
  });
  it('文字を打つ欄の中では効かない', () => {
    const input = document.createElement('textarea');
    t.root.append(input);
    t.key({ key: 'PageDown', code: 'PageDown', altKey: true }, input);
    expect(t.d.getState().noteTabs.active).toBe('c');
  });
  const run = (cmd: string, dry: boolean): boolean =>
    runGlobalCommand(cmd, t.root, t.d, t.keymap, () => {}, () => {}, dry);
  it('操作を探す: 次・前・閉じる・開き直す(押せる / 押せない)', () => {
    expect(run('tab-next', true)).toBe(true);
    expect(run('tab-prev', true)).toBe(true);
    expect(run('tab-close', true)).toBe(true);
    expect(run('tab-reopen', true), '閉じたタブが無いのに押せる').toBe(false);
    expect(run('tab-close', false)).toBe(true);
    expect(t.lids()).toEqual(['a', 'b']);
    expect(run('tab-reopen', true)).toBe(true);
    expect(run('tab-reopen', false)).toBe(true);
    expect(t.lids()).toEqual(['a', 'b', 'c']);
  });
  it('操作を探す: タブが 1 枚なら次・前は押せない', () => {
    const u = setup();
    u.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(runGlobalCommand('tab-next', u.root, u.d, u.keymap, () => {}, () => {}, true)).toBe(false);
    expect(runGlobalCommand('tab-prev', u.root, u.d, u.keymap, () => {}, () => {}, true)).toBe(false);
  });
  it('編集中は押せない(行は灰色)。鍵で撃つと理由を言い、タブは動かない', () => {
    t.d.dispatch({ type: 'BODY_LOADED', lid: 'c', body: '本文' });
    t.d.dispatch({ type: 'START_EDIT' });
    expect(run('tab-next', true)).toBe(false);
    const said: string[] = [];
    runGlobalCommand('tab-next', t.root, t.d, t.keymap, () => {}, (m) => said.push(m), false);
    expect(said.length).toBe(1);
    expect(t.d.getState().noteTabs.active).toBe('c');
  });
});

describe('タブ列のキー: ← → Home End / Delete', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    t.d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'c' });
    document.body.append(t.root);
  });
  it('→ ← で焦点が隣へ(端は反対側へ回る)。有効なタブは変わらず、一覧の選択も動かない', () => {
    const order = t.tabLids();
    t.tabBtn(order[0]!).focus();
    const ev = t.key({ key: 'ArrowRight' }, t.tabBtn(order[0]!));
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(t.tabBtn(order[1]!));
    t.key({ key: 'ArrowLeft' }, t.tabBtn(order[1]!));
    t.key({ key: 'ArrowLeft' }, t.tabBtn(order[0]!));
    expect(document.activeElement).toBe(t.tabBtn(order[2]!));
    t.key({ key: 'Home' }, t.tabBtn(order[2]!));
    expect(document.activeElement).toBe(t.tabBtn(order[0]!));
    t.key({ key: 'End' }, t.tabBtn(order[0]!));
    expect(document.activeElement).toBe(t.tabBtn(order[2]!));
    expect(t.d.getState().noteTabs.active).toBe('c');
    expect(t.d.getState().selectedLid).toBe('c');
  });
  it('矢印は上へ流さない(全域の鍵・左の列の行移動に届かない)', () => {
    let reached = false;
    document.addEventListener('keydown', () => (reached = true), { once: true });
    t.key({ key: 'ArrowRight' }, t.tabBtn(t.tabLids()[0]!));
    expect(reached).toBe(false);
  });
  it('Delete で押したタブを閉じる(閉じたあとも焦点は列に残る)', () => {
    t.tabBtn('b').focus();
    const ev = t.key({ key: 'Delete' }, t.tabBtn('b'));
    expect(ev.defaultPrevented).toBe(true);
    expect(t.lids()).toEqual(['a', 'c']);
    expect(document.activeElement?.closest('[data-pkc-region="note-tabs"]')).not.toBeNull();
  });
  it('修飾キー付き・タブ以外では動かない(対照群)', () => {
    t.key({ key: 'Delete', ctrlKey: true }, t.tabBtn('b'));
    t.key({ key: 'Delete' }, t.root);
    expect(t.lids()).toEqual(['a', 'b', 'c']);
  });
});
