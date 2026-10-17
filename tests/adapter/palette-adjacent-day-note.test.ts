/** @vitest-environment happy-dom */
/**
 * 🔴 **前の日・次の日のノートを開く**(#1640 ②。🟣 Gemini 依頼 58 の答え = C)。
 * 画面にボタンは足さず、「操作を探す」から呼ぶ。ノートがある日だけ飛び、ノートは増やさない。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { adjacentDateNote, isDateTitle } from '../../src/features/schedule/today-note';

function meta(lid: string, title: string, order = 1, archived = false): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived,
    bodyChars: 0,
  };
}
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const rowOf = (id: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')].find(
    (b) => b.getAttribute('data-pkc-command') === id,
  );

const METAS = [
  meta('a', '2026-10-01'),
  meta('b', '2026-10-05'),
  meta('c', '2026-10-09'),
  meta('d', '2026-10-07', 1, true), // 片付け済み ── 拾わない
  meta('e', '2026-13-45'), // 日付ではない
  meta('f', 'めも'),
];

describe('adjacentDateNote(純関数)', () => {
  it('ノートがある日だけ飛び、無い日・片付け済み・日付でない題名は飛ばす', () => {
    expect(adjacentDateNote(METAS, '2026-10-05', 'prev')?.lid).toBe('a');
    expect(adjacentDateNote(METAS, '2026-10-05', 'next')?.lid).toBe('c'); // 10-07 は片付け済みなので 10-09
    expect(adjacentDateNote(METAS, '2026-10-01', 'prev')).toBeNull();
    expect(adjacentDateNote(METAS, '2026-10-09', 'next')).toBeNull();
    expect(isDateTitle('2026-13-45')).toBe(false);
    expect(isDateTitle('2026-10-05')).toBe(true);
  });
  it('同じ題名が複数あれば先に作られたほう', () => {
    const m = [meta('x', '2026-10-01', 5), meta('y', '2026-10-01', 2), meta('z', '2026-10-09')];
    expect(adjacentDateNote(m, '2026-10-09', 'prev')?.lid).toBe('y');
  });
});

function boot() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  return { root, d };
}
async function openPalette(root: HTMLElement, word: string): Promise<void> {
  root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
  await tick();
  const f = document.querySelector<HTMLInputElement>('[data-pkc-field="palette-filter"]')!;
  f.value = word;
  f.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('前の日・次の日のノートを開く(操作を探す)', () => {
  it('🔴 日付の題名のノートを開いていれば押せて、選ぶと隣の日のノートが開く', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    await openPalette(root, '前の日');
    const row = rowOf('open-prev-day-note');
    expect(row, '一覧に出ていない').toBeDefined();
    expect(row!.disabled).toBe(false);
    row!.click();
    await tick();
    expect(d.getState().selectedLid).toBe('a');
  });

  it('🔴 日付でないノート・端のノートでは押せず、ノートも増えない', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'f' });
    await openPalette(root, '次の日');
    expect(rowOf('open-next-day-note')!.disabled, '日付でない題名で押せる').toBe(true);
    document.querySelector<HTMLDialogElement>('dialog')?.close();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'c' });
    await openPalette(root, '次の日');
    expect(rowOf('open-next-day-note')!.disabled, 'いちばん新しい日で押せる').toBe(true);
    expect(d.getState().entryMetas.size, 'ノートが増えた').toBe(METAS.length);
  });
});
