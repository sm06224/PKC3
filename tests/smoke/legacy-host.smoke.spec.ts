import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors } from './helpers';

/**
 * 🔴 **旧ビルドの本体タブでも起動する**(#286。2026-08-19 に実機で踏んだ)。
 *
 * 多重タブでは本体(holder)1 枚だけが worker を持ち、2 枚目以降は本体経由で
 * store を叩く。⚠ そして**本体が旧ビルドのことがある**(版が配られても、
 * 読み直したタブだけが新しくなる)。このとき新しいタブが投げる新しい op を
 * 旧 worker は知らず、`未知の op です: resolveContainer` で**起動が丸ごと落ちた**。
 *
 * ⚠ unit(`tests/adapter/resolve-container-compat.test.ts`)は**判断**しか見ない。
 * 「アプリが実際に開くか」は実ブラウザでしか確かめられない ── そこがまさに
 * 壊れていた場所である。
 *
 * 🔑 **旧 worker の真似方**: `Worker.prototype.postMessage` を包み、
 * `resolveContainer` だけを**その場で断る**(worker へは渡さない)。
 * 断り文は当時の worker が返した文字列そのもの。
 */
async function pretendLegacyWorker(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const orig = Worker.prototype.postMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Worker.prototype.postMessage = function (this: Worker, msg: any, ...rest: any[]) {
      if (msg && typeof msg === 'object' && msg.req && msg.req.op === 'resolveContainer') {
        // ⚠ 非同期で返す(同期に返すと pending へ入る前に届く)
        setTimeout(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: { id: msg.id, ok: false, error: 'Error: 未知の op です: resolveContainer' },
            }),
          );
        }, 0);
        return;
      }
      return orig.call(this, msg, ...rest);
    };
  });
}

test('🔴 本体が旧ビルドでも起動し、直し方が画面に出る (#286)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await pretendLegacyWorker(page);
  await gotoApp(page);

  // ① 🔴 **アプリが開く**(これが壊れていた)
  await expect(
    page.locator('[data-pkc-slot="root"]'),
    'boot が完了していない(旧本体で起動が落ちている)',
  ).toHaveAttribute('data-pkc-boot', 'ready');

  // ② 旧本体の器へ落ちている(旧ビルドは必ずこの綴りを使っていた)
  await expect(page.locator('[data-pkc-slot="root"]')).toHaveAttribute(
    'data-pkc-container',
    'default',
  );

  /**
   * ③ 🔴 **黙って劣化しない** ── 何をすれば直るかまで出す。
   * ⚠ 観測点は**状態の行だけ**(root 全体で探すと、お知らせのカードや本文に
   *   満たされて常に真になる ── CLAUDE.md §1)。
   */
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('古い版のタブが本体');

  // ④ 落ちた形跡が残っていない
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * ⚠ **対照群**(CLAUDE.md §4「効くはずの一手を先頭に置く」)。
 * 包まない回は採番済みの id が出る ── これが出ないなら、上の test は
 * 「もともと `default` だった」だけかもしれない(空振り)。
 */
test('対照群: 包まなければ採番済みの id が出る', async ({ page }) => {
  await gotoApp(page);
  const cid = await page.locator('[data-pkc-slot="root"]').getAttribute('data-pkc-container');
  expect(cid, '採番されていない').toMatch(/^c-[0-9a-f]{32}$/);
  await expect(page.locator('[data-pkc-region="status"]')).not.toContainText('古い版のタブが本体');
});
