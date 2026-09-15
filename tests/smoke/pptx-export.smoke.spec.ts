/**
 * 🔴 **PowerPoint 書き出しの実ブラウザ検証**(#187 段⑤)。
 *
 * 設計 doc の「検証の型」:
 * > 🔴 **経路ごとに smoke を持つ**。PKC2 の pptx が画像を 1 枚も出さないまま残ったのは、
 * > docx にだけ smoke があったからである
 *
 * ⚠ unit(`tests/features/pptx-export.test.ts`)は**組み立ての規則**を見る。ここは
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

test('🔴 情報ペインの PowerPoint で .pptx が落ちてきて、見出しでスライドが切れる(#187 段⑤)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'スライド試験');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    [
      '# 扉の題',
      '',
      '## 扉の副題',
      '',
      '### 節のタイトル',
      '',
      'ふつうの段落と **太字**。',
      '',
      '1. 番号付き',
      '- 点',
      '',
      '| 見出し | 値 |',
      '| --- | --- |',
      '| 行 | 1 |',
      '',
      /**
       * 🔴 **板 2 枚と、その間の線**(#530 段③e)。
       * ⚠ **この筋書きに足した理由**:ここまで、書き出しの smoke の fixture に
       *   `.pkc-place` も `.pkc-line` も **1 つも無かった** ── つまり
       *   「板と線を書いたノートを書き出す」という当の動線は、実ブラウザで
       *   **1 度も通っていなかった**(緑だったのは別の物の回帰である)。
       * 🔑 **新しい起動は増やさない** ── 既に在るこの筋書きの末尾へ伸ばす。
       * ⚠ 線の塊の中に**字**を入れてある ── 読む画面に 1 文字も出ない字が
       *   書き出しにだけ現れる、という段③a の実害をここで止める。
       */
      ':::format{#今日 .pkc-place x=0 y=0 w=200 h=100}',
      '今日',
      ':::',
      '',
      ':::format{#明日 .pkc-place x=400 y=0 w=200 h=100}',
      '明日',
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
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-pptx"]'),
  ]);
  // ⚠ 名前は**アプリが決めた値**で見る(この headless は非 ASCII の download 名を
  //    捨てるので、`suggestedFilename` は観測点にしない ── CLAUDE.md §4)
  const path = await download.path();
  expect(path, 'file が落ちてきていない').not.toBeNull();
  const bytes = readFileSync(path!);
  expect(bytes.length, '0 バイトの file が落ちてきた').toBeGreaterThan(1000);

  const text = bytes.toString('utf-8');
  expect(text.slice(0, 2), 'zip ではない').toBe('PK');
  for (const part of [
    '[Content_Types].xml',
    'ppt/presentation.xml',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml',
    // 🔴 **見出しで切れている** ── 1 枚しか無ければ切れ方が死んでいる
    'ppt/slides/slide2.xml',
    // 🔴 **板は 1 枚で 1 スライド**(#530 段①)── 3 枚目がそれである
    'ppt/slides/slide3.xml',
  ])
    expect(text, `${part} が入っていない`).toContain(part);
  // ⚠ 4 枚目は無い(扉 + 節 + 板 の 3 枚)── 空のスライドを挟んでいないこと(段④)
  expect(text, '空のスライドが挟まっている').not.toContain('ppt/slides/slide4.xml');
  expect(text, '扉の題が入っていない').toContain('扉の題');
  expect(text, '副題が入っていない').toContain('扉の副題');
  expect(text, '本文が入っていない').toContain('ふつうの段落と');
  expect(text, '番号付きが点に化けている').toContain('buAutoNum');
  expect(text, '表が格子になっていない').toContain('<a:tbl>');
  /**
   * 🔴 **板の線が、繋がったコネクタとして入っている**(#530 段③e)。
   * ⚠ **`<p:cxnSp>` が在るだけでは足りない** ── 座標だけの線でも見た目は同じだが、
   *   受け取った人が付箋を動かしても**付いてこない**(user が求めているのは
   *   「ぐりぐり動かせる」ことなので、それでは要望を 1 つも満たさない)。
   */
  expect(text, '線が図形として入っていない').toContain('<p:cxnSp>');
  expect(text, '線が板に繋がっていない(座標だけの線になっている)').toContain('<a:stCxn');
  expect(text, '線の行き先が繋がっていない').toContain('<a:endCxn');
  // 🔴 読む画面に 1 文字も出ない字が、配る物にだけ現れていないこと(段③a の実害)
  expect(text, '画面に出ない字が書き出しに漏れている').not.toContain('線の中の見えない字');
  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **図は絵で入る。原文が等幅で出ない**(#187 段⑤)。
 *
 * ⚠ この経路は **unit では届かない** ── 焼くのは `main.ts` が渡す産出器
 * (mermaid 本体 + canvas)で、そこは node の unit から呼べない。
 * 🔑 **PKC2 が落とした当の穴がここ**である(pptx の図が 1 枚も出ないまま残った)。
 */
test('🔴 mermaid の図が PowerPoint にベクタで入る(原文が出ない)(#187 段⑤)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'スライドの図');
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
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-pptx"]'),
  ]);
  const path = await download.path();
  expect(path, 'file が落ちてきていない').not.toBeNull();
  const text = readFileSync(path!).toString('utf-8');
  // 🔴 **図はベクタ(EMF)で入る**(#238 と同じ向き)
  expect(text, '図がベクタで入っていない').toContain('ppt/media/figure1.emf');
  expect(text, 'ラスタに戻っている').not.toContain('ppt/media/figure1.png');
  // ⚠ 宣言が無いと PowerPoint は種類を決められず、file ごと拒む
  expect(text, '目録に emf の宣言が無い').toContain('<Default Extension="emf"');
  expect(text, 'スライドが図を指していない').toContain('<a:blip r:embed=');
  // 🔴 **原文が等幅で出ていない**(PKC2 の失敗の顔)
  expect(text, '図の原文が本文に出ている').not.toContain('graph TD');
  expect(text, '図が「描けませんでした」になっている').not.toContain('描けませんでした');
  expect(errors, 'pageerror が出た').toEqual([]);
});
