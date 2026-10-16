/** @vitest-environment happy-dom */
/**
 * 🔴 **並べ替えの 2 行書きは、1 行目が落ちたら 2 行目を書かない**(#1087 の見直し)。
 *
 * ⚠ 交換は 2 行 1 組で、片側だけ disk に載ると順序が表現できない(同値の order が残る)。
 *   直す前は行ごとに enqueue していたので、1 行目が失敗しても 2 行目は書かれていた。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';

const meta = (lid: string, order: number): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup(first: 'reject' | 'null' | 'ok') {
  const d = new Dispatcher();
  const attempted: string[] = [];
  let calls = 0;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    reorderEntry: async (lid: string) => {
      attempted.push(lid);
      calls += 1;
      if (calls === 1 && first === 'reject') throw new Error('disk full');
      if (calls === 1 && first === 'null') return null;
      return stubStamps();
    },
  } as never);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2)], relations: [] });
  return { d, attempted };
}

describe('並べ替えの 2 行書き', () => {
  it('対照群: 1 行目が通れば 2 行とも書く', async () => {
    const { d, attempted } = setup('ok');
    d.dispatch({ type: 'MOVE_ENTRY_ORDER', lid: 'a', direction: 'down' });
    await tick();
    expect([...attempted].sort(), '2 行書かれていない(この test が何も見ていない)').toEqual(['a', 'b']);
  });

  it('🔴 1 行目の書込が失敗したら、2 行目は書かない(片側だけ disk に載らない)', async () => {
    const { d, attempted } = setup('reject');
    d.dispatch({ type: 'MOVE_ENTRY_ORDER', lid: 'a', direction: 'down' });
    await tick();
    expect(attempted, '1 行目が落ちたのに 2 行目を試した').toHaveLength(1);
    expect(d.getState().error ?? '').toContain('並べ替えを保存できませんでした');
  });

  it('🔴 1 行目のノートが見つからなくても、2 行目は書かない', async () => {
    const { d, attempted } = setup('null');
    d.dispatch({ type: 'MOVE_ENTRY_ORDER', lid: 'a', direction: 'down' });
    await tick();
    expect(attempted).toHaveLength(1);
    expect(d.getState().error ?? '').toContain('並べ替え: ノートが見つかりません');
  });
});
