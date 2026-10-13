/** @vitest-environment happy-dom */
/**
 * 2 ペインの描き直しの門(#1087)── **字が変わらない保存では組み直さない**。
 *
 * 保存の ack は `entryMetas` を必ず新しい Map に差し替える(`updatedAt` が動く)。参照で比べると
 * 毎回 `filerRows` を 2 ペイン分回すので、門は**この面が読む列だけの指紋**
 * (`DualFilerRenderer.metaSignature`)で比べる。
 *
 * 🔑 観測点: 件数の行(`dual-count`)に目印の字を書き、**描き直しが走れば上書きされる**ことを使う
 * (描き直す側は件数の行を `text` と比べて書く ── 目印は `text` と違うので消える)。
 * ⚠ 1 つの it で変える列は **1 つだけ**(複数まとめると、1 列を外す変異が別の列に救われる)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';

const MARK = 'ここは組み直されていない';

function meta(lid: string, order: number, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T10:00:00Z',
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: 10 * order,
    ...over,
  };
}
const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

function setup(sort: AppState['entrySort'] = 'manual') {
  const host = document.createElement('div');
  document.body.append(host);
  const view = new DualFilerRenderer(host);
  const metas = [
    meta('f1', 1, { archetype: 'folder', bodyChars: null }),
    meta('a', 2),
    meta('b', 3),
    meta('c', 4),
  ];
  let state = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas,
    relations: [rel('r1', 'f1', 'c')],
  }).state;
  state = { ...state, entrySort: sort };
  view.render(state);
  const counts = (): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>('[data-pkc-field="dual-count"]'),
  ];
  expect(counts().length, '2 ペイン分の件数の行').toBe(2);
  const arm = (): void => {
    for (const el of counts()) el.textContent = MARK;
  };
  const rebuilt = (): boolean => counts().every((el) => el.textContent !== MARK);
  const untouched = (): boolean => counts().every((el) => el.textContent === MARK);
  /** 1 件だけ差し替えた新しい Map で描く(= 保存の ack と同じ形)。 */
  const renderWith = (lid: string, over: Partial<EntryMeta>): void => {
    const next = new Map(state.entryMetas);
    next.set(lid, { ...next.get(lid)!, ...over });
    state = { ...state, entryMetas: next };
    view.render(state);
  };
  const setSort = (sort: AppState['entrySort']): void => {
    state = { ...state, entrySort: sort };
    view.render(state);
  };
  const renderAll = (next: Map<string, EntryMeta>): void => {
    state = { ...state, entryMetas: next };
    view.render(state);
  };
  return { arm, rebuilt, untouched, renderWith, renderAll, setSort, metas: () => state.entryMetas };
}

describe('2 ペインの門', () => {
  it('対照群: 目印は描き直しで消える(中身が同じ新しい Map の再描画では消えない)', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', {});
    expect(t.untouched()).toBe(true);
    t.renderWith('a', { title: '別の題' });
    expect(t.rebuilt()).toBe(true);
  });

  it('読まない列 createdAt だけ変わっても描き直さない', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { createdAt: '2025-01-01T00:00:00Z' });
    expect(t.untouched()).toBe(true);
  });

  it('読まない列 status だけ変わっても描き直さない', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { status: 'done' });
    expect(t.untouched()).toBe(true);
  });

  it('読まない列 date だけ変わっても描き直さない', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { date: '2026-08-25' });
    expect(t.untouched()).toBe(true);
  });

  it('読まない列 archived だけ変わっても描き直さない', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { archived: true });
    expect(t.untouched()).toBe(true);
  });

  it('同じ日の updatedAt(日付の字が変わらない保存)では描き直さない', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { updatedAt: '2026-01-01T10:30:00Z' });
    expect(t.untouched()).toBe(true);
  });

  it('title が変わると描き直す', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { title: '名前を変えた' });
    expect(t.rebuilt()).toBe(true);
  });

  it('archetype が変わると描き直す', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { archetype: 'todo' });
    expect(t.rebuilt()).toBe(true);
  });

  it('entryOrder が変わると描き直す(手動順が読む)', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { entryOrder: 9 });
    expect(t.rebuilt()).toBe(true);
  });

  it('bodyChars が変わると描き直す(大きさの列が読む)', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { bodyChars: 12345 });
    expect(t.rebuilt()).toBe(true);
  });

  it('別の日の updatedAt(日付の字が変わる)だと描き直す', () => {
    const t = setup();
    t.arm();
    t.renderWith('a', { updatedAt: '2026-01-03T10:00:00Z' });
    expect(t.rebuilt()).toBe(true);
  });

  it('「更新」順では、同じ日の updatedAt でも描き直す(生の値が並びを決める)', () => {
    const t = setup('updated');
    t.arm();
    t.renderWith('a', { updatedAt: '2026-01-01T10:30:00Z' });
    expect(t.rebuilt()).toBe(true);
  });

  it('lid だけが入れ替わる(他の列は同じ)と描き直す', () => {
    const t = setup();
    t.arm();
    // ⚠ 位置は同じまま lid だけ替える(並びの違いに救わせない)
    const next = new Map(
      [...t.metas()].map(([k, v]): [string, EntryMeta] =>
        k === 'b' ? ['z', { ...v, lid: 'z' }] : [k, v],
      ),
    );
    t.renderAll(next);
    expect(t.rebuilt()).toBe(true);
  });

  it('並びを「更新」順へ替えた直後の、中身が同じ新しい Map では描き直さない(指紋の控えは向きごと)', () => {
    const t = setup();
    t.setSort('updated');
    t.arm();
    t.renderWith('a', {});
    expect(t.untouched()).toBe(true);
  });
});
