/**
 * P5c-1: 行パッチの lossless pin。
 * 「復元が byte 一致する」を最優先で固める(履歴の本文が 1 byte でも変われば
 * それは復元ではない)。ランダム往復も回して縁の取りこぼしを潰す。
 */
import { describe, expect, it } from 'vitest';
import {
  applyLinePatch,
  diffLines,
  didLastDiffFallBack,
  parseLinePatch,
  serializeLinePatch,
  splitLines,
} from '../../src/features/revision/line-patch';

const roundtrip = (from: string, to: string): string =>
  applyLinePatch(from, parseLinePatch(serializeLinePatch(diffLines(from, to))));

describe('line patch (P5c-1)', () => {
  it('行末を保持して分割する(空文字は 0 行)', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a\n']);
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a\r\n', 'b\r\n']);
  });

  it('byte 一致の往復: CRLF / 末尾改行 / 空 / 多バイト / 単一巨大行', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['', '新規本文\n'],
      ['消える本文\n', ''],
      ['a\nb\nc\n', 'a\nB\nc\n'], // 中間 1 行の置換
      ['a\nb\nc\n', 'a\nb\nc\nd\n'], // 末尾追記
      ['a\nb\nc\n', 'x\na\nb\nc\n'], // 先頭挿入
      ['a\r\nb\r\n', 'a\r\nB\r\n'], // CRLF 保持
      ['末尾改行なし', '末尾改行なし\n'], // 改行の有無だけが違う
      ['末尾改行あり\n', '末尾改行あり'],
      ['同一\n', '同一\n'],
      ['# 見出し\n\n本文です。\n', '# 見出し\n\n本文でした。\n\n追記\n'],
      ['x'.repeat(50_000), 'x'.repeat(25_000) + 'y'.repeat(25_000)], // 単一巨大行
      ['絵文字🎌\n日本語\n', '絵文字🎌\n日本語かな\n'],
    ];
    for (const [from, to] of cases) {
      expect(roundtrip(from, to)).toBe(to);
    }
  });

  it('典型的な編集のパッチは全文より小さい(差分保持の前提)', () => {
    const from = Array.from({ length: 500 }, (_, i) => `行 ${i}\n`).join('');
    const to = from.replace('行 250\n', '行 250(修正)\n');
    const size = serializeLinePatch(diffLines(from, to)).length;
    expect(size).toBeLessThan(from.length / 10);
  });

  it('全面書換(予算超過)でも正しく復元できる ── 最小性より上限を優先', () => {
    // 交互に別内容 = 共通部分の削りが効かず編集距離が跳ねる形
    const from = Array.from({ length: 3000 }, (_, i) => `A${i}\n`).join('');
    const to = Array.from({ length: 3000 }, (_, i) => `B${i}\n`).join('');
    expect(roundtrip(from, to)).toBe(to);
  });

  it('ランダム往復 200 本(縁の取りこぼし検出)', () => {
    // 決定的 PRNG(再現性 ── 落ちたら同じ入力で必ず再現する)
    let seed = 20260801;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const genLines = (n: number): string =>
      Array.from({ length: n }, () => {
        const r = rnd();
        const body = r < 0.3 ? '' : `行${Math.floor(r * 20)}`;
        return rnd() < 0.1 ? `${body}\r\n` : `${body}\n`;
      }).join('');
    for (let i = 0; i < 200; i++) {
      const a = genLines(Math.floor(rnd() * 30));
      const b = rnd() < 0.2 ? '' : genLines(Math.floor(rnd() * 30));
      const withTail = rnd() < 0.3 ? a.replace(/\n$/, '') : a;
      expect(roundtrip(withTail, b)).toBe(b);
    }
  });

  it('splitLines: 改行の無い巨大入力・縁のケースでも分割が正しい(R0-1)', () => {
    // 正規表現 split から手書き indexOf 走査へ替えた回(rust-wasm-strategy §4.1)。
    // 出力の同一性が崩れたら復元が byte 一致でなくなるので、縁を pin する
    expect(splitLines('\n')).toEqual(['\n']);
    expect(splitLines('\n\n')).toEqual(['\n', '\n']);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('x'.repeat(50_000))).toEqual(['x'.repeat(50_000)]); // 改行なし巨大
    const many = Array.from({ length: 5000 }, (_, i) => `行 ${i}\n`).join('');
    expect(splitLines(many)).toHaveLength(5000);
    expect(splitLines(many + '末尾')).toHaveLength(5001);
  });

  it('予算超過のフォールバックが観測できる(R0-④ ── 黙って最小性を諦めない)', () => {
    const small = diffLines('a\nb\n', 'a\nB\n');
    expect(didLastDiffFallBack()).toBe(false);
    expect(applyLinePatch('a\nb\n', small)).toBe('a\nB\n');
    // 交互に全行違う = 共通部分の削りが効かず編集距離が跳ねる形
    const from = Array.from({ length: 3000 }, (_, i) => `A${i}\n`).join('');
    const to = Array.from({ length: 3000 }, (_, i) => `B${i}\n`).join('');
    const big = diffLines(from, to);
    expect(didLastDiffFallBack()).toBe(true); // 落ちたことが分かる
    expect(applyLinePatch(from, big)).toBe(to); // 落ちても**正しい**
  });

  it('壊れたパッチは throw(それらしい本文を作らない)', () => {
    expect(() => applyLinePatch('a\n', { v: 1, ops: [5] })).toThrow(/overrun/);
    expect(() => applyLinePatch('a\nb\n', { v: 1, ops: [1] })).toThrow(/not fully consumed/);
    expect(() => applyLinePatch('a\n', { v: 1, ops: [-5] })).toThrow(/overrun/);
    expect(() => parseLinePatch('{}')).toThrow(/malformed/);
    expect(() => parseLinePatch('not json')).toThrow();
    expect(() =>
      applyLinePatch('a\n', { v: 2 as unknown as 1, ops: [] }),
    ).toThrow(/version/);
  });
});
