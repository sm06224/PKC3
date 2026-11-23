/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { installToastLift } from '../../src/adapter/ui/render/toast-lift';

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function setup(append: { top: number; bottom: number; hidden?: boolean }) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-pkc-region="shell"><main data-pkc-region="center"><button data-pkc-axis="y"></button><div data-pkc-region="append"></div></main></div>';
  document.body.append(root);
  const center = root.querySelector<HTMLElement>('[data-pkc-region="center"]')!;
  const ap = root.querySelector<HTMLElement>('[data-pkc-region="append"]')!;
  const grip = root.querySelector<HTMLElement>('[data-pkc-axis="y"]')!;
  center.getBoundingClientRect = () => rect(0, 800);
  ap.getBoundingClientRect = () => rect(append.top, append.bottom);
  grip.getBoundingClientRect = () => rect(append.top - 8, append.top);
  ap.hidden = append.hidden === true;
  grip.hidden = append.hidden === true;
  const stop = installToastLift(root);
  return { shell: root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!, stop };
}

describe('toast-lift ── 浮き札を追記欄の真上へ上げる量', () => {
  it('🔴 本文のマスの下端 − 追記欄(と掴む帯)の上端を --pkc-toast-lift に書く', () => {
    const { shell, stop } = setup({ top: 700, bottom: 800 });
    // 掴む帯(top = 692)のほうが上 → 800 - 692
    expect(shell.style.getPropertyValue('--pkc-toast-lift')).toBe('108px');
    stop();
  });
  it('🔴 追記欄が畳まれて(hidden)場所を取らないときは 0 ── 本文の下端に付く(対照: 出ているときは非 0)', () => {
    const shown = setup({ top: 700, bottom: 800 });
    expect(shown.shell.style.getPropertyValue('--pkc-toast-lift')).not.toBe('0px');
    const hidden = setup({ top: 700, bottom: 800, hidden: true });
    expect(hidden.shell.style.getPropertyValue('--pkc-toast-lift')).toBe('0px');
  });
});

describe('toast-lift ── 大きさ・畳みの変化で測り直す(ResizeObserver / MutationObserver を実際に鳴らす)', () => {
  it('🔴 追記欄が畳まれる(hidden)・掴む帯が動くと、観測が鳴って測り直す(空振り防止: 鳴らさなければ値は変わらない)', () => {
    const ros: Array<{ cb: () => void; targets: Element[] }> = [];
    const mos: Array<{ cb: () => void }> = [];
    class FakeRO {
      targets: Element[] = [];
      constructor(public cb: () => void) {
        ros.push(this);
      }
      observe(t: Element): void {
        this.targets.push(t);
      }
      disconnect(): void {}
    }
    class FakeMO {
      constructor(public cb: () => void) {
        mos.push(this);
      }
      observe(): void {}
      disconnect(): void {}
    }
    const prevRO = globalThis.ResizeObserver;
    const prevMO = globalThis.MutationObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeRO;
    (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = FakeMO;
    try {
      const { shell, stop } = setup({ top: 700, bottom: 800 });
      expect(shell.style.getPropertyValue('--pkc-toast-lift')).toBe('108px');
      expect(ros.length, 'ResizeObserver を使っていない').toBe(1);
      expect(mos.length, 'MutationObserver を使っていない').toBe(1);
      const root = shell.parentElement!;
      const ap = root.querySelector<HTMLElement>('[data-pkc-region="append"]')!;
      const grip = root.querySelector<HTMLElement>('[data-pkc-axis="y"]')!;
      // 鳴らさない間は変わらない(対照)
      ap.hidden = true;
      grip.hidden = true;
      expect(shell.style.getPropertyValue('--pkc-toast-lift'), '鳴らしていないのに測り直した').toBe('108px');
      mos[0]!.cb();
      expect(shell.style.getPropertyValue('--pkc-toast-lift'), '畳まれたのに測り直さない').toBe('0px');
      // 追記欄が伸びる(大きさの変化)
      ap.hidden = false;
      grip.hidden = false;
      ap.getBoundingClientRect = () => rect(600, 800);
      grip.getBoundingClientRect = () => rect(592, 600);
      ros[0]!.cb();
      expect(shell.style.getPropertyValue('--pkc-toast-lift')).toBe('208px');
      expect(ros[0]!.targets.length, 'center と append を観測していない').toBe(2);
      stop();
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = prevRO;
      (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = prevMO;
    }
  });
});
