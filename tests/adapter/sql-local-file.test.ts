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
  SQL_LOCAL_FILE_KEEP_MAX,
  sqlLocalFileSize,
} from '../../src/adapter/state/sql-local-file';
import { SQL_MAX_SOURCES } from '../../src/features/query/sql-multi-source';
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
   * 🔴 **控えは N 件持てる**(#918 段⑦で、「常に 1 つだけ」から変えた)。
   *
   * ⚠ 直す前は 2 件目を控えた瞬間に 1 件目が消えた。複数の file を並べると、DuckDB は走らせるたびに
   *   **全部の file を読み直す**ので、1 件目が消えていると **走らせて初めて**
   *   「中身を読めませんでした」と出る(足したときは何も起きないので気づけない)。
   * 🔑 だから「**2 件目を控えても、1 件目はそのまま読める**」を直に見る。
   */
  it('🔴 2 件目を控えても、1 件目は読める(並べた file が走らせるときに消えない)', async () => {
    const a = registerSqlLocalFile(new File(['aaa'], 'a.csv'));
    const b = registerSqlLocalFile(new File(['bbbb'], 'b.parquet'));
    const c = registerSqlLocalFile(new File(['cc'], 'c.json'));
    for (const [lid, text] of [[a, 'aaa'], [b, 'bbbb'], [c, 'cc']] as const) {
      const got = await readSqlLocalFileBytes(lid);
      expect(got, `${text} が読めない(後から控えた file に消された)`).not.toBeNull();
      expect(new TextDecoder().decode(got!)).toBe(text);
    }
    // 手放せば、その 1 件だけが読めなくなる(他は残る)
    releaseSqlLocalFile(b);
    expect(await readSqlLocalFileBytes(b)).toBeNull();
    expect(await readSqlLocalFileBytes(a)).not.toBeNull();
    expect(await readSqlLocalFileBytes(c)).not.toBeNull();
  });

  /**
   * 🔴 **安全弁:放されない道が在っても、積み上がらない**(#682 段④c の「読まれなかった控え」の置き換え)。
   * ⚠ 上限は並べられる数の 2 倍。**正しく使っていれば届かない**数なので、使っている file は消えない。
   */
  it('🔴 上限を超えたら、いちばん古い控えから捨てる(新しい物は残る)', async () => {
    const lids: string[] = [];
    for (let i = 0; i < SQL_LOCAL_FILE_KEEP_MAX + 3; i += 1) {
      lids.push(registerSqlLocalFile(new File([String(i)], `f${String(i)}.csv`)));
    }
    expect(await readSqlLocalFileBytes(lids[0]!), '古い控えが残っている(積み上がる)').toBeNull();
    expect(await readSqlLocalFileBytes(lids[2]!)).toBeNull();
    expect(await readSqlLocalFileBytes(lids[lids.length - 1]!), '新しい控えまで消えた').not.toBeNull();
    // 使っている数(並べられる上限 + 控えたばかりの 1)は必ず残る
    const alive = await Promise.all(lids.map((l) => readSqlLocalFileBytes(l)));
    expect(alive.filter((x) => x !== null).length).toBe(SQL_LOCAL_FILE_KEEP_MAX);
    expect(SQL_LOCAL_FILE_KEEP_MAX).toBeGreaterThan(SQL_MAX_SOURCES);
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
