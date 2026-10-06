/**
 * 🔴 **`.sqlite` を DuckDB 用の NDJSON の写しにする純粋な規則**(#682 段④d)。
 *
 * ここが見るのは「**写した結果が何になるか**」の規則 ── 行 → 1 行 / BLOB / NULL / 天井 / 型の写し表 /
 * DDL と読み込みの字。⚠ **engine が実際に読めるか**は `tests/duckdb-sqlite-ndjson.test.ts`(実物の
 * DuckDB)が見る ── 字を pin する test は「その字が出ていること」しか言えない。
 */
import { describe, expect, it } from 'vitest';
import {
  LossyWatch,
  NdjsonCollector,
  SQLITE_NDJSON_TABLE_MAX_BYTES,
  bytesToBase64,
  createTableSql,
  duckDbColumnTypeOf,
  insertFromNdjsonSql,
  ndjsonKeysOf,
  ndjsonLineOf,
  quoteIdent,
  refusedNote,
  tooBigReason,
} from '../../src/features/query/sqlite-ndjson';

const line = (cols: string[], row: unknown[]): string => ndjsonLineOf(ndjsonKeysOf(cols), row);

describe('🔴 行 → NDJSON の 1 行', () => {
  it('値の種類ごとに、決まった JSON になる', () => {
    expect(line(['a', 'b', 'c'], [1, 'x', 1.5])).toBe('{"a":1,"b":"x","c":1.5}');
    // 🔑 NULL も**省かない**(`read_json` は列の並びを key の並びから決める)
    expect(line(['a', 'b'], [null, undefined])).toBe('{"a":null,"b":null}');
  });

  it('🔴 BLOB は base64 の字で入る ── NULL にして黙って捨てない', () => {
    // 'AAEC' = bytes [0, 1, 2]
    expect(line(['b'], [new Uint8Array([0, 1, 2])])).toBe('{"b":"AAEC"}');
    // 対照群:空の BLOB は空文字(NULL ではない ── 値は在った)
    expect(line(['b'], [new Uint8Array(0)])).toBe('{"b":""}');
    expect(bytesToBase64(new Uint8Array([255, 254, 253, 252]))).toBe('//79/A==');
  });

  it('🔴 大きい BLOB でも落ちない(引数の数の上限に当たらない)', () => {
    const big = new Uint8Array(200_000).fill(65);
    const s = bytesToBase64(big);
    expect(s.length).toBe(Math.ceil(200_000 / 3) * 4);
    expect(atob(s.slice(0, 8))).toBe('AAAAAA');
  });

  it('🔴 2^53 を超える整数は桁をそのまま書く(Number へ丸めない)', () => {
    expect(line(['n'], [9007199254740993n])).toBe('{"n":9007199254740993}');
    expect(line(['n'], [-9223372036854775808n])).toBe('{"n":-9223372036854775808}');
  });

  it('JSON に無い数は逃がす(NaN は NULL / 無限大は字)', () => {
    expect(line(['x'], [Number.NaN])).toBe('{"x":null}');
    expect(line(['x'], [Number.POSITIVE_INFINITY])).toBe('{"x":"Infinity"}');
    expect(line(['x'], [Number.NEGATIVE_INFINITY])).toBe('{"x":"-Infinity"}');
  });

  it('🔴 改行・引用符・日本語・列名の記号が在っても、1 行のまま壊れない', () => {
    const l = line(['売 上', 'q"x'], ['a\nb"c', 'りんご']);
    expect(l).not.toContain('\n');
    expect(JSON.parse(l)).toEqual({ '売 上': 'a\nb"c', 'q"x': 'りんご' });
  });
});

describe('🔴 天井つきの組み立て(NdjsonCollector)', () => {
  it('天井の内側なら、行をそのまま改行で繋いだ bytes が返る', () => {
    const c = new NdjsonCollector(1000);
    expect(c.push('{"a":1}')).toBe(true);
    expect(c.push('{"a":2}')).toBe(true);
    const out = c.finish();
    expect(new TextDecoder().decode(out ?? new Uint8Array())).toBe('{"a":1}\n{"a":2}\n');
    expect(c.rows).toBe(2);
    expect(c.exceeded).toBe(false);
  });

  it('🔴 行が 0 件なら `null`(空の表は file を作らない)', () => {
    expect(new NdjsonCollector(1000).finish()).toBeNull();
  });

  it('🔴 天井を超えたら、そこで `false` を返し、以後は積まない(読むのをやめさせる)', () => {
    const c = new NdjsonCollector(50);
    let stoppedAt = -1;
    for (let i = 0; i < 100_000; i += 1) {
      if (!c.push('{"a":"' + 'x'.repeat(40) + '"}')) {
        stoppedAt = i;
        break;
      }
    }
    expect(stoppedAt, '天井を超えても止まらない').toBeGreaterThan(0);
    // 🔑 一括(1000 行)の符号化で気づくので、数千行までに止まる(全行は読まない)
    expect(stoppedAt).toBeLessThan(2000);
    expect(c.exceeded).toBe(true);
    expect(c.finish(), '超えた表の bytes を返している').toBeNull();
    // 超えた後に push しても積まない
    expect(c.push('{"a":1}')).toBe(false);
  });

  /**
   * 🔴 **太い行でも、天井を超えたらすぐ止まる**(着地後のレビューで出た)。
   * 天井を見るのが「1000 行ごと」だけだった頃は、1 行 64 KB の表が **999 行目まで止まらず**
   * (天井の 64MiB を大きく超えて読み続け)、512 KB では `Array.join` が字の長さの上限で落ちた。
   * 🔑 見るのは**止まる行**が「天井 ÷ 行の幅」の近く(束ねる 1 MiB ぶんの行数 + 数行)であること ──
   *   行数だけで判定に戻すと、100 KB の行で 999 行目まで止まらない。
   */
  it('🔴 太い行(100KB / 300KB / 512KB)でも、止まる行は「天井 ÷ 行の幅」の近く', () => {
    const max = 64 * 1024 * 1024;
    for (const width of [100 * 1024, 300 * 1024, 512 * 1024]) {
      const l = '{"a":"' + 'x'.repeat(width) + '"}';
      const c = new NdjsonCollector(max);
      let stoppedAt = -1;
      for (let i = 0; i < 3000; i += 1) {
        if (!c.push(l)) {
          stoppedAt = i;
          break;
        }
      }
      const expected = Math.floor(max / (l.length + 1));
      expect(stoppedAt, `${String(width)} bytes の行で、天井を超えても止まらない`).toBeGreaterThan(0);
      // 超えた後に読み続けるのは、束ねる 1 MiB ぶんの行数(+ 数行)まで
      const slack = Math.ceil((1024 * 1024) / l.length) + 4;
      expect(stoppedAt, `${String(width)} bytes の行で止まるのが遅い`).toBeLessThanOrEqual(expected + slack);
      expect(stoppedAt, `${String(width)} bytes の行で、天井の内側なのに止まった`).toBeGreaterThanOrEqual(expected - 1);
      expect(c.exceeded).toBe(true);
      expect(c.finish()).toBeNull();
    }
  });

  it('⚠ 対照群 ── 太い行でも、天井の内側なら全行が返る(束ね方を変えても欠けない)', () => {
    const l = '{"a":"' + 'x'.repeat(300 * 1024) + '"}';
    const c = new NdjsonCollector(8 * 1024 * 1024);
    for (let i = 0; i < 20; i += 1) expect(c.push(l)).toBe(true);
    const out = c.finish();
    expect(out?.byteLength).toBe(20 * (l.length + 1));
    expect(c.rows).toBe(20);
  });

  it('🔴 天井ちょうどは通り、1 バイト超えると断る(境界)', () => {
    const l = '{"a":1}'; // 7 字 + 改行 = 8 bytes
    const exact = new NdjsonCollector(8);
    exact.push(l);
    expect(exact.finish()?.byteLength).toBe(8);
    const over = new NdjsonCollector(7);
    over.push(l);
    expect(over.finish()).toBeNull();
    expect(over.exceeded).toBe(true);
  });

  it('🔑 数えるのは字数ではなく符号化した bytes(日本語は 1 字 3 bytes)', () => {
    // '{"a":"あいう"}' = 字数 11 / bytes 17 + 改行 1 = 18
    const l = '{"a":"あいう"}';
    const c = new NdjsonCollector(17);
    c.push(l);
    expect(c.finish(), '字数で数えている(bytes では天井を超える)').toBeNull();
    const ok = new NdjsonCollector(18);
    ok.push(l);
    expect(ok.finish()?.byteLength).toBe(18);
  });

  it('🔴 返す bytes は丁度の大きさの buffer(transfer で余りを運ばない)', () => {
    const c = new NdjsonCollector(1_000_000);
    for (let i = 0; i < 2500; i += 1) c.push('{"a":' + String(i) + '}');
    const out = c.finish();
    expect(out).not.toBeNull();
    expect(out?.buffer.byteLength).toBe(out?.byteLength);
  });

  it('🔴 1 表あたりの天井は 64MiB(実測 100k 行 = 27.5MB の約 2.4 倍)', () => {
    // ⚠ 数を pin するのは、変えるときに**理由を読み直させる**ため(定数の docstring に根拠が在る)
    expect(SQLITE_NDJSON_TABLE_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('🔴 型へ写すと値が黙って変わる行(LossyWatch)', () => {
  const watch = (types: string[], rows: unknown[][]): boolean => {
    const w = new LossyWatch(types.map((t, i) => ({ name: 'c' + String(i), type: t })));
    for (const r of rows) w.see(r);
    return w.lossy;
  };

  it('🔴 BIGINT へ写す列(INT / BOOL)に小数 ── 丸まるので旗を立てる', () => {
    expect(watch(['INTEGER'], [[3], [19.99]])).toBe(true);
    expect(watch(['BOOLEAN'], [[0.5]])).toBe(true);
    // 対照群:整数だけ / NULL / 文字(型違いは作り直しが救う)/ 大きい整数(bigint)は立てない
    expect(watch(['INTEGER'], [[3], [null], ['abc'], [BigInt('1000000000000000000')]])).toBe(false);
  });

  it('🔴 DOUBLE へ写す列に ±Infinity / bigint(2^53 超)── 落ちずに変わるので旗を立てる', () => {
    expect(watch(['REAL'], [[1.5], [Infinity]])).toBe(true);
    expect(watch(['DOUBLE'], [[-Infinity]])).toBe(true);
    expect(watch(['NUMERIC'], [[BigInt('9007199254740993')]])).toBe(true);
    // 対照群:ふつうの小数・整数・NULL は立てない / NaN は `null` で運ぶので立てない
    expect(watch(['REAL', 'NUMERIC'], [[1.5, 2], [2, 3.25], [null, null], [Number.NaN, 1]])).toBe(false);
  });

  it('🔴 VARCHAR へ写す列は何が来ても立てない(字のまま入る)/ 列ごとに判定する(別の列の値で立てない)', () => {
    expect(watch(['TEXT', ''], [[1.5, Infinity], [BigInt('1000000000000000000'), 2.5]])).toBe(false);
    // 小数は REAL の列には普通の値 ── INTEGER の列が整数のままなら立てない
    expect(watch(['INTEGER', 'REAL'], [[1, 2.5], [2, 3.5]])).toBe(false);
    // 逆に、小数が INTEGER の列の位置に来たら、その列の宣言で見て立てる
    expect(watch(['REAL', 'INTEGER'], [[1, 2.5]])).toBe(true);
  });

  it('一度立ったら、以後は見ない(旗は戻らない)', () => {
    const w = new LossyWatch([{ name: 'a', type: 'INTEGER' }]);
    w.see([1.5]);
    w.see([1]);
    expect(w.lossy).toBe(true);
  });
});

describe('🔴 型の写し表', () => {
  it('宣言の型 → DuckDB の 3 つの型', () => {
    const table: Array<[string, string]> = [
      ['INTEGER', 'BIGINT'],
      ['int', 'BIGINT'],
      ['BIGINT', 'BIGINT'],
      ['UNSIGNED BIG INT', 'BIGINT'],
      ['BOOLEAN', 'BIGINT'],
      ['REAL', 'DOUBLE'],
      ['FLOAT', 'DOUBLE'],
      ['DOUBLE PRECISION', 'DOUBLE'],
      ['DECIMAL(10,2)', 'DOUBLE'],
      ['NUMERIC', 'DOUBLE'],
      ['TEXT', 'VARCHAR'],
      ['VARCHAR(20)', 'VARCHAR'],
      ['BLOB', 'VARCHAR'],
      // 🔴 写せない / 決められない型は VARCHAR(値は 1 つも失わない)
      ['', 'VARCHAR'],
      ['DATE', 'VARCHAR'],
      ['DATETIME', 'VARCHAR'],
      ['JSON', 'VARCHAR'],
    ];
    for (const [declared, want] of table) {
      expect(duckDbColumnTypeOf(declared), `宣言=${declared}`).toBe(want);
    }
  });
});

describe('🔴 DDL と読み込みの字', () => {
  const cols = [
    { name: 'id', type: 'INTEGER' },
    { name: '品 名', type: 'TEXT' },
    { name: 'a"b', type: 'REAL' },
  ];

  it('空の表も列を持つ ── 宣言から作る(名前は元のまま引用する)', () => {
    expect(createTableSql('売上', cols)).toBe(
      'CREATE OR REPLACE TABLE "売上" ("id" BIGINT, "品 名" VARCHAR, "a""b" DOUBLE)',
    );
    // 🔑 `CREATE OR REPLACE` ── 前の回が途中で落ちても、同じ器でやり直せる
    expect(createTableSql('x', cols)).toContain('CREATE OR REPLACE TABLE');
  });

  it('全列 VARCHAR の作り直し(型が合わない行が在る表)', () => {
    expect(createTableSql('t', cols, true)).toBe(
      'CREATE OR REPLACE TABLE "t" ("id" VARCHAR, "品 名" VARCHAR, "a""b" VARCHAR)',
    );
  });

  it('🔴 読み込みは列と型を明示した read_json(read_json_auto に推定させない)', () => {
    const sql = insertFromNdjsonSql('売上', 'source_t1.ndjson', cols);
    expect(sql).toBe(
      `INSERT INTO "売上" SELECT * FROM read_json('source_t1.ndjson', format='newline_delimited', ` +
        `columns={'id': 'BIGINT', '品 名': 'VARCHAR', 'a"b': 'DOUBLE'})`,
    );
    expect(sql).not.toContain('read_json_auto');
    expect(insertFromNdjsonSql('t', 'f.ndjson', cols, true)).toContain("'id': 'VARCHAR'");
  });

  it("🔴 列名の ' は倍にする(user の字が SQL へ混ざる口)", () => {
    const sql = insertFromNdjsonSql('t', 'f.ndjson', [{ name: "it's", type: 'TEXT' }]);
    expect(sql).toContain("'it''s': 'VARCHAR'");
  });

  it('識別子の引用', () => {
    expect(quoteIdent('a')).toBe('"a"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe('断る理由の字', () => {
  it('天井を超えた理由は MB で言う ── file ではなく「写した行」の大きさだと言い、逃げ道は添えない(並べているかを worker は知らない)', () => {
    const why = tooBigReason(SQLITE_NDJSON_TABLE_MAX_BYTES);
    expect(why).toContain('64.0 MB');
    // 🔴 直す前は「行の写しが … を超えました」で、35 MB の file にも出るので「file は小さいのに」と読まれた
    expect(why).toContain('コピーした行が');
    expect(why).toContain('元のファイルより大きくなることがあります');
    expect(why, '逃げ道は呼び側(runner)が並べているかで言い分ける').not.toContain('内蔵の sqlite');
  });

  it('1MB に満たない天井は KB で言う(「0 MB」と書かない)', () => {
    expect(tooBigReason(2048)).toContain('2.0 KB');
    expect(tooBigReason(2048)).not.toContain('0.0 MB');
  });

  it('表の名前は呼び側が前置する(ここでは持たない)', () => {
    expect(tooBigReason(1024 * 1024)).not.toContain('売上');
    expect(refusedNote('売上', '理由')).toBe('売上 は DuckDB へコピーできませんでした(理由)');
    // 名前が空の表(sqlite は許す)も、何の表か分かる字で言う
    expect(refusedNote('', '理由')).toBe('(名前の無い表) は DuckDB へコピーできませんでした(理由)');
    // 逃げ道を渡せば、理由のあとに 1 度だけ添える
    expect(refusedNote('売上', '理由', '内蔵の sqlite なら実行できます')).toBe(
      '売上 は DuckDB へコピーできませんでした(理由。内蔵の sqlite なら実行できます)',
    );
  });
});
