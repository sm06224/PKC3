#!/usr/bin/env node
/**
 * 🔴 **畳んだときに「戻る口」が何個残るか**(#609 / #582 の R4)。
 *
 * ## なぜ要るか
 *
 * `docs/development/operation-model-2026-08.md` §4 の規則 3
 * (「畳めるペインが唯一の入口になってはならない」)は、**数で言えないと守れない**。
 * ⚠ 初稿は「押せるボタンが 22 → 0 個」と書いていたが、それは
 * **左ペインの中だけの数**で、画面全体は 0 になっていない
 * (CLAUDE.md §4「計器の名前を、計器の見ている範囲より広く書かない」)。
 *
 * ## ⚠ 踏んだ罠(2 つとも「計器の話を製品の話と読む」型)
 *
 * 1. 🔴 **ノートを 1 件も作らずに測ると、追記欄の帯が出ない。**
 *    `app.css` の `:has([data-pkc-region='append'][hidden])` が帯を消すので、
 *    「掴む帯 0」は**製品の主張にならない**。だからこの probe は**先にノートを作る**。
 * 2. 🔴 **面へスコープする。** `document` 全体で `button` を数えると、
 *    お知らせのカードや編集の帯に満たされて「まだ押せる物が在る」に見える
 *    ── 見たいのは「**その面を戻す口**」であって、押せる物の総数ではない。
 *
 * ## 対照群
 *
 * **畳む前**を必ず先に測る。そこが 0 なら、畳んだ後の 0 は計器の話である。
 *
 *   npm run build && npx vite preview --port 45732 &
 *   PKC3_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node scripts/pane-escape-probe.mjs
 */
import { chromium } from '@playwright/test';

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:45732';
const exe = process.env.PKC3_CHROMIUM;

/** ⚠ 面積を持ち、`display`/`visibility` で消えていないものだけ数える。 */
const listVisible = `(sel) => {
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
      const host = el.closest('[data-pkc-region]');
      out.push({
        action: el.getAttribute('data-pkc-action') ?? el.getAttribute('data-pkc-region') ?? '(なし)',
        pane: el.getAttribute('data-pkc-pane') ?? '',
        region: host === null ? '' : host.getAttribute('data-pkc-region'),
      });
    }
  }
  return out;
}`;

const SELS = {
  戻す口_sidebar: '[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]',
  戻す口_inspector: '[data-pkc-action="toggle-pane"][data-pkc-pane="inspector"]',
  戻す口_append: '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]',
  パレットを開く: '[data-pkc-action="open-palette"]',
  掴む帯: '[data-pkc-region="pane-grip"]',
  'shell の押せるもの': '[data-pkc-region="shell"] button:not([disabled])',
};

const VIEWPORTS = [
  [480, 844],
  [720, 900],
  [1280, 900],
];

const browser = await chromium.launch(exe === undefined ? {} : { executablePath: exe });
const rows = [];
for (const [width, height] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pkc-region="shell"]', { timeout: 20000 });
  await page.waitForTimeout(500);
  // ⚠ 罠 1 ── ノートが 0 件だと追記欄も情報ペインも出ない
  await page.click('[data-pkc-field="create-pick"]');
  await page.click('[data-pkc-region="create-menu"] [data-pkc-archetype="text"]');
  await page.click('[data-pkc-field="create-run"]');
  await page.waitForTimeout(800);

  const snap = async (state) => {
    const row = { 窓: `${width}x${height}`, 状態: state };
    for (const [name, sel] of Object.entries(SELS)) {
      row[name] = (await page.evaluate(`(${listVisible})(${JSON.stringify(sel)})`)).length;
    }
    row['hidden-panes'] = await page.getAttribute('[data-pkc-region="shell"]', 'data-pkc-hidden-panes');
    rows.push(row);
  };

  await snap('畳まず(対照群)');
  await page.keyboard.press('Alt+BracketLeft');
  await page.waitForTimeout(400);
  await snap('一覧を畳んだ');
  await page.keyboard.press('Alt+BracketRight');
  await page.waitForTimeout(400);
  await snap('両方畳んだ');
  await ctx.close();
}
await browser.close();

// 🔴 対照群が崩れた回は、結果を読まない(CLAUDE.md §4)
const control = rows.filter((r) => r.状態.startsWith('畳まず'));
// ⚠ 空振り防止 ── 対照群が 0 行なら、下の検査は**何も見ずに通る**
if (control.length !== VIEWPORTS.length) {
  console.error(`⚠ 対照群が ${control.length} 行しか無い(窓は ${VIEWPORTS.length} 通り)`);
  process.exit(2);
}
const brokenGauge = control.filter((r) => r['パレットを開く'] === 0);
if (brokenGauge.length > 0) {
  console.error('⚠ 判定不能: 畳む前にパレットが 0 件の窓がある(計器か描画の待ちが足りない)');
  console.error(JSON.stringify(brokenGauge, null, 1));
  process.exit(2);
}
console.log(JSON.stringify(rows, null, 1));
