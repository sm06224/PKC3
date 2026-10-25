import { test, expect, type Page } from '@playwright/test';
import { gotoApp, dismissAnnounce, collectPageErrors, clickReal, modClickReal } from './helpers';

/**
 * 🔴 **長大なノート(5,000 行超)だけ、画面の外の塊の配置を飛ばす**(#1467、裁定 21 = A)。
 *
 * ## 🔴 unit では原理的に届かない
 *
 * `content-visibility: auto` が実際に塊を飛ばすか・目次で飛んだ先が飛ばした塊の見積もりの高さに
 * 惑わされず、周りが描かれた後に合わせ直されるか、は **配置を持つ実ブラウザでしか見えない**
 * (happy-dom は `getBoundingClientRect` も `checkVisibility` も 0 / 無い)。
 *
 * ## 守るもの
 *
 * 1. 5,000 行以下のノートには印が付かず、**どの塊も飛ばさない**(= 1 ピクセルも変わらない)
 * 2. 5,000 行を超えるノートは印が付き、**画面の外の塊を実際に飛ばす**(空振り防止)
 * 3. 目次で遠い見出しへ飛ぶと、周りが描かれた後に見出しが**画面の先頭の数 px 以内**へ落ち着く
 * 4. 飛ばした塊の中の字を、ブラウザの検索(Ctrl+F と同じ `window.find`)が見つけられる
 * 5. 紙(印刷)には全部描く
 * 6. 編集の面(ライブエディタ)にも印が付き、画面の外の塊を飛ばす(依頼 28 = B を測り直して覆した)。
 *    ⚠ 飛ばしている塊でも、遠い塊を開いて打て、確定すると本文に入る
 */

const HIRAGANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらり';

/** `##` を 50 行ごと・5 行ごとに空行・1 行 40 字。最後の段落に目印を 1 つ置く。 */
function fixture(n: number, tag: string): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    if (i % 50 === 1) out.push(`## ${tag}見出し ${Math.floor(i / 50) + 1}`);
    else if (i % 5 === 0) out.push('');
    else out.push(i === n - 1 ? `${HIRAGANA.slice(0, 20)}${tag}末尾の目印` : HIRAGANA.slice(0, 40));
  }
  return out.join('\n');
}

const SHORT_LINES = 2000;
const LONG_LINES = 6000;

async function importNotes(page: Page): Promise<void> {
  await page.setInputFiles('[data-pkc-field="import-input"]', [
    { name: 'short.md', mimeType: 'text/markdown', buffer: Buffer.from(fixture(SHORT_LINES, '短')) },
    { name: 'long.md', mimeType: 'text/markdown', buffer: Buffer.from(fixture(LONG_LINES, '長')) },
  ]);
  await expect(page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]')).toHaveCount(2, {
    timeout: 30_000,
  });
}

async function open(page: Page, tag: '短' | '長'): Promise<void> {
  await page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]', { hasText: `${tag}見出し 1` })
    .first()
    .click();
  // 描けた印(`data-pkc-painted` = いま選んでいる lid)を待つ
  await expect
    .poll(
      () =>
        page.evaluate((t) => {
          const h = document.querySelector('[data-pkc-field="detail-body"]');
          return h !== null && (h.textContent ?? '').slice(0, 40).includes(`${t}見出し 1`);
        }, tag),
      { message: `${tag}のノートが描けていない`, timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * 目次(右上の「目次」)から、後ろから 6 番目の見出しへ飛んで、**落ち着くまで待って**位置を返す。
 * 位置 = 見出しの上端から、本文の器の上端までの距離(px)。⚠ 0 ではない(器の余白 / 見出しの上の余白)。
 */
async function jumpFar(page: Page, tag: '短' | '長'): Promise<{ offset: number; scrollTop: number }> {
  await open(page, tag);
  await page.locator('.pkc-quick-toc-btn').click();
  const links = page.locator('.pkc-quick-toc-list [data-pkc-action="toc-jump"]');
  const n = await links.count();
  expect(n, '空振り防止 ── 目次に見出しが並んでいる').toBeGreaterThan(30);
  const farLink = links.nth(n - 6);
  const slug = await farLink.getAttribute('data-pkc-toc-slug');
  expect(slug).not.toBeNull();
  await farLink.click();
  const read = (): Promise<{ offset: number; scrollTop: number }> =>
    page.evaluate((id) => {
      const h = document.getElementById(id);
      const sc = document.querySelector('[data-pkc-region="detail"]') as HTMLElement;
      return {
        offset: h === null ? 99999 : Math.round(h.getBoundingClientRect().top - sc.getBoundingClientRect().top),
        scrollTop: Math.round(sc.scrollTop),
      };
    }, slug!);
  // 飛んで(scrollTop が動いて)から、見出しが器の上の端 100px 以内に居る状態を待つ
  await expect
    .poll(async () => {
      const r = await read();
      return r.scrollTop > 5_000 && Math.abs(r.offset) < 100;
    }, { message: `${tag}のノートで目次の見出しへ飛べていない`, timeout: 5_000 })
    .toBe(true);
  // 落ち着くまで 2 フレーム + 余裕(合わせ直しは 2 フレーム後に 1 度)
  await page.waitForTimeout(400);
  return read();
}

test('🔴 長大なノートだけ画面の外を飛ばし、目次で飛んだ先は落ち着く / 5,000 行以下は変わらない (#1467)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await importNotes(page);

  // ① 5,000 行以下 ── 印が無く、どの塊も飛ばさない
  await open(page, '短');
  const short = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const kids = [...host.children] as HTMLElement[];
    return {
      attr: host.hasAttribute('data-pkc-long-note'),
      blocks: kids.length,
      skipped: kids.filter((k) => getComputedStyle(k).contentVisibility !== 'visible').length,
    };
  });
  expect(short.blocks, '空振り防止 ── 2,000 行が塊として描けている').toBeGreaterThan(300);
  expect(short.attr, '5,000 行以下に印が付いた').toBe(false);
  expect(short.skipped, '5,000 行以下の塊を飛ばす設定が掛かった').toBe(0);

  // 対照 ── 5,000 行以下のノートで目次から遠い見出しへ飛んだときの落ち着き先(= 飛ばしを掛けない側の正解)
  const shortLanded = await jumpFar(page, '短');
  expect(shortLanded.scrollTop, '空振り防止 ── 本当に遠くへ飛んでいる').toBeGreaterThan(10_000);

  // ② 5,000 行超 ── 印が付き、画面の外の塊を実際に飛ばす
  await open(page, '長');
  const long = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const kids = [...host.children] as HTMLElement[];
    // ⚠ 飛ばされるのは塊の**中身**(塊自身は箱を持つ)── 塊の子で見る
    const inner = (el: HTMLElement): Element => el.firstElementChild ?? el;
    return {
      attr: host.hasAttribute('data-pkc-long-note'),
      blocks: kids.length,
      cv: getComputedStyle(kids[10]!).contentVisibility,
      // 末尾の塊は画面の外 ── 実際に飛ばされている(描かれていない)
      lastShown: inner(kids[kids.length - 2]!).checkVisibility({ contentVisibilityAuto: true }),
      firstShown: inner(kids[1]!).checkVisibility({ contentVisibilityAuto: true }),
    };
  });
  expect(long.blocks, '空振り防止 ── 6,000 行が塊として描けている').toBeGreaterThan(1000);
  expect(long.attr, '5,000 行超に印が付かない').toBe(true);
  expect(long.cv).toBe('auto');
  expect(long.firstShown, '画面の先頭の塊まで飛ばした').toBe(true);
  expect(long.lastShown, '画面の外(末尾)の塊を飛ばしていない ── 効いていない').toBe(false);

  // ③ 目次で遠い見出しへ飛ぶ ── 周りが描かれた後に、5,000 行以下のノートで飛んだときと同じ位置へ落ち着く
  const landed = await jumpFar(page, '長');
  expect(landed.scrollTop, '空振り防止 ── 本当に遠くへ飛んでいる').toBeGreaterThan(20_000);
  expect(
    Math.abs(landed.offset - shortLanded.offset),
    `長大なノートで飛んだ見出しの位置(${landed.offset}px)が、短いノート(${shortLanded.offset}px)と違う ── 見積もりの高さに惑わされたまま`,
  ).toBeLessThanOrEqual(6);

  // ④ 飛ばした塊の中の字を、ブラウザの検索が見つけられる(Ctrl+F と同じ機構)
  const found = await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    // @ts-expect-error `window.find` は標準の型に無い
    return window.find('長末尾の目印', false, false, true) as boolean;
  });
  expect(found, '飛ばした塊の中の字をブラウザの検索が見つけられない').toBe(true);

  // ⑤ 紙には全部描く
  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const kids = [...host.children] as HTMLElement[];
    return kids.filter((k) => getComputedStyle(k).contentVisibility !== 'visible').length;
  });
  expect(printed, '印刷で飛ばしたままの塊が残る').toBe(0);

  // ⑥ 編集の面にも印が付き、画面の外の塊を飛ばす。遠い塊を開いて打てる
  await page.emulateMedia({ media: 'screen' });
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live, '編集の面に印が付かない').toHaveAttribute('data-pkc-long-note', '', { timeout: 30_000 });
  await expect
    .poll(() => live.evaluate((el) => el.childElementCount), { message: '編集の本文が描けていない', timeout: 30_000 })
    .toBeGreaterThan(1000);
  const editSkipped = await live.evaluate((el) => {
    const kids = [...el.children] as HTMLElement[];
    return {
      cv: getComputedStyle(kids[10]!).contentVisibility,
      skipped: kids.filter((k) => !(k.firstElementChild ?? k).checkVisibility({ contentVisibilityAuto: true })).length,
    };
  });
  expect(editSkipped.cv).toBe('auto');
  expect(editSkipped.skipped, '編集の面で画面の外の塊を飛ばしていない ── 効いていない').toBeGreaterThan(500);
  // 末尾の段落(飛ばされている)まで送って、Ctrl+クリックで開いて打つ
  await live.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const last = live.locator('p', { hasText: '長末尾の目印' });
  await expect(last).toBeVisible();
  await modClickReal(page, last);
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row, '遠い塊が開かない').toBeVisible();
  await expect(row).toHaveValue(/長末尾の目印/);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('ZZZ');
  await expect(row).toHaveValue(/長末尾の目印ZZZ$/);
  await page.keyboard.press('Tab');
  await expect(live, '確定した字が本文に入らない').toContainText('長末尾の目印ZZZ');

  expect(errors).toEqual([]);
});
