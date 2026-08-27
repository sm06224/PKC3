import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';
import { withStateOnFail } from './state-dump';

/**
 * 🔴 **書いたノートが、連絡先として並ぶ**(#278 段①。user 指示 2026-08-19
 * 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ…、**連絡先**、
 * タイマー、アラートは組み込みアプリでリリースしたい」)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **保存 → worker の走査 → 面**の全段 ── unit は面と worker を別々に見ており、
 *    「保存したものが本当に集まるか」は**その間の配線**なので誰も通らない
 *    (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも書けない」)
 * ② **タブを開いたときに集める**という段取り(`REFRESH_CONTACT_SCAN` の発火)
 * ③ **押せる宛先が本当に `tel:` / `mailto:` になっているか**(実ブラウザの `href`)
 */
test('🔴 tel: を書いたノートが連絡先に並び、押せる宛先になる (#278 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live
    .locator('[data-pkc-field="row-source"]')
    .fill(
      '---\ntel: 090-1234-5678\nemail: taro@example.com\norg: 例の会社\n---\n\n# 山田太郎\n\n打ち合わせは水曜が空いているとのこと。',
    );
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ⚠ **開くまで集めない**(連絡先を使わない人に全走査を負わせない)
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="contacts"]');
  const pane = page.locator('[data-pkc-browse-pane="contacts"]');
  await expect(pane, '連絡先のタブが開かない').toBeVisible();

  const row = pane.locator('[data-pkc-contact]');
  await withStateOnFail(page, '書いた連絡先が並ばない', async () => ({}), async () => {
    await expect(row, '連絡先が 1 件も並ばない').toHaveCount(1, { timeout: 10_000 });
  });

  // 🔴 **押せる宛先になっている**(実ブラウザの href で見る)
  await expect(
    row.locator('[data-pkc-field="contact-tel"]'),
    '電話が押せる宛先になっていない',
  ).toHaveAttribute('href', 'tel:09012345678');
  await expect(
    row.locator('[data-pkc-field="contact-mail"]'),
    'メールが押せる宛先になっていない',
  ).toHaveAttribute('href', 'mailto:taro@example.com');
  // ⚠ **字は書いたとおり**(記号を落とすのは href だけ)
  await expect(row).toContainText('090-1234-5678');
  await expect(row, '所属が出ていない').toContainText('例の会社');

  /**
   * 🔴 **名前を押すと、そのノートが中央に開く**(左の列はそのまま)。
   * ⚠ ここが #278 で「中央の面にしない」と決めた所である ──
   *   開いても**連絡先の面は消えない**。
   */
  await clickReal(page, '[data-pkc-field="contact-name"]');
  /**
   * ⚠ **本文に出るのは frontmatter の外**である ── `tel:` は囲みの中なので
   *   画面には出ない。だから見るのは**本文の字**(見出し)にする
   *   (1 稿目は `090-…` を探して落ちた ── 面が正しく、観測点が間違っていた)。
   */
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '名前を押してもノートが開かない',
  ).toContainText('打ち合わせは水曜');
  await expect(pane, 'ノートを開いたら連絡先の面が消えた').toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
