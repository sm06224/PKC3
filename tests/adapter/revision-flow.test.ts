/** @vitest-environment happy-dom */
/**
 * P5b: 履歴・ゴミ箱の app 層 flow pin。
 * - 刻む縁: 変更ありの commit だけ / fresh 初回は積まない / 無変更は積まない
 * - 復元 = 前進変異(現状を先に積む順序)
 * - trash 復元の lid 衝突は可視ブロック
 * - purge-trash の confirm は fail closed
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(bodies: Record<string, string>, port: Partial<StorePort> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  // binder は root 配下しか拾わない ── filer region も root 内に置く
  const filerRegion = document.createElement('div');
  root.append(filerRegion);
  const filer = new FilerRenderer(filerRegion);
  d.onState((s) => {
    detail.render(s);
    if (s.viewMode === 'filer') filer.render(s);
  });
  const log: string[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    persistEntry: async (e) => {
      log.push(`persist:${e.lid}:${e.body}`);
    },
    deleteEntry: async () => {
      log.push('delete');
    },
    addRevision: async (rev) => {
      log.push(`rev:${rev.entryLid}:${rev.body}`);
      return { added: true, pruned: 0 };
    },
    ...port,
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
  const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
  return { d, root, log, q };
}

describe('revision flow (P5b)', () => {
  it('変更ありの commit だけが baseline を積む(persist より先)── 無変更・RETRY は積まない', async () => {
    const { d, log } = setup({ e1: '# v1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# v2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    expect(log).toEqual(['rev:e1:# v1', 'persist:e1:# v2']); // 変更前を先に積む

    // 無変更 commit は persist も revision も出さない
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    expect(log).toHaveLength(2);
  });

  it('fresh(新規作成)の初回 commit は revision を積まない ── seed へ戻す復元先はゴミ', async () => {
    const { d, log } = setup({});
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: 'new' });
    await tick();
    const created = log.length; // CREATE の初回 persist
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# 初稿' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    const added = log.slice(created);
    expect(added).toEqual(['persist:n1:# 初稿']); // revision は無い
  });

  it('履歴 panel: SHOW_HISTORY → 一覧描画 → 復元 = 前進変異の順序 + panel 畳み', async () => {
    const { d, log, q } = setup(
      { e1: '# 現在' },
      {
        listRevisionMetas: async () => [
          { id: 'r-9', rev_order: 9, created_at: '2026-08-01', title: '旧題', archetype: 'text' },
        ],
        getRevision: async (revId) =>
          revId === 'r-9' ? { body: '# 復元先', title: '旧題', archetype: 'text' } : null,
      },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'SHOW_HISTORY' });
    await tick();
    expect(d.getState().revisionPanel?.items).toHaveLength(1);
    const panel = q('[data-pkc-field="history-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('#9');

    d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-9' });
    await tick();
    // 前進変異: 現状(# 現在)を積んでから revision 内容で persist
    expect(log).toEqual(['rev:e1:# 現在', 'persist:e1:# 復元先']);
    const s = d.getState();
    expect(s.openBody?.body).toBe('# 復元先');
    expect(s.entryMetas.get('e1')?.title).toBe('旧題'); // title も戻る
    expect(s.revisionPanel).toBeNull(); // panel は畳む(履歴が 1 件伸びたため)
    expect(q('[data-pkc-field="history-panel"]')).toBeNull();
  });

  it('ゴミ箱: 一覧 → 復元で entry が戻り選択される。lid 衝突は可視ブロック', async () => {
    const { d, log, q } = setup(
      { e1: '# live' },
      {
        listTrash: async () => [
          { id: 'r-t', entry_lid: 'gone1', created_at: '2026-08-01', title: '消した子', archetype: 'todo' },
        ],
        getRevision: async () => ({
          body: '---\nstatus: open\n---\n\nやる',
          title: '消した子',
          archetype: 'todo',
        }),
      },
    );
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'filer' });
    d.dispatch({ type: 'SHOW_TRASH' });
    await tick();
    expect(d.getState().trashPanel?.items).toHaveLength(1);
    const region = q('[data-pkc-region="filer-trash"]')!;
    expect(region.textContent).toContain('消した子');

    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'gone1', revId: 'r-t' });
    await tick();
    const s = d.getState();
    expect(log.at(-1)).toContain('persist:gone1');
    expect(s.entryMetas.get('gone1')).toMatchObject({
      title: '消した子',
      archetype: 'todo',
      status: 'open', // 抽出一元化(extractMeta)を通っている
    });
    expect(s.selectedLid).toBe('gone1');
    expect(s.trashPanel?.items).toHaveLength(0); // 復元した行は消える
    expect(s.order).toContain('gone1');

    // lid 衝突(既存 e1)── 黙って上書きしない
    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'e1', revId: 'r-t' });
    await tick();
    expect(d.getState().error).toContain('既に存在します');
  });

  it('purge-trash: confirm 不在は fail closed、承諾で TRASH_PURGED が panel を空にする', async () => {
    let purged = 0;
    const { d, root } = setup(
      {},
      {
        listTrash: async () => [
          { id: 'r-t', entry_lid: 'gone1', created_at: null, title: null, archetype: null },
        ],
        purgeTrash: async () => {
          purged++;
          return { purged: 1 };
        },
      },
    );
    bindActions(root, d);
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'filer' });
    d.dispatch({ type: 'SHOW_TRASH' });
    await tick();

    const btn = document.querySelector<HTMLElement>('[data-pkc-action="purge-trash"]')!;
    expect(btn).not.toBeNull();
    btn.click(); // happy-dom に confirm は無い → ?? false → 実行しない
    await tick();
    expect(purged).toBe(0);

    Object.defineProperty(window, 'confirm', { value: () => true, configurable: true });
    btn.click();
    await tick();
    expect(purged).toBe(1);
    expect(d.getState().trashPanel?.items).toHaveLength(0);
  });
});
