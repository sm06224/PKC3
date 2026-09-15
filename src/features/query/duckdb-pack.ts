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
 * ⚠ **下限を置く** ── 0 バイトや途中で切れた物を「在る」と数えない。
 * 🔑 実測(2026-09-15):wasm **35,913,747** / worker **773,223** byte。
 *   下限はその半分弱 ── 事故の桁(空 / 切れた)だけを止める。
 */
const FLOOR = { [DUCKDB_WASM]: 16_000_000, [DUCKDB_WORKER]: 300_000 } as const;

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
  for (const want of [DUCKDB_WASM, DUCKDB_WORKER] as const) {
    const got = files.find((f) => f.path === want);
    if (got === undefined) {
      return { ok: false, why: `DuckDB の一式に ${want} がありません(取り直してください)` };
    }
    if (got.bytes < FLOOR[want]) {
      // ⚠ 数字を出す ── 「壊れています」だけだと、こちらも後から原因を絞れない
      return { ok: false, why: `DuckDB の ${want} が小さすぎます(${got.bytes} byte。取り直してください)` };
    }
  }
  return { ok: true, pack: { version, files } };
}

/**
 * 実体の在り処。⚠ **同一オリジンの相対 path だけ**を組む ──
 * 🔴 外の宛先を組める形にしない(組めるようにした瞬間、次に書く人が CDN を渡せる)。
 */
export function duckDbAssetUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${path}`;
}
