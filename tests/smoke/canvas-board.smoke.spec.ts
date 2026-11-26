/**
 * 🔴 **付箋のボードの無限キャンバス**(v4.0 Phase 2 / PR-09)を、実ブラウザで見る。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 枠が実際に器を切り取り、transform で拡大・縮小して見える | happy-dom は layout も transform も持たない |
 * | 🔴 **縮小した板で実マウスの掴みがカーソルに付いてくる**(倍率の割り戻し) | `getBoundingClientRect` が transform 込みになるのは実物だけ |
 * | 🔴 負の所へ離すと本文に負の x= / y= が書かれ、線が付いてくる | 保存の往復と線の実寸は実物でしか通らない |
 * | カメラを動かしても本文が 1 byte も変わらない | 同上 |
 *
 * 🔑 観測点は **data-pkc-x(本文から描き直された値)** と、編集の画面に出る本文そのもの。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BOARD = [
  ':::format{#c1 .pkc-place x=120 y=40 w=240 h=120}',
  'ひとつめ',
  ':::',
  '',
  ':::format{#c2 .pkc-place x=520 y=200 w=200 h=100}',
  'ふたつめ',
  ':::',
  '',
  ':::format{.pkc-line from=c1 to=c2}',
  ':::',
].join('\n');

test('🔴 無限キャンバス: 切替・ズーム・パン・倍率を割り戻した掴み・負の位置・通常表示へ戻す (PR-09)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'キャンバスの板');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const detail = page.locator('[data-pkc-region="detail"]');
  const bar = detail.locator('[data-pkc-field="canvas-bar"]');
  const mode = bar.locator('[data-pkc-canvas-cmd="mode"]');
  const vp = detail.locator('[data-pkc-field="canvas-viewport"]');
  const minimap = vp.locator('[data-pkc-field="canvas-minimap"]');
  const c1 = detail.locator('#c1');
  const lines = detail.locator('[data-pkc-field="place-lines"] path[data-pkc-line-from]');

  // ── 1. 通常表示 → 無限キャンバス ──
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(vp).toHaveCount(0);
  await clickReal(page, mode);
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(vp).toBeVisible();
  await expect(minimap).toBeVisible();
  await expect(minimap.locator('rect[data-pkc-minimap-card]')).toHaveCount(2);
  await expect(bar.locator('[data-pkc-canvas-cmd="zoom-in"]')).toBeVisible();
  await expect(lines).toHaveCount(1);

  // ── 2. ズーム(100% / + / − / 全体を表示)とパン ──
  const zoomReset = bar.locator('[data-pkc-canvas-cmd="zoom-reset"]');
  await clickReal(page, zoomReset);
  await expect(zoomReset).toHaveText('100%');
  const w100 = (await c1.boundingBox())!.width;
  expect(Math.round(w100), '100% で幅が記法どおりでない').toBe(240);
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="zoom-in"]'));
  await expect(zoomReset).toHaveText('125%');
  expect(Math.round((await c1.boundingBox())!.width), '拡大が見た目に効いていない').toBe(300);
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="zoom-out"]'));
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="zoom-out"]'));
  await expect(zoomReset).toHaveText('80%');
  expect(Math.round((await c1.boundingBox())!.width), '縮小が見た目に効いていない').toBe(192);
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="fit"]'));
  // 全体を表示: 2 枚とも枠の中に見える
  const vpBox = (await vp.boundingBox())!;
  for (const id of ['#c1', '#c2']) {
    const b = (await detail.locator(id).boundingBox())!;
    expect(b.x >= vpBox.x && b.x + b.width <= vpBox.x + vpBox.width, `${id} が枠の横に収まっていない`).toBe(true);
    expect(b.y >= vpBox.y && b.y + b.height <= vpBox.y + vpBox.height, `${id} が枠の縦に収まっていない`).toBe(true);
  }
  // 背景をドラッグしてパン(付箋の無い所 = 枠の左上の角。⚠ 左下は起動のお知らせが重なることがある)
  await clickReal(page, zoomReset);
  const before = (await c1.boundingBox())!;
  const bgX = vpBox.x + 20;
  const bgY = vpBox.y + 20;
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x as number, y as number);
    return el?.getAttribute('data-pkc-field') ?? `${el?.tagName ?? 'null'}:${el?.closest('[data-pkc-field]')?.getAttribute('data-pkc-field') ?? ''}`;
  }, [bgX, bgY]);
  expect(['canvas-viewport', 'detail-body'], `背景の点が背景でない(${String(hit)} / 枠 ${JSON.stringify(vpBox)} / 窓 ${JSON.stringify(page.viewportSize())})`).toContain(hit);
  await page.mouse.move(bgX, bgY);
  await page.mouse.down();
  await page.mouse.move(bgX + 90, bgY + 40, { steps: 6 });
  await page.mouse.up();
  const after = (await c1.boundingBox())!;
  expect(Math.round(after.x - before.x), 'パンで付箋が横に付いてこない').toBe(90);
  expect(Math.round(after.y - before.y), 'パンで付箋が縦に付いてこない').toBe(40);

  // カメラを動かしても本文は 1 byte も変わらない(編集の画面で原文を読む → やめる)
  await expect(c1).toHaveAttribute('data-pkc-x', '120');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  expect(await page.inputValue('[data-pkc-field="editor-body"]'), 'カメラの操作で本文が変わった').toBe(BOARD);
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  // 🔑 編集から戻ってもキャンバスとカメラ(100%)は覚えている
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(zoomReset).toHaveText('100%');

  // ── 3. 縮小(80%)して掴み、負の所へ動かして離す ──
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="zoom-out"]'));
  await expect(zoomReset).toHaveText('80%');
  const lineBefore = await lines.first().getAttribute('d');
  const grip = detail.locator('#c1 [data-pkc-field="place-grip"]');
  const g = (await grip.boundingBox())!;
  const cardBefore = (await c1.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  // 画面で −160 / −80 → ワールドで −200 / −100(80% を割り戻す)
  await page.mouse.move(g.x + g.width / 2 - 160, g.y + g.height / 2 - 80, { steps: 8 });
  const cardMid = (await c1.boundingBox())!;
  expect(Math.round(cardMid.x - cardBefore.x), '掴んでいる間、付箋がカーソルに付いてこない(横)').toBe(-160);
  expect(Math.round(cardMid.y - cardBefore.y), '掴んでいる間、付箋がカーソルに付いてこない(縦)').toBe(-80);
  await page.mouse.up();
  await expect(c1, '負の x= が本文に書かれていない').toHaveAttribute('data-pkc-x', '-80', { timeout: 5000 });
  await expect(c1).toHaveAttribute('data-pkc-y', '-60');
  // 線が付いてくる
  await expect.poll(() => lines.first().getAttribute('d'), { message: '線が付箋に付いてこない' }).not.toBe(lineBefore);
  await expect(lines).toHaveCount(1);
  // 離した位置は見た目もそのまま(描き直しで跳ばない)
  const cardAfter = (await c1.boundingBox())!;
  expect(Math.abs(cardAfter.x - cardMid.x), '描き直しで付箋が跳んだ').toBeLessThan(2);

  // ── 4. 通常表示へ戻す(枠・ミニマップが外れ、負の付箋も画面の中) ──
  await clickReal(page, mode);
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(vp).toHaveCount(0);
  await expect(detail.locator('[data-pkc-field="canvas-minimap"]')).toHaveCount(0);
  const host = detail.locator('[data-pkc-field="detail-body"]');
  await expect(host).toHaveAttribute('data-pkc-board-shift', '');
  // 🔑 器は transform で右下へずれている(外形は寄せた後)── 寄せる前の左端はバーと同じ所
  const barBox = (await bar.boundingBox())!;
  const c1Normal = (await c1.boundingBox())!;
  expect(Math.round(c1Normal.x - barBox.x), '通常表示で負の付箋が左へはみ出した(寄せていない)').toBe(0);
  expect(c1Normal.y, '通常表示で負の付箋が上へはみ出した').toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
  // 対照群: 器はずれた分だけ右にある(c1 は x=-80 → 器を 80px 右へ)
  const hostBox = (await host.boundingBox())!;
  expect(Math.round(hostBox.x - barBox.x), '器が寄せた量だけずれていない').toBe(80);

  // 付箋の無いノートでは何も起動しない
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'ふつうのノート');
  await page.fill('[data-pkc-field="editor-body"]', 'ふつうの本文です。');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(detail.locator('[data-pkc-field="canvas-bar"]')).toHaveCount(0);
  await expect(detail.locator('[data-pkc-field="canvas-viewport"]')).toHaveCount(0);

  expect(errors).toEqual([]);
});
