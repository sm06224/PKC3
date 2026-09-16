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
  /**
   * 🔴 **開いた直後に読み込む拡張**(#682 段④b。user 要望 2026-09-16
   * 「拡張はあらかじめ読み込んでおく」)。
   *
   * ⚠ 渡すのは**呼び側が組んだ在り処だけ** ── 同一オリジンの相対か、端末の
   *   一式が貸す `blob:` URL。門は `duckdb-pack-acquire.ts` の
   *   `resolveDuckDbBase()` に 1 つだけ在る(ここで 2 つ目を作らない)。
   * ⚠ **省ける**(既定は 0 件)── 省いた器は csv / tsv だけ読める、
   *   段④b より前と同じ姿になる。
   */
  readonly extensions?: readonly { readonly name: string; readonly url: string }[];
  /** 取得の進み具合(0〜1)。⚠ 無くても動く ── 計測のために意味論を変えない。 */
  readonly onProgress?: (ratio: number) => void;
}

/**
 * 🔴 **拡張を 1 つ読み込む**(#682 段④b)。
 *
 * 打ち方は **`INSTALL '<器の中の file 名>'` → `LOAD <名前>`** ──
 * 🔑 3 通り(`INSTALL`+`LOAD` / `LOAD '<file>'` / `FORCE INSTALL`)を当てて
 *   **これだけが通った**(段④a、[run 2](https://github.com/sm06224/PKC3/actions/runs/35097508782))。
 *
 * ⚠ **上の 2 行の門(`autoinstall` / `autoload` を切る)を掛けたままで通る**ことは
 *   同じ run の対照群で実測済み ── つまり
 *   **「外から取ってこない」と「手元の物を読み込む」は両立する**。
 *
 * 🔴 **落ちたら投げる。飲まない。** ⚠ 飲むと「parquet を開いた人だけ、
 *   遠い所で分かりにくく落ちる」形になる ── どの拡張が読めなかったかを、
 *   起こすその場で言う。
 */
async function loadExtension(
  db: { registerFileBuffer: (name: string, bytes: Uint8Array) => Promise<void> },
  conn: { query: (sql: string) => Promise<unknown> },
  ext: { readonly name: string; readonly url: string },
): Promise<void> {
  let bytes: Uint8Array;
  try {
    const res = await fetch(ext.url);
    // ⚠ **沈黙を成功と読まない** ── 404 の HTML を掴んで「読み込んだ」と言わない
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`DuckDB の拡張 ${ext.name} を取ってこられませんでした(${String(e)})`, {
      cause: e,
    });
  }
  /**
   * ⚠ **器の中の file 名は、こちらが決める固定の字にする**(`duckdb-runner.ts` の
   *   `duckDbFileNameOf` と同じ考え)── 名前は `DUCKDB_EXTENSIONS` の要素なので
   *   `[a-z_]` しか入らないが、**それを SQL の字へ入れる前提を、ここに書いておく**。
   */
  const file = `${ext.name}.duckdb_extension.wasm`;
  await db.registerFileBuffer(file, bytes);
  await conn.query(`INSTALL '${file}'`);
  await conn.query(`LOAD ${ext.name}`);
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
  /**
   * 🔴 **拡張を勝手に取りに行かせない**(#682 段②。設計 doc §4 の柱)。
   *
   * 実測(2026-09-15、実ブラウザ):**掛けないと本当に外へ飛ぶ** ──
   * `SELECT * FROM read_parquet('nope.parquet')` が
   * `https://extensions.duckdb.org/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm` へ
   * XHR を出した(`page.on('request')` で観測)。掛けると catalog に無いと即断られ、
   * **外への要求は 0 件**になる。
   *
   * ⚠ **これだけでは足りない** ── 同じ実測で、`read_csv_auto('https://…')` /
   *   `FROM 'https://…'` / `ATTACH 'https://…'` は**拡張を挟まずに**外へ出た。
   *   🔑 そちらは `duckdb-runner.ts` が**中身を写し切ってから engine ごと塞ぐ**。
   * ⚠ 打つ人が `SET …=true` で戻せてしまう(実測)ので、字の門
   *   (`duckdb-guard.ts`)が `SET` / `RESET` を断っている ── **対で効く**。
   */
  await conn.query('SET autoinstall_known_extensions=false');
  await conn.query('SET autoload_known_extensions=false');
  /**
   * 🔴 **門を掛けた後に読み込む**(#682 段④b)。⚠ 順番が要る ──
   * 先に読み込むと、その間だけ自動取得が生きている(外へ出る窓が開く)。
   */
  for (const ext of input.extensions ?? []) await loadExtension(db, conn, ext);
  return {
    put: async (name: string, bytes: Uint8Array) => {
      /**
       * ⚠ 同じ名前が残っていると上流が断るので、**先に外す**。
       *   初回は「無い」で投げるので飲む(無いのが正常である)。
       */
      await db.dropFile(name).catch(() => undefined);
      await db.registerFileBuffer(name, bytes);
    },
    query: async (sql: string) => {
      const table = await conn.query(sql);
      /**
       * 🔴 **列と型は schema から採る**(#682 段②)。
       * ⚠ 行から採ると **0 行のときに列が消える**(何を引いたのか読めなくなる)。
       * ⚠ 型の字が要るのは**日付を見分けるため** ── 値はただの数(ミリ秒)で来るので、
       *   型を見ないと `1789430400000` がそのまま画面に出る(実測)。
       */
      const columns = table.schema.fields.map((f) => f.name);
      const types = table.schema.fields.map((f) => String(f.type));
      // ⚠ Arrow の表をそのまま返さない ── 上流の型が呼び側へ漏れる
      const rows = table.toArray().map((r) => {
        const o = r as unknown as Record<string, unknown>;
        return columns.map((c) => o[c]);
      });
      return { columns, types, rows };
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
