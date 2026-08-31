import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, gotoApp } from './helpers';

/**
 * 🔴 **マニュアルを「アプリ」として別の窓で読む**(#645。user 要望 2026-08-31)。
 *
 * > 「**ヘルプの中からマニュアルをアプリとして出してください。
 * > ちっとも改善していません。少しはこちらの要望を尊重してください**」
 *
 * ## ここでしか確かめられないこと
 *
 * unit は「組み上がった DOM」までしか見られない。実ブラウザでしか分からないのは:
 * - **本当に窓が開くか**(`window.open` の `popup` 指定は happy-dom に無い)
 * - 🔴 **本文が窓いっぱいに出るか** ── これが user の苦情そのものである。
 *   ヘルプ面の中では `max-height: 60vh` の箱に入っていた
 * - **目次を押したら、その見出しへ実際にスクロールするか**
 *   (`href="#m-3"` は script 無しで飛ぶが、飛んだかは実ブラウザでしか測れない)
 * - **元の画面が残っているか**(#300 の裁定「主の作業領域を奪わない」)
 */
const HEAD = '[data-pkc-field="manual-window-head"]';
const TOC = '[data-pkc-region="manual-window-toc"]';
const MAIN = '[data-pkc-region="manual-window-main"]';

test('🔴 ヘルプからマニュアルの窓が開き、窓いっぱいに出る (#645)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① ヘルプを開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  await expect(page.locator('[data-pkc-region="help-manual"]')).toBeVisible();

  /**
   * 🔴 **対照群 ── ヘルプ面の中では箱に入っている**。
   * ⚠ これを先に測る:入っていないなら、以降の「窓では大きい」は何も証明しない。
   */
  const boxed = await page.locator('[data-pkc-region="help-manual"]').boundingBox();
  expect(boxed, 'マニュアルの箱が見えない(前提が崩れている)').not.toBeNull();
  expect(boxed!.height, '前提が崩れている(ヘルプ面の中で既に窓いっぱい)').toBeLessThan(900 * 0.7);

  // ② 「マニュアルを別のウィンドウで開く」を押す
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  const win = await popup;
  await win.waitForLoadState('domcontentloaded');

  // ③ 帯・目次・本文が出る
  await expect(win.locator(HEAD)).toContainText('PKC3 マニュアル');
  await expect(win.locator(`${TOC} button`).first()).toBeVisible();
  const links = await win.locator(`${TOC} button`).count();
  expect(links, '目次が空').toBeGreaterThan(100);

  /**
   * ④ 🔴 **本文は窓いっぱい** ── ここが user の苦情の当の点である。
   * ⚠ 「大きい」ではなく**器に対する比**で見る(窓の寸法は環境で動く)。
   */
  const inner = await win.evaluate(() => window.innerHeight);
  const main = await win.locator(MAIN).boundingBox();
  expect(main, '本文の面が見えない').not.toBeNull();
  expect(main!.height / inner, '本文が窓いっぱいに出ていない').toBeGreaterThan(0.8);

  // ⑤ 🔴 **元の画面は残っている**(#300「主の作業領域を奪わない」)
  await expect(page.locator('[data-pkc-region="help-manual"]')).toBeVisible();

  await win.close();
  expect(errors, `console/pageerror: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * 🔴 **暗い環境で読める**(2026-08-31、着地前の実地調査が拾った defect の回帰)。
 *
 * ⚠ 1 稿目は `background: var(--bg, #fff)` と書いていたが、**`--bg` は
 * `BODY_CSS` に焼かれていない**(実測: 変数 30 個のうち `--fg` は在り `--bg` は無い)
 * ── 地は `#fff` 固定、字は `--fg` で環境に追従するので、**暗い環境では
 * 白地に白い字**になり、窓の中が 1 文字も読めなかった。
 * 🔑 観測点は**字面ではなく実際の色** ── 「`color-scheme` と書いてあるか」を見ると、
 *   書いてあるのに効かない形(器に地を置き直す等)を素通りする。
 */
test('🔴 暗い環境でも、地と字の明暗が逆転しない (#645)', async ({ page, context }) => {
  // ⚠ 別窓は**この page から開く**ので、`page` 側に当てれば開いた窓にも効く
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  const win = await popup;
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator(MAIN)).toBeVisible();

  /** `rgb(...)` を明るさ(0〜255)へ。⚠ 単純平均でよい ── 見たいのは**向き**である。 */
  const lum = (css: string): number => {
    const m = css.match(/\d+/gu);
    if (!m || m.length < 3) return -1;
    return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
  };
  const seen = await win.evaluate(() => {
    const body = getComputedStyle(document.body);
    // ⚠ 器が透明なら、実際に塗っているのは `html` である ── 両方見る
    const root = getComputedStyle(document.documentElement);
    return { fg: body.color, bg: body.backgroundColor, rootBg: root.backgroundColor };
  });
  const fg = lum(seen.fg);
  const bg = Math.max(lum(seen.bg), lum(seen.rootBg));
  expect(fg, '字の色を読めない(観測点が壊れている)').toBeGreaterThanOrEqual(0);
  // 🔴 **暗い環境なら、字は地より明るい** ── 逆なら白地に白い字である
  expect(fg, `暗い環境で地(${bg})より字(${fg})が暗い ── 読めない`).toBeGreaterThan(bg);
  await win.close();
});

test('🔴 目次を押すと、その見出しまで送られる (#645)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  const win = await popup;
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator(`${TOC} button`).first()).toBeVisible();

  /**
   * ⚠ **対照群を先に置く** ── 押す前は先頭に居ること。
   * これが 0 でなければ、以降の「動いた」は何も言えない。
   */
  const before = await win.locator(MAIN).evaluate((el) => el.scrollTop);
  expect(before, '押す前から送られている(前提が崩れている)').toBe(0);

  // ⚠ 深い所の行を押す(先頭付近だと「動いた」が誤差に埋もれる)
  const n = await win.locator(`${TOC} button`).count();
  const target = win.locator(`${TOC} button`).nth(Math.floor(n * 0.7));
  const id = await target.getAttribute('data-pkc-target');
  await target.click();

  const after = await win.locator(MAIN).evaluate((el) => el.scrollTop);
  expect(after, '目次を押しても送られていない').toBeGreaterThan(0);

  /**
   * 🔴 **窓がアプリへ飛んでいない**(2026-08-31 の probe で実際に踏んだ)。
   * ⚠ `<a href="#m-100">` だと `about:blank` が base を引き継いで
   *   `http://…/#m-100` へ navigate し、**マニュアルが丸ごと消えた**。
   */
  expect(win.url(), '窓がアプリへ飛んだ').toBe('about:blank');

  /**
   * 🔴 **「動いた」だけでは足りない** ── その見出しが**画面に居る**ことまで見る
   * (行を押すたびに 1px 動くだけでも「動いた」は真になる)。
   */
  const seen = await win.evaluate((wanted) => {
    const el = document.getElementById(wanted);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { top: box.top, h: window.innerHeight };
  }, id!);
  expect(seen, '目次の飛び先が本文に無い').not.toBeNull();
  expect(seen!.top).toBeGreaterThanOrEqual(0);
  expect(seen!.top, '飛んだ見出しが画面の外に居る').toBeLessThan(seen!.h);

  await win.close();
  expect(errors, `console/pageerror: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * 🔴 **2 回目に押しても、読んでいた所を失わない**(#645。着地前の設計レビューが
 * 拾った ── 直す前は毎回組み直していたので、押すたび先頭へ戻っていた)。
 *
 * ⚠ unit は「組み直していない」までしか見られない ── **同じ窓が返るか**は
 *   ブラウザ(窓の名前の解決)の仕事なので、ここでしか確かめられない。
 */
test('🔴 もう一度押すと、同じ窓が読んでいた所のまま前に出る (#645)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  const win = await popup;
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator(MAIN)).toBeVisible();

  // ⚠ **対照群** ── 送る前は 0(0 のままなら、以降の「保たれた」は何も言わない)
  expect(await win.locator(MAIN).evaluate((el) => el.scrollTop)).toBe(0);
  await win.locator(MAIN).evaluate((el) => {
    el.scrollTop = 900;
  });
  const before = await win.locator(MAIN).evaluate((el) => el.scrollTop);
  expect(before, '送れていない(前提が崩れている)').toBeGreaterThan(0);

  /**
   * 🔴 **2 枚目が開いたら赤**。⚠ `waitForEvent('page')` を張ると「開くのを待つ」
   *   ことになるので、**張らずに枚数の増分**で見る。
   */
  const pagesBefore = context.pages().length;
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  await page.waitForTimeout(700);
  expect(context.pages().length, '2 枚目が開いた').toBe(pagesBefore);
  expect(
    await win.locator(MAIN).evaluate((el) => el.scrollTop),
    '読んでいた所が先頭へ戻った',
  ).toBe(before);

  await win.close();
  expect(errors, `console/pageerror: ${errors.join(' | ')}`).toEqual([]);
});
