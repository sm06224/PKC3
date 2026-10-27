/**
 * 🔴 **構造まわりの動線を、実ブラウザで 1 周**(#1441 / #1439 / #283 / #1455)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 ログの月の行・「すべて」の行が、**本物の描画**の見出しに付き、押すと**実際に画面から消える** | happy-dom は表示・非表示の計算(`hidden`)を画面に映さない |
 * | 🔴 見出しの右クリック → 切り出し → 戻す で、**本物の保存**を通っても本文が 1 字も変わらない | 保存は本物の worker(SQLite)を通る |
 * | 🔴 予定の面の「担当」の選択が、**本物の列**で札を絞る | 札の描画と配置は実 DOM |
 * | 🔴 ワークスペースを足して切り替えると**読み込み直され**、器ごとにノートが分かれる(OPFS の本物) | 読み込み直しは unit に無い |
 *
 * 🔑 起動は 1 本ずつ(起動を足すと以後すべての回に 1.6 秒 ── CLAUDE.md)。観測点は**画面に出ている字**と
 *   **保存を通した後の本文**。
 */
import { test, expect } from '@playwright/test';
import {
  gotoApp,
  bootedHere,
  clickReal,
  createEntry,
  collectPageErrors,
  useSplitEditor,
  writesLanded,
} from './helpers';

const MENU = '[data-pkc-region="context-menu"]';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 ログの月の行・すべて畳むが効き、見出しの右クリックで章を切り出して元に戻せる (#1441 / #1439)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ─ ① ログ: 2 か月にまたがる 4 日(月の行が 2 つ・「すべて」の行が 1 つ出る)
  await createEntry(page, 'textlog');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    [
      '## 2026-09-30 09:00:00',
      '九月の記録',
      '## 2026-10-01 09:00:00',
      '十月一日の記録',
      '## 2026-10-02 09:00:00',
      '十月二日の記録',
      '## 2026-10-02 18:00:00',
      '十月二日の夕',
    ].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const body = page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-body"]');
  const months = body.locator('[data-pkc-log-month]');
  await expect(months, '月の行が 2 つ出ていない').toHaveCount(2);
  await expect(months.nth(0)).toHaveText('2026年9月');
  await expect(months.nth(1)).toHaveText('2026年10月');
  const all = body.locator('[data-pkc-log-all]');
  await expect(all, '「すべて」の行が出ていない').toHaveText('すべて折りたたむ');
  const paras = body.locator('p');
  await expect(paras.filter({ visible: true }), '前提が崩れている(最初は 4 件とも見える)').toHaveCount(4);

  // 月の行を押す → その月の 3 件が画面から消える。もう一度で戻る(片道にしない)
  await months.nth(1).click();
  await expect(months.nth(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(paras.filter({ visible: true })).toHaveText(['九月の記録']);
  await months.nth(1).click();
  await expect(paras.filter({ visible: true }), '月の畳みが戻らない').toHaveCount(4);

  // 「すべて」を押す → 全部畳まれ、字が変わる。もう一度で全部戻る
  await all.click();
  await expect(paras.filter({ visible: true }), '「すべて」で畳まれない').toHaveCount(0);
  await expect(all).toHaveText('すべて出す');
  await all.click();
  await expect(paras.filter({ visible: true }), '「すべて出す」で戻らない').toHaveCount(4);

  // ─ ② 章の切り出し / 元に戻す
  await createEntry(page, 'text');
  const ORIGINAL = '# 全体\n\n前書き\n\n## 第一章\n\n一章の本文\n\n## 第二章\n\n二章の本文\n';
  await page.fill('[data-pkc-field="editor-title"]', '長いノート');
  await page.fill('[data-pkc-field="editor-body"]', ORIGINAL);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await writesLanded(page);
  const detail = page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-body"]');
  await expect(detail.getByText('一章の本文')).toBeVisible();

  await detail.locator('h2', { hasText: '第一章' }).click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-pkc-action="restore-chapter"]'), '切り出す前から「戻す」が出ている').toHaveCount(0);
  await menu.locator('button[data-pkc-action="split-chapter"]').click();
  // 本文では、一章の本文が消え、リンク 1 行(切り出したノートへ)に替わる。見出しは残る
  await expect(detail.getByText('一章の本文'), '切り出したのに本文が残っている').toHaveCount(0);
  await expect(detail.locator('h2', { hasText: '第一章' })).toBeVisible();
  await expect(detail.locator('a[data-pkc-action="navigate-entry-ref"]')).toHaveText('第一章');
  await expect(detail.getByText('二章の本文'), '隣の章まで巻き込んだ').toBeVisible();
  await writesLanded(page);
  // 左の一覧に「第一章」のノートが増えている(題名は見出しの字)
  await expect(
    page.locator('[data-pkc-region="sidebar"] [data-pkc-entry]').filter({ hasText: '第一章' }),
    '切り出したノートが一覧に無い',
  ).toHaveCount(1);

  // 元に戻す(片道にしない)── 本文が 1 字も変わらず戻り、切り出し先は消える
  await detail.locator('h2', { hasText: '第一章' }).click({ button: 'right' });
  await expect(menu.locator('[data-pkc-action="split-chapter"]'), '切り出し済みなのに「切り出す」が出ている').toHaveCount(0);
  await menu.locator('button[data-pkc-action="restore-chapter"]').click();
  await expect(detail.getByText('一章の本文'), '戻らない').toBeVisible();
  await writesLanded(page);
  await expect(
    page.locator('[data-pkc-region="sidebar"] [data-pkc-entry]').filter({ hasText: '第一章' }),
    '戻したのに切り出し先が一覧に残っている',
  ).toHaveCount(0);
  // 往復後の本文(編集欄に開いて読む)が元と同じ
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toHaveValue(ORIGINAL);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 予定の面を担当で絞れ、情報ペインで担当を付けて外せる (#283)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await gotoApp(page);

  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const today = `${String(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  await createEntry(page, 'text');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    `- [ ] 見積を送る @${today} 担当:田中\n- [ ] 発注する @${today} 担当:鈴木\n- [ ] 会議 @${today}`,
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await writesLanded(page);

  // 予定のタブ: 担当を書いた予定があるので選択が出る
  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  await expect(pane).toBeVisible();
  const cards = pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]');
  await expect(cards, '札が 3 枚出ていない').toHaveCount(3, { timeout: 10_000 });
  const sel = pane.locator('[data-pkc-field="schedule-owner"]');
  await expect(sel, '担当の選択が出ていない').toBeVisible();
  await sel.selectOption({ label: '田中' });
  await expect(cards, '田中で絞れない').toHaveCount(1);
  await expect(cards.first()).toContainText('見積を送る');
  await sel.selectOption({ label: '担当なし' });
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('会議');
  await sel.selectOption({ label: '担当: すべて' });
  await expect(cards, '「すべて」で戻らない').toHaveCount(3);

  // 情報ペイン: ノートの担当を付ける → 前書きに書かれる → 外す
  await clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="set-entry-owner"]');
  await page.fill('[data-pkc-field="prompt-input"]', '佐藤');
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect(
    page.locator('[data-pkc-region="inspector"] [data-pkc-field="inspector-owner-name"]'),
    '担当が情報ペインに出ない',
  ).toHaveText('佐藤');
  await writesLanded(page);
  await clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="clear-entry-owner"]');
  await expect(
    page.locator('[data-pkc-region="inspector"] [data-pkc-field="inspector-owner-name"]'),
    '担当を外せない',
  ).toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 ワークスペースを足して切り替えると、読み込み直され、器ごとにノートが分かれる (#1455)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '仕事のノート');
  await page.fill('[data-pkc-field="editor-body"]', '仕事の本文');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await writesLanded(page);

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const box = page.locator('[data-pkc-region="workspaces"]');
  await expect(box, 'ワークスペースの節が出ていない').toBeVisible();
  const rows = box.locator('[data-pkc-field="workspace-row"]');
  await expect(rows, '最初は 1 つのはず').toHaveCount(1);
  await expect(rows.first().locator('[data-pkc-field="workspace-current"]')).toHaveText('使用中');
  // 使っている器には「切り替える」「削除」を出さない
  await expect(rows.first().locator('[data-pkc-action="workspace-switch"]')).toHaveCount(0);
  await expect(rows.first().locator('[data-pkc-action="workspace-delete"]')).toHaveCount(0);

  // 足す(足しただけでは画面は変わらない)
  await box.locator('[data-pkc-field="workspace-new-name"]').fill('個人用');
  await clickReal(page, '[data-pkc-region="workspaces"] [data-pkc-action="workspace-create"]');
  await expect(rows, '足したのに増えない').toHaveCount(2);
  await expect(rows.filter({ hasText: '個人用' })).toHaveCount(1);

  // 切り替える → 読み込み直される → 個人用は空
  await Promise.all([
    page.waitForEvent('load'),
    clickReal(page, '[data-pkc-region="workspaces"] [data-pkc-action="workspace-switch"]'),
  ]);
  await bootedHere(page);
  await expect(
    page.locator('[data-pkc-region="sidebar"] [data-pkc-entry]').filter({ hasText: '仕事のノート' }),
    '切り替えたのに前の器のノートが見えている',
  ).toHaveCount(0);

  // 設定へ戻ると、使用中が個人用に替わっている。仕事用へ戻すとノートが戻る(双方向)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const rows2 = page.locator('[data-pkc-region="workspaces"] [data-pkc-field="workspace-row"]');
  await expect(rows2).toHaveCount(2);
  await expect(rows2.filter({ hasText: '個人用' }).locator('[data-pkc-field="workspace-current"]')).toHaveText('使用中');
  await Promise.all([
    page.waitForEvent('load'),
    rows2.filter({ hasNotText: '個人用' }).locator('[data-pkc-action="workspace-switch"]').click(),
  ]);
  await bootedHere(page);
  await expect(
    page.locator('[data-pkc-region="sidebar"] [data-pkc-entry]').filter({ hasText: '仕事のノート' }),
    '戻してもノートが戻らない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 板を右クリックして「手書きして置く…」→ 白紙に描いて保存すると、押した位置に画像の付箋が置かれる (#1448)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '手書きの板');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ':::format{.pkc-place x=40 y=40 w=240 h=100}\n最初の付箋\n:::\n',
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await writesLanded(page);
  const host = page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-body"]');
  const cards = host.locator('.pkc-place');
  await expect(cards).toHaveCount(1);

  // 空いている所を右クリック → 「手書きして置く…」
  await host.click({ button: 'right', position: { x: 520, y: 120 } });
  const menu = page.locator(MENU);
  await expect(menu.locator('[data-pkc-action="add-place-drawing"]')).toHaveText('手書きして置く…');
  const [win] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10_000 }),
    menu.locator('[data-pkc-action="add-place-drawing"]').click(),
  ]);
  await win.waitForSelector('[data-pkc-field="image-draw-canvas"]', { timeout: 10_000 });
  // 白紙(横 1280 × 縦 800)で始まる
  await expect
    .poll(() => win.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!.width))
    .toBe(1280);
  expect(await win.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!.height)).toBe(800);
  // 線が無いうちは保存を押せない / 1 本描くと押せる
  await expect(win.locator('[data-pkc-field="image-draw-save"]')).toBeDisabled();
  const box = (await win.locator('[data-pkc-field="image-draw-canvas"]').boundingBox())!;
  await win.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await win.mouse.up();
  await expect(win.locator('[data-pkc-field="image-draw-save"]')).toBeEnabled();
  const closed = win.waitForEvent('close', { timeout: 10_000 });
  await win.locator('[data-pkc-field="image-draw-save"]').click();
  await closed;

  // 板に付箋が 1 枚増え(画像そのものが映る)、左の一覧に添付が増えている
  await expect(cards, '手書きの付箋が板に置かれていない').toHaveCount(2, { timeout: 10_000 });
  await expect(host.locator('.pkc-place img').first(), '付箋の中に手書きの画像が映っていない').toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator('[data-pkc-region="sidebar"] [data-pkc-entry]').filter({ hasText: '手書き-' }),
    '添付が一覧に増えていない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 ポップアップが止められたら、左の「手書き」タブに白紙が開き、描いて保存すると板に置かれてタブが畳まれる (#1448)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoApp(page);
  // ブラウザがポップアップを止めた状態(window.open が null を返す)
  await page.evaluate(() => {
    window.open = () => null;
  });

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '退避の板');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ':::format{.pkc-place x=40 y=40 w=240 h=100}\n最初の付箋\n:::\n',
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await writesLanded(page);
  const host = page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-body"]');
  const cards = host.locator('.pkc-place');
  await expect(cards).toHaveCount(1);

  const tab = page.locator('[data-pkc-browse="draw"]');
  await expect(tab, '普段から手書きのタブが出ている').toBeHidden();

  await host.click({ button: 'right', position: { x: 520, y: 120 } });
  await page.locator(MENU).locator('[data-pkc-action="add-place-drawing"]').click();

  // 中央ではなく左のタブに道具が出る
  await expect(tab).toBeVisible({ timeout: 10_000 });
  const canvas = page.locator('[data-pkc-browse-pane="draw"] [data-pkc-field="image-draw-canvas"]');
  await expect(canvas, '手書きのタブに台が出ていない').toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-pkc-region="detail"] [data-pkc-field="image-draw-canvas"]'), '中央に台が出ている').toHaveCount(0);
  await expect(cards, '手書きを開いたら中央の板が消えた').toHaveCount(1);
  const save = page.locator('[data-pkc-browse-pane="draw"] [data-pkc-field="image-draw-save"]');
  await expect(save).toBeDisabled();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(save).toBeEnabled();
  await expect(cards, '台を押しただけで、読んでいる板が閉じた').toHaveCount(1);
  await save.click();

  await expect(cards, '手書きの付箋が板に置かれていない').toHaveCount(2, { timeout: 10_000 });
  await expect(tab, '保存後も手書きのタブが残っている').toBeHidden({ timeout: 10_000 });

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
