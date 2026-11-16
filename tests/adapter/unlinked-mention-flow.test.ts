/** @vitest-environment happy-dom */
/**
 * 🔴 **リンクのない言及の流れ**(#1966 4-1)── 選ぶ → 引く → 右の列に出る → 「リンクにする」→ 包んで引き直す。
 *
 * - 参照元と同じ契機(選択)で引き、別のノートの答えは捨てる
 * - 0 件・まだ引いていない・引けない版では行ごと出さない(右の列は混んでいる)
 * - 「リンクにする」は押した行の相手を、いま選んでいるノートへ包む。編集中は理由を言って止まる
 * - 包んだら開いている本文を差し替え、知らせを出し、参照元と言及を引き直す
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

const meta = (lid: string, title = 't-' + lid): EntryMeta => ({
  lid,
  title,
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
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Calls {
  mentions: string[];
  backlinks: string[];
  link: Array<[string, string]>;
}

function wire(opts: { mentions?: unknown; link?: unknown } = {}) {
  const calls: Calls = { mentions: [], backlinks: [], link: [] };
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
    findBacklinks: async (lid: string) => {
      calls.backlinks.push(lid);
      return { lids: [], truncated: false };
    },
    ...('mentions' in opts
      ? { findUnlinkedMentions: opts.mentions }
      : {
          findUnlinkedMentions: async (lid: string) => {
            calls.mentions.push(lid);
            return lid === 'n1' ? { items: [{ lid: 'n2', count: 3 }], truncated: false } : { items: [], truncated: false };
          },
        }),
    ...('link' in opts
      ? { linkMentions: opts.link }
      : {
          linkMentions: async (lid: string, sourceLid: string) => {
            calls.link.push([lid, sourceLid]);
            return { wrote: { lid: sourceLid, body: '[会議](entry:n1)', stamps: stubStamps() }, links: 3 };
          },
        }),
  } as unknown as Parameters<typeof connectStoreEffects>[1]);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', '会議'), meta('n2', '議事録'), meta('n3')],
    relations: [],
  });
  return { d, calls };
}

function paint(s: AppState): HTMLElement {
  const region = document.createElement('div');
  document.body.append(region);
  new InspectorRenderer(region).render(s);
  return region;
}
const rowOf = (r: HTMLElement): HTMLElement => r.querySelector<HTMLElement>('[data-pkc-field="inspector-mentions"]')!;

describe('引いて、右の列に出す', () => {
  it('🔴 選ぶと引き、相手の名前・箇所の数・「リンクにする」が出る', async () => {
    const { d, calls } = wire();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    expect(calls.mentions).toEqual(['n1']);
    expect(d.getState().mentions).toEqual({ lid: 'n1', items: [{ lid: 'n2', count: 3 }], truncated: false });
    const row = rowOf(paint(d.getState()));
    expect(row.hidden).toBe(false);
    expect((row.previousElementSibling as HTMLElement).hidden, '見出し(dt)が隠れたまま').toBe(false);
    expect(row.querySelector('[data-pkc-field="inspector-mention-note"]')?.textContent).toBe('議事録');
    expect(row.querySelector('[data-pkc-field="inspector-mention-count"]')?.textContent).toBe('3 か所');
    const make = row.querySelector<HTMLElement>('[data-pkc-action="link-mentions"]')!;
    expect(make.getAttribute('data-pkc-entry')).toBe('n2');
    expect(make.textContent).toBe('リンクにする');
  });

  it('⚠ 0 件・まだ引いていない・引けない版では行ごと出さない', async () => {
    const none = wire();
    none.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n3' });
    await flush();
    expect(rowOf(paint(none.d.getState())).hidden, '0 件なのに行が出ている').toBe(true);

    const old = wire({ mentions: undefined });
    old.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(rowOf(paint(old.d.getState())).hidden, 'まだ引いていないのに行が出ている').toBe(true);
    await flush();
    expect(old.d.getState().mentions).toBeNull();
    expect(rowOf(paint(old.d.getState())).hidden).toBe(true);

    const broken = wire({
      mentions: async () => {
        throw new Error('boom');
      },
    });
    broken.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    expect(rowOf(paint(broken.d.getState())).hidden, '引けなかったのに行が出ている').toBe(true);
    expect(broken.d.getState().backlinks?.failed, '言及の失敗で参照元まで失敗にした').toBeUndefined();
  });

  it('⚠ 選択が動いたら前のノートの答えはその場で捨て、遅れて着いた別のノートの答えも捨てる', async () => {
    const { d } = wire();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n3' });
    expect(d.getState().mentions, '前のノートの言及が残った').toBeNull();
    d.dispatch({ type: 'MENTIONS_LOADED', lid: 'n1', items: [{ lid: 'n2', count: 1 }], truncated: false });
    expect(d.getState().mentions, '遅れて着いた別のノートの答えを入れた').toBeNull();
  });
});

describe('「リンクにする」', () => {
  function mount() {
    resetAppDialogForTest();
    document.body.innerHTML = '';
    const w = wire();
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const map = new Map<string, string>();
    bindActions(
      root,
      w.d,
      { showStatus: () => {} },
      new KeymapStore({
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      }),
    );
    const press = (): void => {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'link-mentions');
      b.setAttribute('data-pkc-entry', 'n2');
      root.append(b);
      b.click();
    };
    return { ...w, press };
  }

  it('🔴 押した行の相手を、いま選んでいるノートへ包み、本文を差し替えて知らせ、参照元と言及を引き直す', async () => {
    const { d, calls, press } = mount();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    calls.backlinks.length = 0;
    calls.mentions.length = 0;
    const seen: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: Parameters<typeof d.dispatch>[0]) => {
      if (a.type === 'ENTRY_BODY_REFRESHED') seen.push(`${a.lid}:${a.body}`);
      return orig(a);
    }) as typeof d.dispatch;
    press();
    await flush();
    expect(calls.link).toEqual([['n1', 'n2']]);
    expect(seen, '包んだ本文で、開いている本文を差し替えていない').toEqual(['n2:[会議](entry:n1)']);
    expect(calls.backlinks, '包んだ後に参照元を引き直していない').toEqual(['n1']);
    expect(calls.mentions, '包んだ後に言及を引き直していない').toEqual(['n1']);
    const s = d.getState();
    expect(s.notice ?? '').toContain('「議事録」の 3 か所をリンクにしました');
  });

  it('⚠ 編集中は理由を言って止まる(本文を書き換えない)', async () => {
    const { d, calls, press } = mount();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await flush();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase).toBe('editing');
    press();
    await flush();
    expect(calls.link, '編集中に包んだ').toEqual([]);
    expect(d.getState().error ?? '').toContain('リンクにしてください');
  });
});
