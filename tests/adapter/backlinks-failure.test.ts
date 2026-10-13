/** @vitest-environment happy-dom */
/**
 * 🔴 **参照元を調べられなかったとき、「調べています…」のまま固めない**(#1087)。
 *
 * 直す前は、worker が投げても、古い worker で口が無くても、何も dispatch されず、
 * 右の列の「参照元」が永久に「調べています…」と出ていた。
 * ⚠ 「0 件(無し)」とは別物 ── 混ぜると「参照されていない」と嘘をつく。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import type { AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function wire(findBacklinks: unknown): Dispatcher {
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    findBacklinks,
  } as unknown as Parameters<typeof connectStoreEffects>[1]);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
  return d;
}

function paint(s: AppState): HTMLElement {
  const region = document.createElement('div');
  document.body.append(region);
  new InspectorRenderer(region).render(s);
  return region;
}
const text = (r: HTMLElement): string =>
  r.querySelector('[data-pkc-field="inspector-backlinks"]')!.textContent ?? '';

describe('参照元を調べられなかったとき (#1087)', () => {
  it('🔴 worker が投げたら、失敗として state に入り、画面は次の手を言う', async () => {
    const d = wire(async () => {
      throw new Error('boom');
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    expect(d.getState().backlinks?.failed, '失敗が state に入っていない').toBe(true);
    const t = text(paint(d.getState()));
    expect(t).toContain('参照元を調べられませんでした');
    expect(t).toContain('選び直す');
    expect(t, '「無し」と言ってはいけない').not.toBe('無し');
    expect(t).not.toContain('調べています');
  });

  it('🔴 古い worker(口が無い)でも、同じ', async () => {
    const d = wire(undefined);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    expect(d.getState().backlinks?.failed).toBe(true);
    expect(text(paint(d.getState()))).toContain('参照元を調べられませんでした');
  });

  it('⚠ 対照群 ── 成功すれば失敗の印は付かない', async () => {
    const d = wire(async () => ({ lids: ['n2'], truncated: false }));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    expect(d.getState().backlinks?.failed).toBeUndefined();
    expect(text(paint(d.getState()))).not.toContain('調べられませんでした');
  });

  it('🔴 遅れて届いた別のノートの失敗は捨てる / 選び直せば消えてもう一度頼む', () => {
    const base = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a'), meta('b')],
      relations: [],
    }).state;
    let s = reduce(base, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false, failed: true }).state;
    expect(s.backlinks, '別のノートの失敗を受け入れた').toBeNull();
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'b', lids: [], truncated: false, failed: true }).state;
    expect(s.backlinks?.failed).toBe(true);
    const r = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' });
    expect(r.state.backlinks).toBeNull();
    expect(r.events).toContainEqual({ type: 'REQUEST_BACKLINKS', lid: 'a' });
  });
});
