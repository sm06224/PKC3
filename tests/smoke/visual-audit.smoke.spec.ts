/**
 * 🔴 **画面の撮影台帳 ── 12 画面 × 明 / 暗(+ スマホ幅 390×844)**(Stage 2 PR-1。製品の挙動は変えない)。
 *
 * 後の PR(ネオンの全ブロック化・UI/UX の修正)の前後を人が見比べるための**撮影台**。`PKC3_SHOT_DIR` があるときだけ
 * `NN-name-light.png` / `NN-name-dark.png`(1440×900・DPR 2。スマホは 390×844)を書く。
 * ⚠ **撮らないときも各画面へ実際に着き、その画面を示す要素が見えていること**は毎回 assert する(撮影が空振りの飾りにならない)。
 *
 * | # | 画面 | 見える印 |
 * |---|---|---|
 * | 01 | ふつうのノート | 本文 |
 * | 02 | カードログ | `[data-pkc-log-card]` |
 * | 03 | 表・コード・図・グラフ入りのノート | 図(`mermaid` / `chart` の img) |
 * | 04 | 情報ペインのカードが主役の画面(02 と同じ画面で、情報ペインのカードを撮る意図の名前) | `[data-pkc-card]` |
 * | 05 | SQL の 3 ペイン / ER 図のタブ | `sql-tree` / `sql-er` |
 * | 06 | 予定表 | `schedule` のタブ |
 * | 07 | 設定 / 端末間の同期の E2E 暗号化の欄 | `settings-body` / `sync-e2e-setup` |
 * | 08 | メッセージの簡易履歴 | `message-popover` |
 * | 09 | 右下の知らせ(元に戻す) | `status-undo` |
 * | 10 | 回復キーのダイアログ | `recovery-key` |
 * | 11 | ランチャーと、別ウィンドウで開いたアプリ | `launcher-grid` / 別窓の `sql` |
 * | 12 | スマホ幅(一覧・本文・追記・メッセージ) | `data-pkc-layout="phone"` |
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  useSplitEditor,
  dismissAnnounce,
  openMessagePopover,
  openBrowse,
  openTile,
  clickInspectorMoreItem,
} from './helpers';
import { THEMES } from '../../src/adapter/ui/render/theme';
import { SECRET, PASS, startMockS3 } from './mock-s3';

test.use({ deviceScaleFactor: 2 });

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const DIR = process.env.PKC3_SHOT_DIR;
const SHOOTING = DIR !== undefined && DIR !== '';

/** 明 → 暗の順に同じ画面を撮る(`NN-name-light.png` / `NN-name-dark.png`)。撮影が無いときは何もしない。最後は明に戻す。 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOOTING) return;
  mkdirSync(DIR, { recursive: true });
  // ポインタは発光・吹き出しの出ない所(左のペインの一覧の上)へ逃がす。スマホ幅は触らない
  if ((page.viewportSize()?.width ?? 0) > 700) await page.mouse.move(150, 450);
  for (const theme of ['light', 'dark'] as const) {
    await applyThemeLikeApp(page, theme);
    await page.screenshot({ path: `${DIR}/${name}-${theme}.png` });
  }
  await applyThemeLikeApp(page, 'light');
}

/**
 * 🔴 配色は製品の `applyTheme`(`src/adapter/ui/render/theme.ts`)と同じく **`data-pkc-theme` と `data-pkc-tone` の 2 つ**を立てる
 * (`data-pkc-tone` がアクセントの色の明暗を決める。theme だけだと暗い撮影の半分が明のまま)。tone は製品と同じく THEMES の `dark` から引く。
 * ⚠ 切り替えるたびに、地の色が実際に変わったこと・tone が合っていることを assert する(撮影しない実行でも呼べる)。
 */
async function applyThemeLikeApp(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const tone = THEMES.find((t) => t.id === theme)?.dark === true ? 'dark' : 'light';
  const before = await bodyBg(page);
  await page.evaluate(
    ([t, tn]) => {
      document.documentElement.setAttribute('data-pkc-theme', t!);
      document.documentElement.setAttribute('data-pkc-tone', tn!);
    },
    [theme, tone],
  );
  await page.waitForTimeout(150); // 色の移り変わり(transition)が済むのを待つ
  expect(await page.locator('html').getAttribute('data-pkc-tone'), `${theme} の tone`).toBe(tone);
  const after = await bodyBg(page);
  if (lastTheme.get(page) !== undefined && lastTheme.get(page) !== theme) expect(after, `${theme} へ切り替えても地の色が変わらない(${before})`).not.toBe(before);
  lastTheme.set(page, theme);
  seenBg.set(`${theme}`, after);
  const other = seenBg.get(theme === 'light' ? 'dark' : 'light');
  if (other !== undefined) expect(after, '明と暗の地の色が同じ').not.toBe(other);
}
const lastTheme = new WeakMap<Page, string>();
const seenBg = new Map<string, string>();
const bodyBg = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function commitNew(page: Page, archetype: string, title: string, body: string): Promise<void> {
  await createEntry(page, archetype);
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

const select = (page: Page, title: string): Promise<void> =>
  clickReal(page, page.locator('[data-pkc-region="sidebar"]').getByText(title, { exact: true }).first());

const LOG = Array.from({ length: 9 }, (_, i) => [
  `## 2026-10-${String(1 + Math.floor(i / 3)).padStart(2, '0')} ${String(8 + (i % 3) * 3).padStart(2, '0')}:00:00`,
  `記録${i + 1}の本文です。作業の経過をここに書きます。`,
  ...(i === 1 ? ['- 補足の箇条書き\n- 数字の突き合わせは明日にまわす'] : []),
]).flat().join('\n\n');

const RICH = [
  '# 表・コード・図のノート',
  '本文の段落です。**太字**と`コード`と[リンク](https://example.com)。',
  '| 品目 | 数量 | 単価 |\n| --- | ---: | ---: |\n| りんご | 3 | 120 |\n| みかん | 5 | 80 |',
  '```ts\nconst total = items.reduce((a, b) => a + b.price, 0);\n```',
  '```sql\nSELECT 1\n```',
  '```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```',
  '```chart\n{"type":"bar","labels":["1月","2月","3月"],"datasets":[{"label":"件数","data":[3,5,2]}]}\n```',
  '> 引用の段落です。',
].join('\n\n');

test('🔴 撮影台帳: 通常の 12 画面のうち S3 を使わないもの(01〜06・07 設定・08・09・11・12)を明 / 暗で撮る (Stage 2 PR-1)', async ({ page, context }) => {
  test.setTimeout(240_000);
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);

  // 作り物の入れ物
  await commitNew(page, 'text', '通常のノート', '最初の段落です。日々のメモをここに書きます。\n\n- 箇条書きの 1\n- 箇条書きの 2\n\n二つ目の段落です。'.repeat(2));
  await commitNew(page, 'text', '表と図のノート', RICH);
  const body = page.locator('[data-pkc-field="detail-body"]');
  await expect(body.locator('[data-pkc-mermaid-src]')).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30_000 });
  await expect(body.locator('[data-pkc-chart-src]')).toHaveAttribute('data-pkc-chart-state', 'ready', { timeout: 30_000 });
  await commitNew(page, 'textlog', 'カードのログ', LOG);
  await commitNew(page, 'text', '消すノート', '消して「元に戻す」を撮る。');

  // 01 ふつうのノート
  await select(page, '通常のノート');
  await expect(body).toContainText('日々のメモ');
  await shoot(page, '01-note');

  // 03 表・コード・図・グラフ(先に: 図が焼き上がっている間に)
  await select(page, '表と図のノート');
  await expect(body.locator('table').first()).toBeVisible();
  await expect(body.locator('[data-pkc-mermaid-src] img')).toBeVisible();
  await expect(body.locator('[data-pkc-chart-src] img')).toBeVisible();
  await shoot(page, '03-rich-note');

  // 02 カードログ
  await select(page, 'カードのログ');
  await expect(body.locator('[data-pkc-log-card]').first()).toBeVisible();
  await shoot(page, '02-card-log');

  // 04 情報ペインのカード
  await expect(page.locator('[data-pkc-region="inspector"] [data-pkc-card]').first()).toBeVisible();
  await shoot(page, '04-note-with-inspector-cards');

  // 06 予定表(左のペインのタブ)
  await openBrowse(page, 'schedule');
  await expect(page.locator('[data-pkc-browse-pane="schedule"]'), '予定表のタブが出ない').toBeVisible();
  await shoot(page, '06-schedule');
  await openBrowse(page, 'filer'); // 一覧へ戻す

  // 05 SQL の 3 ペイン(+ ER 図のタブ)
  await page.evaluate(() => {
    location.hash = '#pkc?view=sql';
  });
  const sql = page.locator('[data-pkc-view-pane="sql"]');
  await expect(sql).toBeVisible({ timeout: 15_000 });
  await expect(sql.locator('[data-pkc-field="sql-tree-table"][data-pkc-name="entries"]')).toHaveCount(1, { timeout: 15_000 });
  await sql.locator('[data-pkc-field="sql-input"]').fill('SELECT lid, title FROM entries LIMIT 20');
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(sql.locator('[data-pkc-field="sql-table"]')).toBeVisible({ timeout: 10_000 });
  await shoot(page, '05-sql');
  await clickReal(page, sql.locator('[data-pkc-field="sql-er-toggle"]'));
  await expect(sql.locator('[data-pkc-region="sql-er"]')).toBeVisible();
  await expect(sql.locator('[data-pkc-field="sql-er-box"]').first()).toBeVisible({ timeout: 15_000 });
  await shoot(page, '05-sql-er');
  await clickReal(page, sql.locator('[data-pkc-field="sql-query-tab"]'));

  // 07 設定(S3 の E2E の欄は別の test)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator('[data-pkc-region="settings-body"]')).toBeVisible();
  await shoot(page, '07-settings');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]'); // 閉じて本文へ

  // 11 ランチャーと、別ウィンドウで開いたアプリ
  await openBrowse(page, 'launcher');
  await expect(page.locator('[data-pkc-region="launcher-grid"]')).toBeVisible();
  await shoot(page, '11-launcher');
  const opened = context.waitForEvent('page');
  await openTile(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:sql"]');
  const popup = await opened;
  await popup.setViewportSize({ width: 1100, height: 800 });
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup.locator('[data-pkc-view-pane="sql"]'), '別ウィンドウの SQL が出ない').toBeVisible({ timeout: 20_000 });
  await expect(popup.locator('[data-pkc-field="sql-tree-table"][data-pkc-name="entries"]')).toHaveCount(1, { timeout: 15_000 });
  await shoot(popup, '11-launcher-app-window');
  await popup.close();
  await openBrowse(page, 'filer');

  // 09 右下の知らせ(元に戻す)── 消すノートを「その他 ▾」から消す
  await select(page, '消すノート');
  await clickInspectorMoreItem(page, 'delete-entry');
  const toast = page.locator('[data-pkc-region="status-stack"] [data-pkc-field="status-undo"]');
  await expect(toast, '「元に戻す」つきの知らせが出ない').toBeVisible();
  await shoot(page, '09-toast-undo');
  await clickReal(page, toast); // 片道にしない(撮影の後始末)
  await select(page, '通常のノート');

  // 08 メッセージの簡易履歴
  const pop = await openMessagePopover(page);
  await expect(pop).toBeVisible();
  await shoot(page, '08-message-popover');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // 12 スマホ幅(一覧・本文・追記・メッセージ)── 前の知らせが写り込まないよう、消えるまで待つ
  // 知らせが出ている間だけ、消えるのを待つ(出ていなければ何もしない)
  if (await page.locator('[data-pkc-region="status"]').isVisible()) await expect(page.locator('[data-pkc-region="status"]')).toBeHidden({ timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-pkc-region="shell"]')).toHaveAttribute('data-pkc-layout', 'phone');
  const toList = async (): Promise<void> => {
    for (let i = 0; i < 3 && !(await page.locator('[data-pkc-region="sidebar"]').isVisible()); i += 1) {
      await clickReal(page, '[data-pkc-field="phone-back"]');
    }
    await expect(page.locator('[data-pkc-region="sidebar"]')).toBeVisible();
  };
  await toList();
  await shoot(page, '12-phone-list');
  await select(page, 'カードのログ');
  await expect(body.locator('[data-pkc-log-card]').first()).toBeVisible();
  await shoot(page, '12-phone-body');
  await expect(page.locator('[data-pkc-field="append-input"]'), 'スマホ幅で追記欄が見えない').toBeVisible();
  await page.locator('[data-pkc-field="append-input"]').scrollIntoViewIfNeeded();
  await shoot(page, '12-phone-append');
  const popPhone = await openMessagePopover(page);
  await expect(popPhone).toBeVisible();
  await shoot(page, '12-phone-message');
  await page.keyboard.press('Escape');

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 撮影台帳: 設定の「端末間の同期」の E2E 暗号化の欄と、回復キーのダイアログ(07・10)を明 / 暗で撮る (Stage 2 PR-1)', async ({ browser }) => {
  test.setTimeout(120_000);
  const mock = await startMockS3();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => localStorage.setItem('pkc3.sync', '1'));
  const page = await ctx.newPage();
  const errors = collectPageErrors(page);
  try {
    await useSplitEditor(page);
    await gotoApp(page);
    await dismissAnnounce(page);
    await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
    const s3 = page.locator('[data-pkc-region="settings-sync-s3"]');
    await expect(s3).toBeAttached();
    const f = (k: string) => page.locator(`[data-pkc-field="sync-s3-${k}"]`);
    await f('endpoint').fill(mock.url);
    await f('bucket').fill('my notes');
    await f('region').fill('auto');
    await f('prefix').fill('pkc3/');
    await f('access-key-id').fill(SECRET.accessKeyId);
    await f('secret').fill(SECRET.secretAccessKey);
    await clickReal(page, '[data-pkc-action="test-sync-s3"]');
    await expect(f('result')).toContainText('接続できました', { timeout: 20_000 });
    await clickReal(page, '[data-pkc-action="connect-sync-s3"]');
    const setup = s3.locator('[data-pkc-field="sync-e2e-setup"]');
    await expect(setup, 'E2E 暗号化の設定の欄が出ない').toBeVisible({ timeout: 20_000 });
    await s3.locator('[data-pkc-field="sync-e2e-pass"]').fill(PASS);
    await s3.locator('[data-pkc-field="sync-e2e-pass2"]').fill(PASS);
    await setup.scrollIntoViewIfNeeded();
    await shoot(page, '07-settings-e2e');

    await clickReal(page, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="start-sync-e2e-setup"]');
    const key = page.locator('[data-pkc-region="app-dialog"] [data-pkc-field="recovery-key"]');
    await expect(key, '回復キーの窓が出ない').toBeVisible({ timeout: 20_000 });
    await shoot(page, '10-recovery-key');
    await page.keyboard.press('Escape'); // 何も作らずにやめる
    await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
    expect(errors.filter((e) => !e.includes(mock.url)), `console エラー: ${errors.join(' / ')}`).toEqual([]);
  } finally {
    await ctx.close();
    mock.server.close();
  }
});
