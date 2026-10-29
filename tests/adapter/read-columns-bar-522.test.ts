/** @vitest-environment happy-dom */
/**
 * 🔴 **段組みの切替を、読む面の帯(センターペイン)にも置く**(#522 の残り)。
 * 観測点: ① 帯に押せるボタンが実際に出る ② 押すと `Alt+C` と同じ関数(`cycleReadColumns`)に届き、画面の下に段数が出る
 * ③ 編集中は帯が入れ替わり、出ない。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

describe('読む面の帯の「段組みを切り替える」(#522)', () => {
  it('🔴 帯に出ていて、押すと段数の知らせが出る(Alt+C と同じ道)', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const shell = buildShell(root);
    const d = new Dispatcher();
    const said: string[] = [];
    bindActions(root, d, { showStatus: (m: string) => said.push(m) });
    const detail = new DetailRenderer(shell.detail);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    detail.render(d.getState());
    const btn = shell.detail.querySelector<HTMLElement>(
      '[data-pkc-field="detail-toolbar"] [data-pkc-action="cycle-read-columns"]',
    );
    expect(btn, '帯に段組みの切替が出ていない').not.toBeNull();
    expect(btn!.textContent).toContain('段組みを切り替える');
    btn!.click();
    expect(said.join('\n'), '押しても段数が出ない').toMatch(/本文の段組み: \d 段/);
  });

  it('編集に入ると帯は入れ替わり、段組みの切替は出ない', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const shell = buildShell(root);
    const d = new Dispatcher();
    const detail = new DetailRenderer(shell.detail);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    detail.render(d.getState());
    expect(d.getState().phase, '前提: 編集中').toBe('editing');
    expect(
      shell.detail.querySelector('[data-pkc-field="detail-toolbar"] [data-pkc-action="cycle-read-columns"]'),
    ).toBeNull();
  });
});
