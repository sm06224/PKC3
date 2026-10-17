/** @vitest-environment happy-dom */
/**
 * 🔴 **表の行・列を消した直後に「元に戻す」を出す**(#1662 5。Gemini 裁定 = #1163 依頼 48 の 5 = A)。
 *
 * 直す前は × を押すとすぐ消え、追記・移動・ゴミ箱にある画面下の「元に戻す」が無かった(履歴から戻すしか無い)。
 * 見るのは 3 つ: ①消した回に知らせと戻す先の版が state に載る ②足した回には載らない
 * ③知らせの隣のボタンが `restore-revision`(消す前の版)を指す。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const meta: EntryMeta = {
  lid: 'n1',
  title: '見積',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
};
const BODY = '```csv\na,b\n1,2\n3,4\n```\n';

async function run(mode: 'add' | 'remove', what: 'row' | 'col') {
  const d = new Dispatcher();
  let disk = BODY;
  const revs: Array<{ id: string; rev_order: number }> = [{ id: 'r0', rev_order: 1 }];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    listRevisionMetas: async () => revs as never,
    getBody: async () => disk,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e: EntryUpsert, opts?: { checkpoint?: boolean }): Promise<EntryStamps> => {
      if (opts?.checkpoint === true) revs.push({ id: 'r1', rev_order: 2 });
      disk = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'SET_CSV_SHAPE', lid: 'n1', line: 2, openLine: '1,2', col: 0, what, mode });
  await tick();
  return { d, disk };
}

describe('表の行・列を消した直後の「元に戻す」(#1662 5)', () => {
  it('🔴 行を消した回は、知らせと消す前の版が載り、ボタンは restore-revision を指す', async () => {
    const { d, disk } = await run('remove', 'row');
    expect(disk, '消えていない(前提)').not.toContain('1,2');
    const s = d.getState();
    expect(s.notice).toBe('表の行を消しました');
    expect(s.restoreUndo).toEqual({ lid: 'n1', revId: 'r1', notice: '表の行を消しました' });
    const btn = document.createElement('button');
    expect(paintStatusUndo(btn, s, '表の行を消しました')).toBe(true);
    expect(btn.getAttribute('data-pkc-action')).toBe('restore-revision');
    expect(btn.getAttribute('data-pkc-rev-id')).toBe('r1');
    expect(btn.textContent).toBe('元に戻す');
    // 別の知らせが上書きしたら畳む
    expect(paintStatusUndo(btn, s, 'コピーしました')).toBe(false);
  });

  it('列を消した回は「列」と言う', async () => {
    const { d } = await run('remove', 'col');
    expect(d.getState().notice).toBe('表の列を消しました');
  });

  it('足した回は知らせも「元に戻す」も出さない(消した回だけ)', async () => {
    const { d } = await run('add', 'row');
    expect(d.getState().restoreUndo ?? null).toBeNull();
    expect(d.getState().notice).not.toBe('表の行を消しました');
  });
});
