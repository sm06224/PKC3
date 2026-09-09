/**
 * 🔴 **SQL の答えを、そのままノートにする**(#681 段③ の 3 つ目)。
 *
 * ⚠ 窓を閉じれば答えは消える ── 出口が無いと「調べられるが、残せない」。
 *
 * 守る主張:
 * 1. 打った SQL と答えの表が、**両方**本文に残る
 * 2. 🔴 升の中の ``` で**囲みが壊れない**(柵の長さを中身から決める)
 * 3. `null` は**空の升**にする(`null` という字を書かない)
 * 4. 切った回は**切ったと書く**(黙って途中までを渡さない)
 * 5. 🔑 **名前は付けない**(勝手に名付けると、同じ名前の表が知らぬ間に積まれる)
 */
import { describe, expect, it } from 'vitest';
import { fenceMarkFor, sqlNoteBody, sqlNoteTitle } from '../../src/features/query/sql-to-note';
import { allFences, fenceInfo } from '../../src/features/markdown/source-blocks';
import { detectCsvLang } from '../../src/features/markdown/csv-table';
import { parseCsv } from '../../src/features/markdown/csv-table';

const base = {
  sql: 'SELECT title, n FROM t',
  columns: ['title', 'n'],
  rows: [
    ['あ', 1],
    ['い', 2],
  ] as ReadonlyArray<ReadonlyArray<string | number | null>>,
  truncated: false,
};

describe('題名', () => {
  it('いつ調べたかが入る(並んだときに区別できる)', () => {
    expect(sqlNoteTitle(new Date(2026, 8, 9, 15, 4))).toBe('SQL の答え 2026-09-09 15:04');
  });
});

describe('本文', () => {
  it('🔴 打った SQL と答えの表が、両方残る', () => {
    const body = sqlNoteBody(base);
    expect(body, '打った SQL が残っていない').toContain('SELECT title, n FROM t');
    expect(body, '見出しが残っていない').toContain('title,n');
    expect(body, '行が残っていない').toContain('あ,1');
  });

  /**
   * 🔑 **囲みとして読めることまで見る**(字が在るだけでは足りない)──
   * 読み手(`allFences` / `detectCsvLang`)を通して、sql と csv の 2 つが出るか。
   */
  it('🔴 読み手から見て、sql と csv の囲みが 1 つずつ出る', () => {
    const body = sqlNoteBody(base);
    const langs = allFences(body).map((f) => f.name.toLowerCase());
    expect(langs).toEqual(['sql', 'csv']);
    expect(detectCsvLang('csv')).toBe('csv');
  });

  /**
   * 🔴 **升の中の ``` で囲みが壊れない**(いちばん静かな壊れ方)。
   * ⚠ 壊れると、以降の行が本文として描かれて**答えが途中で化ける**。
   */
  it('🔴 升に ``` が入っていても、囲みが途中で閉じない', () => {
    const body = sqlNoteBody({
      ...base,
      rows: [['```', 1]],
    });
    const fences = allFences(body);
    expect(fences.map((f) => f.name.toLowerCase()), '囲みが途中で閉じた').toEqual(['sql', 'csv']);
    // ⚠ 空振り防止 ── 中身が実際に入っている
    expect(body).toContain('```');
  });

  it('⚠ 柵は中身より 1 本長い(最低 3 本)', () => {
    expect(fenceMarkFor('ふつう')).toBe('```');
    expect(fenceMarkFor('a ``` b')).toBe('````');
    expect(fenceMarkFor('a ````` b')).toBe('``````');
  });

  it('🔴 null は空の升(null という字を書かない)', () => {
    const body = sqlNoteBody({ ...base, columns: ['a', 'b'], rows: [[null, 'x']] });
    expect(body, 'null という字が本文に出た').not.toContain('null');
    expect(body).toContain('\n,x\n');
  });

  it('⚠ 区切りや引用符を含む升は、csv の作法で囲む', () => {
    const body = sqlNoteBody({ ...base, columns: ['a'], rows: [['あ,い'], ['"']] });
    const csv = body.split('```csv\n')[1]?.split('\n```')[0] ?? '';
    expect(parseCsv(csv, ','), '読み直せない字になっている').toEqual([['a'], ['あ,い'], ['"']]);
  });

  it('🔴 切った回は、切ったと書く', () => {
    expect(sqlNoteBody({ ...base, truncated: true })).toContain('上限で切っています');
    expect(sqlNoteBody(base), '切っていないのに切ったと書いた').not.toContain('上限で切って');
  });

  it('🔑 名前は付けない ── 代わりに「付けられる」ことを書く', () => {
    const body = sqlNoteBody(base);
    /**
     * ⚠ **見るのは囲みの開き行**(CLAUDE.md §1「範囲が広すぎて散文に満たされる」)──
     *   本文全体で `csv name=` を探すと、**すぐ下で案内している 1 行**に満たされる
     *   (実際に落ちた)。
     */
    const lines = body.split('\n');
    const open = allFences(body).find((f) => f.name.toLowerCase() === 'csv');
    expect(open, 'csv の囲みが無い(空振り)').toBeDefined();
    expect(fenceInfo(lines[open?.start ?? 0] ?? ''), '勝手に名前を付けている').toBe('csv');
    expect(body, 'また引ける道を知らせていない').toContain('name=好きな名前');
  });

  it('⚠ 0 行でも本文になる(件数を言う)', () => {
    const body = sqlNoteBody({ ...base, rows: [] });
    expect(body).toContain('0 行');
    expect(allFences(body).map((f) => f.name.toLowerCase())).toEqual(['sql', 'csv']);
  });
});
