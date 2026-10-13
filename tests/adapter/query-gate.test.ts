/** @vitest-environment happy-dom */
/**
 * 集計の面の描き直しの門(#1087)── **字が変わらない保存では表を組み直さない**。
 *
 * 保存の ack は `entryMetas` を必ず新しい Map に差し替える。参照で比べると(最大 3,000 行の)表を
 * 毎回組み直すので、門は**この面が読む物だけの指紋**(`QueryRenderer.metaSignature`)で比べる:
 * 組に載っている lid の題名と、在るか無いか。
 *
 * 🔑 観測点: 表の最初の行(`li`)の node。**組み直されれば捨てられて外れる**(`isConnected`)。
 * ⚠ 1 つの it で変えるのは 1 つだけ。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { QueryRenderer } from '../../src/adapter/ui/render/query';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 10,
    ...over,
  };
}

function setup() {
  const host = document.createElement('div');
  document.body.append(host);
  const view = new QueryRenderer(host);
  let state = {
    ...initialState,
    entryMetas: new Map<string, EntryMeta>([
      ['e1', meta('e1')],
      ['e2', meta('e2')],
      ['e3', meta('e3')], // 組に載っていないノート
    ]),
    order: ['e1', 'e2', 'e3'],
    queryKey: 'author',
    queryKeys: { keys: [{ key: 'author', count: 2 }], omittedKeys: 0, scanned: 2 },
    queryGroups: {
      groups: [{ value: '佐藤', total: 2, lids: ['e1', 'e2'] }],
      omittedGroups: 0,
      scanned: 2,
    },
  } as AppState;
  view.render(state);
  const row = (lid = 'e1'): HTMLElement =>
    host.querySelector<HTMLElement>(`li[data-pkc-entry="${lid}"]`)!;
  const first = row();
  expect(first, '表に行が出ている').not.toBeNull();
  const rebuilt = (): boolean => !first.isConnected;
  const renderWith = (lid: string, over: Partial<EntryMeta>): void => {
    const next = new Map(state.entryMetas);
    next.set(lid, { ...next.get(lid)!, ...over });
    state = { ...state, entryMetas: next };
    view.render(state);
  };
  const renderMetas = (entryMetas: Map<string, EntryMeta>): void => {
    state = { ...state, entryMetas };
    view.render(state);
  };
  const setGroups = (lids: string[]): void => {
    state = {
      ...state,
      queryGroups: {
        groups: [{ value: '田中', total: lids.length, lids }],
        omittedGroups: 0,
        scanned: lids.length,
      },
    };
    view.render(state);
  };
  return { row, setGroups, rebuilt, renderWith, renderMetas, metas: () => state.entryMetas };
}

describe('集計の面の門', () => {
  it('対照群: 題名が変われば組み直す(node が入れ替わる)', () => {
    const t = setup();
    t.renderWith('e1', {});
    expect(t.rebuilt()).toBe(false);
    t.renderWith('e1', { title: '別の題' });
    expect(t.rebuilt()).toBe(true);
  });

  it('読まない列 updatedAt だけ変わっても組み直さない', () => {
    const t = setup();
    t.renderWith('e1', { updatedAt: '2026-10-13T00:00:00Z' });
    expect(t.rebuilt()).toBe(false);
  });

  it('読まない列 bodyChars だけ変わっても組み直さない', () => {
    const t = setup();
    t.renderWith('e1', { bodyChars: 999 });
    expect(t.rebuilt()).toBe(false);
  });

  it('組に載っていないノートの題名が変わっても組み直さない', () => {
    const t = setup();
    t.renderWith('e3', { title: '別の題' });
    expect(t.rebuilt()).toBe(false);
  });

  it('組に載っているノートが消えると組み直す(消えたノートは出さない)', () => {
    const t = setup();
    const next = new Map(t.metas());
    next.delete('e2');
    t.renderMetas(next);
    expect(t.rebuilt()).toBe(true);
  });

  it('題名が空のノートが消えると組み直す(「消えた」と「題名が空」を取り違えない)', () => {
    const t = setup();
    t.renderWith('e2', { title: '' });
    const li = t.row('e2');
    const next = new Map(t.metas());
    next.delete('e2');
    t.renderMetas(next);
    expect(li.isConnected).toBe(false);
  });

  it('組を差し替えた後の、中身が同じ新しい Map では組み直さない(指紋の控えは組ごと)', () => {
    const t = setup();
    t.setGroups(['e2', 'e3']);
    const li = t.row('e2');
    t.renderWith('e2', {});
    expect(li.isConnected).toBe(true);
  });
});

describe('覚えていた項目のノートが無くなったとき(#1087 の見直し 2026-10-13)', () => {
  const base = (keys: AppState['queryKeys']): AppState =>
    ({
      ...initialState,
      queryKey: 'author',
      queryKeys: keys,
      queryGroups: { groups: [{ value: '(未設定)', total: 2, lids: [] }], omittedGroups: 0, scanned: 2 },
    }) as unknown as AppState;
  const emptyText = (state: AppState): string => {
    const host = document.createElement('div');
    document.body.append(host);
    new QueryRenderer(host).render(state);
    return host.querySelector('[data-pkc-field="query-empty"]')?.textContent ?? '';
  };

  it('🔴 もうどのノートにも無いなら、そう言って選び直させる(全部が「(未設定)」の 1 グループに見せない)', () => {
    expect(emptyText(base({ keys: [{ key: 'status', count: 2 }], omittedKeys: 0, scanned: 2 }))).toBe(
      '「author」を書いたノートがもうありません。上の「グループ化」で選び直してください',
    );
  });

  it('⚠ 項目を多い順に切っているときは言わない(切られただけかもしれない)/ 在るなら言わない', () => {
    expect(emptyText(base({ keys: [{ key: 'status', count: 2 }], omittedKeys: 3, scanned: 2 }))).toBe('');
    expect(emptyText(base({ keys: [{ key: 'author', count: 2 }], omittedKeys: 0, scanned: 2 }))).toBe('');
  });
});
