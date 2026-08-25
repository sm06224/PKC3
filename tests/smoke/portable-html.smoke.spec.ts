import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
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
 * ④ 🔴 **再読込で残るか**(段③)── 器は `file://` の IndexedDB。
 *    ⚠ そして **`file://` は origin が全部 `file://` に潰れる**(実測)ので、
 *    ⑤ **別のバンドルが互いを上書きしないか**まで見ないと、正しさを主張できない。
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
   * ② 🔴 **選んだ形を「事故」として告げない**(段③ で向きが変わった)。
   *
   * ⚠ 段①② の時点ではここが `SecurityError` を**要求**していた ── OPFS を
   *   試して落ちていたからである。段③ で可搬バンドルは **OPFS を試さなくなった**
   *   ので、`fallbackReason` は載らない。
   * 🔑 主張の向きが変わったので、**空振り防止も置き直す**(CLAUDE.md §1
   *   「検査の向きを裏返したら、作法も裏返る」)── 状態の面が**実在する**ことを
   *   先に確かめてから、そこに警告が無いことを見る。
   */
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status, '状態の面が無い(検査そのものが空振りしている)').toBeAttached();
  await expect(status).not.toContainText('SecurityError');

  // ③ 🔴 **worker が動いている**(ノートを作れる = storage worker が生きている)
  await createEntry(page, 'text');
  await expect(
    page.locator('[data-pkc-field="editor-title"]'),
    'ノートを作れない(worker が動いていない)',
  ).toBeVisible({ timeout: 10_000 });
});

/**
 * 🔴 **段③ の本題 ── 再読込で残る。**
 *
 * ⚠ この test は段①② の時点では「**残らない**」を pin していた
 * (「段③ が入ったらここが落ちて、書き換えろと言ってくる」と書いてあった)──
 * その通りに落ちたので、向きを裏返した。
 */
test('🔴 `file://` で作ったノートが再読込で残る (#400 段③)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  /**
   * ⚠ **一覧の面を明示してから数える**(1 稿目で踏んだ)。
   * 🔑 素で `[data-pkc-entry]` を数えると**情報ペインのボタン**に満たされる
   *   ── #180 で nightly を 13 晩赤にしたのと同じ罠である(§1「別の面の文字」)。
   */
  await clickReal(page, '[data-pkc-browse="list"]');
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  /**
   * ⚠ **前提を assert する。** ここが 0 でないなら、前の走りの器が残っている
   *   (playwright は走りごとに profile を捨てるが、それは**前提であって観測では
   *   ない**)── 崩れたときに「残った」と読まないための門である。
   */
  await expect(rows, '最初から 1 件ある(前の走りの器が残っている)').toHaveCount(0);

  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill('可搬に残るノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows, '作ったのに一覧に出ない(前提が崩れた)').toHaveCount(1, { timeout: 10_000 });

  /**
   * 🔴 **保存は束ねて遅らせる**(打鍵ごとには書かない)。だから
   *   **閉じる合図を送ってから**再読込する ── これは製品が本当にやっている手順
   *   (`visibilitychange` の hidden で flush)であって、test 用の近道ではない。
   */
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1_500);

  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(rows, '🔴 再読込で消えた(段③ が効いていない)').toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-pkc-region="entry-list"]')).toContainText('可搬に残るノート');
});

/**
 * 🔴 **別のバンドルは互いを上書きしない**(#400 段③ の正しさの要件)。
 *
 * > ⚠ **`file://` では origin が全部 `file://` に潰れる**(2026-08-25 実測)──
 * > 別ディレクトリの別 HTML 同士で IndexedDB が**共有される**。
 *
 * だから器の名前を id で切っていなければ、**2 つ書き出して両方使うと片方が
 * 黙って消える**。⚠ これは unit では原理的に見えない(`file://` が要る)。
 */
test('🔴 別の id のバンドルは、互いのノートを見ない (#400 段③)', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-portable-'));
  const other = join(dir, 'other.html');
  const src = readFileSync(HTML, 'utf-8');
  const from = '{"id":"pkcb-template","exportedAt":0}';
  expect(src, '雛形に印が無い(検査そのものが空振りしている)').toContain(from);
  writeFileSync(other, src.replace(from, '{"id":"pkcb-othertest01","exportedAt":0}'));

  // ① 雛形のほうに 1 件書く
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(0);
  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill('雛形のノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows).toHaveCount(1, { timeout: 10_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1_500);

  // ② 別の id のバンドルを開く ── 🔴 **見えてはいけない**
  await page.goto(pathToFileURL(other).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(
    rows,
    '🔴 別のバンドルのノートが見えている(器の名前空間が切れていない)',
  ).toHaveCount(0, { timeout: 10_000 });

  // ③ 🔑 **対照群** ── 雛形へ戻ると、ちゃんと残っている
  //    (②が 0 件なのは「どちらも保存できていない」からではない)
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(rows, '雛形の側まで消えている(保存そのものが効いていない)').toHaveCount(1, {
    timeout: 15_000,
  });
});
