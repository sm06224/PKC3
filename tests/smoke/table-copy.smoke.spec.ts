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
  // 🔑 題名を付ける ── 落とす file の名前が**このノート**から作られることを ⑥ で見る
  await page.locator('[data-pkc-field="editor-title"]').fill('買い物メモ');
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
  // ⚠ 5 = コピーの形 / 6 つ目は「本文を書き換える」(#708 裁定②)
  await expect(rows, '形の一覧が出ない').toHaveCount(6);
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
  await expect(rows, '2 つ目の表で一覧が出ない').toHaveCount(6);
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

  /**
   * ⑥ 🔴 **`.csv` で保存すると、file が本当に落ちてくる**(2026-09-05、着地前レビュー M1)。
   *
   * ⚠ 直す前は **5 つのうち index 4 を 1 度も押していなかった** ── だから
   *   `download: downloadBlob` の配線を `() => {}` に変えても**全部緑**だった
   *   (落とす口が死んでも、光る合図と「保存しました」だけが出る)。
   * 🔑 観測点は**ブラウザが受け取った file**(名前と中身)── 呼んだかどうかではない。
   */
  const wait = page.waitForEvent('download');
  await page.locator(menu).first().click();
  await page.locator('[data-pkc-field="pick-copy-format"][data-pkc-copy-format-index="4"]').click();
  const dl = await wait;
  /**
   * ⚠ **名前はここで見ない** ── この箱の headless Chromium は**非 ASCII の
   *   `download` 名を丸ごと捨てて `"download"` にする**(CLAUDE.md §4)。
   *   名前の規則は unit(`copy-md-block.test.ts`)が題名と空題名の 2 通りで見る。
   * 🔑 ここでしか見られないのは「**ブラウザが本当に file を受け取ったか**」と
   *   「**その中身**」である。
   */
  const chunks: Buffer[] = [];
  for await (const c of (await dl.createReadStream())!) chunks.push(Buffer.from(c));
  const body = Buffer.concat(chunks).toString('utf8');
  expect(body.charCodeAt(0), 'BOM が無い(Excel で文字化けする)').toBe(0xfeff);
  expect(body.slice(1), '落ちてきた中身が表になっていない').toBe('名前,メモ\na|b,"x,y"');
  /**
   * 🔴 **保存は字で言う**(光る合図はコピーの意味)── 画面の下に 1 行出る。
   * 🔑 **名前の主張はここで見る**(着地前レビュー M2 / M3)── 落ちた file の名前は
   *   この箱では読めないが、**知らせの字にはアプリが決めた名前がそのまま載る**。
   *   ⚠ これが無いと、binder の `noteTitle` を `() => ''` にしても全部緑になる
   *   (unit は自前の stub を渡すので、配線を 1 度も通らない)。
   */
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '保存したのに何も言っていない / ノートの題名から名前を作っていない',
  ).toContainText(/買い物メモ-\d{4}-\d{2}-\d{2}\.csv を保存しました/);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **指で触る端末から、表の形を変えられる**(#708 裁定②。user 2026-09-06)。
 *
 * > user への設問:「指で触る端末には右クリックが無いので、いま
 * > 『Markdown の表 ⇄ CSV の表』を入れ替える方法が 1 つもありません」
 * > → 裁定は「**▾ の小窓に 1 行足す**」。
 *
 * 🔑 **unit では届かない 2 つ**を実ブラウザで見る:
 * 1. 押した行が `SET_TABLE_FORMAT` まで届き、**本文が本当に書き換わるか**
 * 2. 書き換わった表が**升を押して打てる形**になっているか(それが変える目的である)
 */
test('🔴 ▾ の小窓から、本文の表を作り変えられる (#708 裁定②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('作り変え');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const menu = '[data-pkc-field="detail-body"] [data-pkc-copy-menu]';
  await expect(page.locator(menu), '▾ が出ていない').toHaveCount(1, { timeout: 15_000 });
  // 🔑 前提 ── いまは markdown の表なので、行や列を足す ＋ × は出ていない
  await expect(
    page.locator('[data-pkc-field="detail-body"] [data-pkc-action="shape-cell"]'),
    '前提が崩れた(markdown の表なのに ＋ × が出ている)',
  ).toHaveCount(0);

  await clickReal(page, menu);
  const rows = page.locator('[data-pkc-field="pick-copy-format"]');
  await expect(rows, '一覧が出ない').toHaveCount(6);
  // 🔴 **区切りが 1 本引かれている**(上は持ち出す・下は本文を書き換える)
  await expect(
    page.locator('[data-pkc-field="pick-copy-format-sep"]'),
    '区切りが引かれていない(コピーと書き換えが地続きに見える)',
  ).toHaveCount(1);
  /**
   * 🔴 **線の「位置」まで見る**(着地前レビュー・実装 R4、2026-09-06)。
   * ⚠ 本数だけを見ていたので、**線を一番下へ動かす変異が生き延びた** ──
   *   そうなると書き換える行がコピーの 5 つと地続きになり、
   *   この裁定が防ごうとした当のもの(コピーのつもりで本文が変わる)が戻る。
   */
  await expect(
    page.locator('[data-pkc-field="pick-copy-format-sep"] ~ [data-pkc-field="pick-copy-format"]'),
    '区切りより下に在るのが、書き換える 1 行だけになっていない',
  ).toHaveCount(1);
  await expect(rows.nth(5), '書き換える行の字が違う').toHaveText(
    '本文を CSV の表に書き換える(行と列を足せて、式も使えます)',
  );

  await clickReal(page, '[data-pkc-field="pick-copy-format"][data-pkc-copy-format-index="5"]');

  /**
   * 🔴 **本文が本当に書き換わる** ── 観測点は「行が出た」ではなく、
   *   **csv の表にしかない ＋ × が出たこと**である(形が変わった証拠)。
   */
  await expect(
    page.locator('[data-pkc-field="detail-body"] [data-pkc-action="shape-cell"]'),
    '本文が書き換わっていない(csv の表になっていない)',
  ).not.toHaveCount(0, { timeout: 15_000 });
  // 🔑 升は今までどおり押して打てる(作り変えた目的が果たせている)
  await expect(
    page.locator('[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]'),
    '作り変えた表の升が押せない',
  ).not.toHaveCount(0);

  /** 🔴 **戻せる**(片道の操作を作らない ── user 指示 2026-08-23)。 */
  await clickReal(page, menu);
  await expect(rows, '作り変えた後に一覧が出ない').toHaveCount(6);
  await expect(rows.nth(5), '戻す字が出ていない').toHaveText(
    '本文を Markdown の表に書き換える(よそへ貼りやすい形。行・列の ＋ × と式は使えなくなります)',
  );

  expect(errors, `ページで例外が出た: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **作り変えられない表には、その行を出さない**(#708 裁定②)。
 *
 * ## ⚠ 台を差し替えた(2026-09-07、#743)
 *
 * ここは長く `:::note` の中の表を台にしていたが、**user 裁定「出す」で
 * `:::` の中も引用の中も出るようになった**ので、台としては成り立たなくなった。
 * 🔑 差し替え先は「**閉じていない csv の囲み**」── 実測でこの形だけが
 *   「**表も ▾ も出るのに `tableAt` が `null`**」を今も満たす
 *   (表=1 / ▾=1 / `tableAt`=null。閉じた囲みは対照群として csv を返す)。
 * ⚠ 閉じていない囲みを触らないのは**下の本文を丸ごと飲むから**である ──
 *   走査は閉じ無しの柵を末尾まで飲むので、書き換えると囲みより下が消える。
 * 🔑 だから小窓にも出さない ── **押しても何も起きない行を作らない**
 *   (user 指示 2026-08-23「片道の操作を作らない」)。
 * ⚠ この形の台が無いと、「出さない」を守る門が**丸ごと素通り**する
 *   (実測:`at === null` の判定を外す変異が unit も smoke も生き延びた)。
 */
test('🔴 閉じていない csv の囲みでは、書き換える行を出さない (#708 裁定②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('閉じていない囲み');
  // ⚠ **閉じの ``` を書かない** ── これが「表は出るが作り変えられない」唯一の形である
  await page.locator('[data-pkc-field="editor-body"]').fill('```csv\n品名,数\nりんご,3\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const menu = '[data-pkc-field="detail-body"] [data-pkc-copy-menu]';
  await expect(page.locator(menu), '▾ が出ていない(前提が崩れた)').toHaveCount(1, {
    timeout: 15_000,
  });
  await clickReal(page, menu);

  const rows = page.locator('[data-pkc-field="pick-copy-format"]');
  // 🔴 **コピーの 5 つだけ**(書き換える行は出ない)
  await expect(rows, '押しても何も起きない行を出した').toHaveCount(5);
  await expect(
    page.locator('[data-pkc-field="pick-copy-format-sep"]'),
    '出す行が無いのに区切りだけ引いた',
  ).toHaveCount(0);
  // ⚠ 空振り防止 ── 一覧そのものはちゃんと出ている
  await expect(rows.first(), '一覧が出ていない').toHaveText('表計算に貼る(TSV)');
  /**
   * 🔴 **題名も「書き換える」を名乗らない**(着地前レビュー・動線 D5、2026-09-06)。
   * ⚠ 行を出さないだけだと**題名だけが約束を残す** ── user は「壊れている」か
   *   「自分の押し方が悪い」と読む(画面には理由が 1 文字も出ない)。
   */
  await expect(
    page.locator('[data-pkc-field="dialog-title"]'),
    '書き換える行が無いのに、題名が「書き換える」と名乗っている',
  ).toHaveText('この表をコピー');

  expect(errors, `ページで例外が出た: ${errors.join(' / ')}`).toEqual([]);
});
