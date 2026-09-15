/**
 * 🔴 **DuckDB の実物を起こす、いちばん薄い層**(#682 段①b)。
 *
 * ⚠ **ここに判断を書かない** ── どの test も実行しない file に判断を置くと、
 * 取り違えが全部緑のまま通る(CLAUDE.md §2)。判断は 2 つの pure な層に在る:
 * 目録を検めるのは `features/query/duckdb-pack.ts`、
 * 起こす / 畳むの規律は `duckdb-lease.ts`。ここは**配線だけ**。
 *
 * ## 🔑 上流は**動的 import** で読む
 *
 * `import()` にすると Vite が別の塊へ切り出すので、**DuckDB を選ぶまで
 * その JS(実測 196.8 KiB)を 1 バイトも読まない**。⚠ 静的 import にすると
 * 本体の塊に混ざり、選ばない user も必ず読むことになる。
 *
 * ## 🔴 外へ出ない
 *
 * 渡す URL は**呼び側が組んだ同一オリジンの物だけ**(`duckDbAssetUrl`)。
 * ⚠ 上流には `getJsDelivrBundles()`(CDN から引く口)が在るが、**呼ばない** ──
 * `tests/duckdb-gate.test.ts` が `src` の全数走査で 0 件を留めている。
 */
import type { DuckDbHandle } from './duckdb-lease';

export interface OpenDuckDbInput {
  /** wasm の在り処(同一オリジンの相対)。 */
  readonly wasmUrl: string;
  /** ワーカーの在り処(同一オリジンの相対)。 */
  readonly workerUrl: string;
  /** 取得の進み具合(0〜1)。⚠ 無くても動く ── 計測のために意味論を変えない。 */
  readonly onProgress?: (ratio: number) => void;
}

/**
 * 起こす。⚠ 返る取っ手は **`terminate()` で本当に畳める**もの ──
 * 畳めない取っ手を返すと、`DuckDbLease` の規律が丸ごと空振りする。
 */
export async function openDuckDb(input: OpenDuckDbInput): Promise<DuckDbHandle> {
  const duckdb = await import('@duckdb/duckdb-wasm');
  const worker = new Worker(input.workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(input.wasmUrl, null, (p) => {
    /**
     * ⚠ 上流の進み具合は「読んだ量 / 全体」で来る ── **全体が 0 の回がある**
     * (Content-Length を返さない配信)ので、0 除算を画面へ出さない。
     */
    const total = p.bytesTotal;
    if (input.onProgress !== undefined && total > 0) {
      input.onProgress(Math.min(1, p.bytesLoaded / total));
    }
  });
  const conn = await db.connect();
  return {
    query: async (sql: string) => {
      const table = await conn.query(sql);
      // ⚠ Arrow の表をそのまま返さない ── 上流の型が呼び側へ漏れる
      return table.toArray().map((r) => r.toJSON() as Record<string, unknown>);
    },
    terminate: async () => {
      /**
       * 🔴 **順番が要る** ── 接続を閉じてから畳む。逆にすると、上流が
       * 「終了したワーカーへ問い合わせた」で投げ、`release()` が例外を飲むので
       * **畳めたのか分からなくなる**。
       */
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
