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
   * ⚠ **渡すのは「置き場」と「名前」で、file の在り処ではない** ── engine が
   *   自分で `<置き場>/<版>/<台>/<名前>.duckdb_extension.wasm` を **HTTP GET** する。
   *   実測(2026-09-16、実ブラウザで 8 通り)で**この道しか通らなかった**。
   * ⚠ **置き場は同一オリジンでなければならない** ── 門は
   *   `duckdb-pack-acquire.ts` の `resolveDuckDbBase()` に 1 つだけ在る
   *   (ここで 2 つ目を作らない)。
   * ⚠ **省ける**(既定は読み込まない)── 省いた器は csv / tsv だけ読める、
   *   段④b より前と同じ姿になる。
   */
  readonly extensions?: {
    readonly repository: string;
    readonly names: readonly string[];
  };
  /** 取得の進み具合(0〜1)。⚠ 無くても動く ── 計測のために意味論を変えない。 */
  readonly onProgress?: (ratio: number) => void;
}

/**
 * 🔴 **同梱した拡張を読み込む**(#682 段④b)。
 *
 * ## 打ち方は 8 通り測って 1 つに決まった(2026-09-16、実ブラウザ)
 *
 * | 打ち方 | 結果 |
 * |---|---|
 * | `registerFileBuffer` + `INSTALL '<file>'` → `LOAD <name>` | 🔴 **外の `extensions.duckdb.org` へ XHR** |
 * | 同上 + `LOAD '<file>'` / `LOAD '<file>'` だけ | 🔴 `Extension … is not available` |
 * | `INSTALL '<同一オリジンの URL>'` | 🔴 やはり外へ XHR |
 * | 取りに来る path を `registerFileBuffer` で先に置く | 🔴 **素通りして HTTP GET が飛ぶ** |
 * | 🟢 **`SET custom_extension_repository` → `INSTALL <name>` → `LOAD <name>`** | 🟢 **`loaded=true` / 外へ 0 件** |
 *
 * 🔴 **段④a(node)の答えは、ここでは使えなかった。** node には
 * `~/.duckdb/extensions/` という実体の置き場が在るので `INSTALL '<file>'` が
 * そこへ書き、`LOAD <name>` が見つける。⚠ wasm には無い ──
 * 配る wasm の中に **`ExtensionDirectory functionality is not supported in duckdb-wasm`**
 * という字がそのまま入っている。
 *
 * ⚠ だから**「node で通った」を「ブラウザで通る」と読んではいけない**
 * (CLAUDE.md §2「本命の分岐を、unit は 1 度も通らないことがある」の実例)。
 *
 * 🔴 **落ちたら投げる。飲まない。** ⚠ 飲むと「parquet を開いた人だけ、
 * 遠い所で分かりにくく落ちる」形になる。
 */
async function loadExtensions(
  conn: { query: (sql: string) => Promise<unknown> },
  exts: { readonly repository: string; readonly names: readonly string[] },
): Promise<void> {
  if (exts.names.length === 0) return;
  /**
   * ⚠ **置き場の字を SQL へ入れる前に検める** ── ここは `document.baseURI` から
   *   組んだ字しか来ないが、**来ない前提をコードに書かない**(次に書く人が
   *   別の字を渡した日に、引用符が閉じてしまう)。
   */
  await conn.query(`SET custom_extension_repository='${exts.repository.replace(/'/gu, "''")}'`);
  for (const name of exts.names) {
    // ⚠ 名前は `DUCKDB_EXTENSIONS` の要素(`[a-z_]` だけ)── それ以外は断る
    if (!/^[a-z_]+$/u.test(name)) throw new Error(`DuckDB の拡張の名前が不正です: ${name}`);
    await conn.query(`INSTALL ${name}`);
    await conn.query(`LOAD ${name}`);
  }
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
  if (input.extensions !== undefined) await loadExtensions(conn, input.extensions);
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
