/**
 * #398 段②: **版のちがいを行で見せる**。
 *
 * > user の物語: 3 日前の版に戻したい。履歴を開くと**題名が 3 つとも同じ**で、
 * > 日時しか手がかりが無い ── どれが目当てか、押すまで分からない。
 *
 * 見るのは 3 点:
 * ① 足した行 / 消した行が、その向きで出るか
 * ② 🔴 **変わっていない所を畳むか**(5000 行のログでちがいが埋もれない)
 * ③ 🔴 **畳んだぶんを数え落とさないか**(総量は畳む前から数える)
 */
import { describe, expect, it } from 'vitest';
import { diffCounts, diffRows } from '../../src/features/revision/diff-view';

const kinds = (from: string, to: string): string =>
  diffRows(from, to)
    .map((r) => (r.kind === 'gap' ? `~${r.skipped ?? 0}` : `${r.kind[0]}:${r.text}`))
    .join('|');

describe('ちがいを行で見せる', () => {
  it('足した行は add、消した行は del(向きは 古い → 新しい)', () => {
    expect(kinds('a\nb\n', 'a\nc\n')).toBe('s:a|d:b|a:c');
  });

  it('変わっていなければ、変わった行が 1 つも出ない', () => {
    expect(diffRows('a\nb\n', 'a\nb\n').every((r) => r.kind !== 'add' && r.kind !== 'del')).toBe(
      true,
    );
  });

  it('⚠ 行末の改行は画面に出さない(器が改行を持つ)', () => {
    expect(diffRows('a\n', 'b\n').map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('⚠ CRLF の \\r も出さない', () => {
    expect(diffRows('a\r\n', 'b\r\n').map((r) => r.text)).toEqual(['a', 'b']);
  });
});

describe('🔴 変わっていない所は畳む', () => {
  const long = (n: number, mark = 'x'): string =>
    Array.from({ length: n }, (_, i) => `${mark}${i}`).join('\n') + '\n';

  it('長い同一の塊は gap 1 つになる(ちがいが埋もれない)', () => {
    const from = long(50);
    const to = from.replace('x25', 'X25');
    const rows = diffRows(from, to);
    expect(rows.filter((r) => r.kind === 'gap').length, '畳んでいない').toBeGreaterThan(0);
    // 🔑 50 行がそのまま並ぶことはない
    expect(rows.length, `50 行がほぼそのまま出ている(${rows.length} 行)`).toBeLessThan(20);
  });

  it('🔑 変わった行の前後は残る(どこの行か分かる)', () => {
    const from = long(50);
    const to = from.replace('x25', 'X25');
    const texts = diffRows(from, to).map((r) => r.text);
    expect(texts, '手前の行が落ちている').toContain('x24');
    expect(texts, '後ろの行が落ちている').toContain('x26');
  });

  it('⚠ 短い同一の塊は畳まない(「⋯ 2 行」のほうが読みにくい)', () => {
    // 変えた行の間に 3 行 ── context 2 × 2 = 4 なので全部 keep される
    const rows = diffRows('A\np\nq\nr\nB\n', 'A2\np\nq\nr\nB2\n');
    expect(rows.some((r) => r.kind === 'gap'), '短い塊まで畳んでいる').toBe(false);
  });
});

describe('🔴 総量は畳む前から数える', () => {
  it('畳んでも件数は変わらない(数え落とさない)', () => {
    const from = Array.from({ length: 60 }, (_, i) => `x${i}`).join('\n') + '\n';
    const to = from.replace('x10', 'X10').replace('x50', 'X50');
    expect(diffCounts(from, to)).toEqual({ added: 2, removed: 2 });
  });

  it('同じ本文なら 0 / 0', () => {
    expect(diffCounts('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
  });

  it('全部消したら removed だけ', () => {
    expect(diffCounts('a\nb\n', '')).toEqual({ added: 0, removed: 2 });
  });

  it('空から書いたら added だけ', () => {
    expect(diffCounts('', 'a\nb\n')).toEqual({ added: 2, removed: 0 });
  });
});
