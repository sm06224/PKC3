/**
 * 🔴 **1 ノートを「相手に渡せる 1 枚」で書き出す**(#491)。
 *
 * > user 報告 2026-08-27:「右クリックで気づきましたが、
 * > **書き出しに閲覧配布用HTMLがないのは残念**ですね」
 *
 * ⚠ 在ったのは**設定 → 書き出しと片づけ**の「閲覧用 HTML」だけで、それは
 *   **コレクション全部**を 1 枚にする物だった ── ノート 1 件を渡す口は
 *   **どこにも無かった**。
 *
 * 🔑 観測点は**落ちてきた file の中身**にする ── 「ダウンロードが始まった」だけを
 *   見ると、0 バイトでも空の HTML でも通る(`docx-export` と同じ作法)。
 * 🔴 **対照群を同じ test に置く** ── 隣の `書き出す`(`.pkc3.zip`)と**別の物**で
 *   あることを見る。置かないと「HTML の押し口が `.pkc3.zip` を落としている」
 *   (= 押した人にしか見えない取り違え)が緑のまま通る。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  useSplitEditor,
} from './helpers';

test.beforeEach(async ({ page }) => {
  // ⚠ 行の在り処と編集の道具は `context-menu.smoke.spec.ts` と同じにする
  //    (2 つ目の作法を作らない)
  await useSplitEditor(page);
});

/** ⚠ 2 件作る ── 1 件だけだと「全部書き出した」と見分けがつかない(空振り防止)。 */
const OTHER_TITLE = '渡さないほうのノート';
const OTHER_BODY = 'これは相手に渡らないはずの本文である。';

test('🔴 情報ペインの「閲覧用 HTML」で、そのノートだけの 1 枚が落ちてくる (#491)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ── 対照群になるノート(こちらは書き出さない)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', OTHER_TITLE);
  await page.fill('[data-pkc-field="editor-body"]', OTHER_BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  // 渡さないほうの住所(渡すノートの本文から指して「入っていない先」を作る)
  const otherLid = await page
    .locator('[data-pkc-action="copy-entry-ref"][data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(otherLid, '渡さないノートの住所が取れない(前提が崩れた)').toBeTruthy();

  // ── 渡すノート
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '配る資料');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ['# 配る見出し', '', 'ふつうの段落と **太字**。', '', '- 箇条書き', '', '読めない日付 @2026-1-5x の件', '', `[入っていない先](entry:${otherLid})`, '', 'アイコン :home: の行'].join('\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-html"]'),
  ]);
  const path = await download.path();
  expect(path, 'file が落ちてきていない').not.toBeNull();
  const text = readFileSync(path!, 'utf-8');

  /**
   * 🔴 **`.pkc3.zip` ではないこと** ── 隣の `書き出す` と押し口を取り違えていない。
   * ⚠ zip は先頭 2 バイトが `PK` である。
   */
  expect(text.slice(0, 2), 'zip が落ちてきた(押し口を取り違えている)').not.toBe('PK');
  expect(text.slice(0, 200).toLowerCase(), 'HTML ではない').toContain('<!doctype html');
  expect(text.length, '空の HTML が落ちてきた').toBeGreaterThan(1000);

  // ── そのノートが入っている
  expect(text, '題名が入っていない').toContain('配る資料');
  expect(text, '見出しが入っていない').toContain('配る見出し');
  expect(text, '本文が入っていない').toContain('ふつうの段落と');
  // 🔴 読めない日付の案内は本文を読む画面だけ ── 配る file には入らない(台帳 #1852 束 E1)。字そのものは本文として残る
  expect(text, '読めない日付の字が本文から消えた').toContain('2026-1-5x');
  expect(text, '画面用の「日付として読めません」が配る HTML に入った').not.toContain('日付として読めません');

  /**
   * 🔴 **1 件だけであること**(#491 の「このノートを渡す」)。
   * ⚠ ここが無いと、`singleEntrySource` を通さずコレクション全部を出す実装でも
   *   上の assert は全部通る ── **絞り込みが効いていること**は別に見る。
   */
  expect(text, '渡さないはずのノートが入っている').not.toContain(OTHER_TITLE);
  expect(text, '渡さないはずの本文が入っている').not.toContain(OTHER_BODY);

  /**
   * 🔴 **入っていないノートへのリンクは、薄い字と点線で「押せない」を見せる**(依頼 77-3)。
   * ⚠ 見るのは配った file を実際に開いた姿(`app.css` ではなく焼いた CSS)── 閲覧側が作る要素なので
   *   アプリには対応物が無い。
   */
  const viewer = await page.context().newPage();
  // 拡張子が .html でないと、ブラウザは字のまま見せる ── 開ける名前で保存し直す
  const viewFile = join(tmpdir(), `pkc3-entry-html-${process.pid}.html`);
  await download.saveAs(viewFile);
  await viewer.goto(`file://${viewFile}`);
  const outside = viewer.locator('[data-pkc-outside-note]');
  await expect(outside, '入っていないノートへのリンクが「押せない印」になっていない').toHaveCount(1);
  await expect(outside).toHaveText('入っていない先');
  expect(
    await outside.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, line: cs.textDecorationLine, style: cs.textDecorationStyle };
    }),
    '薄い字・点線の下線になっていない',
  ).toEqual({ opacity: '0.6', line: 'underline', style: 'dotted' });
  /**
   * 🔴 **#853 本文のアイコン(`:home:`)が、配った file を別ページで開いても豆腐でない**。
   * ⚠ 対照群に「書体に無い符号位置」を同じ書体で描いて、画素が違うことで見る
   *   (豆腐も送り幅は同じなので、幅だけでは割れない ── `icon-font.smoke.spec.ts` と同じ作法)。
   * 🔑 新しい起動は足さない ── 上で開いた配布 file の同じ page で見る。
   */
  const icon = viewer.locator('[data-pkc-icon][data-pkc-symbol="home"]');
  await expect(icon, '配った HTML に :home: の器が出ていない').toHaveCount(1);
  const iconOut = await icon.evaluate(async (el) => {
    const before = getComputedStyle(el, '::before');
    const family = before.fontFamily;
    const content = before.content.replace(/^["']|["']$/g, '');
    await document.fonts.ready;
    const FAMILY = '"PKC Symbols"';
    const finger = (ch: string): string => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.font = `48px ${FAMILY}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(ch, 8, 32);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      let h = '';
      for (let i = 3; i < d.length; i += 4) h += d[i]! > 0 ? '1' : '0';
      return h;
    };
    return {
      family,
      content,
      loaded: document.fonts.check(`16px ${FAMILY}`, content),
      glyph: finger(content),
      tofu: finger(String.fromCodePoint(0xf000)),
    };
  });
  expect(iconOut.family, '🔴 ::before の書体が埋め込みの PKC Symbols でない').toContain('PKC Symbols');
  expect(iconOut.content.length, '🔴 ::before の字が空(符号位置が焼かれていない)').toBeGreaterThan(0);
  expect(iconOut.loaded, '🔴 配った file の書体が読み込まれていない').toBe(true);
  expect(iconOut.glyph.includes('1'), '🔴 描いた絵が空').toBe(true);
  expect(iconOut.glyph, '🔴 アイコンが豆腐(未定義の符号位置と同じ絵)になっている').not.toBe(iconOut.tofu);
  /**
   * 🔴 台帳 #1852 束 S1(依頼 77-2 B)── 幅 360px で開くと、一覧が本文の上に出て、ノートを選ぶと一覧が閉じる。
   * 🔑 起動を増やさない ── 上で開いた配布 file を、同じ page で狭くする。
   */
  await viewer.setViewportSize({ width: 360, height: 800 });
  const navBox = await viewer.locator('nav').boundingBox();
  const mainBox = await viewer.locator('main').boundingBox();
  expect(navBox, '一覧(nav)が取れない').not.toBeNull();
  expect(mainBox, '本文(main)が取れない').not.toBeNull();
  expect(navBox!.y + navBox!.height, `360px で一覧が本文の上に出ていない(nav ${JSON.stringify(navBox)} / main ${JSON.stringify(mainBox)})`)
    .toBeLessThanOrEqual(mainBox!.y + 1);
  expect(mainBox!.width, '360px で本文が潰れている').toBeGreaterThan(300);
  await expect(viewer.locator('#pkc-dnotes'), '前提: 一覧は開いている').toHaveJSProperty('open', true);
  await viewer.locator('#pkc-list button').first().click();
  await expect(viewer.locator('#pkc-dnotes'), 'ノートを選んでも一覧が閉じない(スマホ幅)').toHaveJSProperty('open', false);
  await viewer.close();

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **右クリックからも出る**(#491)── user が気づいたのはこの経路である。
 *
 * ⚠ 字は `features/entry-actions.ts` が 1 か所で持つので、情報ペインと
 *   右クリックで**別の呼び名**になることはない ── ここで見るのは
 *   「**その口が右クリックにも並んでいる**」ことだけである。
 */
test('🔴 右クリックのメニューにも「閲覧用 HTML」が並ぶ (#491)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  // ⚠ 題名は ASCII(headless は非 ASCII の download 名を捨てる ── 下の .md の名前の観測点のため)
  await page.fill('[data-pkc-field="editor-title"]', 'handout');
  await page.fill('[data-pkc-field="editor-body"]', '本文。');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const row = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').first();
  await expect(row, '行が出ていない').toBeVisible();
  await row.click({ button: 'right' });
  const item = page.locator(
    '[data-pkc-region="context-menu"] [data-pkc-action="export-entry-html"]',
  );
  await expect(item, '右クリックに「閲覧用 HTML」が無い').toBeVisible();
  // ⚠ **対照群** ── 隣の「書き出す」も並んでいる(メニューそのものが出ている証拠)
  await expect(
    page.locator('[data-pkc-region="context-menu"] [data-pkc-action="export-entry"]'),
    'メニューが出ていない(空振り)',
  ).toBeVisible();
  expect(await item.textContent(), '呼び名が字の正本と違う').toContain('閲覧用 HTML');

  /**
   * 🔴 **同じメニューの「Markdown で書き出す」で、本文がそのまま落ちる**(#1440)── 新しい起動を足さず、
   *   この道中に載せる。観測点は**落ちた file の中身と名前**(「落ち始めた」だけでは空の file でも通る)。
   * 🔴 右の列(情報ペイン)にも**出る**(2026-10-11 に反転。以前は「出ない」を pin していた)── 対照群は隣の
   *   「閲覧用 HTML」が右の列に出ていること(描けていることの証拠)。
   */
  await expect(
    page.locator('[data-pkc-region="inspector"] [data-pkc-action="export-entry-html"]'),
    '右の列が描けていない(空振り)',
  ).toBeVisible();
  await expect(
    page.locator('[data-pkc-region="inspector"] [data-pkc-action="export-entry-markdown"]'),
    '右の列に「Markdown で書き出す」が出ていない',
  ).toBeVisible();
  const md = page.locator(
    '[data-pkc-region="context-menu"] [data-pkc-action="export-entry-markdown"]',
  );
  await expect(md, '右クリックに「Markdown で書き出す」が無い').toBeVisible();
  expect(await md.textContent()).toContain('Markdown で書き出す');
  const [mdDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="export-entry-markdown"]'),
  ]);
  const mdPath = await mdDownload.path();
  expect(mdPath, 'file が落ちてきていない').not.toBeNull();
  expect(readFileSync(mdPath!, 'utf-8'), '本文がそのまま入っていない').toBe('本文。');
  expect(mdDownload.suggestedFilename(), '<題名>-<日付>.md で落ちていない').toMatch(/^handout-\d{8}\.md$/);

  // 🔴 右の列の同じ口でも、同じ file が落ちる(2026-10-11。利用者は右クリックを知らなくても見つけられる)
  const [paneDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-markdown"]'),
  ]);
  const panePath = await paneDownload.path();
  expect(panePath, '右の列から file が落ちてきていない').not.toBeNull();
  expect(readFileSync(panePath!, 'utf-8'), '右の列の書き出しで本文がそのまま入っていない').toBe('本文。');
  expect(paneDownload.suggestedFilename()).toMatch(/^handout-\d{8}\.md$/);

  expect(errors, 'pageerror が出た').toEqual([]);
});
