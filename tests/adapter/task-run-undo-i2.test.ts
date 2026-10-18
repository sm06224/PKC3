/** @vitest-environment happy-dom */
/**
 * 🔴 **「このリストをすべて未完了に戻す」の直後に、件数と「元に戻す」を出す**
 * (台帳 #1852 I2 / 依頼 114-2。Gemini 回答 = 推薦 A)。
 *
 * 直す前は押しても画面の下に何も出ず、戻す道はノートの履歴だけで、その案内も無かった。
 * 見るのは 4 つ: ①戻した回に知らせ(「N 件を未完了に戻しました」)と戻す先の版が載る
 * ②ボタンは `restore-revision`(押す前の版)を指し、字は「元に戻す」③何も動かない回には出さない(対照群)。「完了にする」の回も出す(残りの分)
 * ④繰り返しの行を飛ばした数は同じ 1 行で言う。
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
  title: '買い物',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
};

async function run(body: string, to: 'done' | 'open') {
  const d = new Dispatcher();
  let disk = body;
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
  const lines = body.split('\n').flatMap((l, i) => (/^- \[[ x]\]/.test(l) ? [i] : []));
  d.dispatch({ type: 'SET_TASK_RUN', lid: 'n1', lines, openLines: lines.map((i) => body.split('\n')[i]!), to });
  await tick();
  return { d, disk: () => disk };
}

describe('「すべて未完了に戻す」の直後の「元に戻す」(依頼 114-2)', () => {
  const DONE = '- [x] 牛乳\n- [x] 卵\n- [ ] パン\n';

  it('🔴 戻した回は件数を言い、押す前の版が載り、ボタンは restore-revision を指す', async () => {
    const { d, disk } = await run(DONE, 'open');
    expect(disk(), '戻っていない(前提)').toBe('- [ ] 牛乳\n- [ ] 卵\n- [ ] パン\n');
    const s = d.getState();
    expect(s.notice).toBe('2 件を未完了に戻しました');
    expect(s.restoreUndo).toEqual({ lid: 'n1', revId: 'r1', notice: '2 件を未完了に戻しました' });
    const btn = document.createElement('button');
    expect(paintStatusUndo(btn, s, '2 件を未完了に戻しました')).toBe(true);
    expect(btn.getAttribute('data-pkc-action')).toBe('restore-revision');
    expect(btn.getAttribute('data-pkc-rev-id')).toBe('r1');
    expect(btn.textContent).toBe('元に戻す');
    // 別の知らせが上書きしたら畳む
    expect(paintStatusUndo(btn, s, 'コピーしました')).toBe(false);
  });

  it('繰り返しの行を飛ばした数も、同じ 1 行で言う', async () => {
    const { d } = await run('- [x] 牛乳\n- [x] ゴミ出し @2026-09-07 毎週\n', 'open');
    const s = d.getState();
    expect(s.notice).toBe('1 件を未完了に戻しました / 1 件は繰り返しなので触りませんでした');
    expect(s.restoreUndo?.revId).toBe('r1');
  });

  it('対照群:何も動かない回(もう全部未完了)には「元に戻す」を出さない', async () => {
    const { d } = await run('- [ ] 牛乳\n- [ ] 卵\n', 'open');
    expect(d.getState().restoreUndo ?? null).toBeNull();
    expect(d.getState().notice).toBe('すべて未完了になっています');
  });

  it('🔴 「すべて完了にする」の回も、件数と「元に戻す」を出す(114-2 の残り。まとめて変わる操作は同じ)', async () => {
    const { d, disk } = await run('- [ ] 牛乳\n- [ ] 卵\n- [x] パン\n', 'done');
    expect(disk()).toBe('- [x] 牛乳\n- [x] 卵\n- [x] パン\n');
    const s = d.getState();
    expect(s.notice).toBe('2 件を完了にしました');
    expect(s.restoreUndo).toEqual({ lid: 'n1', revId: 'r1', notice: '2 件を完了にしました' });
  });

  it('対照群:「すべて完了にする」で何も動かない回(もう全部完了)には「元に戻す」を出さない', async () => {
    const { d } = await run('- [x] 牛乳\n- [x] 卵\n', 'done');
    expect(d.getState().restoreUndo ?? null).toBeNull();
    expect(d.getState().notice).toBe('すべて完了になっています');
  });
});
