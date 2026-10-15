/**
 * 🔴 **もう戻っているノートを、ゴミ箱の版で上書きしない**(#1087)。
 * ⚠ ゴミ箱の画面を古いまま開いていた別のタブで「戻す」を押すと、その間に書き足した本文が、ゴミ箱へ入れたときの版で
 *   上書きされていた(このタブの一覧はまだ「無い」と思っているので、reducer の門を素通りする)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, TRASH_ALREADY_RESTORED_TEXT } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string): EntryMeta {
  return { lid, title: lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
}

function setup(disk: Record<string, string>) {
  const d = new Dispatcher();
  const persisted: string[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getRevision: async () => ({ body: 'ゴミ箱へ入れたときの本文', title: 't', archetype: 'text' }) as never,
    getBody: async (lid: string) => disk[lid] ?? null,
    getBodies: async () => [],
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; body: string }) => {
      persisted.push(e.lid);
      disk[e.lid] = e.body;
      return stubStamps();
    },
  } as never);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  return { d, persisted };
}

describe('ゴミ箱から戻す', () => {
  it('🔴 別のタブで先に戻されて書き足されていたら、上書きせずに理由を出す', async () => {
    const disk: Record<string, string> = { x: '戻した後に書き足した本文' };
    const s = setup(disk);
    s.d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'x', revId: 'r1' } as never);
    await tick();
    expect(s.persisted, '戻った本文をゴミ箱の版で上書きした').toEqual([]);
    expect(disk['x']).toBe('戻した後に書き足した本文');
    expect(s.d.getState().error).toBe(TRASH_ALREADY_RESTORED_TEXT);
  });
  it('対照群: まだゴミ箱に在るなら戻す', async () => {
    const disk: Record<string, string> = {};
    const s = setup(disk);
    s.d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'x', revId: 'r1' } as never);
    await tick();
    expect(s.persisted).toEqual(['x']);
  });
});
