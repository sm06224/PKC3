import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { clickReal, createEntry } from './helpers';

/**
 * 🔴 **可搬単一 HTML が `file://` で起動する**(#400 段①②)。
 *
 * > 正本 doc §9.2 は書き出し 3 形式のうち**これを「主」と呼んでいる**のに、
 * > 実装が無いまま設計 doc が 20 日間どこにも積まれていなかった(#400)。
 *
 * 🔴 **unit では原理的に届かない層**だけを見る:
 * ① **`file://` で本当に起動するか** ── `http://` で通ることは保証にならない
 *    (module worker が起動しない / OPFS が opaque origin で取れない)
 * ② **worker が classic の blob で本当に動くか** ── 畳み方が正しいかは、
 *    走らせるまで分からない
 * ③ **wasm が `data:` から読めるか** ── sqlite の loader は
 *    `self.location.href` から相対で解決するので、blob worker では解けない
 *
 * ⚠ **まだ「保存が残る」ところまでは行っていない**(段③)── ここが見るのは
 *   **起動するところまで**である。⚠ だから「残るはず」を書かない。
 */
const HTML = resolve('dist-portable/pkc3.html');

test.beforeAll(() => {
  /**
   * ⚠ **無ければ自分で焼く** ── 通常の `npm run build` は `dist-portable` を
   *   作らない(本番の配り物を単一化しないため)。ここで焼かないと、
   *   この spec は**環境によって走ったり走らなかったり**する
   *   (走らない回を「通った」と読む形を作らない)。
   */
  if (existsSync(HTML)) return;
  execFileSync('npx', ['vite', 'build', '--config', 'build/portable.config.ts'], {
    stdio: 'ignore',
  });
  execFileSync('node', ['build/portable/fold.mjs'], { stdio: 'ignore' });
});

test('🔴 畳んだ 1 個の HTML が `file://` で起動する (#400 段①②)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);

  // ① 起動する
  await expect(
    page.locator('[data-pkc-boot="ready"]'),
    '`file://` で起動しない',
  ).toBeAttached({ timeout: 20_000 });
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);

  /**
   * ② ⚠ **OPFS が取れないことを、黙って落とさない**(既存の告知が効いている)。
   * 🔑 `file://` は opaque origin なので OPFS は原理的に取れない ── そこは
   *   欠陥ではないが、**黙って `:memory:` に落ちる**のは欠陥である。
   */
  await expect(
    page.locator('[data-pkc-region="status"]'),
    'OPFS が取れないことを黙って落としている',
  ).toContainText('SecurityError', { timeout: 10_000 });

  // ③ 🔴 **worker が動いている**(ノートを作れる = storage worker が生きている)
  await createEntry(page, 'text');
  await expect(
    page.locator('[data-pkc-field="editor-title"]'),
    'ノートを作れない(worker が動いていない)',
  ).toBeVisible({ timeout: 10_000 });
});

/**
 * ⚠ **対照群 ── いまはまだ残らない**(段③ が未実装であることの記録)。
 *
 * 🔴 これは「壊れている」ではなく「**まだ作っていない**」である。
 *   ⚠ 書かずに置くと、次に読む人は「残るはず」と思って追いかける ──
 *   だから**残らないことを pin する**。段③ が入ったらここが落ちて、
 *   **書き換えろと言ってくる**(それが正しい合図である)。
 */
test('⚠ 対照群 ── `file://` では再読込で消える(段③ が未実装であることの記録)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  /**
   * ⚠ **一覧の面を明示してから数える**(1 稿目で踏んだ)。
   * 🔑 素で `[data-pkc-entry]` を数えると**情報ペインのボタン**に満たされる
   *   ── #180 で nightly を 13 晩赤にしたのと同じ罠である(§1「別の面の文字」)。
   * ⚠ そして既定で開いている面は一覧とは限らない(`entry-list` の region は
   *   在るが空、という実測が `backlinks.smoke.spec.ts` に残っている)。
   */
  await clickReal(page, '[data-pkc-browse="list"]');
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows, '最初から 1 件ある(前提が崩れた)').toHaveCount(0);

  // ⚠ **user と同じ手順で作る**(`helpers` の 1 本)── 直に action を押す形は
  //    分割ボタンの手順を飛ばすので、種類が決まらず前提が崩れる(1 稿目で踏んだ)
  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows, '作ったのに一覧に出ない(前提が崩れた)').toHaveCount(1, { timeout: 10_000 });

  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    rows,
    '⚠ 残るようになった ── 段③ が入ったなら、この test を「残る」へ書き換えること',
  ).toHaveCount(0, { timeout: 10_000 });
});
