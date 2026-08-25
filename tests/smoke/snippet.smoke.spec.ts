import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **雛形を短縮語 + `Tab` で挿す**(#196 / B-2)。
 *
 * 🔴 **unit では原理的に届かない層が 2 つ**:
 * ① **本物の `Tab`** ── textarea の `Tab` は既定で焦点移動なので、こちらが握らない
 *    回に**本当に焦点が動く**かは実ブラウザでしか見られない。⚠ 常に握る実装は
 *    unit では緑のまま(`defaultPrevented` を見る test は書けるが、実際に焦点が
 *    どこへ行くかは happy-dom では決まらない)
 * ② **雛形が worker 越しに届くか** ── unit は fake の `snippetScan` を差すので、
 *    SQL と protocol の往復は 1 度も通らない(CLAUDE.md §2)
 */
test('🔴 雛形を作って、短縮語 + Tab で本文に挿せる (#196)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① 雛形を 1 件作る(⚠ user と同じ手順 ── 種類を選んでから本体を押す)
  await createEntry(page, 'snippet');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta, '雛形が編集の形で開いていない').toBeVisible();
  await ta.fill('---\nabbr: addr\n---\n〒100-0000 ${宛名} 様');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ② 普通のノートを作って、短縮語を打つ
  await createEntry(page, 'text');
  await ta.fill('addr');
  // ⚠ 末尾へカーソルを置く(短縮語は**カーソルの手前**で当たる)
  await ta.press('End');
  await ta.press('Tab');

  // ③ 🔴 本文に入り、埋める印が**選ばれている**
  await expect(ta, '雛形が挿さっていない').toHaveValue('〒100-0000 ${宛名} 様');
  const sel = await ta.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    return t.value.slice(t.selectionStart, t.selectionEnd);
  });
  expect(sel, '埋める印が選ばれていない(打っても置き換わらない)').toBe('${宛名}');

  // ④ 打てば置き換わる(印ごと)
  await page.keyboard.type('山田');
  await expect(ta).toHaveValue('〒100-0000 山田 様');

  // ⑤ 🔴 保存しても残る(画面だけ変わって本文が元のまま、を作らない)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '保存した本文に雛形が残っていない').toHaveValue('〒100-0000 山田 様');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **当たらない `Tab` は焦点を移す**(#196 / B-2)。
 *
 * ⚠ これが**実ブラウザでしか見られない主張**である ── 「握らなかった」ことは
 *   unit でも見られるが、**その結果どこへ行くか**は既定動作なのでブラウザが決める。
 * ⚠ ここを壊すと、キーボードだけで使う人が**編集欄から出られなくなる**。
 */
test('🔴 短縮語が当たらない Tab は、これまでどおり次へ移る (#196)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('ふつうの文');
  await ta.press('End');
  await ta.press('Tab');

  await expect(ta, '本文が書き替わっている').toHaveValue('ふつうの文');
  const stillHere = await ta.evaluate((el) => document.activeElement === el);
  expect(stillHere, 'Tab を握ったまま(編集欄から出られない)').toBe(false);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
