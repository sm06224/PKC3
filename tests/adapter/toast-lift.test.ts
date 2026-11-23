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
