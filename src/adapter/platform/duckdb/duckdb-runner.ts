/**
 * 🔴 **DuckDB で 1 件引く**(#682 段②)。目録を検め、相手を写し、**外を塞いでから**打つ。
 *
 * ## 🔴 「外へ出ない」をどう守るか ── 実測で 1 つに絞れた(2026-09-15、実ブラウザ)
 *
 * 3 つの門を測った結果、**単独で足りる物は 1 つも無かった**:
 *
 * | 掛けた門 | 差し込んだ csv を読めるか | 遠くの file を読めるか |
 * |---|---|---|
 * | `autoinstall` / `autoload` を切る | 🟢 読める | 🔴 **読めてしまう**(`read_csv_auto('https://…')` が XHR で外へ出た) |
 * | `enable_external_access=false` | 🔴 **読めない**(差し込んだ物まで塞がる) | 🟢 塞がる |
 *
 * 🔑 **だから順番で解く**(この順で実測済み):
 * ① 拡張の自動取得を切る(`duckdb-open.ts`)② 相手を差し込む
 * ③ **中身を表へ写し切る**(`CREATE OR REPLACE TABLE … AS SELECT …`)④ **外を塞ぐ**
 * ⑤ そこから先が user の字。
 *
 * 実測(2026-09-15):④ の後でも ③ で写した表は `SELECT` も `count` も `GROUP BY` も通り、
 * **差し込んだ file の読み直し**も、**遠くの 3 通り**
 * (`read_csv_auto('https://…')` / `FROM 'https://…'` / `ATTACH 'https://…'`)も
 * 全部断られ、**外への要求は 0 件**だった。
 * 🔴 そして **一度塞ぐと同じ器では二度と開けられない**
 * (「Cannot enable external access while database is running」)── つまり
 * **打つ人にも外せない、本物の境**である。
 * ⚠ 字の門(`duckdb-guard.ts`)が `SET` / `RESET` を断っているのは **① の取り消しを
 * 防ぐため** ── ④ は engine が守るが、① は打ち直せてしまう(実測)。
 *
 * ## ⚠ 相手を替えたら器ごと作り直す
 *
 * ④ を掛けた器へ 2 件目は差し込めない(file を読めないので)。
 * 🔑 `DuckDbLease` が**鍵が変わったら畳んで起こし直す** ── 使い捨ての規律と同じ向き。
 */
import { CSV_ATTACHMENT_TABLE_NAME, looksLikeCsvAttachmentName } from '@features/query/csv-attachment';
import { CSV_SOURCE_COLUMNS } from '@features/query/csv-tables';
import { duckDbTable } from '@features/query/duckdb-rows';
import { DUCKDB_WASM, DUCKDB_WORKER, duckDbAssetUrl, readDuckDbPack } from '@features/query/duckdb-pack';
import { DuckDbLease, type DuckDbHandle } from './duckdb-lease';

/** 配る一式の置き場(`build/duckdb-assets-plugin.ts` の `DUCKDB_DIR` と同じ)。 */
export const DUCKDB_BASE = 'duckdb/';

/**
 * 🔴 **時間の門**(ms)。⚠ sqlite 側(8 秒)と**違う理由で**違う値にしてある:
 * - sqlite は**ノートの DB を持つワーカー**で走るので、長引くと**保存が止まる**
 * - DuckDB は**別の使い捨てワーカー**なので、止まるのは DuckDB だけ
 * 🔑 だから少し長く取れる ── ただし**無限には待たせない**。
 * ⚠ 実測(2026-09-15):上流に中断の口は無く、`worker.terminate()` を呼んでも
 *   飛んでいる問い合わせは **10 秒待っても pending のまま**だった ── つまり
 *   **待ち手を解くのは呼び側の時計だけ**である(`duckdb-lease.ts` の `raceQuery`)。
 */
export const DUCKDB_MAX_MS = 30_000;

/** 返す行の上限(sqlite 側と揃える)。⚠ 切ったら**必ず言う**。 */
export const DUCKDB_MAX_ROWS = 200_000;

export interface DuckDbRunnerDeps {
  /** 同一オリジンの字を取ってくる(目録)。 */
  fetchText(url: string): Promise<string>;
  /** 実体を起こす。⚠ 渡す URL は**こちらが組んだ同一オリジンの物だけ**。 */
  open(input: { wasmUrl: string; workerUrl: string }): Promise<DuckDbHandle>;
  /** 基点。既定は `document.baseURI`。 */
  baseUrl?: string;
  idleMs?: number;
}

export interface DuckDbRunInput {
  readonly sql: string;
  /** 相手(csv / tsv の 1 件)。 */
  readonly source: { readonly lid: string; readonly name: string };
  /**
   * 🔴 **相手の中身を読む口**(⚠ 呼ばれるのは**器へ入れ直すときだけ**)。
   *
   * 🔑 **ここが受け取る形にしてあるのは、lid から bytes を出す道が
   *   `store-effects.ts` に 1 本だけ在るから**である(添付なら本文から鍵を読んで
   *   IDB を引き、手持ちの file なら控えを 1 回で使い捨てる)。
   *   ⚠ こちらで組み直すと、同じ問いに答える口が 2 つになる(§7)。
   * ⚠ 読めなければ `null`(断る理由を画面へ出す)。
   */
  readonly readBytes: () => Promise<Uint8Array | null>;
}

export interface DuckDbRunResult {
  readonly columns: string[];
  readonly rows: Array<Array<string | number | null>>;
  readonly truncated: boolean;
  readonly ms: number;
}

/** SQL の文字列に埋める。⚠ 題名は user の字なので**必ず**通す。 */
export function sqlQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * 🔴 **器の中での file 名は、こちらが決める固定の字**にする。
 * ⚠ 題名をそのまま使わない ── `'` や改行を含む題名が SQL の字へ混ざる。
 * 🔑 拡張子だけは残す(`read_csv_auto` が区切りを見分ける手がかりになる)。
 * ⚠ **`.csv` は実測済み / `.tsv` は未測** ── 区切りの見分けは上流の推定に任せている。
 *   外した回は上流の断り文がそのまま画面に出る(黙って化けはしない)。
 */
export function duckDbFileNameOf(name: string): string {
  return looksLikeCsvAttachmentName(name) === 'tsv' ? 'source.tsv' : 'source.csv';
}

/**
 * 差し込んだ file から表を組む 1 文。
 * 🔑 **表の名前も、足す 2 列も sqlite 側と同じ**(`csv` / `_note` / `_lid`)──
 *   揃えてあるので、**同じ SQL がどちらの engine でも通る**(比べられる)。
 * ⚠ **VIEW にしない** ── VIEW は打つたびに file を読み直すので、
 *   外を塞いだ後に**引けなくなる**(実測で `Permission Error`)。
 */
export function duckDbLoadSql(file: string, note: { lid: string; name: string }): string {
  const noteCol = CSV_SOURCE_COLUMNS[0] ?? '_note';
  const lidCol = CSV_SOURCE_COLUMNS[1] ?? '_lid';
  return (
    'CREATE OR REPLACE TABLE ' + CSV_ATTACHMENT_TABLE_NAME + ' AS SELECT ' +
    sqlQuote(note.name) + ' AS ' + noteCol + ', ' + sqlQuote(note.lid) + ' AS ' + lidCol + ', * ' +
    'FROM read_csv_auto(' + sqlQuote(file) + ')'
  );
}

/** 🔴 外を塞ぐ 1 文。⚠ **写し切った後に**打つ(前に打つと写せない ── 実測)。 */
export const DUCKDB_SEAL_SQL = 'SET enable_external_access=false';

export class DuckDbRunner {
  private readonly lease: DuckDbLease;
  /** 検めた目録(1 度読めば替わらない)。⚠ 読めなかった回は控えない。 */
  private urls: { wasmUrl: string; workerUrl: string } | null = null;

  constructor(private readonly deps: DuckDbRunnerDeps) {
    this.lease = new DuckDbLease({
      open: async () => this.deps.open(await this.resolveUrls()),
      ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
    });
  }

  /** ⚠ **test と計測のための観測点**(製品の分岐には使わない)。 */
  get awake(): boolean {
    return this.lease.awake;
  }

  /** いま畳む(面を閉じたとき)。 */
  async release(): Promise<void> {
    await this.lease.release();
  }

  async run(input: DuckDbRunInput): Promise<DuckDbRunResult> {
    const started = Date.now();
    const { lid, name } = input.source;
    const raw = await this.lease.run({
      sql: input.sql,
      maxMs: DUCKDB_MAX_MS,
      // ⚠ 鍵は lid と名前の両方(名前だけだと、同じ題名の別ノートで入れ替わらない)
      data: { key: lid + '|' + name, load: (h) => this.load(h, input.readBytes, lid, name) },
    });
    const table = duckDbTable(raw);
    const truncated = table.rows.length > DUCKDB_MAX_ROWS;
    return {
      columns: table.columns,
      rows: truncated ? table.rows.slice(0, DUCKDB_MAX_ROWS) : table.rows,
      truncated,
      ms: Date.now() - started,
    };
  }

  /**
   * 相手を差し込み、表へ写し切り、**外を塞ぐ**。
   * ⚠ **この 3 つは 1 組** ── 途中で止めると、外が開いたままの器が残る。
   *   🔑 落ちた回は `DuckDbLease` が「入っている」と控えないので、次に**やり直す**。
   */
  private async load(
    h: DuckDbHandle,
    readBytes: () => Promise<Uint8Array | null>,
    lid: string,
    name: string,
  ): Promise<void> {
    const bytes = await readBytes();
    if (bytes === null) throw new Error(name + ' の中身を読めませんでした');
    const file = duckDbFileNameOf(name);
    await h.put(file, bytes);
    await h.query(duckDbLoadSql(file, { lid, name }));
    await h.query(DUCKDB_SEAL_SQL);
  }

  /**
   * 目録を読んで、実体の在り処を決める。
   * ⚠ **信じずに検める**(`readDuckDbPack`)── 壊れた物を渡すと、上流は
   *   wasm の解釈の所で分かりにくく落ちる(user には「開かない」としか見えない)。
   */
  private async resolveUrls(): Promise<{ wasmUrl: string; workerUrl: string }> {
    const known = this.urls;
    if (known !== null) return known;
    const base = new URL(DUCKDB_BASE, this.deps.baseUrl ?? document.baseURI).href;
    let text: string;
    try {
      text = await this.deps.fetchText(duckDbAssetUrl(base, 'pack.json'));
    } catch {
      /**
       * ⚠ **一式は precache に載っていない**(設計 doc §11)── 電波が無い日は
       *   ここで落ちる。🔑 だから理由を**その言葉で**言う。
       */
      throw new Error('DuckDB の一式を取ってこられませんでした(つながっているか確かめてください)');
    }
    const read = readDuckDbPack(text);
    if (!read.ok) throw new Error(read.why);
    const urls = {
      wasmUrl: duckDbAssetUrl(base, DUCKDB_WASM),
      workerUrl: duckDbAssetUrl(base, DUCKDB_WORKER),
    };
    this.urls = urls;
    return urls;
  }
}
