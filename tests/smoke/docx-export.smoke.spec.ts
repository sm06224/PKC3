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
    ['# 見出し', '', 'ふつうの段落と **太字**。', '', '- 箇条書き', '  - 入れ子'].join('\n'),
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
  for (const part of ['word/document.xml', 'word/numbering.xml', 'word/styles.xml'])
    expect(text, `${part} が入っていない`).toContain(part);
  expect(text, '見出しが入っていない').toContain('見出し');
  expect(text, '本文が入っていない').toContain('ふつうの段落と');
  expect(text, '箇条書きが numbering を指していない').toContain('<w:numId');
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
test('🔴 mermaid の図が Word に絵として入る(原文が出ない)(#187 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '図の試験');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    '```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n',
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
  expect(text, '図の PNG が入っていない').toContain('word/media/figure1.png');
  expect(text, 'document が図を指していない').toContain('r:embed="rIdM1"');
  // 🔴 **原文が等幅で出ていない**(PKC2 の失敗の顔)
  expect(text, '図の原文が本文に出ている').not.toContain('graph TD');
  expect(text, '図が「描けませんでした」になっている').not.toContain('描けませんでした');
  expect(errors, 'pageerror が出た').toEqual([]);
});
