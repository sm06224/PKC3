import { test, expect, type Page, type Request } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 関係グラフの大規模表示(GPU)と 3D(v4.0 Phase 3 / PR-13、ビジョン 1-C)── 実ブラウザで確かめる 3 つ。
 *
 * ① 関係グラフを既定(通常)で開いただけでは、Three.js の chunk を 1 つも取りに行かない(定常コスト 0)
 * ② 「大規模」→「3D」へ切り替えると遅延で読み込まれて描かれ(WebGPU / WebGL2 / 2D 簡易表示のどれか)、
 *    ドラッグ回転・ズーム・リセット・節点の押下によるノートの移動が例外 0 で動く
 * ③ 「通常」へ戻すと GPU の図が外れ、従来の DOM の図へ双方向に戻れる
 * 🔑 起動は 1 つ(`smoke-budget`)。⚠ 既存の道中に載せない ── ① は「一度も読んでいない」を見るので、
 *   他の spec の道中で読まれた chunk が混ざると空振りする。
 *
 * ⚠ 観測点は「何を取りに行ったか」(`request`)と DOM の印(`data-pkc-graph-gpu-state` / `-backend`)、
 *   それに「押したらどのノートが開いたか」(本文の題名)。節点の場所は、描画面の上で pointermove を走らせ
 *   ホバーの札(`select-entry` の `data-pkc-entry`)が出た点として探す ── 描き方(GPU / 2D)に依らない。
 */

/** Three.js の chunk の名前(vite の出力の名前は `three.core-…js` など)。 */
const THREE_CHUNK = /\/assets\/three[.-][^/]*\.js(?:\?|$)/;

function watchRequests(page: Page): Request[] {
  const all: Request[] = [];
  page.on('request', (r) => all.push(r));
  return all;
}

async function writeBody(page: Page, body: string): Promise<void> {
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(body);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

async function openBrowseTab(page: Page, mode: string): Promise<void> {
  const tab = page.locator(`[data-pkc-region="browse-tabs"] [data-pkc-browse="${mode}"]`);
  if (await tab.evaluate((el) => el.hasAttribute('data-pkc-overflow'))) {
    await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-field="bar-more"]');
    await clickReal(page, `[data-pkc-region="context-menu"] [data-pkc-action="set-browse"][data-pkc-browse="${mode}"]`);
  } else {
    await clickReal(page, tab);
  }
}

/**
 * 描画面の上で pointermove を走らせ、`want` 以外(`want` が null なら何でも)の節点にホバーの札が出る点を探す。
 * @returns ページの座標と、その節点の lid
 */
async function findNode(page: Page, pane: string, avoid: string | null): Promise<{ x: number; y: number; lid: string }> {
  const hit = await page.evaluate(
    ({ pane, avoid }) => {
      const stage = document.querySelector<HTMLElement>(`${pane} [data-pkc-field="graph-gpu-stage"]`)!;
      const hover = stage.querySelector<HTMLElement>('[data-pkc-field="graph-gpu-hover"]')!;
      const r = stage.getBoundingClientRect();
      for (let y = r.top + 4; y < r.bottom - 4; y += 4) {
        for (let x = r.left + 4; x < r.right - 4; x += 4) {
          stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: x, clientY: y, bubbles: true }));
          const lid = hover.hidden ? null : hover.getAttribute('data-pkc-entry');
          if (lid !== null && lid !== avoid) {
            stage.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 9, bubbles: false }));
            return { x, y, lid };
          }
        }
      }
      return null;
    },
    { pane, avoid },
  );
  expect(hit, '描画面のどこにも節点が見つからない').not.toBeNull();
  return hit!;
}

test('🔴 関係グラフ: 通常では Three.js 0 件 → 大規模 → 3D(回転・ズーム・リセット・押下で移動)→ 通常へ双方向', async ({ page }) => {
  const errors = collectPageErrors(page);
  const requests = watchRequests(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // B を作り、A は B へのリンクを持つ(「選んだノートから」の図に 2 つの節点)
  await createEntry(page, 'text');
  await writeBody(page, '# 行き先B');
  const title = page.locator('[data-pkc-field="detail-title"]').first();
  const titleB = (await title.innerText()).trim();
  const lidB = await page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').first().getAttribute('data-pkc-entry');
  expect(lidB).toBeTruthy();
  await createEntry(page, 'text');
  await writeBody(page, `# 起点A\n\n[行き先B](entry:${lidB})`);
  // ⚠ 観測点は本文の題名(一覧の `data-pkc-selected` は印の側で、開いているノートではない)
  const titleA = (await title.innerText()).trim();
  expect(titleA).not.toBe(titleB);

  // ① 既定(通常)── DOM の図が出て、Three.js は 1 件も取りに行かない
  const PANE = '[data-pkc-browse-pane="graph"]';
  await openBrowseTab(page, 'graph');
  const pane = page.locator(PANE);
  await expect(pane.locator('[data-pkc-field="graph-map"] [data-pkc-action="select-entry"]')).toHaveCount(2);
  await expect(pane.locator('[data-pkc-graph-mode="dom"]')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  expect(requests.filter((r) => THREE_CHUNK.test(r.url())).map((r) => r.url()), '通常の図で Three.js を取りに行った').toEqual([]);
  await expect(pane.locator('[data-pkc-field="graph-gpu"]')).toHaveCount(0);

  // ② 大規模(2D)── 遅延で読み込まれて描かれる
  await clickReal(page, pane.locator('[data-pkc-graph-mode="gpu2d"]'));
  const gpu = pane.locator('[data-pkc-field="graph-gpu"]');
  await expect(gpu).toHaveAttribute('data-pkc-graph-gpu-state', /^(ready|fallback)$/, { timeout: 20_000 });
  await expect(pane.locator('[data-pkc-field="graph-map"]')).toHaveCount(0);
  const backend2d = await gpu.getAttribute('data-pkc-graph-gpu-backend');
  expect(['webgpu', 'webgl2', '2d']).toContain(backend2d);
  if (backend2d !== '2d') {
    await expect(pane.locator('[data-pkc-field="graph-gpu-stage"] > canvas[data-pkc-gpu-canvas]')).toHaveCount(1);
    expect(requests.some((r) => THREE_CHUNK.test(r.url())), 'GPU で描いたのに Three.js を読んでいない').toBe(true);
  }

  // ③ 3D ── 回転・ズーム・リセット
  await clickReal(page, pane.locator('[data-pkc-graph-mode="gpu3d"]'));
  await expect(gpu).toHaveAttribute('data-pkc-graph-gpu-mode', 'gpu3d');
  await expect(gpu).toHaveAttribute('data-pkc-graph-gpu-state', /^(ready|fallback)$/, { timeout: 20_000 });
  await expect(pane.locator('[data-pkc-field="graph-gpu"]'), '前の大規模の図が残っている').toHaveCount(1);
  const stage = pane.locator('[data-pkc-field="graph-gpu-stage"]');
  const box = (await stage.boundingBox())!;
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(80);
  const reset = pane.locator('[data-pkc-graph-zoom="reset"]');
  await expect(reset).toHaveText('100%');
  // 🔴 有効にする前のただのホイールは、図を奪わない(倍率は 100% のまま)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(200);
  await expect(reset, '有効にしていないのにホイールで図がズームした').toHaveText('100%');
  // 何も無い角からドラッグして回す(節点を開かない)
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(title, 'ドラッグでノートが移った').toHaveText(titleA);
  // ホイールで寄る → 倍率の字が変わる → リセットで戻る
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect(reset).not.toHaveText('100%');
  await clickReal(page, reset);
  await expect(reset).toHaveText('100%');
  // キーボード(フォーカスして + / 0)
  await stage.focus();
  await page.keyboard.press('+');
  await expect(reset).not.toHaveText('100%');
  await page.keyboard.press('0');
  await expect(reset).toHaveText('100%');

  // 🔴 節点の押下で、そのノートへ移る(既存の select-entry)
  const target = await findNode(page, PANE, null);
  const other = target.lid === lidB ? target : await findNode(page, PANE, target.lid);
  expect(other.lid).toBe(lidB);
  await page.mouse.move(other.x, other.y);
  await expect(pane.locator('[data-pkc-field="graph-gpu-hover"]')).toBeVisible();
  await expect(pane.locator('[data-pkc-field="graph-gpu-hover"]')).toContainText('つながり');
  await page.mouse.click(other.x, other.y);
  await expect(title, '節点を押してもノートが移らない').toHaveText(titleB);
  // 選んだノートが変わっても、同じ描画面のまま(GPU を借り直さない)
  await expect(pane.locator('[data-pkc-field="graph-gpu"]')).toHaveCount(1);

  // ④ 通常へ戻す ── GPU の図が外れて DOM の図へ
  await clickReal(page, pane.locator('[data-pkc-graph-mode="dom"]'));
  await expect(pane.locator('[data-pkc-field="graph-gpu"]')).toHaveCount(0);
  await expect(pane.locator('[data-pkc-gpu-canvas]')).toHaveCount(0);
  await expect(pane.locator('[data-pkc-field="graph-map"] [data-pkc-action="select-entry"]')).toHaveCount(2);
  // もう一度 大規模 へ(双方向)
  await clickReal(page, pane.locator('[data-pkc-graph-mode="gpu2d"]'));
  await expect(pane.locator('[data-pkc-field="graph-gpu"]')).toHaveAttribute('data-pkc-graph-gpu-state', /^(ready|fallback)$/, {
    timeout: 20_000,
  });
  await expect(pane.locator('[data-pkc-field="graph-map"]')).toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
