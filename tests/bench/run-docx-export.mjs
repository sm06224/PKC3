/**
 * PKC3 計器: **Word(.docx)の書き出しはメインを何 ms 止めるか**(#187 段④)。
 *
 * 🔴 なぜ要るか ── 設計 doc §5 の「速度とメモリを測る(PKC2 は 0 件)」。
 * 段①〜⑤ は**正しさ**だけを見てきた。ワーカーへ逃がすかどうかは
 * 「重い処理はワーカーへ」(不可侵指示 2026-08-03)の**適用範囲の判断**なので、
 * **測ってから決める**(CLAUDE.md「性能の主張は測ってから言う」)。
 *
 * ## 対照群
 *
 * 設計 doc が指定した対照群は「**同じ文書を HTML で書き出す**」である ──
 * 読みと描画は同じ道を通り、**組み立てと zip だけが違う**。差し引きで出るのは
 * 「docx の組み立てぶん」であって、書き出し全体ではない。
 * ⚠ 差し引きで出た値は**向きだけ**信頼する(倍率を書かない ── 計測規律)。
 *
 * ## 観測点
 *
 * - `longTaskMs` … 50ms 以上の詰まりの合計(`longtask` は 50ms 未満を落とす)
 * - `maxGapMs` … **心拍(4ms)の最大の空き** ── 細かい詰まりはこちらでしか見えない
 * - `wallMs` … 押してから file が落ちてくるまで(user が待つ時間)
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45741 --strictPort &
 *   node tests/bench/run-docx-export.mjs --blocks=2000
 */
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 45741);
/** 塊の数(見出し + 段落 + 箇条書き + 表 + コードを混ぜて 1 単位)。 */
const BLOCKS = Number(args.blocks ?? 2000);
const ROUNDS = Number(args.rounds ?? 3);

/** 大きい文書を作る。⚠ **1 種類の塊だけにしない** ── 表とコードは道が違う。 */
function bigBody(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`## 節 ${i + 1}`);
    out.push('');
    out.push(`これは ${i + 1} 番目の段落です。**強め**の字と \`等幅\` と [外部](https://example.com/${i}) を含みます。`);
    out.push('');
    out.push('- 一つ目', '- 二つ目', '  - 入れ子', '');
    if (i % 5 === 0) {
      out.push('| 名前 | 数 |', '|---|---|', `| あ | ${i} |`, `| い | ${i * 2} |`, '');
    }
    if (i % 7 === 0) {
      out.push('```js', `const x${i} = ${i};`, '```', '');
    }
  }
  return out.join('\n');
}

const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  ...(existsSync(bundled) ? { executablePath: bundled } : {}),
});
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.addInitScript(() => {
  try {
    globalThis.localStorage.setItem('pkc3.editor-mode', 'split');
  } catch {
    /* ignore */
  }
});
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('[data-pkc-boot="ready"]', { timeout: 60000 });

await page.evaluate(() => {
  const w = window;
  w.__m = { long: 0, longMs: 0, gapMs: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__m.long += 1;
        w.__m.longMs += e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask を持たない環境ではこの次元は測れない(下で明記する) */
  }
  // 🔴 **心拍**(4ms)── `longtask` は 50ms 未満を落とすので、細かい詰まりが見えない
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - last > w.__m.gapMs) w.__m.gapMs = now - last;
    last = now;
  }, 4);
});

const markStart = () =>
  page.evaluate(() => {
    const w = window;
    w.__m.gapMs = 0;
    return { long: w.__m.long, longMs: w.__m.longMs };
  });
/** ⚠ **1 手番譲ってから読む** ── observer の callback は非同期に届く。 */
const markEnd = (base) =>
  page.evaluate(async (b) => {
    const w = window;
    await new Promise((r) => setTimeout(r, 50));
    return {
      longTasks: w.__m.long - b.long,
      longTaskMs: Math.round(w.__m.longMs - b.longMs),
      maxGapMs: Math.round(w.__m.gapMs),
    };
  }, base);

// ── 大きいノートを 1 件作る ────────────────────────────────
const body = bigBody(BLOCKS);
await page.click('[data-pkc-field="create-pick"]');
await page.click('[data-pkc-region="create-menu"] [data-pkc-archetype="text"]');
await page.click('[data-pkc-field="create-run"]');
await page.waitForSelector('[data-pkc-field="editor-body"]');
await page.fill('[data-pkc-field="editor-title"]', '大きい文書');
/**
 * ⚠ `page.fill` は**大きい本文で返ってこない**(1 打鍵ごとにプレビューが追いつく
 * 面なので、actionability の待ちが終わらない)。値を入れて `input` を 1 回だけ
 * 撃つ ── アプリから見ると「まとめて貼り付けた」と同じである。
 */
await page.evaluate((text) => {
  const ta = document.querySelector('[data-pkc-field="editor-body"]');
  ta.value = text;
  ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
}, body);
await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
await page.waitForSelector('[data-pkc-action="start-edit"]');

/** 1 回押して、詰まりと時間を採る。 */
async function measure(selector) {
  const base = await markStart();
  const t0 = Date.now();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.click(selector),
  ]);
  const path = await download.path();
  const wallMs = Date.now() - t0;
  const m = await markEnd(base);
  return { ...m, wallMs, ok: path !== null };
}

const rows = [];
for (let r = 0; r < ROUNDS; r += 1) {
  // ⚠ **順番を混ぜない**(同じ順で回す)── 先に回したほうが不利になる系の
  //   偏りは、両群を同じ回数・同じ順で回して打ち消す
  rows.push({
    round: r,
    docx: await measure('[data-pkc-region="inspector"] [data-pkc-action="export-entry-docx"]'),
    html: await measure('[data-pkc-action="export-html"]'),
  });
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sum = (key, kind) => med(rows.map((r) => r[kind][key]));
console.log(JSON.stringify({ blocks: BLOCKS, bodyChars: body.length, rounds: ROUNDS }, null, 0));
for (const r of rows) console.log(JSON.stringify(r));
console.log(
  JSON.stringify({
    median: {
      docx: { wallMs: sum('wallMs', 'docx'), longTaskMs: sum('longTaskMs', 'docx'), maxGapMs: sum('maxGapMs', 'docx') },
      html: { wallMs: sum('wallMs', 'html'), longTaskMs: sum('longTaskMs', 'html'), maxGapMs: sum('maxGapMs', 'html') },
    },
    errors,
  }),
);
await browser.close();
