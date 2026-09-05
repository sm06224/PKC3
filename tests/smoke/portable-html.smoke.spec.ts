import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { clickReal, createEntry } from './helpers';

/**
 * 🔴 **可搬単一 HTML が `file://` で起動する**(#400 段①②)。
 *
 * > 正本 doc §9.2 は書き出し 3 形式のうち**これを「主」と呼んでいる**のに、
 * > 実装が無いまま設計 doc が 20 日間どこにも積まれていなかった(#400)。
 *
 * 🔴 **unit では原理的に届かない層**だけを見る:
 * ① **`file://` で本当に起動するか** ── `http://` で通ることは保証にならない
 *    (module worker が起動しない / OPFS が opaque origin で取れない)
 * ② **worker が classic の blob で本当に動くか** ── 畳み方が正しいかは、
 *    走らせるまで分からない
 * ③ **wasm が `data:` から読めるか** ── sqlite の loader は
 *    `self.location.href` から相対で解決するので、blob worker では解けない
 *
 * ④ 🔴 **再読込で残るか**(段③)── 器は `file://` の IndexedDB。
 *    ⚠ そして **`file://` は origin が全部 `file://` に潰れる**(実測)ので、
 *    ⑤ **別のバンドルが互いを上書きしないか**まで見ないと、正しさを主張できない。
 */
const HTML = resolve('dist-portable/pkc3.html');
/** 配信される `dist` の隣(アプリが `fetch` で取りに行く先)。 */
const TEMPLATE = resolve('dist/portable-template.html');

test.beforeAll(() => {
  /**
   * ⚠ **無ければ自分で焼く** ── 通常の `npm run build` は `dist-portable` を
   *   作らない(本番の配り物を単一化しないため)。ここで焼かないと、
   *   この spec は**環境によって走ったり走らなかったり**する
   *   (走らない回を「通った」と読む形を作らない)。
   */
  if (existsSync(HTML)) return;
  execFileSync('npx', ['vite', 'build', '--config', 'build/portable.config.ts'], {
    stdio: 'ignore',
  });
  execFileSync('node', ['build/portable/fold.mjs'], { stdio: 'ignore' });
});

/**
 * 🔴 **雛形を `dist` の隣に置く**(#400 段④)。
 *
 * 本番では CI がやる(`pages.yml` / `release.yml` の「検品の**後**」の step)──
 * ⚠ **検品の後**なのは、雛形をアプリの一部にしないためである
 *   (size cap の主張が変わる / **SW の precache に載る**)。
 * ここでもその形をそのまま真似る(smoke は `dist` を配信している)。
 */
test.beforeAll(() => {
  copyFileSync(HTML, TEMPLATE);
});

test('🔴 畳んだ 1 個の HTML が `file://` で起動する (#400 段①②)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);

  // ① 起動する
  await expect(
    page.locator('[data-pkc-boot="ready"]'),
    '`file://` で起動しない',
  ).toBeAttached({ timeout: 20_000 });
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);

  /**
   * ② 🔴 **選んだ形を「事故」として告げない**(段③ で向きが変わった)。
   *
   * ⚠ 段①② の時点ではここが `SecurityError` を**要求**していた ── OPFS を
   *   試して落ちていたからである。段③ で可搬バンドルは **OPFS を試さなくなった**
   *   ので、`fallbackReason` は載らない。
   * 🔑 主張の向きが変わったので、**空振り防止も置き直す**(CLAUDE.md §1
   *   「検査の向きを裏返したら、作法も裏返る」)── 状態の面が**実在する**ことを
   *   先に確かめてから、そこに警告が無いことを見る。
   */
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status, '状態の面が無い(検査そのものが空振りしている)').toBeAttached();
  await expect(status).not.toContainText('SecurityError');

  // ③ 🔴 **worker が動いている**(ノートを作れる = storage worker が生きている)
  await createEntry(page, 'text');
  await expect(
    page.locator('[data-pkc-field="editor-title"]'),
    'ノートを作れない(worker が動いていない)',
  ).toBeVisible({ timeout: 10_000 });
});

/**
 * 🔴 **段③ の本題 ── 再読込で残る。**
 *
 * ⚠ この test は段①② の時点では「**残らない**」を pin していた
 * (「段③ が入ったらここが落ちて、書き換えろと言ってくる」と書いてあった)──
 * その通りに落ちたので、向きを裏返した。
 */
test('🔴 `file://` で作ったノートが再読込で残る (#400 段③)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  /**
   * ⚠ **一覧の面を明示してから数える**(1 稿目で踏んだ)。
   * 🔑 素で `[data-pkc-entry]` を数えると**情報ペインのボタン**に満たされる
   *   ── #180 で nightly を 13 晩赤にしたのと同じ罠である(§1「別の面の文字」)。
   */
  await clickReal(page, '[data-pkc-browse="list"]');
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  /**
   * ⚠ **前提を assert する。** ここが 0 でないなら、前の走りの器が残っている
   *   (playwright は走りごとに profile を捨てるが、それは**前提であって観測では
   *   ない**)── 崩れたときに「残った」と読まないための門である。
   */
  await expect(rows, '最初から 1 件ある(前の走りの器が残っている)').toHaveCount(0);

  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill('可搬に残るノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows, '作ったのに一覧に出ない(前提が崩れた)').toHaveCount(1, { timeout: 10_000 });

  /**
   * 🔴 **保存は束ねて遅らせる**(打鍵ごとには書かない)。だから
   *   **閉じる合図を送ってから**再読込する ── これは製品が本当にやっている手順
   *   (`visibilitychange` の hidden で flush)であって、test 用の近道ではない。
   */
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1_500);

  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(rows, '🔴 再読込で消えた(段③ が効いていない)').toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-pkc-region="entry-list"]')).toContainText('可搬に残るノート');
});

/**
 * 🔴 **別のバンドルは互いを上書きしない**(#400 段③ の正しさの要件)。
 *
 * > ⚠ **`file://` では origin が全部 `file://` に潰れる**(2026-08-25 実測)──
 * > 別ディレクトリの別 HTML 同士で IndexedDB が**共有される**。
 *
 * だから器の名前を id で切っていなければ、**2 つ書き出して両方使うと片方が
 * 黙って消える**。⚠ これは unit では原理的に見えない(`file://` が要る)。
 */
test('🔴 別の id のバンドルは、互いのノートを見ない (#400 段③)', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-portable-'));
  const other = join(dir, 'other.html');
  const src = readFileSync(HTML, 'utf-8');
  const from = '{"id":"pkcb-template","exportedAt":0}';
  expect(src, '雛形に印が無い(検査そのものが空振りしている)').toContain(from);
  writeFileSync(other, src.replace(from, '{"id":"pkcb-othertest01","exportedAt":0}'));

  // ① 雛形のほうに 1 件書く
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(0);
  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill('雛形のノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows).toHaveCount(1, { timeout: 10_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1_500);

  // ② 別の id のバンドルを開く ── 🔴 **見えてはいけない**
  await page.goto(pathToFileURL(other).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(
    rows,
    '🔴 別のバンドルのノートが見えている(器の名前空間が切れていない)',
  ).toHaveCount(0, { timeout: 10_000 });

  // ③ 🔑 **対照群** ── 雛形へ戻ると、ちゃんと残っている
  //    (②が 0 件なのは「どちらも保存できていない」からではない)
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(rows, '雛形の側まで消えている(保存そのものが効いていない)').toHaveCount(1, {
    timeout: 15_000,
  });
});


/**
 * 🔴 **段④ の本題 ── 書き出した 1 枚が、そのまま PKC3 として開く。**
 *
 * ⚠ これは unit では原理的に届かない:
 * ① `fetch` で雛形を取る(同じ origin)② `<a download>` で受け取る
 * ③ **`file://` で開いて、中身が入っていること**
 *
 * 🔑 対照群を先に置く ── 「書き出した 1 枚に元の本文が在る」だけでは、
 *   **雛形をそのまま配っても通る**(雛形にも同じアプリが入っている)。
 *   だから **user が打った題名**が出ることを見る。
 */
test('🔴 書き出した 1 枚が、そのまま PKC3 として開く (#400 段④)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });

  // ⚠ 既定で開いている面は一覧とは限らない(既定はフォルダ)── 先に開く
  await clickReal(page, '[data-pkc-browse="list"]');
  const title = `持ち出す本文 ${process.pid}`;
  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-region="entry-list"]')).toContainText(title, {
    timeout: 10_000,
  });

  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)に在る ── 先に開く
  const dl = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-action="export-portable"]');
  const out = join(mkdtempSync(join(tmpdir(), 'pkc3-out-')), 'carried.html');
  await (await dl).saveAs(out);

  // ① 1 枚で成立している(外部参照が 0 件 = 雛形の門がそのまま効いている)
  const bytes = readFileSync(out, 'utf-8');
  expect(bytes.length, '書き出した 1 枚が小さすぎる').toBeGreaterThan(3_000_000);
  // 🔴 印が雛形のままではない(= 器を新しく切っている)
  expect(bytes, '雛形の器のまま書き出している').not.toContain('"id":"pkcb-template"');

  // ② 🔴 `file://` で開いて、**打った題名**が出る
  const carried = await page.context().newPage();
  await carried.goto(pathToFileURL(out).href);
  await expect(carried.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(carried, '[data-pkc-browse="list"]');
  await expect(
    carried.locator('[data-pkc-region="entry-list"]'),
    '🔴 書き出した 1 枚に中身が入っていない',
  ).toContainText(title, { timeout: 15_000 });

  // ③ 🔑 **続きが書ける**(読むだけの HTML との違いはここである)
  await createEntry(carried, 'text');
  await expect(carried.locator('[data-pkc-field="editor-title"]')).toBeVisible({
    timeout: 10_000,
  });
  await carried.locator('[data-pkc-field="editor-title"]').fill('持ち出した先で足した');
  await clickReal(carried, '[data-pkc-action="commit-edit"]');
  await expect(carried.locator('[data-pkc-region="entry-list"]')).toContainText(
    '持ち出した先で足した',
    { timeout: 10_000 },
  );
  await carried.close();
});

/**
 * 🔴 **持ち歩ける 1 枚でも、マニュアルの窓は 1 枚に焼き込んだ page を `blob:` で開く**
 * (#648 段③。段②までは隣に `manual.html` が無いので `about:blank` に組んでいた ──
 * **F5 で白紙** / 配色は明暗の 2 種だけ、が 1 枚ではそのままだった)。
 *
 * ここでしか確かめられないのは 4 つ ── ① `file://` の opener が作った `blob:` へ
 * 本当に navigate できるか(top-level の `data:` はブラウザが止める) ② `file://` 由来の
 * blob で **F5 が効くか**(blob URL が生きている間は読み直せる) ③ 暗い環境で読めるか
 * ④ opener が焼いた配色が届くか(`file://` 由来の blob は `localStorage` に触れないことが
 * ある ── 属性で焼く道が効いていること)。
 */
test.describe('暗い環境', () => {
  test.use({ colorScheme: 'dark' });

  test('🔴 持ち歩ける 1 枚でも、マニュアルの窓が blob: の page で開き、F5 で消えない (#648 段③)', async ({
    page,
    context,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(pathToFileURL(HTML).href);
    await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
    await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');

    const popup = context.waitForEvent('page');
    await clickReal(page, '[data-pkc-action="open-manual-window"]');
    const win = await popup;
    // ① 焼き込んだ page へ移る(about:blank のままなら段①の逃げ道へ落ちている)
    await win.waitForURL((u) => u.protocol === 'blob:');
    const toc = win.locator('[data-pkc-region="manual-window-toc"] a');
    await expect(toc.first(), '目次が出ない(page に移れていない)').toBeVisible();
    const links = await toc.count();
    expect(links, '目次が空').toBeGreaterThan(100);
    // ⚠ 段①の印(`<button>` の目次)ではない
    expect(await win.locator('[data-pkc-region="manual-window-toc"] button').count()).toBe(0);

    // ③ 暗い環境で読める(tokens の配色が効いている)
    const lum = (css: string): number => {
      const m = css.match(/\d+/gu);
      if (!m || m.length < 3) return -1;
      return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
    };
    const seen = await win.evaluate(() => ({
      fg: getComputedStyle(document.body).color,
      bg: getComputedStyle(document.body).backgroundColor,
      rootBg: getComputedStyle(document.documentElement).backgroundColor,
      theme: document.documentElement.getAttribute('data-pkc-theme'),
    }));
    expect(seen.theme, '配色の属性が立っていない').toBe('dark');
    const fg = lum(seen.fg);
    const bg = Math.max(lum(seen.bg), lum(seen.rootBg));
    expect(fg).toBeGreaterThanOrEqual(0);
    expect(fg, `暗い環境で地(${bg})より字(${fg})が暗い ── 読めない`).toBeGreaterThan(bg);

    // ② 🔴 目次を押して、F5 ── 白紙にならず、その節に居る(段①では白紙になっていた)
    const target = toc.nth(Math.floor(links * 0.6));
    const id = (await target.getAttribute('href'))!.slice(1);
    await target.click();
    /**
     * 🔴 **押した直後に、その節へ飛んでいる**(2026-09-05 実測で足した)。
     * ⚠ `blob:null/`(`file://` 由来の blob)では Chromium が `<a href="#…">` の navigate を
     *   `Not allowed to load local resource` で止める ── 断片も付かず、見出しへも送られず、
     *   **目次が丸ごと dead click** だった。それを boot script が `pushState` で肩代わりする
     *   (`manual-page.ts`)。F5 の後だけ見ると「印が消えた」に見えるが、本体はここである。
     */
    expect(decodeURIComponent(new URL(win.url()).hash), '目次を押しても節の印が付かない').toBe(
      `#${id}`,
    );
    const jumped = await win.evaluate((wanted) => {
      const el = document.getElementById(wanted);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { top: box.top, h: window.innerHeight };
    }, id);
    expect(jumped, '飛び先が本文に無い').not.toBeNull();
    expect(jumped!.top, '目次を押しても、その節へ飛ばない(dead click)').toBeGreaterThanOrEqual(0);
    expect(jumped!.top).toBeLessThan(jumped!.h);
    await win.reload();
    await expect(win.locator('[data-pkc-region="manual-window-main"]'), 'F5 で白紙になった').toBeVisible();
    expect(await toc.count()).toBe(links);
    expect(decodeURIComponent(new URL(win.url()).hash), 'F5 で節の印が消えた').toBe(`#${id}`);
    const landed = await win.evaluate((wanted) => {
      const el = document.getElementById(wanted);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { top: box.top, h: window.innerHeight };
    }, id);
    expect(landed, '飛び先が本文に無い').not.toBeNull();
    expect(landed!.top, 'F5 のあと、その節に戻っていない').toBeGreaterThanOrEqual(0);
    expect(landed!.top).toBeLessThan(landed!.h);

    // ⑤ もう一度押しても 2 枚目が開かない(同じ窓が前に出る)
    const pagesBefore = context.pages().length;
    await page.bringToFront();
    await clickReal(page, '[data-pkc-action="open-manual-window"]');
    await page.waitForTimeout(700);
    expect(context.pages().length, '2 枚目が開いた').toBe(pagesBefore);

    await win.close();
    expect(errors, `pageerror: ${errors.join(' | ')}`).toEqual([]);
  });
});

/**
 * 🔴 **④ opener が焼いた配色が届く**(#648 段③)。`file://` 由来の `blob:` は
 * `localStorage` に触れないことがある ── そのとき boot script は `<html>` に焼かれた
 * 属性を採る(`portable-manual.ts` の `bakeAppearance`)。観測点は**実際に塗られた地の色**。
 */
test('🔴 持ち歩ける 1 枚で選んだ配色(Dracula)が、blob: の窓の地の色になる (#648 段③)', async ({
  page,
  context,
}) => {
  const tokens = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
  const block = tokens.slice(tokens.indexOf(":root[data-pkc-theme='dracula']"));
  const hex = /--bg:\s*#([0-9a-f]{6})/iu.exec(block)![1]!;
  const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  // 設定画面の実物の <select> で選ぶ(保存の鍵を直に触らない)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="theme-select"]').selectOption('dracula');
  await expect(page.locator('html')).toHaveAttribute('data-pkc-theme', 'dracula');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  const win = await popup;
  await win.waitForURL((u) => u.protocol === 'blob:');
  await expect(win.locator('[data-pkc-region="manual-window-main"]')).toBeVisible();
  const seen = await win.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-pkc-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  expect(seen.theme).toBe('dracula');
  expect(seen.bg, '選んだ配色の地の色になっていない').toBe(rgb);
  await win.close();
});
