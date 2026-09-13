/**
 * 🔴 **手持ちのファイルの、使い捨ての控え**(#854 段②)。
 *
 * ⚠ ここが守るのは「1 回読んだら消える(即破棄)」だけである ── 開く手順や
 *   画面での見え方は `tests/adapter/sql-pane.test.ts` の
 *   「SQL の面から、手持ちのファイルを開く」が端から端まで見ている。
 */
import { describe, expect, it } from 'vitest';
import { registerSqlLocalFile, takeSqlLocalFileBytes } from '../../src/adapter/state/sql-local-file';
import { isSqlLocalFileLid } from '../../src/features/query/sql-local-file';

describe('手持ちのファイルの控え', () => {
  it('🔴 控えて → 読むと、file の中身が bytes で返る', async () => {
    const file = new File(['abcdef'], 'x.sqlite');
    const lid = registerSqlLocalFile(file);
    expect(isSqlLocalFileLid(lid), '発行した lid が合成の印を持っていない').toBe(true);
    const bytes = await takeSqlLocalFileBytes(lid);
    expect(bytes, '中身が読めていない').not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('abcdef');
  });

  /**
   * 🔴 **「憶えない」の直接の証拠**(user 裁定 2026-09-12)。
   * ⚠ 2 度目を許すと、選び直していない file がもう一度開けてしまう
   *   ── これは「毎回選び直す」の裏を返す形の壊れ方である。
   */
  it('🔴 1 回読んだら、控えは消える(2 回目は null)', async () => {
    const file = new File(['xyz'], 'y.csv');
    const lid = registerSqlLocalFile(file);
    const first = await takeSqlLocalFileBytes(lid);
    expect(first, '前提が崩れている(1 回目が読めていない)').not.toBeNull();
    const second = await takeSqlLocalFileBytes(lid);
    expect(second, '2 回目も読めてしまう(即破棄になっていない)').toBeNull();
  });

  it('⚠ 発行していない lid を読むと null(対照群 ── 実在しない控えを読んでも壊れない)', async () => {
    expect(await takeSqlLocalFileBytes('no-such-lid')).toBeNull();
  });

  /**
   * 🔴 **読まれなかった控えも、次に選んだ瞬間に消える**(着地前の検算で足した)。
   *
   * ⚠ 「読んだら消す」だけでは足りない ── **読まれない道が在る**
   *   (古い worker では上流の門が先に断るので、控えは誰にも読まれない)。
   *   そのままだと選び直すたびに `File` が 1 つずつ heap に積み上がる。
   * 🔑 選び所は一度に 1 つしか選べないので、**控える前に前の物を捨てる**。
   */
  it('🔴 読まれなかった控えは、次に選んだ時点で捨てられる(積み上がらない)', async () => {
    const stale = registerSqlLocalFile(new File(['old'], 'old.csv'));
    // ⚠ ここで読まない ── 断られた回(古い worker)を模す
    registerSqlLocalFile(new File(['new'], 'new.csv'));
    expect(
      await takeSqlLocalFileBytes(stale),
      '読まれなかった控えが残っている(選び直すたびに積み上がる)',
    ).toBeNull();
  });

  it('⚠ 2 回発行すると、別々の lid になる(同じ物として扱わない)', () => {
    const a = registerSqlLocalFile(new File(['a'], 'a.sqlite'));
    const b = registerSqlLocalFile(new File(['b'], 'b.sqlite'));
    expect(a, '2 回発行しても同じ lid になっている(取り違えの元)').not.toBe(b);
  });
});
