/**
 * smoke: ノートに埋め込んだ HTML のウィジェット(v4.0 Phase 2 / PR-07、ビジョン 5-A)。
 *
 * まっさらな起動から 1 本の道中で見る(起動 1 つ ── `scripts/smoke-budget.mjs`):
 * 1. ` ```html id="counter" ` のカウンターを押して 0 → 2
 * 2. 再読み込みしても 2 のまま(箱の 1 行目の同期 `localStorage.getItem` が前回の値を返す)
 * 3. 同じノートの無関係な段落を編集しても 2 のまま / 配色を暗くしても箱を読み直さずに `--pkc-fg` と `data-pkc-tone` が変わる
 * 4. 「状態を初期化」→ 確認 → 0 に戻る
 * 5. `id=` の無い ` ```html ` は今までどおり描かれ、`localStorage` にウィジェットの鍵を書かない
 */
import { test, expect, type Frame, type Page } from '@playwright/test';
import {
  answerAppDialog,
  bootedHere,
  clickReal,
  collectPageErrors,
  createEntry,
  gotoApp,
  useSplitEditor,
  writesLanded,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const COUNTER =
  '<button id="inc">+1</button> <span id="val"></span>\n' +
  '<script>\n' +
  "var n = Number(localStorage.getItem('count') || '0');\n" +
  "window.__booted = window.__booted || Math.random();\n" +
  "document.getElementById('val').textContent = String(n);\n" +
  "document.getElementById('inc').onclick = function () { n += 1; localStorage.setItem('count', String(n)); document.getElementById('val').textContent = String(n); };\n" +
  '</script>';

const PLAIN =
  '<p id="plain">ふつうの枠</p>\n' +
  "<script>try { localStorage.setItem('x', '1'); document.getElementById('plain').setAttribute('data-wrote', 'yes'); } catch (e) { document.getElementById('plain').setAttribute('data-wrote', 'no'); }</script>";

const BODY = (para: string): string =>
  `${para}\n\n\`\`\`html id="counter"\n${COUNTER}\n\`\`\`\n\n\`\`\`html\n${PLAIN}\n\`\`\`\n`;

const widgetFrame = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-pkc-field="detail-body"] iframe.pkc-widget-frame');

async function frameOf(page: Page): Promise<Frame> {
  const el = await widgetFrame(page).elementHandle();
  const f = await el!.contentFrame();
  expect(f, 'ウィジェットの箱の中身が無い').not.toBeNull();
  return f!;
}

async function valueIs(page: Page, v: string): Promise<void> {
  await expect
    .poll(async () => {
      const f = await frameOf(page);
      return f.locator('#val').textContent().catch(() => null);
    }, { timeout: 10_000 })
    .toBe(v);
}

const widgetKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('pkc3.widget.')) out.push(k);
    }
    return out.sort();
  });

test('id= の在る html のウィジェットは状態を保ち、配色に追従し、初期化できる / id= の無い枠は何も保存しない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(BODY('はじめの段落'));
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);

  // 1. カウンターを 0 → 2
  await expect(widgetFrame(page)).toHaveCount(1);
  await valueIs(page, '0');
  const reset = page.locator('[data-pkc-field="widget-reset"]');
  await expect(reset).toHaveText('状態を初期化');
  await expect(reset, '保存が無いのに「状態を初期化」が押せる').toBeDisabled();
  const f0 = await frameOf(page);
  await f0.locator('#inc').click();
  await f0.locator('#inc').click();
  await valueIs(page, '2');
  await expect(reset, '保存したのに「状態を初期化」が押せない').toBeEnabled();
  const keys = await widgetKeys(page);
  expect(keys, '保存の鍵が 1 つでない').toHaveLength(1);
  expect(keys[0]).toMatch(/^pkc3\.widget\.[^.]+\.counter\.count$/);

  // 5(先に見る). id= の無い枠は描かれ、localStorage には書けない(状態を持たない)
  const plainFrame = page.locator('[data-pkc-field="detail-body"] iframe[data-pkc-html-render-id]:not(.pkc-widget-frame)');
  await expect(plainFrame).toHaveCount(1);
  const pf = await (await plainFrame.elementHandle())!.contentFrame();
  await expect(pf!.locator('#plain')).toHaveText('ふつうの枠');
  await expect(pf!.locator('#plain')).toHaveAttribute('data-wrote', 'no');
  expect(await widgetKeys(page), 'id= の無い枠が鍵を書いた').toEqual(keys);
  // 箱の隔離は変わらない
  expect(await widgetFrame(page).getAttribute('sandbox')).toBe('allow-scripts');
  expect(await plainFrame.getAttribute('sandbox')).toBe('allow-scripts');

  // 2. 再読み込みしても 2 のまま
  await page.reload();
  await bootedHere(page);
  if ((await widgetFrame(page).count()) === 0) {
    // 選択が戻らない起動なら、一覧から開き直す(user と同じ手順)
    await clickReal(page, page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]').first());
  }
  await valueIs(page, '2');

  // 3a. 同じノートの無関係な段落を編集しても 2 のまま
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill(BODY('書き換えた段落'));
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('書き換えた段落');
  await valueIs(page, '2');

  // 3b. 配色を暗くしても箱は読み直さず、変数と tone が変わる
  const fr = await frameOf(page);
  const booted = await fr.evaluate(() => (window as unknown as { __booted: number }).__booted);
  await page.evaluate(() => {
    (document.querySelector('[data-pkc-field="detail-body"] iframe.pkc-widget-frame') as HTMLElement).setAttribute('data-smoke-mark', '1');
  });
  const lightFg = await fr.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pkc-fg').trim());
  const parentDark = await page.evaluate(() => {
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    document.documentElement.setAttribute('data-pkc-tone', 'dark');
    return getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
  });
  await expect.poll(() => fr.evaluate(() => document.documentElement.getAttribute('data-pkc-tone'))).toBe('dark');
  const darkFg = await fr.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pkc-fg').trim());
  expect(darkFg, '箱の --pkc-fg が親の --fg と一致しない').toBe(parentDark);
  expect(darkFg, '暗くしても --pkc-fg が変わらない').not.toBe(lightFg);
  // 文字の色も --pkc-fg に従う
  const bodyColor = await fr.evaluate(() => getComputedStyle(document.body).color);
  expect(bodyColor).not.toBe('rgb(34, 34, 34)');
  // 読み直していない(箱の中の値も、親の側の要素も同じ)
  expect(await fr.evaluate(() => (window as unknown as { __booted: number }).__booted)).toBe(booted);
  await expect(page.locator('[data-pkc-field="detail-body"] iframe.pkc-widget-frame[data-smoke-mark="1"]')).toHaveCount(1);
  await valueIs(page, '2');

  // 4. 「状態を初期化」→ 確認 → 0
  await clickReal(page, reset);
  await answerAppDialog(page, 'ok');
  await valueIs(page, '0');
  expect(await widgetKeys(page), '初期化しても鍵が残った').toEqual([]);
  await expect(reset).toBeDisabled();

  expect(errors).toEqual([]);
});
