/**
 * 🔴 **配っている DuckDB で、答えを Parquet に書き、読み戻して同じ行が返る**(#918 段⑥)。
 *
 * ## なぜ engine で見るのか
 *
 * ⚠ 字の門(`tests/features/duckdb-export.test.ts`)が言えるのは「**組んだ字**」までで、
 *   🔴 その字を **外を塞いだ後の engine が本当に書けるか**、**書いた file が Parquet として読み戻せるか**、
 *   **型(整数 / 小数 / 文字 / 日付 / 無し)が保たれるか**は 1 バイトも言わない。
 * 🔑 だから **別の器**(書いた器とは別の engine)に bytes を差し込んで `read_parquet` し、行と型を見る。
 *   書いた器で読み戻すと、**同じ器の中の表**を読むだけで file を通らない(空振り)。
 *
 * ## ⚠ 何は言えないか
 *
 * node と実ブラウザは**別の経路**である。node の engine は `COPY … TO` を**手元の file**へ書く
 * (ブラウザは器の中の memory に書く)ので、書いた file の後始末(`dropFile`)の効きは言えない ──
 * そちらは `tests/adapter/duckdb-lease-file.test.ts` が取っ手の模しで、画面からの通しは
 * `tests/smoke/attach.smoke.spec.ts` が実ブラウザで見る。ここで言えるのは
 * 「**塞いだ後でも許した path にだけ書けて、読み戻した行と型が同じ**」までである。
 *
 * ## ⚠ **node の環境で走らせる**(`@vitest-environment node`)
 */
/** @vitest-environment node */
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DUCKDB_EXTENSIONS } from '../src/features/query/duckdb-pack';
import { DUCKDB_SEAL_SQL, duckDbFileNameOf, duckDbLoadSql } from '../src/adapter/platform/duckdb/duckdb-runner';
import { duckDbReadableSourceOf } from '../src/features/query/sql-guest-source';
import {
  DUCKDB_ALLOW_EXPORT_SQL,
  DUCKDB_EXPORT_FILE,
  DUCKDB_EXPORT_TMP,
  parquetCopyOf,
} from '../src/features/query/duckdb-export';

const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
const VENDOR = join(import.meta.dirname, '../vendor/duckdb-extensions');

/** ⚠ 拡張は**別プロセスの** HTTP で配る(`tests/duckdb-read-formats.test.ts` の冒頭の理由と同じ)。 */
const SERVER = `
const { createServer } = require('node:http');
const { existsSync, readFileSync } = require('node:fs');
const { join, normalize } = require('node:path');
const ROOT = process.argv[1];
createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '').split('?')[0]));
  const p = join(ROOT, rel);
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.statusCode = 404; res.end('no'); return; }
  res.setHeader('content-type', 'application/wasm');
  res.end(readFileSync(p));
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
`;

interface Conn {
  query: (s: string) => { toArray: () => { toJSON: () => Record<string, unknown> }[] };
}
interface Vessel {
  conn: Conn;
  put: (name: string, bytes: Uint8Array) => void;
  copyFileToBuffer: (name: string) => Uint8Array;
  dropFile: (name: string) => void;
}

let child: ChildProcess | null = null;
let port = 0;
let work = '';
const home = process.cwd();

async function newVessel(): Promise<Vessel> {
  const mod = (await import(/* @vite-ignore */ join(DIST, 'duckdb-node-blocking.cjs'))) as unknown as {
    default?: Record<string, unknown>;
  };
  const duck = (mod.default ?? mod) as {
    ConsoleLogger: new (l: unknown) => unknown;
    LogLevel: { ERROR: unknown };
    NODE_RUNTIME: unknown;
    createDuckDB: (b: unknown, l: unknown, r: unknown) => Promise<{
      instantiate: () => Promise<unknown>;
      connect: () => Conn;
      registerFileBuffer: (name: string, bytes: Uint8Array) => void;
      copyFileToBuffer: (name: string) => Uint8Array;
      dropFile: (name: string) => void;
    }>;
  };
  const db = await duck.createDuckDB(
    {
      mvp: { mainModule: join(DIST, 'duckdb-mvp.wasm'), mainWorker: null },
      eh: { mainModule: join(DIST, 'duckdb-eh.wasm'), mainWorker: null },
    },
    new duck.ConsoleLogger(duck.LogLevel.ERROR),
    duck.NODE_RUNTIME,
  );
  await db.instantiate();
  const conn = db.connect();
  conn.query(`SET custom_extension_repository='http://127.0.0.1:${String(port)}'`);
  for (const name of DUCKDB_EXTENSIONS) {
    conn.query(`INSTALL ${name}`);
    conn.query(`LOAD ${name}`);
  }
  return {
    conn,
    put: (name, bytes) => {
      db.registerFileBuffer(name, bytes);
    },
    copyFileToBuffer: (name) => db.copyFileToBuffer(name),
    dropFile: (name) => {
      db.dropFile(name);
    },
  };
}

/** ⚠ 整数は `BigInt` で返る ── 製品は `duckdb-rows.ts` が `Number` へ落とす。比べる前に揃える。 */
const rowsOf = (v: Vessel, sql: string): Record<string, unknown>[] =>
  v.conn
    .query(sql)
    .toArray()
    .map((r) =>
      Object.fromEntries(
        Object.entries(r.toJSON()).map(([k, x]) => [k, typeof x === 'bigint' ? Number(x) : x]),
      ),
    );

const CSV = [
  'id,品名,単価,日付,備考',
  '1,牛乳,1.5,2026-10-12,',
  '2,パン,2,2026-10-13,あ',
  '3,卵,10.25,2026-10-14,日本語の備考',
  '',
].join('\n');

/** 書いた器(製品と同じ順番で作る: 差し込む → 写す → 書き出し用に許す → 塞ぐ)。 */
let writer: Vessel;

/**
 * 🔴 **node の engine は書いた file を手元に残す**(ブラウザは器の中の memory)ので、書き出しの間に
 * 手元へ残った 2 つを消す。⚠ 消さないと次の書き出しが**前の file のまま**返る(実測 2026-10-12)。
 */
function exportAsParquet(sql: string): Uint8Array {
  rmSync(DUCKDB_EXPORT_FILE, { force: true });
  rmSync(DUCKDB_EXPORT_TMP, { force: true });
  const copy = parquetCopyOf(sql);
  if (!copy.ok) throw new Error('前提が崩れている(組めない): ' + copy.why);
  writer.conn.query(copy.statement);
  // 🔑 製品(`DuckDbLease.runFile`)と同じ手:読んだらすぐ外す(外さないと次の書き出しが前の file を返す ── 実測)
  const bytes = writer.copyFileToBuffer(DUCKDB_EXPORT_FILE);
  writer.dropFile(DUCKDB_EXPORT_FILE);
  return bytes;
}

/** 書いた器とは**別の器**(読み戻し専用。1 つを使い回す ── 起こすのに 1.5 秒かかる)。 */
let reader: Vessel | null = null;
let backSeq = 0;
/**
 * 別の器へ差し込んで読み戻す。
 * ⚠ 同じ名前へ別の大きさの buffer を差し直すと上流が前の大きさで読んで落ちる(`duckdb-read-formats.test.ts` の実測)──
 *   だから**毎回別の名前**にして、`query` の `back.parquet` をその名前へ置き換える。
 */
async function readBack(bytes: Uint8Array, query: string): Promise<Record<string, unknown>[]> {
  reader ??= await newVessel();
  backSeq += 1;
  const name = `back${String(backSeq)}.parquet`;
  reader.put(name, bytes);
  return rowsOf(reader, query.replaceAll('back.parquet', name));
}

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', SERVER, VENDOR], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    c.stdout?.once('data', (b: Buffer) => {
      resolve(Number(b.toString('utf8').trim()));
    });
    c.once('error', reject);
  });
  // 🔴 手元へ書かれる file の置き場を使い捨てにする(repo の作業ツリーを汚さない)
  work = mkdtempSync(join(tmpdir(), 'pkc3-parquet-'));
  process.chdir(work);

  writer = await newVessel();
  const src = duckDbReadableSourceOf('lid-1', '売上.csv');
  if (src === null || src.kind === 'sqlite') throw new Error('前提が崩れている(売上.csv が DuckDB へ渡せる形にならない)');
  const file = duckDbFileNameOf(src);
  writer.put(file, new TextEncoder().encode(CSV));
  writer.conn.query(duckDbLoadSql(src, file));
  // 🔴 製品と同じ順番:許す path は**塞ぐ前**(`duckdb-open.ts`)、塞ぎは写し切った後(`DuckDbRunner.load`)
  writer.conn.query(DUCKDB_ALLOW_EXPORT_SQL);
  writer.conn.query(DUCKDB_SEAL_SQL);
}, 120_000);

afterAll(() => {
  process.chdir(home);
  rmSync(work, { recursive: true, force: true });
  child?.kill();
});

describe('🔴 塞いだ後の器が、許した path にだけ Parquet を書ける(実物の engine)', () => {
  it('前提 ── 写した表が引け、外は塞がっている(対照群)', () => {
    expect(rowsOf(writer, 'SELECT count(*) AS n FROM csv')[0]?.['n']).toBe(3);
    expect(() => rowsOf(writer, "SELECT * FROM read_csv_auto('source.csv')"), '塞いだのに file を読み直せる').toThrow();
  });

  it('🔴 許した path 以外へは、塞ぎのまま書けない(許可が穴になっていない)', () => {
    for (const to of ['other.parquet', 'tmp_other.parquet', '../escape.parquet']) {
      expect(
        () => writer.conn.query(`COPY (SELECT 1 AS a) TO '${to}' (FORMAT PARQUET)`),
        `${to} へ書けてしまう`,
      ).toThrow();
    }
  });

  it('🔴 整数 / 小数 / 文字 / 無し / 日本語 / 日付 が、別の器で読み戻しても同じ行・同じ型で返る', async () => {
    const query = 'SELECT id, 品名, 単価, 日付, 備考, id * 2 AS 倍 FROM csv ORDER BY id';
    const asked = rowsOf(writer, query);
    // ⚠ 前提 ── 書く前の答えが、思っている形(null と日本語と日付を含む)である
    expect(asked.map((r) => r['備考']), '前提が崩れている(null と日本語を含む答えのはず)').toEqual([
      null,
      'あ',
      '日本語の備考',
    ]);

    const bytes = exportAsParquet(query);
    // 🔑 Parquet の印(先頭と末尾が PAR1)── 別の形式を書いていない
    const magic = (from: number): string => String.fromCharCode(...bytes.slice(from, from + 4));
    expect(magic(0), '先頭が PAR1 でない').toBe('PAR1');
    expect(magic(bytes.length - 4), '末尾が PAR1 でない').toBe('PAR1');

    const back = await readBack(bytes, "SELECT * FROM read_parquet('back.parquet')");
    // 🔴 書く前の答えと、別の器で読み戻した行が、等値(整数は Number、日付は同じ値)
    expect(back).toEqual(asked);
    // 🔑 期待値を実装と別の観測でも持つ(同じ盲点を共有しない)── 文で書いた値
    expect(back[2]).toEqual(expect.objectContaining({ id: 3, 品名: '卵', 単価: 10.25, 備考: '日本語の備考', 倍: 6 }));

    // 🔴 型が保たれる(CSV / JSON に出すと全部が字になる ── Parquet を選ぶ理由そのもの)
    const types = await readBack(
      bytes,
      "SELECT column_name AS c, column_type AS t FROM (DESCRIBE SELECT * FROM read_parquet('back.parquet'))",
    );
    const before = rowsOf(writer, `SELECT column_name AS c, column_type AS t FROM (DESCRIBE ${query})`);
    expect(types).toEqual(before);
    expect(types.map((r) => r['t']), '整数 / 文字 / 小数 / 日付 の型が保たれていない').toEqual([
      'BIGINT',
      'VARCHAR',
      'DOUBLE',
      'DATE',
      'VARCHAR',
      'BIGINT',
    ]);
  });

  it('🔑 0 行の答えも、列つきの Parquet になる(読み戻して 0 行・同じ列)', async () => {
    const bytes = exportAsParquet('SELECT id, 品名 FROM csv WHERE id < 0');
    const cols = await readBack(bytes, "SELECT column_name AS c FROM (DESCRIBE SELECT * FROM read_parquet('back.parquet'))");
    expect(cols.map((r) => r['c'])).toEqual(['id', '品名']);
    const n = await readBack(bytes, "SELECT count(*) AS n FROM read_parquet('back.parquet')");
    expect(n[0]?.['n']).toBe(0);
  });

  it('🔴 DESCRIBE / FROM 先行 / 末尾が ; や注釈の SQL も、包んで書ける', async () => {
    for (const sql of ['DESCRIBE csv', 'FROM csv', 'SELECT 1 AS a;', 'SELECT 1 AS a -- 注釈']) {
      const bytes = exportAsParquet(sql);
      const n = await readBack(bytes, "SELECT count(*) AS n FROM read_parquet('back.parquet')");
      expect(Number(n[0]?.['n']), sql).toBeGreaterThan(0);
    }
  });
});
