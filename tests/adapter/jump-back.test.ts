/** @vitest-environment happy-dom */
/**
 * 🔴 **目次で飛んだ直後の「元の位置へ戻る」**(台帳 #1852 束 R1、依頼 86-1 B)。
 *
 * 観測点は「飛ぶと知らせの隣に押し口が出る / 押すと飛ぶ前のスクロール位置に戻る」。
 * 対照群: 別の知らせが上書きしたら畳む / 数秒で降ろす / 別のノートへ移った後は戻さない /
 * リンクで来た飛び(目次ではない)では出さない / 続けて飛んでも戻る先は最初の位置。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import {
  clearJumpBackOffer,
  currentJumpBackOffer,
  JUMP_BACK_OFFER_MS,
  jumpBackShown,
  offerJumpBack,
  restoreScroll,
  snapshotScroll,
} from '../../src/adapter/ui/render/jump-back';

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
let scroller: HTMLElement;
let h2: HTMLElement;
const store = new KeymapStore();

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  scroller = document.createElement('div');
  h2 = document.createElement('h2');
  h2.textContent = '第二章';
  scroller.append(h2);
  root.append(scroller);
  document.body.append(root);
  d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [META('a'), META('b')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  stop = bindActions(root, d, {}, store);
});
afterEach(() => {
  stop();
  clearJumpBackOffer();
  vi.useRealTimers();
});

function press(action: string): void {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', action);
  root.append(b);
  b.click();
}

describe('スクロール位置の控え', () => {
  it('飛ぶ箱すべての位置を控え、書き戻せる(画面から外れた箱は触らない)', () => {
    scroller.scrollTop = 120;
    const snap = snapshotScroll(h2);
    expect(snap.some(([el, top]) => el === scroller && top === 120)).toBe(true);
    scroller.scrollTop = 900; // 目次で飛んだ後
    restoreScroll(snap);
    expect(scroller.scrollTop).toBe(120);
    // 対照群: 画面から外れた箱には書かない
    scroller.remove();
    scroller.scrollTop = 5;
    restoreScroll(snap);
    expect(scroller.scrollTop).toBe(5);
  });
});

describe('飛んだ直後の「元の位置へ戻る」', () => {
  it('🔴 知らせと押し口が出て、押すと飛ぶ前の位置へ戻る', () => {
    scroller.scrollTop = 120;
    offerJumpBack(d, snapshotScroll(h2), '第二章');
    scroller.scrollTop = 900;
    const shown = d.getState().notice ?? '';
    expect(shown).toBe('「第二章」へ移動しました');
    expect(jumpBackShown(shown)).toBe(true);
    const btn = document.createElement('button');
    expect(paintStatusUndo(btn, d.getState(), shown), '押し口が出ない').toBe(true);
    expect(btn.getAttribute('data-pkc-action')).toBe('undo-jump');
    expect(btn.textContent).toBe('元の位置へ戻る');
    expect(btn.hidden).toBe(false);
    press('undo-jump');
    expect(scroller.scrollTop, '飛ぶ前の位置に戻っていない').toBe(120);
    expect(d.getState().notice).toBe('元の位置へ戻りました');
    expect(currentJumpBackOffer(), '戻した後も持っている').toBeNull();
    // 戻した後の知らせの隣には、押し口が出ない
    expect(paintStatusUndo(btn, d.getState(), d.getState().notice ?? '')).toBe(false);
    expect(btn.hidden).toBe(true);
  });

  it('別の知らせが上書きしたら押し口を畳む', () => {
    offerJumpBack(d, snapshotScroll(h2), '第二章');
    d.dispatch({ type: 'OP_NOTICE', message: 'コピーしました' });
    const btn = document.createElement('button');
    expect(paintStatusUndo(btn, d.getState(), d.getState().notice ?? '')).toBe(false);
  });

  it('数秒経つと知らせごと降ろす', () => {
    offerJumpBack(d, snapshotScroll(h2), '第二章');
    expect(currentJumpBackOffer()).not.toBeNull();
    vi.advanceTimersByTime(JUMP_BACK_OFFER_MS + 1);
    expect(currentJumpBackOffer()).toBeNull();
    expect(d.getState().notice).toBeNull();
  });

  it('🔴 続けて飛んでも、戻る先は最初に読んでいた位置', () => {
    scroller.scrollTop = 120;
    offerJumpBack(d, snapshotScroll(h2), '第二章');
    scroller.scrollTop = 900;
    offerJumpBack(d, snapshotScroll(h2), '第五章');
    scroller.scrollTop = 2000;
    expect(d.getState().notice).toBe('「第五章」へ移動しました');
    press('undo-jump');
    expect(scroller.scrollTop).toBe(120);
  });

  it('別のノートへ移った後は戻さない(理由を言う)', () => {
    scroller.scrollTop = 120;
    offerJumpBack(d, snapshotScroll(h2), '第二章');
    scroller.scrollTop = 900;
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    press('undo-jump');
    expect(scroller.scrollTop, '別のノートの位置を書き換えた').toBe(900);
    expect(d.getState().notice).toContain('戻せるものがありません');
  });

  it('長い題は知らせの中で切る', () => {
    offerJumpBack(d, snapshotScroll(h2), 'あ'.repeat(40));
    expect(d.getState().notice).toBe(`「${'あ'.repeat(24)}…」へ移動しました`);
  });
});

describe('目次の押し(toc-jump)から出る / リンクの飛びからは出ない', () => {
  function mountBody(): void {
    const detail = document.createElement('div');
    detail.setAttribute('data-pkc-region', 'detail');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    host.setAttribute('data-pkc-painted', 'a');
    const h = document.createElement('h2');
    h.id = 'dai2';
    h.textContent = '第二章';
    host.append(h);
    detail.append(host);
    root.append(detail);
  }

  it('🔴 toc-jump を押すと知らせと押し口が出る(アドレスは変えない)', async () => {
    mountBody();
    const go = document.createElement('button');
    go.setAttribute('data-pkc-action', 'toc-jump');
    go.setAttribute('data-pkc-toc-slug', 'dai2');
    root.append(go);
    const hash = window.location.hash;
    go.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(d.getState().notice).toBe('「第二章」へ移動しました');
    expect(currentJumpBackOffer()?.lid).toBe('a');
    expect(window.location.hash).toBe(hash);
  });

  it('対照群: 飛び先が無ければ出さない', async () => {
    mountBody();
    const go = document.createElement('button');
    go.setAttribute('data-pkc-action', 'toc-jump');
    go.setAttribute('data-pkc-toc-slug', 'ない');
    root.append(go);
    go.click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(currentJumpBackOffer()).toBeNull();
  });
});
