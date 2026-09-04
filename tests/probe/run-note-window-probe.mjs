/**
 * PKC3 計器: **付箋を何枚も開いたとき、常駐と打鍵はどうなるか**(#685、2026-09-04)。
 *
 * 🔴 **なぜ要るか。** user 不可侵指示(2026-08-03)は
 * 「**初回起動が遅くとも許容 / その後の動作がメモリくったり、もっさりだと嫌**」である。
 * 付箋は「何枚でも開ける」ことが売りなので、**枚数に比例して効く**次元を
 * 1 度は測っておかないと、この指示に触れているかどうか言えない。
 * ⚠ #300 段① の計器(`run-window-follower-probe.mjs`)は **3 枚まで**しか測っておらず、
 * しかも**面の窓**(器いっぱい)である ── 付箋は **420x720 の細い窓**なので別物である。
 *
 * ## 測るもの(1 つずつ独立に主張する)
 *
 * ① **常駐** ── ⚠ 観測点は**プロセス木の Pss**(#114)。`performance.memory` は
 *    メインの realm の JS heap しか見ないので、renderer が増える話には答えられない。
 * ② **打鍵の応答** ── ⚠ 観測点は **long task の合計**と**打ち終わるまでの実時間**。
 *    ⚠ 「量が多い」と「体感が悪い」は別の主張である(PKC2 の教訓)。
 * ③ **閉じたら還るか** ── 付箋を全部閉じて、①の値が戻るか。
 *
 * ## 🔴 実測(2026-09-04。2 回走らせて同じ向き・同じ桁)
 *
 * | 付箋 | Pss(プロセス木) | プロセス |
 * |---|---|---|
 * | 0 枚(対照群) | 397.5 / 400.5 MB | 8 |
 * | 1 枚 | 438.9 / 438.5(**+38〜41**) | 9 |
 * | 3 枚 | 511.2 / 512.4 | 11 |
 * | 5 枚 | 582.3 / 582.8(**+182〜185 / 1 枚あたり +36.5**) | 13 |
 * | 5 枚を閉じた後 | **388.7 / 405.4** | **8** |
 *
 * | 打鍵(追記欄・25 字) | 打っている間だけ | long task |
 * |---|---|---|
 * | 付箋 0 枚(対照群) | 679 ms | **0 件** |
 * | 付箋 5 枚 | 675 ms | **0 件** |
 *
 * 🔑 **1 枚 = renderer 1 個(+36.5 MB)。閉じれば全部還る**(8 プロセスに戻る)。
 * 🔑 **5 枚開けても打鍵は変わらない**(679 → 675 ms。差は測定の揺れの内側)。
 * ⚠ 「0 件」が読めるのは**計器が鳴ることを先に見ている**からである
 * (自己検査:わざと 250ms 詰まらせたら 1 件鳴った)。
 *
 * ⚠ **測っていないこと**: 実機のブラウザ / 10 枚以上 / 長時間の常駐 /
 * 実 IME での打鍵 / 付箋の窓**の中**での打鍵(ここで測ったのは**本体の窓**である)。
 *
 * ## 🔴 対照群
 *
 * **付箋 0 枚の同じ手順**を先に通す。⚠ これが無いと、出た数字が
 * 「付箋のせい」なのか「このアプリはもともとそうなのか」を区別できない。
 * ⚠ 対照群が崩れた回(仕込みが 0 件 / 打鍵が届かない)は**結果を読まない**。
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45744 &
 *   node tests/probe/run-note-window-probe.mjs --port=45744
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 45744);
/** 開く付箋の枚数(この数だけノートを仕込む)。 */
const MAX = Number(args.max ?? 5);
const BOOTED = '[data-pkc-slot="root"][data-pkc-boot="ready"]';
const ROWS = '[data-pkc-region="filer-table"] [data-pkc-entry]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 常駐(プロセス木の Pss)── `run-window-follower-probe.mjs` と同じ採り方 ──
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
    if (pss) return Number(pss[1]);
  } catch {
    /* smaps_rollup が無い環境 */
  }
  return null;
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
function treeMemory(rootPid) {
  const kids = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const ppid = readPpid(Number(name));
    if (ppid === null) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(name));
  }
  let pss = 0;
  let procs = 0;
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const m = memKb(pid);
    if (m !== null) {
      pss += m;
      procs += 1;
    }
    for (const k of kids.get(pid) ?? []) queue.push(k);
  }
  return { pssMb: +(pss / 1024).toFixed(1), procs };
}
/** 静止させてから採る(揺れの主因を測定対象から外す ── #114)。 */
async function restingMemory(rootPid) {
  if (!rootPid) return null;
  await sleep(2500);
  const xs = [];
  for (let i = 0; i < 3; i++) {
    xs.push(treeMemory(rootPid));
    await sleep(700);
  }
  return {
    pssMb: xs.map((x) => x.pssMb).sort((a, b) => a - b)[1],
    procs: Math.max(...xs.map((x) => x.procs)),
  };
}

const profile = `/tmp/pkc3-note-window-probe-${process.pid}`;
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
/**
 * long task を数える(打鍵の応答の観測点)。
 * 🔴 **計器の自己検査を持たせる**(2026-09-04 に踏んだ)── 1 稿目は
 *   「わざと 300ms 詰まらせても 0 件」で**計器が死んでいる**と読みかけた。
 *   実際は**観測を登録した同じタスクの中で詰まらせていた**だけで、計器は生きていた。
 *   ⚠ 「0 件」が「速い」なのか「見ていない」なのかは、**鳴ることを 1 度見る**まで
 *   区別できない(CLAUDE.md §4「対照群が届かない回は結果を読まない」)。
 */
await ctx.addInitScript(() => {
  const w = window;
  w.__probe = { longTasks: [], armed: false };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (w.__probe.armed) w.__probe.longTasks.push(+e.duration.toFixed(1));
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask を持たない環境ではこの次元は測れない(下で明記する) */
  }
  /** わざと 1 フレーム詰まらせて、計器が鳴ることを確かめる。 */
  w.__probeSelfCheck = async () => {
    w.__probe.longTasks = [];
    w.__probe.armed = true;
    await new Promise((r) => window.requestAnimationFrame(r));
    const t = Date.now();
    // ⚠ わざと詰まらせる(空の while は lint が嫌うので、捨てる仕事を置く)
    let spin = 0;
    while (Date.now() - t < 250) spin += 1;
    void spin;
    await new Promise((r) => setTimeout(r, 600));
    const n = w.__probe.longTasks.length;
    w.__probe.armed = false;
    w.__probe.longTasks = [];
    return n;
  };
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector(BOOTED, { timeout: 60000 });
// お知らせのカードは畳む(器を押し下げたままにしない)
await page.evaluate(() => {
  document
    .querySelectorAll('[data-pkc-action="dismiss-notices"], [data-pkc-action="announce-close"]')
    .forEach((b) => b.click());
});

// ── 仕込み: MAX 件のノート(付箋は 1 ノート 1 枚なので、枚数ぶん要る) ──
for (let i = 0; i < MAX; i++) {
  await page.click('[data-pkc-action="create-entry"]');
  await page.fill('[data-pkc-field="editor-title"]', `ふせん${i + 1}`);
  await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]', { timeout: 30000 });
}
const seeded = await page.locator(ROWS).count();
if (seeded < MAX) throw new Error(`仕込みが足りない(${seeded} / ${MAX})── 以降は判定不能`);

/**
 * 打鍵の応答を測る。
 * 🔑 **測るのは追記欄である** ── user の物語がそれだから
 *   (「画面の隅に表示した**メモ追記**を使ってどんどんスクラップ」)。
 * ⚠ 途中で 1.2 秒止める ── 止めないと下書きの描画が 1 度も走らない
 *   (等間隔の打鍵は、いちばん再現しない打ち方である)。
 */
async function typingCost(label) {
  const box = page.locator('[data-pkc-field="append-input"]');
  await box.waitFor({ timeout: 15000 });
  await box.click();
  await page.evaluate(() => {
    window.__probe.longTasks = [];
    window.__probe.armed = true;
  });
  /**
   * ⚠ **打っている間だけ数える** ── 1 稿目は間の待ち(2.4 秒)まで足していたので、
   *   実時間が**自分の sleep に支配されて分解能が 0**だった(3084 vs 3074ms)。
   */
  const t0 = Date.now();
  await page.keyboard.type('あいうえおかきくけこさしすせそ', { delay: 25 });
  const t1 = Date.now();
  await sleep(1200); // 🔑 止めた瞬間に描く相手なので、間を空ける
  const t2 = Date.now();
  await page.keyboard.type('たちつてとなにぬねの', { delay: 25 });
  const ms = Date.now() - t2 + (t1 - t0);
  await sleep(1200);
  const long = await page.evaluate(() => {
    window.__probe.armed = false;
    return window.__probe.longTasks.slice();
  });
  // ⚠ **打てたことを確かめる**(空振り防止)── 0 文字なら以降の数字は無意味
  const typed = await box.inputValue();
  if (typed.length < 20) throw new Error(`打鍵が届いていない(${typed.length} 文字)── 判定不能`);
  await box.fill('');
  return {
    測った所: label,
    '打っている間だけ(ms / 25 字)': ms,
    'long task 件数': long.length,
    'long task 合計(ms)': +long.reduce((a, b) => a + b, 0).toFixed(1),
    '最長(ms)': long.length ? Math.max(...long) : 0,
  };
}

const root = findBrowserPid(profile);
const rows = [];
const typing = [];

// 🔴 **計器が鳴ることを先に見る** ── 鳴らないなら以降の「0 件」は何も意味しない
const selfCheck = await page.evaluate(() => window.__probeSelfCheck());
if (selfCheck < 1) {
  throw new Error('long task の計器が鳴らない(わざと 250ms 詰まらせても 0 件)── 判定不能');
}
console.log(`計器の自己検査: わざと 250ms 詰まらせたら ${selfCheck} 件鳴った(生きている)`);

rows.push({ 付箋: 0, ...(await restingMemory(root)) });
typing.push(await typingCost('付箋 0 枚(対照群)'));

/** 付箋を 1 枚開く(実際のボタンを押す ── 配線ごと測る)。 */
async function openSticky(nth) {
  await page.locator(ROWS).nth(nth).click();
  const popup = ctx.waitForEvent('page');
  await page.click('[data-pkc-region="inspector"] [data-pkc-action="open-note-window"]');
  const w = await popup;
  await w.waitForSelector(BOOTED, { timeout: 60000 });
  return w;
}

const wins = [];
for (let i = 0; i < MAX; i++) {
  wins.push(await openSticky(i));
  await page.bringToFront();
  if (i === 0 || i === 2 || i === MAX - 1) {
    rows.push({ 付箋: i + 1, ...(await restingMemory(root)) });
  }
}
typing.push(await typingCost(`付箋 ${MAX} 枚`));

for (const w of wins) await w.close();
await sleep(1500);
rows.push({ 付箋: `${MAX} 枚を閉じた後`, ...(await restingMemory(root)) });

console.log(`\n■ 常駐(プロセス木の Pss。0 枚が対照群)`);
console.table(rows);
console.log(`■ 打鍵の応答`);
console.table(typing);
console.log(`page error: ${errors.length === 0 ? 'なし' : errors.join(' / ')}`);

await ctx.close();
rmSync(profile, { recursive: true, force: true });
