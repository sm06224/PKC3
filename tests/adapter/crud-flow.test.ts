/** @vitest-environment happy-dom */
/**
 * entry CRUD(P3-7a)の end-to-end: 作成 → seed 編集 → 保存 / fresh 掃除 /
 * 削除(確認)/ rename。binder → dispatcher → renderer → fake store を通す。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, order: number, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// root がテスト間で堆積すると region 外 query の事故を隠す ── 毎回掃除
beforeEach(() => {
  document.body.textContent = '';
});

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const sidebar = new SidebarRenderer(regions.sidebar);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => {
    sidebar.render(s);
    detail.render(s);
  });
  bindActions(root, d);
  const store = { ...bodies };
  const deleted: string[] = [];
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    getBody: async (lid) => store[lid] ?? null,
    persistEntry: async (e) => {
      persisted.push(e);
      store[e.lid] = e.body;
    },
    deleteEntry: async (lid) => {
      deleted.push(lid);
      delete store[lid];
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { root, d, persisted, deleted, store, q, qa };
}

describe('create (P3-7a)', () => {
  it('作成ボタン → seed 付き editor + 即永続、保存で本文が確定する', async () => {
    const { d, q, qa, persisted, store } = setup([meta('a', 1)], { a: 'x' });
    q<HTMLElement>('[data-pkc-action="create-entry"][data-pkc-archetype="todo"]')!.click();
    await tick();

    // 即永続(作成時点で行が存在 ── PKC2 と同じ)+ seed が editor に見える
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      archetype: 'todo',
      body: '---\nstatus: open\n---\n',
      status: 'open',
      entryOrder: 2,
    });
    const lid = persisted[0]!.lid;
    expect(d.getState().phase).toBe('editing');
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value).toBe('---\nstatus: open\n---\n');
    // 既定 title(日付 + 種別 + 連番)が title input に入っている
    const title = q<HTMLInputElement>('[data-pkc-field="editor-title"]')!;
    expect(title.value).toMatch(/^\d{4}-\d{2}-\d{2} Todo 1$/);
    // sidebar に行が生えている
    expect(qa(`[data-pkc-entry="${lid}"]`).length).toBeGreaterThan(0);

    ta.value = '---\nstatus: open\n---\n買い物';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(store[lid]).toBe('---\nstatus: open\n---\n買い物');
  });

  it('未編集のまま cancel → entry ごと掃除(PKC2 の空 entry 堆積の対策)', async () => {
    const { d, q, qa, deleted } = setup([meta('a', 1)], { a: 'x' });
    q<HTMLElement>('[data-pkc-action="create-entry"][data-pkc-archetype="text"]')!.click();
    const lid = d.getState().selectedLid!;
    q<HTMLElement>('[data-pkc-action="cancel-edit"]')!.click();
    await tick(20);
    expect(d.getState().entryMetas.has(lid)).toBe(false);
    expect(qa(`[data-pkc-entry="${lid}"]`)).toHaveLength(0);
    expect(deleted).toEqual([lid]); // disk からも掃除
    // 掃除後は元の entry に選択が戻る
    expect(d.getState().selectedLid).toBe('a');
  });

  it('一度 commit した entry は cancel でも消えない(fresh 解除)', async () => {
    const { d, q } = setup([], {});
    q<HTMLElement>('[data-pkc-action="create-entry"][data-pkc-archetype="text"]')!.click();
    const lid = d.getState().selectedLid!;
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '本文';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    // 再編集 → 未変更 cancel ── もう fresh ではないので残る
    q<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    q<HTMLElement>('[data-pkc-action="cancel-edit"]')!.click();
    expect(d.getState().entryMetas.has(lid)).toBe(true);
  });
});

describe('delete (P3-7a)', () => {
  // happy-dom は confirm 未実装 ── 関数を定義して差し替える(グローバル丸ごと
  // 差し替えはしない ── URL 非コンストラクタ事故の教訓)
  const setConfirm = (value: boolean) => {
    Object.defineProperty(window, 'confirm', {
      value: vi.fn().mockReturnValue(value),
      configurable: true,
      writable: true,
    });
  };

  it('確認 OK で削除 ── 行が消え、選択が隣へ移り、store の掃除 op が走る', async () => {
    setConfirm(true);
    const { d, q, qa, deleted } = setup(
      [meta('a', 1), meta('b', 2), meta('c', 3)],
      { a: 'A', b: 'B', c: 'C' },
    );
    q<HTMLElement>('[data-pkc-entry="b"]')!.click();
    await tick();
    q<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    await tick(20);
    expect(qa('[data-pkc-entry="b"]')).toHaveLength(0);
    expect(deleted).toEqual(['b']);
    // 同 index の次(c)へ選択が移り、body が読まれている
    expect(d.getState().selectedLid).toBe('c');
    expect(d.getState().openBody?.body).toBe('C');
  });

  it('確認キャンセルなら何もしない', async () => {
    setConfirm(false);
    const { d, q, deleted } = setup([meta('a', 1)], { a: 'A' });
    q<HTMLElement>('[data-pkc-entry="a"]')!.click();
    await tick();
    q<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    await tick();
    expect(deleted).toHaveLength(0);
    expect(d.getState().entryMetas.has('a')).toBe(true);
  });
});

describe('rename (P3-7a)', () => {
  it('editor の title input → 保存で sidebar と store に反映', async () => {
    const { d, q, persisted, store } = setup([meta('a', 1)], { a: '# 本文' });
    q<HTMLElement>('[data-pkc-entry="a"]')!.click();
    await tick();
    q<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    const title = q<HTMLInputElement>('[data-pkc-field="editor-title"]')!;
    title.value = '新しい題';
    q<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(d.getState().entryMetas.get('a')?.title).toBe('新しい題');
    expect(
      q('[data-pkc-entry="a"] [data-pkc-field="title"]')?.textContent,
    ).toBe('新しい題');
    // 最終的に store の行は 新 title を持つ(rename の read-modify-write)
    const last = persisted[persisted.length - 1]!;
    expect(last.title).toBe('新しい題');
    expect(store['a']).toBe('# 本文'); // body は無傷
  });
});

describe('reducer edges (P3-7a)', () => {
  const boot = (metas: EntryMeta[]) =>
    reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;

  it('CREATE_ENTRY: lid 衝突は可視エラーで拒否 / entryOrder は末尾 + 1', () => {
    const s = boot([meta('a', 5)]);
    const dup = reduce(s, { type: 'CREATE_ENTRY', archetype: 'text', lid: 'a', title: 't' });
    expect(dup.state.entryMetas.size).toBe(1);
    expect(dup.state.error).toMatch(/collision/);
    const ok = reduce(s, { type: 'CREATE_ENTRY', archetype: 'text', lid: 'n', title: 't' });
    expect(ok.state.entryMetas.get('n')?.entryOrder).toBe(6);
    expect(ok.state.order[ok.state.order.length - 1]).toBe('n');
  });

  it('DELETE_ENTRY の選択遷移: 末尾削除 → 前へ、唯一の entry 削除 → null', () => {
    let s = boot([meta('a', 1), meta('b', 2)]);
    s = { ...s, selectedLid: 'b' };
    const r1 = reduce(s, { type: 'DELETE_ENTRY', lid: 'b' });
    expect(r1.state.selectedLid).toBe('a'); // 末尾 fallback
    const only = boot([meta('x', 1)]);
    const r2 = reduce({ ...only, selectedLid: 'x' }, { type: 'DELETE_ENTRY', lid: 'x' });
    expect(r2.state.selectedLid).toBeNull();
    expect(r2.events).toEqual([{ type: 'REQUEST_DELETE', lid: 'x' }]);
  });

  it('RENAME_ENTRY_TITLE: trim / 空・同一は no-op / 楽観 meta 更新 + snapshot event', () => {
    const s = boot([meta('a', 1)]);
    expect(reduce(s, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: '  ' }).events).toEqual([]);
    expect(reduce(s, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: 't-a' }).events).toEqual([]);
    const r = reduce(s, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: '  改名  ' });
    expect(r.state.entryMetas.get('a')?.title).toBe('改名');
    expect(r.events).toEqual([
      { type: 'REQUEST_RENAME', lid: 'a', title: '改名', archetype: 'text', entryOrder: 1 },
    ]);
  });
});
