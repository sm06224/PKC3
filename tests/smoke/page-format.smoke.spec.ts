import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **紙面フォーマット**(2026-08-08。user 裁定「読み幅は A4 と A3、フル HD と
 * 4:3 の縦横を選べるようにし、デフォは A4 縦」)。
 *
 * unit は「規則が在るか / 印が付いているか」しか見られない ── **実際に幅が変わるか**は
 * 実ブラウザでしか分からない(`--read-w` の解決・継承・`max-width:none` の効き方)。
 *
 * 観測点は 3 つ:
 * ① 既定(A4 縦)で段落が **672px 前後**に収まっている
 * ② フル HD にすると段落が**器いっぱいまで**広がる(= cap が外れる)
 * ③ ⚠ **表・図は動かない** ── 器の幅で実装していないことの証拠。ここが一緒に
 *    動いたら「器に cap を掛けた」実装に戻っている(全図が焼き直される設計)
 */
test('🔴 紙面を変えると散文の幅だけが変わる(表は動かない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  /**
   * ⚠ **表は内容に合わせて縮む**(shrink-to-fit)。短い表だと読み幅より**狭くなる**ので、
   * 「表に上限が掛かっていない」を幅の比較で見る主張が**成立しない fixture** になる
   * (2026-08-08 に実際に踏んだ ── 2 列の短い表で落ちた)。
   * 🔑 だから **読み幅を超える内容**を持たせる ── これで「掛かっていれば 672px で
   * 切られ、掛かっていなければ超える」が初めて判定になる。
   */
  const WIDE_ROW = '| ' + ['とても長い見出しの列'.repeat(2)].concat(Array.from({ length: 5 }, (_, i) => `第 ${i + 1} 列の値がここに入る`)).join(' | ') + ' |';
  const SEP = '|' + '---|'.repeat(6);
  await ta.fill(`よく読む段落。\n\n${WIDE_ROW}\n${SEP}\n${WIDE_ROW}\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const para = page.locator('[data-pkc-field="detail-body"] p').first();
  const table = page.locator('[data-pkc-field="detail-body"] table').first();
  await expect(para).toBeVisible();
  await expect(table).toBeVisible();

  const widthOf = async (loc: typeof para): Promise<number> =>
    (await loc.boundingBox())!.width;

  // ① 既定は A4 縦 = 42rem(672px)。⚠ 幅ぴったりに貼らない(font-size で動く)
  const a4 = await widthOf(para);
  expect(a4, `既定の読み幅が広すぎる(${a4}px)`).toBeLessThan(720);
  expect(a4, `既定の読み幅が狭すぎる(${a4}px)`).toBeGreaterThan(600);
  const tableA4 = await widthOf(table);
  // 表は読み幅の外(横に広いほど読める)── ここが 672px なら allow-list が壊れている
  expect(tableA4, '表に読み幅が掛かっている').toBeGreaterThan(a4);

  // ② 設定からフル HD にする(実際の導線)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="page-format-select"]').selectOption('fullhd');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  await expect.poll(async () => await widthOf(para), { timeout: 5000 }).toBeGreaterThan(a4 + 100);
  const wide = await widthOf(para);

  // ③ 🔴 表は 1px も動いていない(器の幅を動かしていない証拠)
  expect(await widthOf(table), '紙面で器の幅が動いている(図が焼き直される実装)').toBe(
    tableA4,
  );

  // ⚠ **戻せる**(片道だけ効く実装を落とす)。選び直したら元の幅へ
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="page-format-select"]').selectOption('a4-portrait');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect.poll(async () => await widthOf(para), { timeout: 5000 }).toBeLessThan(wide - 100);

  // ⚠ 選んだ紙面は**覚えている**(端末の設定)── 開き直しても続く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="page-format-select"]').selectOption('a3-landscape');
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator('[data-pkc-field="page-format-select"]')).toHaveValue('a3-landscape');

  expect(errors).toEqual([]);
});
