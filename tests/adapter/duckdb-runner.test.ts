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
  DUCKDB_REQUIRED_FILES,
  duckDbExtensionPath,
} from '../../src/features/query/duckdb-pack';
import {
  DUCKDB_MAX_ROWS,
  DUCKDB_SEAL_SQL,
  DuckDbRunner,
  duckDbFileNameOf,
  duckDbLoadSql,
  sqlQuote,
  type DuckDbOpenUrls,
  type DuckDbRunnerDeps,
} from '../../src/adapter/platform/duckdb/duckdb-runner';
import { guestTableNameOf } from '../../src/features/query/sql-guest-source';

/** 実測の byte 数(2026-09-15 = 器 / 2026-09-16 = 拡張)。floor を満たす。 */
const REAL_BYTES: Readonly<Record<string, number>> = {
  'duckdb-eh.wasm': 35_913_747,
  'duckdb-browser-eh.worker.js': 773_223,
  [duckDbExtensionPath('json')]: 821_413,
  [duckDbExtensionPath('parquet')]: 3_218_307,
  [duckDbExtensionPath('sqlite_scanner')]: 1_641_696,
};

/** ⚠ 目録は `DUCKDB_REQUIRED_FILES` から組む(手で並べると、足した日に古くなる)。 */
const PACK = JSON.stringify({
  version: '1.33.1',
  files: DUCKDB_REQUIRED_FILES.map((path) => ({ path, bytes: REAL_BYTES[path] ?? 0 })),
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

function make(
  opts: {
    answer?: DuckDbRaw;
    bytes?: Uint8Array | null;
    pack?: string;
    lendInstalled?: DuckDbRunnerDeps['lendInstalled'];
  } = {},
) {
  const answer = opts.answer ?? { columns: ['n'], types: ['Int32'], rows: [[1]] };
  const made: Array<ReturnType<typeof fakeHandle>> = [];
  const open = vi.fn(() => {
    const f = fakeHandle(answer);
    made.push(f);
    return Promise.resolve(f.h);
  });
  const fetchText = vi.fn(() => Promise.resolve(opts.pack ?? PACK));
  const readBytes = vi.fn(() => Promise.resolve(opts.bytes === undefined ? new Uint8Array([1, 2, 3]) : opts.bytes));
  const runner = new DuckDbRunner({
    fetchText,
    open,
    baseUrl: 'https://example.test/app/',
    // ⚠ 未指定なら key ごと渡さない ── `lendInstalled: undefined` を明示するのと
    //   実害は無いが、既存 test の deps 形をそのまま保つ
    ...(opts.lendInstalled === undefined ? {} : { lendInstalled: opts.lendInstalled }),
  });
  return { runner, open, fetchText, readBytes, made };
}

/**
 * 🔴 **拡張の置き場と名前**(#682 段④b)。
 *
 * ⚠ **字を手で並べてある** ── `duckDbExtensionPath` で組むと、実装と同じ綴りを
 *   test 側で書き直すだけになり、**同じ盲点を共有する**(CLAUDE.md §1)。
 *   ここは「engine が実際に叩く置き場」を、読める形で pin する場所である。
 * 🔑 engine はこの下から **`<置き場>/v1.5.4/wasm_eh/<名前>.duckdb_extension.wasm`** を
 *   GET する(実測 2026-09-16、server の log で path を直に確認)。
 */
const NET_EXT = {
  repository: 'https://example.test/app/duckdb/ext',
  names: ['json', 'parquet', 'sqlite_scanner'],
};

const SRC = { kind: 'csv', lang: 'csv', lid: 'l1', name: '売上.csv' } as const;
const PARQUET = { kind: 'parquet', lid: 'p1', name: '売上.parquet' } as const;
const JSON_SRC = { kind: 'json', lang: 'json', lid: 'j1', name: '売上.json' } as const;
const NDJSON = { kind: 'json', lang: 'ndjson', lid: 'j2', name: 'ログ.ndjson' } as const;

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
    const sql = duckDbLoadSql({ kind: 'csv', lang: 'csv', lid: 'l1', name: 'めも.csv' }, 'source.csv');
    expect(sql).toContain('CREATE OR REPLACE TABLE');
    expect(sql).not.toContain('VIEW');
    // 🔑 表の名前と足す 2 列は sqlite 側と同じ(同じ SQL がどちらでも通る)
    expect(sql).toContain(' AS _note');
    expect(sql).toContain(' AS _lid');
    expect(sql).toContain('read_csv_auto');
  });

  /**
   * 🔴 **形式ごとに読み手を変える**(#682 段④c)。
   * ⚠ ここを取り違えると、症状は「**開けるのに、走らせると上流の断り文が出る**」
   *   という遠い所で出る(選び所は DuckDB を出しているので、user には理由が読めない)。
   */
  it('🔴 .parquet / .json は、それぞれの読み手で読む', () => {
    expect(duckDbLoadSql(PARQUET, 'source.parquet')).toContain("read_parquet('source.parquet')");
    expect(duckDbLoadSql(JSON_SRC, 'source.json')).toContain("read_json_auto('source.json')");
    expect(duckDbLoadSql(NDJSON, 'source.ndjson')).toContain("read_json_auto('source.ndjson')");
  });

  /**
   * 🔴 **表の名前は、画面が言う名前と同じ**(#682 段④c)。
   * 🔑 どちらも `guestTableNameOf` **1 つ**から出るので食い違えない ── ここは
   *   「その 1 つを本当に通っているか」を見る(素の字を書き直したら落ちる)。
   */
  it('🔴 器に作る表の名前が、画面に出る名前と同じ', () => {
    for (const src of [SRC, PARQUET, JSON_SRC, NDJSON] as const) {
      const want = guestTableNameOf(src);
      expect(
        duckDbLoadSql(src, duckDbFileNameOf(src)),
        `${src.name}: 画面は ${want} と言うのに、器は別の名前で作っている`,
      ).toContain('CREATE OR REPLACE TABLE ' + want + ' ');
    }
    // ⚠ 空振り防止 ── 4 つが同じ名前に潰れていない
    expect(new Set([SRC, PARQUET, JSON_SRC].map((s) => guestTableNameOf(s))).size).toBe(3);
  });

  /**
   * 🔴 **`.parquet` / `.json` には `_note` / `_lid` を足さない**(#682 段④c)。
   * ⚠ 相手の列名は**書いた人が決めている** ── `SELECT *` に見覚えのない列が
   *   2 つ増えるのは驚きである(csv は sqlite 側と揃える必要があるので足す)。
   */
  it('🔴 .parquet / .json の列は、相手の列だけ(こちらが増やさない)', () => {
    for (const src of [PARQUET, JSON_SRC, NDJSON] as const) {
      const sql = duckDbLoadSql(src, duckDbFileNameOf(src));
      expect(sql, `${src.name}: 相手の列を勝手に増やしている`).not.toContain(' AS _note');
      expect(sql, `${src.name}: 相手の列を勝手に増やしている`).not.toContain(' AS _lid');
    }
    // ⚠ 対照群 ── csv では足している(「どの相手でも足さない」に壊れていない)
    expect(duckDbLoadSql(SRC, 'source.csv')).toContain(' AS _note');
  });

  it("🔴 題名の ' を必ず逃がす(user の字が SQL へ混ざる唯一の口)", () => {
    expect(sqlQuote("it's")).toBe("'it''s'");
    const sql = duckDbLoadSql(
      { kind: 'csv', lang: 'csv', lid: 'l1', name: "a'); DROP TABLE csv; --" },
      'source.csv',
    );
    // ⚠ 逃がしていなければ、ここに閉じていない引用符が残って 2 文目になる
    expect(sql).toContain("'a''); DROP TABLE csv; --'");
  });

  it('器の中の file 名は、題名ではなく決め打ち', () => {
    expect(duckDbFileNameOf(SRC)).toBe('source.csv');
    expect(duckDbFileNameOf({ kind: 'csv', lang: 'tsv', lid: 'x', name: 'ログ.TSV' })).toBe('source.tsv');
    // ⚠ 題名がどんな字でも、SQL へ入るのは決め打ちの字だけ
    expect(duckDbFileNameOf({ kind: 'csv', lang: 'csv', lid: 'x', name: "a'b.csv" })).toBe('source.csv');
    expect(duckDbFileNameOf(PARQUET)).toBe('source.parquet');
    // 🔑 `.json` と `.ndjson` は**別の字**にする ── 上流は拡張子で 1 行 1 件を見分ける
    expect(duckDbFileNameOf(JSON_SRC)).toBe('source.json');
    expect(duckDbFileNameOf(NDJSON)).toBe('source.ndjson');
  });

  it('🔴 相手を替えたら器ごと作り直す(塞いだ器へは差し込めない)', async () => {
    const { runner, open, made, readBytes } = make();
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    await runner.run({ sql: 'SELECT 2', source: SRC, readBytes });
    expect(open, '同じ相手で起こし直している').toHaveBeenCalledTimes(1);
    expect(made[0]?.steps.filter((s) => s === DUCKDB_SEAL_SQL), '同じ相手で 2 回塞いでいる').toHaveLength(1);
    await runner.run({ sql: 'SELECT 3', source: { kind: 'csv', lang: 'csv', lid: 'l2', name: '別.csv' } as const, readBytes });
    expect(open, '相手が替わったのに器を作り直していない').toHaveBeenCalledTimes(2);
    expect(made[0]?.steps).toContain('terminate');
    expect(made[1]?.steps[2]).toBe(DUCKDB_SEAL_SQL);
  });

  it('🔴 同じ題名の別ノートは、別の相手として扱う', async () => {
    const { runner, open, readBytes } = make();
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    await runner.run({ sql: 'SELECT 2', source: { kind: 'csv', lang: 'csv', lid: 'l2', name: '売上.csv' } as const, readBytes });
    expect(open, 'lid が違うのに入れ替えていない').toHaveBeenCalledTimes(2);
  });

  it('目録は同一オリジンから引き、実体の在り処もそこから組む', async () => {
    const { runner, fetchText, open, readBytes } = make();
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(fetchText).toHaveBeenCalledWith('https://example.test/app/duckdb/pack.json');
    expect(open).toHaveBeenCalledWith({
      wasmUrl: 'https://example.test/app/duckdb/duckdb-eh.wasm',
      workerUrl: 'https://example.test/app/duckdb/duckdb-browser-eh.worker.js',
      extensions: NET_EXT,
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

describe('🔴 入っていれば端末の一式、無ければ fetch(#682 段③b)', () => {
  it('🔴 端末に入っていれば、同一オリジンへの fetch は 0 回', async () => {
    const dispose = vi.fn();
    const lendInstalled = vi.fn(async () => ({ wasmUrl: 'blob:w', workerUrl: 'blob:k', dispose }));
    const { runner, fetchText, open, readBytes } = make({ lendInstalled });
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(lendInstalled, '毎回問うはず').toHaveBeenCalledTimes(1);
    expect(fetchText, '端末に入っているのに目録を取りに行っている').not.toHaveBeenCalled();
    /**
     * 🔴 **器と worker は端末から、拡張はいつも同一オリジンから**(#682 段④b)。
     * ⚠ 拡張だけ端末から貸せないのは、engine が **HTTP GET** で取りに来るためで、
     *   `blob:` には path が作れない(実測 2026-09-16)。
     */
    expect(open).toHaveBeenCalledWith({
      wasmUrl: 'blob:w',
      workerUrl: 'blob:k',
      extensions: NET_EXT,
    });
    expect(dispose, '起こし終えたら借りた URL を返している').toHaveBeenCalledTimes(1);
  });

  it('⚠ 対照群 ── 入っていなければ、いまどおり同一オリジンへ fetch する', async () => {
    const lendInstalled = vi.fn(async () => null);
    const { runner, fetchText, open, readBytes } = make({ lendInstalled });
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(lendInstalled).toHaveBeenCalledTimes(1);
    expect(fetchText, '未設置なのに fetch していない').toHaveBeenCalledWith('https://example.test/app/duckdb/pack.json');
    expect(open).toHaveBeenCalledWith({
      wasmUrl: 'https://example.test/app/duckdb/duckdb-eh.wasm',
      workerUrl: 'https://example.test/app/duckdb/duckdb-browser-eh.worker.js',
      extensions: NET_EXT,
    });
  });

  it('🔴 `lendInstalled` を渡さない既存の呼び方は、そのまま同一オリジンへ倒れる(後方互換)', async () => {
    // ⚠ opts.lendInstalled を渡さない ── deps に `lendInstalled` キー自体が無い形
    const { runner, fetchText, open, readBytes } = make();
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(fetchText).toHaveBeenCalledWith('https://example.test/app/duckdb/pack.json');
    expect(open).toHaveBeenCalledWith({
      wasmUrl: 'https://example.test/app/duckdb/duckdb-eh.wasm',
      workerUrl: 'https://example.test/app/duckdb/duckdb-browser-eh.worker.js',
      extensions: NET_EXT,
    });
  });

  it('🔴 器を起こすたびに借り直す(前回の blob: URL を使い回さない)', async () => {
    let n = 0;
    const disposes: Array<ReturnType<typeof vi.fn>> = [];
    const lendInstalled = vi.fn(async () => {
      n += 1;
      const dispose = vi.fn();
      disposes.push(dispose);
      return { wasmUrl: `blob:w${n}`, workerUrl: `blob:k${n}`, dispose };
    });
    const { runner, open, readBytes } = make({ lendInstalled });
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    // ⚠ 相手を替えて器を作り直させる(既存の「相手を替えたら器ごと作り直す」規律)
    await runner.run({ sql: 'SELECT 2', source: { kind: 'csv', lang: 'csv', lid: 'l2', name: '別.csv' } as const, readBytes });

    expect(lendInstalled, '器を作り直した回数だけ借り直しているはず').toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, { wasmUrl: 'blob:w1', workerUrl: 'blob:k1', extensions: NET_EXT });
    expect(open).toHaveBeenNthCalledWith(2, { wasmUrl: 'blob:w2', workerUrl: 'blob:k2', extensions: NET_EXT });
    expect(disposes[0], '1 回目に借りた分を返している').toHaveBeenCalledTimes(1);
    expect(disposes[1], '2 回目に借りた分も返している').toHaveBeenCalledTimes(1);
  });

  it('🔴 `dispose` は `deps.open()` が終わった後に呼ぶ(順番)', async () => {
    const order: string[] = [];
    const dispose = vi.fn(() => order.push('dispose'));
    const lendInstalled = vi.fn(async () => ({ wasmUrl: 'blob:w', workerUrl: 'blob:k', dispose }));
    const answer: DuckDbRaw = { columns: ['n'], types: ['Int32'], rows: [[1]] };
    const open = vi.fn(async (urls: DuckDbOpenUrls) => {
      order.push('open:' + urls.wasmUrl);
      return fakeHandle(answer).h;
    });
    const runner = new DuckDbRunner({
      fetchText: vi.fn(async () => ''),
      open,
      baseUrl: 'https://example.test/app/',
      lendInstalled,
    });
    const readBytes = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    await runner.run({ sql: 'SELECT 1', source: SRC, readBytes });
    expect(order, 'open が終わる前に dispose している').toEqual(['open:blob:w', 'dispose']);
  });

  it('🔴 `deps.open` が失敗しても、借りた URL は返す(try/finally)', async () => {
    const dispose = vi.fn();
    const lendInstalled = vi.fn(async () => ({ wasmUrl: 'blob:w', workerUrl: 'blob:k', dispose }));
    const open = vi.fn(() => Promise.reject(new Error('壊れた wasm')));
    const runner = new DuckDbRunner({
      fetchText: vi.fn(async () => ''),
      open,
      baseUrl: 'https://example.test/app/',
      lendInstalled,
    });
    const readBytes = vi.fn(() => Promise.resolve(new Uint8Array([1])));
    await expect(runner.run({ sql: 'SELECT 1', source: SRC, readBytes })).rejects.toThrow('壊れた wasm');
    expect(dispose, 'open が失敗しても借りた URL を返しているはず').toHaveBeenCalledTimes(1);
  });
});
