/**
 * 🔴 LTTB の間引き(v4.1 PR-7、#2095)── 山と谷を残す・端を残す・欠測で切る・小さいときは壊さない。
 */
import { describe, expect, it } from 'vitest';
import { downsampleLttb } from '../../src/features/chart/lttb';

function series(n: number, f: (i: number) => number): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = i;
    ys[i] = f(i);
  }
  return { xs, ys };
}

/** 対照群: 等間隔に間引く。 */
function strided(ys: Float64Array, threshold: number): number[] {
  const step = Math.ceil(ys.length / threshold);
  const out: number[] = [];
  for (let i = 0; i < ys.length; i += step) out.push(ys[i]!);
  return out;
}

describe('downsampleLttb', () => {
  it('点の数が threshold 以下なら写すだけ(値と添字はそのまま)', () => {
    const { xs, ys } = series(10, (i) => i * 2);
    const r = downsampleLttb(xs, ys, 0, 10, 100);
    expect([...r.ys]).toEqual([...ys]);
    expect([...r.indices]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 元の配列は書き換えない
    expect(ys[3]).toBe(6);
  });

  it('先頭と末尾を必ず残す・指定の数ほどに減らす', () => {
    const { xs, ys } = series(50_000, (i) => Math.sin(i / 50));
    const r = downsampleLttb(xs, ys, 0, 50_000, 500);
    expect(r.indices[0]).toBe(0);
    expect(r.indices[r.indices.length - 1]).toBe(49_999);
    expect(r.xs.length).toBeLessThanOrEqual(500);
    expect(r.xs.length).toBeGreaterThan(400);
    // 添字は昇順
    for (let i = 1; i < r.indices.length; i++) expect(r.indices[i]!).toBeGreaterThan(r.indices[i - 1]!);
  });

  it('尖った山と谷を残す(等間隔の間引きは取りこぼす ── 対照群)', () => {
    const { xs, ys } = series(20_000, (i) => (i === 7_777 ? 100 : i === 13_331 ? -100 : Math.sin(i / 300)));
    const r = downsampleLttb(xs, ys, 0, 20_000, 400);
    expect(Math.max(...r.ys)).toBe(100);
    expect(Math.min(...r.ys)).toBe(-100);
    const naive = strided(ys, 400);
    expect(Math.max(...naive)).toBeLessThan(100);
    expect(Math.min(...naive)).toBeGreaterThan(-100);
  });

  it('範囲 [start, end) だけを間引く', () => {
    const { xs, ys } = series(10_000, (i) => i % 13);
    const r = downsampleLttb(xs, ys, 2_000, 6_000, 200);
    expect(r.indices[0]).toBe(2_000);
    expect(r.indices[r.indices.length - 1]).toBe(5_999);
  });

  it('欠測(NaN)は線の切れ目 1 つになり、両側の区間を別に間引く', () => {
    const { xs, ys } = series(10_000, (i) => (i >= 4_000 && i < 4_100 ? NaN : Math.cos(i / 40)));
    const r = downsampleLttb(xs, ys, 0, 10_000, 300);
    const gaps = [...r.ys].filter((v) => Number.isNaN(v)).length;
    expect(gaps).toBe(1);
    const gapAt = [...r.ys].findIndex((v) => Number.isNaN(v));
    expect(r.indices[gapAt - 1]).toBe(3_999);
    expect(r.indices[gapAt + 1]).toBe(4_100);
    expect(r.indices[r.indices.length - 1]).toBe(9_999);
  });

  it('全部欠測なら空', () => {
    const { xs, ys } = series(5_000, () => NaN);
    expect(downsampleLttb(xs, ys, 0, 5_000, 100).xs.length).toBe(0);
  });

  it('50,000 点を速く(< 50ms)', () => {
    const { xs, ys } = series(50_000, (i) => Math.sin(i) * Math.random());
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) downsampleLttb(xs, ys, 0, 50_000, 1_600);
    expect((performance.now() - t0) / 5).toBeLessThan(50);
  });
});
