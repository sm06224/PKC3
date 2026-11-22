/**
 * 🔴 **上側のツールチップ**(#1982 A3)。unit(happy-dom)では寸法が全部 0 なので、置き場所は実ブラウザでしか測れない。
 *
 * ① 画面の中ほどのボタン: 出た吹き出しの下端が `min(対象の上端, ポインタ y)` より上
 * ② 左の縦のバーの先頭(上に収まらない): 下へ落とさず横へ。対象とポインタのどちらにも重ならない
 * ③ 出ている間だけ標準の `title` が退避され、離れたら戻る
 * ④ `showModal()` のダイアログ(top layer)の中の対象でも、吹き出しが最前面に出る(`elementFromPoint` で取れる)
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, collectPageErrors, dismissAnnounce } from './helpers';

const TIP = '[data-pkc-region="tooltip"]';
/** 観測した値(下の ④ で前提として pin する)。 */
const FOCUS_VISIBLE_AFTER_SHOWMODAL = false;

/** `fromTop` を渡すと、ポインタを対象の上端から fromTop px 下に置く(省略時は中心)。 */
async function hoverCenter(
  page: Page,
  sel: string,
  fromTop?: number,
): Promise<{ x: number; y: number; rect: DOMRect }> {
  const box = await page.locator(sel).boundingBox();
  if (box === null) throw new Error(`見えない: ${sel}`);
  const x = box.x + box.width / 2;
  const y = fromTop === undefined ? box.y + box.height / 2 : box.y + fromTop;
  await page.mouse.move(0, 300);
  await page.mouse.move(x, y, { steps: 4 });
  return { x, y, rect: { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height } as DOMRect };
}

test('🔴 画面の中ほどのボタンでは、対象とポインタの両方より上に出る。title は出ている間だけ退避', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // 中ほどに在る、title を持つボタン(上端が 150px より下のもの)を探す
  const sel = await page.evaluate(() => {
    const cands = [...document.querySelectorAll<HTMLElement>('button[title]')];
    const hit = cands.find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.top > 150 && r.left > 300 && r.bottom < innerHeight - 50;
    });
    if (hit === undefined) return null;
    hit.setAttribute('data-pkc-tip-probe', '');
    return '[data-pkc-tip-probe]';
  });
  expect(sel, 'title を持つ中ほどのボタンが無い').not.toBeNull();
  const title = await page.locator(sel!).getAttribute('title');
  // ポインタは対象の中心ではなく上端付近に置く(show() が pointer を渡し忘れる変異を殺す)
  const { y, rect } = await hoverCenter(page, sel!, 2);
  await expect(page.locator(TIP)).toBeVisible({ timeout: 3000 });
  await expect(page.locator(sel!)).not.toHaveAttribute('title', /.*/);
  expect(await page.locator(sel!).getAttribute('data-pkc-tip-title')).toBe(title);
  const t = (await page.locator(TIP).boundingBox())!;
  expect(await page.locator(TIP).getAttribute('data-pkc-tip-side')).toBe('top');
  expect(t.y + t.height).toBeLessThanOrEqual(Math.min(rect.top, y) - 6 + 1);
  // 🔴 popover が実際に効いている(unit の happy-dom には showPopover が無く、この枝は実ブラウザでしか通らない)
  //   ふつうのボタン(ダイアログの外 = hostOf では救われない)の吹き出しが top layer に載っていること
  expect(await page.locator(TIP).getAttribute('popover'), 'popover="manual" が付いていない').toBe('manual');
  expect(await page.locator(TIP).evaluate((e) => e.matches(':popover-open')), 'showPopover されていない').toBe(true);
  await page.mouse.move(5, 5);
  await expect(page.locator(TIP)).toBeHidden();
  expect(
    await page.locator(TIP).evaluate((e) => e.matches(':popover-open')),
    '隠したあとも popover が開いたまま(closePopover が働いていない)',
  ).toBe(false);
  await expect(page.locator(sel!)).toHaveAttribute('title', title!);
  expect(errors, `page error: ${errors.join(" / ")}`).toEqual([]);
});

test('🔴 左の縦のバーの先頭(上に収まらない)では、下へ落とさず横に出て、対象にもポインタにも重ならない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // first() に頼らず、左の縦のバーの先頭のボタンへ印を付けて名指しする
  const marked = await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('[data-pkc-region="rail"] button[title]');
    if (b === null) return false;
    b.setAttribute('data-pkc-tip-probe', '');
    return true;
  });
  expect(marked, '左の縦のバーに title を持つボタンが無い').toBe(true);
  const sel = '[data-pkc-tip-probe]';
  await expect(page.locator(sel)).toBeVisible();
  // 前提: 吹き出しが上に収まらない位置にいること(崩れたら、検査が空振りになるので理由つきで落とす)
  const tipHeight = 28;
  const gap = 6;
  const margin = 4;
  const railTop = (await page.locator(sel).boundingBox())!.y;
  expect(railTop, `左バーの先頭ボタンの上端 ${railTop} が上に収まる位置になった。「上に収まらない」前提が崩れている`).toBeLessThan(
    gap + tipHeight + margin,
  );
  const title = await page.locator(sel).getAttribute('title');
  const { x, y, rect } = await hoverCenter(page, sel);
  await expect(page.locator(TIP)).toBeVisible({ timeout: 3000 });
  const t = (await page.locator(TIP).boundingBox())!;
  const side = await page.locator(TIP).getAttribute('data-pkc-tip-side');
  expect(side).toBe('right');
  expect(t.x).toBeGreaterThanOrEqual(rect.right);
  expect(t.x).toBeGreaterThan(x);
  expect(t.y).toBeGreaterThanOrEqual(0);
  // ポインタの点を含まない
  expect(x >= t.x && x <= t.x + t.width && y >= t.y && y <= t.y + t.height).toBe(false);
  await page.mouse.move(900, 600);
  await expect(page.locator(TIP)).toBeHidden();
  await expect(page.locator(sel)).toHaveAttribute('title', title!);
  expect(errors, `page error: ${errors.join(" / ")}`).toEqual([]);
});

test('🔴 showModal したダイアログの中の title 付きボタンでも、吹き出しが最前面に出る(説明が消えない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await page.evaluate(() => {
    const d = document.createElement('dialog');
    d.id = 'tip-probe-dialog';
    d.style.cssText = 'width:400px;height:300px;padding:20px';
    d.innerHTML = '<button id="tip-probe-btn" title="ダイアログ内の説明">試験</button>';
    document.body.appendChild(d);
    d.showModal();
  });
  // フォーカスがモーダルの開閉で動いても(クリックでもキーでもない)出ない
  // 🔑 前提を先に見る: showModal は先頭のボタンへフォーカスを移す。それが `:focus-visible` に当たるなら
  //   「出ない」は keyboardInput / focusVisible の門が実際に働いた結果、当たらないなら門に届かない(別の理由で出ない)。
  //   どちらの場合かを理由つきで落とす(不安定な前提に黙って乗らない)。
  const focusState = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { id: a?.id ?? '', fv: a?.matches(':focus-visible') ?? false };
  });
  expect(focusState.id, 'showModal が先頭のボタンへフォーカスを移していない(前提)').toBe('tip-probe-btn');
  expect(focusState.fv, ':focus-visible の扱いが変わった(showModal 直後の焦点が focus-visible)。門の働きを見直す').toBe(FOCUS_VISIBLE_AFTER_SHOWMODAL);
  await page.waitForTimeout(700);
  await expect(page.locator(TIP)).toBeHidden();
  await hoverCenter(page, '#tip-probe-btn');
  await expect(page.locator(TIP)).toBeVisible({ timeout: 3000 });
  await expect(page.locator(TIP)).toHaveText('ダイアログ内の説明');
  const top = await page.evaluate(() => {
    const tip = document.querySelector<HTMLElement>('[data-pkc-region="tooltip"]')!;
    // 吹き出しは pointer-events:none なので、検査の間だけ当たり判定を持たせて最前面かを見る
    tip.style.pointerEvents = 'auto';
    const r = tip.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    tip.style.pointerEvents = '';
    return hit === tip || (hit !== null && tip.contains(hit));
  });
  expect(top, '吹き出しがダイアログの背後に隠れている').toBe(true);
  await page.evaluate(() => (document.getElementById('tip-probe-dialog') as HTMLDialogElement).close());
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
