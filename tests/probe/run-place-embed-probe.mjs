/**
 * #529 W3-③ ── 板に N 枚置いたノートの中身を描くときの**常駐メモリ**と**応答**を測る。
 *
 * > user 指示 2026-08-03(不可侵)「測って報告すべきは配る量ではなく、**継続使用の常駐メモリ**と
 * > **操作の応答**である」
 *
 * ## 何を比べるか
 * - `--arm=on` … 中身を描く(いまの実装)
 * - `--arm=off` … **対照群**。同じ板・同じ大きさの枠で、**本文を頼まない**(= 帯だけ。中身を描く前の見た目)。
 *   ⚠ 「何もしない」ではなく「測りたい操作(中身の描画)以外を全部同じにしたもの」。
 *   頼む口(`PLACE_BODIES_WANTED`)だけを dev の `dispatcher` で止める。
 *
 * ## 何を出すか(1 回の起動 = 1 つの (N, arm))
 * - `pssMb` … **profile を握る全プロセスの Pss**(`tests/helpers/proc-memory.mjs`)。⚠ `heapMb` は
 *   メインの realm の JS heap だけ(worker・GPU・画像のデコードは見えない)
 * - `settleMs` … 板を開いてから、中身を出した枠の数が**最後に増えた**までの時間(冷 = 初回 / 温 = 開き直し)
 * - `scroll.*` … 板を端から端まで 1 往復したときの long task と**心拍(4ms)の最大空き**
 *   (long task は 50ms 未満を落とすので、心拍も見る)
 * - `filled` / `figures` / `attImages` … 実際に出た枠・焼けた図・絵になった添付の数(**空振り防止**)
 *
 * ⚠ **計器の自己検査を先頭に置く**(`perf-measurement` §2.5):既知の 300ms の詰まりが long task に出ること /
 *   100MB を触ったら Pss が 60MB 以上動くこと。どちらかが鳴らなければ**測らずに落ちる**。
 *
 * 使い方(dev server を立ててから):
 *   npx vite --port 48064 &
 *   node tests/probe/run-place-embed-probe.mjs --n=40 --arm=on
 * 任意: `--passes=N`(板を端から端まで往復する回数、既定 2)/ `--idle=ms`(各往復の後の静止、既定 4000 ──
 *   **離れた枠を捨てる仕掛けを試すなら、その猶予より長く**)/ `--mix=text|fig|img|all`(台の中身を絞って
 *   原因を切り分ける)/ `--variant=名前`(出力に載せる札。腕を並べて集計するため)
 * ⚠ 各回の末尾で**メモリ圧迫の通知**(CDP の `Memory.simulatePressureNotification`)を送り、返させた後の常駐
 *   (`purged`)と DOM の節点・文書・購読の数(`counters`)も出す。
 * ⚠ dev の bundle は minify されないので**絶対値は製品より重い**。同じ台での差(on − off)と N への傾きを読む。
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { profileMemoryMb } from '../helpers/proc-memory.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 48064);
const N = Number(args.n ?? 40);
const ARM = args.arm === 'off' ? 'off' : 'on';
/** 往復の回数と、各往復の後に置く静止(ms)。⚠ 離れた枠を捨てるまでの猶予(1.5 秒)より**長く**置く。 */
const PASSES = Number(args.passes ?? 2);
const IDLE = Number(args.idle ?? 4000);
const PROFILE = `/tmp/pkc3-place-embed-probe-${String(PORT)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  args: ['--js-flags=--expose-gc'],
  executablePath: process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium',
});
const out = { n: N, arm: ARM, ...(args.variant ? { variant: args.variant } : {}), ...(args.mix ? { mix: args.mix } : {}) };
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  // ObjectURL の残高(焼いた PNG・貸した画像がどれだけ生きているか)
  await page.addInitScript(() => {
    const w = window;
    w.__m = { long: 0, longMs: 0, made: 0, freed: 0, gapMs: 0 };
    const mk = URL.createObjectURL.bind(URL);
    const fr = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      w.__m.made += 1;
      return mk(b);
    };
    URL.revokeObjectURL = (u) => {
      w.__m.freed += 1;
      fr(u);
    };
  });
  await page.goto(`http://localhost:${String(PORT)}/tests/probe/place-embed-probe.html?n=${String(N)}&mix=${args.mix ?? 'all'}`);
  await page.waitForFunction(() => window.__APP__, null, { timeout: 120_000 });
  await page.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60_000 });
  await sleep(1500);

  await page.evaluate(() => {
    const w = window;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__m.long += 1;
        w.__m.longMs += e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - last > w.__m.gapMs) w.__m.gapMs = now - last;
      last = now;
    }, 4);
  });
  const markStart = () =>
    page.evaluate(() => {
      window.__m.gapMs = 0;
      return { long: window.__m.long, longMs: window.__m.longMs };
    });
  const markEnd = (base) =>
    page.evaluate(async (b) => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        longTasks: window.__m.long - b.long,
        longTaskMs: Math.round(window.__m.longMs - b.longMs),
        maxGapMs: Math.round(window.__m.gapMs),
      };
    }, base);
  const gc = async () => {
    for (let i = 0; i < 2; i += 1) {
      await page.evaluate(() => (typeof window.gc === 'function' ? window.gc() : undefined));
      await sleep(200);
    }
  };

  // ── 自己検査 1:既知の 300ms の詰まりが long task に出るか
  const b0 = await markStart();
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          const end = performance.now() + 300;
          while (performance.now() < end);
          resolve();
        }, 0);
      }),
  );
  const probed = await markEnd(b0);
  if (probed.maxGapMs < 200 || probed.longTasks < 1)
    throw new Error(`計器が既知の 300ms の詰まりを観測できていない: ${JSON.stringify(probed)}`);
  // ── 自己検査 2:100MB を触ったら Pss が動くか(= 全プロセスを見ている)
  await gc();
  const pss0 = profileMemoryMb(PROFILE);
  await page.evaluate(() => {
    window.__ballast = new Uint8Array(100 * 1024 * 1024).fill(1);
  });
  await sleep(300);
  const pss1 = profileMemoryMb(PROFILE);
  await page.evaluate(() => {
    window.__ballast = null;
  });
  if (pss1.pssMb - pss0.pssMb < 60)
    throw new Error(`Pss が 100MB の確保に反応しない(描画プロセスを見ていない?): ${pss0.pssMb} → ${pss1.pssMb}`);
  out.selfCheck = { gapMs: probed.maxGapMs, pssMovedMb: +(pss1.pssMb - pss0.pssMb).toFixed(1), procs: pss1.procs };

  // 対照群:本文を頼む口だけを止める
  if (ARM === 'off') {
    await page.evaluate(() => {
      const d = window.__APP__.dispatcher;
      const orig = d.dispatch.bind(d);
      d.dispatch = (a) => (a && a.type === 'PLACE_BODIES_WANTED' ? undefined : orig(a));
    });
  }

  await gc();
  out.baseline = profileMemoryMb(PROFILE);
  out.baselineHeapMb = await page.evaluate(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));

  /** 板を開いて、中身を出した枠の数が落ち着くまで。 */
  const openBoard = async (label) => {
    const base = await markStart();
    const t0 = Date.now();
    await page.evaluate(() => window.__APP__.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'board' }));
    let lastChange = t0;
    let lastFilled = -1;
    let lastBlocks = 0;
    for (let i = 0; i < 400; i += 1) {
      const s = await page.evaluate(() => ({
        blocks: document.querySelectorAll('[data-pkc-region="detail"] .pkc-place[data-pkc-place-entry]').length,
        filled: document.querySelectorAll('[data-pkc-region="detail"] [data-pkc-field="place-body"][data-pkc-place-body-key]').length,
      }));
      if (s.filled !== lastFilled || s.blocks !== lastBlocks) {
        lastFilled = s.filled;
        lastBlocks = s.blocks;
        lastChange = Date.now();
      }
      if (lastBlocks >= N && Date.now() - lastChange > 600) break;
      await sleep(25);
    }
    const res = await markEnd(base);
    out[label] = { settleMs: lastChange - t0, blocks: lastBlocks, filled: lastFilled, ...res };
  };
  await openBoard('openCold');

  /** 板を端から端まで 1 往復する(心拍と long task)。 */
  const scrollPass = async () => {
    const base = await markStart();
    const t0 = Date.now();
    await page.evaluate(async () => {
      const sc = document.querySelector('[data-pkc-region="detail"]');
      const max = sc.scrollHeight - sc.clientHeight;
      const step = 220;
      for (let y = 0; y <= max; y += step) {
        sc.scrollTop = y;
        await new Promise((r) => window.requestAnimationFrame(() => setTimeout(r, 40)));
      }
      for (let y = max; y >= 0; y -= step) {
        sc.scrollTop = y;
        await new Promise((r) => window.requestAnimationFrame(() => setTimeout(r, 40)));
      }
    });
    const res = await markEnd(base);
    return { ms: Date.now() - t0, ...res };
  };
  out.scroll = await scrollPass();
  await sleep(IDLE);
  await gc();
  out.steady = profileMemoryMb(PROFILE);
  out.steadyHeapMb = await page.evaluate(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));

  // もう 1 往復して、傾き(2 回目で増え続けるか)を見る。⚠ 暖機(図を焼く・画像を読む)と漏れを分けるため、
  // `--passes` で往復を増やして**各回の後**の常駐を並べる
  out.scroll2 = await scrollPass();
  await sleep(IDLE);
  await gc();
  out.steady2 = profileMemoryMb(PROFILE);
  out.passes = [out.steady.pssMb, out.steady2.pssMb];
  for (let i = 2; i < PASSES; i += 1) {
    await scrollPass();
    await sleep(IDLE);
    await gc();
    out.passes.push(profileMemoryMb(PROFILE).pssMb);
  }

  // 🔴 ブラウザは解放したメモリをすぐ OS へ返さない(画像のデコード控え・割り当て器の空き)── 圧迫の通知
  //    (critical)を送って**返させた後**の常駐も採る。`steady*` は「普通に使っているとき」、`purged` は
  //    「中身として残っている分」。⚠ 2 つを分けないと、器の再利用で膨らんだ分を「漏れ」と読む
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('Memory.simulatePressureNotification', { level: 'critical' });
  await sleep(2500);
  await gc();
  out.purged = profileMemoryMb(PROFILE);
  // DOM の節点・文書・イベント購読の数(捨てた枠の節点が GC 待ちで居座っていないか / 購読が積もっていないか)
  out.counters = await cdp.send('Memory.getDOMCounters');

  out.dom = await page.evaluate(() => ({
    nodes: document.getElementsByTagName('*').length,
    slots: document.querySelectorAll('[data-pkc-field="place-body"]').length,
    imgs: document.querySelectorAll('[data-pkc-region="detail"] img').length,
    figures: document.querySelectorAll('[data-pkc-region="detail"] img[data-pkc-field="mermaid-image"]').length,
    attImages: [...document.querySelectorAll('img[data-pkc-field="place-attachment-image"]')].filter(
      (i) => i.complete && i.naturalWidth > 0,
    ).length,
    bodyImages: [...document.querySelectorAll('[data-pkc-field="place-body"] img[data-pkc-asset-key]')].filter(
      (i) => i.complete && i.naturalWidth > 0,
    ).length,
    liveObjectUrls: window.__m.made - window.__m.freed,
    made: window.__m.made,
    freed: window.__m.freed,
  }));

  // 温:別のノートへ移ってから開き直す(描き直し + 図・画像の再取得)
  await page.evaluate(() => window.__APP__.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'p0' }));
  await sleep(800);
  await gc();
  out.afterLeave = profileMemoryMb(PROFILE);
  out.afterLeaveObjectUrls = await page.evaluate(() => window.__m.made - window.__m.freed);
  await openBoard('openWarm');
  out.errors = errors;
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out));
  await ctx.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
