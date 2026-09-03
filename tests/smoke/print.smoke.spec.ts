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
import { gotoApp, clickReal, createEntry, dismissAnnounce, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

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
  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)へ移った ── 先に開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
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

/**
 * 🔴 **紙に出す口が画面に在り、押すと印刷が始まる**(#187、2026-08-23)。
 *
 * ⚠ **観測点は「印刷が始まる瞬間」**(`beforeprint`)であって、押した直後ではない
 * ── CLAUDE.md §5:`chrome` は `beforeprint` のみ、CI 既定の `headless_shell` は
 * `beforeprint` + `afterprint` を**同期発火**する。どちらのビルドでも成立するのは
 * この 1 点だけである。
 *
 * ⚠ 台帳(#180)が「PDF の書き出し口が無い」と書いていた実体は**これ**だった ──
 * `@media print` も `Ctrl+P` も最初から在り、**一覧に並んでいなかった**だけ。
 *
 * ⚠ **既存の smoke は 1 件も `window.print()` を呼んでいない**
 * (`import.smoke.spec.ts` は合成 `beforeprint` を撃つ)。だから §5 のとおり
 * **2 つのビルド両方で通してから push した** ── `chromium-1194` / CI 既定の
 * `chromium_headless_shell-1194`(`PKC3_CHROMIUM` で差す)。どちらも 1 秒台。
 */
test('🔴 情報ペインの「PDF」を押すと印刷が始まる', async ({ page }) => {
  await gotoApp(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill('# 見出し\n\n本文が 1 行。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  // 押した瞬間ではなく、**印刷が始まった**ことを採る
  await page.evaluate(() => {
    (globalThis as unknown as Record<string, unknown>).__printed = 0;
    window.addEventListener('beforeprint', () => {
      (globalThis as unknown as Record<string, unknown>).__printed =
        ((globalThis as unknown as Record<string, number>).__printed ?? 0) + 1;
    });
  });

  const pdf = page.locator('[data-pkc-action="export-entry-pdf"]');
  await expect(pdf, '紙に出す口が画面に無い').toBeVisible();
  // ⚠ 説明は「起きること」で書く(user 指示 2026-08-21)── file は落ちない
  await expect(pdf).toHaveAttribute('title', /印刷画面/);

  await clickReal(page, '[data-pkc-action="export-entry-pdf"]');
  await expect
    .poll(async () => page.evaluate(() => (globalThis as unknown as Record<string, number>).__printed))
    .toBeGreaterThan(0);
});

/**
 * 🔴 **狭い紙(A5)に刷っても、本文が紙に出る**(#632 段③、設計 doc §2-17)。
 *
 * ## なぜ独立した腕が要るか
 *
 * 上の A4(794px)の腕は、**スマホ用画面をただの 1 度も通らない** ── 794px は
 * `PHONE_MAX_PX`(720px)より広いからである。ところが 🔴 **印刷中の版面幅は
 * 紙の幅**なので、A5 縦(**559px**)では `matchMedia` が真になり、
 * **スマホ用画面のまま紙へ行く**。
 *
 * そのとき中央の面は `visibility: hidden` で重なっているので、
 * ⚠ **本文が 1 文字も出ない**(一覧ページで刷ると、白紙が出る)。
 * 🔑 だから `@media print` が中央を `visibility: visible` へ戻している ──
 * この腕は**その 1 行が本当に効いているか**を、紙の側から見る。
 *
 * ## ⚠ いちばん危ない状態から測る
 *
 * **一覧ページに戻ってから**刷る ── 本文ページのまま刷ると中央は元から見えていて、
 * 戻しの 1 行を消しても緑のままになる(§1「別の理由で成立している」)。
 */
test('🔴 A5(559px)の紙でも、一覧ページのまま刷って本文が出る', async ({ page }) => {
  await page.setViewportSize({ width: 559, height: 794 });
  await gotoApp(page);
  // ⚠ この幅ではお知らせが**画面いっぱい**である(user 裁定 2026-09-02)── 畳まないと
  //   作る口に触れない。⚠ 紙の主張とは無関係なので、ここは前提を整えるだけである。
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill(
    Array.from({ length: 60 }, (_, i) => `## 章 ${i}\n\n紙に出るはずの行 ${i}`).join('\n\n'),
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔴 **いちばん危ない状態**へ移る ── 一覧ページ(中央が隠れている)
  await clickReal(page, '[data-pkc-field="phone-back"]');
  const shell = page.locator('[data-pkc-region="shell"]');
  await expect(shell, 'この幅でスマホ用画面になっていない(何も測っていない)').toHaveAttribute(
    'data-pkc-layout',
    'phone',
  );
  await expect(shell, '一覧ページに居ない(危ない状態を作れていない)').toHaveAttribute(
    'data-pkc-page',
    'list',
  );
  // ⚠ 空振り防止 ── 画面ではまだ中央は**隠れている**(戻しは印刷だけの話である)
  const onScreen = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('[data-pkc-region="center"]')!).visibility,
  );
  expect(onScreen, '画面でも中央が見えている(この幅はスマホ用画面ではない)').toBe('hidden');

  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => {
    const cs = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? getComputedStyle(el) : null;
    };
    const body = document.querySelector('[data-pkc-field="detail-body"]') as HTMLElement | null;
    return {
      center: cs("[data-pkc-region='center']")?.visibility ?? '(無し)',
      shell: cs("[data-pkc-region='shell']")?.display ?? '(無し)',
      sidebar: cs("[data-pkc-region='sidebar']")?.display ?? '(無し)',
      bar: cs("[data-pkc-region='phone-bar']")?.display ?? '(無し)',
      // 🔴 「見える」だけでなく**箱が在る**ことを対で見る(この file の罠①)
      boxes: body?.getClientRects().length ?? 0,
      scrollH: body?.scrollHeight ?? 0,
    };
  });

  expect(printed.center, '🔴 一覧ページのまま刷ると本文が 1 文字も出ない').toBe('visible');
  expect(printed.boxes, '中央は見えているのに本文の箱が無い(罠①)').toBeGreaterThan(0);
  expect(printed.scrollH, '本文が 1 行も組まれていない').toBeGreaterThan(2000);
  // ⚠ 紙に押せない物は出さない(A4 の腕と同じ約束が、この幅でも成り立つ)
  expect(printed.shell, '紙でも grid のまま(器がほどけていない)').toBe('block');
  expect(printed.sidebar, '紙に一覧が出ている').toBe('none');
  expect(printed.bar, '紙にページの帯が出ている(押せる物が無い)').toBe('none');

  /**
   * 🔴 **紙が本当に増えたことまで見る**(計算後の style は「指定した」だけ)。
   * ⚠ `page.pdf()` は headless 限定 ── headed のときは飛ばす。
   */
  const pdf = await page.pdf({ format: 'A5' }).catch(() => null);
  if (pdf) {
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages, `A5 の紙が 1 枚しか出ていない(本文が落ちている)。頁数=${pages}`)
      .toBeGreaterThan(2);
  }
});

