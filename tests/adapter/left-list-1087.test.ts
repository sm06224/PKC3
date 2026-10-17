/** @vitest-environment happy-dom */
/**
 * 左の列「フォルダ」の一覧の取りこぼし 6 件(#1087)。どれも直す前の実装で落ちる。
 * B1 消した後の ↓/↑ / B2 親へ戻ったあとの焦点 / B3 フォルダごとのスクロール位置 /
 * B4 開いている物を消した後の後継 / B5 並べ替えの鍵になる列の指紋 / B6 題名順などでの並べ替えの落とし先。
 */
import { describe, it, expect } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { OpenInEditStore } from '../../src/adapter/ui/render/open-in-edit';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

function memStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}
function meta(lid: string, order: number, title = 't-' + lid, archetype = 'text', over: Partial<EntryMeta> = {}): EntryMeta {
  return { lid, title, archetype, createdAt: null, updatedAt: null, entryOrder: order, status: null, date: null, archived: false, bodyChars: null, ...over } as EntryMeta;
}
const rel = (id: string, from: string, to: string): Relation =>
  ({ id, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null }) as Relation;
const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

function screen(metas: EntryMeta[], relations: Relation[] = []) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  bindActions(
    root,
    d,
    { setBrowse: () => {} } as never,
    new KeymapStore(memStorage() as never),
    new OpenInEditStore(memStorage() as never),
  );
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('x')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  } as never);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const rows = () => [...pane.querySelectorAll('tbody [data-pkc-entry]')].map((r) => r.getAttribute('data-pkc-entry')!);
  const row = (lid: string) => pane.querySelector<HTMLElement>(`tbody [data-pkc-entry="${lid}"]`)!;
  const clickRow = (lid: string, over: MouseEventInit = {}) => {
    const el = row(lid);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...over }));
    el.focus();
    return el;
  };
  const press = (key: string, from: Element) =>
    from.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  const active = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-pkc-entry') ?? null;
  return { root, d, regions, pane, rows, row, clickRow, press, active };
}

const notes = (n: number) => Array.from({ length: n }, (_, i) => meta('n' + i, i + 1));

describe('B1 消した後の行送り', () => {
  it('1 件消した後の ↓ は消した位置の次の行、↑ は手前の行', async () => {
    const s = screen(notes(10));
    s.press('Delete', s.clickRow('n5'));
    await tick(30);
    expect(s.rows()).not.toContain('n5');
    s.press('ArrowDown', document.activeElement!);
    expect(s.d.getState().selection).toEqual(['n6']);

    const t = screen(notes(10));
    t.press('Delete', t.clickRow('n5'));
    await tick(30);
    t.press('ArrowUp', document.activeElement!);
    expect(t.d.getState().selection).toEqual(['n4']);
  });
  it('まとめて消した後は先頭の消えた位置の隣から / 末尾を消したら新しい末尾', async () => {
    const s = screen(notes(10));
    s.clickRow('n3');
    s.clickRow('n4', { ctrlKey: true });
    expect([...s.d.getState().selection].sort()).toEqual(['n3', 'n4']);
    s.press('Delete', s.row('n4'));
    await tick(30);
    expect(s.rows()).not.toContain('n3');
    s.press('ArrowDown', document.activeElement!);
    expect(s.d.getState().selection).toEqual(['n5']);

    const t = screen(notes(4));
    t.press('Delete', t.clickRow('n3'));
    await tick(30);
    t.press('ArrowUp', document.activeElement!);
    expect(t.d.getState().selection).toEqual(['n2']);
  });
});

describe('B2 親フォルダへ戻る', () => {
  it('Backspace で出たあとの焦点は出てきたフォルダ(Enter でそのフォルダへ入り直す)', () => {
    const metas = [...notes(8), meta('F', 100, 'FOLDER', 'folder'), meta('c0', 101, 'child')];
    const s = screen(metas, [rel('r', 'F', 'c0')]);
    s.press('Enter', s.clickRow('F'));
    expect(s.d.getState().scopeLid).toBe('F');
    s.press('Backspace', document.activeElement!);
    expect(s.d.getState().scopeLid).toBeNull();
    expect(s.active()).toBe('F');
    s.press('Enter', document.activeElement!);
    expect(s.d.getState().scopeLid).toBe('F');
  });
});

describe('B3 スクロール位置はフォルダごと', () => {
  it('入って出ても、ルートの位置が戻る', () => {
    const children = Array.from({ length: 300 }, (_, i) => meta('c' + i, 1000 + i));
    const metas = [meta('F', 1, 'F', 'folder'), ...Array.from({ length: 300 }, (_, i) => meta('r' + i, 10 + i)), ...children];
    const s = screen(metas, children.map((c, i) => rel('x' + i, 'F', c.lid)));
    const host = s.regions.browseHost;
    let top = 0;
    Object.defineProperty(host, 'scrollTop', {
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, s.rows().length * 26 - 400));
      },
      configurable: true,
    });
    host.scrollTop = 3000;
    host.dispatchEvent(new Event('scroll'));
    s.d.dispatch({ type: 'SET_SCOPE', lid: 'F' });
    expect(host.scrollTop).toBe(0);
    s.d.dispatch({ type: 'SET_SCOPE', lid: null });
    expect(host.scrollTop).toBe(3000);
  });
});

describe('B4 開いているノートを消した後の後継', () => {
  const metas = [
    meta('F', 1, 'F', 'folder'),
    meta('a', 2, 'a'),
    meta('b', 3, 'b'),
    meta('c', 4, 'c'),
    meta('z1', 5, 'z1'),
    meta('z2', 6, 'z2'),
  ];
  const rels = [rel('r1', 'F', 'a'), rel('r2', 'F', 'b'), rel('r3', 'F', 'c')];
  it('1 件: 見えているフォルダの中の隣(下、無ければ上)が開く', () => {
    const s = screen(metas, rels);
    s.d.dispatch({ type: 'SET_SCOPE', lid: 'F' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    s.d.dispatch({ type: 'DELETE_ENTRY', lid: 'b' });
    expect(s.d.getState().selectedLid).toBe('c');
    s.d.dispatch({ type: 'DELETE_ENTRY', lid: 'c' });
    expect(s.d.getState().selectedLid).toBe('a');
  });
  it('題名順では、手で並べた順ではなく見えている順の隣', () => {
    const ms = [meta('x', 1, 'ccc'), meta('y', 2, 'aaa'), meta('w', 3, 'bbb'), meta('v', 4, 'ddd')];
    const s = screen(ms);
    s.d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' });
    expect(s.rows()).toEqual(['y', 'w', 'x', 'v']);
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'x' });
    s.d.dispatch({ type: 'DELETE_ENTRY', lid: 'x' });
    expect(s.d.getState().selectedLid).toBe('v'); // 手で並べた順なら 'y'(x の次)になる
  });
  it('まとめて: 見えている順で、消す物を除いた次(題名順)', () => {
    const ms = [meta('x', 1, 'ccc'), meta('y', 2, 'aaa'), meta('w', 3, 'bbb'), meta('v', 4, 'ddd')];
    const s = screen(ms);
    s.d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'x' });
    s.d.dispatch({ type: 'DELETE_ENTRIES', lids: ['x', 'y'] });
    expect(s.d.getState().selectedLid).toBe('v'); // 手で並べた順なら 'w'
  });
  it('フォルダの中で先頭 2 件を消したら残りの先頭', () => {
    const s = screen(metas, rels);
    s.d.dispatch({ type: 'SET_SCOPE', lid: 'F' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    s.d.dispatch({ type: 'DELETE_ENTRIES', lids: ['a', 'b'] });
    expect(s.d.getState().selectedLid).toBe('c');
  });
  it('開いている物が見えている行に居なければ、従来どおり(中央を空にしない)', () => {
    const s = screen(metas, rels);
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' }); // ルートを見ているが b はフォルダの中
    s.d.dispatch({ type: 'DELETE_ENTRY', lid: 'b' });
    expect(s.d.getState().selectedLid).not.toBeNull();
  });
});

describe('B5 並べ替えの鍵になる列が変わったら描き直す', () => {
  it('「更新」順: 同じ日の更新で順が入れ替わる', () => {
    const t = new Date();
    const at = (h: number) =>
      new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h)).toISOString().slice(0, 19).replace('T', ' ');
    const s = screen([
      meta('A', 1, 'A', 'text', { updatedAt: at(10) }),
      meta('B', 2, 'B', 'text', { updatedAt: at(9) }),
      meta('C', 3, 'C', 'text', { updatedAt: at(8) }),
    ]);
    s.d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'updated' });
    const before = s.rows();
    s.d.dispatch({ type: 'ENTRY_STAMPED', lid: 'C', createdAt: null, updatedAt: at(11) } as never);
    expect(s.rows()).not.toEqual(before);
    expect(s.rows()[0]).toBe('C');
  });
  it('「大きさ」順: 文字数が変わったら順が入れ替わる', () => {
    const s = screen([
      meta('A', 1, 'A', 'text', { bodyChars: 30 }),
      meta('B', 2, 'B', 'text', { bodyChars: 20 }),
      meta('C', 3, 'C', 'text', { bodyChars: 10 }),
    ]);
    s.d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'size' });
    const before = s.rows();
    s.d.dispatch({ type: 'ENTRY_STAMPED', lid: 'C', createdAt: null, updatedAt: null, bodyChars: 99 } as never);
    expect(s.rows()).not.toEqual(before);
    expect(s.rows()[0]).toBe('C');
  });
});

describe('B6 並べ替えの落とし先は「自分で並べた順」のときだけ', () => {
  function drag(type: string, target: Element, lids: string, y: number) {
    const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
    ev.dataTransfer = { types: ['application/x-pkc-lids'], getData: () => lids, setData() {}, dropEffect: 'none', effectAllowed: 'move' };
    ev.clientY = y;
    ev.clientX = 5;
    target.dispatchEvent(ev);
    return ev;
  }
  const box = { top: 0, height: 20, bottom: 20, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} };
  it('題名順では線を出さず受けない / 自分で並べた順では出す', () => {
    for (const [sort, accepts] of [['title', false], ['manual', true]] as const) {
      const s = screen(['a', 'b', 'c', 'd'].map((t, i) => meta('n' + i, i + 1, t)));
      s.d.dispatch({ type: 'SET_ENTRY_SORT', sort });
      const target = s.row('n2');
      (target as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => box;
      const ev = drag('dragover', target, 'n0', 3);
      expect(ev.defaultPrevented).toBe(accepts);
      expect(target.hasAttribute('data-pkc-drop-edge')).toBe(accepts);
    }
  });
  it('題名順でも、フォルダの行へ落として中へ移す道は残る', () => {
    const s = screen([meta('F', 1, 'F', 'folder'), meta('n1', 2, 'n1')]);
    s.d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' });
    const target = s.row('F');
    (target as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => box;
    const ev = drag('dragover', target, 'n1', 3); // 上端でも「中へ入れる」
    expect(ev.defaultPrevented).toBe(true);
    expect(target.hasAttribute('data-pkc-drop-edge')).toBe(false);
  });
});
