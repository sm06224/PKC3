/** @vitest-environment happy-dom */
/**
 * 🔴 **改名の effect が、ほかのノートのリンクの字を直し、1 行知らせる**(#1163 依頼 177、#1648)。
 *
 * 守る主張:
 * 1. 改名(`RENAME_ENTRY_TITLE`)は旧い題名・新しい題名を worker の口へ渡す
 * 2. 書き換えたノートがあれば「N 件のノートのリンクの字も更新しました」と 1 行知らせ、開いている本文は差し替える
 * 3. 書き換えたノートが 0 件なら、知らせない
 * 4. 編集中のノートは `skipLids` に入る
 * 5. 字の書き換えが落ちても、改名の失敗とは言わない(「名前は変えましたが…」)
 * 6. 題名が変わらない改名は口を呼ばない
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (lid: string, title: string): EntryMeta => ({
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
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Call {
  lid: string;
  oldTitle: string;
  newTitle: string;
  skipLids: readonly string[];
}

function wire(result: (c: Call) => Promise<{ wrote: Array<{ lid: string; body: string; stamps: ReturnType<typeof stubStamps> }>; links: number }>) {
  const calls: Call[] = [];
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
    renameLinkTexts: (c: Call) => {
      calls.push(c);
      return result(c);
    },
  } as unknown as Parameters<typeof connectStoreEffects>[1]);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', '旧い題名'), meta('n2', '参照元')],
    relations: [],
  });
  return { d, calls };
}

describe('改名 → ほかのノートのリンクの字', () => {
  it('旧い題名と新しい題名を渡し、書き換えた件数を 1 行で知らせる', async () => {
    const { d, calls } = wire(async () => ({
      wrote: [
        { lid: 'n2', body: '[新しい題名](entry:n1)\n', stamps: stubStamps() },
        { lid: 'n3', body: '[新しい題名](entry:n1)\n', stamps: stubStamps() },
      ],
      links: 3,
    }));
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'n1', title: '新しい題名' });
    await flush();
    expect(calls).toEqual([{ lid: 'n1', oldTitle: '旧い題名', newTitle: '新しい題名', skipLids: [] }]);
    expect(d.getState().notice).toContain('2 件のノートのリンクの字も更新しました');
  });

  it('書き換えたノートが 0 件なら知らせない', async () => {
    const { d, calls } = wire(async () => ({ wrote: [], links: 0 }));
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'n1', title: '新しい題名' });
    await flush();
    expect(calls).toHaveLength(1);
    expect(d.getState().notice ?? '').not.toContain('リンクの字');
  });

  it('編集中のノートは skipLids に入る', async () => {
    const { d, calls } = wire(async () => ({ wrote: [], links: 0 }));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    await flush();
    d.dispatch({ type: 'START_EDIT' });
    await flush();
    expect(d.getState().phase, '前提: 編集中になっている').toBe('editing');
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'n1', title: '新しい題名' });
    await flush();
    expect(calls[0]?.skipLids).toEqual(['n2']);
  });

  it('字の書き換えが落ちても、改名の失敗とは言わない', async () => {
    const { d } = wire(async () => {
      throw new Error('boom');
    });
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'n1', title: '新しい題名' });
    await flush();
    const err = d.getState().error ?? '';
    expect(err).toContain('名前は変えましたが');
    expect(err).not.toContain('名前を保存できませんでした');
  });

  it('題名が変わらない改名は口を呼ばない', async () => {
    const { d, calls } = wire(async () => ({ wrote: [], links: 0 }));
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'n1', title: '旧い題名' });
    await flush();
    expect(calls).toHaveLength(0);
  });
});
