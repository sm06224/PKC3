/**
 * `run-storage-gauge-probe.mjs` が測った数字を**読む側の純関数**(#999 段①)。
 *
 * ⚠ ブラウザを持たないので node の unit で通せる
 *   (`tests/adapter/probe-storage-gauge-judge.test.ts`)── 「対照群が動いた回を
 *   結果として数えない」を**機械で止める**ために切り出した。
 *
 * 🔑 CLAUDE.md §4「対照群が崩れた回を、結果として数えない」: 何もしない対照群の
 *   `fileBytes` / `freeBytes` / `ftsSegments` が動いたなら、**その回の差は経路の
 *   せいだと言えない**(別の書き込みが走っている)。判定規則は結果を見る前に決めて
 *   ここへ置く(後から緩めない)。
 */

/** 2 回の `storageGauge` の差(`ftsSegments` はどちらかが null なら null)。 */
export function gaugeDelta(before, after) {
  const d = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : b - a);
  return {
    pageCount: after.pageCount - before.pageCount,
    fileBytes: after.fileBytes - before.fileBytes,
    freeBytes: after.freeBytes - before.freeBytes,
    ftsSegments: d(before.ftsSegments, after.ftsSegments),
  };
}

/** 1 操作あたり(byte)。n が 0 なら null(0 で割らない)。 */
export function perOp(delta, n) {
  if (!n) return null;
  return {
    fileBytes: delta.fileBytes / n,
    freeBytes: delta.freeBytes / n,
    ftsSegments: delta.ftsSegments === null ? null : delta.ftsSegments / n,
  };
}

/** 対照群(何もしない)は動いていないか。 */
export function controlMoved(idle) {
  if (idle === undefined || idle === null) return { moved: true, why: '対照群(idle)が無い' };
  const d = gaugeDelta(idle.before, idle.after);
  const moved = d.fileBytes !== 0 || d.freeBytes !== 0 || (d.ftsSegments !== null && d.ftsSegments !== 0);
  return {
    moved,
    why: moved ? `対照群が動いた: file ${d.fileBytes} / free ${d.freeBytes} / 段 ${d.ftsSegments}` : null,
  };
}

/**
 * 太り方の表を読んでよいか。
 * @param {{ runs: Array<{name:string,n:number,before:object,after:object}> }} a
 * @returns {string[]} 読めない理由(空なら読んでよい)
 */
export function problemsOfPhaseA(a) {
  const out = [];
  const runs = a?.runs ?? [];
  if (runs.length === 0) return ['経路が 1 つも測れていない'];
  const idle = runs.find((r) => r.name === 'idle');
  const c = controlMoved(idle);
  if (c.moved) out.push(c.why);
  for (const r of runs) {
    if (r.name === 'idle') continue;
    if (!(r.n > 0)) out.push(`${r.name}: 0 操作(空振り)`);
    if (!(r.before?.fileBytes > 0)) out.push(`${r.name}: 前提が崩れている(測る前の file が 0)`);
  }
  return out;
}

/**
 * 検索の指紋(rowid が動いていないか)を比べる。
 * @returns {{ same: boolean, diffs: string[] }}
 */
export function compareFingerprints(a, b) {
  const diffs = [];
  if (JSON.stringify(a.counts) !== JSON.stringify(b.counts)) diffs.push('件数が違う');
  if (JSON.stringify(a.rowidAgg) !== JSON.stringify(b.rowidAgg)) diffs.push('rowid の集計が違う');
  if (JSON.stringify(a.head) !== JSON.stringify(b.head)) diffs.push('先頭の (lid, rowid) が違う');
  const qs = new Set([...Object.keys(a.sets), ...Object.keys(b.sets)]);
  for (const q of qs) {
    if (JSON.stringify(a.sets[q]) !== JSON.stringify(b.sets[q])) diffs.push(`検索「${q}」の当たりが違う`);
  }
  return { same: diffs.length === 0, diffs };
}
