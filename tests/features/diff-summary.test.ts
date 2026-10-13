/**
 * 🔴 **行のちがいと総量を 1 回の比較から出す**(#1087)。
 *
 * 履歴の比較と「PC のファイルへ書き戻す」の確認は、同じ 2 本に `diffRows`(行)と `diffCounts`(総量)を
 * 別々に呼んでいたので、行の比較(Myers)が 2 回走っていた。`diffSummary` は 1 回で両方を返す。
 *
 * ## 守る主張
 * 1. `diffSummary` の行と総量は、`diffRows` / `diffCounts` と同じ値(畳んだ行も数え落とさない)
 * 2. 書き戻しの確認は、行の比較を 1 回しか走らせない
 */
import { describe, expect, it, vi } from 'vitest';

const diffSpy = vi.fn();
vi.mock('../../src/features/revision/line-patch', async (orig) => {
  const real = await orig<typeof import('../../src/features/revision/line-patch')>();
  return {
    ...real,
    diffLines: (...a: Parameters<typeof real.diffLines>) => {
      diffSpy(...a);
      return real.diffLines(...a);
    },
  };
});

const { diffSummary, diffRows, diffCounts } = await import('../../src/features/revision/diff-view');
const { buildWriteBackDiff } = await import('../../src/adapter/ui/actions/write-back');

const lines = (n: number, tag = ''): string =>
  Array.from({ length: n }, (_, i) => `行 ${i}${tag}`).join('\n') + '\n';

const CASES: [string, string, string][] = [
  ['同じ', 'a\nb\n', 'a\nb\n'],
  ['足しただけ', 'a\n', 'a\nb\nc\n'],
  ['消しただけ', 'a\nb\nc\n', 'a\n'],
  ['入れ替え', 'a\nb\nc\n', 'a\nx\nc\n'],
  ['長い本文の中ほど(畳みが出る)', lines(40), lines(20) + '新しい行\n' + lines(20, '*')],
  ['空から', '', 'a\nb\n'],
  ['CRLF', 'a\r\nb\r\n', 'a\r\nc\r\n'],
];

describe('diffSummary(#1087)', () => {
  it.each(CASES)('%s:行と総量が diffRows / diffCounts と同じ', (_name, from, to) => {
    const s = diffSummary(from, to);
    expect(s.rows).toEqual(diffRows(from, to));
    expect({ added: s.added, removed: s.removed }).toEqual(diffCounts(from, to));
  });

  it('前提:畳み(gap)の出る形が CASES に在る(在ると総量を行から数えられない)', () => {
    expect(diffSummary(lines(40), lines(20) + '新しい行\n' + lines(20, '*')).rows.some((r) => r.kind === 'gap')).toBe(
      true,
    );
  });

  it('🔴 書き戻しの確認は、行の比較を 1 回しか走らせない', () => {
    diffSpy.mockClear();
    const d = buildWriteBackDiff('a\nb\n', 'a\nc\n');
    expect(d?.rows.length, '前提:ちがいの行が出ていない').toBeGreaterThan(0);
    expect(diffSpy).toHaveBeenCalledTimes(1);
  });
});
