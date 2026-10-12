/** @vitest-environment happy-dom */
/**
 * 🔴 **長大なノートの印と、飛んだ後の合わせ直し**(#1467、裁定 21 = A)。
 *
 * 実ブラウザの観測(配置・飛び先の位置・Ctrl+F)は `tests/smoke/long-note.smoke.spec.ts`。
 * ここが見るのは **印が付く / 付かない** と、`settleJump` が **印の無い器では何もしない** こと。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { LONG_NOTE_ATTR, settleJump, syncLongNote } from '../../src/adapter/ui/render/long-note';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

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

function setup() {
  const scroller = document.createElement('div');
  scroller.setAttribute('data-pkc-region', 'detail');
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'detail');
  scroller.append(pane);
  document.body.append(scroller);
  return { scroller, r: new DetailRenderer(pane) };
}

function state(lid: string, body: string, phase: AppState['phase'] = 'ready'): AppState {
  return {
    ...initialState,
    phase,
    selectedLid: lid,
    entryMetas: new Map([[lid, meta(lid)]]),
    openBody: { lid, body, baseline: body, persisted: body, diskAhead: false },
  };
}

/** n 行の本文(5 行ごとに空行 = 段落)。 */
const bodyOf = (n: number): string =>
  Array.from({ length: n }, (_, i) => (i % 5 === 4 ? '' : `段落の行 ${i}`)).join('\n');

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const hostOf = (scroller: HTMLElement): HTMLElement | null =>
  scroller.querySelector<HTMLElement>('[data-pkc-field="detail-body"]');

describe('長大なノートの印(読む面)', () => {
  it('5,000 行を超えるノートの器にだけ印が付く', async () => {
    const { scroller, r } = setup();
    r.render(state('a', bodyOf(5001)));
    await settle();
    const host = hostOf(scroller);
    // 空振り防止 ── 本文が本当に描けている
    expect(host?.childElementCount ?? 0, '本文が描けていない').toBeGreaterThan(100);
    expect(host?.hasAttribute(LONG_NOTE_ATTR)).toBe(true);
  });

  it('🔴 5,000 行ちょうど・短いノートには印を付けない(1 ピクセルも変えない側)', async () => {
    const { scroller, r } = setup();
    r.render(state('b', bodyOf(5000)));
    await settle();
    const host = hostOf(scroller);
    expect(host?.childElementCount ?? 0, '本文が描けていない').toBeGreaterThan(100);
    expect(host?.hasAttribute(LONG_NOTE_ATTR)).toBe(false);
  });

  it('長大なノートが短くなったら、印を外す(器は使い回される)', async () => {
    const { scroller, r } = setup();
    r.render(state('c', bodyOf(5001)));
    await settle();
    expect(hostOf(scroller)?.hasAttribute(LONG_NOTE_ATTR)).toBe(true);
    r.render(state('c', bodyOf(40)));
    await settle();
    expect(hostOf(scroller)?.hasAttribute(LONG_NOTE_ATTR), '短くなっても印が残った').toBe(false);
  });
});

describe('ライブエディタには印を付けない(打鍵の応答を守る)', () => {
  const liveOf = (scroller: HTMLElement): HTMLElement | null =>
    scroller.querySelector<HTMLElement>('[data-pkc-region="editor-live"]');
  const wait = async (scroller: HTMLElement): Promise<void> => {
    // 描くのはワーカー(失敗時は同期の経路)── 塊が入るまで待つ
    for (let i = 0; i < 50 && (liveOf(scroller)?.childElementCount ?? 0) < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('🔴 5,000 行を超えるノートでも、編集の器には印を付けない(塊は普通に配置する)', async () => {
    const { scroller, r } = setup();
    r.render(state('e', bodyOf(5001), 'editing'));
    await wait(scroller);
    // 空振り防止 ── 編集の器に塊が本当に入っている(入っていなければ「付いていない」は何も言わない)
    expect(liveOf(scroller)?.childElementCount ?? 0, '編集の本文が描けていない').toBeGreaterThan(100);
    expect(liveOf(scroller)?.hasAttribute(LONG_NOTE_ATTR)).toBe(false);
  });
});

describe('syncLongNote', () => {
  it('付ける / 外すが冪等', () => {
    const el = document.createElement('div');
    syncLongNote(el, bodyOf(6000));
    syncLongNote(el, bodyOf(6000));
    expect(el.hasAttribute(LONG_NOTE_ATTR)).toBe(true);
    syncLongNote(el, 'x');
    syncLongNote(el, 'x');
    expect(el.hasAttribute(LONG_NOTE_ATTR)).toBe(false);
  });
});

describe('settleJump', () => {
  afterEach(() => vi.useRealTimers());

  /** 次の描画を 2 回進める(happy-dom の rAF は timer で動く)。 */
  const frames = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(100);
  };

  it('印の付いた器の中では、2 フレーム後に 1 度だけ go を呼ぶ', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    host.setAttribute(LONG_NOTE_ATTR, '');
    const el = document.createElement('p');
    host.append(el);
    document.body.append(host);
    const go = vi.fn();
    settleJump(el, go);
    expect(go, '飛んだ直後には呼ばない(周りが描かれる前)').not.toHaveBeenCalled();
    await frames();
    expect(go).toHaveBeenCalledTimes(1);
    await frames();
    expect(go, '1 度だけ').toHaveBeenCalledTimes(1);
    host.remove();
  });

  it('🔴 合わせ直すのは 2 フレーム後(1 フレーム目は周りが描かれて実寸になる時間)', () => {
    const queue: FrameRequestCallback[] = [];
    const win = window as unknown as { requestAnimationFrame: typeof requestAnimationFrame };
    const real = win.requestAnimationFrame;
    win.requestAnimationFrame = ((cb: FrameRequestCallback) => queue.push(cb)) as typeof requestAnimationFrame;
    try {
      const host = document.createElement('div');
      host.setAttribute(LONG_NOTE_ATTR, '');
      const el = document.createElement('p');
      host.append(el);
      document.body.append(host);
      const go = vi.fn();
      settleJump(el, go);
      queue.shift()!(0); // 1 フレーム目
      expect(go, '1 フレーム目で合わせた').not.toHaveBeenCalled();
      queue.shift()!(0); // 2 フレーム目
      expect(go).toHaveBeenCalledTimes(1);
      host.remove();
    } finally {
      win.requestAnimationFrame = real;
    }
  });

  it('🔴 印の無い器(5,000 行以下)では何もしない', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const el = document.createElement('p');
    host.append(el);
    document.body.append(host);
    const go = vi.fn();
    settleJump(el, go);
    await frames();
    expect(go).not.toHaveBeenCalled();
    host.remove();
  });

  it('user が動かしたら手を離す', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    host.setAttribute(LONG_NOTE_ATTR, '');
    const el = document.createElement('p');
    host.append(el);
    document.body.append(host);
    const go = vi.fn();
    settleJump(el, go);
    document.dispatchEvent(new Event('wheel'));
    await frames();
    expect(go, '手を動かしたのに引き戻した').not.toHaveBeenCalled();
    host.remove();
  });
});
