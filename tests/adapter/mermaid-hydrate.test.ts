/** @vitest-environment happy-dom */
/**
 * P8 段⑪: **図の面倒を見る根を、まとめて受ける**。
 *
 * 🔴 差分反映は「新しく入った要素」を**何個も**渡してくる。1 個ずつ呼ぶと
 *  - 要素の数だけ観測器(IntersectionObserver)と先読みループができる
 *  - **2 個目以降の根にある図が拾われない**実装でも、1 個だけの test なら緑になる
 *
 * ⚠ 観測点は「描けたか」ではなく「**観測を始めたか**」── 実際の焼き上げは
 * mermaid の読み込みが要るので、ここでは配線だけを見る。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { hydrateMermaid } from '../../src/adapter/ui/render/mermaid-hydrate';

const observed: Element[] = [];
let disconnected = 0;

class FakeIO {
  constructor(_cb: unknown) {
    void _cb;
  }
  observe(el: Element): void {
    observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnected += 1;
  }
}

beforeEach(() => {
  observed.length = 0;
  disconnected = 0;
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 器 1 個を含む塊(実際の markup と同じ入れ子)。 */
function block(src: string): HTMLElement {
  const outer = document.createElement('div');
  outer.className = 'pkc-md-block';
  const slot = document.createElement('div');
  slot.className = 'pkc-render-slot';
  const host = document.createElement('div');
  host.setAttribute('data-pkc-mermaid-src', src);
  slot.append(host);
  outer.append(slot);
  return outer;
}

describe('図の hydrate', () => {
  it('1 つの根の中の器を観測する', () => {
    const dispose = hydrateMermaid(block('graph TD\n A-->B'));
    expect(observed).toHaveLength(1);
    dispose();
    expect(disconnected).toBe(1);
  });

  it('🔴 **複数の根**を渡したら全部の器を観測する', () => {
    // ⚠ ここが本丸 ── 先頭の根しか見ない実装だと、差分で入った 2 個目以降の図が
    // **永久に描かれない**(白いままで、例外も出ない)
    const plain = document.createElement('p');
    const dispose = hydrateMermaid([plain, block('a'), block('b')]);
    expect(observed, '2 個目以降の根にある図を拾っていない').toHaveLength(2);
    // ⚠ 観測器は**1 本**(根の数だけ作らない)
    dispose();
    expect(disconnected).toBe(1);
  });

  it('⚠ 根そのものが器でも拾う(`querySelectorAll` は自分を含まない)', () => {
    const host = document.createElement('div');
    host.setAttribute('data-pkc-mermaid-src', 'x');
    hydrateMermaid([host]);
    expect(observed).toHaveLength(1);
  });

  it('図が無ければ観測器を作らない(空の後始末が返る)', () => {
    const dispose = hydrateMermaid([document.createElement('p')]);
    expect(observed).toHaveLength(0);
    dispose();
    expect(disconnected, '器が無いのに観測器を作った').toBe(0);
  });
});
