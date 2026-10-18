/** @vitest-environment happy-dom */
/**
 * 🔴 **括弧の自動補完は、全文を編集する画面でも使う**(台帳 #1852 / 依頼 201。Gemini 回答:202・203 が効く形に)。
 * 規則そのもの(補う場所・補わない場所)は `tests/features/auto-pair-context.test.ts`。ここは配線を見る。
 * 各項に**対照群**を置く(1 行ずつ編集する画面と同じ規則に乗っていること)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function setup(field: string, value: string, caret: number, selEnd: number = caret): HTMLTextAreaElement {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML = `<div data-pkc-region="detail"><textarea data-pkc-field="${field}"></textarea></div>`;
  document.body.append(root);
  bindActions(root, new Dispatcher(), {});
  const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
  ta.value = value;
  ta.setSelectionRange(caret, selEnd);
  return ta;
}

const press = (ta: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  ta.dispatchEvent(e);
  return e;
};

describe('全文の編集欄の括弧の自動補完(依頼 201)', () => {
  it('「(」を打つと「)」が付き、カーソルは対の間に入る', () => {
    const ta = setup('editor-body', 'あ', 1);
    const e = press(ta, '(');
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('あ()');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 2]);
  });

  it('閉じを打つと、すぐ右の閉じを通り抜ける(二重にしない)', () => {
    const ta = setup('editor-body', 'あ()', 2);
    press(ta, ')');
    expect(ta.value).toBe('あ()');
    expect(ta.selectionStart).toBe(3);
  });

  it('補った直後の Backspace は、対の両方を消す', () => {
    const ta = setup('editor-body', 'あ()', 2);
    const e = press(ta, 'Backspace');
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('あ');
  });

  it('対照群: 数式の中・表の行では補わない(1 行ずつ編集する画面と同じ規則)', () => {
    const math = setup('editor-body', '$$\n', 3);
    expect(press(math, '(').defaultPrevented).toBe(false);
    expect(math.value).toBe('$$\n');
    const table = setup('editor-body', '| a | ', 6);
    expect(press(table, '(').defaultPrevented).toBe(false);
  });

  it('対照群: 補っていない所の Backspace は普通の Backspace', () => {
    const ta = setup('editor-body', '$$\n()', 4);
    expect(press(ta, 'Backspace').defaultPrevented).toBe(false);
    expect(ta.value).toBe('$$\n()');
  });

  it('Ctrl+[ のような字でない打鍵では補わない。選んだ字は括弧で囲む', () => {
    const ta = setup('editor-body', 'あ', 1);
    press(ta, '[', { ctrlKey: true });
    expect(ta.value).toBe('あ');
    const sel = setup('editor-body', 'ab', 0, 2);
    press(sel, '(');
    expect(sel.value).toBe('(ab)');
  });

  it('章の欄でも補う。題名の欄・SQL の欄には効かない', () => {
    const sec = setup('section-draft-input', '', 0);
    press(sec, '「');
    expect(sec.value).toBe('「」');
    const sql = setup('sql-input', '', 0);
    press(sql, '(');
    expect(sql.value).toBe('');
  });
});
