/** @vitest-environment happy-dom */
/**
 * 戻る・進むの行き先(NAV-1/2/3)と、最近開いたノートのピッカー(NAV-4)。
 *
 * 🔴 守る主張:
 * 1. システムのメッセージ / 処理の記録は履歴に積まない(積むと戻る・進むが dead click になる)
 * 2. 履歴の末尾といまの選択がずれたら、戻るは**末尾**へ着く(跳び越さない)
 * 3. 行き先が選べないときは次に選べる行き先へ進む
 * 4. ピッカーも他の「ノートを開く道」と同じく、断られたら理由を出す
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { canNavBack, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

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
    bodyChars: null,
  };
}

function booted(lids: string[]): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: lids.map(meta), relations: [] });
  return d;
}
const sel = (lid: string) => ({ type: 'SELECT_ENTRY', lid }) as const;

describe('戻る・進むの行き先がずれたとき', () => {
  it('🔴 メッセージを開いても履歴に積まない。戻ると直前のノート、進むは何も起きない', () => {
    const d = booted(['a', 'b']);
    d.dispatch(sel('a'));
    d.dispatch(sel('b'));
    d.dispatch({ type: 'MESSAGES_READ', lid: 'sys-messages' });
    expect(d.getState().selectedLid).toBe('sys-messages');
    expect(d.getState().selectionHistory.past, 'システムのノートが履歴に入った').toEqual(['a', 'b']);
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid, 'メッセージから戻っても直前のノートへ着かない').toBe('b');
    d.dispatch({ type: 'NAV_HISTORY', dir: 'forward' });
    expect(d.getState().selectedLid, '進む先が無いのに動いた').toBe('b');
  });

  it('🔴 メッセージを挟んでも、戻るが 1 件ずつ辿れる(a → b → msg → a → 戻る 2 回)', () => {
    const d = booted(['a', 'b']);
    d.dispatch(sel('a'));
    d.dispatch(sel('b'));
    d.dispatch({ type: 'MESSAGES_READ', lid: 'sys-messages' });
    d.dispatch(sel('a'));
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid).toBe('b');
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid).toBe('a');
  });

  it('🔴 別タブでいまのノートが消えて選択が外れたら、戻るは末尾へ着く(跳び越さない)', () => {
    const d = booted(['a', 'b', 'c']);
    for (const l of ['a', 'b', 'c']) d.dispatch(sel(l));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] });
    expect(d.getState().selectedLid).toBeNull();
    expect(canNavBack(d.getState())).toBe(true);
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid, 'b を跳び越して a へ行った').toBe('b');
  });

  it('🔴 履歴が 1 件だけでも、選択が外れていれば戻れる', () => {
    const d = booted(['a', 'b']);
    d.dispatch(sel('a'));
    d.dispatch(sel('b'));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    expect(d.getState().selectionHistory.past).toEqual(['a']);
    expect(canNavBack(d.getState())).toBe(true);
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid).toBe('a');
  });

  it('🔴 行き先が選べないときは、次に選べる行き先へ進む(押しても動かない、を作らない)', () => {
    const d = booted(['a', 'b', 'c']);
    for (const l of ['a', 'b', 'c']) d.dispatch(sel(l));
    const st = d.getState();
    // 履歴にだけ居て一覧に居ない lid(掃除をすり抜けた場合)を差し込む
    const back = reduce(
      { ...st, selectionHistory: { past: ['a', 'ghost', 'c'], future: [] } },
      { type: 'NAV_HISTORY', dir: 'back' },
    );
    expect(back.state.selectedLid, 'ghost で止まった').toBe('a');
    const fwd = reduce(
      { ...st, selectedLid: 'a', selectionHistory: { past: ['a'], future: ['ghost', 'b'] } },
      { type: 'NAV_HISTORY', dir: 'forward' },
    );
    expect(fwd.state.selectedLid, '進むが ghost で止まった').toBe('b');
  });
});

describe('最近開いたノートのピッカー(NAV-4)', () => {
  it('🔴 編集中に選ぶと、選択は動かず理由が出る', async () => {
    resetAppDialogForTest();
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    bindActions(root, d, {});
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
    d.dispatch(sel('n1'));
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'a' });
    d.dispatch(sel('n2'));
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: 'b' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase).toBe('editing');
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', altKey: true, bubbles: true, cancelable: true }),
    );
    const rows = root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="entry-pick-row"]');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    rows[0]!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d.getState().selectedLid, '編集中に選択が動いた').toBe('n2');
    expect(d.getState().error, '断られた理由が出ていない').toContain('開いてください');
    resetAppDialogForTest();
  });
});
