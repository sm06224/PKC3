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
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce, pixels, changed } from './helpers';

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
    ...(i === 1 ? ['補足の段落です。数字の突き合わせは明日にまわす。'] : []),
    ...(i === 0 ? [WIDE_TABLE, `\`\`\`ts\n${WIDE_CODE}\n\`\`\``, ':::details{summary="折りたたみの見出し" open}\n折りたたみの中身\n:::'] : []),
  ]).flat(),
].join('\n\n');

async function openLog(page: Page): Promise<void> {
  await createEntry(page, 'textlog');
  await page.fill('[data-pkc-field="editor-body"]', FIXTURE);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${BODY} > [data-pkc-log-card]`).first()).toBeAttached();
}

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
  // 同じカードの中の、ブロックとブロックの境目(2 つ目の記録の 1 つ目の塊と 2 つ目の塊の間)── カードの内側は光らない
  const seamY = await page
    .locator(cardSel)
    .nth(1)
    .evaluate((h) => {
      const second = h.nextElementSibling?.nextElementSibling as HTMLElement | null;
      if (second === null || second === undefined) return -1;
      return second.getAttribute('data-pkc-log-card') === 'first' || second.tagName === 'H2' ? -1 : second.getBoundingClientRect().top;
    });
  expect(seamY, '検査の前提: 2 つ目の記録が 2 つ以上の塊を持つ').toBeGreaterThan(0);
  const seamClip = { x: target.x + 12, y: seamY - 5, width: target.width - 24, height: 10 };
  const seamRest = await pixels(page, seamClip);
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
      // ⚠ 画面に出ていない(送る器の外へ切られている)カードは候補でない(IntersectionObserver で絞る)── 数えない
      const sc = document.querySelector('[data-neon-scroller]')?.getBoundingClientRect();
      const visible = (e: HTMLElement): boolean => {
        const r = e.getBoundingClientRect();
        return r.height > 0 && (sc === undefined || (r.bottom > sc.top && r.top < sc.bottom)) && r.bottom > 0 && r.top < innerHeight;
      };
      const far = all.filter((e) => !e.hasAttribute('data-pkc-glow-near') && visible(e));
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
  // 🔴 カードの中のブロックの境目(途中の塊の上下)に、線もにじみも出ない(出るのは外周だけ)
  expect(changed(seamRest, await pixels(page, seamClip)), 'カードの中のブロックの境目に光の線が出た').toBe(0);

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

  // ⑤c 🔴 折りたたみ(`:::details`)の輪郭は、他の塊と同じカードの縁(±1px)に出る(内側の余白 `--card-pad` のぶん内へ寄らない)
  {
    await page.evaluate(() => {
      (document.querySelector('[data-neon-scroller]') as HTMLElement).scrollTop = 0;
    });
    const det = page.locator(`${BODY} > details.pkc-details[data-pkc-log-card]`).first();
    await det.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.mouse.move(OUT_X, OUT_Y);
    await expect(page.locator(NEAR)).toHaveCount(0);
    const d = await det.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, h: r.height };
    });
    // カードの縁 = 同じ記録の見出し(先頭の塊)の左端
    const cardX = await page.locator(`${BODY} > h2[data-pkc-log-card="first"]`).first().evaluate((el) => el.getBoundingClientRect().x);
    expect(Math.abs(cardX - d.x), '検査の前提: 折りたたみの箱の左端がカードの縁').toBeLessThanOrEqual(1);
    expect(d.h).toBeGreaterThan(30);
    const edge = { x: d.x - 2, y: d.y + 10, width: 6, height: d.h - 20 };
    const inside = { x: d.x + 8, y: d.y + 10, width: 24, height: d.h - 20 };
    const restE = await pixels(page, edge);
    const restI = await pixels(page, inside);
    await page.mouse.move(d.x + 60, d.y + d.h / 2 - 30);
    await page.mouse.move(d.x + 4, d.y + d.h / 2);
    await expect.poll(() => det.evaluate((el) => el.hasAttribute('data-pkc-glow-near')), { message: '折りたたみの塊が光らない' }).toBe(true);
    await page.waitForTimeout(150);
    expect(changed(restE, await pixels(page, edge)), '折りたたみの輪郭がカードの縁(±1px)に出ていない').toBeGreaterThan((d.h - 20) * 2 * 0.8);
    expect(changed(restI, await pixels(page, inside)), '折りたたみの輪郭が内側の余白のぶん内へ寄っている(カードの縁から 8px 以上内側が変わった)').toBe(0);
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 PR-2: 本文のブロック(コード・表・図・引用・折りたたみ)・入力欄の近接発光 / キーボードのフォーカスの静止線
// ─────────────────────────────────────────────────────────────────────────────

const NOTE_BODY = [
  '# 近接発光の確認',
  '段落です。'.repeat(6),
  WIDE_TABLE,
  '```ts\nconst answer = 42;\nfunction f(x: number): number {\n  return x * answer;\n}\n```',
  '```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```',
  '> 引用の段落です。',
  ':::details{summary="折りたたみの見出し" open}\n折りたたみの中身です。\n:::',
].join('\n\n');

type Box = { x: number; y: number; w: number; h: number };
/** 画面の真ん中へ送って(⚠ `behavior: 'instant'` ── 本文は `scroll-behavior: smooth` で、送っている最中に撮ると静止の画素がずれる)矩形を返す。 */
const boxOf = (page: Page, sel: string): Promise<Box> =>
  page.locator(sel).first().evaluate(async (el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

/** 近づけて(遠くから 2 段で)印が付くまで待ち、描画が落ち着くのを待つ。 */
async function hoverNear(page: Page, sel: string, x: number, y: number): Promise<void> {
  await page.mouse.move(x + 40, y + 24);
  await page.mouse.move(x, y);
  await expect.poll(() => page.locator(sel).first().evaluate((el) => el.hasAttribute('data-pkc-glow-near')), { message: `${sel} が光らない` }).toBe(true);
  await page.waitForTimeout(150);
}

/** 縁の帯の画素が、光で変わったか(静止 → 近づけた)。`inner` は内側の地: 1 画素も変わらない。 */
async function expectEdgeGlows(
  page: Page,
  name: string,
  sel: string,
  pick: (b: Box) => { pointer: { x: number; y: number }; edge: { x: number; y: number; width: number; height: number }; inner: { x: number; y: number; width: number; height: number }; minChanged: number },
): Promise<void> {
  await page.mouse.move(OUT_X, OUT_Y);
  await expect(page.locator(NEAR), `${name}: ポインタを外しても光が残る`).toHaveCount(0);
  const b = await boxOf(page, sel);
  const p = pick(b);
  const restE = await pixels(page, p.edge);
  const restI = await pixels(page, p.inner);
  await hoverNear(page, sel, p.pointer.x, p.pointer.y);
  const litE = await pixels(page, p.edge);
  const litI = await pixels(page, p.inner);
  expect(changed(restE, litE), `${name}: 縁の画素が静止のときと同じ(光っていない)`).toBeGreaterThanOrEqual(p.minChanged);
  expect(changed(restI, litI), `${name}: 内側の地まで変わった`).toBe(0);
  const dir = process.env.PKC3_SHOT_DIR;
  if (dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    const clip = { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24), width: Math.min(b.w + 48, 520), height: Math.min(b.h + 48, 320) };
    await page.screenshot({ path: `${dir}/neon-${name}-${currentTheme}.png`, clip });
  }
  await page.mouse.move(OUT_X, OUT_Y);
}
let currentTheme = 'light';

test('🔴 ネオン(本文のブロック・入力欄): コード・表・図・引用・折りたたみ・入力欄の縁が光り、内側は変わらない / スクロールする表の縁も (Stage 2 PR-2)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('近接発光');
  await page.fill('[data-pkc-field="editor-body"]', NOTE_BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${BODY} [data-pkc-mermaid-src]`)).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30_000 });
  await page.mouse.move(OUT_X, OUT_Y);

  const CODE = `${BODY} .pkc-md-block[data-pkc-md-block-kind="code"]:not([data-pkc-render-lang])`;
  const TABLE = `${BODY} .pkc-md-block[data-pkc-md-block-kind="table"]`;
  const CARD = `${BODY} .pkc-md-block[data-pkc-render-lang="mermaid"]`;
  const QUOTE = `${BODY} blockquote`;
  const DETAILS = `${BODY} .pkc-details`;

  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-pkc-theme', 'dark');
        document.documentElement.setAttribute('data-pkc-tone', 'dark');
      });
      // 配色の切り替えで地の色に 0.15s の transition が掛かる ── 落ち着いてから静止の画素を撮る(撮った後に動くと「内側が変わった」に見える)
      await page.waitForTimeout(700);
    }
    currentTheme = theme;

    // ① コード: 左の縁(枠のすぐ内側 2px)が光る。包み(`.pkc-md-block`)の疑似要素 ── 内側の地(字の無い右側)は変わらない
    await expectEdgeGlows(page, 'code', CODE, (b) => ({
      pointer: { x: b.x + 4, y: b.y + b.h / 2 },
      edge: { x: b.x, y: b.y + 6, width: 3, height: b.h - 12 },
      inner: { x: b.x + b.w - 260, y: b.y + 8, width: 180, height: b.h - 16 },
      minChanged: (b.h - 12) * 2 * 0.8,
    }));

    // ② 表(横スクロールの器): 器自身の背景で描く。器の外側(透明な 2px の枠)の左の縁が切れ目なく光る
    await expectEdgeGlows(page, 'table', TABLE, (b) => ({
      pointer: { x: b.x + 1, y: b.y + b.h / 2 },
      edge: { x: b.x, y: b.y + 6, width: 2, height: b.h - 12 },
      inner: { x: b.x + 8, y: b.y + 6, width: 40, height: b.h - 12 },
      minChanged: (b.h - 12) * 2 * 0.8,
    }));

    // ③ 図のカード: ヘアラインの角丸カード全体の縁(左)が光る
    await expectEdgeGlows(page, 'diagram', CARD, (b) => ({
      pointer: { x: b.x + 4, y: b.y + b.h / 2 },
      edge: { x: b.x, y: b.y + 20, width: 3, height: b.h - 40 },
      inner: { x: b.x + b.w - 90, y: b.y + b.h - 50, width: 60, height: 30 },
      minChanged: (b.h - 40) * 2 * 0.8,
    }));

    // ④ 引用: 左の線(3px)だけ光る。字は変わらない
    await expectEdgeGlows(page, 'quote', QUOTE, (b) => ({
      pointer: { x: b.x + 1, y: b.y + b.h / 2 },
      edge: { x: b.x, y: b.y, width: 3, height: b.h },
      inner: { x: b.x + 24, y: b.y + 2, width: 80, height: b.h - 4 },
      minChanged: b.h * 2 * 0.8,
    }));

    // ⑤ 折りたたみ: 左の縁
    await expectEdgeGlows(page, 'details', DETAILS, (b) => ({
      pointer: { x: b.x + 4, y: b.y + b.h / 2 },
      edge: { x: b.x - 1, y: b.y + 10, width: 4, height: b.h - 20 },
      inner: { x: b.x + b.w - 200, y: b.y + 10, width: 160, height: b.h - 20 },
      minChanged: (b.h - 20) * 2 * 0.8,
    }));

    // ⑥ 入力欄(検索欄): 1px の枠そのものが薄く光る。上の縁(ポインタの下)の画素が変わり、内側は変わらない
    await expectEdgeGlows(page, 'find', '[data-pkc-field="entry-filter"]', (b) => ({
      pointer: { x: b.x + 60, y: b.y + 2 },
      edge: { x: b.x + 20, y: b.y, width: 90, height: 2 },
      inner: { x: b.x + b.w - 70, y: b.y + 8, width: 50, height: b.h - 16 },
      minChanged: 90 * 2 * 0.3,
    }));

    // ⑦ 追記欄の枠
    await expectEdgeGlows(page, 'append', '[data-pkc-field="append-form"]', (b) => ({
      pointer: { x: b.x + 140, y: b.y + 2 },
      edge: { x: b.x + 60, y: b.y - 1, width: 160, height: 3 },
      inner: { x: b.x + b.w - 220, y: b.y + 10, width: 160, height: 30 },
      minChanged: 160 * 2 * 0.4,
    }));
  }
  currentTheme = 'light';
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-pkc-theme', 'light');
    document.documentElement.setAttribute('data-pkc-tone', 'light');
  });

  // ⑧ 🔴 横スクロールした表でも、輪郭は器に張り付いたまま(器自身の背景)
  {
    const blk = page.locator(TABLE).first();
    const b = await boxOf(page, TABLE);
    const edgeR = { x: b.x + b.w - 2, y: b.y + 8, width: 2, height: b.h - 16 };
    await page.mouse.move(OUT_X, OUT_Y);
    const rest = await pixels(page, edgeR);
    await page.mouse.move(b.x + b.w - 40, b.y + b.h / 2);
    await page.mouse.move(b.x + b.w - 2, b.y + b.h / 2);
    await page.waitForTimeout(150);
    const lit = await pixels(page, edgeR);
    expect(changed(rest, lit), '表の右の縁が光らない').toBeGreaterThan((b.h - 16) * 2 * 0.8);
    await blk.evaluate((el) => {
      el.scrollLeft = 300;
    });
    await page.waitForTimeout(100);
    expect(changed(rest, await pixels(page, edgeR)), '横スクロールで輪郭が消えた').toBeGreaterThan((b.h - 16) * 2 * 0.8);
    await page.mouse.move(OUT_X, OUT_Y);
  }

  // ⑨ 🔴 版面が動かない: 表の器は光ってもいなくても同じ位置・大きさ(透明な 2px の枠は常にある)
  {
    await page.mouse.move(OUT_X, OUT_Y);
    await page.locator(TABLE).first().evaluate((el) => {
      el.scrollLeft = 0; // ⑧ で横へ送った
    });
    const rest = await boxOf(page, TABLE);
    const tableLeft = await page.locator(`${TABLE} table`).first().evaluate((t) => t.getBoundingClientRect().x);
    const para = await page.locator(`${BODY} > p`).first().evaluate((p) => p.getBoundingClientRect().x);
    expect(Math.abs(tableLeft - para), `表の左端が段落とずれた(表 ${tableLeft} / 段落 ${para})`).toBeLessThanOrEqual(1.5);
    await hoverNear(page, TABLE, rest.x + 1, rest.y + rest.h / 2);
    const lit = await boxOf(page, TABLE);
    expect(lit, '光ると表の器の位置・大きさが動いた').toEqual(rest);
  }

  // ⑩ 🔴 画面の外へ出た候補には印が付かない(IntersectionObserver で絞る): 本文を送って、画面の外にある器に光が残らない
  {
    await page.mouse.move(OUT_X, OUT_Y);
    await page.evaluate((s) => {
      let e = document.querySelector(s) as HTMLElement | null;
      while (e && e.scrollHeight <= e.clientHeight + 2) e = e.parentElement;
      e?.setAttribute('data-neon-scroller', '');
    }, BODY);
    const b = await boxOf(page, CODE);
    await hoverNear(page, CODE, b.x + 4, b.y + b.h / 2);
    await page.evaluate(() => {
      const sc = document.querySelector('[data-neon-scroller]') as HTMLElement | null;
      if (sc !== null) sc.scrollTop = sc.scrollHeight;
    });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            ([...document.querySelectorAll('[data-pkc-glow-near]')] as HTMLElement[]).filter((e) => {
              const r = e.getBoundingClientRect();
              return r.bottom < 0 || r.top > innerHeight;
            }).length,
          ),
        { message: '画面の外の候補に光が残っている' },
      )
      .toBe(0);
    await page.mouse.move(OUT_X, OUT_Y);
  }

  // ⑪ SQL の打つ欄(色分けの層を重ねた欄の包み): 縁が光り、フォーカス(欄そのもの)では全周の線が出て、包みの近接の光は出ない
  {
    await page.evaluate(() => {
      location.hash = '#pkc?view=sql';
    });
    const input = page.locator('[data-pkc-view-pane="sql"] [data-pkc-field="sql-input"]');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.blur(); // 開いた直後は打つ欄にフォーカスが入っている(フォーカスがあると近接の光は出ない = 仕様)
    await page.mouse.move(OUT_X, OUT_Y);
    await expectEdgeGlows(page, 'sql', '[data-pkc-field="sql-input-wrap"]', (b) => ({
      pointer: { x: b.x + 200, y: b.y + 2 },
      edge: { x: b.x + 80, y: b.y, width: 240, height: 2 },
      inner: { x: b.x + b.w - 220, y: b.y + 12, width: 160, height: 30 },
      minChanged: 240 * 2 * 0.5,
    }));
    const wb = await boxOf(page, '[data-pkc-field="sql-input-wrap"]');
    const top = { x: wb.x + 80, y: wb.y, width: 240, height: 2 };
    const restTop = await pixels(page, top);
    await input.focus();
    await page.waitForTimeout(150);
    const focusTop = await pixels(page, top);
    expect(changed(restTop, focusTop), 'SQL の欄のフォーカスの線が出ない').toBeGreaterThan(240 * 2 * 4 * 0.7);
    expect(await input.evaluate((el) => getComputedStyle(el).outlineStyle), 'SQL の欄に outline が残っている').toBe('none');
    await page.mouse.move(wb.x + 330, wb.y + 30);
    await page.mouse.move(wb.x + 200, wb.y + 2);
    await page.waitForTimeout(150);
    expect(changed(focusTop, await pixels(page, top)), 'SQL の欄のフォーカス中に近接の光が重なった').toBe(0);
  }
  expect(errors, `console / page error: ${errors.join(' | ')}`).toEqual([]);
});

test('🔴 フォーカス: キーボード(Tab)で入力欄・追記欄の枠に全周の静止した線が出る(二重の outline なし)/ フォーカスが近接の光に勝つ / 動きを減らす・スマホ幅でも静止の線は残り、近接の光は出ない (Stage 2 PR-2)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('フォーカス');
  await page.fill('[data-pkc-field="editor-body"]', '# 見出し\n\n本文です。\n\n```ts\nconst a = 1;\n```');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await page.mouse.move(OUT_X, OUT_Y);

  /** 4 辺の帯(外周 2px。`out` なら 1px 外へずらす ── 追記欄の枠は線を外側へ 1px 足す)。 */
  type Ring = { name: string; clip: { x: number; y: number; width: number; height: number } };
  const ring = (b: Box, out = 0): Ring[] => [
    { name: '上', clip: { x: b.x + 6, y: b.y - out, width: b.w - 12, height: 2 } },
    { name: '下', clip: { x: b.x + 6, y: b.y + b.h - 2 + out, width: b.w - 12, height: 2 } },
    { name: '左', clip: { x: b.x - out, y: b.y + 6, width: 2, height: b.h - 12 } },
    { name: '右', clip: { x: b.x + b.w - 2 + out, y: b.y + 6, width: 2, height: b.h - 12 } },
  ];
  const sides = async (b: Box, out = 0): Promise<number[][]> => Promise.all(ring(b, out).map((r) => pixels(page, r.clip)));

  // ① 検索欄 → Tab で並び順の選択欄へ(キーボードのフォーカス = `:focus-visible`)。全周の線 + 内側は変わらない + outline は無い
  const sel = '[data-pkc-field="entry-sort"]';
  await page.focus('[data-pkc-field="entry-filter"]');
  const sb = await boxOf(page, sel);
  await page.mouse.move(OUT_X, OUT_Y);
  await page.locator('[data-pkc-field="entry-filter"]').blur();
  const rest = await sides(sb);
  const restInner = await pixels(page, { x: sb.x + 8, y: sb.y + 7, width: 40, height: sb.h - 14 });
  await page.focus('[data-pkc-field="entry-filter"]');
  await page.keyboard.press('Tab');
  await expect(page.locator(sel)).toBeFocused();
  expect(await page.locator(sel).evaluate((el) => el.matches(':focus-visible')), 'キーボードで入ったのに :focus-visible でない').toBe(true);
  await page.waitForTimeout(150);
  const f1 = await sides(sb);
  ring(sb).forEach((r, i) => expect(changed(rest[i]!, f1[i]!), `選択欄のフォーカスの線が ${r.name} の辺に出ていない(全周でない)`).toBeGreaterThan(r.clip.width * r.clip.height * 4 * 0.7));
  expect(changed(restInner, await pixels(page, { x: sb.x + 8, y: sb.y + 7, width: 40, height: sb.h - 14 })), 'フォーカスで内側の地が変わった').toBe(0);
  // 静止: 時間が経っても動かない(アニメーションしない)
  await page.waitForTimeout(400);
  const f2 = await sides(sb);
  ring(sb).forEach((r, i) => expect(changed(f1[i]!, f2[i]!), `フォーカスの線が ${r.name} の辺で動いている(静止でない)`).toBe(0));
  // outline を二重に引かない(neon の線だけ)
  const style = await page.locator(sel).evaluate((el) => {
    const c = getComputedStyle(el);
    return { outlineStyle: c.outlineStyle, outlineWidth: c.outlineWidth, shadow: c.boxShadow, border: c.borderTopColor };
  });
  expect(style.outlineStyle === 'none' || style.outlineWidth === '0px', `outline が残っている: ${JSON.stringify(style)}`).toBe(true);
  expect(style.shadow, '全周の線(内側の影)が無い').toContain('inset');

  // ② 🔴 フォーカスが勝つ: フォーカス中の欄の縁へポインタを近づけても、縁の画素は変わらない(近接の光は出ない)
  const fb = await boxOf(page, sel);
  const focusedOnly = await pixels(page, { x: fb.x + 10, y: fb.y, width: fb.w - 20, height: 2 });
  await page.mouse.move(fb.x + fb.w / 2 + 30, fb.y + fb.h + 20);
  await page.mouse.move(fb.x + fb.w / 2, fb.y + 2);
  await expect.poll(() => page.locator(sel).evaluate((el) => el.hasAttribute('data-pkc-glow-near')), { message: '近接の印は付く(CSS が隠す)' }).toBe(true);
  await page.waitForTimeout(150);
  expect(changed(focusedOnly, await pixels(page, { x: fb.x + 10, y: fb.y, width: fb.w - 20, height: 2 })), 'フォーカス中の縁に近接の光が重なった(フォーカスが勝っていない)').toBe(0);
  await page.mouse.move(OUT_X, OUT_Y);

  // ③ 追記欄(`:focus-within` の包み): 枠の全周に線が出る。打つ欄は自分では線を引かない(二重にしない)
  await page.locator(sel).blur();
  const ab = await boxOf(page, '[data-pkc-field="append-form"]');
  const aRest = await sides(ab, 1);
  await page.focus('[data-pkc-field="append-input"]');
  await page.waitForTimeout(150);
  const aF = await sides(ab, 1);
  ring(ab, 1).forEach((r, i) => expect(changed(aRest[i]!, aF[i]!), `追記欄のフォーカスの線が ${r.name} の辺に出ていない`).toBeGreaterThan(r.clip.width * r.clip.height * 4 * 0.6));
  const inner = await page.locator('[data-pkc-field="append-input"]').evaluate((el) => {
    const c = getComputedStyle(el);
    return { shadow: c.boxShadow, outline: c.outlineStyle };
  });
  expect(inner.shadow, '打つ欄が自分でも線を引いている(枠と二重)').toBe('none');
  expect(inner.outline).toBe('none');
  const dir = process.env.PKC3_SHOT_DIR;
  if (dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/neon-focus-append-light.png`, clip: { x: ab.x - 12, y: ab.y - 12, width: Math.min(ab.w + 24, 640), height: ab.h + 24 } });
    await page.screenshot({ path: `${dir}/neon-focus-select-light.png`, clip: { x: sb.x - 12, y: sb.y - 12, width: sb.w + 24, height: sb.h + 24 } });
  }
  await page.locator('[data-pkc-field="append-input"]').blur();

  // ④ 🔴 動きを減らす設定: 近接の光は付かない(印ゼロ)が、フォーカスの静止の線は残る
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const code = `${BODY} .pkc-md-block[data-pkc-md-block-kind="code"]`;
  const cb = await boxOf(page, code);
  for (let i = 0; i < 6; i += 1) await page.mouse.move(cb.x + 4 + i * 6, cb.y + cb.h / 2 + (i % 2));
  await page.waitForTimeout(150);
  await expect(page.locator(NEAR), '動きを減らす設定なのに近接の光が付いた').toHaveCount(0);
  await page.focus('[data-pkc-field="entry-filter"]');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  const f3 = await sides(sb);
  ring(sb).forEach((r, i) => expect(changed(rest[i]!, f3[i]!), `動きを減らす設定でフォーカスの線が ${r.name} の辺に出ない`).toBeGreaterThan(r.clip.width * r.clip.height * 4 * 0.7));
  await page.locator(sel).blur();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(OUT_X, OUT_Y);

  // ⑤ 🔴 スマホの幅: 近接の光は付かない・追記欄のフォーカスの線は残る
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('[data-pkc-region="shell"]')).toHaveAttribute('data-pkc-layout', 'phone');
  const pcb = await boxOf(page, code);
  for (let i = 0; i < 6; i += 1) await page.mouse.move(pcb.x + 4 + i * 6, pcb.y + pcb.h / 2 + (i % 2));
  await page.waitForTimeout(150);
  await expect(page.locator(NEAR), 'スマホの幅で近接の光が付いた').toHaveCount(0);
  const pa = page.locator('[data-pkc-field="append-input"]');
  await expect(pa).toBeVisible();
  const pab = await boxOf(page, '[data-pkc-field="append-form"]');
  const pRest = await sides(pab, 1);
  await pa.focus();
  await page.waitForTimeout(150);
  const pF = await sides(pab, 1);
  ring(pab, 1).forEach((r, i) => expect(changed(pRest[i]!, pF[i]!), `スマホ幅でフォーカスの線が ${r.name} の辺に出ない`).toBeGreaterThan(r.clip.width * r.clip.height * 4 * 0.6));
  await page.setViewportSize({ width: 1440, height: 900 });
  await pa.blur();

  // ⑥ 🔴 2 ペイン整理: 焦点のある側のペインに同じ全周の枠(内側の影)。焦点のない側には無い
  await page.evaluate(() => {
    location.hash = '#pkc?view=dual';
  });
  await expect(page.locator('[data-pkc-view-pane="dual"]')).toBeVisible({ timeout: 15_000 });
  const panes = page.locator('[data-pkc-region="dual-pane"]');
  await expect(panes).toHaveCount(2);
  const st = await panes.evaluateAll((els) =>
    els.map((el) => {
      const c = getComputedStyle(el);
      return { focused: el.hasAttribute('data-pkc-focused'), shadow: c.boxShadow, border: c.borderTopColor };
    }),
  );
  const on = st.filter((s) => s.focused);
  const off = st.filter((s) => !s.focused);
  expect(on.length, '焦点のある側が 1 つでない').toBe(1);
  expect(on[0]!.shadow, '焦点のある側に全周の線が無い').toContain('inset');
  expect(off[0]!.shadow, '焦点のない側にも線がある').toBe('none');
  expect(on[0]!.border).not.toBe(off[0]!.border);
  expect(errors, `console / page error: ${errors.join(' | ')}`).toEqual([]);
});
