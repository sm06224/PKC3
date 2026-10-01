/** @vitest-environment happy-dom */
/**
 * 🔴 右の列の「チェック項目 4 / 10 完了 (40%)」(#1216)。
 *
 * ⚠ 期待値は `formatTaskProgress` / `listTaskItems` を**呼ばずに**、本文から手で数えた値で書く
 *   (実装の呼び出しを写すと、数え方が変わっても同じ値で一致する)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import * as taskCount from '../../src/features/markdown/task-count';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const META = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'e1',
  title: 'ノート',
  archetype: 'text',
  entryOrder: 0,
  createdAt: '2026-08-04 23:30:00',
  updatedAt: '2026-08-04 23:30:00',
  status: null,
  date: null,
  archived: false,
  bodyChars: 100,
  ...over,
});

function stateOf(meta: EntryMeta, openBody?: string): AppState {
  return {
    ...initialState,
    phase: 'ready',
    selectedLid: meta.lid,
    entryMetas: new Map([[meta.lid, meta]]),
    openBody: openBody !== undefined ? { lid: meta.lid, body: openBody } : null,
  } as AppState;
}

function mount(): { region: HTMLElement; r: InspectorRenderer } {
  document.body.innerHTML = '';
  const region = document.createElement('div');
  document.body.append(region);
  return { region, r: new InspectorRenderer(region) };
}

const tasks = (region: HTMLElement): HTMLElement => {
  const el = region.querySelector<HTMLElement>('[data-pkc-field="inspector-tasks"]');
  if (!el) throw new Error('チェック項目の行が器に無い');
  return el;
};
const dtOf = (dd: HTMLElement): HTMLElement => dd.previousElementSibling as HTMLElement;

/** 10 件中 4 件が済み(手で数えた)。 */
const TEN = [
  '# 引っ越し',
  '',
  '- [x] 1',
  '- [x] 2',
  '- [x] 3',
  '- [x] 4',
  '- [ ] 5',
  '- [ ] 6',
  '- [ ] 7',
  '- [ ] 8',
  '- [ ] 9',
  '- [ ] 10',
].join('\n');

describe('右の列の「チェック項目」(#1216)', () => {
  it('🔴 10 件中 4 件済みなら「4 / 10 完了 (40%)」と、左の字「チェック項目」で出る', () => {
    const { region, r } = mount();
    r.render(stateOf(META(), TEN));
    const dd = tasks(region);
    expect(dd.hidden).toBe(false);
    expect(dd.textContent).toBe('4 / 10 完了 (40%)');
    expect(dtOf(dd).hidden).toBe(false);
    expect(dtOf(dd).textContent).toBe('チェック項目');
  });

  it('🔴 「文字数」の直下に並ぶ(行の順が崩れない)', () => {
    const { region, r } = mount();
    r.render(stateOf(META(), TEN));
    const stats = region.querySelector<HTMLElement>('[data-pkc-field="inspector-stats"]')!;
    expect(stats.nextElementSibling).toBe(dtOf(tasks(region)));
  });

  it('🔴 割合は切り捨て(199/200 を 100% と出さない / 2/3 は 66%)', () => {
    const { region, r } = mount();
    const rows = (done: number, total: number): string =>
      Array.from({ length: total }, (_, i) => (i < done ? '- [x] a' : '- [ ] a')).join('\n');
    r.render(stateOf(META(), rows(199, 200)));
    // 99.5% ── 四捨五入なら 100%(終わっていないのに終わって見える)
    expect(tasks(region).textContent).toBe('199 / 200 完了 (99%)');
    r.render(stateOf(META(), rows(1, 3)));
    expect(tasks(region).textContent).toBe('1 / 3 完了 (33%)');
    // 66.6…% ── 四捨五入なら 67%
    r.render(stateOf(META(), rows(2, 3)));
    expect(tasks(region).textContent).toBe('2 / 3 完了 (66%)');
  });

  it('全部済みで 100% / 1 件も済んでいなければ 0%', () => {
    const { region, r } = mount();
    r.render(stateOf(META(), '- [x] a\n- [x] b'));
    expect(tasks(region).textContent).toBe('2 / 2 完了 (100%)');
    r.render(stateOf(META(), '- [ ] a'));
    expect(tasks(region).textContent).toBe('0 / 1 完了 (0%)');
  });

  it('🔴 0 件のノートでは行ごと畳む(値と <dt> の両方)', () => {
    const { region, r } = mount();
    // 対照群: 先に出して、同じ器で 0 件に変えたとき畳み直すこと(最初から畳まれていたのではない)
    r.render(stateOf(META(), TEN));
    expect(tasks(region).hidden).toBe(false);
    r.render(stateOf(META(), '# 見出しだけ\n\nただの文章。\n- 普通の箇条書き'));
    expect(tasks(region).hidden).toBe(true);
    expect(dtOf(tasks(region)).hidden).toBe(true);
  });

  it('🔴 本文が読めていない(一覧を眺めているだけ / フォルダ)ときも畳む', () => {
    const { region, r } = mount();
    r.render(stateOf(META(), TEN));
    expect(tasks(region).hidden).toBe(false);
    r.render(stateOf(META())); // 本文を開いていない
    expect(tasks(region).hidden).toBe(true);
    expect(dtOf(tasks(region)).hidden).toBe(true);
    const f = mount();
    f.r.render(stateOf(META({ archetype: 'folder', bodyChars: null })));
    expect(tasks(f.region).hidden).toBe(true);
    expect(dtOf(tasks(f.region)).hidden).toBe(true);
  });

  it('🔴 開いている本文が別のノートのものなら数えない(選んだノートの行に、別の本文の数を出さない)', () => {
    const { region, r } = mount();
    const st = stateOf(META(), TEN);
    r.render(st);
    expect(tasks(region).hidden).toBe(false);
    r.render({ ...st, openBody: { lid: 'ほかのノート', body: TEN } } as AppState);
    expect(tasks(region).hidden).toBe(true);
    expect(dtOf(tasks(region)).hidden).toBe(true);
  });

  it('🔴 同じ本文を何度描き直しても、行の走査は 1 回だけ(本文を鍵に憶える)', () => {
    const spy = vi.spyOn(taskCount, 'listTaskItems');
    try {
      const { region, r } = mount();
      const st = stateOf(META(), TEN);
      r.render(st);
      r.render({ ...st });
      r.render(stateOf(META({ updatedAt: '2026-08-05 00:00:00' }), TEN));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(tasks(region).textContent).toBe('4 / 10 完了 (40%)');
      // 対照群: 本文が変われば数え直す(憶えっぱなしにしていない)
      r.render(stateOf(META(), TEN.replace('- [ ] 5', '- [x] 5')));
      expect(spy).toHaveBeenCalledTimes(2);
      expect(tasks(region).textContent).toBe('5 / 10 完了 (50%)');
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * ⚠ 画面は 1 ドットも変わらない(外しても畳みも数も同じ)── 守っているのは常駐メモリだけなので、
   *   憶えている器を直に見る(不可侵指示 2026-07-27「ライフサイクル終端での速やかな破棄」)。
   */
  it('🔴 本文を閉じたら、憶えていた本文を手放す(1 件ぶんの本文を常駐させない)', () => {
    const { r } = mount();
    const held = (): unknown => (r as unknown as { taskCount: unknown }).taskCount;
    r.render(stateOf(META(), TEN));
    expect(held(), '前提: 開いている間は憶えている').not.toBeNull();
    r.render(stateOf(META()));
    expect(held(), '閉じたのに本文を握っている').toBeNull();
  });

  it('🔴 かんばんの札と同じ数え方(ネストした項目も数える / 印の無い箇条書きは数えない)', () => {
    const { region, r } = mount();
    // 3 件(うち 1 件済み)。見出しの行・ふつうの箇条書きは数えない
    const body = ['# a', '- [x] 親', '  - [ ] 子', '- [ ] 別', '- 印の無い行'].join('\n');
    r.render(stateOf(META(), body));
    expect(tasks(region).textContent).toBe('1 / 3 完了 (33%)');
  });
});

/**
 * 🔴 押すと数が連動する(新しい配線は無い ── 本文が書き換わり、右の列が描き直される)。
 * ⚠ 実物の binder → dispatcher → 効果層 → 右の列、まで通す(reducer を直接叩かない)。
 */
describe('チェックを押すと右の列の数が動く(#1216)', () => {
  it('🔴 押すたびに「n / m」が連動し、もう一度押すと戻る', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15));
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => {
      center.render(s);
      inspector.render(s);
    });
    const store: Record<string, string> = { n1: '- [ ] a\n- [x] b\n- [ ] c' };
    const effects = connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async (lid) => store[lid] ?? null,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (e) => {
        store[e.lid] = e.body;
        return stubStamps();
      },
    });
    bindActions(root, d, { settle: () => effects.settled() });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [META({ lid: 'n1', bodyChars: store['n1']!.length })],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const tick = (ms = 20): Promise<void> => new Promise((res) => setTimeout(res, ms));
    await tick();
    const dd = (): HTMLElement => tasks(regions.inspector);
    expect(dd().textContent, '最初の数').toBe('1 / 3 完了 (33%)');
    root
      .querySelector<HTMLElement>('[data-pkc-action="toggle-task"][data-pkc-task-line="0"]')!
      .click();
    await tick();
    expect(store['n1']!.split('\n')[0], '本文が書き換わっていない(前提)').toBe('- [x] a');
    expect(dd().textContent, '押したのに右の列が古いまま').toBe('2 / 3 完了 (66%)');
    root
      .querySelector<HTMLElement>('[data-pkc-action="toggle-task"][data-pkc-task-line="0"]')!
      .click();
    await tick();
    expect(dd().textContent).toBe('1 / 3 完了 (33%)');
  });
});
