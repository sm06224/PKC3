/** @vitest-environment happy-dom */
/**
 * 🔴 **`buildPressedButton` が、CSS の共有属性を必ず立てる**(#1038 段J-2)。
 *
 * `app.css` の濃さの規則は `[data-pkc-choice-btn][aria-pressed='true']` の
 * **1 本**だけ(`choice-btn-pressed-css.test.ts`)なので、この属性が付かない
 * ボタンは region に依らず**永久に濃く見えない**。ここは JS 側の門。
 */
import { describe, expect, it } from 'vitest';
import { buildPressedButton, buildChoiceRow } from '@adapter/ui/render/choice-buttons';

describe('buildPressedButton: CSS 共有属性(data-pkc-choice-btn)', () => {
  it('🔴 単体のボタンに data-pkc-choice-btn が立つ', () => {
    const btn = buildPressedButton({
      action: 'noop',
      dataAttr: 'data-pkc-x-value',
      value: 'a',
      label: 'A',
      pressed: false,
    });
    expect(btn.hasAttribute('data-pkc-choice-btn'), '共有属性が立っていない').toBe(true);
  });

  it('🔴 buildChoiceRow が並べたボタン全部に立つ(数え落としを防ぐ)', () => {
    const row = buildChoiceRow({
      field: 'x-select',
      ariaLabel: 'X',
      action: 'set-x',
      dataAttr: 'data-pkc-x-value',
      choices: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      currentId: 'b',
    });
    const btns = [...row.querySelectorAll('button')];
    expect(btns, 'ボタンが 1 つも無い(前提が崩れている)').toHaveLength(3);
    for (const b of btns) {
      expect(b.hasAttribute('data-pkc-choice-btn'), `${b.textContent} に共有属性が無い`).toBe(true);
    }
  });
});
