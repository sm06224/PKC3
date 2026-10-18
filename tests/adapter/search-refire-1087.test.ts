/** @vitest-environment happy-dom */
/**
 * 🔴 **語で絞ったまま本文を書き換えると、新しく当たるノートが一覧に出る**(#1087)。
 *
 * 直す前は、本文の検索を撃つのは語を打ったとき(`SET_ENTRY_FILTER`)だけだった。
 * 絞ったまま保存・取込・別タブの変更があっても撃ち直されず、新しく当たるノートは
 * 語を打ち直すまで出なかった(外れたノートも残った)。
 * 撃ち直しは書込の後ろ(`scanAfterWrites`)── 保存前の本文で走らない。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: lid === 'a' ? 1 : 2,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 10));
};

function setup() {
  const d = new Dispatcher();
  // 本物の検索と同じく「いまの本文」を引く(書込が着地した後の本文で当てる)
  const bodies = new Map<string, string>([
    ['a', ''],
    ['b', ''],
  ]);
  const asked: Array<{ q: string; sawB: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid: string) => bodies.get(lid) ?? '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; body: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      bodies.set(e.lid, e.body);
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    searchEntries: async (q: string) => {
      asked.push({ q, sawB: bodies.get('b') ?? '' });
      return {
        lids: [...bodies].filter(([, body]) => q !== '' && body.includes(q)).map(([l]) => l),
        truncated: false,
      };
    },
  } as unknown as Parameters<typeof connectStoreEffects>[1]);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] });
  const writeB = (): void => {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'みかんを買う' });
    d.dispatch({ type: 'COMMIT_EDIT' });
  };
  return { d, asked, writeB };
}

describe('絞ったまま書き換えたら、検索を撃ち直す', () => {
  it('🔴 語で絞った状態でノート b の本文に語が入ると、検索がもう一度撃たれ、b が当たりに入る', async () => {
    const { d, asked, writeB } = setup();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await flush();
    expect(asked.length, '前提: 語を打った回の 1 本').toBe(1);
    expect([...(d.getState().searchHits ?? [])], '前提: まだ当たらない').toEqual([]);

    writeB();
    await flush();
    expect(asked.length, '書込の後に撃ち直されていない').toBeGreaterThanOrEqual(2);
    expect(asked.at(-1)?.sawB, '保存前の本文で走っている(書込を追い越した)').toBe('みかんを買う');
    expect([...(d.getState().searchHits ?? [])], 'b が当たりに入っていない').toEqual(['b']);
  });

  it('対照群:語が空なら、書き換えても撃たない', async () => {
    const { d, asked, writeB } = setup();
    writeB();
    await flush();
    expect(d.getState().entryMetas.size, '前提: 台が動いている').toBe(2);
    expect(asked, '語が空なのに検索を撃った').toEqual([]);
  });

  it('🔴 取り込み・別のタブの変更(SYS_BOOTED)でも、絞っていれば撃ち直す', async () => {
    const { d, asked } = setup();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await flush();
    const n = asked.length;
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] });
    await flush();
    expect(asked.length, '取込の後に撃ち直されていない').toBe(n + 1);
  });

  it('🔴 探す画面の語があれば、その検索も撃ち直す(対照群:語が空なら撃たない)', () => {
    const { d } = setup();
    const events: string[] = [];
    d.onEvent((e) => void events.push(e.type));
    d.dispatch({ type: 'REFRESH_SEARCH' });
    expect(events, '語が空なのに撃った').not.toContain('REQUEST_SEARCH_DETAIL');
    expect(events, '左の絞り込みの語が空なのに撃った').not.toContain('REQUEST_SEARCH');
    d.dispatch({ type: 'SET_SEARCH_PAGE_QUERY', query: 'みかん' });
    events.length = 0;
    d.dispatch({ type: 'REFRESH_SEARCH' });
    expect(events).toContain('REQUEST_SEARCH_DETAIL');
  });
});

describe('飛んでいる検索と同じ語の撃ち直し', () => {
  it('🔴 検索が飛んでいる間に同じ語で撃ち直しが来ても捨てない(飛んでいる方は書込の前の本文で走っているかもしれない)', async () => {
    const d = new Dispatcher();
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    let calls = 0;
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '',
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      searchEntries: async () => {
        calls += 1;
        if (calls === 1) await first;
        return { lids: [], truncated: false };
      },
    } as unknown as Parameters<typeof connectStoreEffects>[1]);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await flush();
    expect(calls, '前提: 1 本目が飛んでいる').toBe(1);
    d.dispatch({ type: 'REFRESH_SEARCH' });
    release();
    await flush();
    expect(calls, '同じ語の撃ち直しを捨てた').toBe(2);
  });
});

describe('#タグ の問い合わせ(依頼 317)', () => {
  it('🔴 札の字(#タグ)は、本文検索ではなくタグ走査(smartScan)へ行き、返った lid が当たりになる', async () => {
    const d = new Dispatcher();
    const scanned: Array<{ lid: string; tags: readonly string[] }> = [];
    let searched = 0;
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '',
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      searchEntries: async () => {
        searched += 1;
        return { lids: ['a', 'b'], truncated: false };
      },
      smartScan: async (lid: string, q: { tags: readonly string[] }) => {
        scanned.push({ lid, tags: q.tags });
        return { lids: ['b'], total: 3 };
      },
    } as unknown as Parameters<typeof connectStoreEffects>[1]);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '#AI' });
    await flush();
    expect(searched, '本文の検索を撃った(題名・本文に AI を含むだけのノートが混ざる)').toBe(0);
    expect(scanned).toEqual([{ lid: '', tags: ['AI'] }]);
    expect([...(d.getState().searchHits ?? [])]).toEqual(['b']);
    expect(d.getState().searchHitsTruncated, '上限で切れたら「ほかにもあります」').toBe(true);
    // 対照群: ふつうの語は今までどおり本文を探す
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'AI' });
    await flush();
    expect(searched).toBe(1);
    expect(scanned.length).toBe(1);
  });
});
