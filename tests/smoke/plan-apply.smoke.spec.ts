import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp } from './helpers';

/**
 * 🔴 **整理案を貼って、下見してから当てる**(#429 段③④)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **本物の貼り付け**(`input` が実際に飛ぶか)── unit は手で event を撃っている
 * 2. **`disabled` が本当に押せないか** ── happy-dom は `click()` を素通しさせうる
 * 3. **設定の面を開いてから**辿り着けるか(畳まれていない / 隠れていない)
 */
test('🔴 案を貼ると下見が出て、当てると本当に移る (#429)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 相手(フォルダ)と、動かすノートを作る
  await createEntry(page, 'folder');
  await page.locator('[data-pkc-field="editor-title"]').fill('資料');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('議事録');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * lid は画面から取れる ── 行が `data-pkc-entry` に持っている
   * (情報ペインの「参照をコピー」が出すのと同じ lid)。
   * ⚠ 既定はフォルダの面なので、**そちらの表**から拾う。
   */
  const lids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-entry]')].map((el) => ({
      lid: el.getAttribute('data-pkc-entry') ?? '',
      title: el.textContent ?? '',
    })),
  );
  const note = lids.find((l) => l.title.includes('議事録'));
  const box = lids.find((l) => l.title.includes('資料'));
  expect(note?.lid, '前提が崩れている ── 一覧から lid が取れない').toBeTruthy();
  expect(box?.lid).toBeTruthy();

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const ta = page.locator('[data-pkc-field="plan-input"]');
  await expect(ta, '整理案の欄が設定の面に出ていない(畳まれている?)').toBeVisible();

  const apply = page.locator('[data-pkc-field="plan-apply"]');
  await expect(apply, '貼る前から押せる(dead click)').toBeDisabled();

  // ① 🔴 **誤りが在ると押せない**(行番号つきで理由が出る)
  await ta.fill('mv zzz root');
  await expect(page.locator('[data-pkc-field="plan-errors"] li')).toHaveCount(1);
  await expect(page.locator('[data-pkc-field="plan-errors"] li').first()).toContainText('1 行目');
  await expect(apply, '誤りが在るのに押せる ── 半分だけ当たる').toBeDisabled();

  // ② 正しい案 ── 下見が**題名で**出る
  await ta.fill(`mv ${note!.lid} ${box!.lid}`);
  const prev = page.locator('[data-pkc-field="plan-preview"] li');
  await expect(prev).toHaveCount(1);
  await expect(prev.first(), '下見が題名で書かれていない').toContainText('議事録');
  await expect(prev.first()).toContainText('資料');
  await expect(apply).toBeEnabled();

  // ③ 🔴 **当てると本当に移る**(フォルダ面で中に入って確かめる)
  await clickReal(page, '[data-pkc-field="plan-apply"]');
  await expect(ta, '当てた後も案が残っている ── 二重に当ててしまう').toHaveValue('');
  await expect(apply).toBeDisabled();

  await clickReal(page, '[data-pkc-browse="filer"]');
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  // root には「資料」だけが残る(議事録はその中へ入った)
  await expect(rows, 'root の行数が変わっていない ── 移っていない').toHaveCount(1);
  await expect(rows.first()).toContainText('資料');

  expect(errors, `page error: ${errors.join(' / ')}`).toHaveLength(0);
});
