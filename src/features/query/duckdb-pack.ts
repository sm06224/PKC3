/**
 * 🔴 **配った DuckDB の目録を読む**(#682 段①b。裁定 2026-09-15 = PKC3 自身が配る)。
 *
 * `build/duckdb-assets-plugin.ts` が `dist/duckdb/pack.json` に置く目録を、
 * **信じずに検める**層。⚠ ここは pure ── 取ってくるのも起こすのも adapter の仕事。
 *
 * ## なぜ「検める」が要るか
 *
 * 取ってきた物が壊れていても、`instantiate` は**遠い所で分かりにくく落ちる**
 * (wasm の解釈で落ちるので、user には「開かない」としか見えない)。
 * 🔑 **目録の段で落として、理由を 1 行で言う**ほうが直せる。
 */

/** 配る実体 1 件。 */
export interface DuckDbPackFile {
  readonly path: string;
  readonly bytes: number;
}

export interface DuckDbPack {
  readonly version: string;
  readonly files: readonly DuckDbPackFile[];
}

/**
 * 読めたか / 読めなかったか。⚠ **3 値にしない** ── ここは「無い」と「壊れている」を
 * 区別する必要がない(どちらも「取り直してください」で同じ)。
 */
export type PackRead = { readonly ok: true; readonly pack: DuckDbPack } | { readonly ok: false; readonly why: string };

/** 必ず在る 2 つ。⚠ 綴りは plugin の `SHIPPED` と同じ(`tests/features/duckdb-pack.test.ts` が pin)。 */
export const DUCKDB_WASM = 'duckdb-eh.wasm';
export const DUCKDB_WORKER = 'duckdb-browser-eh.worker.js';

/**
 * 🔴 **DuckDB エンジンの版と、台の名前**(#682 段④b)。
 *
 * ⚠ **npm の `@duckdb/duckdb-wasm` の版とは別物**である(あちらは `1.33.1-dev57.0`)。
 *   拡張は**エンジンの版と完全一致**でなければ読み込めないので、ここが正本になる。
 * 🔑 実測(2026-09-16、`SELECT version()`):`v1.5.4`。台の名前は、拡張を持たない器へ
 *   `LOAD` を打ったとき engine が error に書いた URL から採った(`wasm_eh`)。
 * ⚠ **この字は、配る `duckdb-eh.wasm` の中に実在する**(engine が拡張の URL を
 *   組むため)── `build/duckdb-assets-plugin.ts` がそれを突き合わせて、
 *   食い違ったらビルドを落とす。
 */
export const DUCKDB_ENGINE = { version: 'v1.5.4', platform: 'wasm_eh' } as const;

/**
 * 🔴 **同梱して、開いた直後に読み込む拡張**(#682 段④b。user 要望 2026-09-16)。
 *
 * | 名前 | 何のため |
 * |---|---|
 * | `json` | json / ndjson を読む・`COPY … (FORMAT JSON)` |
 * | `parquet` | parquet を読む・書く |
 * | `sqlite_scanner` | 取り込んだ `.sqlite` を DuckDB で引く |
 *
 * ⚠ **ここに無い拡張は、いまも外へ取りに行かない** ── `duckdb-open.ts` が
 *   `autoinstall` / `autoload` を切っているので、catalog に無いと即断られる。
 *   🔑 その対照群は `tests/features/duckdb-pack.test.ts` と probe に在る。
 */
export const DUCKDB_EXTENSIONS = ['json', 'parquet', 'sqlite_scanner'] as const;

export type DuckDbExtensionName = (typeof DUCKDB_EXTENSIONS)[number];

/**
 * 🔴 **拡張の置き場**(pack の中の相対)。#682 段④b。
 *
 * ⚠ **この形は engine が決めている。こちらの好みではない。**
 * 実測(2026-09-16、実ブラウザ・8 通り):DuckDB は `custom_extension_repository` に
 * 渡した字の下から
 * **`<置き場>/<版>/<台>/<名前>.duckdb_extension.wasm`** を **HTTP GET** する
 * (server の log で path を直に確認した)。
 */
export const DUCKDB_EXT_DIR = 'ext';

/**
 * 拡張 1 つの、pack の中での path。⚠ **綴りの正本はここ** ── plugin も検品も
 * この関数を通す(§7「同じ値が複数の場所にある」)。
 *
 * 🔴 **版と台を path に入れる** ── engine がこの形で取りに来るので、入れないと
 *   **404 になって「読み込めない」だけが残る**(実測 F/G)。
 */
export function duckDbExtensionPath(name: string): string {
  return `${DUCKDB_EXT_DIR}/${DUCKDB_ENGINE.version}/${DUCKDB_ENGINE.platform}/${name}.duckdb_extension.wasm`;
}

/**
 * 🔴 **端末へ入れておける物**(#682 段③b の `DuckDbPackStore` が持つ物)。
 *
 * ⚠ **拡張は入らない。** 実測(2026-09-16、実ブラウザ):拡張は
 * **必ず HTTP GET で取りに来る** ── `registerFileBuffer` で器の中へ先に置いても
 * 素通りして GET が飛ぶ(案 F / G)。端末の一式が貸せるのは `blob:` URL だけで、
 * **`blob:` に path は作れない**ので、置き場として成り立たない。
 * 🔑 だから拡張は**いつも同一オリジンの `duckdb/ext/` から**読む。
 * ⚠ 帰結:**電波が無いと拡張は読み込めない**(一式を端末へ入れてあっても)。
 *   ここを塞ぐには SW に `duckdb/ext/` を持たせる必要があり、それは別の段である。
 */
export const DUCKDB_PACK_FILES: readonly string[] = [DUCKDB_WASM, DUCKDB_WORKER];

/**
 * 配る一式に必ず在る file(起動に要る 2 つ + 同梱する拡張)。
 * 🔑 **目録の検めと、配った物の検品**がこれを回す。
 * ⚠ **取得と保管は `DUCKDB_PACK_FILES`** のほう ── 集合が違うので分けてある。
 */
export const DUCKDB_REQUIRED_FILES: readonly string[] = [
  ...DUCKDB_PACK_FILES,
  ...DUCKDB_EXTENSIONS.map(duckDbExtensionPath),
];

/**
 * ⚠ **下限を置く** ── 0 バイトや途中で切れた物を「在る」と数えない。
 * 🔑 実測(2026-09-15):wasm **35,913,747** / worker **773,223** byte。
 *   拡張は(2026-09-16)json **821,413** / parquet **3,218,307** /
 *   sqlite_scanner **1,641,696** byte。
 *   下限はどれもその半分弱 ── 事故の桁(空 / 切れた)だけを止める。
 * ⚠ **上限は置かない** ── 配る量は判断理由にしない(不可侵指示 2026-08-03)。
 */
const EXT_FLOOR: Readonly<Record<DuckDbExtensionName, number>> = {
  json: 400_000,
  parquet: 1_500_000,
  sqlite_scanner: 800_000,
};

const FLOOR: Readonly<Record<string, number>> = {
  [DUCKDB_WASM]: 16_000_000,
  [DUCKDB_WORKER]: 300_000,
  ...Object.fromEntries(
    DUCKDB_EXTENSIONS.map((name) => [duckDbExtensionPath(name), EXT_FLOOR[name]]),
  ),
};

function isFile(v: unknown): v is DuckDbPackFile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['path'] === 'string' && typeof o['bytes'] === 'number' && Number.isFinite(o['bytes']);
}

/**
 * 目録を読む。⚠ **読めない形は全部「取り直してください」に畳む** ──
 * user に JSON の文法の話をしない。
 */
export function readDuckDbPack(text: string): PackRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, why: 'DuckDB の目録が読めません(取り直してください)' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, why: 'DuckDB の目録が読めません(取り直してください)' };
  }
  const o = raw as Record<string, unknown>;
  const version = o['version'];
  const files = o['files'];
  if (typeof version !== 'string' || version === '') {
    return { ok: false, why: 'DuckDB の目録に版がありません(取り直してください)' };
  }
  if (!Array.isArray(files) || !files.every(isFile)) {
    return { ok: false, why: 'DuckDB の目録の中身が読めません(取り直してください)' };
  }
  for (const want of DUCKDB_REQUIRED_FILES) {
    const got = files.find((f) => f.path === want);
    if (got === undefined) {
      return { ok: false, why: `DuckDB の一式に ${want} がありません(取り直してください)` };
    }
    /**
     * 🔑 **下限を引けない名前は在りえない** ── `DUCKDB_REQUIRED_FILES` も `FLOOR` も
     *   同じ `DUCKDB_EXTENSIONS` から組むので、**足し忘れる形が構造から消えている**
     *   (`EXT_FLOOR` は `Record<DuckDbExtensionName, number>` なので、名前を 1 つ
     *   足したら tsc が下限を要求する)。
     * ⚠ だから「引けなかったとき」の枝は書かない ── 書いても**誰も通らない死んだ枝**に
     *   なり、鳴らない検査が 1 つ増えるだけである(CLAUDE.md §7)。
     */
    if (got.bytes < (FLOOR[want] ?? 0)) {
      // ⚠ 数字を出す ── 「壊れています」だけだと、こちらも後から原因を絞れない
      return { ok: false, why: `DuckDB の ${want} が小さすぎます(${got.bytes} byte。取り直してください)` };
    }
  }
  return { ok: true, pack: { version, files } };
}

/**
 * 実体の在り処を組む(`base` + `path`)。
 *
 * 🔴 **⚠ ここは「同一オリジン」を守っていない**(2026-09-15 に読み直して判明)。
 *   直す前のこの docstring は「**同一オリジンの相対 path だけ**を組む ── 外の宛先を
 *   組める形にしない」と書いていたが、中身は**ただの文字列の連結**である ──
 *   `base` に `https://…` を渡せば、外の宛先が**そのまま組める**。
 * ⚠ つまり**守っていない物を守っていると書いていた**(CLAUDE.md §1「後条件は、
 *   確かめた事実の上にだけ書く」)。⚠ 悪いのは、その字を読んだ次の人が
 *   **検めずに `base` を渡す**ことである。
 * 🔑 **本物の門は adapter 側に置いた** ── `duckdb-pack-acquire.ts` の
 *   `resolveDuckDbBase()` が `document.baseURI` と origin を突き合わせて断る
 *   (Office の `resolveBase()` と同じ形)。⚠ ここは**その門を通った base** を
 *   受け取る前提の、組み立てだけの関数である。
 */
export function duckDbAssetUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${path}`;
}

/**
 * 🔴 **画面に出す「およその大きさ」**(#986 段③で features 側へ移した)。
 *
 * ⚠ 直す前は `adapter/platform/duckdb/duckdb-pack-install.ts` の中の非公開の定数で、
 *   **他の面から引けなかった** ── だから「捨てても残る物」を並べる窓が
 *   **数を手で書く**しかなくなる(手で書いた数は、一式を替えた日に嘘になる)。
 * 🔴 **数から組み立てない**(`${…}MB` と書かない)── `tests/features/human-bytes.test.ts` が
 *   「実行時の値にバイト単位を付ける所は `human-bytes.ts` だけ」を守っている
 *   (`OFFICE_PACK_APPROX` と同じ作法)。
 */
export const DUCKDB_PACK_APPROX = '約 35MB';
