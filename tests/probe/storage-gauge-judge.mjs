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
 * 🔴 **索引の片づけ(`optimizeIndexes`)を製品の op で打った回を、読んでよいか**(#999 段③)。
 *
 * 守っているのは 4 つ(判定規則は結果を見る前に置いた ── 後から緩めない):
 * - **1 秒以内に返る**(往復。裁定の根拠は「0.4 秒で害が無い」)
 * - **畳む前に複数段が在った**(1 段なら「畳んだ」と言えない = 空振り)→ 畳んだ後は 1 段
 * - **空きは増えるか同じ**(縮めていない ── VACUUM を打っていない)
 * - **file は縮まない**
 * @param {{ roundTripMs: number, result: { before: object, after: object } } | undefined} g
 * @returns {string[]} 読めない / 満たさない理由(空なら読んでよい)
 */
export function problemsOfOptimizeOp(g) {
  const out = [];
  if (!g || !g.result) return ['optimizeIndexes を打てていない'];
  const { before, after } = g.result;
  if (!(g.roundTripMs <= 1000)) out.push(`往復が 1 秒を超えた: ${g.roundTripMs} ms`);
  if (!(before.ftsSegments >= 2)) out.push(`前提が崩れている(畳む前の段が ${before.ftsSegments}。複数段が要る)`);
  if (after.ftsSegments !== 1) out.push(`畳まれていない(畳んだ後の段が ${after.ftsSegments})`);
  if (!(after.freeBytes >= before.freeBytes)) out.push('空きが減った(VACUUM を打っている)');
  if (!(after.fileBytes >= before.fileBytes)) out.push('file が縮んだ(VACUUM を打っている)');
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

/**
 * 🔴 **長い更新の途中で殺して開き直した回の「結末」を 1 つに分ける**(#1218 F1)。
 *
 * - `init-failed`   … 開き直せなかった(製品の `init` が落ちた)
 * - `unreadable`    … 開けたが `quick_check` が ok でない / 読めなかった
 * - `completed`     … 全件書き換わっていた(殺す前に終わっていた = 測れていない)
 * - `rolled-back`   … 変更行 0(殺す前と同じ)
 * - `half`          … 途中の状態が見えている(巻き戻されも終わりもしていない)
 * @param {{ reopen?: string, quickCheck?: string[], total?: number, touched?: number }} k
 */
export function stateOfKill(k) {
  if (k.reopen !== 'ok') return 'init-failed';
  if (!Array.isArray(k.quickCheck) || k.quickCheck.join() !== 'ok') return 'unreadable';
  if (!(k.total > 0)) return 'unreadable';
  if (k.touched === k.total) return 'completed';
  if (!k.touched) return 'rolled-back';
  return 'half';
}

/**
 * 🔴 **殺して開き直す probe を読んでよいか**(#1218 F1)。判定規則は結果を見る前に置いた。
 *
 * - `expect = 'patched'`(製品のまま):**全部**が `rolled-back`。差し替えが当たっていない回・
 *   殺す前に終わっていた回(= 測れていない)・壊れた回は、それぞれ別の理由で返る
 * - `expect = 'unpatched'`(対照群 = 差し替えを外した build):差し替わっていないこと、そして
 *   **1 件以上が壊れる**(`init-failed` / `unreadable`)こと。1 件も壊れなければ
 *   「差し替えが効いて救っている」と言えない(= 同じ殺し方で壊れる事実が無い)
 * @param {Array<{ killAtMs: number, patched?: boolean, reopen?: string, quickCheck?: string[], total?: number, touched?: number }>} kills
 * @param {'patched' | 'unpatched'} expect
 * @returns {string[]} 読めない / 満たさない理由(空なら読んでよい)
 */
export function problemsOfReservedLock(kills, expect) {
  const out = [];
  if (!Array.isArray(kills) || kills.length === 0) return ['殺した回が 1 つも無い'];
  if (expect !== 'patched' && expect !== 'unpatched') return [`expect が不明: ${String(expect)}`];
  let broken = 0;
  for (const k of kills) {
    const at = `${k.killAtMs}ms`;
    const state = stateOfKill(k);
    if (state === 'init-failed' || state === 'unreadable') broken++;
    if (expect === 'patched') {
      if (k.patched !== true) out.push(`${at}: 差し替えが当たっていない(patched = ${String(k.patched)})`);
      if (state === 'completed') out.push(`${at}: 殺す前に更新が終わっていた(測れていない。殺す時点を早める)`);
      else if (state !== 'rolled-back') out.push(`${at}: 巻き戻っていない(${state})`);
    } else if (k.patched !== false) {
      out.push(`${at}: 対照群なのに差し替わっている(patched = ${String(k.patched)})`);
    }
  }
  if (expect === 'unpatched' && broken === 0) {
    out.push('対照群が 1 件も壊れなかった(同じ殺し方で壊れる事実が無い ── 差し替えが効いたとは言えない)');
  }
  return out;
}
