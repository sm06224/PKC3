import { test, expect, type Page, type Request } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

/**
 * 🔴 3D ビューア(v4.0 Phase 3 / PR-12、ビジョン 1-B)── 実ブラウザで確かめる 4 つ。
 *
 * ① 3D を含まないノートを開いても、Three.js とローダーの chunk を 1 つも取りに行かない(定常コスト 0)
 * ② ` ```3d ` の図が遅延で読み込まれて描かれ(WebGPU / WebGL2 / 2D 簡易表示のどれか)、
 *    視点をリセット・ワイヤーフレーム・グリッド・ドラッグ・`-norender` / `-both` の切替が例外 0 で動く
 * ③ バイナリ STL の添付にインラインの 3D ビューアが出て、別のノートへ移ると確実に外れる
 * ④ 外部 URL を書いた ` ```3d ` は、ネットワークの要求を 1 件も出さずに理由を出す
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

test('🔴 3D を含まないノートでは Three.js を 1 バイトも取りに行かない', async ({ page }) => {
  const errors = collectPageErrors(page);
  const reqs = watchRequests(page);
  await gotoApp(page);
  await writeNote(page, 'ふつうのメモ', '# メモ\n\n- 箇条書き\n\n```json\n{"objects":[]}\n```\n');
  await page.waitForTimeout(1500);
  const three = reqs.map((r) => r.url()).filter((u) => THREE_CHUNK.test(u));
  expect(three, '3D の無いノートで Three.js / ローダーを読んだ').toEqual([]);
  expect(await page.locator('[data-pkc-3d-viewer]').count()).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('🔴 ```3d の図: 遅延で読み込んで描き、操作と切替が例外 0 で動く', async ({ page }) => {
  const errors = collectPageErrors(page);
  const reqs = watchRequests(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await writeNote(page, '3D の図', SCENE);

  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-3d-src]').first();
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
  const wire = viewer.locator('[data-pkc-3d-op="grid"]');
  await clickReal(page, wire);
  await expect(wire).toHaveAttribute('aria-pressed', 'false');
  await clickReal(page, wire);
  await expect(wire).toHaveAttribute('aria-pressed', 'true');
  if (kind !== '2d') {
    const wf = viewer.locator('[data-pkc-3d-op="wireframe"]');
    await clickReal(page, wf);
    await expect(wf).toHaveAttribute('aria-pressed', 'true');
  }
  await clickReal(page, viewer.locator('[data-pkc-3d-op="reset"]'));
  await page.waitForTimeout(300);

  // -both の切替: 原文の面へ切り替えると原文が見える(ビューアは残る ── 戻せば同じ物)
  const toggle = page.locator('[data-pkc-field="detail-body"] .pkc-render-toggle').first();
  await clickReal(page, toggle);
  await expect(page.locator('[data-pkc-field="detail-body"] .pkc-render-source').first()).toBeVisible();
  await clickReal(page, toggle);
  await expect(viewer).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('```3d-norender は描かずに原文だけ・-render は切替なしで描く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await writeNote(
    page,
    '書き分け',
    '```3d-norender\n{"objects":[{"type":"box"}]}\n```\n\n```3d-render\n{"objects":[{"type":"cone"}]}\n```\n',
  );
  const body = page.locator('[data-pkc-field="detail-body"]');
  await expect(body.locator('[data-pkc-3d-src]')).toHaveCount(1);
  await expect(body.locator('[data-pkc-3d-src]')).toHaveAttribute('data-pkc-3d-state', 'ready');
  await expect(body.locator('code', { hasText: '"box"' })).toBeVisible();
  await expect(body.locator('[data-pkc-render-mode="render"] .pkc-render-toggle')).toHaveCount(0);
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

test('🔴 外部 URL を書いた ```3d は、要求を 1 件も出さずに理由を出す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  const appOrigin = new URL(page.url()).origin;
  const reqs = watchRequests(page);
  await writeNote(
    page,
    '外部の参照',
    '```3d\n{"model":"https://example.com/evil.glb"}\n```\n\n```3d\n{"model":"//cdn.example.com/a.stl","objects":[{"type":"box"}]}\n```\n',
  );
  const hosts = page.locator('[data-pkc-field="detail-body"] [data-pkc-3d-src]');
  await expect(hosts).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(hosts.nth(i)).toHaveAttribute('data-pkc-3d-state', 'failed');
    await expect(hosts.nth(i)).toHaveAttribute('data-pkc-3d-error', /外部の URL/);
  }
  await page.waitForTimeout(1000);
  const outside = reqs.map((r) => r.url()).filter((u) => /^https?:/.test(u) && !u.startsWith(appOrigin));
  expect(outside, '外へ取りに行った').toEqual([]);
  expect(reqs.some((r) => THREE_CHUNK.test(r.url())), '断った図のために Three.js を読んだ').toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});
