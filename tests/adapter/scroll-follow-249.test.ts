/** @vitest-environment happy-dom */
/** #1163 依頼 249(案 A): 2 列の書き方で、右の表示を左のスクロールの割合に合わせて送る。 */
import { describe, expect, it } from 'vitest';
import { followScroll, followScrollTop, refollowScroll, scrollRatio } from '../../src/adapter/ui/render/scroll-ratio';
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

/**
 * 🔴 **描き直しの合わせ直しは、右が付いて行っている間だけ**(フル smoke `preview.smoke.spec.ts:171` で見つけた退行)。
 * ⚠ 直す前は描き直しのたびに右を左の割合へ置いたので、右を自分で送って読んでいた人が 1 字打つたびに引き戻された。
 */
describe('描き直しの合わせ直し(依頼 249 の退行の直し)', () => {
  function pair(rightHeight: number) {
    const left = document.createElement('textarea');
    const right = document.createElement('div');
    document.body.append(left, right);
    Object.defineProperty(left, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(left, 'clientHeight', { value: 200, configurable: true });
    let h = rightHeight;
    Object.defineProperty(right, 'scrollHeight', { get: () => h, configurable: true });
    Object.defineProperty(right, 'clientHeight', { value: 500, configurable: true });
    return { left, right, grow: (n: number) => (h = n) };
  }

  it('🔴 付いて行っている間は、右が伸びたら同じ割合へ合わせ直す', async () => {
    const { left, right, grow } = pair(3000);
    followScroll(left, right);
    left.scrollTop = 400;
    left.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(right.scrollTop).toBe(1250);
    grow(5500); // 描き直しで右が伸びた
    refollowScroll(left, right);
    expect(right.scrollTop, '付いて行っているのに合わせ直さない').toBe(2500);
  });

  it('🔴 右を自分で送っていたら、描き直しても引き戻さない', async () => {
    const { left, right, grow } = pair(3000);
    followScroll(left, right);
    left.scrollTop = 800; // 左は末尾(打っている所)
    left.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(right.scrollTop).toBe(2500);
    right.scrollTop = 800; // 右を自分で上へ送って読んでいる
    grow(3200);
    refollowScroll(left, right);
    expect(right.scrollTop, '自分で送った右を、打つたびに左の位置へ引き戻した').toBe(800);
    // 🔑 左を送れば、また付いて行く
    left.scrollTop = 400;
    left.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(right.scrollTop).toBe(1350);
    grow(5500);
    refollowScroll(left, right);
    expect(right.scrollTop, '付いて行き直したのに合わせ直さない').toBe(2500);
  });

  /** 本物のブラウザと同じく、scrollTop を送れる幅の端へ寄せる右。 */
  function clampingPair(rightHeight: number) {
    const p = pair(rightHeight);
    let top = 0;
    Object.defineProperty(p.right, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, p.right.scrollHeight - p.right.clientHeight));
      },
    });
    return { ...p, shrinkTo: (n: number) => { p.grow(n); p.right.scrollTop = top; } };
  }

  it('🔴 右が縮んでブラウザが端へ寄せても、付いて行くのをやめない(寄せたのは人ではない)', async () => {
    const { left, right, shrinkTo, grow } = clampingPair(3000);
    followScroll(left, right);
    left.scrollTop = 800; // 末尾で打っている
    left.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect(right.scrollTop).toBe(2500);
    shrinkTo(2300); // 末尾の行を消した ── ブラウザが 1800 へ寄せる
    expect(right.scrollTop, '前提: 端へ寄せられていない').toBe(1800);
    refollowScroll(left, right);
    expect(right.scrollTop).toBe(1800);
    grow(4000); // 足し直して伸びた
    refollowScroll(left, right);
    expect(right.scrollTop, '縮めた後から付いて行かなくなった').toBe(3500);
  });

  it('🔑 境目: 置いた所から 2px までは付いて行っていると読み、3px 動いていたら人が動かしたと読む', async () => {
    for (const [moved, follows] of [[2, true], [-2, true], [3, false], [-3, false]] as const) {
      const { left, right, grow } = pair(3000);
      followScroll(left, right);
      left.scrollTop = 400;
      left.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 30));
      right.scrollTop = 1250 + moved;
      grow(5500);
      refollowScroll(left, right);
      expect(right.scrollTop, `${moved}px ずれた右`).toBe(follows ? 2500 : 1250 + moved);
    }
  });

  it('⚠ まだ一度も置いていない右(先頭のまま)は、左の割合へ置く', () => {
    const { left, right } = pair(3000);
    left.scrollTop = 400;
    refollowScroll(left, right);
    expect(right.scrollTop).toBe(1250);
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

/** 🔴 配線: 描き直しの後の合わせ直しが detail に繋がっている(着地前レビュー ⚠2 ── 外すと単体では誰も気づけない)。 */
describe('描き直しの後の合わせ直しの配線(依頼 249)', () => {
  it('🔴 付いて行っている間に打って右が伸びたら、右は同じ割合へ送り直される', async () => {
    const { MarkdownClient } = await import('../../src/adapter/platform/render/markdown-client');
    localStorage.setItem('pkc3.editor-mode', 'split');
    try {
      const root = document.createElement('div');
      document.body.append(root);
      const d = new Dispatcher();
      const detail = new DetailRenderer(buildShell(root).detail, null, new MarkdownClient());
      d.onState((s) => detail.render(s));
      const meta: EntryMeta = { lid: 'n1', title: 'あ', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
      d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
      d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
      d.dispatch({ type: 'START_EDIT' });
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-region="editor-split"] [data-pkc-field="editor-body"]')!;
      const preview = root.querySelector<HTMLElement>('[data-pkc-region="editor-preview"]')!;
      expect(ta, '前提: 2 列の欄が無い').not.toBeNull();
      let previewHeight = 3000;
      Object.defineProperty(ta, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(ta, 'clientHeight', { value: 200, configurable: true });
      Object.defineProperty(preview, 'scrollHeight', { get: () => previewHeight, configurable: true });
      Object.defineProperty(preview, 'clientHeight', { value: 500, configurable: true });
      await new Promise((r) => setTimeout(r, 30));
      ta.scrollTop = 400;
      ta.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 30));
      expect(preview.scrollTop, '前提: 付いて行っていない').toBe(1250);
      previewHeight = 5500; // 描き直しで右が伸びる
      ta.value += '\n\n足した段落\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await expect.poll(() => preview.textContent ?? '', { timeout: 3000 }).toContain('足した段落');
      expect(preview.scrollTop, '描き直しの後に合わせ直していない(配線が外れた)').toBe(2500);
    } finally {
      localStorage.removeItem('pkc3.editor-mode');
    }
  });
});
