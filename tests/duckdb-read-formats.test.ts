/**
 * 🔴 **配る拡張で、`.parquet` / `.json` が本当に読めるか**(#682 段④c)。
 *
 * ## なぜ器を起こしてまで見るのか
 *
 * ⚠ 段④c で足したのは、突き詰めれば **SQL の字**である
 * (`read_csv_auto` / `read_parquet` / `read_json_auto` の選び分け)。
 * 🔴 字を pin する test は「**その字が出ていること**」しか言えない ──
 * **その字で engine が実際に読めるか**は 1 バイトも言わない。
 * 🔑 だからここは **engine に打たせて、返ってきた行を見る**
 * (CLAUDE.md §8「入力を守る検査と、出力が届いたかを見る検査は別物」)。
 *
 * ## ⚠ 何は言えないか
 *
 * node と実ブラウザは**別の経路**である。ここで言えるのは
 * 「**この拡張とこの SQL で、この形式が読める**」までで、
 * 「ブラウザの面から選んで引ける」は言えない ── そちらは
 * `tests/smoke/attach.smoke.spec.ts` が実ブラウザで見る。
 *
 * ## ⚠ 拡張は **別プロセスの** HTTP で配る(実測 2026-09-16)
 *
 * 🔴 同じプロセスに server を立てると**固まる** ── node 版の DuckDB は
 * 拡張を**同期で**取りに行くので、同じ event loop に居る server は応答できない
 * (実測:120 秒で 1 行も返らず、殺すまでぶら下がった)。
 * ⚠ そして `INSTALL '<手元の file>'` は**使えない** ── 通るのに `LOAD` が
 * `need to see wasm magic number` で落ちる(段④b で測った「拡張が生きるのは
 * `custom_extension_repository` から取る道だけ」の node 版である)。
 *
 * ## ⚠ **node の環境で走らせる**(`@vitest-environment node`)
 *
 * 🔴 既定(happy-dom)だと `XMLHttpRequest` が居るので、node 版の DuckDB は
 * **そちらを掴む** ── そして happy-dom は「同期の要求で `responseType` は変えられない」と
 * 断るので、拡張の取得が **`InvalidStateError` で落ちる**(実測 2026-09-16)。
 * ⚠ ブラウザの実物は同期の XHR を許すので、これは **happy-dom 固有**である。
 */
/** @vitest-environment node */
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DUCKDB_ENGINE,
  DUCKDB_EXTENSIONS,
} from '../src/features/query/duckdb-pack';
import {
  DUCKDB_SEAL_SQL,
  duckDbFileNameOf,
  duckDbLoadSql,
} from '../src/adapter/platform/duckdb/duckdb-runner';
import {
  duckDbReadableSourceOf,
  guestTableNameOf,
  type DuckDbReadableGuestSource,
} from '../src/features/query/sql-guest-source';
import { buildParquet } from './features/parquet-fixture';

const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
const VENDOR = join(import.meta.dirname, '../vendor/duckdb-extensions');

/** ⚠ **別プロセス**で立てる(この file の冒頭の理由)。 */
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

let child: ChildProcess | null = null;
let conn: Conn | null = null;

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', SERVER, VENDOR], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    c.stdout?.once('data', (b: Buffer) => {
      resolve(Number(b.toString('utf8').trim()));
    });
    c.once('error', reject);
  });

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
  const c = db.connect();
  conn = c;
  put = (name, bytes) => {
    db.registerFileBuffer(name, bytes);
  };
  /**
   * 🔑 **製品と同じ順番**(`duckdb-open.ts` → `DuckDbRunner.load`)で打つ ──
   * ① 置き場を差す ② `INSTALL` → `LOAD` ③ 相手を差し込む ④ 写す ⑤ 塞ぐ。
   */
  c.query(`SET custom_extension_repository='http://127.0.0.1:${String(port)}'`);
  for (const name of DUCKDB_EXTENSIONS) {
    // ⚠ `sqlite_scanner` も同梱しているので、一覧をそのまま回す(名指ししない)
    c.query(`INSTALL ${name}`);
    c.query(`LOAD ${name}`);
  }
}, 120_000);

let put: (name: string, bytes: Uint8Array) => void = () => undefined;

afterAll(() => {
  child?.kill();
});

/**
 * ⚠ **整数は `BigInt` で返る** ── 製品はここを `duckdb-rows.ts` が `Number` へ落とす
 *   (`BigInt` のまま流すと書き出しが落ちる、と段② で測ってある)。
 * 🔑 ここは読めたかどうかを見る場所なので、同じ向きに揃えてから比べる。
 */
const rows = (sql: string): Record<string, unknown>[] =>
  (conn as Conn)
    .query(sql)
    .toArray()
    .map((r) =>
      Object.fromEntries(
        Object.entries(r.toJSON()).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]),
      ),
    );

/** 製品と同じ手で 1 件読み込み、表の中身を返す。 */
function load(src: DuckDbReadableGuestSource, bytes: Uint8Array): Record<string, unknown>[] {
  const file = duckDbFileNameOf(src);
  put(file, bytes);
  rows(duckDbLoadSql(src, file));
  return rows(`SELECT * FROM ${guestTableNameOf(src)} ORDER BY id`);
}

const src = (name: string): DuckDbReadableGuestSource => {
  const s = duckDbReadableSourceOf('lid-1', name);
  if (s === null) throw new Error(`${name} が DuckDB へ渡せる形にならない`);
  return s;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('🔴 配る拡張で読める形式(#682 段④c)', () => {
  it('🔴 同梱した拡張が、1 つ残らず読み込めている', () => {
    const loaded = rows(
      "SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY 1",
    ).map((r) => String(r['extension_name']));
    for (const want of DUCKDB_EXTENSIONS) {
      expect(loaded, `${want} が読み込めていない(engine ${DUCKDB_ENGINE.version})`).toContain(want);
    }
  });

  /**
   * 🔴 **自作の parquet が本当に parquet として読める**。
   * ⚠ これが落ちたら、疑うのは製品ではなく **`tests/features/parquet-fixture.ts`** である
   *   (前提が崩れている、と読めるように文言へ書いておく)。
   */
  it('🔴 .parquet ── 自作の fixture を read_parquet で読める', () => {
    const bytes = buildParquet([
      { name: 'id', type: 'int32', values: [1, 2, 3] },
      { name: '品名', type: 'utf8', values: ['牛乳', 'パン', '卵'] },
    ]);
    const got = load(src('売上.parquet'), bytes);
    expect(got, '前提が崩れている(自作の parquet を engine が読めていない)').toEqual([
      { id: 1, 品名: '牛乳' },
      { id: 2, 品名: 'パン' },
      { id: 3, 品名: '卵' },
    ]);
    // 🔴 **列を勝手に増やさない**(#682 段④c の判断)── 相手の 2 列だけ
    expect(Object.keys(got[0] ?? {}), '相手の列を増やしている').toEqual(['id', '品名']);
  });

  it('🔴 .json ── 配列の json を read_json_auto で読める', () => {
    const got = load(
      src('明細.json'),
      utf8(JSON.stringify([{ id: 1, 品名: '牛乳' }, { id: 2, 品名: 'パン' }])),
    );
    expect(got).toEqual([{ id: 1, 品名: '牛乳' }, { id: 2, 品名: 'パン' }]);
  });

  /**
   * 🔴 **`.ndjson` は「1 行 1 件」** ── 器の中の file 名を `.json` に潰すと、
   *   上流が形を見分けられない。⚠ だから `duckDbFileNameOf` は 2 つに分けてある。
   */
  it('🔴 .ndjson ── 1 行 1 件の json を読める', () => {
    const got = load(src('ログ.ndjson'), utf8('{"id":1,"品名":"牛乳"}\n{"id":2,"品名":"パン"}\n'));
    expect(got).toEqual([{ id: 1, 品名: '牛乳' }, { id: 2, 品名: 'パン' }]);
  });

  /**
   * ⚠ **対照群** ── 段② から在る csv も、同じ手順で読める
   *   (「新しい 2 つだけ通る」形に壊れていないことを見る)。
   * 🔑 csv だけは **`_note` / `_lid` を足す**(sqlite 側と揃えるため)。
   */
  it('⚠ 対照群 ── .csv は今までどおり読め、_note / _lid が付く', () => {
    const got = load(src('客.csv'), utf8('id,品名\n1,牛乳\n2,パン\n'));
    expect(got).toEqual([
      { _note: '客.csv', _lid: 'lid-1', id: 1, 品名: '牛乳' },
      { _note: '客.csv', _lid: 'lid-1', id: 2, 品名: 'パン' },
    ]);
  });

  /**
   * 🔴 **塞いだ後も、写した表は引ける**(段② の実測を、この形式でも確かめる)。
   *
   * ⚠ **必ずいちばん最後に置く** ── 塞ぎは**その器では二度と外せない**
   *   (「Cannot enable external access while database is running」。段② の実測)ので、
   *   ここより後に読み込む test を足すと、**そちらが理由の分からない断りで落ちる**。
   * ⚠ そして**ここでは新しく差し込まない** ── 同じ名前へ別の大きさの buffer を
   *   差し直すと、上流が前の大きさのまま読んで
   *   「No magic bytes found at end of file」で落ちる(実測 2026-09-16。
   *   製品では相手が変わると**器ごと作り直す**ので、この形は起きない)。
   */
  it('🔴 外を塞いだ後も、写した parquet は引ける(⚠ 最後に置くこと)', () => {
    expect(
      rows('SELECT count(*) AS n FROM parquet')[0]?.['n'],
      '前提が崩れている(上の parquet の test が表を作っていない)',
    ).toBe(3);
    rows(DUCKDB_SEAL_SQL);
    expect(rows('SELECT count(*) AS n FROM parquet')[0]?.['n'], '塞いだら写した表まで引けない').toBe(3);
    // ⚠ そして**差し込んだ file の読み直しは断られる**(塞ぎが効いている証拠)
    expect(
      () => rows("SELECT * FROM read_parquet('source.parquet')"),
      '塞いだのに file を読み直せてしまう',
    ).toThrow();
  });
});
