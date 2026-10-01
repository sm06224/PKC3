/**
 * 保存領域の太り方・片づけの所要を実ブラウザで測る(#999 段①)。
 *
 * 前提: vite dev server が `--port <port>` で起動していること。例:
 *   npx vite --port 47801 --strictPort &
 *   PKC3_CHROMIUM=/opt/pw-browsers/chromium node tests/probe/storage-gauge-probe.mjs \
 *     --port=47801 --phases=a,b,c,e --sizes=20,200,1000 --out=/tmp/x/999-gauge-chromium.json
 *
 * 測るもの(1 主張ずつ。**製品へ口は足さない** ── 片づけは probe が複文で打つ):
 *   a  経路ごとの太り方(対照群 = 何もしない同時間)
 *   b  FTS の `optimize` の前後(file / 空き / 段)
 *   c  VACUUM の所要・前後・一時的な増え方・worker の常駐(プロセス木の Pss)・検索の指紋(rowid)
 *   e  VACUUM の途中で worker を殺す → 開き直して無傷か
 *   (f 空きが足りないときの挙動は、箱の OPFS を埋めるのが危険なので**測らない**)
 *
 * ⚠ 出力は **file に落としてから読む**(`| tail` に通さない ── 落ちたことが消える)。
 * ⚠ 対照群が動いた回 / 前提が崩れた回は、数字を出しても `problems` に理由を書き、
 *   終了コードを 1 にする(`storage-gauge-judge.mjs`)。
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  compareFingerprints,
  gaugeDelta,
  perOp,
  problemsOfPhaseA,
} from './storage-gauge-judge.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : 'true'];
  }),
);
const PORT = Number(args.port ?? 47801);
const PHASES = (args.phases ?? 'a,b,c,e').split(',');
const SIZES = (args.sizes ?? '20,200').split(',').map(Number);
const N = Number(args.n ?? 200);
const BASE = Number(args.base ?? 1500);
const KB = Number(args.kb ?? 4);
const SEED_KB = Number(args.seedkb ?? 8);
const PROFILE = args.profile ?? `/tmp/999-gauge-profile-${process.pid}`;
const OUT = args.out ?? null;
const executablePath = process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium';
const RUN = Date.now().toString(36);
// 製品の既定は truncate。⚠ 変えるのは e(殺す実験)だけ ── 既定と他の journal で殺し方の結果が違うかを見る
const JOURNAL = args.journal ?? null;

// ── プロセス木の Pss(worker は renderer の中に居るので木で採る。`run-app-session.mjs` と同じ手)
function readPpid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}
function memKb(pid) {
  try {
    const roll = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = /^Pss:\s+(\d+) kB$/m.exec(roll);
    return pss ? Number(pss[1]) : null;
  } catch {
    return null;
  }
}
function findBrowserPid(profileDir) {
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
function treePssMb(rootPid) {
  const kids = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const ppid = readPpid(Number(name));
    if (ppid === null) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(name));
  }
  let pss = 0;
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const m = memKb(pid);
    if (m !== null) pss += m;
    for (const k of kids.get(pid) ?? []) queue.push(k);
  }
  return +(pss / 1024).toFixed(1);
}

const mb = (b) => (b === null || b === undefined ? null : +(b / 1048576).toFixed(2));
const out = { meta: {}, problems: [] };
const log = (tag, obj) => console.log(`[${tag}] ${JSON.stringify(obj)}`);
function save() {
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
}

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE, { executablePath });
let rootPid = null;
const pss = () => (rootPid === null ? null : treePssMb(rootPid));

/** fn の間、250ms ごとに Pss を採る(node 側は止まらないので worker が塞がっていても採れる)。 */
async function withPss(fn) {
  const baseline = pss();
  const samples = [];
  const iv = setInterval(() => samples.push(pss()), 250);
  try {
    const result = await fn();
    clearInterval(iv);
    return { result, pssMb: { baseline, peak: Math.max(baseline ?? 0, ...samples), after: pss(), samples: samples.length } };
  } finally {
    clearInterval(iv);
  }
}

try {
  let page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  // ⚠ console の中身は読まない(本文が混じりうる)── error の件数だけ数える
  let consoleErrors = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors++;
  });
  await page.goto(`http://localhost:${PORT}/tests/probe/storage-gauge-probe.html`);
  await page.waitForFunction(() => window.__GAUGE_READY__ === true, null, { timeout: 60_000 });
  rootPid = findBrowserPid(PROFILE);
  const version = await page.evaluate(() => window.navigator.userAgent);
  const est = await page.evaluate(() => window.__GAUGE__.storageUsage());
  out.meta = {
    executablePath,
    userAgent: version,
    phases: PHASES,
    sizesMb: SIZES,
    n: N,
    base: BASE,
    kb: KB,
    seedKb: SEED_KB,
    rootPid,
    storageEstimate: est,
    run: RUN,
    journalOverride: JOURNAL,
  };
  log('meta', out.meta);

  const G = (fn, ...a) => page.evaluate(([f, args]) => window.__GAUGE__[f](...args), [fn, a]);
  const dbName = (tag) => `g-${tag}-${RUN}`;

  // ─────────────── a: 経路ごとの太り方
  if (PHASES.includes('a')) {
    const a = { runs: [] };
    out.a = a;
    const paths = ['save', 'saveCheckpoint', 'appendJobs', 'appendMessages', 'reorder', 'delete'];
    const sampleEvery = Math.max(1, Math.floor(N / 10));
    for (const name of paths) {
      const opened = await G('openDb', dbName('a-' + name));
      const seed = await G('seed', 0, BASE, KB);
      // 定常の姿から測る: メッセージ置き場は上限まで埋め、本文は 100 回保存して「編集セッション後」にする
      if (name === 'appendJobs') await G('prefillMessages', 'sys-jobs', '処理', 5000);
      if (name === 'appendMessages') await G('prefillMessages', 'sys-messages', 'メッセージ', 500);
      const ctx = { base: BASE, kb: KB };
      await page.evaluate(async ([ctx]) => {
        // warm: 100 回保存(amend)
        const G = window.__GAUGE__;
        await G.runPath('save', 100, ctx, 100);
      }, [ctx]);
      let r;
      if (name === 'delete') r = await G('runDelete', N, KB, BASE);
      else r = await page.evaluate(([name, N, ctx, se]) => window.__GAUGE__.runPath(name, N, ctx, se), [name, N, ctx, sampleEvery]);
      r.opened = opened;
      r.seedMs = seed.ms;
      r.delta = gaugeDelta(r.before, r.after);
      r.perOp = perOp(r.delta, r.n);
      a.runs.push(r);
      log('a', { name, n: r.n, ms: r.ms, delta: r.delta, perOp: r.perOp, before: r.before.fileBytes, segB: r.before.ftsSegments, segA: r.after.ftsSegments });
      await G('close');
    }
    // 対照群: 最長の経路と同じ時間だけ何もしない(同じ手順で開いて、同じ warm を済ませてから)
    const longest = Math.max(...a.runs.map((r) => r.ms));
    await G('openDb', dbName('a-idle'));
    await G('seed', 0, BASE, KB);
    await page.evaluate(async ([ctx]) => {
      await window.__GAUGE__.runPath('save', 100, ctx, 100);
    }, [{ base: BASE, kb: KB }]);
    const idle = await G('runIdle', longest);
    idle.delta = gaugeDelta(idle.before, idle.after);
    a.runs.push(idle);
    log('a', { name: 'idle', waitMs: longest, delta: idle.delta });
    await G('close');
    a.problems = problemsOfPhaseA(a);
    out.problems.push(...a.problems.map((p) => 'a: ' + p));
    save();
  }

  // ─────────────── b: optimize の前後(編集セッション後の DB で)
  if (PHASES.includes('b')) {
    await G('openDb', dbName('b'));
    await G('seed', 0, BASE, KB);
    await G('prefillMessages', 'sys-jobs', '処理', 5000);
    const ctx = { base: BASE, kb: KB };
    const session = [];
    for (const name of ['save', 'saveCheckpoint', 'appendJobs', 'reorder']) {
      const r = await page.evaluate(([name, N, ctx]) => window.__GAUGE__.runPath(name, N, ctx, N), [name, N, ctx]);
      session.push({ name, n: r.n, ms: r.ms });
    }
    const del = await G('runDelete', N, KB, BASE);
    session.push({ name: 'delete+purge', n: del.n, ms: del.ms });
    const queries = await G('queries', BASE);
    const fpBefore = await G('fingerprint', queries);
    const g0 = await G('gauge');
    const opt1 = await G('raw', "INSERT INTO entries_fts(entries_fts) VALUES ('optimize')");
    const g1 = await G('gauge');
    const opt2 = await G('raw', "INSERT INTO entries_fts(entries_fts) VALUES ('optimize')");
    const g2 = await G('gauge');
    // 続けて VACUUM(optimize が出した空きを返すか。⚠ file が縮むのはここだけ)
    const vac = await G('raw', 'VACUUM');
    const g3 = await G('gauge');
    const fpAfter = await G('fingerprint', queries);
    const qc = await G('quickCheck');
    out.b = {
      session,
      afterSession: g0,
      afterOptimize1: { ms: opt1.ms, gauge: g1, delta: gaugeDelta(g0, g1) },
      afterOptimize2: { ms: opt2.ms, gauge: g2, delta: gaugeDelta(g1, g2) },
      afterVacuum: { ms: vac.ms, gauge: g3, delta: gaugeDelta(g2, g3) },
      searchSame: compareFingerprints(fpBefore, fpAfter),
      quickCheck: qc.rows,
    };
    log('b', out.b);
    await G('close');
    save();
  }

  // ─────────────── c: VACUUM(大きさ 3 点)+ d: 検索の指紋
  /**
   * 1 つの大きさで「太った DB」を作る: file が目標に届くまで本文を足し、3 割を消す
   * (`i % 10 < 3`)。⚠ 消しても file は縮まない = VACUUM が返す対象。
   */
  async function buildChurned(tag, sizeMb) {
    await G('openDb', dbName(tag), 20, JOURNAL);
    const seeded = await G('seedToBytes', sizeMb * 1048576, SEED_KB);
    const del = await G('raw', "DELETE FROM entries WHERE cid = 'g' AND CAST(substr(lid, 2) AS INTEGER) % 10 < 3");
    return { seeded, deleteMs: del.ms };
  }
  const vacuumMs = {};
  if (PHASES.includes('c')) {
    out.c = [];
    for (const sizeMb of SIZES) {
      const entry = { sizeMb };
      out.c.push(entry);
      try {
        const built = await buildChurned('c-' + sizeMb, sizeMb);
        const seeded = built.seeded;
        entry.seed = { entries: seeded.entries, ms: seeded.ms, maxGaugeMs: seeded.maxGaugeMs };
        entry.deleteMs = built.deleteMs;
        const queries = await G('queries', seeded.entries);
        const fpBefore = await G('fingerprint', queries);
        const before = await G('gauge');
        entry.before = before;
        const usageBefore = await G('storageUsage');
        // ① VACUUM だけ(消した直後の状態から)
        const v = await withPss(() => G('vacuumTimed'));
        entry.vacuum = {
          ms: v.result.ms,
          err: v.result.err,
          opfsUsagePeakMb: mb(Math.max(...v.result.usageSeries.map((s) => s.usage ?? 0))),
          opfsUsageBeforeMb: mb(usageBefore.usage),
          opfsUsageAfterMb: mb(v.result.usageSeries.at(-1).usage),
          pssMb: v.pssMb,
        };
        vacuumMs[sizeMb] = v.result.ms;
        const after = await G('gauge');
        entry.after = after;
        entry.delta = gaugeDelta(before, after);
        const fpAfter = await G('fingerprint', queries);
        entry.searchAndRowid = compareFingerprints(fpBefore, fpAfter);
        entry.rowidAggBefore = fpBefore.rowidAgg;
        entry.rowidAggAfter = fpAfter.rowidAgg;
        entry.quickCheck = (await G('quickCheck')).rows;
        // ② FTS の optimize(縮まないが空きが増える)→ ③ もう一度 VACUUM(optimize で出た空きを返すか)
        const opt = await G('raw', "INSERT INTO entries_fts(entries_fts) VALUES ('optimize')");
        const afterOpt = await G('gauge');
        const v2 = await withPss(() => G('vacuumTimed'));
        const afterV2 = await G('gauge');
        const fpAfter2 = await G('fingerprint', queries);
        entry.thenOptimizeAndVacuum = {
          optimizeMs: opt.ms,
          afterOptimize: afterOpt,
          vacuum2Ms: v2.result.ms,
          vacuum2PssMb: v2.pssMb,
          afterVacuum2: afterV2,
          searchSame: compareFingerprints(fpBefore, fpAfter2),
        };
        // 🔑 負の対照: **わざと rowid をずらす**(索引は追随しない)と、同じ指紋が「違う」と出ること。
        //    出なければ、上の「同じ」は見ていないのと同じ(検索の問いが rowid に鈍いだけ)。
        if (sizeMb === SIZES[0]) {
          await G('raw', "UPDATE entries SET rowid = rowid + 1000000 WHERE cid = 'g'");
          const fpMoved = await G('fingerprint', queries);
          entry.negativeControl = compareFingerprints(fpBefore, fpMoved);
          if (entry.negativeControl.same) out.problems.push('c: 負の対照(rowid を動かした)が「同じ」と出た = 指紋が rowid に鈍い');
        }
        log('c', entry);
        await G('close');
        entry.pssAfterCloseMb = pss();
      } catch (e) {
        entry.error = String(e);
        log('c-error', { sizeMb, error: String(e) });
        try {
          await G('close');
        } catch {
          /* 開けていない */
        }
      }
      save();
    }
  }

  // ─────────────── e: VACUUM の途中で殺す(1 回ごとに DB を作り直す)
  /**
   * 殺し方は 3 つ(`--kills=<種類>:<VACUUM の何割の時点か>,…`):
   * - `terminate` … `Worker.terminate()`(コードが閉じる相当ではない。**効くかどうか**を測る)
   * - `close`     … タブを閉じる(`page.close()`)
   * - `sigkill`   … renderer プロセスを `SIGKILL`(クラッシュ・強制終了の相当)
   * ⚠ 1 回ごとに DB を作り直す ── 1 度終わった DB は、次の回に返す空きが無い。
   */
  if (PHASES.includes('e')) {
    const sizeMb = Number(args.esize ?? SIZES.find((s) => s >= 200) ?? SIZES.at(-1));
    const T = vacuumMs[sizeMb] ?? Number(args.etime ?? 3000);
    const e = { sizeMb, vacuumMsUsedForFractions: T, kills: [] };
    out.e = e;
    // 書式: `<殺し方>:<VACUUM の何割か>` / `<殺し方>@<ms>:update`(対照 = 大きな本文の書き換え)
    const plan = (
      args.kills ??
      'terminate:0.2,sigkill:0.02,sigkill:0.1,sigkill:0.2,sigkill:0.35,sigkill:0.5,sigkill:0.7,sigkill:0.9,close:0.2,close:0.5,sigkill@150:update,sigkill@400:update,sigkill@800:update'
    )
      .split(',')
      .map((s) => {
        const [head, what] = s.split(':');
        if (what === 'update') {
          const [how, ms] = head.split('@');
          return { what: 'update', how, at: Number(ms), frac: null };
        }
        return { what: 'vacuum', how: head, at: Math.round(T * Number(what)), frac: Number(what) };
      });
    const renderers = () => {
      // ⚠ 本体 → 子のうち `--type=renderer` を、Pss の大きい順に(page と worker はここに居る)
      const list = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8');
          if (cmd.includes(`--user-data-dir=${PROFILE}`) && cmd.includes('--type=renderer')) {
            list.push({ pid: Number(name), pss: memKb(Number(name)) ?? 0 });
          }
        } catch {
          /* 消えた */
        }
      }
      return list.sort((a, b) => b.pss - a.pss);
    };
    for (const { what, how, frac, at } of plan) {
      const tag = `e-${sizeMb}-${what}-${how}-${frac ?? at}`;
      const name = dbName(tag);
      const built = await buildChurned(tag, sizeMb);
      const queries = await G('queries', built.seeded.entries);
      const fp0 = await G('fingerprint', queries);
      const g0 = await G('gauge');
      const k = { what, how, frac, afterMs: at, baseline: { fileBytes: g0.fileBytes, freeBytes: g0.freeBytes } };
      // VACUUM を投げっぱなしにして(await しない)、決めた時間だけ待つ
      await G('startKillTarget', what);
      await new Promise((r) => setTimeout(r, k.afterMs));
      const killedAt = Date.now();
      if (how === 'wait') {
        // 対照: 殺さずに最後まで待ち、普通に閉じる(= 「開き直して読める」が成り立つことの確認)
        k.targetMs = await G('waitTarget');
        await G('close');
      } else if (how === 'terminate') {
        await G('terminateWorker');
      } else if (how === 'close') {
        await page.close();
      } else if (how === 'sigkill') {
        const r = renderers();
        k.renderersKilled = r.length;
        for (const { pid } of r) process.kill(pid, 'SIGKILL');
      } else {
        throw new Error('殺し方を知らない: ' + how);
      }
      if (how !== 'terminate' && how !== 'wait') {
        // 死んだ page は捨てて、同じ profile(= 同じ OPFS)で新しい page を開く
        await Promise.race([
          page.close({ runBeforeUnload: false }).catch(() => {}),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
        page = await context.newPage();
        await page.goto(`http://localhost:${PORT}/tests/probe/storage-gauge-probe.html`);
        await page.waitForFunction(() => window.__GAUGE_READY__ === true, null, { timeout: 60_000 });
        rootPid = findBrowserPid(PROFILE) ?? rootPid;
      }
      let reopened;
      try {
        reopened = await G('openDb', name, 20, JOURNAL);
      } catch (err) {
        // 🔴 開き直せなかった = 殺した後の DB が使えない(製品の `init` が落ちた)。理由をそのまま残す
        k.reopenMs = Date.now() - killedAt;
        k.state = 'init-failed(開き直せない)';
        k.reopenError = String(err).slice(0, 300);
        log('e', k);
        e.kills.push(k);
        save();
        continue;
      }
      k.reopenMs = Date.now() - killedAt;
      k.reopenAttempts = reopened.attempts;
      try {
        k.quickCheck = (await G('quickCheck')).rows;
        const fp = await G('fingerprint', queries);
        k.same = compareFingerprints(fp0, fp);
        const g = await G('gauge');
        k.gauge = { fileBytes: g.fileBytes, freeBytes: g.freeBytes, ftsSegments: g.ftsSegments };
        if (what === 'update') {
          // 対照: 全か無か(0 件 = 巻き戻った / 全件 = 終わっていた / その間 = 途中の状態が見えている)
          const [[total, touched]] = await G('rows', "SELECT count(*), sum(substr(body, -1) = ' ') FROM entries WHERE cid = 'g'");
          k.bodyTouched = { total, touched: touched ?? 0 };
          k.state = !k.bodyTouched.touched ? 'rolled-back(殺す前と同じ)' : k.bodyTouched.touched === total ? 'completed(全件書き換わっていた)' : 'other(途中の状態)';
        } else {
          k.state =
            g.fileBytes === g0.fileBytes && g.freeBytes === g0.freeBytes
              ? 'rolled-back(殺す前と同じ)'
              : g.freeBytes === 0
                ? 'completed(空きが 0 = VACUUM は終わっていた)'
                : 'other(途中の状態)';
        }
        // 殺した後でも VACUUM が最後まで通ること
        const done = await G('vacuumTimed');
        k.vacuumAfterKill = { ms: done.ms, err: done.err };
        const fpEnd = await G('fingerprint', queries);
        k.finalSame = compareFingerprints(fp0, fpEnd);
        k.finalQuickCheck = (await G('quickCheck')).rows;
      } catch (err) {
        // 🔴 開けたが読めない(製品の「読み込めません」の門が立った / 読む途中で落ちた)。理由をそのまま残す
        k.state = 'opened-but-unreadable(開けたが読めない)';
        k.verifyError = String(err).slice(0, 200);
        try {
          k.quickCheckAfterError = (await G('quickCheck')).rows.slice(0, 3);
        } catch (err2) {
          k.quickCheckAfterError = 'quick_check も落ちた: ' + String(err2).slice(0, 120);
        }
      }
      log('e', k);
      e.kills.push(k);
      await G('close').catch(() => {});
      save();
    }
  }

  out.meta.consoleErrors = consoleErrors;
  if (out.problems.length > 0) {
    console.error('[problems]', out.problems);
    process.exitCode = 1;
  }
  save();
} finally {
  await context.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
