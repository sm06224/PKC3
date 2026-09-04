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
      '---\ntel: 090-1234-5678\nemail: taro@example.com\norg: 例の会社\n---\n\n# 山田太郎\n\n打ち合わせは水曜が空いているとのこと。',
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
  await expect(
    row.locator('[data-pkc-field="contact-tel"]'),
    '電話が押せる宛先になっていない',
  ).toHaveAttribute('href', 'tel:09012345678');
  await expect(
    row.locator('[data-pkc-field="contact-mail"]'),
    'メールが押せる宛先になっていない',
  ).toHaveAttribute('href', 'mailto:taro@example.com');
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
    '取込完了の帯が出ない',
  ).toContainText('取込完了: 連絡先 1 件', { timeout: 10_000 });
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
 * 「取り消す」を出すのは**注意の面**(`notices.ts`)、押されたら実行するのは
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
test('🔴 取り込んだ直後に「取り消す」を押すと、入った分がごみ箱へ入る (#535 ②)', async ({
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

  await expect(page.locator('[data-pkc-region="status"]'), '取込完了の帯が出ない').toContainText(
    '取込完了: 連絡先 1 件',
    { timeout: 10_000 },
  );

  // 🔑 **注意が 0 件でも面が出る**(戻り道はそこに在る)
  const undo = page.locator('[data-pkc-action="undo-import"]');
  await expect(undo, '取り消す口が出ない(注意 0 件だと面ごと畳まれている)').toBeVisible({
    timeout: 10_000,
  });
  // ⚠ 押す前の説明は「起きること」で書く
  await expect(undo).toHaveAttribute('title', /ごみ箱/);

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
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('ごみ箱');
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
  await expect(pane, '足したら連絡先の面が消えた').toBeVisible();

  expect(errors, 'ページ例外が出ている').toEqual([]);
});
