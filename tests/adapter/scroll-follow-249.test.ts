/** @vitest-environment happy-dom */
/** #1163 依頼 249(案 A): 2 列の書き方で、右の表示を左のスクロールの割合に合わせて送る。 */
import { describe, expect, it } from 'vitest';
import { followScroll, followScrollTop, scrollRatio } from '../../src/adapter/ui/render/scroll-ratio';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';

const box = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({ scrollTop, scrollHeight, clientHeight });

describe('右の表示を左の割合に合わせる(依頼 249)', () => {
  it('割合は 送った量 ÷ 送れる幅(0〜1 に丸める)', () => {
    expect(scrollRatio(box(0, 1000, 200))).toBe(0);
    expect(scrollRatio(box(400, 1000, 200))).toBe(0.5);
    expect(scrollRatio(box(800, 1000, 200))).toBe(1);
    expect(scrollRatio(box(900, 1000, 200))).toBe(1);
    expect(scrollRatio(box(10, 100, 200)), '送れる幅が無い').toBe(0);
  });

  it('🔴 左が半分なら、右も送れる幅の半分へ', () => {
    expect(followScrollTop(box(400, 1000, 200), box(0, 3000, 500))).toBe(1250);
    expect(followScrollTop(box(400, 1000, 200), box(0, 300, 500)), '右に送る幅が無い').toBe(0);
  });

  it('🔴 scroll が何度来ても、右を書くのは 1 描画に 1 回(最後の位置で)', async () => {
    const left = document.createElement('textarea');
    const right = document.createElement('div');
    document.body.append(left, right);
    for (const [el, h, c] of [[left, 1000, 200], [right, 3000, 500]] as const) {
      Object.defineProperty(el, 'scrollHeight', { value: h, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: c, configurable: true });
    }
    let writes = 0;
    let top = 0;
    Object.defineProperty(right, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        writes += 1;
        top = v;
      },
    });
    followScroll(left, right);
    for (const t of [100, 200, 400]) {
      left.scrollTop = t;
      left.dispatchEvent(new Event('scroll'));
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(writes, '来るたびに右を書いている').toBe(1);
    expect(top).toBe(1250);
    // ⚠ 右が外れた(編集を抜けた)後は書かない
    right.remove();
    left.scrollTop = 0;
    left.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(writes, '外れた右を書いた').toBe(1);
  });

  it('割り切れない割合は丸める / 範囲の外は 0〜1 に丸める', () => {
    expect(followScrollTop(box(1, 4, 1), box(0, 11, 1))).toBe(3);
    expect(followScrollTop(box(-5, 1000, 200), box(0, 3000, 500))).toBe(0);
  });

  it('🔴 左の scroll で右が付いて行く(1 描画に 1 回)/ 外すと動かない', async () => {
    const left = document.createElement('textarea');
    const right = document.createElement('div');
    document.body.append(left, right);
    const size = (el: HTMLElement, h: number, c: number) => {
      Object.defineProperty(el, 'scrollHeight', { value: h, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: c, configurable: true });
    };
    size(left, 1000, 200);
    size(right, 3000, 500);
    const off = followScroll(left, right);
    left.scrollTop = 400;
    left.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(right.scrollTop, '右が付いて来ない').toBe(1250);
    off();
    left.scrollTop = 0;
    left.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(right.scrollTop, '外したのに動いた').toBe(1250);
  });
});

/** 🔴 配線: 2 列の編集欄を組むと、左の欄の scroll で右の表示が付いて行く(#1163 依頼 249)。 */

describe('2 列の編集欄に配線されている(依頼 249)', () => {
  it('🔴 左の原文を送ると、右の表示も同じ割合へ送られる', async () => {
    localStorage.setItem('pkc3.editor-mode', 'split');
    try {
      const root = document.createElement('div');
      document.body.append(root);
      const d = new Dispatcher();
      const detail = new DetailRenderer(buildShell(root).detail);
      d.onState((s) => detail.render(s));
      const meta: EntryMeta = { lid: 'n1', title: 'あ', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
      d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
      d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
      d.dispatch({ type: 'START_EDIT' });
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-region="editor-split"] [data-pkc-field="editor-body"]');
      const preview = root.querySelector<HTMLElement>('[data-pkc-region="editor-preview"]');
      expect(ta, '前提: 2 列の欄が無い').not.toBeNull();
      expect(preview).not.toBeNull();
      for (const [el, h, c] of [[ta!, 1000, 200], [preview!, 3000, 500]] as const) {
        Object.defineProperty(el, 'scrollHeight', { value: h, configurable: true });
        Object.defineProperty(el, 'clientHeight', { value: c, configurable: true });
      }
      ta!.scrollTop = 400;
      ta!.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 30));
      expect(preview!.scrollTop, '右が付いて来ない(配線されていない)').toBe(1250);
    } finally {
      localStorage.removeItem('pkc3.editor-mode');
    }
  });
});
