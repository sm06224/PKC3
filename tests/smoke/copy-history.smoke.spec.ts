import { expect, test } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
  useSplitEditor,
} from './helpers';

/**
 * #678: **前にコピーした物を取り出せる**。
 *
 * 🔴 **ここでしか見えない層が 3 つある**:
 * ① **本物のクリップボードへ写る**か ── unit は `navigator.clipboard` を差した
 *    偽物で見ているので、実際の write は 1 度も走らない。
 * ② **メニューが本当に出て、押せるか** ── 出す場所・重なり・押し所は
 *    happy-dom では読めない。
 * ③ 🔴 **読み直しても残るか** ── localStorage の往復は実ブラウザにしかない。
 */
test('🔴 コピーした物が残り、選ぶともう一度コピーされる (#678)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  // ⚠ 実ブラウザは許可を聞く ── 聞かれる形だと押し所の検査ができないので先に許す
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1280, height: 900 });
  // ⚠ `addInitScript` なので **`gotoApp` より前**に呼ぶ(原文の欄を出すため)
  await useSplitEditor(page);
  await gotoApp(page);
  await dismissAnnounce(page);

  // ── ① まだ何も無いときは、メニューではなく**帯で言う**(押しても何も起きない行を出さない)
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('まだ何もコピーして');
  expect(
    await page.locator('[data-pkc-region="context-menu"]').count(),
    '0 件なのにメニューを出している(押しても何も起きない行になる)',
  ).toBe(0);

  // ── ② 2 つコピーする(本文の「この章をコピー」ではなく、確実な口を使う)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('コピー元のノート');
  await page.locator('[data-pkc-field="editor-body"]').fill('ひとつめの中身\n\nふたつめの中身');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="copy-note-md"]');

  /**
   * 🔴 **積まれたことを、置き場そのもので待つ**(2026-09-09。フル smoke で 1 度落ちた)。
   *
   * ⚠ 直す前は「帯に『コピー』と出た」で次へ進んでいた ── これは**代理の観測点**で、
   *   ①別の知らせでも満たされうる ②写しは非同期なので、帯が出てから積まれるまでに
   *   間が空く。⚠ 実際、単独では 5/5 通るのにフル(498 本)の中でだけ落ちた
   *   (**再現は取れていない** ── 隣の spec と 2 本で回しても通る)。
   * 🔑 だから待つ相手を**置き場**にする。⚠ そして**落ちたら理由が読める**ようにする
   *   ── 「メニューが出ない」だけでは、写せなかったのか出せなかったのかが分からない。
   */
  await page
    .waitForFunction(
      () => (localStorage.getItem('pkc3.copy.history') ?? '').includes('ひとつめの中身'),
      undefined,
      { timeout: 15_000 },
    )
    .catch(async (e: unknown) => {
      const why = await page.evaluate(() => ({
        stored: (localStorage.getItem('pkc3.copy.history') ?? '(空)').slice(0, 200),
        status: document.querySelector('[data-pkc-region="status"]')?.textContent ?? '(無し)',
      }));
      throw new Error(
        `コピーが履歴に積まれない ── 置き場: ${why.stored} / 帯: ${why.status}`,
        { cause: e },
      );
    });

  // ── ③ 履歴に出る
  await page.keyboard.press('Control+Shift+V');
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu, '履歴のメニューが出ない').toBeVisible();
  await expect(menu).toContainText('ひとつめの中身');
  await expect(menu, '消す口が無い(消したい物を持ち続けることになる)').toContainText(
    'コピーした物を消す',
  );

  // ── ④ 🔴 選ぶと**もう一度コピーされる**(本物のクリップボードで確かめる)
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-copied="0"]');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('コピーしました');
  const pasted = await page.evaluate(() => navigator.clipboard.readText());
  expect(pasted, 'クリップボードに戻っていない(貼っても前の物が出る)').toContain('ひとつめの中身');

  // ── ⑤ 🔴 読み直しても残る(この端末に残る、が本当か)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  // ⚠ お知らせは 1 度閉じたら出ない(既読は端末に残る)── ここで待つと時間切れになる
  await page.keyboard.press('Control+Shift+V');
  await expect(
    page.locator('[data-pkc-region="context-menu"]'),
    '読み直したら消えた',
  ).toContainText('ひとつめの中身');

  // ── ⑥ 消せる(片道の操作を作らない)
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="clear-copy-history"]');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('全部消しました');
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('まだ何もコピーして');

  expect(errors, errors.join('\n')).toEqual([]);
});
