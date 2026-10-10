/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { captureReadAnchor, resolveReadAnchor } from '../../src/adapter/ui/render/read-anchor';

/** 塊を `heights` の高さで積んだ器(配置は差し込む ── happy-dom は持たない)。 */
function board(heights: number[], lines: (number | null)[] = heights.map((_, i) => i * 3)) {
  const scroller = document.createElement('div');
  const host = document.createElement('div');
  scroller.append(host);
  const blocks = heights.map((_, i) => {
    const el = document.createElement('p');
    const line = lines[i];
    if (line !== null && line !== undefined) el.setAttribute('data-pkc-source-line', String(line));
    host.append(el);
    return el;
  });
  let hs = heights;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
  blocks.forEach((el, i) => {
    el.getBoundingClientRect = () => {
      // ⚠ 畳んだ塊(`hidden`)は、実ブラウザでは位置も大きさも全部 0 を返す
      if (hs[i] === 0) return { top: 0, bottom: 0, height: 0 } as DOMRect;
      const y = hs.slice(0, i).reduce((a, b) => a + b, 0) - scroller.scrollTop;
      return { top: y, bottom: y + hs[i]!, height: hs[i]! } as DOMRect;
    };
  });
  return {
    scroller,
    host,
    setHeights: (next: number[]) => {
      hs = next;
    },
  };
}

describe('読んでいた場所の目印(#1490)', () => {
  it('画面の先頭の塊と、その中のずれを憶える', () => {
    const { scroller, host } = board(Array(20).fill(100));
    scroller.scrollTop = 1050;
    expect(captureReadAnchor(host, scroller)).toEqual({ line: 30, offset: 50 });
  });

  it('🔴 塊の下端がちょうど画面の上端なら、その塊ではなく次の塊を目印にする', () => {
    const { scroller, host } = board(Array(20).fill(100));
    scroller.scrollTop = 1000; // 10 番目(行 27)の下端 = 画面の上端
    expect(captureReadAnchor(host, scroller)).toEqual({ line: 30, offset: 0 });
  });

  it('🔴 配置を持たない(高さ 0)ときは目印を作らない ── px で戻させる', () => {
    const { scroller, host } = board(Array(20).fill(0));
    scroller.scrollTop = 500;
    expect(captureReadAnchor(host, scroller)).toBeNull();
  });

  it('行番号を持たない塊は飛ばして、次の塊を目印にする', () => {
    const { scroller, host } = board(Array(5).fill(100), [0, null, null, 9, 12]);
    scroller.scrollTop = 150;
    expect(captureReadAnchor(host, scroller)).toEqual({ line: 9, offset: -150 });
  });

  it('戻すときは目印の塊のいまの位置 + ずれ', () => {
    const { scroller, host, setHeights } = board(Array(20).fill(100));
    setHeights([300, 300, 100, ...Array(17).fill(100)]);
    scroller.scrollTop = 0;
    expect(resolveReadAnchor(host, scroller, { line: 30, offset: 50 })).toBe(1450);
  });

  it('目印の塊が無ければ null(本文が変わった)', () => {
    const { scroller, host } = board(Array(5).fill(100));
    expect(resolveReadAnchor(host, scroller, { line: 999, offset: 0 })).toBeNull();
  });
});

describe('読んでいた場所の目印 ── 端の形(#1490 レビュー)', () => {
  it('🔴 畳んだ章(高さ 0)の塊が挟まっても、画面の先頭の塊を選ぶ', () => {
    // 0〜9 は 100px、10〜14 は畳んで 0、15〜 は 100px。画面の先頭 = 5 番目(行 15)の 50px 下
    // ⚠ 二分探索の最初の比較が畳んだ塊(12 番目)に当たる配置 ── 位置 0 を「上」と読むと、左半分を捨てる
    const hs = [...Array(10).fill(100), ...Array(5).fill(0), ...Array(10).fill(100)];
    const { scroller, host } = board(hs);
    scroller.scrollTop = 550;
    expect(captureReadAnchor(host, scroller)).toEqual({ line: 15, offset: 50 });
  });

  it('🔴 戻す先の塊が高さ 0 なら null(畳まれた塊へ合わせない)', () => {
    const { scroller, host } = board([100, 0, 100]);
    expect(resolveReadAnchor(host, scroller, { line: 3, offset: 0 })).toBeNull();
  });

  it('戻す計算は、いまの送り量に依らない', () => {
    const { scroller, host } = board(Array(20).fill(100));
    scroller.scrollTop = 700;
    expect(resolveReadAnchor(host, scroller, { line: 30, offset: 50 })).toBe(1050);
  });

  it('先頭より上へは戻さない(ずれが負でも 0 で止める)', () => {
    const { scroller, host } = board(Array(5).fill(100));
    expect(resolveReadAnchor(host, scroller, { line: 0, offset: -80 })).toBe(0);
  });
});
