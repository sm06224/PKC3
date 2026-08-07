/**
 * 印刷(2026-08-07)。
 *
 * 🔴 **直す前は画面から印刷すると 1 頁しか出なかった**(実測)。本文の器が
 * `overflow: auto` の唯一のスクロール箱で、650px の窓に 6271px の中身が入っていた
 * ── 紙に出るのは窓の分だけで、**残り約 90% が黙って落ちていた**。
 * `+++`(改頁)もどの面でも改頁を起こしていなかった。
 *
 * ⚠ **独立した spec にする** ── ここは `emulateMedia` と viewport を触るので、
 *   ほかの spec の assert を汚す。
 *
 * ## 観測点の作り方(3 つの罠を避ける)
 *
 * 🔴 **罠①: `break-after` だけを見ると緑のまま壊れる。** `display: none` を併せると
 *    **改頁は消える**のに、計算後の `break-after` は `'page'` のまま残る(実測)。
 *    だから **`getClientRects().length > 0`(箱が在る)と対にする**。
 * ⚠ **罠②: 印刷時の版面幅は紙の幅**(A4 縦 = 794px)。だから既存の
 *    `max-width: 1100px` / `900px` の上書きが**発火する** ── 紙の見え方を測るには
 *    この幅にしなければならない。⚠ ただし 2026-08-07 時点の狭幅ブロックは
 *    `display` / `overflow` を設定していないので、`@media print` を手前へ移す変異は
 *    **今日は等価**で殺せない(app.css の同名の節に理由を書いた)。
 * 🔴 **罠③: `emulateMedia({media:'print'})` だけでは viewport 幅が変わらない**。
 *    紙で効く規則を観測するには `setViewportSize(794×1123)` が要る。
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoApp, clickReal, createEntry } from './helpers';

/** A4 縦(96dpi 換算)。⚠ 罠② の狭幅上書きがここで発火する。 */
const A4 = { width: 794, height: 1123 };

test('🔴 画面から印刷すると全文が紙に乗り、+++ で改頁する', async ({ page }) => {
  await gotoApp(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  // 3 種の区切りを 1 つずつ + 紙 2 枚を超える長さ
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `## 見出し ${i}\n\n本文の行 ${i}`).join('\n\n');
  await ta.fill(
    `${filler(40)}\n\n+++\n\n${filler(40)}\n\n:::break{kind=page}\n\n中\n\n---\n\n最後\n`,
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const body = page.locator('[data-pkc-field="detail-body"]');
  await expect(body).toBeVisible();

  /**
   * ⚠ **空振り防止を先に置く** ── 改頁のマーカーと素の罫線が実際に出ていること。
   * 0 件なら、以下の assert は何も見ていない。
   */
  const counts = await page.evaluate(() => {
    const host = document.querySelector('[data-pkc-field="detail-body"]')!;
    const all = [...host.querySelectorAll('hr')];
    return {
      breaks: all.filter((h) => h.classList.contains('pkc-section-break')).length,
      plain: all.filter((h) => !h.classList.contains('pkc-section-break')).length,
      scrollH: host.scrollHeight,
    };
  });
  expect(counts.breaks, '改頁のマーカーが出ていない(何も測っていない)').toBeGreaterThanOrEqual(2);
  expect(counts.plain, '素の罫線(kind=rule)が出ていない').toBeGreaterThanOrEqual(1);
  expect(counts.scrollH, '本文が紙 1 枚に収まる短さ(切れても気づけない)').toBeGreaterThan(2000);

  // 罠③: 紙の幅にする。罠②: この幅で狭幅の上書きが発火する
  await page.setViewportSize(A4);
  await page.emulateMedia({ media: 'print' });

  const printed = await page.evaluate(() => {
    const cs = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? getComputedStyle(el) : null;
    };
    const host = document.querySelector('[data-pkc-field="detail-body"]')!;
    const hrs = [...host.querySelectorAll('hr')].map((h) => ({
      isBreak: h.classList.contains('pkc-section-break'),
      breakAfter: getComputedStyle(h).breakAfter,
      // 🔴 罠①: 箱が在るかを **break-after と対で**見る
      boxes: h.getClientRects().length,
      display: getComputedStyle(h).display,
    }));
    return {
      shellDisplay: cs("[data-pkc-region='shell']")?.display ?? '(無し)',
      detailOverflowY: cs("[data-pkc-region='detail']")?.overflowY ?? '(無し)',
      sidebar: cs("[data-pkc-region='sidebar']")?.display ?? '(無し)',
      inspector: cs("[data-pkc-region='inspector']")?.display ?? '(無し)',
      hrs,
    };
  });

  // ① 器がほどけている(ここがほどけないと窓の分しか紙に出ない)
  expect(printed.shellDisplay, '紙でも grid のまま(器がほどけていない)').toBe('block');
  expect(printed.detailOverflowY, '紙でもスクロール箱のまま').toBe('visible');
  // ② 紙に押せないものを出さない
  expect(printed.sidebar, '紙に一覧が出ている').toBe('none');
  expect(printed.inspector, '紙に付随情報が出ている').toBe('none');

  // ③ 🔴 改頁のマーカーは **break-after が page** かつ **箱が在る**
  const breaks = printed.hrs.filter((h) => h.isBreak);
  expect(breaks.length, '改頁のマーカーを 1 つも見ていない').toBeGreaterThanOrEqual(2);
  for (const h of breaks) {
    expect(h.breakAfter, '改頁が指定されていない').toBe('page');
    expect(h.display, 'display:none にすると改頁も消える(罠①)').not.toBe('none');
    expect(h.boxes, '箱が無い ── break-after は page でも改頁は起きない(罠①)').toBeGreaterThan(0);
  }

  // ④ 出し分け ── `---`(kind=rule)は改頁しないし、線は残る
  const plain = printed.hrs.filter((h) => !h.isBreak);
  expect(plain.length, '素の罫線を見ていない').toBeGreaterThanOrEqual(1);
  for (const h of plain) {
    expect(h.breakAfter, 'kind=rule でも改頁している(hr 全体に当ててしまっている)').toBe('auto');
  }

  /**
   * ⑤ 🔴 **実際に紙が増えたことを頁数で見る**(計算後の style は「指定した」だけ)。
   * ⚠ `page.pdf()` は headless 限定 ── headed のときは飛ばす。
   */
  const pdf = await page.pdf({ format: 'A4' }).catch(() => null);
  if (pdf) {
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages, `紙が 1 枚しか出ていない(切れている)。頁数=${pages}`).toBeGreaterThan(2);
  }

  /**
   * ⑥ 🔴 **配る HTML でも同じことが成り立つ**(経路ごとに pin する)。
   *
   * ⚠ 画面側だけ見ていると、書き出し側の改頁を落とす変異が**生き延びる**
   * (実測で生き延びた)。`+++` の意味が面で食い違うのは、この PR が直しに来た
   * 「約束が面ごとに違う」そのものである。
   * ⚠ 書き出したファイルは `file://` で**単体で**開く ── アプリの CSS は届かない。
   */
  await page.emulateMedia({ media: 'screen' });
  const dl = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-action="export-html"]');
  const download = await dl;
  const file = join(tmpdir(), `pkc3-print-${process.pid}.html`);
  await download.saveAs(file);

  const viewer = await page.context().newPage();
  await viewer.goto(`file://${file}`);
  await expect(viewer.locator('#body')).toBeVisible();
  await viewer.setViewportSize(A4);
  await viewer.emulateMedia({ media: 'print' });
  const exported = await viewer.evaluate(() => {
    const hrs = [...document.querySelectorAll('#body hr')].map((h) => ({
      isBreak: h.classList.contains('pkc-section-break'),
      breakAfter: getComputedStyle(h).breakAfter,
      boxes: h.getClientRects().length,
      display: getComputedStyle(h).display,
    }));
    return hrs;
  });
  const expBreaks = exported.filter((h) => h.isBreak);
  expect(expBreaks.length, '配る HTML に改頁のマーカーが出ていない').toBeGreaterThanOrEqual(2);
  for (const h of expBreaks) {
    expect(h.breakAfter, '配る HTML で改頁が指定されていない').toBe('page');
    expect(h.display, '配る HTML で display:none にしている(罠①)').not.toBe('none');
    expect(h.boxes, '配る HTML で箱が無い(改頁は起きない ── 罠①)').toBeGreaterThan(0);
  }
  const expPlain = exported.filter((h) => !h.isBreak);
  expect(expPlain.length, '配る HTML に素の罫線が出ていない').toBeGreaterThanOrEqual(1);
  for (const h of expPlain) {
    expect(h.breakAfter, '配る HTML で kind=rule も改頁している').toBe('auto');
  }
  await viewer.close();
});
