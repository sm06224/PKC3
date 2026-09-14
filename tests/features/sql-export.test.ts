/** @vitest-environment happy-dom */
/**
 * 🔴 **SQL の答えを file へ書き出す**(#918 段④)。
 *
 * ⚠ ここで守るのは 1 つ:**画面の字と、file に出る字は別物である**。
 *   画面は `null` を `(なし)` と描くが、それを file に出すと
 *   **`(なし)` という 5 文字のデータ**になり、受け取った表計算では
 *   「本当に打たれた字」と見分けが付かない。
 */
import { describe, expect, it } from 'vitest';
import {
  asSqlExportKind,
  SQL_EXPORT_KINDS,
  sqlAnswerToText,
  sqlExportFileName,
  sqlExportLabel,
  sqlExportMime,
} from '../../src/features/query/sql-export';

const COLS = ['名前', 'メモ', '数'];
const ROWS: readonly (readonly (string | number | null)[])[] = [
  ['りんご', 'あま, すっぱい', 120],
  ['み"かん"', 'ふゆ\nの くだもの', 80],
  ['なし', null, 0],
];

describe('答えを file へ(#918 段④)', () => {
  /**
   * 🔴 **`null` は空になる**(画面の `(なし)` を持ち込まない)。
   * ⚠ そのうえ **`0` と `''` は残す** ── 「無い」と「0」と「空の字」は別物である
   *   (`!v` で書くと 3 つとも空になる ── いちばんやりがちな外し方)。
   */
  it('🔴 CSV ── null は空 / 0 と空の字は残る', () => {
    const csv = sqlAnswerToText(['a', 'b', 'c'], [[null, 0, '']], 'csv');
    expect(csv).toBe('a,b,c\r\n,0,\r\n');
    expect(csv, '画面の字が file へ漏れている').not.toContain('なし');
  });

  /**
   * ⚠ **1 行目は列の名前** ── 無いと、受け取った側で「1 行目がデータか見出しか」が決まらない。
   * ⚠ 区切り字・引用符・改行を含む升は**引用符で包む**(規則は `csvEscapeField` が持つ)。
   * ⚠ 行の区切りは **`\r\n`**(RFC 4180)だが、**升の中の改行はそのまま**である
   *   ── 混ざると 1 行が 2 行に割れる。
   */
  it('🔴 CSV ── 見出しが 1 行目 / 危ない升は包む / 升の中の改行は割れない', () => {
    const csv = sqlAnswerToText(COLS, ROWS, 'csv');
    const [head, ...rest] = csv.split('\r\n');
    expect(head, '1 行目が列の名前でない').toBe('名前,メモ,数');
    expect(rest[0]).toBe('りんご,"あま, すっぱい",120');
    // ⚠ 引用符は 2 つ重ねて逃がす / 升の中の改行は包みの内側に残る
    expect(csv, '引用符と改行を包んでいない').toContain(
      '"み""かん""","ふゆ\nの くだもの",80',
    );
    // 🔑 空振り防止 ── 包んでいなければ、この字は出てこない
    expect(csv, '引用符を逃がしていない').toContain('""');
  });

  it('⚠ TSV ── 区切りはタブ(カンマは包まない)', () => {
    const tsv = sqlAnswerToText(['a', 'b'], [['x,y', 'z']], 'tsv');
    expect(tsv).toBe('a\tb\r\nx,y\tz\r\n');
  });

  /**
   * 🔴 **JSON は列の名前で組む**(添字ではない)── 添字で組むと、
   *   列の並びが変わった日に**静かにずれる**。
   * ⚠ `null` は `null` のまま(空の字にしない ── 読む側が区別できなくなる)。
   */
  it('🔴 JSON ── 列の名前で組む / null は null のまま', () => {
    const json: unknown = JSON.parse(sqlAnswerToText(['a', 'b'], [[1, null]], 'json'));
    expect(json).toEqual([{ a: 1, b: null }]);
  });

  it('⚠ 0 行でも見出しだけは出る(受け取った側が列を読める)', () => {
    expect(sqlAnswerToText(['a', 'b'], [], 'csv')).toBe('a,b\r\n');
    expect(JSON.parse(sqlAnswerToText(['a'], [], 'json'))).toEqual([]);
  });

  /**
   * ⚠ **足りない升は空で埋める** ── worker が短い行を返しても、
   *   列の数が揃っていないと受け取った表計算で列がずれる。
   */
  it('⚠ 升が足りない行でも、列の数は揃う', () => {
    expect(sqlAnswerToText(['a', 'b', 'c'], [['x']], 'csv')).toBe('a,b,c\r\nx,,\r\n');
  });

  it('⚠ 読めない形は捨てる / 一覧の 3 つは受ける', () => {
    expect(asSqlExportKind('xlsx')).toBeNull();
    expect(asSqlExportKind(null)).toBeNull();
    for (const k of SQL_EXPORT_KINDS) expect(asSqlExportKind(k)).toBe(k);
  });

  /**
   * ⚠ **種別を使い回さない** ── `text/csv` を tsv に付けると、受け手が区切りを推測する。
   * ⚠ 一覧の 3 つが**すべて違う**ことまで見る(1 つコピペで揃えた回を落とす)。
   */
  it('⚠ file の種別は形ごとに違う', () => {
    const mimes = SQL_EXPORT_KINDS.map(sqlExportMime);
    expect(new Set(mimes).size, '種別が重なっている').toBe(SQL_EXPORT_KINDS.length);
    expect(sqlExportMime('csv')).toContain('text/csv');
  });

  it('⚠ 画面に出す字は、形ごとに違う', () => {
    const labels = SQL_EXPORT_KINDS.map(sqlExportLabel);
    expect(new Set(labels).size).toBe(SQL_EXPORT_KINDS.length);
    for (const l of labels) expect(l.length).toBeGreaterThan(3);
  });

  /**
   * 🔴 **OS が受けない字を入れない** ── `/` `:` `*` `?` `"` `<` `>` `|` `\`。
   * ⚠ 調べた相手の名前は user の file 名から来るので、そのまま入れると落ちる。
   * ⚠ **時刻は端末の暦**(`toISOString` は UTC ── 日本の 0〜9 時で前日になる)。
   */
  it('🔴 file の名前 ── 相手の名前が入る / OS が受けない字は落とす', () => {
    const n = sqlExportFileName(new Date(2026, 8, 14, 5, 7), 'a/b:c*?.csv', 'csv');
    expect(n).toBe('SQL の答え a_b_c__.csv 2026-09-14 0507.csv');
    expect(n, '相手の名前が入っていない').toContain('a_b_c');
    // ⚠ 相手を選んでいない回は「この PKC」
    expect(sqlExportFileName(new Date(2026, 0, 2, 3, 4), null, 'json')).toBe(
      'SQL の答え この PKC 2026-01-02 0304.json',
    );
  });
});
