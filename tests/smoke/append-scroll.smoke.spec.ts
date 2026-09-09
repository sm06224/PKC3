import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, dismissAnnounce, collectPageErrors } from './helpers';

/**
 * 🔴 **追記しても、読んでいた場所が失われない**(#782。user 報告 2026-09-07)。
 *
 * > 「追記をすると再レンダリングで頭に戻る。これは別窓で開いている同じメモの方も
 * > 同じ挙動で … **別窓側は再レンダリングでもスクロールは固定しておいて欲しい**」
 *
 * ## 🔴 unit では原理的に届かない
 *
 * 壊れ方は「**本文の高さが潰れて、ブラウザが送り位置を 0 に丸める**」である。
 * happy-dom は版面を持たないので `scrollTop` は丸められない ── 位置を見る検査は
 * **あの台では直す前でも緑になる**。ここが唯一の門である。
 * (器の中身が残ることのほうは `tests/adapter/detail-scroll.test.ts` が見る。)
 *
 * ## 実測(2026-09-07、直す前)
 *
 * | 観測 | 送り位置 | 本文の高さ | 塊の数 |
 * |---|---|---|---|
 * | 追記の前 | **1200** | 10208 | 280 |
 * | 器を空にした直後 | 🔴 **0** | 756 → 650 | 1 → 0 |
 * | 本文が戻った後 | 🔴 **0 のまま** | 10240 | 281 |
 */

const LONG = Array.from(
  { length: 140 },
  (_, i) => `## 節 ${i + 1}\n\n本文の行です。ここに字を並べます。${i}`,
).join('\n\n');

const top = (p: Page): Promise<number> =>
  p.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-pkc-region="detail"]');
    return el === null ? -1 : Math.round(el.scrollTop);
  });

/**
 * 🔴 **「送れる本文になった」まで待つ**(2026-09-09。`workers` を 4 にしたら落ちた)。
 *
 * ⚠ ここは `makeLongNote` の直後に **1 度だけ**測っていた ── ところが
 *   `makeLongNote` が待っているのは**追記欄が出ること**であって、
 *   **本文が組み上がること**ではない。箱が忙しいと組み上がりが後ろへずれ、
 *   `scrollHeight - clientHeight` が **0 のまま**測れてしまう
 *   (実測: フル smoke で `Received: 0` で落ちた)。
 * 🔑 これは**前提**なので、1 度の assert ではなく**待ち**にする ──
 *   待っても伸びなければ**同じ文言で落ちる**ので、空振り防止の強さは変わらない。
 * ⚠ 直すのは「送れる本文か」の判定を**1 か所**にすること ── 同じ測り方が
 *   3 か所に散っていたので、1 か所だけ直すと残りが同じ形で落ちる。
 */
async function expectRoom(target: Page, what: string): Promise<void> {
  await expect
    .poll(
      () =>
        target.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-pkc-region="detail"]');
          return el === null ? -1 : el.scrollHeight - el.clientHeight;
        }),
      { message: `${what}が短すぎて送れない(空振り)`, timeout: 15_000 },
    )
    .toBeGreaterThan(2000);
}

/** 長い本文のノートを作る。⚠ **送れる本文になるまで待って**から返る。 */
async function makeLongNote(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(LONG);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();
  // ⚠ 追記欄が出ても本文はまだ組み上がっていないことがある(上の docstring)
  await expectRoom(page, '本文');
}

test('🔴 別の窓が追記しても、こちらの読んでいた場所は動かない (#782)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await makeLongNote(page);

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(win.locator('[data-pkc-view-pane="detail"]')).toBeVisible({ timeout: 20_000 });
  await win.setViewportSize({ width: 900, height: 800 });
  await win.waitForTimeout(1000);

  // ⚠ **送れる本文であることを先に検める** ── 短い本文では 0 のままでも緑になる
  //    (別窓は `makeLongNote` が面倒を見ないので、ここで待つ)
  await expectRoom(win, '別窓の本文');
  await win.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = 1200;
  });
  expect(await top(win), '前提が崩れた(送れていない)').toBe(1200);

  await page.locator('[data-pkc-field="append-input"]').fill('別の窓から追記した字');
  await clickReal(page, '[data-pkc-action="append-entry"]');

  // 🔑 **追記が別窓へ届くまで待つ** ── 届く前に測ると「動いていない」で必ず緑になる
  await expect(win.locator('[data-pkc-region="detail"]')).toContainText('別の窓から追記した字', {
    timeout: 15_000,
  });
  expect(await top(win), '別窓の読んでいた場所が失われた').toBe(1200);
  // ⚠ 遅れて飛ぶ形もあるので、落ち着いてからもう一度
  await win.waitForTimeout(800);
  expect(await top(win), '遅れて先頭へ飛んだ').toBe(1200);

  // 🔑 追記した側の窓も動かない(こちらは直す前から動いていない ── 対照群)
  expect(errors, `主の窓の error: ${errors.join(' / ')}`).toEqual([]);
  expect(winErrors, `別窓の error: ${winErrors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **追記した窓は、足した所へ送る**(#782 B。user 裁定 2026-09-07
 * 「追記した見出しや末尾にジャンプ」)。
 *
 * ⚠ ここも unit では原理的に見えない ── 「見えているか」は版面の話であり、
 *   happy-dom は版面を持たない。
 */
test('🔴 自分の窓で末尾に追記すると、足した字が見える所まで送る (#782 B)', async ({ page }) => {
  const errors = collectPageErrors(page);
  // ⚠ 「送れる本文であること」は `makeLongNote` が待って保証する(空振り防止)
  await makeLongNote(page);
  // ⚠ **上のほうを読んでいる状態**にする ── 足した字は本文のいちばん下なので、
  //    ここが下に居ると「送らなくても見えている」で空振りする
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = 300;
  });
  /**
   * 🔴 **1 回目を、上のほうの見出しへ足しておく**(#782 B の変異 M4)。
   *
   * ⚠ 1 回だけの台では「`lastAppend` が**動いた**回だけ送る」門を検められない ──
   *   その門が外れると、撃った直後(`writeLock` が立った瞬間)に**古い
   *   `lastAppend`** で発火し、**前に足した所**へ送って降りてしまう。
   * 🔑 だから 2 回足し、2 回目は**長い字**にする ── 古い所へ送ると、
   *   下の「最後の行が見えているか」が**画面の外**になる。
   */
  await page.locator('[data-pkc-field="append-target"]').selectOption({ index: 1 });
  await page.locator('[data-pkc-field="append-input"]').fill('1 回目の追記');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('1 回目の追記', {
    timeout: 15_000,
  });
  await page.locator('[data-pkc-field="append-target"]').selectOption({ index: 0 });
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = 300;
  });
  const LONG_ADD = [
    'ここから 2 回目の追記です。',
    ...Array.from({ length: 28 }, (_, i) => `追記の中の行 ${i + 1} です。`),
    '自分の窓で追記した字',
  ].join('\n');
  await page.locator('[data-pkc-field="append-input"]').fill(LONG_ADD);
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('自分の窓で追記した字', {
    timeout: 15_000,
  });
  /**
   * 🔑 観測点は**位置の数**ではなく「**足した字が画面に入っているか**」である
   *   ── 送り先の px を pin すると、版面が 1px 変わるたびに落ちる。
   */
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
          /**
           * 🔑 **字そのものの位置を測る**(囲んでいる要素ではなく、字の入っている節点)。
           * ⚠ 1 稿目は「子を持たない要素」を探していたが、**続けて書いた行は
           *   1 つの段落**になる(`breaks: true` は `<br>` で繋ぐ)ので当たらず、
           *   しかも段落の枠は 30 行ぶんの高さを持つので「見えている」が緩くなる。
           */
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node: Node | null = null;
          while (walk.nextNode() !== null) {
            if ((walk.currentNode.textContent ?? '').includes('自分の窓で追記した字')) {
              node = walk.currentNode;
              break;
            }
          }
          if (node === null) return 'まだ描けていない';
          const range = document.createRange();
          range.selectNodeContents(node);
          const a = range.getBoundingClientRect();
          const b = el.getBoundingClientRect();
          return a.top < b.bottom && a.bottom > b.top ? '見えている' : '画面の外';
        }),
      { timeout: 10_000 },
    )
    .toBe('見えている');
  // ⚠ 送ったことの裏取り ── 上に居たままなら送っていない(空振り防止)
  expect(await top(page), '足した所へ送っていない(位置が動いていない)').toBeGreaterThan(300);
  expect(errors, `error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **見えているなら動かさない**(#782 B の対照群)。
 *
 * ⚠ 1 稿目は**短い本文**で書いていたが、それでは `block: 'start'` に変える変異が
 *   **生き延びた** ── 送れない本文では、どちらでも位置は 0 のままである
 *   (CLAUDE.md §1「空振り」)。🔑 だから**送れる本文**のまま、
 *   **足す先が画面に入っている**形にした。
 */
test('⚠ 足した字が既に見えているときは、画面を動かさない (#782 B)', async ({ page }) => {
  const errors = collectPageErrors(page);
  // 🔑 空振り防止 ── **送れる本文**であること(送れないなら、どちらでも 0 のまま)は
  //    `makeLongNote` が待って保証する
  await makeLongNote(page);
  expect(await top(page), '前提が崩れた(先頭に居ない)').toBe(0);
  // ⚠ 入り先は**いちばん上の見出し** ── 先頭を見たままで、足した字が画面に入る
  await page.locator('[data-pkc-field="append-target"]').selectOption({ index: 1 });
  await page.locator('[data-pkc-field="append-input"]').fill('見えている所へ追記した字');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('見えている所へ追記した字', {
    timeout: 15_000,
  });
  await page.waitForTimeout(600);
  expect(await top(page), '見えているのに画面が動いた').toBe(0);
  expect(errors, `error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **断られた回は動かさない**(#782 B の対照群 2)。
 *
 * ⚠ これが無いと「着いた回だけ動く」の門(`lastAppend` が**動いたか**)を外す変異が
 *   生き延びる ── 外すと、空のまま押しただけで**前に足した所へ画面が飛ぶ**。
 */
test('⚠ 空のまま「追記」を押しても、画面は動かない (#782 B)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await makeLongNote(page);
  // ① 1 度ちゃんと追記する(`lastAppend` に中身を作る)
  await page.locator('[data-pkc-field="append-input"]').fill('1 回目の追記');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('1 回目の追記', {
    timeout: 15_000,
  });
  // ② 先頭へ戻して、**空のまま**押す
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = 0;
  });
  await page.locator('[data-pkc-field="append-input"]').fill('');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await page.waitForTimeout(1200);
  expect(await top(page), '何も足していないのに画面が動いた').toBe(0);
  expect(errors, `error: ${errors.join(' / ')}`).toEqual([]);
});
