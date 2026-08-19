import { test, expect, type Page } from '@playwright/test';
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

/**
 * 🔴 **user が実際に踏んだ形**(2026-08-19「複数タブの起動時だと思う」)。
 *
 * 上の test は「**同じタブの中の** worker が旧い」形だった。実機で起きるのは
 * **本体タブが旧ビルド / 2 枚目が新ビルド**で、断りが **proxy を跨いで**届く形である
 * ── 版が配られても、読み直したタブだけが新しくなるので、こちらが本命。
 *
 * ⚠ 「同じ原因だから通るはず」で済ませない ── 断りの文字列が proxy の
 *   `res` を通っても保たれるかは、**通してみないと分からない**
 *   (CLAUDE.md §7「同じ問いに答える口が 2 つある」)。
 */
test('🔴 本体タブが旧ビルドでも、2 枚目が起動する (#286 ── proxy 越し)', async ({
  page,
  context,
}) => {
  const errorsA = collectPageErrors(page);
  // ⚠ **本体になる側だけ**を旧くする(2 枚目は素の新ビルド)
  await pretendLegacyWorker(page);
  await gotoApp(page);
  await expect(page.locator('[data-pkc-slot="root"]')).toHaveAttribute('data-pkc-boot', 'ready');

  const pageB: Page = await context.newPage();
  const errorsB = collectPageErrors(pageB);
  await gotoApp(pageB);

  // 🔴 2 枚目が開く(ここが落ちていた)
  await expect(
    pageB.locator('[data-pkc-slot="root"]'),
    '2 枚目の起動が落ちている(旧本体の断りが proxy 越しに抜けている)',
  ).toHaveAttribute('data-pkc-boot', 'ready');
  // ⚠ 本体経由で動いていることの確認(空振り防止 ── 単独起動なら意味が無い)
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText('本体タブ経由');
  // 2 枚とも旧本体の器を見ている(割れていない)
  await expect(pageB.locator('[data-pkc-slot="root"]')).toHaveAttribute(
    'data-pkc-container',
    'default',
  );

  expect(errorsA, `A: ${errorsA.join(' / ')}`).toEqual([]);
  expect(errorsB, `B: ${errorsB.join(' / ')}`).toEqual([]);
});
