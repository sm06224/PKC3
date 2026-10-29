import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoApp, clickReal, collectPageErrors, expectImageRendered, pickCaptureTool } from './helpers';
import { PROCESS_MENU_LABEL, processToolOf } from '../../src/features/capture/capture-process';
import { STEM_MODELS } from '../../src/features/audio/stem-model';
import { buildIdentityOnnx } from '../helpers/identity-onnx';

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
  expect(ids, '動画の一覧の道具').toEqual(['fold-still', 'contact-sheet', 'denoise', 'separate', 'separate-stems', 'balance', 'chapters', 'speakers']);
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

  // ── ②b #674 / #949 歌声と楽器に分ける:モデルは**公開の配布元(ここでは fixture)から**ブラウザが取り、使い捨てのワーカーで本物の ORT(wasm)が走る
  //    ① 取得できないときは「どこがなぜ駄目か」を言って、何も作らない(2 つの取得元とも huggingface.co)
  const stemHosts = new Set(STEM_MODELS[0]!.urls.map((u) => new URL(u).host));
  expect([...stemHosts], '取得元のホストが想定(1 つ)と違う ── 下の route を直すこと').toEqual(['huggingface.co']);
  await page.route('https://huggingface.co/**', (route) => route.abort('connectionrefused'));
  await pickCaptureTool(page, audioRow, 'separate-stems');
  await expect(statusLine(page), '取得できない理由を言わない').toContainText('歌声と楽器を分けるモデルを取得できませんでした', { timeout: 30_000 });
  await expect(statusLine(page)).toContainText('huggingface.co につながりませんでした');
  await expect(rowOf(page, '声と雑音 (歌声).webm'), '取得できなかったのに添付を作った').toHaveCount(0);
  await page.unroute('https://huggingface.co/**');
  //    ② 取得できたら:ワーカーが本物の ONNX Runtime でモデルを読み、左右 2ch の opus を 2 本作る(恒等写像のモデルなので 歌声 = 元 / 楽器 ≈ 無音)
  const modelBytes = Buffer.from(buildIdentityOnnx([1, 4, STEM_MODELS[0]!.stft.dimF, STEM_MODELS[0]!.stft.dimT], STEM_MODELS[0]!.minBytes + 1_000_000));
  let modelRequests = 0;
  await page.route('https://huggingface.co/**', (route) => {
    modelRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      body: modelBytes,
    });
  });
  await pickCaptureTool(page, audioRow, 'separate-stems');
  await expect(statusLine(page), '歌声と楽器を作ったと言わない').toContainText('歌声と楽器の 2 つの音を作りました', { timeout: 90_000 });
  expect(modelRequests, 'モデルの取得は 1 本だけ').toBe(1);
  const vocal = rowOf(page, '声と雑音 (歌声).webm');
  const rest = rowOf(page, '声と雑音 (楽器).webm');
  await expect(vocal, '歌声の添付が増えない').toHaveCount(1, { timeout: 15_000 });
  await expect(rest, '楽器の添付が増えない').toHaveCount(1, { timeout: 15_000 });
  await expect(audioRow, '元の録音が消えた').toHaveCount(1);
  //    中身:ブラウザで復号し直して、2ch・約 7 秒・歌声は鳴り(元の声)・楽器はほぼ無音であること
  const stats = async (row: ReturnType<typeof rowOf>) => {
    await clickReal(page, row.locator('[data-pkc-field="capture-play"]'));
    const src = await row.locator('audio').first().evaluate((a: HTMLAudioElement) => a.currentSrc || a.src);
    return page.evaluate(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer();
      const ctx = new AudioContext();
      const d = await ctx.decodeAudioData(buf);
      const rms = (c: Float32Array): number => Math.sqrt(c.reduce((s, v) => s + v * v, 0) / c.length);
      const out = { channels: d.numberOfChannels, seconds: d.duration, rmsL: rms(d.getChannelData(0)), rmsR: rms(d.getChannelData(Math.min(1, d.numberOfChannels - 1))) };
      await ctx.close();
      return out;
    }, src);
  };
  const v = await stats(vocal);
  await clickReal(page, vocal.locator('[data-pkc-action="capture-stop"]'));
  const r = await stats(rest);
  await clickReal(page, rest.locator('[data-pkc-action="capture-stop"]'));
  expect(v.channels, '歌声が 2ch でない').toBe(2);
  expect(r.channels).toBe(2);
  expect(v.seconds, '歌声の長さが元(7 秒)と違う').toBeGreaterThan(6.5);
  expect(v.seconds).toBeLessThan(7.6);
  expect(v.rmsL, '歌声が鳴っていない(元の声が出ていない)').toBeGreaterThan(0.005);
  expect(r.rmsL, '楽器に声が残っている(恒等写像なら元 − 歌声 ≈ 0)').toBeLessThan(v.rmsL * 0.2);
  //    取り込んだモデルは端末に残り、設定の「音源分離」から見え、消せる(片道にしない)。次からは取りに行かない
  await expect(statusLine(page), '想定の設定で分けたと言わない').toContainText('想定の設定で分けました。聞いて確かめてください');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const stemSection = page.locator('[data-pkc-region="settings-stem"]');
  await stemSection.scrollIntoViewIfNeeded();
  await expect(stemSection.locator('[data-pkc-field="stem-installed"]'), '取り込んだのに「取り込み済み」が出ない').toContainText('取り込み済み');
  await expect(stemSection.locator('[data-pkc-action="install-stem-model"]')).toBeHidden();
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]').catch(async () => {
    await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="detail"]');
    await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  });
  const rowsBefore = await rows(page).count();
  await pickCaptureTool(page, audioRow, 'separate-stems');
  await expect(statusLine(page).first()).toContainText('歌声と楽器の 2 つの音を作りました', { timeout: 90_000 });
  // ⚠ 添付が一覧に増える(= 段取りが終わって次を受けられる)まで待つ。知らせが先に出て、段取りの門はまだ閉じている
  await expect(rows(page), '2 回目の添付が増えない').toHaveCount(rowsBefore + 2, { timeout: 30_000 });
  expect(modelRequests, '2 回目なのにモデルを取りに行った(端末に残っているはず)').toBe(1);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await stemSection.scrollIntoViewIfNeeded();
  await clickReal(page, stemSection.locator('[data-pkc-action="remove-stem-model"]'));
  await expect(stemSection.locator('[data-pkc-action="install-stem-model"]'), '消したのに取り込むが出ない(片道)').toBeVisible({ timeout: 15_000 });
  await expect(stemSection.locator('[data-pkc-field="stem-installed"]')).toBeHidden();
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]').catch(async () => {
    await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="detail"]');
    await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  });
  await page.unroute('https://huggingface.co/**');

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

  // 取得できない道(②b)で 2 つの取得元が断られた分の console.error だけは、道中の期待どおり(他は 0 件)
  const refused = errors.filter((e) => e.includes('ERR_CONNECTION_REFUSED'));
  expect(refused, '取得できない道で、2 つの取得元を試していない').toHaveLength(STEM_MODELS[0]!.urls.length);
  const others = errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'));
  expect(others, others.join('\n')).toEqual([]);
});
