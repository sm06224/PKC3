import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors } from './helpers';

/**
 * ショートカットキーと、その割り当て直し(#256。user 指示 2026-08-18)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **実ブラウザが配る `code`** ── unit は `code` を**自分で書いて**渡している。
 *    実際の打鍵で同じ名前が来るかは、ここでしか確かめられない
 *    (`Alt+[` は mac で `key` が化ける ── だから `code` に賭けている)。
 * 2. **既定動作を止められているか** ── `Ctrl+S` でブラウザの保存が開かない、
 *    `Ctrl+N` で新しい窓が開かない。`preventDefault` の効き目は DOM に出ない。
 * 3. **捕まえている最中に、アプリへ打鍵が漏れないか** ── capture 段と
 *    バブリング段の順序は happy-dom でも動くが、**実際の listener の並び**は
 *    実機で見るのがいちばん確か。
 * 4. **設定 → 効く鍵**の往復が、器を作り直さずに成立するか。
 */
test('🔴 既定の鍵が実機で効き、設定で割り当て直すと入れ替わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  const shell = page.locator('[data-pkc-region="shell"]');
  await expect(rows).toHaveCount(0);

  // ① 既定(Ctrl+N)でノートができる ── **実際の打鍵**で
  await page.keyboard.press('Control+n');
  await expect(rows, 'Ctrl+N が実機で効いていない').toHaveCount(1);
  // ⚠ 作ると**編集に入る**ので、確定して `ready` へ戻す ── 戻さないと以降の
  //    「作られない」は**編集中だから断られた**だけになる(1 稿目がそれで偽陽性だった)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.keyboard.press('Control+n');
  await expect(rows, '2 回目が作られない ── 以降の否定の検査が無意味になる').toHaveCount(2);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ② 面の切替(Alt+3 = 設定)。⚠ **数字キーの `code`(Digit3)**が実機で来るかの検査でもある
  await page.keyboard.press('Alt+3');
  await expect(page.locator('[data-pkc-region="settings-body"]')).toBeVisible();

  // ③ 設定の中に割当の一覧が在り、既定が見えている
  const row = page.locator('[data-pkc-field="keymap-row"][data-pkc-command="toggle-sidebar"]');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-pkc-field="keymap-chord"]')).toHaveCount(2);

  // ④ 🔴 捕まえている最中の打鍵は**アプリに届かない**
  //    (`Ctrl+N` を割り当てようとしただけでノートが増える、を落とす)
  await clickReal(page, '[data-pkc-field="keymap-assign"][data-pkc-command="edit-entry"]');
  await page.keyboard.press('Control+n');
  await expect(rows, '割り当てようとしただけでノートができた').toHaveCount(2);
  // ぶつかる相手なので断られる(= 断り文が出る)
  await expect(
    page.locator('[data-pkc-field="keymap-row"][data-pkc-command="edit-entry"]'),
  ).toContainText('ノートを作る');

  // ⑤ 既定を 2 つとも外して、別の鍵を割り当てる
  //    ⚠ 観測点はペインの畳み具合(属性)── **何度でも押せて、状態を持ち越さない**
  for (const chord of ['Alt+BracketLeft', 'Mod+Backslash']) {
    await clickReal(
      page,
      `[data-pkc-field="keymap-drop"][data-pkc-command="toggle-sidebar"][data-pkc-chord="${chord}"]`,
    );
  }
  await clickReal(page, '[data-pkc-field="keymap-assign"][data-pkc-command="toggle-sidebar"]');
  await page.keyboard.press('Alt+g');
  await expect(row.locator('[data-pkc-field="keymap-chord"]')).toHaveCount(1);
  await expect(row).toContainText('Alt + G');

  // ⑥ 🔴 入れ替わったことを**効き目**で見る(表示だけ変わって効かない、を落とす)
  await expect(shell).not.toHaveAttribute('data-pkc-hidden-panes', /sidebar/);
  await page.keyboard.press('Alt+BracketLeft');
  await expect(shell, '外した既定がまだ効いている').not.toHaveAttribute(
    'data-pkc-hidden-panes',
    /sidebar/,
  );
  await page.keyboard.press('Alt+g');
  await expect(shell, '割り当てた鍵が効いていない').toHaveAttribute(
    'data-pkc-hidden-panes',
    /sidebar/,
  );
  await page.keyboard.press('Alt+g');
  await expect(shell).not.toHaveAttribute('data-pkc-hidden-panes', /sidebar/);

  // ⑦ ヘルプの一覧も同じ表から出ている(PKC2 はここが手書きでズレた)
  await page.keyboard.press('F1');
  await expect(
    page.locator('[data-pkc-field="help-key-chords"][data-pkc-command="toggle-sidebar"]'),
  ).toHaveText('Alt + G');

  // ⑧ すべて既定に戻す → 既定が戻り、割り当てた鍵は効かなくなる
  await page.keyboard.press('Alt+3');
  await clickReal(page, '[data-pkc-field="keymap-reset-all"]');
  await page.keyboard.press('Alt+g');
  await expect(shell, '戻したのに割り当てた鍵が生きている').not.toHaveAttribute(
    'data-pkc-hidden-panes',
    /sidebar/,
  );
  await page.keyboard.press('Alt+BracketLeft');
  await expect(shell, '既定に戻っていない').toHaveAttribute('data-pkc-hidden-panes', /sidebar/);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **ブラウザの既定を止めている**(`preventDefault`)。
 *
 * ⚠ 観測点は「押した event が `defaultPrevented` で戻ってくること」──
 * 保存ダイアログや新しい窓は playwright から見えないので、**アプリが止めた事実**を
 * 直接採る(CLAUDE.md §4「観測点はアプリ自身の信号にする」)。
 */
test('🔴 近道はブラウザの既定を止める(保存ダイアログ / 新しい窓を開かせない)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await page.evaluate(() => {
    const seen: { key: string; prevented: boolean }[] = [];
    (window as unknown as { __keys: typeof seen }).__keys = seen;
    // ⚠ **バブリングの最後**で見る ── アプリの listener より後に来る位置
    window.addEventListener('keydown', (e) => {
      seen.push({ key: e.key, prevented: e.defaultPrevented });
    });
  });

  await page.keyboard.press('Control+n');
  await page.keyboard.press('Alt+3');
  // ⚠ 対照群 ── 誰も割り当てていない鍵は**止めない**(全部止める実装を落とす)
  await page.keyboard.press('Control+Shift+F9');

  const seen = await page.evaluate(
    () => (window as unknown as { __keys: { key: string; prevented: boolean }[] }).__keys,
  );
  const prevented = (k: string) => seen.find((s) => s.key.toLowerCase() === k)?.prevented;
  /**
   * ⚠ 見ているのは「**アプリが既定を止めた**」ことだけである(着地前レビュー 10)。
   * ブラウザが予約している鍵(`Ctrl+N` / `Ctrl+T` / `Ctrl+W`)を実際に奪えるかは
   * **ページからは確かめられない** ── そこは user の実機で見る話で、ここでは
   * 「アプリが受けて止めている」までを主張する(計器の名前を主張より広げない)。
   */
  expect(prevented('n'), 'Ctrl+N をアプリが受けて止めていない').toBe(true);
  expect(prevented('3'), 'Alt+3 をアプリが受けて止めていない').toBe(true);
  expect(prevented('f9'), '割り当てていない鍵まで止めている').toBe(false);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
