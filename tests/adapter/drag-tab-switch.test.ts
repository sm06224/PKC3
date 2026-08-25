/** @vitest-environment happy-dom */
/**
 * #402 ③: **掴んだまま、別の面へ持っていける**。
 *
 * > user の物語: フォルダタブで行を掴んだ。予定タブの日付へ落としたい。
 * > いまは**タブを押すのに一度手を離すしかない** ── 離すと掴んだ状態が消える。
 *
 * ## 🔴 実装の前に測った(#402 の本文が「測ってから着手する」と書いていた)
 *
 * PKC3 の左の列は**同じホストの中で `hidden` を入れ替える排他 pane** なので、
 * 面を変えた瞬間に**掴んでいた元の要素が `hidden` になる**。PKC2(面ごと差し替え)
 * とは前提が違うため、「drag が生き残るか」が機構の成否を決めていた。
 *
 * **実 Chromium で測った結果(2026-08-25)**: 掴んだ最中に元の面を `hidden` に
 * しても、行き先の `dragover` も `drop` も届いた
 * (`["dragstart","dragover","dragover","drop"]`)。⚠ `hidden` が本当に
 * 当たっていることも同じ回で確かめた ── 当たっていなければ「面を変えた」を
 * 1 度も試していないことになる(空振り)。
 *
 * ここが見るのは**時間の規律**である:通り過ぎただけでは変わらず、
 * 止まったら変わり、離したら変わらない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

const PKC_DRAG = 'application/x-pkc-lids';
const PKC_TASK_DRAG = 'application/x-pkc-task';

beforeEach(() => {
  document.body.textContent = '';
  vi.useFakeTimers();
});

function rig() {
  const root = document.createElement('div');
  document.body.append(root);
  const tabs: string[] = [];
  const d = new Dispatcher(initialState);
  bindActions(root, d, { setBrowse: (m) => void tabs.push(m) });
  const mk = (mode: string): HTMLElement => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'set-browse');
    b.setAttribute('data-pkc-browse', mode);
    root.append(b);
    return b;
  };
  const drag = (el: HTMLElement, type: string | null, kind = 'dragover'): void => {
    const ev = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: type === null ? { types: [] } : { types: [type], dropEffect: '' },
    });
    el.dispatchEvent(ev);
  };
  const end = (): void => {
    root.dispatchEvent(new Event('dragend', { bubbles: true }));
  };
  return { root, tabs, mk, drag, end };
}

describe('#402 ③ 掴んだまま面を変える', () => {
  it('🔴 タブの上で止まったら面が変わる', () => {
    const r = rig();
    r.drag(r.mk('schedule'), PKC_DRAG);
    expect(r.tabs, '止まる前に変わった').toEqual([]);
    vi.advanceTimersByTime(600);
    expect(r.tabs, '止まっても変わらない').toEqual(['schedule']);
  });

  it('🔴 通り過ぎただけでは変わらない(落とす先を見失わせない)', () => {
    const r = rig();
    const tab = r.mk('schedule');
    r.drag(tab, PKC_DRAG);
    vi.advanceTimersByTime(300);
    // タブの外へ抜ける
    r.drag(r.root, PKC_DRAG);
    vi.advanceTimersByTime(600);
    expect(r.tabs, '通り過ぎただけで変わった').toEqual([]);
  });

  it('🔴 離したら変わらない(離した後に画面が動かない)', () => {
    const r = rig();
    r.drag(r.mk('schedule'), PKC_DRAG);
    vi.advanceTimersByTime(300);
    r.end();
    vi.advanceTimersByTime(600);
    expect(r.tabs, '離した後に面が変わった').toEqual([]);
  });

  it('🔴 別のタブへ移ったら、そちらで数え直す', () => {
    const r = rig();
    const a = r.mk('schedule');
    const b = r.mk('filer');
    r.drag(a, PKC_DRAG);
    vi.advanceTimersByTime(500);
    r.drag(b, PKC_DRAG);
    vi.advanceTimersByTime(200);
    expect(r.tabs, '前のタブの残り時間で変わった').toEqual([]);
    vi.advanceTimersByTime(400);
    expect(r.tabs).toEqual(['filer']);
  });

  it('⚠ 同じタブに居る間は数え直さない(ずっと変わらない、を作らない)', () => {
    const r = rig();
    const tab = r.mk('schedule');
    // `dragover` は動かしている間ずっと飛んでくる
    for (let i = 0; i < 10; i++) {
      r.drag(tab, PKC_DRAG);
      vi.advanceTimersByTime(100);
    }
    expect(r.tabs, '数え直され続けて永久に変わらない').toEqual(['schedule']);
  });

  it('🔴 予定の札を運んでいるときも効く(2 種類の荷物とも)', () => {
    const r = rig();
    r.drag(r.mk('filer'), PKC_TASK_DRAG);
    vi.advanceTimersByTime(600);
    expect(r.tabs).toEqual(['filer']);
  });

  it('🔴 OS からのファイルでは効かない(落とすつもりの所が消える)', () => {
    const r = rig();
    r.drag(r.mk('schedule'), 'Files');
    vi.advanceTimersByTime(600);
    expect(r.tabs, 'ファイルを運んでいるのに面が変わった').toEqual([]);
  });

  it('⚠ タブは落とし先にならない(「タブに入れた」に見せない)', () => {
    const r = rig();
    const tab = r.mk('schedule');
    const ev = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: [PKC_DRAG], dropEffect: '' },
    });
    tab.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'タブが落とし先になっている').toBe(false);
  });
});
