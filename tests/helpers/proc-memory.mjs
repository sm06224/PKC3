/**
 * 🔴 **プロセス木の常駐を測る 1 か所**(#682 段①b で取り出した)。
 *
 * ⚠ 取り出す前は **3 本が自前の写しを持っていた** ── `tests/bench/run-app-session.mjs`
 * と `tests/probe/` の 2 本(この 2 本は互いに同一で、bench 版より**計器が痩せていた**)。
 * 🔑 ここに置いたのは **bench 版**(`Pss` と `Rss` を両方採り、`smaps_rollup` が
 * 無い環境では `status` の `VmRSS` へ落ちる)。
 *
 * 🔑 見るのは **Pss**(共有ページを持ち主の数で割った量)── ⚠ `Rss` は同じ共有
 * ページを**プロセスごとに数える**ので、プロセス数が動く比較では
 * **数が増えただけで常駐が増えたように見える**。
 *
 * ⚠ **`performance.memory` では測れない** ── あれはメインの realm の JS heap だけで、
 * **worker の中の wasm を 1 バイトも数えない**(CLAUDE.md §4 で 1 度踏んでいる)。
 * DuckDB の常駐はまさに worker の中に在るので、ここは木で採るしかない。
 *
 * ⚠ `tests/probe/` の 2 本はまだ自前の写しを使っている ── あちらは**痩せた計器**で
 * 測った数字が doc に載っているので、黙って差し替えると**過去の比較が崩れる**。
 * 差し替えるなら、同じ筋書きで両方を測って**差が無いことを見てから**にする。
 */
import { readFileSync, readdirSync } from 'node:fs';

export function readPpid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm は空白も括弧も含みうるので **最後の `)` から**読む
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}

/** そのプロセスの常駐(Pss / Rss)を KB で返す。 */
export function memKb(pid) {
  try {
    const roll = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = /^Pss:\s+(\d+) kB$/m.exec(roll);
    const rss = /^Rss:\s+(\d+) kB$/m.exec(roll);
    if (pss && rss) return { pss: Number(pss[1]), rss: Number(rss[1]) };
  } catch {
    /* smaps_rollup が無い環境は status へ落ちる */
  }
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(st);
    return rss ? { pss: 0, rss: Number(rss[1]) } : null;
  } catch {
    return null;
  }
}

/**
 * profile を握っているブラウザ本体の pid を引く。
 * ⚠ 子(renderer / gpu)は `--type=` を持つので外す ── 本体だけを根にする。
 */
export function findBrowserPid(profileDir) {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes(`--user-data-dir=${profileDir}`)) continue;
    if (cmd.includes('--type=')) continue;
    return Number(name);
  }
  return null;
}

/** ブラウザのプロセス木を全部足す(worker は renderer の中に居るので木で採る)。 */
export function treeMemoryMb(rootPid) {
  const kids = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const ppid = readPpid(Number(name));
    if (ppid === null) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(name));
  }
  let pss = 0;
  let rss = 0;
  let procs = 0;
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const m = memKb(pid);
    if (m) {
      pss += m.pss;
      rss += m.rss;
      procs += 1;
    }
    for (const k of kids.get(pid) ?? []) queue.push(k);
  }
  return { pssMb: +(pss / 1024).toFixed(1), rssMb: +(rss / 1024).toFixed(1), procs };
}

/**
 * 🔴 **profile を握っているプロセスを全部足す**(#682 段①b で足した)。
 *
 * ⚠ `treeMemoryMb`(親子で辿る)は **Chromium では取りこぼす** ── 描画プロセスは
 * **zygote 経由で親が付け替わる**ので、ブラウザ本体からの木に入らないことがある。
 * 🔴 実測(2026-09-15):200MB を確保して触っても **−2.2MB** しか動かなかった
 * (= 描画プロセスを 1 つも見ていない)。
 *
 * 🔑 だから**木ではなく `--user-data-dir` で選ぶ** ── 本体も描画も GPU も
 * 同じ profile を命令行に持つので、付け替えに影響されない。
 *
 * ⚠ **自分と親は除く**(`$$` / `$PPID` に当たる形にしない ── CLAUDE.md §6)。
 */
export function profileMemoryMb(profileDir) {
  let pss = 0;
  let rss = 0;
  let procs = 0;
  const self = process.pid;
  const parent = process.ppid;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === self || pid === parent) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes(`--user-data-dir=${profileDir}`)) continue;
    const m = memKb(pid);
    if (m) {
      pss += m.pss;
      rss += m.rss;
      procs += 1;
    }
  }
  return { pssMb: +(pss / 1024).toFixed(1), rssMb: +(rss / 1024).toFixed(1), procs };
}
