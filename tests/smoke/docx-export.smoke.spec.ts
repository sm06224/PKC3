/**
 * 🔴 **Word 書き出しの実ブラウザ検証**(#187 段①)。
 *
 * 設計 doc の「検証の型」:
 * > 🔴 **経路ごとに smoke を持つ**。PKC2 の pptx が画像を 1 枚も出さないまま残ったのは、
 * > docx にだけ smoke があったからである
 *
 * ⚠ unit(`tests/features/docx-export.test.ts`)は**組み立ての規則**を見る。ここは
 * **押して落ちてくるか**だけを見る ── 2 つを分けないと、「XML は正しいのに配線が
 * 死んでいて何も落ちてこない」(= user から見た dead click)が緑のまま通る。
 *
 * 🔑 観測点は **落ちてきた file の中身**にする。「ダウンロードが始まった」だけを見ると、
 *    0 バイトの壊れた zip でも通る。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeEach(async ({ page }) => {
  // ⚠ 本文を入れる道具として全文 textarea を使うので、設定で split を明示する
  await useSplitEditor(page);
});

test('🔴 情報ペインの Word で .docx が落ちてきて、本文が中に入っている(#187)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'ワード試験');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    [
      '# 見出し',
      '',
      'ふつうの段落と **太字**。',
      '',
      '本文のアイコン :home: の行',
      '',
      '- 箇条書き',
      '  - 入れ子',
      '',
      '- [x] 済んだ項目',
      '- [ ] 未了の項目',
      '',
      /**
       * 🔴 **板 2 枚と、その間の線**(#530 段①/段③e)。
       * ⚠ ここまで、書き出しの smoke の fixture に `.pkc-place` も `.pkc-line` も
       *   **1 つも無かった** ── つまり「板と線を書いたノートを Word へ出す」という
       *   当の動線は、実ブラウザで**1 度も通っていなかった**。
       * 🔑 **新しい起動は増やさない** ── 既に在るこの筋書きの末尾へ伸ばす。
       * ⚠ 線の塊に**字**を入れてある ── 読む画面に 1 文字も出ない字が
       *   Word にだけ現れる、という段③a の実害をここで止める。
       */
      ':::format{#今日 .pkc-place x=0 y=0 w=200 h=100}',
      '今日',
      ':::',
      '',
      ':::format{.pkc-line from=今日 to=明日}',
      '線の中の見えない字',
      ':::',
    ].join('\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-docx"]'),
  ]);
  // ⚠ 名前は**アプリが決めた値**で見る(この headless は非 ASCII の download 名を
  //    捨てるので、`suggestedFilename` は観測点にしない ── CLAUDE.md §4)
  const path = await download.path();
  expect(path, 'file が落ちてきていない').not.toBeNull();
  const bytes = readFileSync(path!);
  expect(bytes.length, '0 バイトの file が落ちてきた').toBeGreaterThan(1000);

  /**
   * 🔴 **開いて中を見る。** zip の中の名前は素の bytes に平文で入る(deflate せず
   * store で書いているため、本文の文字列もそのまま入る)ので、ここでは
   * **part の名前と本文の文字**を直接探す。⚠ 「zip らしきものが落ちた」では、
   * 中身が空でも通る。
   */
  const text = bytes.toString('utf-8');
  expect(text.slice(0, 2), 'zip ではない').toBe('PK');
  for (const part of [
    'word/document.xml',
    'word/numbering.xml',
    'word/styles.xml',
    // ページ番号(#187 段③)── 宣言だけして中身が無いと Word ごと開けない
    'word/footer1.xml',
  ])
    expect(text, `${part} が入っていない`).toContain(part);
  expect(text, '見出しが入っていない').toContain('見出し');
  expect(text, '本文が入っていない').toContain('ふつうの段落と');
  expect(text, '箇条書きが numbering を指していない').toContain('<w:numId');
  /**
   * 🔴 **#853 本文のアイコン(`:home:`)は Word に画像(PNG)で入る**。
   * ⚠ 焼くのは実ブラウザの canvas + 書体(unit は node で届かない)。入らないと Word で黙って消える。
   * 🔑 この時点の本文に画像の添付は無い ── `<w:pict>` はアイコンの分だけ。
   */
  expect(text, '🔴 アイコンが Word に画像として入っていない').toContain('<w:pict>');
  expect(text, '🔴 アイコンが入れられなかった').not.toContain('入れられませんでした');
  expect(text, '🔴 アイコンの PNG が media に入っていない').toMatch(/word\/media\/[^"<]*\.png/);
  /**
   * 🔴 **板と線は Word に何も足さない**(#530 段①/段③e)。
   * ⚠ Word に自由配置の面は無いので、位置も線も出さない ── だが**中身の字は出る**。
   * 🔑 線の塊に書いた字は**読む画面に 1 文字も出ない**ので、Word にだけ現れたら
   *   それは user がいちばん気づけない壊れ方である(段③a の実害)。
   */
  expect(text, '板の字が落ちている').toContain('今日');
  expect(text, '画面に出ない字が Word に漏れている').not.toContain('線の中の見えない字');
  /**
   * 🔴 **束 K2(#1163 依頼 144・280・53-2)**。同じ道中で見る(起動は増やさない)。
   * ① 1 行目にノートの題名が大きな見出しで入る ② チェックリストは ☑ / ☐ で、黒丸(箇条書きの印)を付けない
   * ③ 書き出した知らせに「ブロック」という数え方が出ない ④ 本文が空のノートは断られ、file は落ちない
   */
  const docXml = text.slice(text.indexOf('<w:body'));
  const titleAt = docXml.indexOf('ワード試験');
  expect(titleAt, '前提:題名が document.xml に入っている').toBeGreaterThan(-1);
  expect(titleAt, '🔴 題名が本文より前(1 行目)に入っていない').toBeLessThan(docXml.indexOf('見出し'));
  expect(docXml.slice(Math.max(0, titleAt - 200), titleAt), '🔴 題名が見出しの書式で入っていない').toContain('Heading1');
  const doneAt = docXml.indexOf('済んだ項目');
  const todoAt = docXml.indexOf('未了の項目');
  expect(doneAt, '前提:チェックの項目が入っている').toBeGreaterThan(-1);
  expect(docXml.slice(Math.max(0, doneAt - 300), doneAt), '🔴 済みの項目に ☑ が付いていない').toContain('☑');
  expect(docXml.slice(Math.max(0, todoAt - 300), todoAt), '🔴 未了の項目に ☐ が付いていない').toContain('☐');
  // 黒丸なし:チェックの段落は箇条書きの番号(numId)を指さない ── 段落の頭から項目の字までを見る
  for (const [label, at] of [['済み', doneAt], ['未了', todoAt]] as const) {
    const pStart = docXml.lastIndexOf('<w:p>', at) >= 0 ? docXml.lastIndexOf('<w:p>', at) : docXml.lastIndexOf('<w:p ', at);
    expect(docXml.slice(pStart, at), `🔴 ${label}のチェック項目に黒丸(numId)が付いている`).not.toContain('<w:numId');
  }
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status, '書き出しの知らせが出ていない').toContainText('Word で書き出しました');
  expect(await status.innerText(), '🔴 知らせに「ブロック」という数え方が残っている').not.toContain('ブロック');

  /**
   * 🔴 **束 A1(依頼 142 ②)**。箇条書きの項目・表のマス・文の途中に置いた画像は、**置いた位置のまま**同じ段落の中へ入る。
   * ⚠ 直す前は、囲む塊の上や表の後ろへ移していた ── 「画像が入る」だけを見る assert は、位置がずれていても通る。
   * 🔑 新しい起動は足さない ── 同じノートに画像を添付し、本文を書き換えて、もう一度書き出す。
   */
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'ず.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  const attached = page.locator('[data-pkc-region="detail"] img[data-pkc-asset-key]');
  await expect(attached, '前提:画像が添付されて本文に入った').toHaveCount(1, { timeout: 15_000 });
  const key = await attached.first().getAttribute('data-pkc-asset-key');
  expect(key, '前提:画像の鍵が読める').toBeTruthy();
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    [
      '- 項目の画像 ![項目の図](asset:' + key + ') 項目のあと',
      '',
      '| 見出し | 値 |',
      '| --- | --- |',
      '| マスの画像 ![マスの図](asset:' + key + ') | 2 |',
      '',
      '文の途中 ![文中の図](asset:' + key + ') の続き',
    ].join('\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const [download2] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-docx"]'),
  ]);
  const path2 = await download2.path();
  expect(path2, '2 回目の file が落ちてきていない').not.toBeNull();
  const xml2 = readFileSync(path2!).toString('utf-8');
  const doc2 = xml2.slice(xml2.indexOf('<w:body'));
  expect(doc2, '🔴 画像が入れられなかった').not.toContain('入れられませんでした');
  expect((doc2.match(/<w:pict>/g) ?? []).length, '🔴 画像が 3 枚入っていない').toBe(3);
  const paras = doc2.split('</w:p>');
  const itemP = paras.find((p) => p.includes('項目の画像'));
  expect(itemP, '前提:項目の段落が在る').toBeDefined();
  expect(itemP, '🔴 項目の中の画像が、その項目の段落に入っていない').toContain('<w:pict>');
  expect(itemP, '🔴 画像を含む項目が箇条書きでなくなった').toContain('<w:numId');
  expect(itemP!.indexOf('<w:pict>'), '🔴 画像が項目の字の前後を入れ替えた').toBeGreaterThan(itemP!.indexOf('項目の画像'));
  expect(itemP!.indexOf('項目のあと'), '🔴 項目の「あと」の字が画像より前に出ている').toBeGreaterThan(itemP!.indexOf('<w:pict>'));
  const cellTc = doc2.split('</w:tc>').find((c) => c.includes('マスの画像'));
  expect(cellTc, '前提:マスが在る').toBeDefined();
  expect(cellTc, '🔴 マスの中の画像が、そのマスに入っていない(表の後ろへ移っている)').toContain('<w:pict>');
  const midP = paras.find((p) => p.includes('文の途中'));
  expect(midP, '前提:文の段落が在る').toBeDefined();
  expect(midP, '🔴 文の途中の画像が、同じ段落に入っていない').toContain('<w:pict>');
  expect(midP!.indexOf('の続き'), '🔴 文の続きが画像より前に出ている').toBeGreaterThan(midP!.indexOf('<w:pict>'));

  // ④ 本文が空のノート ── 断られ、ダウンロードが起きない
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  let downloaded = false;
  page.on('download', () => {
    downloaded = true;
  });
  await clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-docx"]');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '🔴 本文が空のノートが断られていない',
  ).toContainText('本文が空なので、Word には書き出しません');
  await page.waitForTimeout(500);
  expect(downloaded, '🔴 本文が空なのにダウンロードが起きた').toBe(false);
  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **図は絵で入る。原文が等幅で出ない**(#187 段②)。
 *
 * ⚠ この経路は **unit では届かない** ── 焼くのは `main.ts` が渡す産出器
 * (mermaid 本体 + canvas)で、そこは node の unit から呼べない。
 * 段① はここが素通しで、器の中の**原文が code 塊**になっていた
 * (PKC2 に「図は原文が黙って等幅で出る」と記録されている失敗そのもの)。
 */
test('🔴 mermaid の図が Word にベクタで入る(原文が出ない)(#187 段② / #238)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  // 🔴 暗い配色のまま書き出す(束 K1)── 図は明るい配色で紙(Word)に入る。同じ道中に ```svg の囲みも置く
  await page.evaluate(() => document.documentElement.setAttribute('data-pkc-theme', 'dark'));
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '図の試験');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    '```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n\n' +
      '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#c00"/></svg>\n```\n',
  );
  // ⚠ **焼けたことを先に見る**(器が ready になるまで待つ)── 待たずに書き出すと
  //    「まだ焼けていないから入らなかった」のか「配線が死んでいる」のか割れない
  await expect(
    page.locator('[data-pkc-region="editor-preview"] [data-pkc-mermaid-src]'),
  ).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30_000 });
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-docx"]'),
  ]);
  const path = await download.path();
  expect(path, 'file が落ちてきていない').not.toBeNull();
  const text = readFileSync(path!).toString('utf-8');
  // 🔴 **図はベクタ(EMF)で入る**(#238、user 指示 2026-08-17)。
  //    ⚠ ラスタ(.png)に戻っていたら、それは `renderFigureVector` の配線が落ちている
  expect(text, '図がベクタで入っていない').toContain('word/media/figure1.emf');
  expect(text, 'ラスタに戻っている').not.toContain('word/media/figure1.png');
  // ⚠ VML なので `r:id`(DrawingML の `r:embed` ではない)
  expect(text, 'document が図を指していない').toContain('r:id="rIdM1"');
  // 🔴 **原文が等幅で出ていない**(PKC2 の失敗の顔)
  expect(text, '図の原文が本文に出ている').not.toContain('graph TD');
  expect(text, '図が「描けませんでした」になっている').not.toContain('描けませんでした');
  // 🔴 svg の囲みが「埋め込み枠」の 1 行にならず、2 枚目の図として入る(束 K1)
  expect(text, '🔴 svg の囲みが図として入っていない(2 枚目の図が無い)').toMatch(/word\/media\/figure2\.(emf|png)/);
  expect(text, '🔴 svg の囲みが埋め込み枠の案内になっている').not.toContain('埋め込み枠');
  expect(text, '🔴 svg の原文が本文に出ている').not.toContain('<svg');
  expect(errors, 'pageerror が出た').toEqual([]);
});
