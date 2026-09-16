/**
 * 🔴 **配る DuckDB の版を、engine 自身に聞く**(#682 段④b)。
 *
 * ## なぜ字の突合では足りないか
 *
 * 拡張(`vendor/duckdb-extensions/`)は **engine の版と完全一致**でなければ
 * 読み込めない。⚠ ところがこちらが上げるのは **npm の `@duckdb/duckdb-wasm`** で、
 * engine の版とは**別々に動く** ── npm を上げた日に `vendor/` が黙って古くなる。
 *
 * `build/duckdb-assets-plugin.ts` は「配る wasm の中に `\0v1.5.4\0` が在るか」を
 * 見ているが、⚠ **それは字が在ることしか言えない**。
 * 🔴 着地前レビューが実測で示したとおり、素の `includes` だと `'v1.5.4'` は
 * `'v1.5.40'` にも含まれるので**版が上がった日に素通り**する
 * (いまは NUL で囲って丸ごと一致にしてある)。
 *
 * 🔑 **ここは器を起こして直に聞く** ── `SELECT version()` と `pragma_platform()` は
 * engine が自分で答える値なので、**字の並びに救われようがない**
 * (CLAUDE.md §8「入力を守る検査と、出力が届いたかを見る検査は別物」)。
 *
 * ## ⚠ node で起こしている理由と、その限界
 *
 * 実測 **1.6 秒**(器の起動込み)。⚠ node と実ブラウザは**別の経路**なので、
 * ここで言えるのは「**この wasm はこの版である**」までで、
 * 「ブラウザで拡張が読み込める」は言えない ── そちらは
 * `tests/smoke/attach.smoke.spec.ts` が実ブラウザで見る。
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DUCKDB_ENGINE,
  DUCKDB_EXTENSIONS,
  duckDbExtensionPath,
} from '../src/features/query/duckdb-pack';

const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));

describe('🔴 配る DuckDB の版(#682 段④b)', () => {
  it('🔴 engine 自身が名乗る版と台が、DUCKDB_ENGINE と一致する', async () => {
    /**
     * ⚠ **node 版は型を公開していない** ── `@duckdb/duckdb-wasm` の `exports` が
     *   `dist/duckdb-node-blocking.cjs` の `.d.ts` を出していないので、
     *   ここは名前で引かず**実体の path を組んで**読む(`require` の解決と同じ向き)。
     */
    const mod = (await import(
      /* @vite-ignore */ join(DIST, 'duckdb-node-blocking.cjs')
    )) as unknown as { default?: Record<string, unknown> };
    const duck = (mod.default ?? mod) as {
      ConsoleLogger: new (l: unknown) => unknown;
      LogLevel: { ERROR: unknown };
      NODE_RUNTIME: unknown;
      createDuckDB: (b: unknown, l: unknown, r: unknown) => Promise<{
        instantiate: () => Promise<unknown>;
        connect: () => { query: (s: string) => { toArray: () => { toJSON: () => Record<string, unknown> }[] } };
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
    const one = (sql: string): string =>
      String(Object.values(conn.query(sql).toArray()[0]?.toJSON() ?? {})[0]);

    expect(one('SELECT version()'), 'engine の版が上がっている ── 拡張を取り直すこと').toBe(
      DUCKDB_ENGINE.version,
    );
    expect(one('SELECT * FROM pragma_platform()'), '台が変わっている').toBe(
      DUCKDB_ENGINE.platform,
    );
  });

  /**
   * 🔴 **repo に置いた bytes が、README に書いた由来と同じ**(#682 段④b)。
   *
   * ⚠ `tests/duckdb-gate.test.ts` は**大きさの下限**しか見ていないので、
   *   中身がすり替わっても鳴らない。🔑 由来(`vendor/duckdb-extensions/README.md`)は
   *   sha256 を書いているので、**それを機械で突き合わせる** ── 書いてあるだけの
   *   材料は「在るだけ」である(CLAUDE.md §1)。
   */
  it('🔴 同梱した拡張の sha256 が、由来の記録と一致する', () => {
    const readme = readFileSync('vendor/duckdb-extensions/README.md', 'utf-8');
    for (const name of DUCKDB_EXTENSIONS) {
      const file = join(
        'vendor/duckdb-extensions',
        DUCKDB_ENGINE.version,
        DUCKDB_ENGINE.platform,
        `${name}.duckdb_extension.wasm`,
      );
      const got = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(readme, `${name} の sha256 が README に無い(由来が辿れない)`).toContain(got);
      // ⚠ 空振り防止 ── 配る path の組み立てが、この file と同じ名前を指している
      expect(duckDbExtensionPath(name)).toContain(`${name}.duckdb_extension.wasm`);
    }
    // ⚠ README が「全部 3 件」を書いていること(1 件でも通るなら数えていない)
    expect(readme.match(/\b[0-9a-f]{64}\b/gu) ?? [], 'README の sha256 が 3 件でない').toHaveLength(
      DUCKDB_EXTENSIONS.length,
    );
  });
});
