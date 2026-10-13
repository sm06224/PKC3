/** @vitest-environment happy-dom */
/**
 * 🔴 **右の列は打つたびに描き直される ── 同じ入力なら計算を繰り返さない**(#1087)。
 *
 * 守る主張(面全体を飛ばすのではなく、**計算だけ**を省く。file 冒頭の dead click の戒めは生きている):
 * 1. 居場所(祖先の題名)は、選択 lid / `entryMetas` / `relations` の**どれかが変わったときだけ**解き直す
 * 2. つながりの図は、選択 lid / `entryMetas` / `relations` / 本文リンクの**どれかが変わったときだけ**組み直す。
 *    同じ入力なら DOM の node を使い回す(= 残した節点を押しても動く)
 * 3. 入力が変われば、新しい内容が出る(1 入力 1 test)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import * as tree from '../../src/features/relation/tree';

vi.mock('../../src/features/relation/tree', async (orig) => {
  const real = await orig<typeof import('../../src/features/relation/tree')>();
  return { ...real, getAncestorFolders: vi.fn(real.getAncestorFolders) };
});

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
function rel(id: string, fromLid: string, toLid: string, kind: string): Relation {
  return { id, fromLid, toLid, kind, createdAt: null, updatedAt: null };
}

const METAS = new Map<string, EntryMeta>([
  ['dir', meta('dir', '仕事', 'folder')],
  ['dir2', meta('dir2', '私用', 'folder')],
  ['a', meta('a', '本体')],
  ['b', meta('b', '相手B')],
  ['c', meta('c', '相手C')],
]);
const RELS: Relation[] = [rel('s1', 'dir', 'a', 'structural'), rel('r1', 'a', 'b', 'related')];

function stateOf(over: Partial<AppState>, body = 'text'): AppState {
  return {
    ...initialState,
    phase: 'ready',
    entryMetas: METAS,
    relations: RELS,
    selectedLid: 'a',
    openBody: { lid: 'a', body, baseline: body, persisted: body, diskAhead: false },
    ...over,
  } as AppState;
}

function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  const q = (sel: string): Element | null => regions.inspector.querySelector(sel);
  const nodes = (): string[] =>
    [...regions.inspector.querySelectorAll('[data-pkc-field="relation-map"] button')].map(
      (b) => b.textContent ?? '',
    );
  const folder = (): string =>
    q('[data-pkc-field="inspector-folder"]')?.textContent ?? '(行なし)';
  return { inspector, q, nodes, folder };
}

const calls = (): number => vi.mocked(tree.getAncestorFolders).mock.calls.length;

beforeEach(() => {
  vi.mocked(tree.getAncestorFolders).mockClear();
});

describe('居場所(祖先の題名)', () => {
  it('入力が同じなら解き直さない(本文だけが動く)', () => {
    const { inspector, folder } = setup();
    inspector.render(stateOf({}, 'a'));
    const first = calls();
    expect(first).toBeGreaterThan(0);
    expect(folder()).toBe('仕事');
    inspector.render(stateOf({}, 'ab'));
    inspector.render(stateOf({}, 'abc'));
    expect(calls()).toBe(first);
    expect(folder()).toBe('仕事');
  });

  it('relations の参照が変われば解き直し、新しい居場所を出す', () => {
    const { inspector, folder } = setup();
    inspector.render(stateOf({}));
    const before = calls();
    inspector.render(stateOf({ relations: [rel('s2', 'dir2', 'a', 'structural'), RELS[1]!] }));
    expect(calls()).toBeGreaterThan(before);
    expect(folder()).toBe('私用');
  });

  it('entryMetas の参照が変われば解き直し、新しい題名を出す', () => {
    const { inspector, folder } = setup();
    inspector.render(stateOf({}));
    const before = calls();
    const metas = new Map(METAS).set('dir', meta('dir', '仕事(改)', 'folder'));
    inspector.render(stateOf({ entryMetas: metas }));
    expect(calls()).toBeGreaterThan(before);
    expect(folder()).toBe('仕事(改)');
  });

  it('選択 lid が変われば解き直す', () => {
    const { inspector, folder } = setup();
    inspector.render(stateOf({}));
    const before = calls();
    inspector.render(stateOf({ selectedLid: 'b', openBody: null }));
    expect(calls()).toBeGreaterThan(before);
    expect(folder()).toBe('ルート');
  });
});

describe('つながりの図', () => {
  const figure = (q: (s: string) => Element | null): Element | null =>
    q('[data-pkc-field="relation-map"]');

  it('入力が同じなら組み直さない(node を使い回す)', () => {
    const { inspector, q, nodes } = setup();
    inspector.render(stateOf({}, 'a'));
    const fig = figure(q);
    expect(fig).not.toBeNull();
    expect(nodes()).toEqual(['本体', '相手B']);
    inspector.render(stateOf({}, 'ab'));
    expect(figure(q)).toBe(fig);
    expect(nodes()).toEqual(['本体', '相手B']);
  });

  it('relations の参照が変われば組み直し、新しい相手を出す', () => {
    const { inspector, q, nodes } = setup();
    inspector.render(stateOf({}));
    const fig = figure(q);
    inspector.render(stateOf({ relations: [...RELS, rel('r2', 'a', 'c', 'related')] }));
    expect(figure(q)).not.toBe(fig);
    expect(nodes()).toContain('相手C');
  });

  it('entryMetas の参照が変われば組み直し、新しい題名を出す', () => {
    const { inspector, q, nodes } = setup();
    inspector.render(stateOf({}));
    const fig = figure(q);
    inspector.render(stateOf({ entryMetas: new Map(METAS).set('b', meta('b', '相手B(改)')) }));
    expect(figure(q)).not.toBe(fig);
    expect(nodes()).toContain('相手B(改)');
  });

  it('本文のリンクが増えれば組み直し、新しい相手を出す', () => {
    const { inspector, q, nodes } = setup();
    inspector.render(stateOf({}, 'text'));
    const fig = figure(q);
    inspector.render(stateOf({}, 'text [c](entry:c)'));
    expect(figure(q)).not.toBe(fig);
    expect(nodes()).toContain('相手C');
  });

  it('選択 lid が変われば組み直し、新しい中心を出す', () => {
    const { inspector, q, nodes } = setup();
    inspector.render(stateOf({}));
    const fig = figure(q);
    inspector.render(stateOf({ selectedLid: 'b', openBody: null }));
    expect(figure(q)).not.toBe(fig);
    expect(nodes()[0]).toBe('相手B');
  });

  it('器が作り直されたら(形が変わる)、同じ入力でも組み直す', () => {
    const { inspector, q, nodes } = setup();
    inspector.render(stateOf({}));
    inspector.render(stateOf({ selectedLid: null, openBody: null }));
    inspector.render(stateOf({}));
    expect(nodes()).toEqual(['本体', '相手B']);
    expect(figure(q)).not.toBeNull();
  });
});
