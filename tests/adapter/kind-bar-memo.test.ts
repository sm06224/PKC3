/** @vitest-environment happy-dom */
/**
 * 🔴 **種類の札は、数える材料が同じなら数え直さない**(#1087)。
 *
 * 帯は状態が動くたびに描く。直す前は、選ぶ・打つだけの回にも `order` の全ノートを回して種類を数えていた。
 *
 * ## 守る主張
 * 1. `order` / `entryMetas` / `filterQuery` / `searchHits` が同じ参照なら、数え直さない
 * 2. どれか 1 つが変われば数え直し、札の数も変わる
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { KindBarRenderer } from '../../src/adapter/ui/render/kind-bar';

const countSpy = vi.fn();
vi.mock('../../src/features/filter/kind-filter', async (orig) => {
  const real = await orig<typeof import('../../src/features/filter/kind-filter')>();
  return {
    ...real,
    kindCounts: (...a: Parameters<typeof real.kindCounts>) => {
      countSpy(...a);
      return real.kindCounts(...a);
    },
  };
});

function meta(lid: string, order: number, archetype: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const boot = (): AppState =>
  reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', 1, 'text'), meta('b', 2, 'folder'), meta('c', 3, 'attachment')],
    relations: [],
  }).state;

beforeEach(() => {
  document.body.textContent = '';
  countSpy.mockClear();
});

function mount() {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const bar = new KindBarRenderer(regions.sidebar);
  const chips = (): string[] =>
    [...regions.sidebar.querySelectorAll('[data-pkc-action="toggle-kind-filter"]')].map(
      (b) => b.textContent ?? '',
    );
  return { bar, chips };
}

describe('種類の札の数え直し(#1087)', () => {
  it('🔴 材料が同じ参照なら、選び直しても数え直さない', () => {
    const { bar, chips } = mount();
    let s = boot();
    bar.render(s, 'filer');
    expect(chips().length, '前提: 札が出ていない').toBeGreaterThan(1);
    countSpy.mockClear();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    bar.render(s, 'filer');
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    bar.render(s, 'filer');
    expect(countSpy).toHaveBeenCalledTimes(0);
  });

  it('🔴 材料が 1 つでも変われば数え直し、札が変わる', () => {
    const { bar, chips } = mount();
    const s = boot();
    bar.render(s, 'filer');
    const before = chips();
    countSpy.mockClear();
    const metas = new Map(s.entryMetas);
    metas.set('c', { ...metas.get('c')!, archetype: 'text' });
    bar.render({ ...s, entryMetas: metas }, 'filer');
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(chips()).not.toEqual(before);
    countSpy.mockClear();
    bar.render({ ...s, entryMetas: metas, filterQuery: 't-a' }, 'filer');
    expect(countSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 保存の ack(`ENTRY_STAMPED`)は一覧を新しい Map に差し替える。違うのが時刻だけなら数え直さない。
   * 対照群は直下(題名・種類が変われば数え直す)と、上の「材料が 1 つでも変われば」が持つ。
   */
  it('🔴 時刻だけが違う新しい一覧(保存の ack)では、数え直さず、札も変わらない', () => {
    const { bar, chips } = mount();
    const s = boot();
    bar.render(s, 'filer');
    const before = chips();
    countSpy.mockClear();
    const metas = new Map(s.entryMetas);
    metas.set('a', { ...metas.get('a')!, updatedAt: '2026-10-14 09:00:00' });
    bar.render({ ...s, entryMetas: metas }, 'filer');
    expect(countSpy).toHaveBeenCalledTimes(0);
    expect(chips()).toEqual(before);
  });

  it('🔴 対照群: 時刻の次に種類も変わった一覧では、前の時刻だけの差し替えを足場にせず数え直す', () => {
    const { bar, chips } = mount();
    const s = boot();
    bar.render(s, 'filer');
    // ① 時刻だけ(数え直さない)で控えが新しい一覧へ進む
    const stamped = new Map(s.entryMetas);
    stamped.set('a', { ...stamped.get('a')!, updatedAt: '2026-10-14 09:00:00' });
    bar.render({ ...s, entryMetas: stamped }, 'filer');
    countSpy.mockClear();
    // ② 次の一覧では種類が変わる ── 進めた控えとの比べで「違い」が見えること
    const retyped = new Map(stamped);
    retyped.set('c', { ...retyped.get('c')!, archetype: 'text' });
    const before = chips();
    bar.render({ ...s, entryMetas: retyped }, 'filer');
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(chips()).not.toEqual(before);
  });

  it('🔴 並び(order)だけが変わっても数え直す(一覧から外れたノートは数えない)', () => {
    const { bar } = mount();
    const s = boot();
    bar.render(s, 'filer');
    countSpy.mockClear();
    bar.render({ ...s, order: s.order.filter((l) => l !== 'c') }, 'filer');
    expect(countSpy).toHaveBeenCalledTimes(1);
  });

  it('🔴 本文の当たり(searchHits)だけが遅れて変わっても数え直す', () => {
    const { bar, chips } = mount();
    // 題名には当たらない語 ── 当たりが返る前は 0 件、返ったら本文が当たったノートが数えられる
    const s = { ...boot(), filterQuery: 'ほんぶんだけ' };
    bar.render(s, 'filer');
    countSpy.mockClear();
    bar.render({ ...s, searchHits: new Set(['a', 'c']) }, 'filer');
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(chips().length, '本文が当たったノートの札が出ていない').toBe(2);
  });
});
