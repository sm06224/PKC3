/**
 * 🔴 **輪郭の近接発光(ネオン)**(B2)── ログのカード・情報ペインのカード・左端のバーのボタンの輪郭が、
 * ポインタの近くだけ**本当に光る**かを実ブラウザで見る(1 起動)。
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 近いカードにだけ印(`data-pkc-glow-near`)が付き、半径の外のカードには付かない。離れる・ゾーンを出ると消える | 実マウスの `pointerover` / `pointerleave` の順序と rAF |
 * | 🔴 **画素**: 近くの輪郭(上の辺)の画素が静止のときと変わり(光っている)、**内側の地の画素は 1 つも変わらない** | `mask-composite: exclude` が内側を抜くかは描いて初めて分かる |
 * | 🔴 スクロールしてもポインタが止まっていれば、光の位置(`--gy`)が追いつく(`pointermove` 無し) | スクロールの `scroll` → rAF の連携 |
 * | 🔴 畳み(DOM の変化)の後も、動かさずに古い矩形で光り続けない | MutationObserver → 次のコマ |
 * | 🔴 動きを減らす設定 / スマホの幅では、動かしても印が一度も付かない | 環境の問い(`matchMedia`)と版面 |
 * | 人が目で見る明暗のスクリーンショット(`PKC3_SHOT_DIR` があれば DPR 2・1440×900 で保存) | 人が見る物 |
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce } from './helpers';

test.use({ deviceScaleFactor: 2 });

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';
const NEAR = '[data-pkc-glow-near]';
/** どのゾーンでもない所(左のペインの一覧の上。バーは x < 40)。 */
const OUT_X = 150;
const OUT_Y = 450;

/** 横にあふれる表とコード(`overflow: auto` の器 = 疑似要素が切られる塊)。 */
const WIDE_TABLE = [
  `| ${Array.from({ length: 16 }, (_, i) => `列${i + 1}ほげほげほげ`).join(' | ')} |`,
  `| ${Array.from({ length: 16 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 16 }, (_, i) => `値${i + 1}ふがふがふが`).join(' | ')} |`,
].join('\n');
const WIDE_CODE = `const wide = '${'0123456789'.repeat(30)}';`;

const FIXTURE = [
  ...Array.from({ length: 14 }, (_, i) => [
    `## 2026-10-${String(1 + Math.floor(i / 3)).padStart(2, '0')} ${String(8 + (i % 3) * 3).padStart(2, '0')}:00:00`,
    `記録${i + 1}の本文です。作業の経過をここに書きます。`,
    ...(i === 0 ? [WIDE_TABLE, `\`\`\`ts\n${WIDE_CODE}\n\`\`\``] : []),
  ]).flat(),
].join('\n\n');

async function openLog(page: Page): Promise<void> {
  await createEntry(page, 'textlog');
  await page.fill('[data-pkc-field="editor-body"]', FIXTURE);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${BODY} > [data-pkc-log-card]`).first()).toBeAttached();
}

/** clip の画素(RGB)を、実ブラウザの canvas で読む(スクリーンショット → デコード)。 */
async function pixels(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number[]> {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const g = cv.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const out: number[] = [];
    for (let i = 0; i < d.length; i += 4) out.push(d[i]!, d[i + 1]!, d[i + 2]!);
    return out;
  }, png.toString('base64'));
}
/** 2 つの画素列の「違う画素の数」(1 チャンネルでも 24 以上違えば違うと数える)。 */
const changed = (a: number[], b: number[]): number => {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) >= 24) n += 1;
  }
  return n;
};

const rectOf = (page: Page, sel: string, nth = 0): Promise<{ x: number; y: number; width: number; height: number }> =>
  page.locator(sel).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

async function scroller(page: Page): Promise<void> {
  await page.evaluate((s) => {
    let e = document.querySelector(s) as HTMLElement | null;
    while (e && e.scrollHeight <= e.clientHeight + 2) e = e.parentElement;
    e?.setAttribute('data-neon-scroller', '');
  }, BODY);
}

test('🔴 ネオン: 近いカードの輪郭だけが光り、内側の地は光らない / スクロール・畳みに追従 / 動きを減らす・スマホ幅では付かない (B2)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await openLog(page);
  await scroller(page);
  await page.evaluate(() => {
    (document.querySelector('[data-neon-scroller]') as HTMLElement).scrollTop = 0;
  });

  const cardSel = `${BODY} > h2[data-pkc-log-card="first"], ${BODY} > h2[data-pkc-log-card="solo"]`;
  await page.mouse.move(OUT_X, OUT_Y); // ゾーンの外(左のペインの一覧の上)
  await expect(page.locator(NEAR), '入る前から光っている').toHaveCount(0);

  // ① 静止の画素(ポインタがゾーンの外)── 2 つ目の記録の上の辺と、同じカードの内側の地
  const target = await rectOf(page, cardSel, 1);
  const ringClip = { x: target.x + 100, y: target.y - 3, width: 240, height: 8 };
  const groundClip = { x: target.x + target.width - 250, y: target.y + 10, width: 200, height: 8 };
  const ringRest = await pixels(page, ringClip);
  const groundRest = await pixels(page, groundClip);

  // ② 上の辺のすぐ内側へ入れる(実マウス)── 印が付き、近いカードだけ
  const px = target.x + 200;
  const py = target.y + 2;
  await page.mouse.move(px - 40, py + 30);
  await page.mouse.move(px, py);
  await expect.poll(() => page.locator(NEAR).count(), { message: '近づけても光らない' }).toBeGreaterThan(0);
  const probe = await page.evaluate(
    ([x, y]) => {
      const all = [...document.querySelectorAll('[data-pkc-log-days] > [data-pkc-log-card]')] as HTMLElement[];
      const R = 160;
      const dist = (el: HTMLElement): number => {
        const r = el.getBoundingClientRect();
        const dx = Math.max(r.left - x!, 0, x! - r.right);
        const dy = Math.max(r.top - y!, 0, y! - r.bottom);
        return Math.hypot(dx, dy);
      };
      const near = all.filter((e) => e.hasAttribute('data-pkc-glow-near'));
      const far = all.filter((e) => !e.hasAttribute('data-pkc-glow-near') && e.getBoundingClientRect().height > 0);
      return {
        nearMax: Math.max(...near.map(dist)),
        farMin: Math.min(...far.map(dist)),
        farCount: far.length,
        R,
        gx: near.map((e) => e.style.getPropertyValue('--gx')),
      };
    },
    [px, py] as const,
  );
  expect(probe.nearMax, '半径(160px)の外のカードに印が付いた').toBeLessThanOrEqual(probe.R);
  expect(probe.farMin, '半径の内のカードに印が付いていない').toBeGreaterThan(probe.R - 1);
  expect(probe.farCount, '全部のカードが光っている(絞れていない)').toBeGreaterThan(0);
  expect(probe.gx.every((v) => /^-?\d+px$/.test(v)), `局所座標が px でない: ${probe.gx.join(',')}`).toBe(true);

  // ③ 🔴 画素: 輪郭は変わり(光った)、内側の地は 1 画素も変わらない
  await page.waitForTimeout(150);
  const ringLit = await pixels(page, ringClip);
  const groundLit = await pixels(page, groundClip);
  expect(changed(ringRest, ringLit), '輪郭の画素が静止のときと同じ(光っていない)').toBeGreaterThan(ringClip.width * 2 * 0.5);
  expect(changed(groundRest, groundLit), '内側の地まで光った / 変わった').toBe(0);

  // ④ 🔴 スクロール: ポインタを止めたまま画面を送ると、光の位置(--gy)がそのコマで追いつく(pointermove 無し)
  const gyOf = (): Promise<{ gy: number; top: number }[]> =>
    page.evaluate((y) => {
      return ([...document.querySelectorAll('[data-pkc-glow-near]')] as HTMLElement[]).map((e) => ({
        gy: parseFloat(e.style.getPropertyValue('--gy')),
        top: y - e.getBoundingClientRect().top,
      }));
    }, py);
  await page.evaluate(() => {
    (document.querySelector('[data-neon-scroller]') as HTMLElement).scrollTop += 70;
  });
  await expect
    .poll(async () => {
      const v = await gyOf();
      return v.length > 0 && v.every((x) => Math.abs(x.gy - x.top) <= 1);
    }, { message: 'スクロールしても光の位置が追いつかない(ずれたまま)' })
    .toBe(true);

  // ⑤ 🔴 畳み(DOM の変化)── 動かさずに、畳んだ記録の中身が光ったまま残らない
  const hiddenBefore = await page.evaluate(() => ([...document.querySelectorAll('[data-pkc-glow-near]')] as HTMLElement[]).filter((e) => e.getBoundingClientRect().height === 0).length);
  expect(hiddenBefore).toBe(0);
  await page.evaluate(() => {
    const near = document.querySelector('h2[data-pkc-glow-near] [data-pkc-field="heading-fold"]') as HTMLElement | null;
    near?.click(); // `click()` はポインタを動かさない
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            ([...document.querySelectorAll('[data-pkc-glow-near]')] as HTMLElement[]).filter((e) => e.getBoundingClientRect().height === 0 || e.hidden).length,
        ),
      { message: '畳んで見えなくなったカードが光ったまま(古い矩形)' },
    )
    .toBe(0);

  // ⑤b 🔴 横スクロールの器(表・コード)の輪郭も切れ目なく光る(疑似要素は overflow に切られるので、器自身の背景で描く)
  for (const kind of ['table', 'pre']) {
    await page.evaluate(() => {
      (document.querySelector('[data-neon-scroller]') as HTMLElement).scrollTop = 0;
    });
    const blk = page.locator(`${BODY} > .pkc-md-block[data-pkc-log-card]`).filter({ has: page.locator(kind) }).first();
    await blk.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.mouse.move(OUT_X, OUT_Y);
    await expect(page.locator(NEAR)).toHaveCount(0);
    const bb = await blk.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    expect(bb.h, `${kind} の器が小さすぎる(検査の前提)`).toBeGreaterThan(30);
    // 左の辺の 3px 幅の縦の帯(輪郭 2px + 内側 1px)を、器の高さ全体(上下 14px の角を除く)で読む
    const edge = { x: bb.x, y: bb.y + 14, width: 3, height: bb.h - 28 };
    const inner = { x: bb.x + 6, y: bb.y + 14, width: 6, height: bb.h - 28 };
    const restE = await pixels(page, edge);
    const restI = await pixels(page, inner);
    // 左の辺のすぐ内側へ(器の縦の真ん中)
    await page.mouse.move(bb.x + 60, bb.y + bb.h / 2 - 40);
    await page.mouse.move(bb.x + 4, bb.y + bb.h / 2);
    await expect.poll(() => blk.evaluate((el) => el.hasAttribute('data-pkc-glow-near')), { message: `${kind} の器が光らない` }).toBe(true);
    await page.waitForTimeout(150);
    const litE = await pixels(page, edge);
    const litI = await pixels(page, inner);
    const rows = (bb.h - 28) * 2; // DPR 2
    expect(changed(restE, litE), `${kind} の器の左の輪郭が切れ目なく光っていない(疑似要素が切られている)`).toBeGreaterThan(rows * 0.9);
    expect(changed(restI, litI), `${kind} の器の内側の地まで変わった`).toBe(0);
    // 右の辺も(ポインタを右へ寄せる)
    const edgeR = { x: bb.x + bb.w - 3, y: bb.y + 14, width: 3, height: bb.h - 28 };
    const restR = await pixels(page, edgeR);
    await page.mouse.move(bb.x + bb.w - 40, bb.y + bb.h / 2);
    await page.mouse.move(bb.x + bb.w - 4, bb.y + bb.h / 2);
    await page.waitForTimeout(150);
    expect(changed(restR, await pixels(page, edgeR)), `${kind} の器の右の輪郭が光らない`).toBeGreaterThan(rows * 0.9);
    // 横スクロールしても輪郭は器に張り付いたまま(背景は動かない)
    await blk.evaluate((el) => {
      el.scrollLeft = 200;
    });
    await page.waitForTimeout(100);
    expect(changed(restR, await pixels(page, edgeR)), `${kind}: 横スクロールで輪郭が消えた`).toBeGreaterThan(rows * 0.9);
    await page.mouse.move(OUT_X, OUT_Y);
  }

  // ⑥ 離れる: ゾーンの外へ出ると全部消え、座標の変数も残らない
  await page.mouse.move(OUT_X, OUT_Y);
  await expect(page.locator(NEAR), '出ても光が残る').toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll('[data-pkc-log-days] > [style*="--gx"]').length), '座標が残った').toBe(0);

  // ⑦ 情報ペインのカードも同じ仕組みで光る
  const insp = page.locator('[data-pkc-region="inspector"] > [data-pkc-card]');
  const ib = await insp.nth(1).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width };
  });
  await page.mouse.move(ib.x + ib.w / 2, ib.y - 20);
  await page.mouse.move(ib.x + ib.w / 2, ib.y + 3);
  await expect.poll(() => page.locator(`[data-pkc-region="inspector"] > [data-pkc-card]${NEAR}`).count(), { message: '情報ペインのカードが光らない' }).toBeGreaterThan(0);

  // ⑧ 左端のバーのボタンも(局所座標が付く)
  const rb = await page.locator('[data-pkc-region="rail"] button').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(rb.x + rb.w / 2, rb.y + rb.h / 2 + 30);
  await page.mouse.move(rb.x + rb.w / 2, rb.y + rb.h / 2);
  await expect.poll(() => page.locator(`[data-pkc-region="rail"] button${NEAR}`).count(), { message: 'バーのボタンが光らない' }).toBeGreaterThan(0);
  expect(await page.locator(`[data-pkc-region="inspector"] ${NEAR}`).count(), 'ゾーンを出た情報ペインの光が残った').toBe(0);

  // 人が見る明暗のスクリーンショット(PKC3_SHOT_DIR があれば)
  const dir = process.env.PKC3_SHOT_DIR;
  if (dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/neon-rail.png`, clip: { x: 0, y: 0, width: 200, height: 300 } });
  }

  // ⑨ 🔴 動きを減らす設定: 動かしても印が一度も付かない(リスナーごと外れる)
  await page.mouse.move(OUT_X, OUT_Y);
  await expect(page.locator(NEAR)).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const t2 = await rectOf(page, cardSel, 3);
  for (let i = 0; i < 6; i += 1) await page.mouse.move(t2.x + 100 + i * 20, t2.y + 3 + (i % 2));
  await page.waitForTimeout(150);
  await expect(page.locator(NEAR), '動きを減らす設定なのに光った').toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // 戻すと付く(環境の変化に追従する)
  await page.mouse.move(OUT_X, OUT_Y);
  const t3 = await rectOf(page, cardSel, 3);
  await page.mouse.move(t3.x + 100, t3.y + 30);
  await page.mouse.move(t3.x + 120, t3.y + 3);
  await expect.poll(() => page.locator(NEAR).count(), { message: '動きを減らす設定を戻しても光らない' }).toBeGreaterThan(0);

  // ⑩ 🔴 スマホの幅: 動かしても印が付かない
  await page.mouse.move(OUT_X, OUT_Y);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('[data-pkc-region="shell"]')).toHaveAttribute('data-pkc-layout', 'phone');
  await expect(page.locator(NEAR)).toHaveCount(0);
  const body = await page.locator(`${BODY} > [data-pkc-log-card]`).first().boundingBox();
  if (body !== null) {
    for (let i = 0; i < 6; i += 1) await page.mouse.move(body.x + 40 + i * 10, body.y + 4 + (i % 2));
    await page.waitForTimeout(150);
  }
  await expect(page.locator(NEAR), 'スマホの幅で光った').toHaveCount(0);
  expect(errors, `console / page error: ${errors.join(' | ')}`).toEqual([]);
});
