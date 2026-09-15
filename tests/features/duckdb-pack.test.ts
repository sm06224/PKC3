/**
 * 🔴 **配った DuckDB の目録を、信じずに検める**(#682 段①b)。
 *
 * ⚠ ここで落とさないと、壊れた一式は `instantiate` の**遠い所**で落ちる ──
 * user には「開かない」としか見えず、こちらも原因を絞れない。
 */
import { describe, expect, it } from 'vitest';
import {
  DUCKDB_WASM,
  DUCKDB_WORKER,
  duckDbAssetUrl,
  readDuckDbPack,
} from '../../src/features/query/duckdb-pack';
import { DUCKDB_DIR, DUCKDB_PACK } from '../../build/duckdb-assets-plugin';

/** 実測(2026-09-15)の byte 数。 */
const REAL = { wasm: 35_913_747, worker: 773_223 };

const pack = (over: Partial<{ version: string; files: unknown }> = {}): string =>
  JSON.stringify({
    version: '1.33.1-dev57.0',
    files: [
      { path: DUCKDB_WASM, bytes: REAL.wasm },
      { path: DUCKDB_WORKER, bytes: REAL.worker },
    ],
    ...over,
  });

describe('🔴 目録を検める(#682)', () => {
  it('🟢 実物と同じ形なら読める', () => {
    const r = readDuckDbPack(pack());
    expect(r.ok, r.ok ? '' : r.why).toBe(true);
    if (r.ok) {
      expect(r.pack.version).toBe('1.33.1-dev57.0');
      expect(r.pack.files).toHaveLength(2);
    }
  });

  it('🔴 JSON として読めない → 取り直してくださいに畳む', () => {
    const r = readDuckDbPack('{ ずれた');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('取り直して');
  });

  it('🔴 版が無い / 空 → 断る', () => {
    for (const v of ['', undefined]) {
      const r = readDuckDbPack(pack({ version: v as string }));
      expect(r.ok, `版が ${JSON.stringify(v)} なのに通った`).toBe(false);
      if (!r.ok) expect(r.why).toContain('版');
    }
  });

  it('🔴 要る file が欠けている → その名前を言って断る', () => {
    const r = readDuckDbPack(pack({ files: [{ path: DUCKDB_WORKER, bytes: REAL.worker }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain(DUCKDB_WASM);
  });

  it('🔴 空 / 途中で切れた一式 → 数字を出して断る', () => {
    const r = readDuckDbPack(
      pack({
        files: [
          { path: DUCKDB_WASM, bytes: 12 },
          { path: DUCKDB_WORKER, bytes: REAL.worker },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    // ⚠ 数字を出す ── 「壊れています」だけだと、後から原因を絞れない
    if (!r.ok) expect(r.why).toMatch(/12 byte/u);
  });

  it('🔴 files が配列でない → 断る', () => {
    expect(readDuckDbPack(pack({ files: 'x' })).ok).toBe(false);
  });

  /**
   * 🔴 **型の門だけが効く形で見る**(変異試験 M4 が SURVIVED で教えた)。
   *
   * ⚠ 1 稿目は `[{ path: DUCKDB_WASM }]`(bytes 無し)で見ていたが、これは
   *   **別の門に救われて**落ちていた ── `undefined < 16_000_000` は **false** なので
   *   下限では落ちず、「worker がありません」で落ちる。つまり型の門を外しても緑だった。
   * 🔑 だから **2 つとも名前は正しく、`bytes` の型だけが違う**形にする ──
   *   型の門を外すと `'big' < 16_000_000` も false なので、**通ってしまう**。
   */
  it('🔴 bytes の型だけが違う ── ここは型の門しか止められない', () => {
    const r = readDuckDbPack(
      pack({
        files: [
          { path: DUCKDB_WASM, bytes: 'big' },
          { path: DUCKDB_WORKER, bytes: REAL.worker },
        ],
      }),
    );
    expect(r.ok, '型の門が効いていない(bytes が数でなくても通った)').toBe(false);
    // ⚠ **どの門が鳴ったか**まで見る ── 別の門に救われた回と区別できない
    if (!r.ok) expect(r.why).toContain('中身が読めません');
  });

  it('🔑 綴りが plugin と 1 つ(片方だけ改名すると、配った物を探せなくなる)', () => {
    // ⚠ plugin が配る名前と、読む側が探す名前は**同じでなければならない**
    expect(DUCKDB_PACK).toBe(`${DUCKDB_DIR}pack.json`);
    const r = readDuckDbPack(pack());
    expect(r.ok).toBe(true);
  });

  it('🔴 在り処は同一オリジンの相対だけ ── 外の宛先を組めない', () => {
    expect(duckDbAssetUrl('duckdb', DUCKDB_WASM)).toBe(`duckdb/${DUCKDB_WASM}`);
    expect(duckDbAssetUrl('duckdb/', DUCKDB_WASM)).toBe(`duckdb/${DUCKDB_WASM}`);
    // ⚠ 空振り防止 ── 組み立てが実際に連結していること
    expect(duckDbAssetUrl('a/b', 'c.wasm')).toBe('a/b/c.wasm');
  });
});
