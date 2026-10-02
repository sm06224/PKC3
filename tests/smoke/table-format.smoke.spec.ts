/**
 * 🔴 **右クリックで表の形を変える**(#708 段②)。
 *
 * > user の物語(#708): markdown で `| 品名 | 数 |` と書いた表を、あとから
 * > **升を押して打てる表にしたい**(逆に、csv の表を他所へ持っていくために
 * > markdown へ落としたい)。どちらの道も無かった。
 *
 * 🔑 **unit では届かない 3 つ**を実ブラウザで見る:
 * 1. **本物の右クリック**(`button: 'right'`)── 合成 event ではブラウザ既定を
 *    奪えたか / メニューが押せる所に出たかが分からない
 * 2. **メニューの項目から実際に効くか** ── メニューは `data-pkc-action` を置くだけで、
 *    実行は root の委譲がやる。**その配線**は実物でしか見えない
 * 3. 🔴 **保存された本文が変わっているか** ── 画面の字だけ見ると、本文に
 *    書かれていなくても緑になる(読み直して残ることまで見る)
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

// ⚠ 本文は 2 行(#1240)── 並べ替えで並び順が変わることを見るには、行が 2 つ要る
const BODY = [
  '# 買い物',
  '',
  '| 品名 | 数 |',
  '|---|---|',
  '| りんご | 3 |',
  '| みかん | 1 |',
  '',
  '以上。',
].join('\n');

const MENU = '[data-pkc-region="context-menu"]';
/** 押せる升(⚠ #708 段④ で **markdown の表にも出る**ので、これは形の証拠ではない)。 */
const CELL = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';
/**
 * 🔴 **csv の表になった証拠**(#708 段④ で観測点を差し替えた)。
 *
 * ⚠ 直す前は「升が押せるか」で形を見分けていたが、段④ で **markdown の表の升も
 *   押せるようになった**ので、その印は**両方で真**になった ── 形を見分けられない。
 * 🔑 いま形を分けるのは **行・列を足す ＋ ×**(`shape-cell`)である ── csv の表にしか出ない。
 */
const CSV_ONLY = '[data-pkc-field="detail-body"] [data-pkc-action="shape-cell"]';

test('🔴 表を右クリックして形を変えると、保存された本文も変わる (#708 段②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('買い物');
  await page.locator('[data-pkc-field="editor-body"]').fill(`${BODY}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const table = page.locator('[data-pkc-field="detail-body"] table');
  await expect(table, '表が描かれていない').toHaveCount(1, { timeout: 15_000 });
  // 🔑 **前提**:まだ markdown の表である(行・列の ＋ × は出ていない)
  await expect(page.locator(CSV_ONLY), '前提: もう csv の表になっている').toHaveCount(0);
  // 🔴 **テーブル列ソート**(#1150): ヘッダーにソート属性とインジケータが付与されていること
  const th = table.locator('th').first();
  await expect(th, '表ヘッダーにソート属性が付与されていない').toHaveAttribute('data-pkc-sort-direction', 'none');
  await expect(th.locator('.pkc-table-sort-icon'), 'ソートインジケータが出ていない').toBeVisible();
  /**
   * 🔴 **印の字は要素ではなく CSS の `::after` が出す**(読む面の選択・⧉ に混ざらないため)。
   * ⚠ `toBeVisible` は空の `span` でも通る ── 観測点は**計算後の `::after` の `content`**と、
   *   見出しの `textContent` が字を持たないこと。
   * ⚠ 3 態は**属性を直に書き換えて**見る(CSS の受け皿だけを見る)。押す道は下の
   *   「見出しを押す」で通す(#1240 まで、見出しの 1 回押しは並べ替えと同時に升の編集も
   *   始めていたので、この観測点は押す道を使えなかった)。
   */
  const afterContent = (): Promise<string> =>
    th.locator('.pkc-table-sort-icon').evaluate((n) => getComputedStyle(n, '::after').content);
  expect(await th.evaluate((n) => n.textContent), '印の字が textContent に混ざっている').toBe('品名');
  expect(await afterContent(), '並べ替え前の印(↕)が CSS から出ていない').toBe('"↕"');
  for (const [dir, mark] of [['asc', '▲'], ['desc', '▼'], ['none', '↕']] as const) {
    await th.evaluate((n, d) => n.setAttribute('data-pkc-sort-direction', d), dir);
    expect(await afterContent(), `${dir} の印(${mark})が CSS から出ていない`).toBe(`"${mark}"`);
  }

  /**
   * ── 🔴 **見出しを押す(#1240。裁定 A)**:1 回押しは並べ替えだけ、編集は 2 回押しか ✎。
   *
   * ⚠ 並べ替えと編集が**同じ 1 回押しを奪い合っていた**(開いたばかりの欄が壊れる)。
   *   本物の押しでないと、ブラウザが出す `click` / `dblclick` の並びも、✎ が押せる所に出ているかも
   *   見えない。⚠ 新しく起動しない ── この道中に足す。
   */
  const INPUT = '[data-pkc-field="detail-body"] [data-pkc-field="cell-input"]';
  const bodyFirstCol = (): Promise<string[]> =>
    table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.children[0]!.textContent ?? ''));
  expect(await bodyFirstCol(), '前提: 描いたままの並び').toEqual(['りんご', 'みかん']);
  // ① 見出し(品名)を 1 回押す → 並び順が変わり、編集欄は出ない
  //    ⚠ 右端の見出しは表の右上の ⧉ / ▾ が重なる(実測)ので、押すのは左の見出し
  await clickReal(page, th);
  await expect.poll(bodyFirstCol, '見出しを押しても並べ替わらない').toEqual(['みかん', 'りんご']);
  await expect(page.locator(INPUT), '見出しの 1 回押しで編集欄が開いた').toHaveCount(0);
  // ⚠ 対照群 ── 本文の升は今までどおり 1 回押しで開く(台が「何も開かない」だけではない)
  await clickReal(page, table.locator('td').first());
  await expect(page.locator(INPUT), '対照群が鳴っていない ── 本文の升が 1 回押しで開かない').toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator(INPUT)).toHaveCount(0);
  // ② 見出し(品名)を 2 回押す → 編集欄が開く(その升の字で)
  await th.dblclick();
  await expect(page.locator(INPUT), '見出しの 2 回押しで編集欄が開かない').toHaveCount(1);
  await expect(page.locator(INPUT)).toHaveValue('品名');
  await page.keyboard.press('Escape');
  await expect(page.locator(INPUT)).toHaveCount(0);
  // ③ 見出しに触れると右に ✎ が出る → 押すと編集欄が開く(並べ替えは起きない)
  const pencil = th.locator('.pkc-cell-edit-btn');
  expect(
    await pencil.evaluate((n) => getComputedStyle(n, '::before').content),
    '✎ の字が CSS から出ていない',
  ).toBe('"✎"');
  expect(await th.evaluate((n) => n.textContent), '✎ が見出しの字に混ざった').toBe('品名');
  await th.hover();
  await expect(pencil, '見出しに触れても ✎ が出ない').toBeVisible();
  const orderBefore = await bodyFirstCol();
  await clickReal(page, pencil);
  await expect(page.locator(INPUT), '✎ で編集欄が開かない').toHaveCount(1);
  await expect(page.locator(INPUT)).toHaveValue('品名');
  expect(await bodyFirstCol(), '✎ を押したのに並べ替わった').toEqual(orderBefore);
  await page.keyboard.press('Escape');
  await expect(page.locator(INPUT)).toHaveCount(0);
  // ④ 🔴 いちばん右の見出しの ✎ は、表の右上の ⧉ / ▾ の下に隠れない(押せる所に出ている)
  //    ⚠ 実測で踏んだ ── 右端に置くと ⧉ / ▾ が重なり、押しても ⧉ / ▾ が受けていた
  const lastHead = table.locator('th').last();
  await lastHead.hover();
  const lastPencil = lastHead.locator('.pkc-cell-edit-btn');
  await expect(lastPencil, '右端の見出しに触れても ✎ が出ない').toBeVisible();
  expect(
    await lastPencil.evaluate((n) => {
      const r = n.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === n;
    }),
    '右端の見出しの ✎ が ⧉ / ▾ の下に隠れて押せない',
  ).toBe(true);

  // ── ① 表を右クリックすると「CSV の表にする」が出る
  await table.locator('td').first().click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, '表の上で右クリックしてもメニューが出ない').toBeVisible();
  const toCsv = menu.locator('[data-pkc-action="table-to-csv"]');
  await expect(toCsv, '「CSV の表にする」が出ていない').toHaveText('CSV の表にする');

  // ── ② 押すと、升を押して打てる表に変わる
  await clickReal(page, toCsv);
  /**
   * ⚠ **`toBeVisible` では見られない** ── ＋ × は行に乗せるまで `visibility: hidden`
   *   である(`app.css`)。🔑 観測点は「**その印が焼かれているか**」にする。
   */
  await expect(
    page.locator(CSV_ONLY),
    'csv の表になっていない(行・列の ＋ × が焼かれていない)',
  ).not.toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(CELL), '升の数が変わった(表が組み替わった)').toHaveCount(6);
  await expect(table, '表が消えた / 増えた').toHaveCount(1);
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '表の外の字まで書き換えた',
  ).toContainText('以上。');

  /**
   * ── ③ 🔴 **読み込み直しても残る**(本文へ書かれた証拠)。
   * ⚠ 読み直すと何も選ばれていないので、一覧から開き直す(`csv-cell` と同じ作法)。
   */
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CSV_ONLY), '読み直したら markdown へ戻った').not.toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.locator(CELL).nth(2), '升の字が消えた').toHaveText(/りんご/);

  /**
   * ── ④ 🔴 **戻せる**(user 指示 2026-08-23「片道の操作を作らない」)。
   * ⚠ 押した先が「もう一度同じ物を押す」ではなく、**反対側の字**が出ることまで見る。
   */
  await page.locator(CELL).first().click({ button: 'right' });
  const toMd = page.locator(`${MENU} [data-pkc-action="table-to-markdown"]`);
  await expect(toMd, '「Markdown の表にする」が出ていない').toHaveText('Markdown の表にする');
  await clickReal(page, toMd);
  await expect(page.locator(CSV_ONLY), 'markdown へ戻っていない(＋ × がまだ出ている)').toHaveCount(
    0,
    { timeout: 15_000 },
  );
  // 🔑 戻っても**升は押せるまま**(#708 段④)── 形は戻り、打ちやすさは残る
  await expect(page.locator(CELL), '戻したら升が押せなくなった').toHaveCount(6);
  await expect(
    page.locator('[data-pkc-field="detail-body"] table'),
    '戻したら表が消えた',
  ).toContainText('りんご');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
/**
 * 🔴 **引用(`>`)と `:::` の板の中でも、表の形を変えられる**
 *   (#743。**user 裁定 2026-09-07「出す」**)。
 *
 * 🔑 **unit では届かない 3 つ**を実ブラウザで見る:
 * 1. **器の中の表を本物の右クリックで掴めるか** ── どの表かは描画が焼いた
 *    `data-pkc-source-line` から引くので、**焼かれていなければ項目は出ない**。
 *    ⚠ unit は行番号を自分で渡すので、この段を 1 度も通らない
 * 2. **メニューの項目から実際に効くか** ── メニューは `data-pkc-action` を置くだけで、
 *    実行は root の委譲がやる(`table-copy` の ▾ とは別の配線である)
 * 3. 🔴 **読み直しても残るか** ── 画面の字だけ見ると、本文へ書かれていなくても緑になる
 *
 * ⚠ 「**器から落ちていない**」(引用の前置きを付け直したか)は**unit でも見ている**
 *   ── `table-convert.test.ts` が描いた HTML の `blockquote` / `.pkc-section-callout`
 *   を見る。ここに置くのは**同じ不変量を、本物の操作の後で**確かめるためである
 *   (2 か所で見ているのは重複ではない:片方は関数の答え、片方は user の一連の動作)。
 */
const CALLOUT_TABLE = '[data-pkc-field="detail-body"] .pkc-section-callout table';
const QUOTE_TABLE = '[data-pkc-field="detail-body"] blockquote table';
const NESTED_BODY = [
  '# 在庫',
  '',
  ':::note',
  '| 品名 | 数 |',
  '|---|---|',
  '| りんご | 3 |',
  ':::',
  '',
  '> | 品目 | 個 |',
  '> |---|---|',
  '> | みかん | 5 |',
  '',
  '以上。',
].join('\n');

test('🔴 引用と ::: の中の表も、右クリックで形を変えられて器から落ちない (#743)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('在庫');
  await page.locator('[data-pkc-field="editor-body"]').fill(`${NESTED_BODY}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  // 🔑 **前提** ── 表が 2 つとも器の中に描かれ、まだ markdown である
  await expect(page.locator(CALLOUT_TABLE), '板の中に表が無い').toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(QUOTE_TABLE), '引用の中に表が無い').toHaveCount(1);
  await expect(page.locator(CSV_ONLY), '前提: もう csv の表になっている').toHaveCount(0);

  const menu = page.locator(MENU);
  /** 器の中の表を右クリックして「CSV の表にする」を押す。 */
  const toCsv = async (where: string, name: string): Promise<void> => {
    await page.locator(`${where} td`).first().click({ button: 'right' });
    await expect(menu, `${name}: メニューが出ない`).toBeVisible();
    const item = menu.locator('[data-pkc-action="table-to-csv"]');
    await expect(item, `${name}: 「CSV の表にする」が出ていない`).toHaveText('CSV の表にする');
    await clickReal(page, item);
  };

  await toCsv(CALLOUT_TABLE, '板の中');
  await expect(
    page.locator(`${CALLOUT_TABLE} [data-pkc-action="shape-cell"]`),
    '板の中の表が csv になっていない(行・列の ＋ × が焼かれていない)',
  ).not.toHaveCount(0, { timeout: 15_000 });
  // 🔴 **器から落ちていない** ── 板の外に表が増えていないことも見る
  await expect(page.locator(CALLOUT_TABLE), '作り変えたら板から落ちた').toHaveCount(1);

  await toCsv(QUOTE_TABLE, '引用の中');
  await expect(
    page.locator(`${QUOTE_TABLE} [data-pkc-action="shape-cell"]`),
    '引用の中の表が csv になっていない',
  ).not.toHaveCount(0, { timeout: 15_000 });
  // 🔴 **前置き(`> `)を付け直していないと、ここで落ちる**(升の字は同じまま)
  await expect(page.locator(QUOTE_TABLE), '作り変えたら引用から落ちた').toHaveCount(1);

  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '器の外の字まで書き換えた',
  ).toContainText('以上。');

  // ── 🔴 **読み込み直しても残る**(本文へ書かれた証拠)
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(`${QUOTE_TABLE} [data-pkc-action="shape-cell"]`), '読み直したら戻った')
    .not.toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(CALLOUT_TABLE), '読み直したら板から落ちた').toHaveCount(1);
  await expect(page.locator(QUOTE_TABLE), '読み直したら引用から落ちた').toHaveCount(1);

  /**
   * ── 🔴 **戻せる**(片道ではない ── 出す判断の根拠そのもの)。
   * ⚠ ここが出なければ、#743 で出すと決めた前提が崩れている。
   */
  await page.locator(`${QUOTE_TABLE} td`).first().click({ button: 'right' });
  const toMd = menu.locator('[data-pkc-action="table-to-markdown"]');
  await expect(toMd, '引用の中で「Markdown の表にする」が出ていない').toHaveText(
    'Markdown の表にする',
  );
  await clickReal(page, toMd);
  await expect(
    page.locator(`${QUOTE_TABLE} [data-pkc-action="shape-cell"]`),
    '引用の中で markdown へ戻っていない',
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(QUOTE_TABLE), '戻したら引用から落ちた').toHaveCount(1);
  await expect(page.locator(QUOTE_TABLE), '戻したら升の字が消えた').toContainText('みかん');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
