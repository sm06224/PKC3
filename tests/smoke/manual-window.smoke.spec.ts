import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { clickReal, collectPageErrors, gotoApp } from './helpers';

/**
 * 🔴 **マニュアルを「アプリ」として別の窓で読む**(#645。user 要望 2026-08-31)。
 *
 * > 「**ヘルプの中からマニュアルをアプリとして出してください。
 * > ちっとも改善していません。少しはこちらの要望を尊重してください**」
 *
 * ## 段②(2026-09-02):窓の中身は build 時に焼いた `manual.html`
 *
 * 段①は `about:blank` を opener が組んでいた。実 URL を持たないので **F5 で白紙**、
 * **設定の配色が届かない** ── いまは `window.open` で掴んだ窓を `manual.html` へ移す。
 *
 * ## ここでしか確かめられないこと
 *
 * unit は「組み上がった HTML」までしか見られない。実ブラウザでしか分からないのは:
 * - **本当に窓が開いて、`manual.html` へ移るか**(`window.open` の `popup` は happy-dom に無い)
 * - 🔴 **本文が窓いっぱいに出るか** ── これが user の苦情そのものである
 * - **目次を押したら、その見出しへ実際にスクロールするか**(断片は実 URL の中で解決する)
 * - 🔴 **F5 で消えないか / 設定の配色が届くか**(段②の当の点。preview が配る `dist/` でしか見えない)
 * - **元の画面が残っているか**(#300 の裁定「主の作業領域を奪わない」)
 */
const HEAD = '[data-pkc-field="manual-window-head"]';
const TOC = '[data-pkc-region="manual-window-toc"]';
const MAIN = '[data-pkc-region="manual-window-main"]';
const PAGE = /\/manual\.html$/u;

/** 開いた窓が `manual.html` に着くまで待つ(about:blank → replace の 2 段を跨ぐ)。 */
async function openManual(page: import('@playwright/test').Page, context: import('@playwright/test').BrowserContext) {
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  const win = await popup;
  await win.waitForURL((u) => PAGE.test(u.pathname));
  await expect(win.locator(MAIN)).toBeVisible();
  return win;
}

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

  // ② 「マニュアルを別のウィンドウで開く」を押す → 焼いた 1 枚へ移る
  const win = await openManual(page, context);

  // ③ 帯・目次・本文が出る
  // ⚠ 並びは他の窓と同じ「<名前> — PKC3」(#648 I4)。頭が PKC3 の旧い字なら落ちる
  await expect(win.locator(HEAD)).toContainText('マニュアル — PKC3');
  await expect(win.locator(`${TOC} a`).first()).toBeVisible();
  const links = await win.locator(`${TOC} a`).count();
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
 * ⚠ 段①の 1 稿目は `background: var(--bg, #fff)` と書いていたが、**`--bg` は
 * `BODY_CSS` に焼かれていない** ── 地は `#fff` 固定、字は `--fg` で環境に追従するので、
 * **暗い環境では白地に白い字**になり、窓の中が 1 文字も読めなかった。
 * 🔑 段②では保存が無ければ **OS の明暗で配色を決める**(`dark` が立つ)。
 *   観測点は**字面ではなく実際の色** ── 「`color-scheme` と書いてあるか」を見ると、
 *   書いてあるのに効かない形(器に地を置き直す等)を素通りする。
 */
test.describe('暗い環境', () => {
  /**
   * 🔴 **context ごと暗くする**(2026-09-02 実測)。⚠ `page.emulateMedia` は**その page だけ**に
   *   効き、`manual.html` へ移った別窓には届かない ── 段①(about:blank)では通っていたが、
   *   実 URL へ navigate した窓では `prefers-color-scheme` が light のまま(`light` が立った)。
   *   `test.use({ colorScheme })` は context の設定なので、開いた窓にも効く。
   */
  test.use({ colorScheme: 'dark' });

test('🔴 暗い環境でも、地と字の明暗が逆転しない (#645)', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const win = await openManual(page, context);

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
    return {
      fg: body.color,
      bg: body.backgroundColor,
      rootBg: root.backgroundColor,
      theme: document.documentElement.getAttribute('data-pkc-theme'),
    };
  });
  // 🔑 保存が無ければ OS に従う ── 暗い環境なら dark が立つ(段②の script)
  expect(seen.theme, '暗い環境なのに dark の配色が立っていない').toBe('dark');
  const fg = lum(seen.fg);
  const bg = Math.max(lum(seen.bg), lum(seen.rootBg));
  expect(fg, '字の色を読めない(観測点が壊れている)').toBeGreaterThanOrEqual(0);
  // 🔴 **暗い環境なら、字は地より明るい** ── 逆なら白地に白い字である
  expect(fg, `暗い環境で地(${bg})より字(${fg})が暗い ── 読めない`).toBeGreaterThan(bg);
  await win.close();
});
});

test('🔴 目次を押すと、その見出しまで送られる (#645)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const win = await openManual(page, context);
  await expect(win.locator(`${TOC} a`).first()).toBeVisible();

  /**
   * ⚠ **対照群を先に置く** ── 押す前は先頭に居ること。
   * これが 0 でなければ、以降の「動いた」は何も言えない。
   */
  const before = await win.locator(MAIN).evaluate((el) => el.scrollTop);
  expect(before, '押す前から送られている(前提が崩れている)').toBe(0);

  // ⚠ 深い所の行を押す(先頭付近だと「動いた」が誤差に埋もれる)
  const n = await win.locator(`${TOC} a`).count();
  const target = win.locator(`${TOC} a`).nth(Math.floor(n * 0.7));
  const id = (await target.getAttribute('href'))!.slice(1);
  await target.click();

  const after = await win.locator(MAIN).evaluate((el) => el.scrollTop);
  expect(after, '目次を押しても送られていない').toBeGreaterThan(0);

  /**
   * 🔴 **窓がアプリへ飛んでいない**(2026-08-31 の probe で実際に踏んだ形)。
   * ⚠ 段①の `about:blank` では `<a href="#m-100">` が base を引き継いで
   *   `http://…/#m-100` へ navigate し、**マニュアルが丸ごと消えた**。
   *   段②は実 URL なので、断片は **この page の中**で解決する ── URL は
   *   `manual.html#<見出しの字>` のまま(= 節ごとに控えられる)。
   * ⚠ 印は見出しの字(#648 D4)なので `url.hash` は percent-encode されて返る ── 復号して比べる。
   */
  const url = new URL(win.url());
  expect(url.pathname, '窓がアプリへ飛んだ').toMatch(PAGE);
  expect(decodeURIComponent(url.hash), '断片が URL に付いていない(控えられない)').toBe(`#${id}`);
  // 🔑 印が通し番号ではなく見出しの字(版をまたいで同じ節を指す ── D4 の当の点)
  expect(id, '印が通し番号のまま(見出しが増えた版で隣を指す)').not.toMatch(/^m-\d+$/u);

  /**
   * 🔴 **「動いた」だけでは足りない** ── その見出しが**画面に居る**ことまで見る
   * (行を押すたびに 1px 動くだけでも「動いた」は真になる)。
   */
  const seen = await win.evaluate((wanted) => {
    const el = document.getElementById(wanted);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { top: box.top, h: window.innerHeight };
  }, id);
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
 * ⚠ unit は「移し直していない」までしか見られない ── **同じ窓が返るか**は
 *   ブラウザ(窓の名前の解決)の仕事なので、ここでしか確かめられない。
 * ⚠ 段②では「読み直し(navigate)」が起きても先頭へ戻る ── URL が変わらないことも見る。
 */
test('🔴 もう一度押すと、同じ窓が読んでいた所のまま前に出る (#645)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const win = await openManual(page, context);

  // ⚠ **対照群** ── 送る前は 0(0 のままなら、以降の「保たれた」は何も言わない)
  expect(await win.locator(MAIN).evaluate((el) => el.scrollTop)).toBe(0);
  await win.locator(MAIN).evaluate((el) => {
    el.scrollTop = 900;
  });
  const before = await win.locator(MAIN).evaluate((el) => el.scrollTop);
  expect(before, '送れていない(前提が崩れている)').toBeGreaterThan(0);
  /**
   * 🔴 **対照群 ── 何も変えずにもう一度押しても、字の大きさは動かない**(2026-09-02 hotfix)。
   * ⚠ 直す前は 14px → 13px に縮んでいた ── 文字の大きさを選んでいない user に、
   *   アプリで「効いている既定 13px」を渡していた(当時、焼いた page は選んでいなければ
   *   読み物の 14px のまま)。
   * 🔑 I6(#648)で窓の既定を**アプリと同じ 13px** に揃えた ── 期待値は
   *   `features/text-scale.ts` の「標準」から読む(綴りを写さない)。
   */
  const std = readFileSync(new URL('../../src/features/text-scale.ts', import.meta.url), 'utf8');
  const stdPx = /id: 'standard'[^}]*size: '(\d+px)'/u.exec(std)![1]!;
  const fontBefore = await win.evaluate(() => getComputedStyle(document.body).fontSize);
  expect(fontBefore, '前提:何も選んでいないので、窓の字はアプリの既定と同じ').toBe(stdPx);

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
  expect(
    await win.evaluate(() => getComputedStyle(document.body).fontSize),
    '何も変えていないのに字の大きさが動いた(当て直しが冪等でない)',
  ).toBe(fontBefore);

  await win.close();
  expect(errors, `console/pageerror: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * 🔴 **F5 で白紙にならない**(#645 段②。段①の窓で実際に起きていた ── マニュアルにも
 * 「白紙になります」と書いていた)。
 * ⚠ ここは `dist/` を配る preview でしか見えない ── unit は `manual.html` が
 *   **配られているか**を原理的に見られない(§8「届いたか」)。
 */
test('🔴 窓で F5 を押しても、マニュアルはそのまま読み直せる (#645 段②)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const win = await openManual(page, context);
  const before = await win.locator(`${TOC} a`).count();
  expect(before, '前提が崩れている(目次が空)').toBeGreaterThan(100);
  // 目次を押しておく ── URL に節の印が付く(F5 のあと**その節へ戻る**ことまで見る)
  const target = win.locator(`${TOC} a`).nth(Math.floor(before * 0.6));
  const id = (await target.getAttribute('href'))!.slice(1);
  await target.click();
  expect(decodeURIComponent(new URL(win.url()).hash)).toBe(`#${id}`);

  await win.reload();
  await expect(win.locator(MAIN), 'F5 で白紙になった').toBeVisible();
  expect(await win.locator(`${TOC} a`).count()).toBe(before);
  const url = new URL(win.url());
  expect(url.pathname).toMatch(PAGE);
  expect(decodeURIComponent(url.hash), 'F5 で節の印が消えた').toBe(`#${id}`);
  /**
   * 🔴 **F5 のあと、その節に居る**(マニュアル §4-4 がそう書いている)。
   * ⚠ 本文はスクロール箱の中に居るので、ブラウザは位置を復元しない ── 戻れるのは
   *   URL の断片が効くからである。断片が効いていなければ先頭に戻る = ここで落ちる。
   */
  const seen = await win.evaluate((wanted) => {
    const el = document.getElementById(wanted);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { top: box.top, h: window.innerHeight };
  }, id);
  expect(seen, '飛び先が本文に無い').not.toBeNull();
  expect(seen!.top, 'F5 のあと、その節に戻っていない').toBeGreaterThanOrEqual(0);
  expect(seen!.top).toBeLessThan(seen!.h);

  /**
   * 🔴 **ブックマークから開いても、その節に着く**(マニュアル §4-4「その節から開けます」)。
   * ⚠ 再読み込みとは別の経路(新しい navigation)── 別の節の印で開き直して見る。
   */
  const other = (await win.locator(`${TOC} a`).nth(Math.floor(before * 0.3)).getAttribute('href'))!.slice(1);
  await win.goto(`${url.origin}${url.pathname}#${other}`);
  await expect(win.locator(MAIN)).toBeVisible();
  const landed = await win.evaluate((wanted) => {
    const el = document.getElementById(wanted);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { top: box.top, h: window.innerHeight };
  }, other);
  expect(landed, 'ブックマークの飛び先が本文に無い').not.toBeNull();
  expect(landed!.top, 'ブックマークから開いても、その節に着いていない').toBeGreaterThanOrEqual(0);
  expect(landed!.top).toBeLessThan(landed!.h);

  await win.close();
  expect(errors, `console/pageerror: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * 🔴 **設定で選んだ配色が、この窓にも届く**(#645 段②。段①の窓には 2 種しか無く、
 * マニュアルにも「この窓にはまだ届きません」と書いていた)。
 * 🔑 観測点は**実際に塗られた地の色** ── `tokens.css` の当の配色の `--bg` と一致すること。
 *   属性(`data-pkc-theme`)だけ見ると、属性は立つのに CSS が入っていない形を素通りする。
 */
test('🔴 設定で選んだ配色(Dracula)が、窓の地の色になる (#645 段②)', async ({ page, context }) => {
  // 🔑 期待値は tokens.css から読む(綴りを写さない)
  const tokens = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
  const block = tokens.slice(tokens.indexOf(":root[data-pkc-theme='dracula']"));
  const hex = /--bg:\s*#([0-9a-f]{6})/iu.exec(block)![1]!;
  const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;

  // user が設定で Dracula と「特大」を選んでいる状態(保存の鍵は theme.ts / text-scale.ts と同じ)
  await page.addInitScript(() => {
    localStorage.setItem('pkc3.theme', 'dracula');
    localStorage.setItem('pkc3.text-scale', 'xlarge');
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  // ⚠ 対照群 ── アプリ本体にその配色が効いている(効いていなければ「窓に届いた」は何も言わない)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-pkc-theme'))).toBe(
    'dracula',
  );
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const win = await openManual(page, context);

  const seen = await win.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-pkc-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    fontSize: getComputedStyle(document.body).fontSize,
  }));
  expect(seen.theme).toBe('dracula');
  expect(seen.bg, '選んだ配色の地の色になっていない').toBe(rgb);
  /**
   * 🔴 **字の大きさの設定も届く**(動線レビュー D3 ── 「特大」の user の窓だけ 14px だった)。
   * 🔑 期待値は `features/text-scale.ts` の表から読む(綴りを写さない)
   */
  const xl = readFileSync(new URL('../../src/features/text-scale.ts', import.meta.url), 'utf8');
  const px = /id: 'xlarge'[^}]*size: '(\d+px)'/u.exec(xl)![1]!;
  expect(seen.fontSize, '「特大」が窓に届いていない').toBe(px);
  await win.close();
});

/**
 * 🔴 **設定を変えたあと、もう一度押すと、読んでいた所のまま新しい見え方で前に出る**
 * (2026-09-02、動線レビュー I1。user 裁定「推奨で実装を許可」)。
 *
 * ⚠ 段②のままだと、開いている窓は設定に追従せず「窓で F5」が要った。
 * 🔑 観測点は 3 つ ── ①読み直していない(URL も送った位置もそのまま)
 *   ②地の色が新しい配色 ③字の大きさが新しい設定。**設定画面の実物の <select>** で変える。
 */
test('🔴 設定で配色と文字の大きさを変えて、もう一度押すと窓が追いつく (#645 I1)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const win = await openManual(page, context);
  const before = await win.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-pkc-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    fontSize: getComputedStyle(document.body).fontSize,
    url: location.href,
  }));
  // ⚠ 対照群 ── まだ Dracula でも特大でもない(そうなら以降の「変わった」は何も言わない)
  expect(before.theme).not.toBe('dracula');
  expect(before.fontSize).not.toBe('17px');
  await win.locator(MAIN).evaluate((el) => {
    el.scrollTop = 700;
  });
  const scrolled = await win.locator(MAIN).evaluate((el) => el.scrollTop);
  expect(scrolled, '送れていない(前提が崩れている)').toBeGreaterThan(0);

  // 設定画面で実際に変える(保存の鍵を直に触らない)
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="theme-select"]').selectOption('dracula');
  await page.locator('[data-pkc-field="text-scale-select"]').selectOption('xlarge');
  await expect(page.locator('html')).toHaveAttribute('data-pkc-theme', 'dracula');

  // もう一度押す ── ヘルプへ戻らなくても、アプリの一覧のタイルでもよいが、ここは同じボタン
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const pagesBefore = context.pages().length;
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  await page.waitForTimeout(500);
  expect(context.pages().length, '2 枚目が開いた').toBe(pagesBefore);

  const after = await win.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-pkc-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    fontSize: getComputedStyle(document.body).fontSize,
    url: location.href,
  }));
  expect(after.url, '読み直している').toBe(before.url);
  expect(await win.locator(MAIN).evaluate((el) => el.scrollTop), '読んでいた所が先頭へ戻った').toBe(
    scrolled,
  );
  expect(after.theme).toBe('dracula');
  expect(after.bg, '地の色が新しい配色になっていない').not.toBe(before.bg);
  expect(after.fontSize, '文字の大きさが新しい設定になっていない').toBe('17px');

  await win.close();
  expect(errors, `console/pageerror: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * 🔴 **Ctrl+P で本文が全部の頁に出る**(動線レビュー D6 ── 本文は `overflow:auto` の
 * スクロール箱に居るので、印刷の規則が無いと**見えている 1 頁ぶんしか出ない**。
 * アプリ本体が `app.css` で同じ形を踏んで直した)。
 * 🔑 観測点は **PDF の頁数** ── 「規則が焼かれているか」は unit が見るが、
 *   ブラウザが本当に箱をほどいて頁を割ったかは、紙(PDF)でしか分からない。
 */
test('🔴 窓で印刷すると、本文が全部の頁に出る (#645 段②)', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  const win = await openManual(page, context);
  const pdf = await win.pdf({ format: 'A4' });
  // ⚠ `/Type /Page`(`/Pages` を除く)の数 = 頁数。マニュアル 3600 行なら数十頁になる
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/gu) ?? []).length;
  expect(pages, `印刷が ${pages} 頁 ── スクロール箱がほどけていない`).toBeGreaterThan(10);
  await win.close();
});
