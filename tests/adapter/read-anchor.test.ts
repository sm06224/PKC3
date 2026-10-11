/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureReadAnchor,
  HOLD_MS,
  HOLD_STOP_EVENTS,
  HOLD_TOLERANCE_PX,
  installReadAnchorHold,
  realignTarget,
  resolveReadAnchor,
} from '../../src/adapter/ui/render/read-anchor';

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

describe('戻した後の合わせ直し(#1525)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('realignTarget:許容内・目印なしは書かない、外れていれば目印の位置', () => {
    expect(realignTarget(null, 100)).toBeNull();
    expect(realignTarget(100 + HOLD_TOLERANCE_PX, 100)).toBeNull();
    expect(realignTarget(1450, 100)).toBe(1450);
    // 🔑 下限:許容が広すぎると、数 px のずれを直さない(5px は書く)
    expect(realignTarget(105, 100)).toBe(105);
  });

  /** ResizeObserver の差し込み。`fire()` で「本文の高さが変わった」を撃つ。`live()` は observe 中の数。 */
  function stubRO() {
    const cbs = new Map<object, () => void>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          cbs.set(this, cb);
        }
        observe() {}
        disconnect() {
          cbs.delete(this);
        }
      },
    );
    return { fire: () => [...cbs.values()].forEach((cb) => cb()), live: () => cbs.size };
  }

  /** 台:行 30 の塊(index 10)が、戻した瞬間は 10px しかない。`grow()` で 100px に焼けた状態にする。 */
  function setup() {
    const ro = stubRO();
    const b = board(Array(20).fill(100));
    b.setHeights([...Array(10).fill(100), 10, ...Array(9).fill(100)]);
    b.scroller.scrollTop = 1060; // 戻した直後の位置(塊の外へはみ出している)
    const hold = installReadAnchorHold(b.host, b.scroller, { line: 30, offset: 60 });
    return { ...ro, ...b, hold, grow: () => b.setHeights(Array(20).fill(100)) };
  }

  it('目印の塊が低いうちに戻しても、高さが変わったら目印の位置へ引き直す', () => {
    const t = setup();
    t.grow();
    t.fire();
    expect(t.scroller.scrollTop).toBe(1060);
    // 対照:もう一度ずれたら、もう一度引き直す(1 回きりではない)
    t.scroller.scrollTop = 1200;
    t.fire();
    expect(t.scroller.scrollTop).toBe(1060);
  });

  it('5px のずれは書く(許容が広すぎない)', () => {
    const t = setup();
    t.grow();
    t.scroller.scrollTop = 1055;
    t.fire();
    expect(t.scroller.scrollTop).toBe(1060);
  });

  it('止める入力の種類は 4 つ(期待値は実装の配列から作らない)', () => {
    expect([...HOLD_STOP_EVENTS]).toEqual(['wheel', 'touchstart', 'pointerdown', 'keydown']);
  });

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('文書のどこかに %s が入ったら、もう引き戻さない(器の外からでも)', (ev) => {
    const t = setup();
    // 器の外(文書)で起きた入力 ── 目次・探す・リンク先の列など
    document.dispatchEvent(new Event(ev));
    t.grow();
    t.scroller.scrollTop = 400;
    t.fire();
    expect(t.scroller.scrollTop).toBe(400);
  });

  it('自分が書いていない送り(入力の無い移動)が起きたら、もう引き戻さない', () => {
    const t = setup();
    t.scroller.scrollTop = 400; // scrollIntoView 等
    t.scroller.dispatchEvent(new Event('scroll'));
    t.grow();
    t.fire();
    expect(t.scroller.scrollTop).toBe(400);
  });

  it('高さが変わった直後の送り(スクロールアンカーの調整)は数えない', () => {
    const t = setup();
    let sh = 5000;
    Object.defineProperty(t.scroller, 'scrollHeight', { get: () => sh, configurable: true });
    sh = 6000; // 高さが変わった
    t.scroller.scrollTop = 1300; // ブラウザが調整した
    t.scroller.dispatchEvent(new Event('scroll'));
    t.grow();
    t.fire();
    expect(t.scroller.scrollTop).toBe(1060);
  });

  it('時間が過ぎたら止まる(高さが変わらなくても。常駐させない)', () => {
    vi.useFakeTimers();
    const t = setup();
    expect(t.live()).toBe(1);
    vi.advanceTimersByTime(HOLD_MS + 1);
    expect(t.live(), '時間切れで observer が残っている').toBe(0);
    t.grow();
    t.scroller.scrollTop = 400;
    t.fire();
    expect(t.scroller.scrollTop).toBe(400);
  });

  it('dispose で observer も listener も外れる', () => {
    const t = setup();
    t.hold.dispose();
    expect(t.live()).toBe(0);
    t.grow();
    t.scroller.scrollTop = 400;
    t.fire();
    expect(t.scroller.scrollTop).toBe(400);
  });
});
