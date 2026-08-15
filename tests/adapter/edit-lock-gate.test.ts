/** @vitest-environment happy-dom */
/**
 * #177: 「編集」ボタンの編集権ゲート ── binder → dispatcher の end-to-end。
 *
 * 守る主張:
 * 1. 取れたら編集に入る(従来と同じ)
 * 2. 取れなかったら**編集に入らず**、押した場所と対の断りが出る(無言にしない)
 * 3. 取ったのに reducer が編集を断ったら**返す**(取りっぱなしの死にロックを作らない)
 * 4. 作成 → 即編集も編集権を登録する(別タブが 'changed' でこの lid を知る前に)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  };
}

const tick = async (ms = 10): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

function setup(services: {
  acquireEditLock?: (lid: string) => Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEditLock?: (lid: string) => void;
}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d, services);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '# 本文',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    persistEntry: async () => stubStamps(),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, q };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.setItem('pkc3.editor-mode', 'split');
});

describe('start-edit の編集権ゲート(#177)', () => {
  it('取れたら編集に入る', async () => {
    const acquireEditLock = vi.fn(async () => 'granted' as const);
    const { d, q } = setup({ acquireEditLock });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(acquireEditLock).toHaveBeenCalledWith('a');
    expect(d.getState().phase).toBe('editing');
  });

  it('取れなかったら編集に入らず、断りが出る(無言の dead click にしない)', async () => {
    const { d, q } = setup({ acquireEditLock: async () => 'denied' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(d.getState().phase).toBe('ready');
    // ⚠ 文言は押した場所と対(§1)── 「別のタブ」が理由だと分かる形
    expect(d.getState().error).toContain('別のタブで編集中');
  });

  it('本体と話せないときは「編集中」と言わない(レビュー M-7 ── 文言の嘘)', async () => {
    const { d, q } = setup({ acquireEditLock: async () => 'unreachable' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(d.getState().phase).toBe('ready');
    expect(d.getState().error).toContain('本体タブと通信できません');
    expect(d.getState().error, '存在しない編集タブを探させる文言').not.toContain('編集中です');
  });

  it('acquire 待ち中に選択が変わったら、別ノートの編集に入らずロックを返す(レビュー M-3)', async () => {
    let resolveLock!: (v: 'granted') => void;
    const acquireEditLock = vi.fn(
      () => new Promise<'granted'>((r) => (resolveLock = r)),
    );
    const releaseEditLock = vi.fn();
    const { d, q } = setup({ acquireEditLock, releaseEditLock });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click(); // 'a' の acquire 発行(pending)
    // 待っている間に別のノートへ移る(setup の meta は 'a' だけなので 'b' を足す)
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    await tick(); // 'b' の本文が openBody へ
    expect(d.getState().openBody?.lid).toBe('b');
    resolveLock('granted');
    await tick();
    // 🔴 'b' の編集に「'a' のロックで」入ってはいけない
    expect(d.getState().phase).toBe('ready');
    expect(releaseEditLock).toHaveBeenCalledWith('a');
  });

  it('取ったのに編集に入れなかったら返す(死にロックを作らない)', async () => {
    // 実在する race: acquire は非同期(follower は放送 1 往復)── 待っている間に
    // user が別の操作で editing に入ると、reducer は START_EDIT を断る。
    // そのときロックを返さないと、'a' は**どのタブからも編集できないノート**になる
    let resolveLock!: (v: 'granted') => void;
    const acquireEditLock = vi.fn(
      () => new Promise<'granted'>((r) => (resolveLock = r)),
    );
    const releaseEditLock = vi.fn();
    const { d, q } = setup({ acquireEditLock, releaseEditLock });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click(); // acquire 発行(pending)
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'b', title: 'b' });
    expect(d.getState().phase).toBe('editing'); // 'b' の編集に入った
    resolveLock('granted');
    await tick();
    expect(d.getState().openBody?.lid, "'a' の編集で上書きされた").toBe('b');
    expect(releaseEditLock, '入れなかったのに握りっぱなし').toHaveBeenCalledWith('a');
  });

  it('サービス未配線(単独タブ相当)なら従来どおり編集に入る', async () => {
    const { d, q } = setup({});
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(d.getState().phase).toBe('editing');
  });

  it('作成 → 即編集も編集権を登録する', async () => {
    const acquired: string[] = [];
    const { d, q } = setup({
      acquireEditLock: async (lid) => {
        acquired.push(lid);
        return 'granted';
      },
    });
    await tick();
    const btn = q('[data-pkc-action="create-entry"]');
    expect(btn, 'create ボタンが無い(前提が崩れた)').not.toBeNull();
    btn!.click();
    await tick();
    expect(d.getState().phase).toBe('editing');
    const lid = d.getState().openBody?.lid;
    expect(lid).toBeTruthy();
    expect(acquired).toContain(lid);
  });
});
