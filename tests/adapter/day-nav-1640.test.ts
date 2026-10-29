/** @vitest-environment happy-dom */
/**
 * 🔴 **日付ノートの上の「‹ 前の日 / 次の日 ›」**(#1640 項 2)。
 * 出る条件(題名が日付のときだけ)・押せる条件(その向きに日付ノートがある)・押した先(ノートがある日だけ飛ぶ)を見る。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, title: string, order = 1): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function stateOn(metas: EntryMeta[], lid: string): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid, body: '本文' }).state;
  return s;
}

const METAS = [meta('a', '2026-10-10'), meta('b', '2026-10-12'), meta('c', '2026-10-20'), meta('x', '買い物')];

async function paint(lid: string): Promise<HTMLElement> {
  const root = document.createElement('div');
  const detail = new DetailRenderer(buildShell(root).detail);
  detail.render(stateOn(METAS, lid));
  await settle();
  return root.querySelector<HTMLElement>('[data-pkc-field="detail-day-nav"]')!;
}

describe('日付ノートの前後へ飛ぶ (#1640 項 2)', () => {
  it('題名が日付のノートでは、前の日・次の日が出る(間の日が無くても、ある日へ飛ぶ)', async () => {
    const nav = await paint('b');
    expect(nav.hidden).toBe(false);
    const [prev, next] = [...nav.querySelectorAll<HTMLButtonElement>('button')] as [HTMLButtonElement, HTMLButtonElement];
    expect(prev.textContent).toBe('‹ 前の日');
    expect(next.textContent).toBe('次の日 ›');
    expect(prev.disabled).toBe(false);
    expect(next.title).toContain('2026-10-20');
  });

  it('いちばん古い日の「前の日」は押せない(次の日は押せる)', async () => {
    const nav = await paint('a');
    const [prev, next] = [...nav.querySelectorAll<HTMLButtonElement>('button')] as [HTMLButtonElement, HTMLButtonElement];
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
  });

  it('題名が日付でないノートでは何も出ない', async () => {
    const nav = await paint('x');
    expect(nav.hidden).toBe(true);
    expect(nav.querySelector('button')).toBeNull();
  });

  it('押すと、ノートがある隣の日が選ばれる', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const shell = buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    const detail = new DetailRenderer(shell.detail);
    d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: '本文' });
    detail.render(d.getState());
    shell.detail.querySelector<HTMLElement>('[data-pkc-dir="next"]')!.click();
    expect(d.getState().selectedLid).toBe('c');
    detail.render(d.getState());
    shell.detail.querySelector<HTMLElement>('[data-pkc-dir="prev"]')!.click();
    expect(d.getState().selectedLid).toBe('b');
  });
});
