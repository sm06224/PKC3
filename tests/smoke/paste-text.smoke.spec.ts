/**
 * 🔴 **文字の貼付**(#251。HTML → PKC-Markdown / `data:` `blob:` を資産へ)。
 *
 * 🔴 **unit(happy-dom)では届かない層だけ**をここで見る:
 * ① **本物の `ClipboardEvent` + `DataTransfer`** ── `text/html` と `text/plain` を
 *    両方載せたクリップボードは、fake では「こちらが渡した形」しか試していない
 * ② **`document.execCommand('insertText')`** ── happy-dom に無いので unit は
 *    必ず fallback を通る = **本命の経路を 1 度も走らせていない**(CLAUDE.md §2)
 * ③ **実 `fetch('data:…')` + 実 IDB** ── 資産として本当に取り出せて、確定後の
 *    本文で**画像として描かれる**か(字が入っただけなら壊れた key でも通る)
 */
import { test, expect, type Page } from '@playwright/test';
import {
  clickReal,
  createEntry,
  collectPageErrors,
  expectImageRendered,
  gotoApp,
  useSplitEditor,
} from './helpers';

// 1x1 PNG(67 bytes)── 他の smoke と同じ絵
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 本物の paste event を、その欄の上で発火させる(焦点も実際に置く)。
 *
 * ⚠ **合成の event はブラウザの既定の貼付を起こさない**(信頼された event では
 * ないため)── だから「横取りしなかった」を **`value` が原文になること**では
 * 見られない。⚠ 観測点は **`defaultPrevented`**(= こちらが止めたかどうか)である。
 * 1 稿目はここを取り違えて「原文が入っていない」と読み、**製品の不具合に見えた**。
 */
async function pasteText(
  page: Page,
  selector: string,
  data: { html?: string; plain: string },
): Promise<boolean> {
  return await page.evaluate(
    ({ selector, data }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`要素が無い: ${selector}`);
      const dt = new DataTransfer();
      if (data.html !== undefined) dt.setData('text/html', data.html);
      dt.setData('text/plain', data.plain);
      if (el instanceof HTMLElement) el.focus();
      const ev = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { selector, data },
  );
}

/** 編集中の 1 面(既定 = live)を開いて、行の入力欄を出す。 */
async function openLiveRow(page: Page): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await expect(
    live.locator('[data-pkc-field="row-source"]'),
    '空のノートで行が開かない(貼る先が無い)',
  ).toBeVisible();
}

const ROW = '[data-pkc-region="editor-live"] [data-pkc-field="row-source"]';

test('🔴 ウェブページをコピーして貼ると、形のまま入って描かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  await pasteText(page, ROW, {
    html:
      '<h2>見出し</h2><p>本文と<strong>強調</strong>と<a href="https://e.com/a">リンク</a></p>' +
      '<ul><li>親<ul><li>子</li></ul></li></ul>' +
      '<table><tr><th>名</th><th>数</th></tr><tr><td>あ</td><td>1</td></tr></table>',
    plain: '見出し 本文と強調とリンク 親 子 名 数 あ 1',
  });

  const row = page.locator(ROW);
  // ① 記法に戻って入る(平文のままなら `##` も `|` も出ない)
  await expect(row, 'HTML が markdown に戻っていない').toHaveValue(/## 見出し/);
  await expect(row).toHaveValue(/\*\*強調\*\*/);
  await expect(row).toHaveValue(/\[リンク\]\(https:\/\/e\.com\/a\)/);
  await expect(row, '入れ子の箇条書きが平らになった').toHaveValue(/- 親\n {2}- 子/);
  await expect(row, '表が入っていない').toHaveValue(/\| 名 \| 数 \|/);

  // ② 🔴 **取り消せる**(`execCommand` の経路を通っている証拠 ── unit では測れない)
  await page.keyboard.press('Control+z');
  await expect(row, '取り消しで戻っていない').not.toHaveValue(/## 見出し/);
  await page.keyboard.press('Control+y');
  await expect(row).toHaveValue(/## 見出し/);

  // ③ 🔴 **確定すると本当にその形で描かれる**(字が入っただけで終わらせない)
  await page.keyboard.press('Tab');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live.locator('h2'), '見出しとして描かれていない').toContainText('見出し');
  await expect(live.locator('table td').first(), '表として描かれていない').toContainText('あ');
  await expect(live.locator('ul ul li'), '入れ子の箇条書きが描かれていない').toContainText('子');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 埋め込みの画像(data:)は資産になり、本文は asset: を指す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  await pasteText(page, ROW, {
    html: `<p>まえ</p><img src="data:image/png;base64,${PNG_1X1_B64}" alt="ず">`,
    plain: 'まえ',
  });

  const row = page.locator(ROW);
  await expect(row, '資産へ逃がしていない').toHaveValue(/!\[ず\]\(asset:[^)]+\)/, {
    timeout: 15_000,
  });
  // 🔴 **本文に base64 が残っていない**(残ると編集・保存のたびに丸ごと運ぶ)
  await expect(row, '本文に base64 が居座っている').not.toHaveValue(/base64/);

  // 確定すると**実際の画像として描かれる**(key が本物である証拠)
  await page.keyboard.press('Tab');
  await expectImageRendered(page, 'img[data-pkc-asset-key]');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 markdown 原文を渡してくるコピー(AI の「コピー」)は横取りしない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  // ⚠ text/plain が原文、text/html が描画済み ── 原文のほうが必ず正確である
  const source = '## 題\n\n```ts\nconst a = 1;\n```\n\n- あ';
  const stopped = await pasteText(page, ROW, {
    html: '<h2>題</h2><pre><code class="language-ts">const a = 1;</code></pre><ul><li>あ</li></ul>',
    plain: source,
  });

  // 既定の貼付に委ねた = 止めていない(原文がそのまま入る経路)
  expect(stopped, '原文を捨てて HTML から作り直した').toBe(false);
  // ⚠ 欄も触っていない(横取りしていないのに書き込んでいたら、それも事故)
  await expect(page.locator(ROW)).toHaveValue('');

  // 🔑 逆側 ── **形しか無い**コピーなら止める(この test が「常に止めない」で
  //    通っていないことを、同じ器で確かめる)
  const stoppedRich = await pasteText(page, ROW, {
    html: '<h2>題</h2><p>本文</p>',
    plain: '題 本文',
  });
  expect(stoppedRich, '形のあるコピーまで素通りしている').toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **資産にしている最中に焦点が移っても、本文の欄に入る**(#251)。
 *
 * ⚠ unit では**この行を 1 度も走らせられない** ── happy-dom に `execCommand` が無く、
 * 必ず fallback の `value` 直代入を通るので、焦点の有無が結果を変えない
 * (CLAUDE.md §2「弱いのではなく走っていない」)。#250 と同じ穴がここにも在る。
 * ⚠ **2 列の面で測る** ── 1 面は別の欄を触った瞬間に行を閉じるので、
 *   「欄は生きているのに焦点だけ外れた」というこの次元が作れない。
 */
test('🔴 資産にしている間に焦点が移っても、本文の欄に入る(2 列)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  const sel = '[data-pkc-field="editor-body"]';
  await expect(page.locator(sel)).toBeVisible();
  await pasteText(page, sel, {
    html: `<p>まえ</p><img src="data:image/png;base64,${PNG_1X1_B64}" alt="ず">`,
    plain: 'まえ',
  });
  // ⚠ 資産にしている**最中に**焦点を奪う(user が絞り込み欄を触った、の再現)
  await page.evaluate((sel) => {
    const ta = document.querySelector<HTMLTextAreaElement>(sel);
    if (ta?.value.includes('asset:'))
      throw new Error('この次元を測れていない(資産化が先に終わった)');
    const other = document.querySelector<HTMLElement>('[data-pkc-field="entry-filter"]');
    if (!other) throw new Error('焦点を移す先が無い(この次元を測れていない)');
    other.focus();
  }, sel);

  await expect(page.locator(sel), '本文の欄に入っていない(焦点を戻していない)').toHaveValue(
    /!\[ず\]\(asset:[^)]+\)/,
    { timeout: 15_000 },
  );
  // ⚠ **絞り込み欄に入っていない**(入ると検索語が壊れる ── 静かな事故)
  await expect(page.locator('[data-pkc-field="entry-filter"]')).toHaveValue('');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
