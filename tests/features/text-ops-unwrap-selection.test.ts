/**
 * #1087 A-1: 印を外したあとの選択は、外す前に選んでいた字そのものを指す。
 * 直す前は印が選択の外にあるとき `end` が印の長さぶん後ろへ伸びていた
 * (「**太字** あ」の「太字」だけ選んで外すと「太字 あ」が選ばれ、続けて打つと後ろの字ごと置き換わる)。
 */
import { describe, expect, it } from 'vitest';
import { applyFormat, type FormatOp, type TextSelection } from '../../src/features/markdown/text-ops';

const OPS: readonly { op: FormatOp; mark: string }[] = [
  { op: 'bold', mark: '**' },
  { op: 'italic', mark: '*' },
  { op: 'code', mark: '`' },
  { op: 'highlight', mark: '==' },
  { op: 'emdot', mark: '^^' },
  { op: 'strike', mark: '~~' },
];

const pick = (s: TextSelection): string => s.text.slice(s.start, s.end);

describe('🔴 印を外したあとの選択(#1087 A-1)', () => {
  for (const { op, mark } of OPS) {
    for (const tail of ['', ' あいうえお']) {
      for (const head of ['', 'まえ ']) {
        const body = `${head}${mark}太字${mark}${tail}`;
        const plain = `${head}太字${tail}`;
        it(`${op}: 印の外側だけ選んで外す ${JSON.stringify(body)}`, () => {
          const at = head.length + mark.length;
          const out = applyFormat({ text: body, start: at, end: at + 2 }, op);
          expect(out.text).toBe(plain);
          expect(pick(out), '選択が元の字からずれた').toBe('太字');
          // 往復: もう一度押すと元の本文に戻る
          const back = applyFormat(out, op);
          expect(back.text).toBe(body);
          expect(pick(back)).toBe('太字');
        });
        it(`${op}: 印ごと選んで外す ${JSON.stringify(body)}`, () => {
          const s = head.length;
          const out = applyFormat({ text: body, start: s, end: s + mark.length * 2 + 2 }, op);
          expect(out.text).toBe(plain);
          expect(pick(out)).toBe('太字');
          expect(applyFormat(out, op).text).toBe(body);
        });
      }
    }
  }

  it('複数行で全部囲まれているとき(行ごとに印ごと)、外した選択は元の行を指す(往復も)', () => {
    // 複数行で「印の外側だけ」を選ぶ形は作れない(各行の区間は行末まで・行頭の字から始まる)ので、
    // 行ごとに印ごと選んだ形を対照群として置く。
    const text = '**あ**\n**い**\nう';
    const out = applyFormat({ text, start: 0, end: 11 }, 'bold');
    expect(out.text).toBe('あ\nい\nう');
    expect(pick(out)).toBe('あ\nい');
    expect(applyFormat(out, 'bold').text).toBe('**あ**\n**い**\nう');
  });
});
