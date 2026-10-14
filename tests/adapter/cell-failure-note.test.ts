/** @vitest-environment happy-dom */
/**
 * 🔴 **表のセルの確定が失敗したとき、打った字が知らせに入る**(#1087 の見直し 2026-10-14)。
 *
 * 欄は確定した時点で閉じるので(`binder.ts` の `commit`)、知らせに字が無いと
 * 打った字は画面のどこにも残らない。欄に開き直す道ではなく、知らせに入れる道を取った
 * (表の塊は往復で差し替わり、失敗した回は差し替わらない ── 開き直す先の升の保証が無い)。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
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

async function failWith(value: string): Promise<{ error: string; wrote: boolean }> {
  const d = new Dispatcher();
  let wrote = false;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    // 表ではない本文 ── 行番号が表を指さないので、書換は断られる
    getBody: async () => 'ただの文\n',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (): Promise<EntryStamps> => {
      wrote = true;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'SET_CSV_CELL', lid: 'n1', line: 0, col: 0, value });
  await tick();
  return { error: d.getState().error ?? '', wrote };
}

describe('セルの確定が失敗したとき、打った字を知らせる', () => {
  it('🔴 断られた回の知らせに、打った字が入る(何も書かれていないことも見る)', async () => {
    const r = await failWith('こんにちは');
    expect(r.wrote, '前提が崩れている(書いてしまった)').toBe(false);
    expect(r.error).toContain('本文が変わっているため反映できませんでした');
    expect(r.error).toContain('入力した『こんにちは』は反映されていません');
  });

  it('長い字は頭だけ(30 字 + …)', async () => {
    const r = await failWith('あ'.repeat(31));
    expect(r.error).toContain(`『${'あ'.repeat(30)}…』`);
    expect(r.error).not.toContain('あ'.repeat(31));
  });

  it('空にした回は、失われる字が無いので付けない', async () => {
    const r = await failWith('');
    expect(r.error).toContain('反映できませんでした');
    expect(r.error).not.toContain('入力した');
  });
});
