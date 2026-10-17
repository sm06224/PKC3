/** @vitest-environment happy-dom */
/**
 * 🔴 **履歴から戻した直後の「元に戻す」**(依頼 68-1。Gemini 裁定 = #1163 への依頼 68 の回答)。
 *
 * 新しい復元の経路は作らない ── 復元は戻す前の本文を履歴に 1 件積むので、その版へ向けた
 * 同じ `RESTORE_REVISION` を、画面の下の知らせの隣の「元に戻す」から撃つ。
 * ⚠ 守っているのは効きの端から端まで(effect が積まれた版を見つける → state → 画面の下のボタン → 押す →
 *   戻す前の本文に戻る)と、**積まれなかった回は口を出さない**こと。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import { stubRevisionOps } from '../helpers/revision-stub';

const meta = (lid: string): EntryMeta => ({
  lid, title: 't-' + lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1,
  status: null, date: null, archived: false, bodyChars: null,
});
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

/** 復元で履歴が 1 件増える fake。`grows: false` なら増えない(同じ本文を書いた回)。 */
function setup(grows: boolean, topIsPre = false) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  const log: string[] = [];
  let persisted = false;
  const metasNow = () => [
    ...((persisted && grows) || topIsPre
      ? [{ id: 'r-10', rev_order: 10, created_at: '2026-08-02', title: '戻す前', archetype: 'text' }]
      : []),
    { id: 'r-9', rev_order: 9, created_at: '2026-08-01', title: '旧題', archetype: 'text' },
  ];
  const revs: Record<string, { body: string; title: string; archetype: string }> = {
    'r-9': { body: '# 復元先', title: '旧題', archetype: 'text' },
    'r-10': { body: '# 戻す前', title: '戻す前', archetype: 'text' },
  };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '# 戻す前',
    listRevisionMetas: async () => metasNow(),
    getRevision: async (id) => revs[id] ?? null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      log.push(`persist:${e.lid}:${e.body}${opts?.checkpoint ? ':cp' : ''}`);
      persisted = true;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1'), meta('e2')], relations: [] });
  return { root, d, log };
}
const undoBtn = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="status-undo"]')!;
const paint = (root: HTMLElement, d: Dispatcher): HTMLElement => {
  const btn = undoBtn(root);
  paintStatusUndo(btn, d.getState(), d.getState().notice ?? '');
  return btn;
};
async function restored(grows: boolean, topIsPre = false) {
  const h = setup(grows, topIsPre);
  h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
  await tick();
  h.d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-9' });
  await tick();
  return h;
}

describe('履歴から戻した直後の「元に戻す」(依頼 68-1)', () => {
  it('🔴 戻すと「元に戻す」が出て、押すと戻す前の本文に戻る', async () => {
    const h = await restored(true);
    expect(h.d.getState().openBody?.body, '前提:復元先に戻っていない').toBe('# 復元先');
    expect(h.d.getState().restoreUndo, '積まれた版を見つけていない').toMatchObject({ lid: 'e1', revId: 'r-10' });
    const btn = paint(h.root, h.d);
    expect(btn.hidden, '戻す口が出ない(片道になっている)').toBe(false);
    expect(btn.textContent).toBe('元に戻す');
    expect(btn.getAttribute('data-pkc-action'), '押すと別の物が戻る').toBe('restore-revision');
    expect(btn.getAttribute('data-pkc-rev-id')).toBe('r-10');
    btn.click();
    await tick();
    expect(h.d.getState().openBody?.body, '押したのに戻す前の本文に戻っていない').toBe('# 戻す前');
    expect(h.log.at(-1)).toBe('persist:e1:# 戻す前:cp');
  });

  it('⚠ 別のノートを開いたら出さない(他のノートの版を、開いているノートへ書かない)', async () => {
    const h = await restored(true);
    expect(paint(h.root, h.d).hidden, '前提:戻した直後は出ている').toBe(false);
    const st = { ...h.d.getState(), selectedLid: 'e2' };
    const btn = undoBtn(h.root);
    paintStatusUndo(btn, st, st.notice ?? '');
    expect(btn.hidden, '別のノートの上に戻す口が残っている').toBe(true);
  });

  it('⚠ 別の知らせに上書きされたら畳む(「コピーしました」の隣に残さない)', async () => {
    const h = await restored(true);
    expect(paint(h.root, h.d).hidden, '前提:戻した直後は出ている').toBe(false);
    const btn = undoBtn(h.root);
    paintStatusUndo(btn, { ...h.d.getState(), notice: 'コピーしました' }, 'コピーしました');
    expect(btn.hidden).toBe(true);
  });

  it('🔴 履歴が増えなかった回(同じ本文を書いた)は、口を出さない(古い別の版へ戻さない)', async () => {
    const h = await restored(false);
    expect(h.d.getState().openBody?.body, '前提:復元は通っている').toBe('# 復元先');
    expect(h.d.getState().restoreUndo ?? null).toBeNull();
    expect(paint(h.root, h.d).hidden, '戻す先が無いのに口が出ている').toBe(true);
  });

  it('🔴 戻す前の本文が既に一番上の版に在って積まれなかった回(ゴミ箱から戻した直後)も、その版へ戻せる', async () => {
    const h = await restored(false, true);
    expect(h.d.getState().openBody?.body, '前提:復元は通っている').toBe('# 復元先');
    expect(h.d.getState().restoreUndo, '一番上の版が戻す前の本文なのに口が出ない').toMatchObject({ lid: 'e1', revId: 'r-10' });
    const btn = paint(h.root, h.d);
    expect(btn.hidden).toBe(false);
    btn.click();
    await tick();
    expect(h.d.getState().openBody?.body).toBe('# 戻す前');
  });

  it('🔴 「元に戻す」で戻した後は、知らせを言い換え、「元に戻す」を重ねて出さない(行ったり来たりしない)', async () => {
    const h = await restored(true);
    const first = h.d.getState().notice;
    expect(first, '前提:最初は「前の版に戻しました」(題名が変わったので、題名も戻したことを添える)').toBe(
      '「t-e1」を前の版に戻しました(題名も「旧題」に戻しました)',
    );
    const btn = paint(h.root, h.d);
    expect(btn.getAttribute('data-pkc-undo'), '押し先が「元に戻す」だと伝わっていない').toBe('1');
    btn.click();
    await tick();
    expect(h.d.getState().openBody?.body, '前提:戻す前の本文に戻った').toBe('# 戻す前');
    expect(h.d.getState().notice, '同じ字を出し続けている').toBe(
      '「戻す前」を、戻す前の本文に戻しました(題名も「戻す前」に戻しました)',
    );
    expect(h.d.getState().restoreUndo ?? null, '元に戻すを重ねて出している').toBeNull();
    expect(paint(h.root, h.d).hidden).toBe(true);
  });

  it('対照群: 履歴の「この版に戻す」(印なし)は、従来の知らせのまま', async () => {
    const h = await restored(true);
    expect(h.d.getState().notice).toBe('「t-e1」を前の版に戻しました(題名も「旧題」に戻しました)');
    h.d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-10' });
    await tick();
    expect(h.d.getState().notice).toBe('「旧題」を前の版に戻しました(題名も「戻す前」に戻しました)');
  });
});
