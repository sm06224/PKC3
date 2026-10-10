/** @vitest-environment happy-dom */
/**
 * 🔴 **このノートを Markdown で書き出す**(#1440)── 「操作を探す」の入口と、右クリックの受け手が
 * **同じ口**(`services.exportEntryMarkdown`)へ届くこと。
 *
 * ⚠ 書き出しそのもの(file 名・本文・添付の件数)は `export-entry-markdown.test.ts`。ここが見るのは**配線**。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DIALOG_REGION, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
const rowOf = (id: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')].find(
    (b) => b.getAttribute('data-pkc-command') === id,
  );
const whyOf = (id: string): string =>
  rowOf(id)?.querySelector('[data-pkc-field="palette-why"]')?.textContent ?? '';

function boot(calls: string[], withService = true) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  bindActions(root, d, withService ? { exportEntryMarkdown: (lid) => calls.push(lid) } : {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも')], relations: [] });
  return { root, d };
}

async function openPalette(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
  await tick();
  const f = document.querySelector<HTMLInputElement>('[data-pkc-field="palette-filter"]')!;
  f.value = 'Markdown';
  f.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('このノートを Markdown で書き出す(#1440)', () => {
  it('🔴 ノートを開いていれば押せて、選ぶと開いているノートの lid で書き出しが呼ばれる', async () => {
    const calls: string[] = [];
    const { root, d } = boot(calls);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await openPalette(root);
    const row = rowOf('export-note-markdown');
    expect(row, '「このノートを Markdown で書き出す」が一覧に出ていない').toBeDefined();
    expect(row!.disabled, '押せるはずの行が押せない').toBe(false);
    row!.click();
    await tick();
    expect(calls).toEqual(['n1']);
  });

  it('🔴 ノートを開いていない / 編集中 / 配線が無い版では押せず、理由を言う', async () => {
    const calls: string[] = [];
    const { root, d } = boot(calls);
    await openPalette(root);
    expect(rowOf('export-note-markdown')!.disabled, 'ノートを開いていないのに押せる').toBe(true);
    dialog()?.close();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'x' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている').toBe('editing');
    await openPalette(root);
    expect(rowOf('export-note-markdown')!.disabled, '編集中なのに押せる').toBe(true);
    expect(whyOf('export-note-markdown')).toContain(NOT_READY_PREFIX);
    expect(whyOf('export-note-markdown'), '出口を言っていない').toContain('編集をやめる');
    expect(calls, '断ったのに書き出しが呼ばれた').toEqual([]);

    dialog()?.close();
    const stale = boot([], false);
    stale.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await openPalette(stale.root);
    expect(rowOf('export-note-markdown')!.disabled, '配線の無い版で押せる').toBe(true);
  });

  it('🔴 右クリックの受け手(export-entry-markdown)も同じ口へ、選んでいるノートの lid で届く', () => {
    const calls: string[] = [];
    const { root, d } = boot(calls);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'export-entry-markdown');
    root.append(b);
    b.click();
    expect(calls).toEqual(['n1']);
  });
});
