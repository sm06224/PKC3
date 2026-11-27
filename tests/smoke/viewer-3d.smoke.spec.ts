import { test, expect, type Page, type Request } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, pixels, changed } from './helpers';

/**
 * 🔴 3D ビューア(v4.0 Phase 3 / PR-12、ビジョン 1-B)── 実ブラウザで確かめる 4 つ。
 *
 * ① 3D を含まないノートを開いても、Three.js とローダーの chunk を 1 つも取りに行かない(定常コスト 0)
 * ② 外部 URL を書いた ` ```3d ` は、ネットワークの要求を 1 件も出さずに理由を出す
 * ③ ` ```3d ` の図が遅延で読み込まれて描かれ(WebGPU / WebGL2 / 2D 簡易表示のどれか)、
 *    視点をリセット・ワイヤーフレーム・グリッド・ドラッグ・`-norender` / `-render` / `-both` の切替が例外 0 で動く
 * ④ バイナリ STL の添付にインラインの 3D ビューアが出て、別のノートへ移ると確実に外れる
 * 🔑 起動は 2 つ(①〜③ の道中 1 本 + 何も開いていない状態から添付する ④)── `smoke-budget`。
 *
 * ⚠ 観測点は「何を取りに行ったか」(`request`)と「何が DOM に在るか」── 描けたかどうかは
 *   描画方式の印(`data-pkc-3d-backend`)と描画面の要素(canvas / ポスター / 2D 退避)で見る。
 */

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/** Three.js とローダーの chunk の名前(vite の出力の名前は `three.core-…js` など)。 */
const THREE_CHUNK = /\/assets\/(?:three[.-]|GLTFLoader|STLLoader|OBJLoader)[^/]*\.js(?:\?|$)/;

function watchRequests(page: Page): Request[] {
  const all: Request[] = [];
  page.on('request', (r) => all.push(r));
  return all;
}

async function writeNote(page: Page, title: string, body: string): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.locator('[data-pkc-field="editor-body"]').fill(body);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-title"]').first()).toHaveText(title, { timeout: 15_000 });
}

/** 最小のバイナリ STL(四面体 = 三角形 4 枚)。 */
function tetraStl(): Buffer {
  const v = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const;
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ] as const;
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => {
    const o = 84 + i * 50;
    let p = o + 12; // 法線は 0 のまま(ローダーが補う)
    for (const idx of f) for (const c of v[idx]!) {
      buf.writeFloatLE(c, p);
      p += 4;
    }
  });
  return buf;
}

const SCENE = [
  '# 3D の図',
  '',
  '```3d',
  '{ "objects": [',
  '    { "type": "box", "position": [0, 0.5, 0], "color": "#4a90d9", "label": "土台" },',
  '    { "type": "sphere", "position": [0, 1.6, 0], "size": 0.8, "color": "#e0a030" },',
  '    { "type": "torus", "position": [1.5, 0.3, 0] }',
  '  ], "height": 320 }',
  '```',
  '',
].join('\n');

/**
 * 🔴 起動は 1 つ(`smoke-budget`)── 3D の無いノート → 外部 URL を書いた図 → 3D の図、の順に 1 本の道中で見る。
 * ⚠ 順番が要である: 前の 2 つでは Three.js を 1 度も取りに行っていないことを、**取りに行く前**に確かめる。
 */
test('🔴 ```3d: 3D の無いノート・外部 URL では Three.js を読まず、図は遅延で読んで描き、操作と切替が例外 0 で動く', async ({ page }) => {
  const errors = collectPageErrors(page);
  const reqs = watchRequests(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  const appOrigin = new URL(page.url()).origin;

  // ① 3D を含まないノート ── Three.js もローダーも取りに行かない
  await writeNote(page, 'ふつうのメモ', '# メモ\n\n- 箇条書き\n\n```json\n{"objects":[]}\n```\n');
  await page.waitForTimeout(1000);
  expect(reqs.map((r) => r.url()).filter((u) => THREE_CHUNK.test(u)), '3D の無いノートで Three.js / ローダーを読んだ').toEqual([]);
  expect(await page.locator('[data-pkc-3d-viewer]').count()).toBe(0);

  // ② 外部 URL を書いた図 ── 要求を 1 件も出さずに理由を出す(Three.js も読まない)
  await writeNote(
    page,
    '外部の参照',
    '```3d\n{"model":"https://example.com/evil.glb"}\n```\n\n```3d\n{"model":"//cdn.example.com/a.stl","objects":[{"type":"box"}]}\n```\n',
  );
  const bad = page.locator('[data-pkc-field="detail-body"] [data-pkc-3d-src]');
  await expect(bad).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(bad.nth(i)).toHaveAttribute('data-pkc-3d-state', 'failed');
    await expect(bad.nth(i)).toHaveAttribute('data-pkc-3d-error', /外部の URL/);
  }
  await page.waitForTimeout(1000);
  expect(reqs.map((r) => r.url()).filter((u) => /^https?:/.test(u) && !u.startsWith(appOrigin)), '外へ取りに行った').toEqual([]);
  expect(reqs.some((r) => THREE_CHUNK.test(r.url())), '断った図のために Three.js を読んだ').toBe(false);

  // ③ 3D の図(と、書き分けの -norender / -render)
  await writeNote(
    page,
    '3D の図',
    SCENE + '\n```3d-norender\n{"objects":[{"type":"box","note":"norender"}]}\n```\n\n```3d-render\n{"objects":[{"type":"cone"}]}\n```\n',
  );
  const hosts = page.locator('[data-pkc-field="detail-body"] [data-pkc-3d-src]');
  // -norender は器を作らない(原文のコードだけ)── 器は 2 つ
  await expect(hosts).toHaveCount(2);
  await expect(page.locator('[data-pkc-field="detail-body"] code', { hasText: '"norender"' })).toBeVisible();
  await expect(page.locator('[data-pkc-field="detail-body"] [data-pkc-render-mode="render"] .pkc-render-toggle')).toHaveCount(0);
  await expect(hosts.nth(1)).toHaveAttribute('data-pkc-3d-state', 'ready');

  const host = hosts.first();
  await expect(host).toHaveAttribute('data-pkc-3d-state', 'ready', { timeout: 15_000 });
  const viewer = host.locator('[data-pkc-3d-viewer]');
  await viewer.scrollIntoViewIfNeeded();
  // 描画方式が決まる(WebGPU / WebGL2 / 2D 簡易表示のどれか)
  const backend = viewer.locator('[data-pkc-3d-info="backend"][data-pkc-3d-backend]');
  await expect(backend).toHaveAttribute('data-pkc-3d-backend', /^(webgpu|webgl2|2d)$/, { timeout: 30_000 });
  const kind = await backend.getAttribute('data-pkc-3d-backend');
  const stage = viewer.locator('[data-pkc-3d-stage]');
  if (kind === '2d') {
    await expect(stage.locator('[data-pkc-3d-canvas2d]')).toHaveCount(1);
    await expect(viewer.locator('[data-pkc-3d-note]')).toBeVisible();
  } else {
    // GPU の描画面が置かれ、Three.js は遅延で読まれた
    await expect(stage.locator('canvas[data-pkc-gpu-canvas]')).toHaveCount(1);
    expect(reqs.some((r) => THREE_CHUNK.test(r.url())), 'Three.js を読んでいない').toBe(true);
  }
  await expect(viewer.locator('[data-pkc-3d-info="format"]')).toHaveText('3D シーン');
  await expect(viewer.locator('[data-pkc-3d-info="size"]')).toHaveText('オブジェクト 3 個');
  await expect(stage).toHaveCSS('height', '320px');

  // ドラッグで回す・ホイール・キー
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, 200);
  await stage.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('0');

  // 切替
  const grid = viewer.locator('[data-pkc-3d-op="grid"]');
  await clickReal(page, grid);
  await expect(grid).toHaveAttribute('aria-pressed', 'false');
  await clickReal(page, grid);
  await expect(grid).toHaveAttribute('aria-pressed', 'true');
  if (kind !== '2d') {
    const wf = viewer.locator('[data-pkc-3d-op="wireframe"]');
    await clickReal(page, wf);
    await expect(wf).toHaveAttribute('aria-pressed', 'true');
  }
  await clickReal(page, viewer.locator('[data-pkc-3d-op="reset"]'));
  await page.waitForTimeout(300);

  // -both の切替: 原文の面へ切り替えると原文が見え、戻せばビューアが見える
  const toggle = page.locator('[data-pkc-field="detail-body"] .pkc-render-toggle').first();
  await clickReal(page, toggle);
  await expect(page.locator('[data-pkc-field="detail-body"] .pkc-render-source').first()).toBeVisible();
  await clickReal(page, toggle);
  await expect(viewer).toBeVisible();

  // ⑤ 🔴 スクロールの取り合い 0: 長いノートの途中にある 3D の上でただのホイールを回すと、ノートが送られる
  //    (図は奪わない)。Ctrl + ホイールは図のズーム(ノートは送られない)。ツールバーの 拡大 で高さが大きく変わる
  const filler = Array.from({ length: 40 }, (_, i) => `${i} 行目の段落です。`).join('\n\n');
  await writeNote(page, '長い 3D', `${filler}\n\n${SCENE}\n\n${filler}\n`);
  const longHost = page.locator('[data-pkc-field="detail-body"] [data-pkc-3d-src]').first();
  await expect(longHost).toHaveAttribute('data-pkc-3d-state', 'ready', { timeout: 15_000 });
  const longViewer = longHost.locator('[data-pkc-3d-viewer]');
  await longViewer.scrollIntoViewIfNeeded();
  await expect(longViewer.locator('[data-pkc-3d-info="backend"][data-pkc-3d-backend]')).toHaveAttribute('data-pkc-3d-backend', /^(webgpu|webgl2|2d)$/, { timeout: 30_000 });
  // V-6: 言語バッジは JSON ではなく 3D
  const badges = await page.locator('[data-pkc-field="detail-body"] .pkc-code-lang').allTextContents();
  expect(badges.filter((t) => /json/i.test(t)), '3d の囲みに JSON のバッジが出ている').toEqual([]);
  const scroller = page.locator('[data-pkc-region="detail"]');
  const top = async (): Promise<number> => scroller.evaluate((el) => el.scrollTop);
  const longStage = longViewer.locator('[data-pkc-3d-stage]');
  const sb = (await longStage.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  const t0 = await top();
  await page.mouse.wheel(0, 400);
  await expect.poll(top, { message: '3D の上のホイールでノートが送られない(スクロールを奪っている)' }).toBeGreaterThan(t0);
  // Ctrl + ホイール = 図のズーム(画素が変わる)。ノートは送られない
  await longStage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const cb = (await longStage.boundingBox())!;
  const clip = { x: cb.x + 4, y: cb.y + 4, width: Math.max(8, cb.width - 8), height: Math.max(8, cb.height - 8) };
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  const before = await pixels(page, clip);
  const t1 = await top();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -500);
  await page.keyboard.up('Control');
  await expect
    .poll(async () => changed(before, await pixels(page, clip)), { message: 'Ctrl + ホイールで図が変わらない' })
    .toBeGreaterThan(50);
  expect(Math.abs((await top()) - t1), 'Ctrl + ホイールでノートが送られた').toBeLessThan(2);
  // クリックで有効 → 枠が出る → Esc で抜ける
  await clickReal(page, longStage);
  await expect(longStage).toHaveAttribute('data-pkc-3d-active', '');
  await page.keyboard.press('Escape');
  await expect(longStage).not.toHaveAttribute('data-pkc-3d-active', '');
  // 拡大: 高さが大きくなり、もう一度で戻る
  const h0 = (await longStage.boundingBox())!.height;
  await clickReal(page, longViewer.locator('[data-pkc-3d-op="expand"]'));
  await expect(longViewer.locator('[data-pkc-3d-op="expand"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await longStage.boundingBox())!.height).toBeGreaterThan(h0 + 150);
  await clickReal(page, longViewer.locator('[data-pkc-3d-op="expand"]'));
  await expect.poll(async () => Math.round((await longStage.boundingBox())!.height)).toBe(Math.round(h0));

  expect(errors, errors.join('\n')).toEqual([]);
});

test('🔴 STL の添付にインラインの 3D ビューアが出て、別のノートへ移ると外れる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '四面体.stl',
    mimeType: 'application/octet-stream',
    buffer: tetraStl(),
  });
  const viewer = page.locator('[data-pkc-region="detail"] [data-pkc-field="attachment-3d"]');
  await expect(viewer).toBeVisible({ timeout: 15_000 });
  await expect(viewer.locator('[data-pkc-3d-info="format"]')).toHaveText('STL');
  const backend = viewer.locator('[data-pkc-3d-info="backend"][data-pkc-3d-backend]');
  await expect(backend).toHaveAttribute('data-pkc-3d-backend', /^(webgpu|webgl2|2d)$/, { timeout: 30_000 });
  if ((await backend.getAttribute('data-pkc-3d-backend')) !== '2d') {
    await expect(viewer.locator('[data-pkc-3d-info="size"]')).toHaveText('寸法 1 × 1 × 1');
    await expect(viewer.locator('canvas[data-pkc-gpu-canvas]')).toHaveCount(1);
  }
  // 保存の導線は残る(片道の操作を作らない)
  await expect(page.locator('[data-pkc-region="detail"] [data-pkc-action="download-asset"]').first()).toBeVisible();

  // 別のノートへ移ると、ビューアも描画面も外れる
  await writeNote(page, '別のノート', '# 別\n');
  await expect(page.locator('[data-pkc-3d-viewer]')).toHaveCount(0);
  await expect(page.locator('canvas[data-pkc-gpu-canvas]')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
