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
import * as clipboard from '../../src/adapter/platform/clipboard';
import { vi } from 'vitest';

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

  it('IME 変換中の Esc は編集キャンセルに化けない(isComposing ガード)', async () => {
    const { d, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '変換中の draft';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 変換中の Esc =「変換の取り消し」── 編集セッションは維持されること
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }),
    );
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().openBody?.body).toBe('変換中の draft');
    expect(q('[data-pkc-field="editor-body"]')).toBe(ta);
  });

  it('キャンセルボタン(実クリック)も baseline へ戻す', async () => {
    const { d, persisted, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '捨てる';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('[data-pkc-action="cancel-edit"]')!.click();
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('原文');
    expect(persisted).toHaveLength(0);
  });

  it('保存失敗 → 編集ボタン非表示 + 再保存導線 → 再送で復帰(error 復帰の e2e)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail);
    d.onState((s) => detail.render(s));
    bindActions(root, d);
    let failNext = true;
    const persisted: string[] = [];
    connectStoreEffects(d, {
      getBody: async () => '# A',
      persistEntry: async (e) => {
        if (failNext) throw new Error('disk full');
        persisted.push(e.body);
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    root.querySelector<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = 'v2';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(d.getState().phase).toBe('error');
    // START_EDIT は ready 限定 ── ボタンを出したまま無言 no-op にしない
    expect(root.querySelector('[data-pkc-action="start-edit"]')).toBeNull();
    // 未達の commit がある ── 再保存導線が出る
    const retry = root.querySelector<HTMLElement>('[data-pkc-action="retry-persist"]');
    expect(retry).not.toBeNull();

    failNext = false;
    retry!.click();
    await tick(20);
    expect(persisted).toEqual(['v2']);
    expect(d.getState().phase).toBe('ready');
    expect(d.getState().openBody?.persisted).toBe('v2');
    // 復帰後は通常の編集導線に戻る
    expect(root.querySelector('[data-pkc-action="start-edit"]')).not.toBeNull();
    expect(root.querySelector('[data-pkc-action="retry-persist"]')).toBeNull();
  });

  it('copy-md-block は実 delegation 経路(rendered ⧉ ボタンのクリック)で動く', async () => {
    const spy = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const { d, q, root } = setup({ a: '```js\nconst x = 1;\n```' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    // renderMarkdown が生成した実ボタン → root delegation → handler → clipboard
    const btn = root.querySelector<HTMLElement>(
      '[data-pkc-field="detail-body"] [data-pkc-action="copy-md-block"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();
    await tick(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain('const x = 1;');
    expect(q('[data-pkc-action="copy-md-block"]')?.getAttribute('data-pkc-flash')).toBe(
      'true',
    );
    spy.mockRestore();
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
