import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoApp, clickReal, collectPageErrors, expectImageRendered, pickCaptureTool } from './helpers';
import { PROCESS_MENU_LABEL, processToolOf } from '../../src/features/capture/capture-process';

/**
 * 🔴 **録ったものを仕上げる**(#952 A2・A4・A5・B1。着地前レビューの実 Chromium smoke)。
 *
 * unit(happy-dom)が原理的に届かない層:
 * ① **本物の `AudioContext` で復号 → ワーカー(RNNoise の wasm)→ `AudioEncoder`(opus)→ 新しい添付** ── 偽の符号化器では
 *    「本当に鳴らせる webm ができたか」は言えない
 * ② **本物の WebCodecs(VP8 の復号)+ `OffscreenCanvas`(ワーカー)→ PNG** ── 偽の復号器と偽の canvas では「絵が描けたか」は言えない
 * ③ **本物の `<video>` の再生位置**(チャプターの時刻を押す)
 *
 * fixture は自作の短い物(`tests/fixtures/`):
 *  - `media/voice-noisy-7s.webm` ── 合成の声 3 秒 → 無音 1 秒 → 声 3 秒に弱い雑音(opus, 7 秒)
 *  - `vp8/screen-still-motion-still.webm` ── 160x90・15 秒・静止 11 秒 → 動く 1 秒 → 静止 3 秒(VP8, 1.5 秒ごとにキーフレーム)
 *
 * 🔑 新しい起動を増やさない ── 1 本の道中(取り込む → 一覧の「仕上げ ▾」から順に使う)に assert を積む。
 */
const AUDIO = readFileSync('tests/fixtures/media/voice-noisy-7s.webm');
const VIDEO = readFileSync('tests/fixtures/vp8/screen-still-motion-still.webm');

const rows = (page: Page) => page.locator('[data-pkc-capture]');
const rowOf = (page: Page, name: string) => page.locator(`[data-pkc-capture]:has([data-pkc-field="capture-name"]:text-is("${name}"))`);
const statusLine = (page: Page) => page.locator('[data-pkc-region="status"]');

test('🔴 仕上げ ▾ から:雑音を減らす → 新しい音の添付 / コンタクトシート → PNG の img / チャプター → 本文に追記・時刻で再生位置へ / 静止区間をまとめる', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  await gotoApp(page);
  const filerRows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await page.setInputFiles('[data-pkc-field="attach-input"]', { name: '声と雑音.webm', mimeType: 'audio/webm', buffer: AUDIO });
  // ⚠ 1 件ずつ取り込めたことを観測してから次を渡す(待ちを伸ばしても直らない)
  await expect(filerRows, '前提: 音が取り込めていない').toHaveCount(1, { timeout: 15_000 });
  await page.setInputFiles('[data-pkc-field="attach-input"]', { name: '画面.webm', mimeType: 'video/webm', buffer: VIDEO });
  await expect(filerRows, '前提: 動画が取り込めていない').toHaveCount(2, { timeout: 15_000 });
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  await expect(rows(page), '前提: 取り込んだ音と動画の 2 行が一覧に無い').toHaveCount(2, { timeout: 15_000 });

  const audioRow = rowOf(page, '声と雑音.webm');
  const videoRow = rowOf(page, '画面.webm');

  // ── ① 行には「仕上げ ▾」を 1 つだけ置く(道具を並べない)。押すと表のとおりの一覧(塊つき)が出る
  for (const row of [audioRow, videoRow]) {
    await expect(row.locator('[data-pkc-action="open-capture-process"]'), '「仕上げ ▾」が 1 つでない').toHaveCount(1);
    await expect(row.locator('[data-pkc-action="open-capture-process"]')).toHaveText(PROCESS_MENU_LABEL);
    await expect(row.locator('[data-pkc-action="capture-process"]'), '道具のボタンが行に並んでいる').toHaveCount(0);
  }
  await clickReal(page, videoRow.locator('[data-pkc-action="open-capture-process"]'));
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu).toBeVisible();
  const ids = await menu.locator('[data-pkc-action="capture-process"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-pkc-part')));
  expect(ids, '動画の一覧の道具').toEqual(['fold-still', 'contact-sheet', 'denoise', 'separate', 'balance', 'chapters', 'speakers']);
  expect(await menu.locator('[data-pkc-action="capture-process"]').first().textContent()).toBe(processToolOf('fold-still')!.label);
  await expect(menu.locator('[data-pkc-group]'), '塊(映像 / 音を作る / ノートに書く)で切れていない').toHaveCount(3);
  // 一覧の外を押すと閉じる(片道にしない)
  await page.keyboard.press('Escape');
  await expect(menu, 'Escape で一覧が閉じない').toBeHidden();

  // ── ② B1 雑音を減らす:本物の復号 → ワーカー → opus → 新しい添付(元は残る)
  await pickCaptureTool(page, audioRow, 'denoise');
  await expect(statusLine(page), '雑音を減らした音を作ったと言わない').toContainText('雑音を減らした音を作りました', { timeout: 60_000 });
  const denoised = rowOf(page, '声と雑音 (雑音を減らした).webm');
  await expect(denoised, '新しい添付が一覧に増えない').toHaveCount(1, { timeout: 15_000 });
  await expect(audioRow, '元の録音が消えた').toHaveCount(1);
  // 本当に鳴らせる webm か:新しい音を聞く(<audio> が読み込め、長さが元と同じ 7 秒前後)
  await clickReal(page, denoised.locator('[data-pkc-field="capture-play"]'));
  const audio = denoised.locator('audio').first();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { message: '新しい音が読み込めない(壊れた webm)' }).toBeGreaterThanOrEqual(1);
  const seconds = await audio.evaluate((a: HTMLAudioElement) => a.duration);
  expect(seconds, '新しい音の長さが元(7 秒)と違う').toBeGreaterThan(6.5);
  expect(seconds).toBeLessThan(7.6);
  await clickReal(page, denoised.locator('[data-pkc-action="capture-stop"]'));

  // ── ③ A5 コンタクトシート:WebCodecs の復号 + OffscreenCanvas → PNG の添付(画像として描ける)
  await pickCaptureTool(page, videoRow, 'contact-sheet');
  await expect(statusLine(page), 'コンタクトシートを作ったと言わない').toContainText('場面のコンタクトシートを作りました', { timeout: 60_000 });
  await clickReal(page, '[data-pkc-browse="filer"]');
  const sheetRow = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]:has-text("画面 (コンタクトシート).png")');
  await expect(sheetRow, 'コンタクトシートの添付が一覧に無い').toHaveCount(1, { timeout: 15_000 });
  await clickReal(page, sheetRow);
  await expectImageRendered(page, '[data-pkc-region="detail"] img[data-pkc-field="attachment-media"]');
  const size = await page.locator('[data-pkc-region="detail"] img[data-pkc-field="attachment-media"]').first().evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
  // 2 場面(0 秒と 11 秒)→ 2 列。幅 = 余白 16 x 2 + 絵 320 x 2 + 隙間 12
  expect(size[0], 'コンタクトシートの幅が割り付けと違う(2 場面 = 2 列)').toBe(16 * 2 + 320 * 2 + 12);
  expect(size[1], 'コンタクトシートの高さが 0').toBeGreaterThan(100);
  // 灰色だけの絵ではない(実際に映像の絵が描かれている):画素に 2 色以上ある
  const colors = await page.locator('[data-pkc-region="detail"] img[data-pkc-field="attachment-media"]').first().evaluate(async (i: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = i.naturalWidth;
    c.height = i.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(i, 0, 0);
    const seen = new Set<string>();
    const d = g.getImageData(0, 0, c.width, c.height).data;
    for (let k = 0; k < d.length; k += 4 * 97) seen.add(`${d[k]},${d[k + 1]},${d[k + 2]}`);
    return seen.size;
  });
  expect(colors, 'コンタクトシートが単色(絵が描かれていない)').toBeGreaterThan(4);

  // ── ④ A4 チャプター:本文に追記され、時刻を押すと再生位置が動く
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  await pickCaptureTool(page, videoRow, 'chapters');
  await expect(statusLine(page), 'チャプターを足したと言わない').toContainText('件のチャプターを足しました', { timeout: 30_000 });
  await clickReal(page, videoRow.locator('[data-pkc-field="capture-name"]'));
  const body = page.locator('[data-pkc-view-pane="detail"]');
  await expect(body, '本文の末尾にチャプターの見出しが足されていない').toContainText(/チャプター \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await expect(body).toContainText('0:00 チャプター 1');
  await expect(body).toContainText('0:11 チャプター 2');
  const player = body.locator('video[data-pkc-field="attachment-media"]');
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { message: '動画が読み込めない' }).toBeGreaterThanOrEqual(1);
  const link = body.locator('[data-pkc-action="seek-media"][data-pkc-seek-ms="11000"]');
  await expect(link, '行頭の 0:11 が押せる字になっていない').toHaveText('0:11');
  expect(await player.evaluate((v: HTMLVideoElement) => v.currentTime), '前提: 再生位置が先頭に居ない').toBeLessThan(1);
  await clickReal(page, link);
  await expect
    .poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5000, message: '時刻を押しても再生位置が 11 秒へ動かない' })
    .toBeGreaterThanOrEqual(10.5);

  // ── ⑤ A2 静止区間をまとめる:新しい動画(小さい・長さは同じ・再生できる)
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  await pickCaptureTool(page, videoRow, 'fold-still');
  await expect(statusLine(page), '静止区間をまとめたと言わない').toContainText('をまとめました', { timeout: 30_000 });
  const folded = rowOf(page, '画面 (静止区間をまとめた).webm');
  await expect(folded, '新しい動画が一覧に増えない').toHaveCount(1, { timeout: 15_000 });
  await clickReal(page, folded.locator('[data-pkc-field="capture-play"]'));
  const foldedVideo = folded.locator('video').first();
  await expect.poll(() => foldedVideo.evaluate((v: HTMLVideoElement) => v.readyState), { message: 'まとめた動画が読み込めない' }).toBeGreaterThanOrEqual(1);
  const dur = await foldedVideo.evaluate((v: HTMLVideoElement) => v.duration);
  expect(dur, 'まとめたのに長さが変わった').toBeGreaterThan(14);
  expect(dur).toBeLessThan(16);

  expect(errors, errors.join('\n')).toEqual([]);
});
