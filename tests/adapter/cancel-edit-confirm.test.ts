/** @vitest-environment happy-dom */
/**
 * 🔴 **編集をやめるとき、打った内容があれば「打った内容を捨てますか」と聞く**(依頼 71-1。Gemini 裁定 =
 * #1163 への依頼 71 の回答)。打っていなければ聞かずにやめる。変換中の Esc は今までどおり無視する。
 *
 * ⚠ 守っているのは**聞く条件**(打った / 打っていない)と**答えの効き方**(捨てる / 続ける)と、
 *   やめる口が 2 本(Esc・「編集をやめる」)とも同じ規則を通ること。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';

const meta = (lid: string): EntryMeta => ({
  lid, title: 't-' + lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1,
  status: null, date: null, archived: false, bodyChars: null,
});
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '# 原文',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, q };
}

const dialog = (): HTMLElement | null => document.querySelector('[data-pkc-region="app-dialog"][open]');
const dialogText = (): string => document.querySelector('[data-pkc-field="dialog-body"]')?.textContent ?? '';
const press = (field: 'dialog-ok' | 'dialog-cancel'): void =>
  document.querySelector<HTMLElement>(`[data-pkc-field="${field}"]`)!.click();

async function startEditing(typed: string | null) {
  const h = setup();
  h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  await tick();
  h.q('[data-pkc-action="start-edit"]')!.click();
  const ta = h.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
  expect(ta, '前提:編集に入っていない').not.toBeNull();
  if (typed !== null) {
    ta.value = typed;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { ...h, ta };
}
const esc = (ta: HTMLElement, composing = false): void => {
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: composing }));
};

beforeEach(() => {
  localStorage.setItem('pkc3.editor-mode', 'split');
});
afterEach(() => {
  resetAppDialogForTest();
  document.body.textContent = '';
  localStorage.clear();
});

describe('編集をやめる前の確認(依頼 71-1)', () => {
  it('🔴 打っていなければ、聞かずにやめる(対照群)', async () => {
    const h = await startEditing(null);
    esc(h.ta);
    await tick();
    expect(dialog(), '打っていないのに聞いた').toBeNull();
    expect(h.d.getState().phase, 'やめられていない').toBe('ready');
  });

  it('🔴 打った内容があれば「打った内容を捨てますか」と聞き、答えるまで編集を続ける', async () => {
    const h = await startEditing('# 打った');
    esc(h.ta);
    await tick();
    expect(dialog(), '聞いていない').not.toBeNull();
    expect(dialogText()).toBe('打った内容を捨てますか');
    expect(h.d.getState().phase, '答える前にやめた').toBe('editing');
  });

  it('🔴 「編集を続ける」を選ぶと、打った内容が残ったまま編集に戻る', async () => {
    const h = await startEditing('# 打った');
    esc(h.ta);
    await tick();
    press('dialog-cancel');
    await tick();
    expect(h.d.getState().phase).toBe('editing');
    expect(h.d.getState().openBody?.body, '打った内容が消えた').toBe('# 打った');
  });

  it('🔴 「捨てる」を選ぶと、元の本文でやめる', async () => {
    const h = await startEditing('# 打った');
    esc(h.ta);
    await tick();
    press('dialog-ok');
    await tick();
    expect(h.d.getState().phase).toBe('ready');
    expect(h.d.getState().openBody?.body, '捨てたのに本文が元に戻っていない').toBe('# 原文');
  });

  it('🔴 「編集をやめる」ボタンも同じ規則を通る(口が 2 本とも)', async () => {
    const h = await startEditing('# 打った');
    h.q('[data-pkc-action="cancel-edit"]')!.click();
    await tick();
    expect(dialog(), 'ボタンの口だけ聞いていない').not.toBeNull();
    expect(h.d.getState().phase).toBe('editing');
    press('dialog-cancel');
    await tick();
  });

  it('🔴 打っていない回は、ボタンの口でも聞かない(対照群)', async () => {
    const h = await startEditing(null);
    h.q('[data-pkc-action="cancel-edit"]')!.click();
    await tick();
    expect(dialog()).toBeNull();
    expect(h.d.getState().phase).toBe('ready');
  });

  it('🔴 変換中の Esc は無視する(聞きもしない・やめもしない)', async () => {
    const h = await startEditing('# 打った');
    esc(h.ta, true);
    await tick();
    expect(dialog(), '変換中の Esc で聞いた').toBeNull();
    expect(h.d.getState().phase, '変換中の Esc でやめた').toBe('editing');
    // 対照群:変換中でなければ同じ打鍵で聞く
    esc(h.ta, false);
    await tick();
    expect(dialog()).not.toBeNull();
  });

  it('⚠ 聞いている間にもう一度押しても、窓は 1 つのまま', async () => {
    const h = await startEditing('# 打った');
    h.q('[data-pkc-action="cancel-edit"]')!.click();
    h.q('[data-pkc-action="cancel-edit"]')!.click();
    await tick();
    expect(document.querySelectorAll('[data-pkc-region="app-dialog"]').length).toBe(1);
    press('dialog-cancel');
  });
});
