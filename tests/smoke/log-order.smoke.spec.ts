/**
 * 🔴 **ログを新しい順に並べる**(#2018 1。user 裁定 2026-11-22)── 実ブラウザで、**見た目の上下**が入れ替わることを見る。
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 「古い順」ボタンを押すと、新しい記録が**画面の上**に来る(入れ子の追いログは親の下のまま)| `order` は happy-dom で配置に映らない |
 * | 🔴 ふつうのノートの段落の位置は、設定を変えても 1px も動かない(flex はログの新しい順だけ) | 余白の重なりは実寸でしか測れない |
 * | 🔴 設定画面の列と、読む面のボタンが同じ値を映す(双方向) | 本物の設定画面 |
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';

async function tops(page: Page, texts: readonly string[]): Promise<number[]> {
  const out: number[] = [];
  for (const t of texts) {
    const box = await page.locator(`${BODY} p`, { hasText: t }).first().boundingBox();
    if (box === null) throw new Error(`「${t}」が描かれていない`);
    out.push(Math.round(box.y));
  }
  return out;
}

test('🔴 ログの並べ替え: 新しい記録が上に来て、入れ子は親の下のまま / ふつうのノートは 1px も動かない (#2018 1)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(() => localStorage.removeItem('pkc3.log-order'));

  // 対照群: ふつうのノートの段落の位置を先に測る
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-body"]', ['# 見出し', 'ふつう一', '## 小見出し', 'ふつう二'].join('\n\n'));
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const plainBefore = await tops(page, ['ふつう一', 'ふつう二']);
  const plainLid = await page.locator(BODY).getAttribute('data-pkc-painted');

  await createEntry(page, 'textlog');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ['## 2026-10-09 09:00:00', '古い記録', '### 2026-10-09 09:30:00', '古い記録の追い', '## 2026-10-10 08:00:00', '新しい記録'].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const btn = page.locator(`${BODY} [data-pkc-field="log-order"]`);
  await expect(btn, '並べ替えのボタンが出ていない').toHaveText('古い順');
  const [old0, follow0, new0] = (await tops(page, ['古い記録', '古い記録の追い', '新しい記録'])) as [number, number, number];
  expect(old0 < follow0 && follow0 < new0, '前提: 古い順で上から書いた順').toBe(true);
  // 古い順のログは flex にならない(通常の流れ)
  expect(await page.locator(BODY).evaluate((el) => getComputedStyle(el).display)).toBe('block');

  await btn.click();
  await expect(btn).toHaveText('新しい順');
  const [old1, follow1, new1] = (await tops(page, ['古い記録', '古い記録の追い', '新しい記録'])) as [number, number, number];
  expect(new1, '新しい記録が上に来ていない').toBeLessThan(old1);
  expect(old1, '入れ子の追いログが親の下に居ない').toBeLessThan(follow1);
  expect(await page.evaluate(() => localStorage.getItem('pkc3.log-order'))).toBe('desc');

  // 🔴 紙は書いた順(着地前レビュー 🔴1 ── 画面の flex の規則が印刷の節より後ろに在り、素の宣言では負けていた)
  await page.emulateMedia({ media: 'print' });
  expect(await page.locator(BODY).evaluate((el) => getComputedStyle(el).display), '印刷でも flex のまま').toBe('block');
  await expect(btn, '並べ替えのボタンが紙に出る').toBeHidden();
  const [oldP, , newP] = (await tops(page, ['古い記録', '古い記録の追い', '新しい記録'])) as [number, number, number];
  expect(oldP, '紙が新しい順のまま').toBeLessThan(newP);
  await page.emulateMedia({ media: 'screen' });
  await expect(btn).toBeVisible();

  // 設定画面の列も「新しい順」(双方向)── そこで「古い順」を押すと戻る
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const choice = page.locator('[data-pkc-field="log-order-select"]');
  await expect(choice.locator('[data-pkc-log-order-value="desc"]')).toHaveAttribute('aria-pressed', 'true');
  await choice.locator('[data-pkc-log-order-value="asc"]').click();
  await expect(choice.locator('[data-pkc-log-order-value="asc"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('pkc3.log-order'))).toBe('asc');

  // 新しい順にした状態で、ふつうのノートの段落が 1px も動かない
  await page.evaluate(() => localStorage.setItem('pkc3.log-order', 'desc'));
  await page.locator(`[data-pkc-region="sidebar"] [data-pkc-entry="${String(plainLid)}"]`).first().click();
  await expect(page.locator(BODY)).toHaveAttribute('data-pkc-painted', String(plainLid));
  expect(await tops(page, ['ふつう一', 'ふつう二']), 'ふつうのノートの段落が動いた').toEqual(plainBefore);
  expect(await page.locator(BODY).evaluate((el) => getComputedStyle(el).display)).toBe('block');

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **新しい順で、記録の境目をまたぐ「このブロックを上へ / 下へ」は断り、記録の中では動かす**(#2018 フォロー。
 * user 裁定 2026-11-22)── 新しい順では見た目の上下が記録の境目で DOM と逆になるので、またぐ移動だけ理由を出して止める。
 */
test('🔴 新しい順のログ: 記録の中のブロックは上へ動かせ、境目をまたぐ上へは理由を出して本文を変えない (#2018)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(() => localStorage.setItem('pkc3.log-order', 'desc'));
  await createEntry(page, 'textlog');
  const src = ['## 2026-10-09 09:00:00', '古い一', '古い二', '## 2026-10-10 08:00:00', '新しい一'].join('\n\n');
  await page.fill('[data-pkc-field="editor-body"]', src);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(BODY)).toHaveAttribute('data-pkc-log-order', 'desc');
  const step = async (text: string, dir: 'up' | 'down'): Promise<void> => {
    await page.locator(`${BODY} > p`, { hasText: text }).first().click({ button: 'right' });
    await page.locator(`[data-pkc-region="context-menu"] [data-pkc-action="move-block-step"][data-pkc-block-step-dir="${dir}"]`).click();
  };
  // 記録の頭の直後の塊を上へ = 記録の頭(見出し)より前 = 境目をまたぐ → 断る
  await step('古い一', 'up');
  await expect(page.locator('[data-pkc-region="status"]'), '境目をまたぐのに理由が出ない').toContainText('記録の境目をまたいで');
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-field="editor-body"]'), '断ったのに本文が変わった').toHaveValue(src);
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  // 記録の中の上へ(古い二を古い一の前へ)は動く
  await step('古い二', 'up');
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-field="editor-body"]'), '記録の中の移動が効かない').toHaveValue(
    ['## 2026-10-09 09:00:00', '古い二', '古い一', '## 2026-10-10 08:00:00', '新しい一'].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **新しい順で塊が中央へ縮まない・入れ子の縦線が揃う・同じ日の中も時刻の降順**(実機の崩れ。user 指示 2026-11-22)。
 * - 縦の flex の子は左右の余白が `auto` だと字の幅まで縮み、1 行の短い段落が 1 つずつ中央に寄っていた
 *   → 古い順と新しい順で、**塊ごとの左端と幅が同じ**であることを実寸で突き合わせる(古い順が対照群)
 * - 本文の並びを裏返すだけだと、追記の順と見出しの日時が食い違う記録で時刻が前後した(`22:47:20 → 06:18:53 → 15:25:46`)
 *   → 見出しの日時の降順で上から並ぶこと
 */
test('🔴 新しい順のログ: 塊は古い順と同じ左端・幅のまま(中央に縮まない)、同じ日の中も見出しの日時の降順 (#2018 実機)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(() => localStorage.setItem('pkc3.log-order', 'asc'));
  await createEntry(page, 'textlog');
  // 本文の順は 15:25 → 06:18 → 22:47(手で書き足した・取り込んだ記録で起きる並び)
  await page.fill(
    '[data-pkc-field="editor-body"]',
    [
      '## 2026-11-22 15:25:46',
      '昼の記録',
      '## 2026-11-22 06:18:53',
      '朝',
      '### 2026-11-22 06:30:00',
      '朝の追い一段',
      '#### 2026-11-22 06:40:00',
      '朝の追い二段',
      '## 2026-11-22 22:47:20',
      '夜の記録の本文はすこし長めに書いて、読み幅いっぱいに折り返すかどうかを見る',
    ].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const texts = ['15:25:46', '昼の記録', '06:18:53', '朝', '06:30:00', '朝の追い一段', '06:40:00', '朝の追い二段', '22:47:20', '夜の記録'];
  const rects = (): Promise<{ text: string; left: number; width: number; top: number }[]> =>
    page.locator(BODY).evaluate((host, keys) => {
      const kids = [...host.children].filter((c) => c.matches('p, h2, h3, h4'));
      return keys.map((k) => {
        const el = kids.find((c) => (c.textContent ?? '').trim() === k || (c.textContent ?? '').includes(k) && (k.length > 2 || (c.textContent ?? '').trim() === k));
        if (el === undefined) throw new Error(`「${k}」が無い`);
        const r = el.getBoundingClientRect();
        return { text: k, left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10, top: Math.round(r.top) };
      });
    }, texts);
  const asc = await rects();
  await page.locator(`${BODY} [data-pkc-field="log-order"]`).click();
  await expect(page.locator(BODY)).toHaveAttribute('data-pkc-log-order', 'desc');
  const desc = await rects();
  for (let i = 0; i < texts.length; i++) {
    expect(Math.abs(desc[i]!.left - asc[i]!.left), `「${texts[i]}」の左端が古い順とずれた(中央に縮んだ)`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(desc[i]!.width - asc[i]!.width), `「${texts[i]}」の幅が古い順と違う(字の幅に縮んだ)`).toBeLessThanOrEqual(0.5);
  }
  // 対照群が意味を持つ: 短い段落「朝」も読み幅いっぱい(字の幅ではない)
  const asa = desc.find((r) => r.text === '朝')!;
  const yoru = desc.find((r) => r.text === '夜の記録')!;
  expect(asa.width, '短い段落が字の幅に縮んだ').toBeCloseTo(yoru.width, 0);
  expect(asa.left).toBeCloseTo(yoru.left, 0);
  // 入れ子は親より右(字下げの位置は塊の左端 + padding。縦線は同じ左端から引く)
  // 同じ日の中も見出しの日時の降順
  const t = (k: string): number => desc.find((r) => r.text === k)!.top;
  expect(t('22:47:20'), '22:47 が一番上に来ない').toBeLessThan(t('15:25:46'));
  expect(t('15:25:46'), '15:25 が 06:18 より上に来ない').toBeLessThan(t('06:18:53'));
  expect(t('06:18:53'), '入れ子は親の下のまま').toBeLessThan(t('朝の追い一段'));
  expect(t('朝の追い一段')).toBeLessThan(t('朝の追い二段'));
  // 並べ替えのボタンは字の幅のまま右に寄る(塊と一緒に全幅へ広がらない)
  const ob = await page.locator(`${BODY} [data-pkc-field="log-order"]`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = el.parentElement!.getBoundingClientRect();
    return { w: r.width, right: r.right, hostW: h.width, hostRight: h.right };
  });
  expect(ob.w, '並べ替えのボタンが全幅の帯になった').toBeLessThan(ob.hostW / 3);
  expect(Math.abs(ob.right - ob.hostRight), '並べ替えのボタンが右に寄っていない').toBeLessThanOrEqual(2);
  await page.locator(BODY).screenshot({ path: test.info().outputPath('log-desc.png') });
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **新しい順の日の行は、その日のいちばん上の記録の手前**(着地前レビュー ⚠5)── 本文の順が日時と食い違う日
 *   (10:00 の後ろに 08:00)でも、日の行は 10:00 の上に来る。日をまたいでも新しい日が上。
 */
test('🔴 新しい順: 日の行はその日でいちばん新しい記録の上、新しい日が上 (#2018 実機)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(() => localStorage.setItem('pkc3.log-order', 'desc'));
  await createEntry(page, 'textlog');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ['## 2026-11-21 09:00:00', '前の日', '## 2026-11-22 10:00:00', '十時', '## 2026-11-22 08:00:00', '八時'].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(BODY)).toHaveAttribute('data-pkc-log-order', 'desc');
  const top = async (sel: string, text?: string): Promise<number> => {
    const loc = text === undefined ? page.locator(sel).first() : page.locator(sel, { hasText: text }).first();
    const b = await loc.boundingBox();
    if (b === null) throw new Error(`${sel} ${text ?? ''} が無い`);
    return b.y;
  };
  const day22 = await top(`${BODY} > [data-pkc-log-day="2026-11-22"]`);
  const day21 = await top(`${BODY} > [data-pkc-log-day="2026-11-21"]`);
  const [t10, t8, prev] = [await top(`${BODY} > p`, '十時'), await top(`${BODY} > p`, '八時'), await top(`${BODY} > p`, '前の日')];
  expect(day22, '11/22 の日の行が、その日でいちばん新しい 10:00 の上に無い').toBeLessThan(t10);
  expect(t10, '10:00 が 08:00 の上に無い').toBeLessThan(t8);
  expect(t8, '11/22 の記録が 11/21 の日の行より上に無い').toBeLessThan(day21);
  expect(day21).toBeLessThan(prev);
});
