import { readFileSync } from 'node:fs';
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

/**
 * 🔴 **vCard の出し入れ**(#278 段③)。unit では届かない層:
 * ① 実 file picker(accept に .vcf が無いと受理器が動いてもファイルを選べない)
 * ② 取り込んだノートが**実 sqlite の再読込と worker の走査**を通って連絡先に並ぶ
 * ③ **実ブラウザの download** で .vcf が本当に落ち、中身が vCard である
 */
test('🔴 .vcf を取り込むと連絡先に並び、「vCard で書き出す」で .vcf が落ちてくる (#278 段③)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① accept に .vcf が無いと、受理器が動いてもファイルを選べない
  const accept = await page.locator('[data-pkc-field="import-input"]').getAttribute('accept');
  expect(accept).toContain('.vcf');

  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:山田太郎',
    'ORG:例の会社',
    'TEL;TYPE=CELL:090-1234-5678',
    'EMAIL:taro@example.com',
    'END:VCARD',
    '',
  ].join('\r\n');
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: '連絡先.vcf',
    mimeType: '',
    buffer: Buffer.from(vcf, 'utf8'),
  });

  // ② 取込の完了が帯に出る(⚠ 一覧の既定はフォルダ表示なので entry-list では見ない)
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '取込完了の帯が出ない',
  ).toContainText('取込完了: 連絡先 1 件', { timeout: 10_000 });
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="contacts"]');
  const pane = page.locator('[data-pkc-browse-pane="contacts"]');
  const row = pane.locator('[data-pkc-contact]');
  await withStateOnFail(page, '取り込んだ連絡先が並ばない', async () => ({}), async () => {
    await expect(row, '連絡先が 1 件も並ばない').toHaveCount(1, { timeout: 10_000 });
  });
  await expect(row.locator('[data-pkc-field="contact-name"]')).toContainText('山田太郎');

  // ③ 書き出し ── 実ブラウザの download で .vcf が落ち、中身が vCard である
  const exp = pane.locator('[data-pkc-field="contacts-export"]');
  await expect(exp, '書き出しの口が出ない').toHaveText('vCard で書き出す(1 件)');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-field="contacts-export"]'),
  ]);
  // ⚠ 名前は見ない(この headless は非 ASCII の download 名を捨てる)── 中身で見る
  const path = await download.path();
  expect(path, 'download が落ちてこない').toBeTruthy();
  const body = readFileSync(path!, 'utf8');
  expect(body).toContain('BEGIN:VCARD\r\nVERSION:3.0');
  expect(body).toContain('FN:山田太郎');
  expect(body).toContain('TEL;TYPE=voice:090-1234-5678');

  expect(errors, '例外が出ている').toEqual([]);
});
