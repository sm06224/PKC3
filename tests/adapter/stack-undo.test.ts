/** @vitest-environment happy-dom */
/**
 * 🔴 **スタックを全部降ろした直後の「元に戻す」**(依頼 98-2。Gemini の回答「推薦どおり」= A)。
 *
 * 観測点は「知らせの隣の押し口が出る / 押すと降ろす前の並びが同じ順で戻る」。
 * 対照群: 別の知らせが上書きしたら畳む / 空のときは何も出ない / 降ろした後にノートが消えていたらその件は戻らない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import { clearStackOffer, currentStackOffer, STACK_OFFER_MS } from '../../src/adapter/ui/render/stack-undo';

const META = (lid: string): EntryMeta => ({
  lid,
  title: `ノート ${lid}`,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 0,
});

let root: HTMLElement;
let d: Dispatcher;
let stop: () => void;
const store = new KeymapStore();
const noop = (): void => {};

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [META('a'), META('b'), META('c')], relations: [] });
  stop = bindActions(root, d, {}, store);
});
afterEach(() => {
  stop();
  clearStackOffer();
  vi.useRealTimers();
});

function press(action: string): void {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', action);
  root.append(b);
  b.click();
}

function stackThree(): void {
  d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
  d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
  d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'c' });
}

describe('スタックを全部降ろした直後の「元に戻す」(依頼 98-2)', () => {
  it('🔴 降ろすと、知らせと押し口が出て、押すと降ろす前の並びが同じ順で戻る', () => {
    stackThree();
    expect(d.getState().splitLids, '前提: 上から c, b, a').toEqual(['c', 'b', 'a']);
    expect(runGlobalCommand('stack-clear', root, d, store, noop, noop)).toBe(true);
    expect(d.getState().splitLids).toEqual([]);
    const shown = d.getState().notice ?? '';
    expect(shown).toContain('3 件を降ろしました');
    expect(shown, '並びを残す方法が書かれていない').toContain('スタックを保存');
    expect(currentStackOffer()?.lids).toEqual(['c', 'b', 'a']);
    const btn = document.createElement('button');
    expect(paintStatusUndo(btn, d.getState(), shown), '押し口が出ない').toBe(true);
    expect(btn.getAttribute('data-pkc-action')).toBe('undo-stack-clear');
    expect(btn.textContent).toBe('元に戻す');
    press('undo-stack-clear');
    expect(d.getState().splitLids, '並びが同じ順で戻っていない').toEqual(['c', 'b', 'a']);
    expect(d.getState().notice).toContain('3 件');
    expect(currentStackOffer(), '戻した後も材料が残っている').toBeNull();
  });

  it('別の知らせが上書きしたら押し口を畳む(別の知らせが戻ると読ませない)', () => {
    stackThree();
    runGlobalCommand('stack-clear', root, d, store, noop, noop);
    const btn = document.createElement('button');
    expect(paintStatusUndo(btn, d.getState(), '別の知らせです')).toBe(false);
    expect(btn.hidden).toBe(true);
  });

  it('数秒経つと知らせごと降ろす', () => {
    stackThree();
    runGlobalCommand('stack-clear', root, d, store, noop, noop);
    vi.advanceTimersByTime(STACK_OFFER_MS + 10);
    expect(currentStackOffer()).toBeNull();
    expect(d.getState().notice ?? '').not.toContain('を降ろしました');
  });

  it('対照群: 空のスタックを降ろしても「元に戻す」は出ない', () => {
    expect(runGlobalCommand('stack-clear', root, d, store, noop, noop)).toBe(true);
    expect(currentStackOffer()).toBeNull();
  });

  it('降ろした後にノートが消えていたら、その件は戻さず、戻せた件数を言う', () => {
    stackThree();
    runGlobalCommand('stack-clear', root, d, store, noop, noop);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [META('a'), META('c')], relations: [] });
    press('undo-stack-clear');
    expect(d.getState().splitLids).toEqual(['c', 'a']);
    expect(d.getState().notice).toContain('2 件');
  });
});
