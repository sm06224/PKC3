/**
 * smoke: つながり図に「本文の名前つき csv」が出て、線が 0 本の理由を言う
 * (#918 段⑤d-2 / 段⑤d-3)。
 *
 * ⚠ 依頼された動線を通す spec が既存に無かったので新設した(pkc3-smoker の判断)。
 *   `attach.smoke.spec.ts` の巨大な 1 test は「添付の csv/xlsx を調べる」道中に
 *   段⑤d-1(繋ぐ)までは通すが、**本文だけに書いた名前つき csv**(添付を経由しない)
 *   と、**繋ぐ前の「線 0 本」の理由文**は 1 度も通っていない。
 *
 * 動線①:「ノートを 1 枚作り、本文に名前つきの csv の囲みを書く →
 *   SQL で調べる を開く → 構造を見る を押す →
 *   『棚卸(本文の表・2 行)』の四角が出る → 名前を押すと下の欄に
 *   `select * from 棚卸` が入る → 列(品名)を押すと `select 品名 from 棚卸` になる →
 *   走らせると中身が表に出る」。
 *
 * 動線②:「線が 0 本のとき、理由(外部キーを宣言していない)と次の一手
 *   (「繋ぐ」を押して列を 2 つ)が出る → 『繋ぐ』を入にすると、理由は残ったまま
 *   次の一手の誘いだけ消える(すぐ下の案内が代わりに言うので、二重に言わない)」。
 *
 * ⚠ **新しい起動は増やさない**(#820 の規律)── ②は①が開いたままの
 *   同じ SQL の面・同じ図の道中で確かめる(`gotoApp` を 2 度呼ばない)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useListBrowse, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

test('🔴 本文の名前つき csv が図の四角として出て引ける。線 0 本の理由も出て、繋ぐと誘いだけ消える (#918 段⑤d-2/d-3)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  // ⚠ 見出しの行数は「見出しを除いた行(データ行)」を数える(csv-tables.ts の
  //   `rows: grid.length - 1`)── だから「2 行」を確かめるにはデータ行を 2 つ書く。
  await page.keyboard.type('```csv name=棚卸\n品名,数\nりんご,3\nみかん,5\n```\n');
  /**
   * 🔴 **受けられない名前の囲みも 1 つ書く**(#980)。
   *
   * ⚠ 名前が受けられないと**表になりません**。そのとき user に見えるのは
   *   「表が出てこない」だけなので、#681 段③ で**理由**(`csv_tables.why`)を
   *   出せるようにしてある ── 🔴 **ところが画面に届いているかを
   *   実ブラウザで 1 度も見ていなかった**。
   * 🔑 **起動を増やさない** ── 新しい spec を足すと 1 起動 = 以後すべての回に
   *   約 1.6 秒。だから**この道中に足す**(#980 の設計)。
   * 🔴 **1 稿目の名前は空振りだった**(2026-09-16。実ブラウザで 0 行が返って分かった)。
   *   囲みの属性は `info.trim().split(/\s+/)` で割るので、
   *   `name=だめ な 名前` は **`name=だめ` としか読まれない** ──
   *   ⚠ そして `だめ` は**通ってしまう名前**である(`why` が空)。
   *   だから目録は 0 行を返し、**assert が何も守っていなかった**。
   * 🔑 だから**本当に断られる字を、実装に当てて選んだ**:
   *
   *   | 書いた名前 | 読まれる名前 | why |
   *   |---|---|---|
   *   | `name=だめ な 名前` | `だめ` | 🔴 **空(通る)** |
   *   | `name=だめ!` | `だめ!` | 🟢「名前に使えるのは文字・数字・_ だけです」 |
   *
   * ⚠ **空白を入れない** ── 入れた時点で、そこから先は名前ではなくなる。
   */
  await page.keyboard.type('```csv name=だめ!\na,b\n1,2\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * ⚠ 空振り防止 ── 本文の囲みが、そもそも表として読めていること
   *   (読めていなければ、以降の「図に四角が出ない」が別の理由で起きてしまう)。
   *
   * 🔴 **囲みは 2 つとも表になる**(2026-09-16 に実ブラウザで測って分かった)。
   * ⚠ 直す前のこの行は `toBeVisible()` で、囲みを 1 つ足したら
   *   **strict mode 違反**(2 要素に解決)で落ちた。
   * 🔑 そして**それが教えてくれたことのほうが大きい** ── 本文を描く側
   *   (`features/markdown/csv-table.ts`)は **`name=` を 1 度も検めていない**
   *   (`csvTableNameWhy` / `validCsvTableName` の呼び口が 0 件)。
   *   つまり「名前が受けられない」で失うのは**本文の見た目ではなく、
   *   SQL から名前で引けること**である ── だから理由は
   *   `csv_tables.why`(= SQL の目録)に出る。
   */
  const bodyTable = page.locator('[data-pkc-field="detail-body"] table');
  await expect(bodyTable, '本文の csv が 2 つとも表になっていない(前提が崩れている)').toHaveCount(
    2,
    { timeout: 10_000 },
  );
  await expect(bodyTable.first()).toContainText('りんご');
  // 🔴 受けられない名前の囲みも、**本文には出る**(上の docstring)
  await expect(bodyTable.nth(1), '受けられない名前の囲みが本文に出ていない').toContainText('ab');

  /**
   * ── ① SQL で調べる を開く(この PKC のノートが既定 ── 何も選ばない)。
   * ⚠ この面は押しボタンを持たない(binder.ts「SQL の面も押しボタンを持たない」)
   *   ので、`attach.smoke.spec.ts` と同じくアドレスで開く。
   */
  await page.evaluate(() => {
    location.hash = '#pkc?view=sql';
  });
  const sqlPane = page.locator('[data-pkc-view-pane="sql"]');
  await expect(sqlPane, 'SQL の面が開かない').toBeVisible({ timeout: 15_000 });

  // ── 構造を見る
  await clickReal(page, '[data-pkc-action="sql-er-toggle"]');
  const erBox = page.locator('[data-pkc-field="sql-er-box"]');
  const csvBox = erBox.filter({ hasText: '棚卸' });
  await expect(csvBox, '本文の表の四角が出ない').toHaveCount(1, { timeout: 15_000 });

  // 🔴 見出しの字がちょうど「棚卸(本文の表・2 行)」であること(種類と行数)
  const head = csvBox.locator('[data-pkc-field="sql-er-table"]');
  await expect(head, '見出しの字が違う').toHaveText('棚卸(本文の表・2 行)');

  // ⚠ 大きさを持っている(0px の箱は「出ている」と言えない)
  const rect = (await csvBox.first().boundingBox())!;
  expect(rect.width, '四角に幅が無い').toBeGreaterThan(80);
  expect(rect.height, '四角に高さが無い').toBeGreaterThan(30);

  // ── 名前を押す → `select * from 棚卸`
  const sqlInput = page.locator('[data-pkc-field="sql-input"]');
  await page.fill('[data-pkc-field="sql-input"]', '');
  await clickReal(page, head);
  await expect(sqlInput, '名前を押しても select * from 棚卸 にならない').toHaveValue(
    'select * from 棚卸',
  );

  // ── 列(品名)を押す → `select 品名 from 棚卸`
  const colOf = (name: string) =>
    csvBox.locator('[data-pkc-field="sql-er-column"]').filter({ hasText: name }).first();
  await clickReal(page, colOf('品名'));
  await expect(sqlInput, '列を押しても select 品名 from 棚卸 にならない').toHaveValue(
    'select 品名 from 棚卸',
  );

  // ── 走らせる → 中身が表に出る
  await clickReal(page, '[data-pkc-action="run-sql"]');
  const sqlTable = page.locator('[data-pkc-field="sql-table"]');
  await expect(sqlTable, '本文の表から行が返らない').toBeVisible({ timeout: 10_000 });
  await expect(sqlTable).toContainText('りんご');

  /**
   * ── ② 線が 0 本のとき、理由が出る(#918 段⑤d-3)。
   *
   * ⚠ 前提として測る:この PKC 自身の表(entries / relations 等)は外部キーを
   *   1 本も宣言していない(`src` を全数 grep して 0 件)ので、
   *   `declared === 0 && mine === 0` の場合分けに落ちるはず。
   * ⚠ 対照群として「箱は 2 つ以上ある」ことを先に見る ── 1 つしか無い回は
   *   別の文言(「繋ぐ相手がいません」)になるので、ここで前提を検算する。
   */
  await expect
    .poll(async () => erBox.count(), {
      message: '箱が 2 つ以上ない(前提が崩れている ── 別の文言になるはず)',
      timeout: 5_000,
    })
    .toBeGreaterThanOrEqual(2);
  const zero = page.locator('[data-pkc-field="sql-er-zero"]');
  await expect(zero, '線 0 本の理由が出ない').toContainText(
    'この DB は、表どうしの繋がり(外部キー)を 1 つも宣言していません。',
  );
  await expect(zero, '次の一手(「繋ぐ」への誘い)が出ていない').toContainText(
    '上の「繋ぐ」を押して列を 2 つ押すと、自分で繋げます。',
  );

  // ── 「繋ぐ」を入にする → 理由は残ったまま、誘いだけ消える(二重に言わない)
  await clickReal(page, '[data-pkc-action="sql-er-connect-toggle"]');
  const connectBtn = page.locator('[data-pkc-field="sql-er-connect"]');
  await expect(connectBtn, '「繋ぐ」が入にならない').toHaveAttribute('aria-pressed', 'true');

  await expect(zero, '繋ぐを入にしたら、理由まで消えた').toContainText(
    'この DB は、表どうしの繋がり(外部キー)を 1 つも宣言していません。',
  );
  await expect(zero, '繋ぐを入にしたのに、次の一手の誘いが残っている(二重に言っている)').not.toContainText(
    '上の「繋ぐ」を押して列を 2 つ押すと',
  );
  // 🔑 代わりに、すぐ下の案内がその役目を引き継ぐ
  const hint = page.locator('[data-pkc-field="sql-er-connect-hint"]');
  await expect(hint, 'すぐ下の案内が代わりに言っていない').toContainText(
    '繋ぎたい列を 2 つ押してください',
  );

  // ⚠ 対照群 ── 「繋ぐ」を切に戻すと、誘いが元へ戻る(退行が無いこと)
  await clickReal(page, '[data-pkc-action="sql-er-connect-toggle"]');
  await expect(connectBtn, '「繋ぐ」が切にならない').toHaveAttribute('aria-pressed', 'false');
  await expect(zero, '切に戻したのに誘いが戻らない').toContainText(
    '上の「繋ぐ」を押して列を 2 つ押すと、自分で繋げます。',
  );

  /**
   * ── ③ 🔴 **受けられなかった理由が、画面に届いている**(#980)。
   *
   * ⚠ 単体(`storage-worker.test.ts`)は `why` に理由が入ることを見ているが、
   *   **画面まで来ているか**は実ブラウザで 1 度も見ていなかった。
   * 🔑 **同じ道中で見る**(`gotoApp` を増やさない)。
   */
  await page.fill('[data-pkc-field="sql-input"]', '');
  await page.fill(
    '[data-pkc-field="sql-input"]',
    "SELECT name, why FROM csv_tables WHERE why <> ''",
  );
  await clickReal(page, '[data-pkc-action="run-sql"]');

  /**
   * ⚠ **空振り防止** ── 受けられない囲みは**この spec の中で作っている**
   *   (上の本文)。別の spec に頼ると、走る順で対照群が空になり、
   *   **空の集合は何を assert しても通る**。
   * 🔑 だから「行が在ること」と「字が合っていること」を**両方**見る。
   */
  await expect(sqlTable, '目録が引けない').toBeVisible({ timeout: 10_000 });
  /**
   * ⚠ **0 行で通らないようにする** ── 直す前の稿は目録が **0 行**を返し、
   *   見出し(`name` / `why`)しか無いのに `toContainText` が
   *   「まだ来ていないだけ」と 5 秒待って落ちた。
   * 🔑 **まず行が在ることを見る**(`sql-row` を数える)── 0 行なら
   *   「理由が出ていない」ではなく「**そもそも 1 件も載っていない**」と読める。
   */
  const whyRows = page.locator('[data-pkc-field="sql-table"] tbody tr');
  await expect(whyRows, '目録に 1 行も載っていない(囲みが断られていない = 空振り)').toHaveCount(
    1,
    { timeout: 10_000 },
  );
  await expect(sqlTable, '受けられなかった名前が目録に出ていない').toContainText('だめ!');
  await expect(sqlTable, '🔴 なぜ受けられなかったのかが画面に出ていない').toContainText(
    '名前に使えるのは文字・数字・_ だけです',
  );

  /**
   * ⚠ **対照群** ── 受けられた名前(`棚卸`)は、この目録に**出ない**
   *   (`WHERE why <> ''` なので)。🔑 これが無いと
   *   「全部の行を出しているだけ」でも通ってしまう。
   */
  await expect(sqlTable, '受けられた名前まで「理由あり」に混ざっている').not.toContainText('棚卸');

  expect(errors, `想定外の console/pageerror が出た: ${JSON.stringify(errors)}`).toEqual([]);
});
