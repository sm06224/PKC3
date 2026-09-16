/**
 * 🔴 **配った DuckDB の目録を、信じずに検める**(#682 段①b)。
 *
 * ⚠ ここで落とさないと、壊れた一式は `instantiate` の**遠い所**で落ちる ──
 * user には「開かない」としか見えず、こちらも原因を絞れない。
 */
import { describe, expect, it } from 'vitest';
import {
  DUCKDB_EXTENSIONS,
  DUCKDB_REQUIRED_FILES,
  DUCKDB_WASM,
  DUCKDB_WORKER,
  duckDbAssetUrl,
  duckDbExtensionPath,
  readDuckDbPack,
} from '../../src/features/query/duckdb-pack';
import { DUCKDB_DIR, DUCKDB_PACK } from '../../build/duckdb-assets-plugin';

/** 実測の byte 数(2026-09-15 = 器 / 2026-09-16 = 拡張)。 */
const REAL: Readonly<Record<string, number>> = {
  [DUCKDB_WASM]: 35_913_747,
  [DUCKDB_WORKER]: 773_223,
  [duckDbExtensionPath('json')]: 821_413,
  [duckDbExtensionPath('parquet')]: 3_218_307,
  [duckDbExtensionPath('sqlite_scanner')]: 1_641_696,
};

/**
 * 🔑 **一式は `DUCKDB_REQUIRED_FILES` から組む** ── 手で並べると、
 * 足した人が並べ忘れた日にこの fixture だけ古くなる(そして
 * 「実物と同じ形」を名乗ったまま、実物と違う形を検めることになる)。
 */
const files = (): { path: string; bytes: number }[] =>
  DUCKDB_REQUIRED_FILES.map((path) => ({ path, bytes: REAL[path] ?? 0 }));

const pack = (over: Partial<{ version: string; files: unknown }> = {}): string =>
  JSON.stringify({ version: '1.33.1-dev57.0', files: files(), ...over });

describe('🔴 目録を検める(#682)', () => {
  it('🟢 実物と同じ形なら読める', () => {
    const r = readDuckDbPack(pack());
    expect(r.ok, r.ok ? '' : r.why).toBe(true);
    if (r.ok) {
      expect(r.pack.version).toBe('1.33.1-dev57.0');
      // ⚠ 数は `DUCKDB_REQUIRED_FILES` から引く ── 手で書くと、足した日に嘘になる
      expect(r.pack.files).toHaveLength(DUCKDB_REQUIRED_FILES.length);
      expect(DUCKDB_REQUIRED_FILES.length, '拡張 3 つを数えていない').toBe(5);
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
    /**
     * 🔑 **要る物を 1 つずつ抜いて、全部当てる**(#682 段④b で 2 → 5 に増えた)。
     * ⚠ 代表 1 件だけ抜く形では、**後から足した拡張の門が死んでも緑**になる
     *   (門を N 個置いたら、N 個目だけが鳴る場面を N 通り作る ── CLAUDE.md §1)。
     */
    for (const missing of DUCKDB_REQUIRED_FILES) {
      const r = readDuckDbPack(pack({ files: files().filter((f) => f.path !== missing) }));
      expect(r.ok, `${missing} を抜いたのに通った`).toBe(false);
      if (!r.ok) expect(r.why, '欠けた物の名前を言っていない').toContain(missing);
    }
  });

  it('🔴 空 / 途中で切れた一式 → 数字を出して断る', () => {
    // 🔑 下限も**要る物の全部**に効いていることを見る(上と同じ理由)
    for (const cut of DUCKDB_REQUIRED_FILES) {
      const r = readDuckDbPack(
        pack({ files: files().map((f) => (f.path === cut ? { ...f, bytes: 12 } : f)) }),
      );
      expect(r.ok, `${cut} が 12 byte なのに通った`).toBe(false);
      // ⚠ 数字を出す ── 「壊れています」だけだと、後から原因を絞れない
      if (!r.ok) expect(r.why).toMatch(/12 byte/u);
    }
  });

  /**
   * 🔴 **空振り防止** ── 上の 2 つは「全部落ちる」を見るので、
   * `readDuckDbPack` が**何をしても false を返す**形に壊れても緑になる。
   * 🔑 だから「無傷なら通る」を同じ形で 1 本置く。
   */
  it('⚠ 対照群 ── どれも抜いていなければ通る', () => {
    for (const name of DUCKDB_EXTENSIONS) {
      expect(REAL[duckDbExtensionPath(name)], `${name} の実測値が fixture に無い`).toBeGreaterThan(
        0,
      );
    }
    expect(readDuckDbPack(pack()).ok).toBe(true);
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
