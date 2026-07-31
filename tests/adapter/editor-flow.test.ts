/** @vitest-environment happy-dom */
/**
 * editor(P3-5)の end-to-end: binder → dispatcher → renderer → fake store。
 * state mutation → consumer 観測点(DOM / 副作用)まで通す(PKC2 Testing 規約)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';

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

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    getBody: async (lid) => bodies[lid] ?? null,
    persistEntry: async (e) => {
      persisted.push(e);
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, persisted, q };
}

describe('editor flow (P3-5)', () => {
  it('編集 → 入力 → 保存: DOM と store まで一貫する', async () => {
    const { d, persisted, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();

    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('# 原文');

    // 入力: input delegation が state に写す。編集中は DOM を作り直さない
    ta!.value = '# 改稿';
    ta!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(d.getState().openBody?.body).toBe('# 改稿');
    expect(q('[data-pkc-field="editor-body"]')).toBe(ta); // 同一 node(カーソル保全)

    q('[data-pkc-action="commit-edit"]')!.click();
    await tick();
    // view へ戻り、新内容が rendered で見える
    expect(q('[data-pkc-field="editor-body"]')).toBeNull();
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('改稿');
    // store には行全体が 1 回だけ書かれ、ack で persisted が確定
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ lid: 'a', body: '# 改稿' });
    expect(d.getState().openBody?.persisted).toBe('# 改稿');
  });

  it('キャンセル(Esc)は baseline へ戻し、書かない', async () => {
    const { d, persisted, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '捨てる変更';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await tick();
    expect(q('[data-pkc-field="editor-body"]')).toBeNull();
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('原文');
    expect(persisted).toHaveLength(0);
  });

  it('Ctrl+Enter は保存ショートカット', async () => {
    const { d, persisted, q } = setup({ a: 'plain text' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = 'plain text v2';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    await tick();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe('plain text v2');
  });

  it('無変化の保存は書かない(#1024)', async () => {
    const { persisted, q, d } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    q('[data-pkc-action="commit-edit"]')!.click();
    await tick();
    expect(persisted).toHaveLength(0);
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('原文');
  });
});
