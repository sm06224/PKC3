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

test('🔴 無限キャンバス: 切替・ズーム・パン・倍率を割り戻した掴み・負の位置・通常表示へ戻す (PR-09) + 複数選択・整列・手書き・関係グラフ (PR-10)', async ({ page }) => {
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

  /**
   * ── 5. v4.0 Phase 2 / PR-10(ビジョン 2-B)── 複数選択と整列・手書き・関係グラフのズームとボードで開く。
   * 🔑 smoke の予算(`scripts/smoke-budget.mjs`)── 新しい起動を増やさず、この道中に積む。
   * ⚠ 選択・カメラはノートごとの記憶なので、3 つはそれぞれ新しいノートで始める(前の段の状態を持ち込まない)。
   */
  await multiSelectAndAlign(page);
  await freehandPlace(page);
  await graphToBoard(page);
  await narrowMinimap(page);

  expect(errors).toEqual([]);
});

/* ───────────────── v4.0 Phase 2 / PR-10(ビジョン 2-B) ───────────────── */

/** 板を作って無限キャンバスで開き、100% にする。 */
async function openBoard(page: import('@playwright/test').Page, title: string, body: string) {
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', title);
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const detail = page.locator('[data-pkc-region="detail"]');
  const bar = detail.locator('[data-pkc-field="canvas-bar"]');
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="mode"]'));
  await expect(bar.locator('[data-pkc-canvas-cmd="mode"]')).toHaveAttribute('aria-pressed', 'true');
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="zoom-reset"]'));
  return { detail, bar, vp: detail.locator('[data-pkc-field="canvas-viewport"]') };
}

/** 🔴 複数選択: Shift + クリックで 2 枚選び、「整列 ▾ → 左揃え」で x= が揃う(1 回の書込)。 */
async function multiSelectAndAlign(page: import('@playwright/test').Page): Promise<void> {
  const { detail, bar } = await openBoard(page, '整列の板', BOARD);
  const c1 = detail.locator('#c1');
  const c2 = detail.locator('#c2');
  await expect(bar.locator('[data-pkc-canvas-cmd="align"]'), '選ぶ前から整列が出ている').toBeHidden();
  // 🔴 常に出るボタン(選択・手書き)は、複数選択で整列・グループが現れても横に動かない
  const selectBtn = bar.locator('[data-pkc-canvas-cmd="select"]');
  const drawBtn = bar.locator('[data-pkc-canvas-cmd="draw"]');
  const xBefore = [(await selectBtn.boundingBox())!.x, (await drawBtn.boundingBox())!.x];

  // 🔑 付箋の中の字(⠿ でない所)を Shift + クリック
  await c1.getByText('ひとつめ').click({ modifiers: ['Shift'] });
  await c2.getByText('ふたつめ').click({ modifiers: ['Shift'] });
  await expect(c1).toHaveAttribute('data-pkc-canvas-selected', '1');
  await expect(c2).toHaveAttribute('data-pkc-canvas-selected', '1');
  // 選んだ付箋は輪郭(アクセント)で見える
  const outline = await c1.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline, '選んだ付箋に輪郭が出ていない').toBe('solid');

  const align = bar.locator('[data-pkc-canvas-cmd="align"]');
  await expect(align).toBeVisible();
  expect((await selectBtn.boundingBox())!.x, '複数選択で「選択」が横に動いた').toBe(xBefore[0]);
  expect((await drawBtn.boundingBox())!.x, '複数選択で「手書き」が横に動いた').toBe(xBefore[1]);
  // 整列・グループは常設ボタンの後ろにある
  expect((await align.boundingBox())!.x, '整列が手書きより前にある').toBeGreaterThan(xBefore[1]!);
  // 🔴 押している「選択」は字色と同じ色で塗りつぶさない(反転の塗りをやめた)
  await clickReal(page, selectBtn);
  await expect(selectBtn).toHaveAttribute('aria-pressed', 'true');
  const paint = await selectBtn.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--fg)';
    document.body.append(probe);
    const fg = getComputedStyle(probe).color;
    probe.remove();
    return { bg: getComputedStyle(el).backgroundColor, fg };
  });
  expect(paint.bg, '押している選択が字色で塗りつぶされている').not.toBe(paint.fg);
  await clickReal(page, selectBtn);
  await clickReal(page, align);
  const menu = bar.locator('[data-pkc-field="canvas-align-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-pkc-canvas-align="distribute-x"]'), '2 枚なのに等間隔が押せる').toBeDisabled();
  await clickReal(page, menu.locator('[data-pkc-canvas-align="left"]'));
  await expect(menu).toHaveCount(0);
  // 🔴 本文から描き直された値で揃っている
  await expect(c2, '左揃えが本文に書かれていない').toHaveAttribute('data-pkc-x', '120', { timeout: 5000 });
  await expect(c1).toHaveAttribute('data-pkc-x', '120');
  await expect(c2).toHaveAttribute('data-pkc-y', '200');
  // 見た目も揃う
  const b1 = (await c1.boundingBox())!;
  const b2 = (await c2.boundingBox())!;
  expect(Math.round(b1.x), '見た目の左端が揃っていない').toBe(Math.round(b2.x));
  // 選択は描き直しの後も残る / Esc で外れる
  await expect(c2).toHaveAttribute('data-pkc-canvas-selected', '1');
  await detail.locator('[data-pkc-field="canvas-viewport"]').focus();
  await page.keyboard.press('Escape');
  await expect(detail.locator('[data-pkc-canvas-selected]')).toHaveCount(0);
}

/** 🔴 スマホ幅(390px)ではミニマップを既定で出さない(押すと出る)。 */
async function narrowMinimap(page: import('@playwright/test').Page): Promise<void> {
  // ⚠ 作るのは広い画面(スマホ幅では作成の画面が違う)── キャンバスを開く直前に幅を狭める
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '狭い画面の板');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await page.setViewportSize({ width: 390, height: 844 });
  const detail = page.locator('[data-pkc-region="detail"]');
  const bar = detail.locator('[data-pkc-field="canvas-bar"]');
  const vp = detail.locator('[data-pkc-field="canvas-viewport"]');
  // ⚠ スマホ幅は上の見出しが重なるので、押し所の判定ではなくボタン自身の click を撃つ
  await bar.locator('[data-pkc-canvas-cmd="mode"]').evaluate((el) => (el as HTMLElement).click());
  // ⚠ スマホ幅は詳細が一覧の裏へ回る(visibility: hidden)ので、見えるかではなく `hidden` 属性と大きさで見る
  await expect(vp).toHaveCount(1);
  await expect(vp.locator('[data-pkc-field="canvas-minimap"]'), 'スマホ幅でミニマップが既定で出ている').toHaveAttribute('hidden', '');
  await bar.locator('[data-pkc-canvas-cmd="minimap"]').evaluate((el) => (el as HTMLElement).click());
  const mm = vp.locator('[data-pkc-field="canvas-minimap"]');
  await expect(mm).not.toHaveAttribute('hidden', '');
  const r = (await mm.boundingBox())!;
  const v = (await vp.boundingBox())!;
  expect(r.width, 'スマホ幅のミニマップが大きい').toBeLessThanOrEqual(112);
  expect(r.y + r.height, 'ミニマップが枠の下で切れている').toBeLessThanOrEqual(v.y + v.height);
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** 🔴 手書き: 描いて「ボードに置く」と透過 PNG の付箋が描いた所に置かれ、描く面は DOM から消える。 */
async function freehandPlace(page: import('@playwright/test').Page): Promise<void> {
  const { detail, bar, vp } = await openBoard(page, '手書きの板', BOARD);
  const places = detail.locator('.pkc-format-block.pkc-place');
  await expect(places).toHaveCount(2);
  // 🔑 押すまで描く面は無い(定常コスト 0)
  await expect(page.locator('canvas[data-pkc-field="canvas-draw-surface"]')).toHaveCount(0);

  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="draw"]'));
  const surface = vp.locator('[data-pkc-field="canvas-draw-surface"]');
  await expect(surface).toBeVisible();
  const s = (await surface.boundingBox())!;
  // 付箋の無い所(枠の下の方)に「く」の字
  const x0 = s.x + s.width * 0.35;
  const y0 = s.y + s.height * 0.6;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 80, y0 + 30, { steps: 6 });
  await page.mouse.move(x0 + 10, y0 + 70, { steps: 6 });
  await page.mouse.up();
  const place = vp.locator('[data-pkc-draw-cmd="place"]');
  await expect(place).toBeEnabled();
  await clickReal(page, place);

  // 🔴 3 枚目の付箋 = 透過・枠なしで、中に添付の画像
  await expect(places, '手書きの付箋が置かれていない').toHaveCount(3, { timeout: 10000 });
  const drawn = places.nth(2);
  await expect(drawn).toHaveAttribute('data-pkc-place-bare', '');
  await expect(drawn).toHaveAttribute('data-pkc-fill', 'transparent');
  await expect(drawn.locator('img')).toHaveCount(1);
  // 描いた場所に重なる(倍率 100% なので、付箋の左上は描き始めの点より左上・12px 前後の余白)
  // ⚠ 枠からの相対で比べる ── 本文が伸びると枠の上に「読了時間」の行(16px)が出て、枠ごと下へずれる(置く前後で画面の座標が変わる)
  const d = (await drawn.boundingBox())!;
  const s2 = (await vp.boundingBox())!;
  const rx = x0 - s.x;
  const ry = y0 - s.y;
  const cx = d.x - s2.x;
  const cy = d.y - s2.y;
  expect(cx, '付箋が描いた所より右にある').toBeLessThan(rx);
  expect(cx, '付箋が描いた所から離れすぎている').toBeGreaterThan(rx - 40);
  expect(cy, '付箋が描いた所より下にある').toBeLessThan(ry);
  expect(cy, '付箋が描いた所から離れすぎている').toBeGreaterThan(ry - 40);
  // 🔴 描く面は DOM から消える(画素も手放す)
  await expect(page.locator('canvas[data-pkc-field="canvas-draw-surface"]')).toHaveCount(0);
  await expect(page.locator('[data-pkc-field="canvas-draw"]')).toHaveCount(0);
  await expect(bar.locator('[data-pkc-canvas-cmd="draw"]')).toHaveAttribute('aria-pressed', 'false');
  // 開いているボードは動かない(添付を作っても選択を奪わない)
  await expect(detail.locator('#c1')).toBeVisible();

  // 本文: 付箋 1 枚の書込(既存の 2 枚はそのまま)
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  const text = await page.inputValue('[data-pkc-field="editor-body"]');
  expect(text.startsWith(BOARD), '既存の本文が変わった').toBe(true);
  expect(text).toMatch(/:::format\{\.pkc-place x=-?\d+ y=-?\d+ w=\d+ h=\d+ fill=transparent stroke=none\}\n!\[手書き\]\(asset:[A-Za-z0-9_-]+\)\n:::/);
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  // やめる: 何も置かずに消える
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await clickReal(page, bar.locator('[data-pkc-canvas-cmd="draw"]'));
  await expect(surface).toBeVisible();
  await clickReal(page, vp.locator('[data-pkc-draw-cmd="cancel"]'));
  await expect(page.locator('canvas[data-pkc-field="canvas-draw-surface"]')).toHaveCount(0);
  await expect(places).toHaveCount(3);
}

/** 🔴 関係グラフ: ズームしても節点を押せ、「ボードで開く」で layout: canvas のボードができる。 */
async function graphToBoard(page: import('@playwright/test').Page): Promise<void> {
  // B を作り、A から B へリンクする(関係グラフの smoke と同じ組み方)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '行き先B');
  await page.fill('[data-pkc-field="editor-body"]', '# 行き先B');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const lidB = await page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').first().getAttribute('data-pkc-entry');
  expect(lidB).toBeTruthy();
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '起点A');
  await page.fill('[data-pkc-field="editor-body"]', `# 起点A\n\n[行き先B](entry:${lidB})`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const tab = page.locator('[data-pkc-region="browse-tabs"] [data-pkc-browse="graph"]');
  if (await tab.evaluate((el) => el.hasAttribute('data-pkc-overflow'))) {
    await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-field="bar-more"]');
    await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="set-browse"][data-pkc-browse="graph"]');
  } else {
    await clickReal(page, tab);
  }
  const pane = page.locator('[data-pkc-browse-pane="graph"]');
  const nodes = pane.locator('[data-pkc-action="select-entry"]');
  await expect(nodes).toHaveCount(2);

  // ズーム(+ で 125%)── 図が大きくなる
  const before = (await nodes.first().boundingBox())!;
  await clickReal(page, pane.locator('[data-pkc-graph-zoom="in"]'));
  await expect(pane.locator('[data-pkc-graph-zoom="reset"]')).toHaveText('125%');
  const after = (await nodes.first().boundingBox())!;
  expect(after.width / before.width, 'ズームが図に効いていない').toBeGreaterThan(1.2);
  // Ctrl + ホイールでも変わる
  const map = pane.locator('[data-pkc-field="graph-viewport"]');
  const mb = (await map.boundingBox())!;
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Control');
  await expect(pane.locator('[data-pkc-graph-zoom="reset"]')).not.toHaveText('125%');

  // 🔴 ズームした後も節点は押せる所に在り、押すとそのノートへ移る
  const other = pane.locator('[data-pkc-field="graph-node"]');
  await expect(other).toHaveCount(1);
  const hit = await other.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return at === el || el.contains(at);
  });
  expect(hit, 'ズームした節点が押せる所に無い').toBe(true);
  const target = await other.getAttribute('data-pkc-entry');
  await clickReal(page, other);
  await expect.poll(() => pane.locator('[aria-current="true"]').getAttribute('data-pkc-entry')).toBe(target);

  // 🔴 ボードで開く
  const open = pane.locator('[data-pkc-action="graph-open-board"]');
  await expect(open).toBeEnabled();
  await clickReal(page, open);
  const detail = page.locator('[data-pkc-region="detail"]');
  await expect(detail.locator('[data-pkc-field="canvas-viewport"]'), 'ボードが無限キャンバスで開かない').toBeVisible({ timeout: 10000 });
  await expect(detail.locator('.pkc-format-block.pkc-place')).toHaveCount(2);
  await expect(detail.locator('[data-pkc-field="place-lines"] path[data-pkc-line-from]')).toHaveCount(1);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  const text = await page.inputValue('[data-pkc-field="editor-body"]');
  expect(text.startsWith('---\nlayout: canvas\n---\n'), 'layout: canvas が無い').toBe(true);
  expect(text).toContain(`entry=${lidB}`);
  expect(await page.inputValue('[data-pkc-field="editor-title"]')).toBe('関係グラフのボード');
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
}
