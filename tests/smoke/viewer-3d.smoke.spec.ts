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

/** 対照群の小さな静的グラフ(今までどおり PNG の <img>)。 */
const STATIC_CHART = '```chart\n{"type":"bar","labels":["1月","2月"],"datasets":[{"label":"売上","data":[10,20]}]}\n```\n';

/** 🔴 縦横を固定した静的グラフ(v4.2 PR-1)。 */
const SIZED_CHART = '```chart width=320 height=180\n{"type":"line","labels":["1月","2月"],"datasets":[{"label":"件数","data":[3,5]}]}\n```\n';

/** 1 万点の対話グラフ(v4.1 PR-7)。 */
const LIVE_CHART = [
  '```chart live',
  JSON.stringify({
    type: 'line',
    title: 'センサー',
    height: 300,
    datasets: [{ label: '温度', data: Array.from({ length: 10_000 }, (_, i) => Math.round(Math.sin(i / 300) * 1000 + (i % 97)) / 10) }],
  }),
  '```',
].join('\n');

/** 50 × 50 のヒートマップ。 */
const HEATMAP = ['```chart', JSON.stringify({ type: 'heatmap', matrix: Array.from({ length: 50 }, (_, r) => Array.from({ length: 50 }, (_, c) => r * c)) }), '```'].join('\n');

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
  // 🔴 v4.2 PR-1: 縦横を固定した静的グラフも同じノートに置く(起動を増やさない)
  await writeNote(page, 'ふつうのメモ', '# メモ\n\n- 箇条書き\n\n```json\n{"objects":[]}\n```\n\n' + STATIC_CHART + '\n' + SIZED_CHART);
  await page.waitForTimeout(1000);
  expect(reqs.map((r) => r.url()).filter((u) => THREE_CHUNK.test(u)), '3D の無いノートで Three.js / ローダーを読んだ').toEqual([]);
  expect(await page.locator('[data-pkc-3d-viewer]').count()).toBe(0);
  // 🔑 対照群(v4.1 PR-7): 小さな静的 ```chart は今までどおり PNG の <img>(GPU の器を作らず、Three.js も読まない)
  await expect(page.locator('[data-pkc-field="detail-body"] [data-pkc-chart-src] img')).toHaveCount(2, { timeout: 15_000 });
  // 🔴 縦横の固定(v4.2 PR-1)── ```chart width=320 height=180 は 320 × 180 で描く(対照群は本文の幅に合わせた既定の大きさ)
  const sizedImg = page.locator('[data-pkc-field="detail-body"] [data-pkc-chart-src][data-pkc-fixed-width] img');
  await expect(sizedImg).toHaveCount(1);
  await expect.poll(async () => Math.round((await sizedImg.boundingBox())?.width ?? 0)).toBe(320);
  await expect.poll(async () => Math.round((await sizedImg.boundingBox())?.height ?? 0)).toBe(180);
  const plainImg = page.locator('[data-pkc-field="detail-body"] [data-pkc-chart-src]:not([data-pkc-fixed-width]) img');
  expect(Math.round((await plainImg.boundingBox())!.width), '対照群まで 320px になった').not.toBe(320);
  expect(await page.locator('[data-pkc-field="detail-body"] [data-pkc-gpu-chart-src]').count()).toBe(0);
  expect(reqs.map((r) => r.url()).filter((u) => THREE_CHUNK.test(u)), '静的なグラフで Three.js を読んだ').toEqual([]);

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

  // ⑥ 🔴 大量データの対話グラフ(v4.1 PR-7、#2095)── 1 万点の ```chart live とヒートマップを、長いノートの途中に置く。
  //    描画面が空でない・拡大 / 縮小 / 全体表示 / PNG で保存が動く・ただのホイールはノートを送る・Ctrl + ホイールは図だけ
  await writeNote(page, '大量データ', `${filler}\n\n${LIVE_CHART}\n\n${HEATMAP}\n\n${filler}\n`);
  const gHosts = page.locator('[data-pkc-field="detail-body"] [data-pkc-gpu-chart-src]');
  await expect(gHosts).toHaveCount(2);
  const gHost = gHosts.first();
  await gHost.scrollIntoViewIfNeeded();
  await expect(gHost).toHaveAttribute('data-pkc-gpu-chart-state', 'ready', { timeout: 15_000 });
  const chart = gHost.locator('[data-pkc-gpu-chart]');
  await expect(chart).toHaveAttribute('data-pkc-gpu-chart-backend', /^(webgpu|webgl2|2d)$/, { timeout: 30_000 });
  await expect(chart.locator('[data-pkc-gpu-chart-info="points"]')).toHaveText(/^10,000 点/);
  const gStage = chart.locator('[data-pkc-gpu-chart-stage]');
  await expect(gStage).toHaveCSS('height', '300px');
  await page.waitForTimeout(500);
  const gb = (await gStage.boundingBox())!;
  const gClip = { x: gb.x + 2, y: gb.y + 2, width: gb.width - 4, height: gb.height - 4 };
  const gPx = await pixels(page, gClip);
  // 空でない: 地の色と違う画素が十分ある(線・軸・目盛り)
  const bg = gPx.slice(0, 3);
  const nonBg = gPx.reduce((n, _v, i) => (i % 3 === 0 && Math.abs(gPx[i]! - bg[0]!) + Math.abs(gPx[i + 1]! - bg[1]!) + Math.abs(gPx[i + 2]! - bg[2]!) >= 24 ? n + 1 : n), 0);
  expect(nonBg, '対話グラフの描画面が空').toBeGreaterThan(400);
  // 拡大で絵が変わり、全体表示で戻る
  await clickReal(page, chart.locator('[data-pkc-gpu-chart-op="zoom-in"]'));
  await expect.poll(async () => changed(gPx, await pixels(page, gClip)), { message: '拡大で絵が変わらない' }).toBeGreaterThan(200);
  await clickReal(page, chart.locator('[data-pkc-gpu-chart-op="zoom-out"]'));
  await clickReal(page, chart.locator('[data-pkc-gpu-chart-op="reset"]'));
  // ドラッグで移動(拡大してから)
  await clickReal(page, chart.locator('[data-pkc-gpu-chart-op="zoom-in"]'));
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + 120, gb.y + gb.height / 2, { steps: 4 });
  await page.mouse.up();
  await clickReal(page, chart.locator('[data-pkc-gpu-chart-op="reset"]'));
  // PNG で保存
  const dl = page.waitForEvent('download');
  await clickReal(page, chart.locator('[data-pkc-gpu-chart-op="save"]'));
  // ⚠ ファイル名は観測点にしない ── この headless Chromium は非 ASCII の `<a download>` 名を丸ごと捨てる
  //   (mermaid.smoke と同じ)。名前の規則は unit(`tests/adapter/gpu-chart.test.ts`)が見る。中身が PNG であることを見る
  const png: Buffer[] = [];
  for await (const c of await (await dl).createReadStream()) png.push(c as Buffer);
  const pngBytes = Buffer.concat(png);
  expect(pngBytes.subarray(1, 4).toString('latin1'), 'PNG ではない').toBe('PNG');
  expect(pngBytes.length, 'PNG が小さすぎる(空の絵)').toBeGreaterThan(5_000);
  // ホバーで値が出る
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.move(gb.x + gb.width / 2 + 3, gb.y + gb.height / 2);
  // スクロールの取り合い 0: ただのホイールはノートを送る
  const gt0 = await top();
  await page.mouse.wheel(0, 300);
  await expect.poll(top, { message: '対話グラフの上のホイールでノートが送られない' }).toBeGreaterThan(gt0);
  // Ctrl + ホイールは図だけ(ノートは送られない)
  await gStage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const gb2 = (await gStage.boundingBox())!;
  const gClip2 = { x: gb2.x + 2, y: gb2.y + 2, width: gb2.width - 4, height: gb2.height - 4 };
  await page.mouse.move(gb2.x + gb2.width / 2, gb2.y + gb2.height / 2);
  const gBefore = await pixels(page, gClip2);
  const gt1 = await top();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -500);
  await page.keyboard.up('Control');
  await expect.poll(async () => changed(gBefore, await pixels(page, gClip2)), { message: 'Ctrl + ホイールでグラフが変わらない' }).toBeGreaterThan(200);
  expect(Math.abs((await top()) - gt1), 'Ctrl + ホイールでノートが送られた').toBeLessThan(2);
  // ヒートマップも描ける
  const hHost = gHosts.nth(1);
  await hHost.scrollIntoViewIfNeeded();
  await expect(hHost).toHaveAttribute('data-pkc-gpu-chart-state', 'ready', { timeout: 15_000 });
  await expect(hHost.locator('[data-pkc-gpu-chart]')).toHaveAttribute('data-pkc-gpu-chart-backend', /^(webgpu|webgl2|2d)$/, { timeout: 30_000 });
  await expect(hHost.locator('[data-pkc-gpu-chart-info="points"]')).toHaveText('2,500 点');

  // ⚠ ⑦ を足して 30 秒を超えた ── 起動の予算(1 本 = 1 起動)を増やさないため、同じ 1 本の中で時間だけを延ばす
  //   (`attach.smoke.spec.ts` の `test.setTimeout(120_000)` と同じ前例)
  test.setTimeout(90_000);
  // ⑦ 🔴 スクロール連動(v4.1 PR-8、#2095 中盤)── 見出し 3 節(各節に別の数の表)と "bind": "heading" のグラフ。
  //    読み進めると連動先とデータが切り替わる / 固定中は切り替わらず、追従に戻すと今の節へ揃う / 上端に固定 ⇄ 解除
  const section = (name: string, col: string, vals: number[]): string =>
    [`## ${name}`, '', `| 月 | ${col} |`, '|---|---:|', ...vals.map((v, i) => `| ${i + 1}月 | ${v} |`), '', filler].join('\n');
  const boundBody = [
    '```chart live',
    '{"type":"bar","title":"四半期","bind":"heading","height":220}',
    '```',
    '',
    section('Q1', '売上', [10, 40, 20]),
    section('Q2', '来客数', [5, 9, 30]),
    section('Q3', '返品', [7, 3, 1]),
  ].join('\n\n');
  await writeNote(page, '連動グラフ', boundBody);
  const bHost = page.locator('[data-pkc-field="detail-body"] [data-pkc-gpu-chart-src]').first();
  await expect(bHost).toHaveAttribute('data-pkc-gpu-chart-state', 'ready', { timeout: 15_000 });
  await expect(bHost).toHaveAttribute('data-pkc-gpu-chart-bind', 'heading');
  const bChart = bHost.locator('[data-pkc-gpu-chart]');
  await expect(bChart).toHaveAttribute('data-pkc-gpu-chart-backend', /^(webgpu|webgl2|2d)$/, { timeout: 30_000 });
  const bLabel = bChart.locator('[data-pkc-field="gpu-chart-bind-label"]');
  const bStage = bChart.locator('[data-pkc-gpu-chart-stage]');
  await expect(bLabel).toHaveText('連動: Q1 (1 / 3)');
  await expect(bStage).toHaveAttribute('aria-label', /売上/);
  // 上端に固定(既定)── 本文の根の直下の塊(器を包む塊)が sticky
  const stuck = page.locator('[data-pkc-field="detail-body"] > .pkc-gpu-chart-sticky');
  await expect(stuck).toHaveCount(1);
  await expect(stuck.locator('[data-pkc-gpu-chart-src]')).toHaveCount(1);
  await expect(stuck).toHaveCSS('position', 'sticky');
  /**
   * 🔴 縮小 ⇄ 実サイズ(v4.2 PR-1)── 上端に固定した連動グラフは縮小した絵(見た目 140px)で見せ、実描画(220px)は縮めない。
   *   押すと実サイズ → Esc で縮小に戻す。⚠ 修正を外すと(縦を押し潰す `max-height: 32vh` に戻すと)ここが落ちる。
   */
  const bViewport = bChart.locator('[data-pkc-field="gpu-chart-viewport"]');
  await expect(bChart).toHaveAttribute('data-pkc-gpu-chart-compact', 'true');
  await expect.poll(async () => Math.round((await bViewport.boundingBox())?.height ?? 0)).toBe(140);
  expect(await bStage.evaluate((el) => el.clientHeight), '実描画の高さが縮んだ').toBe(220);
  const cBox = (await bStage.boundingBox())!;
  const cWid = await bStage.evaluate((el) => el.clientWidth);
  expect(Math.abs(cBox.height - 140), '縮小した見た目の高さ').toBeLessThan(3);
  expect(Math.abs(cBox.width - (cWid * 140) / 220), '縦横比が崩れた').toBeLessThan(4);
  await expect(bChart.locator('[data-pkc-field="gpu-chart-compact-hint"]')).toBeVisible();
  await expect(bChart.locator('[data-pkc-field="gpu-chart-bar"]')).toBeHidden();
  await clickReal(page, bViewport);
  await expect(bChart).toHaveAttribute('data-pkc-gpu-chart-compact', 'false');
  await expect.poll(async () => Math.round((await bStage.boundingBox())?.height ?? 0)).toBe(220);
  await expect(bViewport).toHaveAttribute('aria-expanded', 'true');
  await expect(bChart.locator('[data-pkc-field="gpu-chart-expand"]')).toHaveText('縮小に戻す');
  await page.keyboard.press('Escape');
  await expect(bChart).toHaveAttribute('data-pkc-gpu-chart-compact', 'true');
  await expect.poll(async () => Math.round((await bViewport.boundingBox())?.height ?? 0)).toBe(140);
  const heads = page.locator('[data-pkc-field="detail-body"] h2');
  await expect(heads).toHaveCount(3);
  const readTo = async (i: number): Promise<void> => {
    await heads.nth(i).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  };
  await page.waitForTimeout(400);
  const bb0 = (await bStage.boundingBox())!;
  const bClip = { x: bb0.x + 2, y: bb0.y + 2, width: bb0.width - 4, height: bb0.height - 4 };
  const q1Px = await pixels(page, bClip);
  // 下の節へ読み進める → Q2 のデータへ(グラフは上端に残って見えている)
  await readTo(1);
  await expect(bLabel).toHaveText('連動: Q2 (2 / 3)', { timeout: 5_000 });
  await expect(bStage).toHaveAttribute('aria-label', /来客数/);
  const sb2 = (await bStage.boundingBox())!;
  const rb = (await scroller.boundingBox())!;
  expect(sb2.y, '上端に固定したグラフが画面の外へ流れた').toBeGreaterThanOrEqual(rb.y - 1);
  expect(sb2.y, '上端に固定したグラフが画面の外へ流れた').toBeLessThan(rb.y + rb.height / 2);
  await page.waitForTimeout(500);
  const sb2b = (await bStage.boundingBox())!;
  const q2Clip = { x: sb2b.x + 2, y: sb2b.y + 2, width: sb2b.width - 4, height: sb2b.height - 4 };
  await expect.poll(async () => changed(q1Px, await pixels(page, q2Clip)), { message: '節が変わってもグラフの絵が変わらない' }).toBeGreaterThan(50);
  // 固定 → 別の節へ → 切り替わらない
  const follow = bChart.locator('[data-pkc-field="gpu-chart-follow"]');
  await clickReal(page, follow);
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await expect(follow).toHaveText('固定中');
  await readTo(2);
  await page.waitForTimeout(600);
  await expect(bLabel).toHaveText('連動: Q2 (2 / 3)');
  await expect(bStage).toHaveAttribute('aria-label', /来客数/);
  // 追従に戻す → 今読んでいる節(Q3)へ
  await clickReal(page, follow);
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await expect(bLabel).toHaveText('連動: Q3 (3 / 3)', { timeout: 5_000 });
  await expect(bStage).toHaveAttribute('aria-label', /返品/);
  // 上端に固定 ⇄ 固定を解除(双方向)
  const stick = bChart.locator('[data-pkc-field="gpu-chart-sticky"]');
  await expect(stick).toHaveAttribute('aria-pressed', 'true');
  await clickReal(page, stick);
  await expect(stick).toHaveAttribute('aria-pressed', 'false');
  await expect(stuck).toHaveCount(0);
  const slotBlock = page.locator('[data-pkc-field="detail-body"] > *').filter({ has: page.locator('[data-pkc-gpu-chart-src]') });
  await expect(slotBlock).toHaveCount(1);
  await expect(slotBlock).not.toHaveCSS('position', 'sticky');
  // 流れる配置では、読み進めた先でグラフは画面の外にある
  await expect.poll(async () => (await bStage.boundingBox())!.y).toBeLessThan(rb.y - 50);
  await clickReal(page, stick);
  await expect(stick).toHaveAttribute('aria-pressed', 'true');
  await expect(stuck).toHaveCSS('position', 'sticky');
  // 前へ: 追従中は本文もその見出しへ動き、グラフは Q2 に(⚠ 固定の押し直しで本文が動いたので、Q3 まで読み直してから)
  await readTo(2);
  await expect(bLabel).toHaveText('連動: Q3 (3 / 3)', { timeout: 5_000 });
  await clickReal(page, bChart.locator('[data-pkc-gpu-chart-op="bind-prev"]'));
  await expect(bLabel).toHaveText('連動: Q2 (2 / 3)', { timeout: 5_000 });
  // 🔴 縮小中の移動先(v4.2 PR-1)── 見出しは縮小した固定の塊のすぐ下に来る(実描画の高さぶん下へずれない)
  await expect(bChart).toHaveAttribute('data-pkc-gpu-chart-compact', 'true');
  await expect
    .poll(
      async () => {
        const h = (await heads.nth(1).boundingBox())!;
        const st = (await stuck.boundingBox())!;
        return Math.round(h.y - (st.y + st.height));
      },
      { message: '見出しが縮小した固定の塊のすぐ下に来ない', timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(-2);
  {
    const h = (await heads.nth(1).boundingBox())!;
    const st = (await stuck.boundingBox())!;
    expect(h.y - (st.y + st.height), '見出しが固定の塊から離れすぎ').toBeLessThan(40);
  }

  // ⑧ 🔴 別ウィンドウ(v4.1 PR-9、#2095 後半)── 「別ウィンドウで開く」で noopener の窓が開き、グラフだけの軽い起動で描く。
  //    メインウィンドウを読み進めると別ウィンドウも切り替わる / 別ウィンドウだけ固定中 → 解除で最新へ / 別ウィンドウの次へで本文が動く
  //    ⚠ 起動の予算を増やさない: 窓はクリック起点で開く(`.goto(` ではない)
  test.setTimeout(150_000);
  // ⚠ 直前の「前へ」の滑らかなスクロールが終わってから、本文の先頭へ戻す(途中で割り込むと行き先が取り合いになる)
  await page.waitForTimeout(900);
  const toTop = async (): Promise<void> => {
    await scroller.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
  };
  await toTop();
  await expect(bLabel).toHaveText('連動: Q1 (1 / 3)', { timeout: 5_000 });
  // 🔑 縮小中は上の行(別ウィンドウで開く を含む)を隠している ── 実サイズで表示してから押す(v4.2 PR-1)
  await clickReal(page, bChart.locator('[data-pkc-field="gpu-chart-expand"]'));
  await expect(bChart).toHaveAttribute('data-pkc-gpu-chart-compact', 'false');
  const nextPage = page.context().waitForEvent('page');
  await clickReal(page, bChart.locator('[data-pkc-field="gpu-chart-popout"]'));
  const pop = await nextPage;
  const popErrors = collectPageErrors(pop);
  expect(pop.url()).toMatch(/#pkc\?chart=[A-Za-z0-9_-]{8,64}$/);
  const pRoot = pop.locator('[data-pkc-region="chart-popout"]');
  await expect(pRoot).toBeAttached({ timeout: 15_000 });
  // 通常の起動をしていない(枠もサイドバーも作らない)
  await expect(pop.locator('[data-pkc-region="shell"]')).toHaveCount(0);
  const pChart = pop.locator('[data-pkc-region="chart-popout-stage"] [data-pkc-gpu-chart]');
  await expect(pChart).toHaveAttribute('data-pkc-gpu-chart-backend', /^(webgpu|webgl2|2d)$/, { timeout: 30_000 });
  const pLabel = pop.locator('[data-pkc-field="chart-popout-bind"]');
  const pStage = pChart.locator('[data-pkc-gpu-chart-stage]');
  await expect(pLabel).toHaveText('連動: Q1 (1 / 3)', { timeout: 10_000 });
  await expect(pStage).toHaveAttribute('aria-label', /売上/);
  await expect(pop).toHaveTitle(/^四半期 - .*連動グラフ.* \| PKC3$/);
  // 描画域は窓いっぱい(本文用の 220px の高さに縛られない)
  await expect.poll(async () => (await pStage.boundingBox())?.height ?? 0).toBeGreaterThan(260);
  // メインウィンドウで読み進める → 別ウィンドウも切り替わる
  await readTo(1);
  await expect(pLabel).toHaveText('連動: Q2 (2 / 3)', { timeout: 5_000 });
  await expect(pStage).toHaveAttribute('aria-label', /来客数/);
  await readTo(2);
  await expect(pLabel).toHaveText('連動: Q3 (3 / 3)', { timeout: 5_000 });
  await expect(pStage).toHaveAttribute('aria-label', /返品/);
  // 別ウィンドウだけ固定中 → メインを読み戻しても別ウィンドウは Q3 のまま
  const pFollow = pop.locator('[data-pkc-field="chart-popout-follow"]');
  // ⚠ 窓を行き来するときは前に出す(裏の窓は描画・見張りが間引かれる ── 実の利用でも読む窓が前にある)
  await pop.bringToFront();
  await clickReal(pop, pFollow);
  await expect(pFollow).toHaveText('固定中');
  await expect(pFollow).toHaveAttribute('aria-pressed', 'true');
  await page.bringToFront();
  await toTop();
  await expect(bLabel).toHaveText('連動: Q1 (1 / 3)', { timeout: 5_000 });
  await pop.waitForTimeout(600);
  await expect(pLabel).toHaveText('連動: Q3 (3 / 3)');
  await expect(pStage).toHaveAttribute('aria-label', /返品/);
  // 解除 → メインで今読んでいる節(Q1)へ追従
  await pop.bringToFront();
  await clickReal(pop, pFollow);
  await expect(pFollow).toHaveText('追従 ON');
  await expect(pLabel).toHaveText('連動: Q1 (1 / 3)', { timeout: 5_000 });
  await expect(pStage).toHaveAttribute('aria-label', /売上/);
  // 別ウィンドウの「次へ」→ メインの本文が Q2 へ動く(双方向)
  await clickReal(pop, pop.locator('[data-pkc-field="chart-popout-next"]'));
  await expect(pLabel).toHaveText('連動: Q2 (2 / 3)', { timeout: 5_000 });
  await page.bringToFront();
  await expect(bLabel).toHaveText('連動: Q2 (2 / 3)', { timeout: 5_000 });
  // 閉じる ── メインウィンドウにエラーが出ない
  await pop.close({ runBeforeUnload: true });
  await page.waitForTimeout(400);
  expect(popErrors, popErrors.join('\n')).toEqual([]);

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
