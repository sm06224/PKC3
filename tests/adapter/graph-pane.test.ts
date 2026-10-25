/** @vitest-environment happy-dom */
/**
 * 🔴 **関係グラフの面**(#281 ①)。
 * 見るのは user が見て押せるもの:①節点は `select-entry` ②見方(全体 / 手先の数)が描画に効く
 * ③切ったら言う ④中央の器(別窓)でも左の列でも同じ ⑤退避先は左のタブ。
 */
import { describe, expect, it } from 'vitest';
import { GraphRenderer } from '../../src/adapter/ui/render/graph';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { BROWSE_MODES, homeTabOf, hasPaneHome } from '../../src/adapter/ui/render/browse-mode';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import { BROWSE_ICONS } from '../../src/adapter/ui/render/icons';

const meta = (lid: string) => ({ lid, title: `題${lid}`, archetype: 'text' }) as never;
const rel = (a: string, b: string) => ({ id: `${a}${b}`, fromLid: a, toLid: b, kind: 'semantic' }) as never;

function stateOf(extra: Partial<AppState>, lids = ['a', 'b', 'c', 'd']): AppState {
  return {
    ...initialState,
    entryMetas: new Map(lids.map((l) => [l, meta(l)])),
    relations: [rel('a', 'b'), rel('b', 'c'), rel('c', 'd')],
    selectedLid: 'a',
    ...extra,
  } as AppState;
}

function paint(state: AppState): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  new GraphRenderer(host).render(state);
  return host;
}
const nodes = (h: HTMLElement) => [...h.querySelectorAll<HTMLElement>('[data-pkc-action="select-entry"]')];

describe('関係グラフの面', () => {
  it('🔴 節点は押せる(select-entry)・選んでいるノートが分かる', () => {
    const h = paint(stateOf({}));
    expect(nodes(h).map((n) => n.getAttribute('data-pkc-entry'))).toEqual(['a', 'b', 'c']);
    expect(h.querySelector('[aria-current="true"]')?.getAttribute('data-pkc-entry')).toBe('a');
    expect(h.querySelectorAll('[data-pkc-field="graph-edge"]')).toHaveLength(2);
  });

  it('🔴 手先の数が描画に効く(既定 2 手 → 3 手で d が増える)', () => {
    expect(nodes(paint(stateOf({}))).length).toBe(3);
    const s = reduce(stateOf({}), { type: 'SET_GRAPH_VIEW', depth: 3 }).state;
    expect(s.graphView.depth).toBe(3);
    expect(nodes(paint(s)).map((n) => n.getAttribute('data-pkc-entry'))).toEqual(['a', 'b', 'c', 'd']);
    const h = paint(s);
    expect(h.querySelector('[data-pkc-graph-depth="3"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(h.querySelector('[data-pkc-graph-depth="2"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('🔴 全体: 選んでいなくても描き、手先のボタンは出ない', () => {
    const s = reduce(stateOf({ selectedLid: null }), { type: 'SET_GRAPH_VIEW', all: true }).state;
    const h = paint(s);
    expect(nodes(h)).toHaveLength(4);
    expect(h.querySelector('[data-pkc-graph-depth]')).toBeNull();
    expect(h.querySelector('[data-pkc-graph-scope="all"]')?.getAttribute('aria-pressed')).toBe('true');
    // 対照: 選んでいない + 「選んだノートから」は案内だけで図は出ない
    const h2 = paint(stateOf({ selectedLid: null }));
    expect(nodes(h2)).toHaveLength(0);
    expect(h2.querySelector('[data-pkc-field="graph-note"]')?.textContent).toContain('ノートを選ぶと');
  });

  it('🔴 上限を超えたら、そう言う(全体 61 件 → 60 件まで)', () => {
    const lids = Array.from({ length: 61 }, (_, i) => `n${i}`);
    const s = stateOf({ relations: lids.slice(1).map((l) => rel('n0', l)) }, lids);
    const all = reduce(s, { type: 'SET_GRAPH_VIEW', all: true }).state;
    const h = paint(all);
    expect(nodes(h)).toHaveLength(60);
    expect(h.querySelector('[data-pkc-field="graph-note"]')?.textContent).toMatch(/60 件までにしています.*61 件/);
  });

  it('関係が無いノートは「つながりがありません」', () => {
    const h = paint(stateOf({ relations: [] }));
    expect(nodes(h)).toHaveLength(0);
    expect(h.querySelector('[data-pkc-field="graph-note"]')?.textContent).toContain('つながり');
  });

  it('居場所(親子)は辺に出さない', () => {
    const h = paint(stateOf({ relations: [{ id: 'x', fromLid: 'a', toLid: 'b', kind: 'structural' } as never] }));
    expect(nodes(h)).toHaveLength(0);
  });

  it('本文のリンクは選んだノートの分だけ破線で出る', () => {
    const s = stateOf({
      relations: [],
      openBody: { lid: 'a', body: 'see [x](entry:b)' } as never,
    });
    const h = paint(s);
    const edges = [...h.querySelectorAll('[data-pkc-field="graph-edge"]')];
    expect(edges.map((x) => x.getAttribute('data-pkc-relation-kind'))).toEqual(['body-link']);
    expect(edges[0]!.getAttribute('stroke-dasharray')).not.toBeNull();
  });

  it('🔴 中央の器(view=graph)でも同じ図が出る', () => {
    const host = document.createElement('div');
    document.body.append(host);
    new CenterRouter(host).render({ ...stateOf({}), viewMode: 'graph' } as AppState);
    const pane = host.querySelector<HTMLElement>('[data-pkc-view-pane="graph"]');
    expect(pane?.hidden).toBe(false);
    expect(nodes(pane!)).toHaveLength(3);
  });

  it('退避先は左のタブ・タブと図案が在る', () => {
    expect(homeTabOf('graph')).toBe('graph');
    expect(hasPaneHome('graph')).toBe(true);
    expect(BROWSE_MODES).toContain('graph');
    expect(BROWSE_TABS.find((t) => t.mode === 'graph')?.label).toBe('グラフ');
    expect(BROWSE_ICONS.graph).toBeTruthy();
  });
});
