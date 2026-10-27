import { test, expect, type Page } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp } from './helpers';

/**
 * 🔴 外からファイルをドラッグして窓に入っている間だけ、落とせる 2 つのペインの縁に線が出て、
 *   「いまドロップするとどうなるか」の 1 行が出る。配置は一切動かない(#1380)。
 *
 * 出し先: ステータスバーが見えていればそこ / 畳まれている(ふだんの ready)ときは畳んだまま、
 *   左の一覧の下端のラベル。対照群: 内部のドラッグ(PKC の荷物・窓内の <img>)では出ない。
 * 消える経路: dragleave(窓の外へ)/ drop / Esc。
 */
const STATUS = '[data-pkc-region="status"]';
const LABEL = '[data-pkc-field="file-drag-label"]';

const probe = (page: Page) =>
  page.evaluate(
    ({ labelSel }) => {
      const root = document.querySelector('[data-pkc-region="shell"]')!.parentElement!;
      const rect = (sel: string) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100);
      };
      const outline = (sel: string) => {
        const cs = getComputedStyle(document.querySelector(sel)!);
        return `${cs.outlineStyle} ${cs.outlineWidth}`;
      };
      const status = document.querySelector<HTMLElement>('[data-pkc-region="status"]')!;
      const label = document.querySelector<HTMLElement>(labelSel);
      const lr = label?.getBoundingClientRect();
      const sr = document.querySelector('[data-pkc-region="sidebar"]')!.getBoundingClientRect();
      return {
        marked: root.hasAttribute('data-pkc-file-drag'),
        center: rect('[data-pkc-region="center"]'),
        detail: rect('[data-pkc-region="detail"]'),
        sidebar: rect('[data-pkc-region="sidebar"]'),
        centerOutline: outline('[data-pkc-region="center"]'),
        sidebarOutline: outline('[data-pkc-region="sidebar"]'),
        statusHidden: status.hidden || status.getBoundingClientRect().height === 0,
        status: status.textContent ?? '',
        labelShown: label !== null && !label.hidden && (lr?.width ?? 0) > 0,
        labelText: label?.textContent ?? '',
        labelHeight: lr?.height ?? 0,
        labelInSidebar:
          lr !== undefined && lr.left >= sr.left - 1 && lr.right <= sr.right + 1 && lr.bottom <= sr.bottom + 1,
        labelPointerEvents: label === null ? '' : getComputedStyle(label).pointerEvents,
      };
    },
    { labelSel: LABEL },
  );

/** Files を持つ荷物(または PKC の内部荷物)を、指定の要素へ入れる / 離す / 落とす。 */
const fire = (page: Page, type: string, opts: { internal?: boolean; image?: boolean; sel?: string } = {}) =>
  page.evaluate(
    ({ type, internal, image, sel }) => {
      const dt = new DataTransfer();
      if (internal) dt.setData('application/x-pkc-lids', 'x');
      else if (image) dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
      else dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
      const target = document.querySelector(sel) ?? document.body;
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { type, internal: opts.internal ?? false, image: opts.image ?? false, sel: opts.sel ?? '[data-pkc-region="detail"]' },
  );

test('🔴 ふだん(ready・通知なし = ステータスバーが畳まれている)でも、配置は動かず、ラベルが出て、離れると消える (#1380)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  const before = await probe(page);
  expect(before.statusHidden, '台の前提: ふだんはステータスバーが畳まれている').toBe(true);
  expect(before.marked).toBe(false);
  expect(before.labelShown).toBe(false);

  await fire(page, 'dragenter');
  const during = await probe(page);
  expect(during.marked).toBe(true);
  expect(during.centerOutline).toMatch(/^solid 2px/);
  expect(during.sidebarOutline).toMatch(/^solid 2px/);
  // 🔴 ステータスバーは畳んだまま ── 現れて左と中央を縮めない
  expect(during.statusHidden, 'ステータスバーが現れた').toBe(true);
  expect(during.center, '中央ペインが動いた').toEqual(before.center);
  expect(during.detail, '本文が動いた').toEqual(before.detail);
  expect(during.sidebar, '左の一覧が動いた(縮んだ)').toEqual(before.sidebar);
  // 字は左の一覧の下端のラベル。1 行に収まり、操作を奪わない
  expect(during.labelShown, 'ラベルが出ない').toBe(true);
  expect(during.labelText).toBe('ドロップすると添付になります');
  expect(during.labelHeight, 'ラベルが 2 行に折れた').toBeLessThan(36);
  expect(during.labelInSidebar, 'ラベルが左の一覧の下端に無い').toBe(true);
  expect(during.labelPointerEvents).toBe('none');

  await fire(page, 'dragleave');
  const left = await probe(page);
  expect(left.marked).toBe(false);
  expect(left.labelShown, '離れてもラベルが残る').toBe(false);
  expect(left.statusHidden).toBe(true);
  expect(left.center).toEqual(before.center);

  // Esc / drop でも消える
  await fire(page, 'dragenter');
  expect((await probe(page)).labelShown).toBe(true);
  await page.keyboard.press('Escape');
  expect((await probe(page)).labelShown, 'Esc で消えない').toBe(false);
  await fire(page, 'dragenter');
  await fire(page, 'drop');
  const dropped = await probe(page);
  expect(dropped.marked, 'drop で消えない').toBe(false);
  expect(dropped.labelShown).toBe(false);

  expect(errors).toEqual([]);
});

test('🔴 編集中はステータスバーに字が出て(位置は動かない)、本文の欄の上では画像のリンクと言う。内部のドラッグでは出ない (#1380)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  const before = await probe(page);
  expect(before.marked).toBe(false);
  expect(before.centerOutline).toMatch(/^none/);

  // 対照群: 内部のドラッグ(PKC の荷物)では出ない
  await fire(page, 'dragenter', { internal: true });
  expect((await probe(page)).marked, '内部のドラッグで線が出た').toBe(false);

  await fire(page, 'dragenter');
  const during = await probe(page);
  expect(during.marked).toBe(true);
  expect(during.status).toContain('ドロップすると添付になります');
  expect(during.labelShown, 'バーが見えているのにラベルも出た').toBe(false);
  expect(during.center).toEqual(before.center);
  expect(during.detail).toEqual(before.detail);
  expect(during.sidebar).toEqual(before.sidebar);
  await expect(page.locator(STATUS)).toContainText('ドロップすると添付になります');

  // 本文の欄の上: routeFiles と同じ振り分けの字(画像はその場にリンクが入る)
  // 1 面のライブエディタは、行を押して初めて入力欄(textarea)ができる
  await clickReal(page, '[data-pkc-region="editor-live"]');
  const body = '[data-pkc-field="row-source"], [data-pkc-field="editor-body"]';
  await expect(page.locator(body), '台の前提: 本文の入力欄がある').toHaveCount(1);
  await fire(page, 'dragenter', { image: true, sel: body });
  expect((await probe(page)).status).toContain('ドロップするとここに画像のリンクが入ります');
  await fire(page, 'dragenter', { sel: body });
  expect((await probe(page)).status, 'テキストは添付と言う').toContain('ドロップすると添付になります');

  await fire(page, 'dragleave', { image: true, sel: body });
  await fire(page, 'dragleave', { sel: body });
  await fire(page, 'dragleave');
  expect((await probe(page)).marked).toBe(false);
  await fire(page, 'dragenter');
  await page.keyboard.press('Escape');
  expect((await probe(page)).marked, 'Esc で消えない').toBe(false);

  expect(errors).toEqual([]);
});

test('🔴 窓の中で <img> をドラッグしても、線は出ない (#1380 ③)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  // 本物のブラウザのドラッグを起こす <img>(窓の内側で始まる = Chromium は Files を載せることがある)
  await page.evaluate(() => {
    const img = document.createElement('img');
    img.id = 'drag-probe-img';
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.src =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    img.style.cssText = 'position:fixed;left:400px;top:300px;width:40px;height:40px;z-index:5000';
    document.body.append(img);
    const root = document.querySelector('[data-pkc-region="shell"]')!.parentElement!;
    const log: { type: string; marked: boolean; types: string[] }[] = [];
    (window as unknown as { __dragLog: typeof log }).__dragLog = log;
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
      // ⚠ 本体の capture listener の**後**(bubble)で読む = 本体が決めた後の状態
      document.addEventListener(type, (e) => {
        log.push({
          type,
          marked: root.hasAttribute('data-pkc-file-drag'),
          types: [...((e as DragEvent).dataTransfer?.types ?? [])],
        });
      });
    }
  });
  const box = (await page.locator('#drag-probe-img').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 4 });
  await page.mouse.move(700, 400, { steps: 8 });
  await page.mouse.move(720, 420, { steps: 4 });
  // 🔴 実ブラウザは窓内の画像のドラッグに Files を載せる(dragstart の types に Files が入る)── 本物のドラッグの
  //   最中に、Files つきの dragenter が窓の中へ届いても、外のファイルとは見なさない
  const during = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'probe.png', { type: 'image/png' }));
    document
      .querySelector('[data-pkc-region="detail"]')!
      .dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return document.querySelector('[data-pkc-region="shell"]')!.parentElement!.hasAttribute('data-pkc-file-drag');
  });
  expect(during, '窓内の画像のドラッグ中に、Files つきの dragenter で線が出た').toBe(false);
  const mid = await page.evaluate(
    () => (window as unknown as { __dragLog: { type: string; marked: boolean }[] }).__dragLog.slice(),
  );
  await page.mouse.up();
  const log = await page.evaluate(
    () => (window as unknown as { __dragLog: { type: string; marked: boolean; types: string[] }[] }).__dragLog,
  );
  expect(
    log.some((l) => l.type === 'dragstart'),
    '台の前提: 本物のドラッグが始まっていない',
  ).toBe(true);
  expect(mid.some((l) => l.type === 'dragenter' || l.type === 'dragover'), '台の前提: 窓の中へドラッグが入っていない').toBe(
    true,
  );
  expect(
    log.filter((l) => l.marked).map((l) => l.type),
    `窓内の <img> のドラッグで線が出た(types=${JSON.stringify(log[0]?.types)})`,
  ).toEqual([]);
  expect((await probe(page)).marked).toBe(false);
  expect(errors).toEqual([]);
});
