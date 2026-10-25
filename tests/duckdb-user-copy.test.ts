/**
 * 🔴 **user の `COPY (…) TO 'x.csv'` を、配っている DuckDB で本当に書けるか**(#918)。
 *
 * 字の門(`tests/features/duckdb-copy.test.ts`)が言えるのは「組んだ字」までで、
 * ここは **外を塞いだ後の engine が、形式ごとの固定の名前へ書けること・書いた中身が思った形であること・
 * user の打った名前(`../x` など)が書き先にならないこと**を実物で見る。
 * ⚠ node の engine は書いた file を手元に残す(ブラウザは器の中の memory)ので、使い捨ての作業場で走らせる。
 */
/** @vitest-environment node */
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DUCKDB_EXTENSIONS } from '../src/features/query/duckdb-pack';
import { DUCKDB_SEAL_SQL, duckDbFileNameOf, duckDbLoadSql } from '../src/adapter/platform/duckdb/duckdb-runner';
import { duckDbReadableSourceOf } from '../src/features/query/sql-guest-source';
import { DUCKDB_ALLOW_EXPORT_SQL } from '../src/features/query/duckdb-export';
import { DUCKDB_EXPORT_FILES, userCopyOf } from '../src/features/query/duckdb-copy';

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

/** 製品(`DuckDbLease.runFile`)と同じ手:打つ → 読む → 外す。手元に残った file は先に消す。 */
function runUserCopy(sql: string): { bytes: Uint8Array; fileName: string; file: string } {
  const c = userCopyOf(sql);
  if (c === null || !c.ok) throw new Error('前提が崩れている(組めない): ' + (c === null ? 'COPY でない' : c.why));
  for (const f of Object.values(DUCKDB_EXPORT_FILES)) {
    rmSync(f, { force: true });
    rmSync('tmp_' + f, { force: true });
  }
  writer.conn.query(c.statement);
  const bytes = writer.copyFileToBuffer(c.file);
  writer.dropFile(c.file);
  return { bytes, fileName: c.fileName, file: c.file };
}
const text = (b: Uint8Array): string => new TextDecoder().decode(b);


beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', SERVER, VENDOR], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    c.stdout?.once('data', (b: Buffer) => {
      resolve(Number(b.toString('utf8').trim()));
    });
    c.once('error', reject);
  });
  work = mkdtempSync(join(tmpdir(), 'pkc3-usercopy-'));
  process.chdir(work);
  writer = await newVessel();
  const src = duckDbReadableSourceOf('lid-1', '売上.csv');
  if (src === null || src.kind === 'sqlite') throw new Error('前提が崩れている(売上.csv が DuckDB へ渡せる形にならない)');
  const file = duckDbFileNameOf(src);
  writer.put(file, new TextEncoder().encode(CSV));
  writer.conn.query(duckDbLoadSql(src, file));
  // 🔴 製品と同じ順番:許す path は塞ぐ前、塞ぎは写し切った後
  writer.conn.query(DUCKDB_ALLOW_EXPORT_SQL);
  writer.conn.query(DUCKDB_SEAL_SQL);
}, 120_000);

afterAll(() => {
  process.chdir(home);
  rmSync(work, { recursive: true, force: true });
  child?.kill();
});

describe('🔴 塞いだ後の器が、user の COPY を固定の名前へ書ける(実物の engine)', () => {
  it('前提 ── 写した表が引け、外は塞がっている(対照群)', () => {
    expect(rowsOf(writer, 'SELECT count(*) AS n FROM csv')[0]?.['n']).toBe(3);
    expect(() => writer.conn.query("COPY (SELECT 1) TO 'other.csv' (FORMAT CSV)"), '塞いだのに他へ書ける').toThrow();
  });

  it('CSV: 見出し行つきで、日本語・空・小数がそのまま入る。ダウンロード名は user の名前', () => {
    const r = runUserCopy("COPY (SELECT id, 品名, 単価, 備考 FROM csv ORDER BY id) TO '売上.csv'");
    expect(r.fileName).toBe('売上.csv');
    expect(text(r.bytes).split('\n').filter((l) => l !== '')).toEqual([
      'id,品名,単価,備考',
      '1,牛乳,1.5,',
      '2,パン,2.0,あ',
      '3,卵,10.25,日本語の備考',
    ]);
  });

  it('表の名前の形・TSV・HEADER false・区切り文字も効く', () => {
    expect(text(runUserCopy("COPY csv TO 'all.csv'").bytes).split('\n')[0]).toContain('id,品名,単価,日付,備考');
    expect(text(runUserCopy("COPY (SELECT id, 品名 FROM csv ORDER BY id) TO 'a.tsv'").bytes).split('\n')[1]).toBe('1\t牛乳');
    expect(text(runUserCopy("COPY (SELECT id, 品名 FROM csv ORDER BY id) TO 'a.csv' (HEADER false, DELIMITER '|')").bytes).split('\n')[0]).toBe('1|牛乳');
  });

  it('JSON(1 行 1 件)と JSON 配列', () => {
    const lines = text(runUserCopy("COPY (SELECT id, 品名 FROM csv ORDER BY id) TO 'a.json'").bytes)
      .split('\n')
      .filter((l) => l !== '');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { id: 1, 品名: '牛乳' },
      { id: 2, 品名: 'パン' },
      { id: 3, 品名: '卵' },
    ]);
    const arr = JSON.parse(text(runUserCopy("COPY (SELECT id FROM csv ORDER BY id) TO 'a.json' (ARRAY true)").bytes)) as unknown;
    expect(arr).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('Parquet(先頭と末尾が PAR1)。圧縮の指定も通る', () => {
    for (const sql of ["COPY (SELECT * FROM csv) TO 'a.parquet'", "COPY (SELECT * FROM csv) TO 'a.parquet' (COMPRESSION zstd)"]) {
      const b = runUserCopy(sql).bytes;
      const magic = (from: number): string => String.fromCharCode(...b.slice(from, from + 4));
      expect(magic(0), sql).toBe('PAR1');
      expect(magic(b.length - 4), sql).toBe('PAR1');
    }
  });

  it('🔴 打った名前は書き先にならない: 作業場には固定の名前の file 以外が増えない', () => {
    runUserCopy("COPY (SELECT 1 AS a) TO 'evil-name.csv'");
    const left = readdirSync(work).filter((f) => !f.startsWith('source') && f !== 'duckdb-extensions');
    expect(left.some((f) => f.includes('evil')), `打った名前の file ができている: ${left.join(',')}`).toBe(false);
  });
});
