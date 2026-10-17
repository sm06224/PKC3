/** @vitest-environment node */
/**
 * 🔴 **器の中で書いた file を取り出して、すぐ捨てる**(`DuckDbLease.runFile`。#918 段⑥)。
 *
 * ⚠ 守るのは 3 つ:①取り出した後に**必ず外す**(成功も失敗も)②**書き込みの回と違い、器を持ち続けない**
 *   (`hold` を立てない = 30 秒で畳む規律が生きている)③時計(`maxMs`)が **statements 全体**に掛かる。
 */
import { describe, expect, it } from 'vitest';
import { DUCKDB_TOO_LONG, DuckDbLease, type DuckDbHandle } from '../../src/adapter/platform/duckdb/duckdb-lease';

function handle(opts: { failQuery?: boolean; hang?: boolean; noRead?: boolean } = {}) {
  const steps: string[] = [];
  const h: DuckDbHandle = {
    put: () => Promise.resolve(),
    drop: (name) => {
      steps.push('drop:' + name);
      return Promise.resolve();
    },
    query: (sql) => {
      steps.push(sql);
      if (opts.hang === true) return new Promise(() => undefined);
      if (opts.failQuery === true) return Promise.reject(new Error('書けない'));
      return Promise.resolve({ columns: [], types: [], rows: [] });
    },
    terminate: () => {
      steps.push('terminate');
      return Promise.resolve();
    },
    ...(opts.noRead === true
      ? {}
      : {
          readFile: (name: string) => {
            steps.push('read:' + name);
            return Promise.resolve(new Uint8Array([1, 2]));
          },
        }),
  };
  return { h, steps };
}

/** 時計を手で進める lease。 */
function leaseOf(h: DuckDbHandle) {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const lease = new DuckDbLease({
    open: () => Promise.resolve(h),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { live: boolean }).live = false;
    },
  });
  return { lease, timers };
}

describe('🔴 runFile ── 書いた file を取り出して捨てる(#918 段⑥)', () => {
  it('書く → 読む → 外す の順で、bytes を返す', async () => {
    const { h, steps } = handle();
    const { lease } = leaseOf(h);
    const bytes = await lease.runFile({}, { statements: ['COPY 1', 'COPY 2'], file: 'f.parquet' });
    expect(Array.from(bytes)).toEqual([1, 2]);
    expect(steps).toEqual(['COPY 1', 'COPY 2', 'read:f.parquet', 'drop:f.parquet']);
  });

  it('🔴 書くのが落ちた回も file を外す(読みには行かない)', async () => {
    const { h, steps } = handle({ failQuery: true });
    const { lease } = leaseOf(h);
    await expect(lease.runFile({}, { statements: ['COPY'], file: 'f.parquet' })).rejects.toThrow('書けない');
    expect(steps).toContain('drop:f.parquet');
    expect(steps).not.toContain('read:f.parquet');
  });

  it('⚠ 取り出す口が無ければ、何も打たずに理由を言って断る', async () => {
    const { h, steps } = handle({ noRead: true });
    const { lease } = leaseOf(h);
    await expect(lease.runFile({}, { statements: ['COPY'], file: 'f.parquet' })).rejects.toThrow('書き出せません');
    expect(steps, '取り出せないのに書いている').toEqual([]);
  });

  it('🔴 書き込みの回と違い、器を持ち続けない(アイドルの時計を張る)', async () => {
    const { h } = handle();
    const { lease, timers } = leaseOf(h);
    await lease.runFile({}, { statements: ['COPY'], file: 'f.parquet' });
    expect(
      timers.some((t) => t.live),
      '書き出しの後にアイドルの時計が張られていない(`hold` が立っている)',
    ).toBe(true);
  });

  it('🔴 時計が statements 全体に掛かる ── 鳴ったら器を畳み、断る', async () => {
    const { h, steps } = handle({ hang: true });
    const { lease, timers } = leaseOf(h);
    const done = lease.runFile({ maxMs: 5 }, { statements: ['COPY'], file: 'f.parquet' });
    // 器を起こして COPY を打つところまで進める
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const clock = timers.find((t) => t.ms === 5 && t.live);
    expect(clock, '時計が張られていない').toBeDefined();
    clock?.fn();
    await expect(done).rejects.toThrow(DUCKDB_TOO_LONG);
    expect(steps, '時計が鳴ったのに器を畳んでいない').toContain('terminate');
  });
});
