/**
 * 🔴 **手持ちのファイルの控え**(#854 段② / #682 段④c)。
 *
 * ⚠ ここが守るのは**控えの寿命**だけである ── 開く手順や画面での見え方は
 *   `tests/adapter/sql-pane.test.ts` の「SQL の面から、手持ちのファイルを開く」が
 *   端から端まで見ている。
 *
 * 🔴 **2026-09-16 に「1 回読んだら消える」をやめた**(#682 段④c)。
 * ⚠ 直す前のこの file は「**2 回目は null**」を**正しい仕様として pin していた** ──
 *   ところが #682 段② で DuckDB が **2 人目の読み手**になった時点で、それは
 *   「**手持ちの file を DuckDB で引く道が必ず死ぬ**」を pin していたのと同じだった
 *   (選んだ回が控えを消すので、走らせる回は必ず `null`)。
 * 🔑 だから終端を「読んだとき」から「**選ぶのをやめたとき**」へ移した。
 *   ⚠ 「憶えない」(user 裁定 2026-09-12)は**破っていない** ── 永続化はしないし、
 *   選び直せば前の物は消える。変わったのは**選んでいる間**だけである。
 */
import { describe, expect, it } from 'vitest';
import {
  readSqlLocalFileBytes,
  registerSqlLocalFile,
  releaseSqlLocalFile,
  sqlLocalFileSize,
} from '../../src/adapter/state/sql-local-file';
import { isSqlLocalFileLid } from '../../src/features/query/sql-local-file';

describe('手持ちのファイルの控え', () => {
  it('🔴 控えて → 読むと、file の中身が bytes で返る', async () => {
    const file = new File(['abcdef'], 'x.sqlite');
    const lid = registerSqlLocalFile(file);
    expect(isSqlLocalFileLid(lid), '発行した lid が合成の印を持っていない').toBe(true);
    const bytes = await readSqlLocalFileBytes(lid);
    expect(bytes, '中身が読めていない').not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('abcdef');
  });

  /**
   * 🔴 **DuckDB は 2 度以上読む**(#682 段④c。直す前はここが死んでいた)。
   *
   * ⚠ 読み手は 2 人居る:選んだ回(`REQUEST_SQL_GUEST_OPEN`)と、走らせた回
   *   (`DuckDbRunner.load`)。⚠ しかも後者は**器を畳んで起こし直すたびに**読むので、
   *   **読む回数は決まっていない**。
   * 🔑 だから「2 回読める」ではなく「**3 回読んでも同じ物が返る**」を見る
   *   (2 回だけ許す実装に書き換えても落ちる形にしておく)。
   */
  it('🔴 何度読んでも、同じ中身が返る(DuckDB が読み直すため)', async () => {
    const lid = registerSqlLocalFile(new File(['xyz'], 'y.csv'));
    for (const nth of [1, 2, 3]) {
      const got = await readSqlLocalFileBytes(lid);
      expect(got, `${String(nth)} 回目が読めない`).not.toBeNull();
      expect(new TextDecoder().decode(got!), `${String(nth)} 回目の中身が違う`).toBe('xyz');
    }
  });

  it('⚠ 発行していない lid を読むと null(対照群 ── 実在しない控えを読んでも壊れない)', async () => {
    expect(await readSqlLocalFileBytes('no-such-lid')).toBeNull();
  });

  /**
   * 🔴 **終端はここ**(#682 段④c)。⚠ 読んでも消えなくなったぶん、
   *   **放す口が効いていること**を直に見る ── 効かないと、選ぶのをやめた後も
   *   `File` を握ったままになる(不可侵指示 2026-07-27「ライフサイクル終端での即破棄」)。
   */
  it('🔴 手放したら、もう読めない', async () => {
    const lid = registerSqlLocalFile(new File(['zzz'], 'z.parquet'));
    expect(await readSqlLocalFileBytes(lid), '前提が崩れている(放す前に読めていない)').not.toBeNull();
    releaseSqlLocalFile(lid);
    expect(await readSqlLocalFileBytes(lid), '手放したのに読めてしまう').toBeNull();
    expect(sqlLocalFileSize(lid), '手放したのに大きさが答えられてしまう').toBeNull();
  });

  /**
   * 🔴 **手放すのは、名指しした 1 つだけ**(#682 段④c)。
   *
   * ⚠ 引数を取らずに全部消す形で 1 度書いてしまい、**手持ちのファイルを選び直す道が
   *   丸ごと死んだ**(`SET_SQL_SOURCE` は「前の相手を閉じる」→「新しい相手を開く」の
   *   順に出すので、**いま控えたばかりの file が消える**)。
   * 🔑 だから「**別の lid を手放しても、いま控えている物は残る**」を直に見る。
   */
  it('🔴 別の lid を手放しても、いま控えている file は残る', async () => {
    const old = registerSqlLocalFile(new File(['old'], 'old.csv'));
    const now = registerSqlLocalFile(new File(['now'], 'now.parquet'));
    releaseSqlLocalFile(old);
    const got = await readSqlLocalFileBytes(now);
    expect(got, '前の相手を手放したら、いま選んだ file まで消えた').not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe('now');
  });

  /**
   * 🔴 **読まれなかった控えも、次に選んだ瞬間に消える**(着地前の検算で足した)。
   *
   * ⚠ 放す口だけでは足りない ── **放されない道が在る**(古い worker では上流の門が
   *   先に断るので、控えは誰にも読まれず、面も閉じられない)。
   * 🔑 選び所は一度に 1 つしか選べないので、**控える前に前の物を捨てる**。
   */
  it('🔴 読まれなかった控えは、次に選んだ時点で捨てられる(積み上がらない)', async () => {
    const stale = registerSqlLocalFile(new File(['old'], 'old.csv'));
    // ⚠ ここで読まない ── 断られた回(古い worker)を模す
    registerSqlLocalFile(new File(['new'], 'new.csv'));
    expect(
      await readSqlLocalFileBytes(stale),
      '読まれなかった控えが残っている(選び直すたびに積み上がる)',
    ).toBeNull();
  });

  /**
   * 🔴 **大きさは、中身を読まずに答える**(#682 段④c)。
   * ⚠ `.parquet` は選んだだけでは 1 バイトも読まないので、画面へ出す大きさは
   *   ここから採る(`File.size` は中身を読まずに分かる)。
   */
  it('🔴 大きさは中身を読まなくても分かる', () => {
    const lid = registerSqlLocalFile(new File(['12345'], 'w.parquet'));
    expect(sqlLocalFileSize(lid), 'file の大きさを答えられていない').toBe(5);
    expect(sqlLocalFileSize('no-such-lid'), '知らない lid に大きさを答えている').toBeNull();
  });

  it('⚠ 2 回発行すると、別々の lid になる(同じ物として扱わない)', () => {
    const a = registerSqlLocalFile(new File(['a'], 'a.sqlite'));
    const b = registerSqlLocalFile(new File(['b'], 'b.sqlite'));
    expect(a, '2 回発行しても同じ lid になっている(取り違えの元)').not.toBe(b);
  });
});
