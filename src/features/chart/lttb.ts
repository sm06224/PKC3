/**
 * 🔴 **LTTB(Largest-Triangle-Three-Buckets)の間引き**(v4.1 PR-7、#2095)── 大量の折れ線を、
 * 画面の幅に合わせて**山と谷を残したまま**間引く純関数。
 *
 * - 入出力は TypedArray(中間のオブジェクトを作らない)。将来 WebGPU の Compute Shader へ差し替えられるよう、
 *   境界はこの関数 1 つにしておく(GPU の描画と 2D の簡易表示が同じこれを呼ぶ ── CLAUDE.md §7)。
 * - **先頭と末尾の点は必ず残す**。
 * - 欠測(`NaN`)は線の切れ目として扱う: 欠測を挟んだ連続の区間ごとに枠を配って間引き、区間の間には
 *   欠測の点を 1 つ挟む(描く側はそこで線を切る)。
 * - 点の数が `threshold` 以下なら間引かない(範囲を写すだけ)。
 */

export interface LttbResult {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** 元の配列での添字(ホバーの読み上げ・確かめ用)。 */
  readonly indices: Uint32Array;
}

function copyRange(xs: Float64Array, ys: Float64Array, start: number, end: number): LttbResult {
  const n = end - start;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = start + i;
  return { xs: xs.slice(start, end), ys: ys.slice(start, end), indices };
}

/** 欠測の無い 1 区間 [s, e) を `budget` 点へ間引いて `out` に書く。書いた数を返す。 */
function lttbRun(
  xs: Float64Array,
  ys: Float64Array,
  s: number,
  e: number,
  budget: number,
  out: { xs: Float64Array; ys: Float64Array; idx: Uint32Array },
  at: number,
): number {
  const n = e - s;
  if (n <= budget || budget < 3) {
    if (budget < 3 && n > 2) {
      // 枠が 2 しか無い ── 端の 2 点だけ
      out.xs[at] = xs[s]!;
      out.ys[at] = ys[s]!;
      out.idx[at] = s;
      out.xs[at + 1] = xs[e - 1]!;
      out.ys[at + 1] = ys[e - 1]!;
      out.idx[at + 1] = e - 1;
      return 2;
    }
    for (let i = 0; i < n; i++) {
      out.xs[at + i] = xs[s + i]!;
      out.ys[at + i] = ys[s + i]!;
      out.idx[at + i] = s + i;
    }
    return n;
  }
  const every = (n - 2) / (budget - 2);
  let a = s;
  let w = at;
  out.xs[w] = xs[a]!;
  out.ys[w] = ys[a]!;
  out.idx[w] = a;
  w++;
  for (let i = 0; i < budget - 2; i++) {
    // 次のバケツの平均(三角形の 3 点目)
    let avgStart = s + Math.floor((i + 1) * every) + 1;
    let avgEnd = s + Math.floor((i + 2) * every) + 1;
    if (avgEnd > e) avgEnd = e;
    if (avgStart >= avgEnd) avgStart = avgEnd - 1;
    let avgX = 0;
    let avgY = 0;
    const len = avgEnd - avgStart;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += xs[j]!;
      avgY += ys[j]!;
    }
    avgX /= len;
    avgY /= len;
    // このバケツ
    const rangeStart = s + Math.floor(i * every) + 1;
    const rangeEnd = Math.min(s + Math.floor((i + 1) * every) + 1, e - 1);
    const ax = xs[a]!;
    const ay = ys[a]!;
    let maxArea = -1;
    let pick = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((ax - avgX) * (ys[j]! - ay) - (ax - xs[j]!) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        pick = j;
      }
    }
    out.xs[w] = xs[pick]!;
    out.ys[w] = ys[pick]!;
    out.idx[w] = pick;
    w++;
    a = pick;
  }
  out.xs[w] = xs[e - 1]!;
  out.ys[w] = ys[e - 1]!;
  out.idx[w] = e - 1;
  w++;
  return w - at;
}

/**
 * [startIdx, endIdx) を `threshold` 点ほどに間引く(欠測の切れ目の点は数に含めない)。
 * @param threshold 目安の点の数(描画の幅 × 2 ほど)。3 未満は 3 に揃える。
 */
export function downsampleLttb(
  xs: Float64Array,
  ys: Float64Array,
  startIdx: number,
  endIdx: number,
  threshold: number,
): LttbResult {
  const start = Math.max(0, Math.min(startIdx, xs.length));
  const end = Math.max(start, Math.min(endIdx, xs.length, ys.length));
  const count = end - start;
  const th = Math.max(3, Math.floor(threshold));
  if (count <= th) return copyRange(xs, ys, start, end);

  // 欠測の無い区間 [s, e) を拾う(欠測の並びは 1 つの切れ目にまとめる)
  const runs: number[] = [];
  const gaps: number[] = [];
  let finite = 0;
  let runStart = -1;
  for (let i = start; i < end; i++) {
    const ok = !Number.isNaN(ys[i]!) && !Number.isNaN(xs[i]!);
    if (ok) {
      finite++;
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      runs.push(runStart, i);
      gaps.push(i);
      runStart = -1;
    } else if (runs.length > 0 && gaps.length < runs.length / 2) {
      gaps.push(i);
    }
  }
  if (runStart >= 0) runs.push(runStart, end);
  const runCount = runs.length / 2;
  if (runCount === 0) return { xs: new Float64Array(0), ys: new Float64Array(0), indices: new Uint32Array(0) };
  if (finite <= th) {
    // 欠測を除けば枠に収まる ── 点を全部(切れ目つき)
    return copyRange(xs, ys, start, end);
  }
  // 区間ごとの枠(点の数に比例。各区間に最低 2 点)
  const budgets = new Array<number>(runCount);
  let used = 0;
  for (let r = 0; r < runCount; r++) {
    const len = runs[r * 2 + 1]! - runs[r * 2]!;
    const b = Math.min(len, Math.max(len >= 2 ? 2 : 1, Math.floor((th * len) / finite)));
    budgets[r] = b;
    used += b;
  }
  const cap = used + Math.max(0, runCount - 1);
  const out = { xs: new Float64Array(cap), ys: new Float64Array(cap), idx: new Uint32Array(cap) };
  let w = 0;
  for (let r = 0; r < runCount; r++) {
    if (r > 0) {
      // 切れ目(欠測の点)── 描く側はここで線を切る
      const g = gaps[r - 1] ?? runs[r * 2]! - 1;
      out.xs[w] = xs[g]!;
      out.ys[w] = NaN;
      out.idx[w] = g;
      w++;
    }
    w += lttbRun(xs, ys, runs[r * 2]!, runs[r * 2 + 1]!, budgets[r]!, out, w);
  }
  return { xs: out.xs.subarray(0, w), ys: out.ys.subarray(0, w), indices: out.idx.subarray(0, w) };
}
