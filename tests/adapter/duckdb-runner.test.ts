/**
 * 🔴 **DuckDB で 1 件引く道筋**(#682 段②)。
 *
 * ⚠ ここで守りたいのは速さではなく **「外へ出ない」** である ── だから
 *   **打つ順番そのもの**を pin する(差し込む → 写し切る → 塞ぐ)。
 * 🔑 実測(2026-09-15、実ブラウザ):この順でなければ成り立たない ──
 *   先に塞ぐと写せず、VIEW にすると塞いだ後に引けない。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DuckDbHandle } from '../../src/adapter/platform/duckdb/duckdb-lease';
import type { DuckDbRaw } from '../../src/features/query/duckdb-rows';
import {
  DUCKDB_MAX_ROWS,
  DUCKDB_SEAL_SQL,
  DuckDbRunner,
  duckDbFileNameOf,
  duckDbLoadSql,
  sqlQuote,
} from '../../src/adapter/platform/duckdb/duckdb-runner';

const PACK = JSON.stringify({
  version: '1.33.1',
  files: [
    { path: 'duckdb-eh.wasm', bytes: 35_913_747 },
    { path: 'duckdb-browser-eh.worker.js', bytes: 773_223 },
  ],
});

/** 打たれた字を順番どおりに積む器。 */
function fakeHandle(answer: DuckDbRaw) {
  const steps: string[] = [];
  const h: DuckDbHandle = {
    put: (name) => {
      steps.push('put:' + name);
      return Promise.resolve();
    },
    query: (sql) => {
      steps.push(sql);
      return Promise.resolve(answer);
    },
    terminate: () => {
      steps.push('terminate');
      return Promise.resolve();
    },
  };
  return { h, steps };
}

function make(opts: { answer?: DuckDbRaw; bytes?: Uint8Array | null; pack?: string } = {}) {
  const answer = opts.answer ?? { columns: ['n'], types: ['Int32'], rows: [[1]] };
  const made: Array<ReturnType<typeof fakeHandle>> = [];
  const open = vi.fn(() => {
    const f = fakeHandle(answer);
    made.push(f);
    return Promise.resolve(f.h);
  });
  const fetchText = vi.fn(() => Promise.resolve(opts.pack ?? PACK));
  const readBytes = vi.fn(() => Promise.resolve(opts.bytes === undefined ? new Uint8Array([1, 2, 3]) : opts.bytes));
  const runner = new DuckDbRunner({ fetchText, open, baseUrl: 'https://example.test/app/' });
  return { runner, open, fetchText, readBytes, made };
}

const SRC = { lid: 'l1', name: '売上.csv' };

describe('🔴 DuckDB で引く(#682 段②)', () => {
  it('🔑 呼ばれるまで起こさない', () => {
    const { runner, open, fetchText } = make();
    expect(open).toHaveBeenCalledTimes(0);
    expect(fetchText, '目録すら、押す前に取りに行かない').toHaveBeenCalledTimes(0);
    expect(runner.awake).toBe(false);
  });

  it('🔴 打つ順番が「差し込む → 写し切る → 塞ぐ → user の字」である', async () => {
    const { runner, made, readBytes } = make();
    await runner.run({ sql: 'SELECT * FROM csv', source: SRC, readBytes });
    const steps = made[0]?.steps ?? [];
    expect(steps[0]).toBe('put:source.csv');
    expect(steps[1], '写し切る前に塞いでいる(実測では写せない)').toContain('CREATE OR REPLACE TABLE csv');
    expect(steps[2]).toBe(DUCKDB_SEAL_SQL);
    expect(steps[3], 'user の字が、塞ぐより前に走っている').toBe('SELECT * FROM csv');
    expect(steps).toHaveLength(4);
  });

  it('🔴 写すのは TABLE ── VIEW にすると、塞いだ後に引けない', () => {
    const sql = duckDbLoadSql('source.csv', { lid: 'l1', name: 'めも.csv' });
    expect(sql).toContain('CREATE OR REPLACE TABLE');
    expect(sql).not.toContain('VIEW');
    // 🔑 表の名前と足す 2 列は sqlite 側と同じ(同じ SQL がどちらでも通る)
    expect(sql).toContain(' AS _note');
    expect(sql).toContain(' AS _lid');
    expect(sql).toContain('read_csv_auto');
  });

  it("🔴 題名の ' を必ず逃がす(user の字が SQL へ混ざる唯一の口)", () => {
    expect(sqlQuote("it's")).toBe("'it''s'");
    const sql = duckDbLoadSql('source.csv', { lid: 'l1', name: "a'); DROP TABLE csv; --" });
    // ⚠ 逃がしていなければ、ここに閉じていない引用符が残って 2 文目になる
    expect(sql).toContain("'a''); DROP TABLE csv; --'");
  });

  it('器の中の file 名は、題名ではなく決め打ち', () => {
    expect(duckDbFileNameOf('売上.csv')).toBe('source.csv');
    expect(duckDbFileNameOf('ログ.TSV')).toBe('source.tsv');
    // ⚠ 題名がどんな字でも、SQL へ入るのはこの 2 つだけ
    expect(duckDbFileNameOf("a'b.csv")).toBe('source.csv');
  });

  it('🔴 相手を替えたら器ごと作り直す(塞いだ器へは差し込めない)', async () => {
    const { runner, open, made, readBytes } = make();
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    await runner.run({ sql: 'SELECT 2', source: SRC, readBytes });
    expect(open, '同じ相手で起こし直している').toHaveBeenCalledTimes(1);
    expect(made[0]?.steps.filter((s) => s === DUCKDB_SEAL_SQL), '同じ相手で 2 回塞いでいる').toHaveLength(1);
    await runner.run({ sql: 'SELECT 3', source: { lid: 'l2', name: '別.csv' }, readBytes });
    expect(open, '相手が替わったのに器を作り直していない').toHaveBeenCalledTimes(2);
    expect(made[0]?.steps).toContain('terminate');
    expect(made[1]?.steps[2]).toBe(DUCKDB_SEAL_SQL);
  });

  it('🔴 同じ題名の別ノートは、別の相手として扱う', async () => {
    const { runner, open, readBytes } = make();
    await runner.run({ sql: 'SELECT 1', source: { lid: 'l1', name: '売上.csv' }, readBytes });
    await runner.run({ sql: 'SELECT 2', source: { lid: 'l2', name: '売上.csv' }, readBytes });
    expect(open, 'lid が違うのに入れ替えていない').toHaveBeenCalledTimes(2);
  });

  it('目録は同一オリジンから引き、実体の在り処もそこから組む', async () => {
    const { runner, fetchText, open, readBytes } = make();
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(fetchText).toHaveBeenCalledWith('https://example.test/app/duckdb/pack.json');
    expect(open).toHaveBeenCalledWith({
      wasmUrl: 'https://example.test/app/duckdb/duckdb-eh.wasm',
      workerUrl: 'https://example.test/app/duckdb/duckdb-browser-eh.worker.js',
    });
  });

  /**
   * 🔴 **門が「効いている」ことを、runner の経路で見る**(#682 段③a、2026-09-15)。
   *
   * ⚠ 変異試験 A4(`resolveDuckDbBase()` を `new URL(...).href` に戻す)が **SURVIVED**
   *   したので足した。生き延びた理由は「検査が弱い」ではなく **経路が届いていない**
   *   ことだった ── 製品が渡す `DUCKDB_BASE` は**相対の定数**なので、門を通しても
   *   通さなくても結果が 1 バイトも変わらない(CLAUDE.md §2)。
   * 🔑 だから `deps.packBase` で**別の場所を渡せる形**にし、そこで断ることを見る。
   * ⚠ 観測点は 2 つ:**断り文**と、**取りに行っていないこと**。文言だけだと、
   *   組んでから落ちる実装でも通ってしまう(外の宛先へ 1 回飛んだ後に断るのでは遅い)。
   */
  it('🔴 別の場所を置き場に渡したら、取りに行く前に断る', async () => {
    const { runner, fetchText, open, readBytes } = make();
    const evil = new DuckDbRunner({
      fetchText,
      open,
      baseUrl: 'https://example.test/app/',
      packBase: 'https://evil.test/duckdb/',
    });
    await expect(evil.run({ sql: 'SELECT 1', source: SRC, readBytes })).rejects.toThrow('同じ場所');
    expect(fetchText, '断ったのに、外の宛先へ取りに行っている').toHaveBeenCalledTimes(0);
    expect(open, '断ったのに器を起こしている').toHaveBeenCalledTimes(0);

    // ⚠ **対照群** ── 同じ口を既定のまま使えば通る(断りが「いつも出る」形になっていない)
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(fetchText).toHaveBeenCalledWith('https://example.test/app/duckdb/pack.json');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('⚠ 目録を取ってこられなければ、つながりの話として断る', async () => {
    const { runner, open, readBytes } = make();
    const bad = new DuckDbRunner({
      fetchText: () => Promise.reject(new Error('offline')),
      open: () => Promise.reject(new Error('起こしてはいけない')),
      baseUrl: 'https://example.test/app/',
    });
    await expect(bad.run({ sql: 'SELECT 1', source: SRC, readBytes })).rejects.toThrow('つながっているか');
    // ⚠ 対照群 ── 取れる側では起きる(断りが「いつも出る」形になっていない)
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('⚠ 目録が壊れていたら、起こす前に断る', async () => {
    const { runner, open, readBytes } = make({ pack: '{"version":"1","files":[]}' });
    await expect(runner.run({ sql: 'SELECT 1', source: SRC, readBytes })).rejects.toThrow('duckdb-eh.wasm');
    expect(open, '検める前に起こしている').toHaveBeenCalledTimes(0);
  });

  it('⚠ 相手の中身を読めなければ、名前を添えて断る', async () => {
    const { runner, readBytes } = make({ bytes: null });
    await expect(runner.run({ sql: 'SELECT 1', source: SRC, readBytes })).rejects.toThrow('売上.csv');
  });

  it('上限で切ったら、切ったと言う', async () => {
    const rows = Array.from({ length: DUCKDB_MAX_ROWS + 5 }, (_, i) => [i]);
    const { runner, readBytes } = make({ answer: { columns: ['n'], types: ['Int32'], rows } });
    const r = await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(DUCKDB_MAX_ROWS);
    // ⚠ 対照群 ── 上限の内なら切らない
    const { runner: small, readBytes: readBytes2 } = make();
    expect((await small.run({ sql: 'SELECT 1', source: SRC, readBytes: readBytes2 })).truncated).toBe(false);
  });

  it('返す形は sqlite 側と同じ(列 / 行 / 切った印 / 時間)', async () => {
    const { runner, readBytes } = make({
      answer: { columns: ['c'], types: ['Int64'], rows: [[3n]] },
    });
    const r = await runner.run({ sql: 'SELECT count(*) AS c FROM csv', source: SRC, readBytes });
    expect(r.columns).toEqual(['c']);
    // 🔴 BigInt のまま流すと、書き出しが落ちる
    expect(r.rows).toEqual([[3]]);
    expect(typeof r.ms).toBe('number');
  });
});
