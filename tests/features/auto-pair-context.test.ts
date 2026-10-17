/** @vitest-environment node */
/**
 * 🔴 括弧の自動補完は、数式の塊の中と表の行では働かず、コードの中では働く(#1163 依頼 202)。
 * 補った直後の Backspace が両方を消す(依頼 203)のも、補う場所でだけ。
 *
 * 規則は `text-ops.ts` の `autoPairFor` / `pairedBackspaceRange` の 1 か所 ── ライブの行の欄(`row-swap.ts`)は結果を挿すだけ。
 */
import { describe, expect, it } from 'vitest';
import { autoPairFor, pairedBackspaceRange } from '../../src/features/markdown/text-ops';

const at = (text: string, caret: number = text.length) => ({ text, start: caret, end: caret });

describe('補う場所', () => {
  it.each([
    ['普通の文', 'メモ: '],
    ['囲みコードの中', '```\nconst x = '],
    ['文中のコードの中', '値は `f'],
    ['引用の中', '> '],
    ['箇条書きの中', '- '],
  ])('%s では「(」に「)」を補う', (_name, text) => {
    const r = autoPairFor(at(text), '(');
    expect(r, `${_name}: 補わなかった`).not.toBeNull();
    expect(r!.insert).toBe('()');
  });

  it('日本語の括弧「「」も、普通の文では対にする(全角の字でも壊れない)', () => {
    expect(autoPairFor(at('彼は'), '「')?.insert).toBe('「」');
    expect(autoPairFor(at('価格（'), '（')?.insert).toBe('（）');
  });
});

describe('補わない場所', () => {
  it.each([
    ['数式の塊の中', '$$\nf'],
    ['数式の塊の中(閉じ忘れ)', '$$\n\\frac{a}{b'],
    ['表の行の中(見出し)', '| 項目 | 値'],
    ['表の行の中(データ行・セルの途中)', '| 項目 | 値 |\n|---|---|\n| あ | い'],
  ])('%s では補わない(ブラウザにそのまま打たせる)', (_name, text) => {
    for (const key of ['(', '[', '{', '「', '`']) {
      expect(autoPairFor(at(text), key), `${_name}: ${key}`).toBeNull();
    }
  });

  /** ⚠ 対照群 ── 数式を閉じた後の行・表を抜けた後の行は、また補う(補わないのが場所に付いている)。 */
  it('数式を閉じた後・表の次の行では、また補う', () => {
    expect(autoPairFor(at('$$\nx\n$$\nその後 '), '(')?.insert).toBe('()');
    expect(autoPairFor(at('| a | b |\n|---|---|\n| 1 | 2 |\n\nあと '), '(')?.insert).toBe('()');
  });

  it('表の行でも、囲みコードの中に書いた表は表ではなくコード(補う)', () => {
    expect(autoPairFor(at('```\n| a | b'), '(')?.insert).toBe('()');
  });

  it('通り抜け(閉じを打つ)も、補わない場所では働かない', () => {
    const text = '| a ()';
    expect(autoPairFor(at(text, 5), ')')).toBeNull();
    // 対照群: 普通の文なら閉じを通り抜ける
    expect(autoPairFor(at('a ()', 3), ')')?.kind).toBe('skip');
  });
});

describe('補った直後の Backspace は両方を消す(依頼 203)', () => {
  it('普通の文 / コードの中: 「(|)」で Backspace → 両方消える', () => {
    expect(pairedBackspaceRange('メモ: ()', 5)).toEqual({ from: 4, to: 6 });
    expect(pairedBackspaceRange('```\nf()', 6)).toEqual({ from: 5, to: 7 });
    expect(pairedBackspaceRange('彼は「」', 3)).toEqual({ from: 2, to: 4 });
  });

  it('開きの後ろが閉じでないとき・先頭のときは普通の Backspace', () => {
    expect(pairedBackspaceRange('メモ: (あ)', 5)).toBeNull();
    expect(pairedBackspaceRange('()', 0)).toBeNull();
  });

  it('補わない場所(数式・表)では、手で打った「()」の間でも閉じを巻き込まない', () => {
    expect(pairedBackspaceRange('$$\nf()', 5)).toBeNull();
    expect(pairedBackspaceRange('| a () |', 5)).toBeNull();
  });
});
