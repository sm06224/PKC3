/**
 * 🔴 **表を「どの形で」持ち出すか選べる**(#708 段①)。
 *
 * > user の物語(#708): 表の右上の ⧉ を押すと表計算には貼れる。**でも markdown の
 * > 表として貼りたい / CSV の file が欲しい**ときに、その道が無かった。
 * > しかも形を選ぶ口は **csv の囲みにしか無く**、markdown の表と揃っていなかった。
 *
 * 🔴 **unit では届かない層を 3 つだけ見る**:
 *  ① **本物のクリップボード** ── happy-dom の `navigator.clipboard` は差し替え物で、
 *     「**本当に入ったか**」は実ブラウザでしか分からない
 *  ② **本物の `<dialog>`** ── 器は `showModal()` で開き、押した行が答えになる。
 *     happy-dom では「開いた」と「押せる」が一致しない
 *  ③ **押せる所に在るか** ── ⧉ と ▾ は右上に重ねて置くので、**重なって押せない**
 *     という壊れ方は座標を持つ実ブラウザでしか出ない(`clickReal` が dead click を見る)
 */
import { test, expect, type Page } from '@playwright/test';
import { clickReal, createEntry, collectPageErrors, gotoApp, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/** 表 2 つ(markdown と csv)を 1 つのノートに置く ── 同じ口が出るのが段① の主張。 */
const BODY = [
  '| 名前 | メモ |',
  '|---|---|',
  '| a\\|b | x,y |',
  '',
  '```csv',
  '名前,メモ',
  '"a|b","x,y"',
  '```',
].join('\n');

/**
 * 🔴 **押した直後に読まない**(`copy-body.smoke.spec.ts` が 2026-08-08 に踏んだ)。
 * コピーは非同期なので、直後に読むと**1 つ前の中身**が返り、アプリの濡れ衣になる。
 * 待つのは**アプリ自身の信号** ── 成功すると押したボタンに `data-pkc-flash` が
 * 700ms だけ付く。⚠ 短いので**押す前に**観測を仕掛ける。
 */
async function watchFlash(page: Page, sel: string): Promise<void> {
  await page.evaluate((s) => {
    const el = document.querySelector(s)!;
    const w = window as unknown as { __flashed: Record<string, boolean> };
    w.__flashed = w.__flashed ?? {};
    w.__flashed[s] = false;
    const mo = new MutationObserver(() => {
      if (el.getAttribute('data-pkc-flash') === 'true') {
        w.__flashed[s] = true;
        mo.disconnect();
      }
    });
    mo.observe(el, { attributes: true, attributeFilter: ['data-pkc-flash'] });
  }, sel);
}

async function expectFlashed(page: Page, sel: string, what: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (s) => (window as unknown as { __flashed: Record<string, boolean> }).__flashed[s],
          sel,
        ),
      { message: `${what}: コピー成功の合図が出ない(黙って失敗している)`, timeout: 10_000 },
    )
    .toBe(true);
}

test('🔴 表の ▾ から形を選んでコピーでき、⧉ の 1 押しは今までどおり (#708 段①)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(`${BODY}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] table')).toHaveCount(2, {
    timeout: 15_000,
  });

  /**
   * ① 🔴 **markdown の表と csv の表の両方に ▾ が出る** ── これが段① の当の主張。
   *   ⚠ 直す前は csv の囲みにしか形を選ぶ道が無かった。
   */
  const menus = page.locator('[data-pkc-field="detail-body"] [data-pkc-copy-menu]');
  await expect(menus, '2 つの表に同じ口が出ていない').toHaveCount(2);

  /**
   * ② 🔴 **⧉ の 1 押しは今までどおり**(表計算に貼れる TSV + 書式付きの HTML)。
   *   ⚠ 動線を 1 つも減らしていないことの本体である。
   */
  const plain =
    '[data-pkc-field="detail-body"] .pkc-md-copy-btn:not([data-pkc-copy-menu])';
  await watchFlash(page, plain);
  await clickReal(page, plain);
  await expectFlashed(page, plain, '⧉ の 1 押し');
  const one = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return {
      types: items.flatMap((i) => i.types),
      text: await (await items[0]!.getType('text/plain')).text(),
    };
  });
  expect(one.text, '1 押しで TSV が入らない(表計算に貼れない)').toBe('名前\tメモ\na|b\tx,y');
  expect(one.types, 'text/html が載っていない(書式付きで貼れない)').toContain('text/html');

  /**
   * ③ 🔴 **▾ を押すと形の一覧が出て、選んだ形が本当にクリップボードへ入る。**
   *   ⚠ 観測点は「一覧が出たか」ではなく**入った中身**である。
   */
  const menu = '[data-pkc-field="detail-body"] [data-pkc-copy-menu]';
  await watchFlash(page, menu);
  await clickReal(page, menu);
  const rows = page.locator('[data-pkc-field="pick-copy-format"]');
  await expect(rows, '形の一覧が出ない').toHaveCount(5);
  await expect(rows.first(), '一覧が読めない字になっている').toHaveText('表計算に貼る(TSV)');
  await clickReal(page, '[data-pkc-field="pick-copy-format"][data-pkc-copy-format-index="1"]');
  await expectFlashed(page, menu, 'markdown の表');
  const md = await page.evaluate(() => navigator.clipboard.readText());
  // 🔴 `|` を逃がしていないと、貼った先で列がずれる(静かに壊れる向き)
  expect(md, 'markdown の表になっていない').toContain('| 名前 | メモ |');
  expect(md, '升の中の `|` を逃がしていない').toContain('a\\|b');

  /**
   * ④ 🔴 **csv の表からも同じ形で持ち出せる**(口が揃っていることの裏取り)。
   *   ⚠ ここでは CSV を選ぶ ── 同じ一覧から別の形が選べることも同時に見る。
   */
  await page.locator(menu).nth(1).click();
  await expect(rows, '2 つ目の表で一覧が出ない').toHaveCount(5);
  await page.locator('[data-pkc-field="pick-copy-format"][data-pkc-copy-format-index="3"]').click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
      message: 'csv の表から CSV が入らない',
      timeout: 10_000,
    })
    .toBe('名前,メモ\na|b,"x,y"');

  /**
   * ⑤ やめられる ── `Escape` で閉じて、クリップボードは書き換わらない。
   *
   * ⚠ 観測点は**器が開いているか**(`<dialog open>`)であって、行の数ではない ──
   *   器は使い回すので、閉じても中身は次に開くまで残っている(1 稿目はここで
   *   「閉じない」と読み違えた。**製品ではなく観測点の話**である)。
   */
  const dlg = page.locator('[data-pkc-region="app-dialog"][open]');
  await page.locator(menu).first().click();
  await expect(dlg, '器が開かない').toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dlg, 'Escape で閉じない').toHaveCount(0);
  expect(
    await page.evaluate(() => navigator.clipboard.readText()),
    'やめたのに中身が書き換わった',
  ).toBe('名前,メモ\na|b,"x,y"');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
