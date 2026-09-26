/** @vitest-environment happy-dom */
/**
 * 🔴 **章の箱は打ち足すと育つ**(#1044 段2 2巡目の修理、R4)。
 *
 * `installSectionBox` は開いた瞬間に 1 回 `sizeTextareaToContent` を呼ぶが、
 * それだけでは**その後の打鍵で箱の高さが追随しない** ── `row-swap.ts` の
 * `RowSwap`(本文の行入れ替え)は `input` のたびに呼び直しているのに、章の欄には
 * その配線が無かった。打ち足すと、いちばん見せたい見出し行が箱の外(スクロール
 * しないと見えない場所)へ隠れる。
 *
 * ⚠ happy-dom は layout を持たないので `wrappedExtraRows`(折り返し分)は
 *   常に 0 を返す ── ここで守れるのは `ta.rows`(改行の数からの計算)の追随だけ。
 *   折り返し分は実ブラウザの smoke(`context-menu.smoke.spec.ts`)が見る。
 */
import { describe, expect, it } from 'vitest';
import { installSectionBox, SECTION_BOX_INPUT_FIELD } from '../../src/adapter/ui/render/section-box';

function host(sourceLines: number[]): HTMLElement {
  const h = document.createElement('div');
  for (const n of sourceLines) {
    const b = document.createElement('div');
    b.setAttribute('data-pkc-source-line', String(n));
    b.textContent = `line ${n}`;
    h.appendChild(b);
  }
  return h;
}

describe('installSectionBox: 箱は打ち足すと育つ(#1044 段2 2巡目の修理、R4)', () => {
  it('🔴 開いた直後の rows は本文の行数どおり', () => {
    const h = host([0, 1, 2]);
    const ta = installSectionBox(h, { from: 0, to: 3, text: '## 見出し\n本文 1 行目' });
    expect(ta).not.toBeNull();
    expect(Number(ta!.rows)).toBe(2); // 見出し行 + 本文 1 行
  });

  it('🔴 input のたびに数え直し、打ち足すと rows が増える(直す前は開いた瞬間の 1 回だけだった)', () => {
    const h = host([0, 1, 2]);
    const ta = installSectionBox(h, { from: 0, to: 3, text: '## 見出し\n本文' })!;
    expect(Number(ta.rows)).toBe(2);
    ta.value = '## 見出し\n本文\n2 行目\n3 行目\n4 行目';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(Number(ta.rows), '打ち足したのに箱が育っていない(見出し行が隠れる)').toBe(5);
  });

  it('対照群: input を発火させなければ rows は増えない(何もしていない群)', () => {
    const h = host([0, 1, 2]);
    const ta = installSectionBox(h, { from: 0, to: 3, text: '## 見出し\n本文' })!;
    expect(Number(ta.rows)).toBe(2);
    ta.value = '## 見出し\n本文\n2 行目\n3 行目\n4 行目';
    // ⚠ input を撃たない ── 値を書き換えるだけでは rows は動かない(対照群)
    expect(Number(ta.rows)).toBe(2);
  });

  it('🔴 上限(40 行)に当たったら `data-pkc-scroll` が付く(`sizeTextareaToContent` と同じ規則)', () => {
    const h = host([0, 1]);
    const ta = installSectionBox(h, { from: 0, to: 2, text: '## 見出し' })!;
    expect(ta.hasAttribute('data-pkc-scroll')).toBe(false);
    ta.value = '## 見出し\n' + Array.from({ length: 45 }, (_, i) => `行${i}`).join('\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(Number(ta.rows)).toBe(40);
    expect(ta.getAttribute(`data-pkc-scroll`)).toBe('1');
    expect(ta.getAttribute('data-pkc-field')).toBe(SECTION_BOX_INPUT_FIELD);
  });
});

/**
 * 🔴 **カーソルは見出し行の末尾に置く**(#1044 段2 2巡目の修理、R8。
 * 変異試験 F2 が生き延びた ── 末尾を本文の末尾に戻しても通っていた)。
 *
 * ⚠ 直す前は本文の**末尾**に置いていたので、開いた瞬間に textarea が下まで
 *   scroll し、いちばん見せたい見出し行(1 行目)が箱の中で見えなくなっていた。
 */
describe('installSectionBox: カーソルは見出し行の末尾(#1044 段2 2巡目の修理、R8)', () => {
  it('🔴 開いた直後の selectionStart / selectionEnd は見出し行の末尾(= 見出し行の字数)', () => {
    const h = host([0, 1, 2]);
    const heading = '## 決定事項';
    const text = [heading, '', '- 牛乳を買う', ''].join('\n');
    const ta = installSectionBox(h, { from: 0, to: 3, text })!;
    expect(ta.selectionStart, '末尾に置いていない(本文の末尾に戻っている?)').toBe(heading.length);
    expect(ta.selectionEnd).toBe(heading.length);
    // ⚠ 対照群:本文の末尾ではないことを言い切る(text.length と食い違うことを確かめる)
    expect(heading.length).toBeLessThan(text.length);
  });

  it('🔴 章が見出し 1 行だけ(次の見出しが無い)でも、見出し行の末尾に置く', () => {
    const h = host([0]);
    const heading = '## 次回';
    const ta = installSectionBox(h, { from: 0, to: 1, text: heading })!;
    expect(ta.selectionStart).toBe(heading.length);
    expect(ta.selectionEnd).toBe(heading.length);
  });
});
