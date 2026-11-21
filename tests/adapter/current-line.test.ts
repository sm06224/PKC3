/** @vitest-environment happy-dom */
/**
 * 🔴 現在行の強調(#2001 段 4)── 配線(焦点・選び・設定・4 つの欄・IME)を DOM で確かめる。
 * ⚠ happy-dom は座標が全部 0 なので、矩形は `Range` の測り(`getClientRects`)を差し替えて渡す。
 *   本物の位置・折り返し・スクロールは `tests/smoke/current-line.smoke.spec.ts` が実ブラウザで見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindCurrentLine,
  CURRENT_LINE_ATTR,
  CURRENT_LINE_HEIGHT_VAR,
  CURRENT_LINE_TOP_VAR,
  patchText,
} from '../../src/adapter/ui/render/current-line';
import { EDITING_FIELD_KINDS, EDITING_FIELD_NAMES } from '../../src/adapter/ui/editing-field';

let enabled = true;
let rects: { top: number; bottom: number }[] = [{ top: 20, bottom: 36 }];
let asked: Array<[number, number]> = [];

function setup(field: string) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.innerHTML = `<textarea data-pkc-field="${field}"></textarea><input data-pkc-field="title">`;
  document.body.append(root);
  const ta = root.querySelector('textarea')!;
  const unbind = bindCurrentLine(root, { enabled: () => enabled });
  return { root, ta, unbind, other: root.querySelector('input')! };
}
const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

beforeEach(() => {
  enabled = true;
  rects = [{ top: 20, bottom: 36 }];
  asked = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  const R = document.createRange().constructor.prototype as Range;
  vi.spyOn(R, 'getClientRects').mockImplementation(function (this: Range) {
    asked.push([this.startOffset, this.endOffset]);
    return rects as unknown as DOMRectList;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('現在行の強調の配線', () => {
  for (const k of EDITING_FIELD_KINDS) {
    it(`${EDITING_FIELD_NAMES[k]}: 焦点があり caret が畳まれていれば印と位置の変数が付き、離れれば外れる`, async () => {
      const s = setup(EDITING_FIELD_NAMES[k]);
      s.ta.value = 'abc\n\nlast';
      s.ta.focus();
      s.ta.setSelectionRange(6, 6);
      s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
      await frame();
      expect(s.ta.hasAttribute(CURRENT_LINE_ATTR), '印が付かない').toBe(true);
      expect(s.ta.style.getPropertyValue(CURRENT_LINE_HEIGHT_VAR)).toBe('16.0px');
      expect(s.ta.style.getPropertyValue(CURRENT_LINE_TOP_VAR)).toMatch(/px$/);
      // 測った範囲は caret の行(`last` = 5〜9 + 末尾の ZWSP 1 字ぶん)
      expect(asked.at(-1)).toEqual([5, 10]);
      s.other.focus();
      s.other.dispatchEvent(new Event('focusin', { bubbles: true }));
      await frame();
      expect(s.ta.hasAttribute(CURRENT_LINE_ATTR), '焦点を離れても印が残る').toBe(false);
      expect(s.ta.style.getPropertyValue(CURRENT_LINE_TOP_VAR)).toBe('');
      expect(document.querySelector('[data-pkc-field="current-line-mirror"]'), '影が残る').toBeNull();
      s.unbind();
    });
  }

  it('欄ではない <textarea>(検索など)には付かない', async () => {
    const s = setup('search-input');
    s.ta.focus();
    s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
    await frame();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR)).toBe(false);
    s.unbind();
  });

  it('caret が動くと(selectionchange)位置を測り直し、字を選んでいる間は印を外す', async () => {
    const s = setup('editor-body');
    s.ta.value = 'a\nb';
    s.ta.focus();
    s.ta.setSelectionRange(0, 0);
    document.dispatchEvent(new Event('selectionchange'));
    await frame();
    expect(asked.at(-1)).toEqual([0, 2]);
    rects = [{ top: 36, bottom: 52 }];
    s.ta.setSelectionRange(3, 3);
    document.dispatchEvent(new Event('selectionchange'));
    await frame();
    expect(asked.at(-1)).toEqual([2, 4]);
    expect(s.ta.style.getPropertyValue(CURRENT_LINE_TOP_VAR)).toBe('36.0px');
    s.ta.setSelectionRange(0, 3);
    document.dispatchEvent(new Event('selectionchange'));
    await frame();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR), '範囲選択中も印が残る').toBe(false);
    s.unbind();
  });

  it('設定で切ると付かない / 測れなければ(矩形が無い)付けない', async () => {
    enabled = false;
    const s = setup('editor-body');
    s.ta.focus();
    s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
    await frame();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR)).toBe(false);
    enabled = true;
    rects = [];
    s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
    await frame();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR)).toBe(false);
    s.unbind();
  });

  describe('🔴 同じ行の中で打つ間は、全文の影を組み直さず行だけ測る(5000 行で打鍵ごと +17ms だった)', () => {
    const mirrorTexts = (): string[] =>
      [...document.querySelectorAll('[data-pkc-field="current-line-mirror"]')].map((m) => m.textContent ?? '');
    const typeAt = async (ta: HTMLTextAreaElement, value: string, caret: number): Promise<void> => {
      ta.value = value;
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await frame();
    };

    it('同じ行で字を足すと、全文の影の字は古いまま・行の影だけ新しい字になり、高さは測り直す(上端は動かない)', async () => {
      const s = setup('editor-body');
      s.ta.value = 'abc\n\nlast';
      s.ta.focus();
      s.ta.setSelectionRange(9, 9);
      s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
      await frame();
      const first = mirrorTexts();
      expect(first[0], '最初は全文を影へ流す').toBe('abc\n\nlast' + String.fromCharCode(0x200b));
      const top0 = s.ta.style.getPropertyValue(CURRENT_LINE_TOP_VAR);
      rects = [{ top: 99, bottom: 131 }]; // 行の影で測った高さ(折り返して 2 行になった想定)
      asked = [];
      await typeAt(s.ta, 'abc\n\nlastx', 10);
      expect(mirrorTexts()[0], '同じ行の打鍵で全文の影を組み直した').toBe(first[0]);
      expect(mirrorTexts()[1]).toBe('lastx' + String.fromCharCode(0x200b));
      expect(asked, '行の影の全体を 1 度だけ測る').toEqual([[0, 6]]);
      expect(s.ta.style.getPropertyValue(CURRENT_LINE_TOP_VAR), '上端は動かない').toBe(top0);
      expect(s.ta.style.getPropertyValue(CURRENT_LINE_HEIGHT_VAR), '高さは測り直す').toBe('32.0px');
      s.unbind();
    });

    it('行が替わる / 行より前の字が変わる / 改行を打つときは、全文の影を測り直す', async () => {
      const s = setup('editor-body');
      s.ta.value = 'abc\n\nlast';
      s.ta.focus();
      s.ta.setSelectionRange(9, 9);
      s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
      await frame();
      // 行が替わる(selectionchange)
      s.ta.setSelectionRange(1, 1);
      document.dispatchEvent(new Event('selectionchange'));
      await frame();
      expect(mirrorTexts()[0]).toBe('abc\n\nlast' + String.fromCharCode(0x200b));
      expect(asked.at(-1)).toEqual([0, 4]);
      // 行より前の字が変わった(同じ行番号のまま、前の行を書き換えて caret は元の行へ戻す)
      await typeAt(s.ta, 'abc\n\nlast', 6);
      await typeAt(s.ta, 'abcZ\n\nlast', 7);
      expect(mirrorTexts()[0], '前の字が変わったのに影が古い').toBe('abcZ\n\nlast' + String.fromCharCode(0x200b));
      // 行の途中で改行を打つ: 行の頭と行より前は同じなので行だけ測る(上端は動かない)/ caret が次の行へ移ったら全文を測り直す
      await typeAt(s.ta, 'abcZ\n\nla\nst', 8);
      expect(mirrorTexts()[0], '行の頭が同じなのに全文を組み直した').toBe('abcZ\n\nlast' + String.fromCharCode(0x200b));
      await typeAt(s.ta, 'abcZ\n\nla\nst', 9);
      expect(mirrorTexts()[0]).toBe('abcZ\n\nla\nst' + String.fromCharCode(0x200b));
      expect(asked.at(-1)).toEqual([9, 12]);
      s.unbind();
    });
  });

  it('IME の変換中は動かさず、確定で合わせ直す', async () => {
    const s = setup('editor-body');
    s.ta.value = 'x';
    s.ta.focus();
    s.ta.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
    s.ta.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await frame();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR), '変換中に動いた').toBe(false);
    s.ta.dispatchEvent(new Event('compositionend', { bubbles: true }));
    await frame();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR), '確定で合わない').toBe(true);
    s.unbind();
  });

  it('1 フレームに 1 回へ畳む(連続した input で 1 回だけ測る)/ unbind で全部外れる', async () => {
    const s = setup('editor-body');
    s.ta.value = 'x';
    s.ta.focus();
    s.ta.dispatchEvent(new Event('focusin', { bubbles: true }));
    await frame();
    asked = [];
    for (let i = 0; i < 20; i += 1) s.ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await frame();
    expect(asked.length, '畳まれていない').toBe(1);
    s.unbind();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR)).toBe(false);
    s.ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await frame();
    expect(s.ta.hasAttribute(CURRENT_LINE_ATTR), 'unbind 後に動いた').toBe(false);
  });
});

describe('patchText(影の字は差分だけ書く)', () => {
  it('どの位置の編集でも結果が同じ(先頭・中・末尾・全置換・同一)', () => {
    const cases: Array<[string, string]> = [
      ['abc', 'abXc'], ['abc', 'bc'], ['abc', 'ab'], ['abc', ''], ['', 'abc'], ['aaa', 'aa'], ['aa', 'aaa'], ['abcabc', 'abcXabc'], ['same', 'same'], ['行1\n行2', '行1\n\n行2'],
    ];
    for (const [a, b] of cases) {
      const t = document.createTextNode(a);
      patchText(t, b);
      expect(t.data, `${a} → ${b}`).toBe(b);
    }
  });
  it('差分だけを書く(replaceData の範囲が全文ではない)', () => {
    const t = document.createTextNode('x'.repeat(5000) + 'a' + 'y'.repeat(5000));
    const spy = vi.spyOn(t, 'replaceData');
    patchText(t, 'x'.repeat(5000) + 'ab' + 'y'.repeat(5000));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([5001, 0, 'b']);
  });
});
