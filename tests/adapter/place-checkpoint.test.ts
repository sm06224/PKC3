/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋・線を消す回と、テンプレートでまとめて置く回は、前の版を履歴に積む**(#1087 の見直し 2026-10-14)。
 *
 * 直す前は履歴に積むのが task-run / 表の行列の削除 / 情報が落ちる形変えだけで、付箋を消すと
 * 中の字が、線を消すと色・太さ・矢じりの設定が、本文からも履歴からも消えた。**両側**を見る
 * (積む回では積む / 積まない回(1 枚だけ置く・動かす)では積まない)。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const meta: EntryMeta = {
  lid: 'n1',
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
};

const BOARD = [
  ':::format{#p1 .pkc-place x=10 y=10 w=200 h=100}',
  '大事な字',
  ':::',
  '',
  ':::format{#p2 .pkc-place x=300 y=10 w=200 h=100}',
  ':::',
  '',
  ':::format{.pkc-line from=p1 to=p2 stroke=#ff0000 arrow=end}',
  ':::',
  '',
].join('\n');

async function run(
  body: string,
  action: Dispatchable,
): Promise<{ checkpoint: boolean | undefined; disk: string; count: number }> {
  const d = new Dispatcher();
  let disk = body;
  const persisted: Array<{ checkpoint?: boolean }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => disk,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e: EntryUpsert, opts?: { checkpoint?: boolean }): Promise<EntryStamps> => {
      persisted.push({ checkpoint: opts?.checkpoint });
      disk = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  d.dispatch(action);
  await tick();
  return { checkpoint: persisted[0]?.checkpoint, disk, count: persisted.length };
}

describe('付箋・線の書換と履歴(#1087)', () => {
  it('🔴 付箋を消す回は、前の版を積む', async () => {
    const r = await run(BOARD, { type: 'REMOVE_PLACE', lid: 'n1', line: 0 });
    expect(r.count, '書込が届いていない(前提)').toBe(1);
    expect(r.disk, '付箋が消えていない(前提)').not.toContain('大事な字');
    expect(r.checkpoint, '中の字が消えるのに履歴に積んでいない').toBe(true);
  });

  it('🔴 線を消す回は、前の版を積む', async () => {
    const r = await run(BOARD, { type: 'REMOVE_PLACE_LINE', lid: 'n1', line: 7 });
    expect(r.count, '書込が届いていない(前提)').toBe(1);
    expect(r.disk, '線が消えていない(前提)').not.toContain('pkc-line');
    expect(r.checkpoint, '線の設定が消えるのに履歴に積んでいない').toBe(true);
  });

  it('🔴 テンプレートでまとめて置く回は、前の版を積む', async () => {
    const r = await run(BOARD, { type: 'ADD_PLACE', lid: 'n1', x: 30, y: 50, template: 'flow3' });
    expect(r.count, '書込が届いていない(前提)').toBe(1);
    expect(r.disk.split('.pkc-place').length, '付箋が増えていない(前提)').toBeGreaterThan(3);
    expect(r.checkpoint, 'まとめて置くのに履歴に積んでいない').toBe(true);
  });

  it('1 枚だけ置く回は積まない(置いた物は「この付箋を消す」で戻せる)', async () => {
    const r = await run(BOARD, { type: 'ADD_PLACE', lid: 'n1', x: 30, y: 50 });
    expect(r.count, '書込が届いていない(前提)').toBe(1);
    expect(r.disk, '付箋が増えていない(前提)').not.toBe(BOARD);
    expect(r.checkpoint).not.toBe(true);
  });

  it('付箋を動かす回は積まない(履歴を動かした数だけ伸ばさない)', async () => {
    const r = await run(BOARD, { type: 'MOVE_PLACE', lid: 'n1', line: 0, x: 50, y: 60 });
    expect(r.count, '書込が届いていない(前提)').toBe(1);
    expect(r.disk, '動いていない(前提)').not.toBe(BOARD);
    expect(r.checkpoint).not.toBe(true);
  });
});
