import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';
import { withStateOnFail } from './state-dump';

/**
 * 🔴 **書いたノートが、連絡先として並ぶ**(#278 段①。user 指示 2026-08-19
 * 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ…、**連絡先**、
 * タイマー、アラートは組み込みアプリでリリースしたい」)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **保存 → worker の走査 → 面**の全段 ── unit は面と worker を別々に見ており、
 *    「保存したものが本当に集まるか」は**その間の配線**なので誰も通らない
 *    (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも書けない」)
 * ② **タブを開いたときに集める**という段取り(`REFRESH_CONTACT_SCAN` の発火)
 * ③ **押せる宛先が本当に `tel:` / `mailto:` になっているか**(実ブラウザの `href`)
 */
test('🔴 tel: を書いたノートが連絡先に並び、押せる宛先になる (#278 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live
    .locator('[data-pkc-field="row-source"]')
    .fill(
      '---\ntel: 090-1234-5678, 03-1111-2222\nemail: 山田 <taro@example.com>, hanako@example.com\norg: 例の会社\n---\n\n# 山田太郎\n\n打ち合わせは水曜が空いているとのこと。',
    );
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ⚠ **開くまで集めない**(連絡先を使わない人に全走査を負わせない)
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="contacts"]');
  const pane = page.locator('[data-pkc-browse-pane="contacts"]');
  await expect(pane, '連絡先のタブが開かない').toBeVisible();

  const row = pane.locator('[data-pkc-contact]');
  await withStateOnFail(page, '書いた連絡先が並ばない', async () => ({}), async () => {
    await expect(row, '連絡先が 1 件も並ばない').toHaveCount(1, { timeout: 10_000 });
  });

  // 🔴 **押せる宛先になっている**(実ブラウザの href で見る)
  // 🔴 依頼 285: 「,」区切りは 1 件ずつ押せ、`名前 <宛先>` は宛先だけが mailto: になる
  const tels = row.locator('[data-pkc-field="contact-tel"]');
  const mails = row.locator('[data-pkc-field="contact-mail"]');
  await expect(tels, '「,」区切りの電話が 2 件に割れていない').toHaveCount(2);
  await expect(tels.nth(0), '電話が押せる宛先になっていない').toHaveAttribute('href', 'tel:09012345678');
  await expect(tels.nth(1), '2 件目の電話が押せない(先頭の番号しか掛からない)').toHaveAttribute('href', 'tel:0311112222');
  await expect(mails, '「,」区切りのメールが 2 件に割れていない').toHaveCount(2);
  await expect(mails.nth(0), '`名前 <宛先>` が宛先だけの mailto: になっていない').toHaveAttribute(
    'href',
    'mailto:taro@example.com',
  );
  await expect(mails.nth(1), '2 件目のメールが押せない').toHaveAttribute('href', 'mailto:hanako@example.com');
  // 🔴 .vcf の EMAIL / TEL にも名前を載せない(実ブラウザの download の中身)
  const [vcfDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-field="contacts-export"]'),
  ]);
  const vcfText = readFileSync((await vcfDl.path())!, 'utf8');
  expect(vcfText).toContain('EMAIL;TYPE=internet:taro@example.com');
  expect(vcfText).toContain('EMAIL;TYPE=internet:hanako@example.com');
  expect(vcfText).toContain('TEL;TYPE=voice:03-1111-2222');
  expect(vcfText, '.vcf の宛先に名前と <> が残っている').not.toContain('<');
  // ⚠ **字は書いたとおり**(記号を落とすのは href だけ)
  await expect(row).toContainText('090-1234-5678');
  await expect(row, '所属が出ていない').toContainText('例の会社');

  /**
   * 🔴 **名前を押すと、そのノートが中央に開く**(左の列はそのまま)。
   * ⚠ ここが #278 で「中央の面にしない」と決めた所である ──
   *   開いても**連絡先の面は消えない**。
   */
  await clickReal(page, '[data-pkc-field="contact-name"]');
  /**
   * ⚠ **本文に出るのは frontmatter の外**である ── `tel:` は囲みの中なので
   *   画面には出ない。だから見るのは**本文の字**(見出し)にする
   *   (1 稿目は `090-…` を探して落ちた ── 面が正しく、観測点が間違っていた)。
   */
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '名前を押してもノートが開かない',
  ).toContainText('打ち合わせは水曜');
  await expect(pane, 'ノートを開いたら連絡先の面が消えた').toBeVisible();

  /**
   * 🔴 **連絡先を開いたまま、ノートの側で番号を直して保存すると、一覧も変わる**(#1087)。
   * ⚠ 直す前は一覧が古いままで、「vCard で書き出す」が**古い番号を書いていた**
   *   (集め直すのはタブを開いたときだけだった)。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  // ⚠ 番号は frontmatter(「この文書の情報」の札)に在り、行の原文(row-source)には出ない。
  //   札の「情報を編集」から直す(1 稿目は row-source へ全文を fill し、末尾へ別の frontmatter を追記しただけだった)
  await clickReal(page, '[data-pkc-field="fm-edit"]');
  await page
    .locator('[data-pkc-field="fm-source"]')
    // 🔴 #1087: 手で書いた、記号の無い 0 始まりの番号(frontmatter では数として読まれ、先頭の 0 が落ちていた)
    .fill('---\ntel: 09099990000\nemail: taro@example.com\norg: 例の会社\n---');
  await clickReal(page, '[data-pkc-field="fm-commit"]');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(row, '保存したのに連絡先の一覧が古い番号のまま').toContainText('09099990000', {
    timeout: 10_000,
  });
  await expect(row).not.toContainText('090-1234-5678');
  await expect(
    row.locator('[data-pkc-field="contact-tel"]'),
    '先頭の 0 が落ちて別の番号へかかる',
  ).toHaveAttribute('href', 'tel:09099990000');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **vCard の出し入れ**(#278 段③)。unit では届かない層:
 * ① 実 file picker(accept に .vcf が無いと受理器が動いてもファイルを選べない)
 * ② 取り込んだノートが**実 sqlite の再読込と worker の走査**を通って連絡先に並ぶ
 * ③ **実ブラウザの download** で .vcf が本当に落ち、中身が vCard である
 */
test('🔴 .vcf を取り込むと連絡先に並び、「vCard で書き出す」で .vcf が落ちてくる (#278 段③)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① accept に .vcf が無いと、受理器が動いてもファイルを選べない
  const accept = await page.locator('[data-pkc-field="import-input"]').getAttribute('accept');
  expect(accept).toContain('.vcf');

  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:山田太郎',
    'ORG:例の会社',
    'TEL;TYPE=CELL:090-1234-5678',
    'EMAIL:taro@example.com',
    'END:VCARD',
    '',
  ].join('\r\n');
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: '連絡先.vcf',
    mimeType: '',
    buffer: Buffer.from(vcf, 'utf8'),
  });

  // ② 取込の完了が帯に出る(⚠ 一覧の既定はフォルダ表示なので entry-list では見ない)
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '取り込み完了の帯が出ない',
  ).toContainText('取り込み完了: 連絡先 1 件', { timeout: 10_000 });
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="contacts"]');
  const pane = page.locator('[data-pkc-browse-pane="contacts"]');
  const row = pane.locator('[data-pkc-contact]');
  await withStateOnFail(page, '取り込んだ連絡先が並ばない', async () => ({}), async () => {
    await expect(row, '連絡先が 1 件も並ばない').toHaveCount(1, { timeout: 10_000 });
  });
  await expect(row.locator('[data-pkc-field="contact-name"]')).toContainText('山田太郎');

  // ③ 書き出し ── 実ブラウザの download で .vcf が落ち、中身が vCard である
  const exp = pane.locator('[data-pkc-field="contacts-export"]');
  await expect(exp, '書き出しの口が出ない').toHaveText('vCard で書き出す(1 件)');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-field="contacts-export"]'),
  ]);
  // ⚠ 名前は見ない(この headless は非 ASCII の download 名を捨てる)── 中身で見る
  const path = await download.path();
  expect(path, 'download が落ちてこない').toBeTruthy();
  const body = readFileSync(path!, 'utf8');
  expect(body).toContain('BEGIN:VCARD\r\nVERSION:3.0');
  expect(body).toContain('FN:山田太郎');
  expect(body).toContain('TEL;TYPE=voice:090-1234-5678');

  /**
   * ④ 「名前 番号」の混在検索(#1087)── 番号だけで全員に当たらない。
   * 同じ番号の頭(090-1234)を持つ連絡先を 2 人足し、「山田 090」で山田だけが残ることを見る。
   * 対照群:番号だけ「090」なら 3 人とも残る(絞りが効いていないのではない)。
   */
  const more = [
    ['佐藤花子', '090-1234-0000'],
    ['鈴木一郎', '090-1234-9999'],
  ]
    .map(([fn, tel]) => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${fn}`, `TEL;TYPE=CELL:${tel}`, 'END:VCARD', ''].join('\r\n'))
    .join('');
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: '追加.vcf',
    mimeType: '',
    buffer: Buffer.from(more, 'utf8'),
  });
  await expect(row, '台の前提:足した 2 人が並ばない').toHaveCount(3, { timeout: 10_000 });
  const filter = page.locator('[data-pkc-field="entry-filter"]');
  await filter.fill('090');
  await expect(row, '対照群:番号だけの絞りで 3 人残らない').toHaveCount(3);
  await filter.fill('山田 090');
  await expect(row, '「山田 090」で山田以外にも当たっている').toHaveCount(1, { timeout: 5000 });
  await expect(row.locator('[data-pkc-field="contact-name"]')).toContainText('山田太郎');

  expect(errors, '例外が出ている').toEqual([]);
});

/**
 * 🔴 **絞り込みが残っていても、行き止まりにしない**(#536 ②)。
 *
 * > 一覧タブで「会議」と打ったまま連絡先タブへ来ると当たりが 0 件になり、
 * > **「vCard で書き出す」ボタンごと画面から消えて**いた。
 *
 * ⚠ **unit では「ボタンが在る」しか見られない** ── ここで見るのは
 *   **押したら本当に戻るか**(絞りが state から消え、連絡先と書き出しの口が戻る)。
 */
test('🔴 絞り込みで 0 件でも「絞りを外す」から戻れる (#536 ②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live
    .locator('[data-pkc-field="row-source"]')
    .fill('---\ntel: 090-1234-5678\n---\n\n# 山田太郎\n\n本文。');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="contacts"]');
  const pane = page.locator('[data-pkc-browse-pane="contacts"]');
  await expect(pane.locator('[data-pkc-contact]'), '前提が崩れた(連絡先が並ばない)').toHaveCount(1);
  // ⚠ **前提** ── 絞り込みが無いうちは「絞りを外す」は出ていない
  await expect(
    pane.locator('[data-pkc-field="contacts-clear-filter"]'),
    '絞り込みが無いのに「絞りを外す」が出ている',
  ).toHaveCount(0);

  // 🔴 当たらない語で絞る ── ここで書き出しの口ごと消えていた
  await page.locator('[data-pkc-field="entry-filter"]').fill('当たらない語');
  await expect(pane.locator('[data-pkc-contact]'), '絞り込みが効いていない').toHaveCount(0);
  await expect(
    pane.locator('[data-pkc-field="contacts-export"]'),
    '前提が崩れた(書き出しの口が残っている)',
  ).toHaveCount(0);

  const clear = pane.locator('[data-pkc-field="contacts-clear-filter"]');
  await expect(clear, '行き止まりのまま(進める道が無い)').toBeVisible();
  await clickReal(page, '[data-pkc-field="contacts-clear-filter"]');

  // 🔑 **押したら本当に戻る**(連絡先も、書き出しの口も)
  await expect(pane.locator('[data-pkc-contact]'), '押しても連絡先が戻らない').toHaveCount(1);
  await expect(
    pane.locator('[data-pkc-field="contacts-export"]'),
    '押しても書き出しの口が戻らない',
  ).toBeVisible();
  await expect(
    page.locator('[data-pkc-field="entry-filter"]'),
    '絞り込みの欄が空になっていない',
  ).toHaveValue('');

  expect(errors, 'ページ例外が出ている').toEqual([]);
});

/**
 * 🔴 **取り込みを取り消せる**(#535 ②)。
 *
 * ## unit では原理的に届かない ── **配線の両端が別々に test されている**から
 *
 * 「取り込みを取り消す」を出すのは**注意の面**(`notices.ts`)、押されたら実行するのは
 * **root の委譲**(`binder.ts`)、記憶を持つのは `import-undo.ts`、
 * そして 3 つを結ぶのは **`main.ts`** である。
 * ⚠ `main.ts` は**原文を読む test からしか実行されない**ので、
 *   そこを消す変異は「字が在るか」でしか捕まらない(弱いと自覚した検査)。
 * 🔑 だから**実物どうしを繋いで 1 本**通す(CLAUDE.md §7
 *   「A と B が合意していることは、A の test にも B の test にも書けない」)。
 *
 * ⚠ 観測点は**面の外**にする ── 面が畳まれただけでは「消えた」と言えない。
 *   連絡先の一覧が **1 → 0** に戻ることまで見る。
 */
test('🔴 取り込んだ直後に「取り込みを取り消す」を押すと、入った分がゴミ箱へ入る (#535 ②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:取り消される人',
    'TEL;TYPE=CELL:090-0000-0000',
    'END:VCARD',
    '',
  ].join('\r\n');
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'undo.vcf',
    mimeType: '',
    buffer: Buffer.from(vcf, 'utf8'),
  });

  await expect(page.locator('[data-pkc-region="status"]'), '取り込み完了の帯が出ない').toContainText(
    '取り込み完了: 連絡先 1 件',
    { timeout: 10_000 },
  );

  // 🔑 **注意が 0 件でも面が出る**(戻り道はそこに在る)
  const undo = page.locator('[data-pkc-action="undo-import"]');
  await expect(undo, '取り消す口が出ない(注意 0 件だと面ごと畳まれている)').toBeVisible({
    timeout: 10_000,
  });
  // ⚠ 押す前の説明は「起きること」で書く
  await expect(undo).toHaveAttribute('title', /ゴミ箱/);

  // 🔑 **前提** ── 取り消す前は連絡先に 1 件並んでいる(空振り防止)
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="contacts"]');
  const pane = page.locator('[data-pkc-browse-pane="contacts"]');
  await expect(pane.locator('[data-pkc-contact]'), '前提: 取り込んだ 1 件が並んでいない').toHaveCount(
    1,
    { timeout: 10_000 },
  );

  await undo.click();

  // ⚠ **面の外**で確かめる ── 入った分が消えている
  await expect(
    pane.locator('[data-pkc-contact]'),
    '取り消したのに連絡先が残っている',
  ).toHaveCount(0, { timeout: 10_000 });
  // 🔑 **どこへ行ったかを言っている**(黙って消さない)
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('ゴミ箱');
  // ⚠ 押した後に口が残らない(2 度目は何も消さないので、置いておくと dead click)
  await expect(
    page.locator('[data-pkc-action="undo-import"]'),
    '取り消した後も口が残っている',
  ).toHaveCount(0);

  expect(errors, 'ページ例外が出ている').toEqual([]);
});

/**
 * 🔴 **連絡先の面から、その場で 1 件足す**(#278 段③。user 裁定 2026-09-04)。
 *
 * ## unit では原理的に届かない層
 *
 * ① **作る → 実 sqlite に着く → worker の走査 → 面**の全段 ── unit は走査を stub で
 *    置き換えている。「書込が着いてから集め直す」(`settle`)が**本物の worker で**効くかは
 *    ここでしか見えない(CLAUDE.md §7「読みが書込を追い越す」を踏んでいれば、
 *    押した直後の一覧に出ない)
 * ② 実ブラウザの `href`(`tel:` / `mailto:`)── 書いた原値から押せる宛先になること
 */
test('🔴 「足す」で書いた人が一覧に並び、押せる宛先になる (#278 段③)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 🔴 #1087: 中央に開いているノートと、左の探す欄の字を用意する(足しても動かないこと)
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill('# 開いたままのノート\n\n本文です。');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toContainText('開いたままのノート');
  await page.locator('[data-pkc-field="entry-filter"]').fill('鈴木');

  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="contacts"]');
  const pane = page.locator('[data-pkc-browse-pane="contacts"]');
  await expect(pane, '連絡先のタブが開かない').toBeVisible();
  await expect(pane.locator('[data-pkc-contact]'), '前提: 0 件で始まる').toHaveCount(0);

  await pane.locator('[data-pkc-field="contacts-quick-name"]').fill('鈴木花子');
  await pane.locator('[data-pkc-field="contacts-quick-tel"]').fill('080-9876-5432');
  await pane.locator('[data-pkc-field="contacts-quick-email"]').fill('hanako@example.com');
  await pane.locator('[data-pkc-field="contacts-quick-org"]').fill('例の商店');
  await clickReal(page, '[data-pkc-browse-pane="contacts"] [data-pkc-action="contacts-quick-add"]');

  // ① 書込が着いてから集め直され、一覧に並ぶ
  const row = pane.locator('[data-pkc-contact]');
  await withStateOnFail(page, '足した連絡先が並ばない', async () => ({}), async () => {
    await expect(row, '足したのに一覧に並ばない').toHaveCount(1, { timeout: 10_000 });
  });
  await expect(row.locator('[data-pkc-field="contact-name"]')).toContainText('鈴木花子');
  await expect(row, '所属が出ていない').toContainText('例の商店');
  // ② 押せる宛先になっている(字は書いたまま、href は原値から組む)
  await expect(row.locator('[data-pkc-field="contact-tel"]')).toHaveAttribute('href', 'tel:08098765432');
  await expect(row.locator('[data-pkc-field="contact-mail"]')).toHaveAttribute(
    'href',
    'mailto:hanako@example.com',
  );
  // 🔑 通ったら欄は空(続けて足せる)
  await expect(pane.locator('[data-pkc-field="contacts-quick-name"]')).toHaveValue('');
  // ⚠ 面は奪わない ── 中央は本文のまま、連絡先の面も消えない
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  // 🔴 #1087: 開いていたノートは新しい連絡先に置き換わらず、左の探す欄の字も残る
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '足したら中央のノートが新しい連絡先に替わった',
  ).toContainText('開いたままのノート');
  await expect(page.locator('[data-pkc-field="entry-filter"]'), '足したら左の探す欄が消えた').toHaveValue('鈴木');
  await expect(pane, '足したら連絡先の面が消えた').toBeVisible();

  expect(errors, 'ページ例外が出ている').toEqual([]);
});

/**
 * 🔴 **連絡先が 0 件と分かっている間、左の「連絡先」タブは「⋯」の下へ回り、そこから開ける。1 件でもあれば元の位置に戻る**
 * (#475 項目 5)。入口は消えない(片道にしない)。
 * ⚠ 「まだ集めていない」(開くまで走らない)では回さない ── 対照群として、最初は元の位置にある。
 */
test('🔴 連絡先が空なら「⋯」の下へ回り、そこから開ける。1 件あれば戻る (#475 項目 5)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  const tab = page.locator('[data-pkc-region="browse-tabs"] [data-pkc-browse="contacts"]');
  const more = page.locator('[data-pkc-region="browse-tabs"] [data-pkc-field="bar-more"]');

  // 対照群: まだ集めていない間は元の位置にある
  await expect(tab).toBeVisible();
  await expect(tab).not.toHaveAttribute('data-pkc-overflow', '');

  // 開くと集める。0 件の案内(作り方)が出る
  await clickReal(page, tab);
  await expect(page.locator('[data-pkc-browse-pane="contacts"]')).toContainText('連絡先はまだありません', {
    timeout: 10_000,
  });
  // 開いている間は回さない(どこに居るか分からなくなる)
  await expect(tab).not.toHaveAttribute('data-pkc-overflow', '');

  // 別のタブへ移ると、0 件と分かっているので「⋯」の下へ回る
  await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-browse="filer"]');
  await expect(tab, '空の連絡先のタブが「⋯」へ回らない').toHaveAttribute('data-pkc-overflow', '');
  await expect(more).toBeVisible();

  // 「⋯」から開ける(入口は消えない)
  await clickReal(page, more);
  await clickReal(
    page,
    '[data-pkc-region="context-menu"] [data-pkc-action="set-browse"][data-pkc-browse="contacts"]',
  );
  await expect(page.locator('[data-pkc-browse-pane="contacts"]')).toBeVisible();
  await expect(tab, '開いたタブは元の位置に居る').not.toHaveAttribute('data-pkc-overflow', '');

  // 1 件入れると、別のタブへ移っても元の位置のまま
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:山田太郎', 'TEL;TYPE=CELL:090-1234-5678', 'END:VCARD', ''].join('\r\n');
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: '連絡先.vcf',
    mimeType: '',
    buffer: Buffer.from(vcf, 'utf8'),
  });
  await expect(page.locator('[data-pkc-browse-pane="contacts"] [data-pkc-contact]')).toHaveCount(1, {
    timeout: 10_000,
  });
  await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-browse="filer"]');
  await expect(tab, '1 件あるのに「⋯」の下のまま').not.toHaveAttribute('data-pkc-overflow', '');
  await expect(tab).toBeVisible();

  expect(errors, '例外が出ている').toEqual([]);
});
