/**
 * 🔴 **マニュアルが「描ける」と言っている 22 種が、全部 PNG まで焼ける**(#528、2026-08-29)。
 *
 * ## なぜ別 file で、なぜ nightly だけか
 *
 * `docs/manual.md` は **22 種**を「そのまま書けます」と書いているのに、
 * 焼けることを見ていたのは **5 種**だけだった ──
 * ⚠ **残り 17 種は 1 つ壊れても誰も気づかない**(mermaid の版が上がった日に、
 * マニュアルが静かに嘘になる)。
 *
 * 🔴 **2026-09-05: PR gate で走らせることにした**(それまでは `PKC3_HEAVY=1` の
 * ときだけ = 夜だけ)。⚠ 「重い」という見積もりは**測っていなかった**。
 *
 * 実測(2026-09-05、**PR gate と同じ `chromium_headless_shell`**):
 *
 * | | 実測 |
 * |---|---|
 * | この spec 単体 | **5.4 秒**(spec 全体 7.8 秒) |
 * | CI のフル smoke(3 shard に分割) | 各 shard 3.5〜3.9 分 / job timeout **10 分** |
 *
 * 🔑 増えるのは 1 shard に **8 秒**(2% 未満)で、10 分の tripwire は鈍らない。
 * ⚠ 一方、夜だけにしていた間の実害は「**PR gate に skip が 1 件常駐する**」
 *   ことだった ── CLAUDE.md「**`skipped` も赤に数える**(走らなかった = 確かめていない)」。
 *   マニュアルが 22 種を「そのまま書けます」と言っている以上、その主張は
 *   **配る前**に検めるのが正しい。
 * ⚠ **名前が揃っているか**は `tests/features/mermaid-forms-parity.test.ts` が見る
 *   ── マニュアルに行を足したのに fixture を足し忘れたら、**焼く前**に落ちる。
 *   ⚠ 行数(22)も同じ test が名指しで pin する ── 両側を同時に 1 つ消す形は
 *   集合では見えない(2026-09-04、#528 (2))。
 *
 * ## ⚠ 観測点
 *
 * `state="ready"` **だけにしない** ── 器の属性は「描こうとした」までしか言わない。
 * **`<img>` が blob で、実際に画素を持っている**(`naturalWidth > 0`)まで見る。
 * 🔑 22 種を**別々に**assert するので、落ちた種類が**名前で分かる**。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';
import { MERMAID_FORMS } from '../fixtures/mermaid-forms';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 マニュアルの 22 種が、どれも PNG まで焼ける (#528)', async ({ page }) => {
  // ⚠ 22 枚ぶんの焼きを待つので、既定の 1 本ぶんでは足りない
  test.setTimeout(300_000);

  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図の全数');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(MERMAID_FORMS.map((f) => '```mermaid\n' + f.src + '\n```').join('\n\n') + '\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const hosts = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  // ⚠ 空振り防止 ── 器が 22 出ていなければ、以下の for は自明に通る
  await expect(hosts, '図の器が 22 出ていない').toHaveCount(MERMAID_FORMS.length);

  /**
   * 🔴 **先に「全部が決着するまで」待つ**(2026-08-29、1 稿目で踏んだ)。
   *
   * ⚠ 1 稿目は `getAttribute` を**1 回だけ**読んでいた ── 属性は
   *   **焼きが始まるまで付かない**ので、**22 種すべてが `state=なし`** と出た。
   * 🔴 そこには**対照群(`graph TD`)も居た** ── 既存の spec で毎回焼けている
   *   図まで「焼けない」と出たので、**計器の誤り**だと分かった
   *   (CLAUDE.md §4「対照群が届かない回は結果を読まない」)。
   * ⚠ 実測 **1.9 秒**で終わっていた = **1 枚も待っていなかった**。
   *
   * 🔑 だから「`ready` か `failed` に**決着した器の数**」で待つ。
   * ⚠ 待ちが timeout しても**止めない** ── 下で「どれが決着しなかったか」を
   *   名前で並べるほうが、1 回転で全部直せる。
   */
  const settled = async (): Promise<number> =>
    hosts.evaluateAll(
      (els) =>
        els.filter((e) => {
          const s = e.getAttribute('data-pkc-mermaid-state');
          return s === 'ready' || s === 'failed';
        }).length,
    );
  try {
    await expect
      .poll(settled, { timeout: 240_000, intervals: [500, 1000, 2000] })
      .toBe(MERMAID_FORMS.length);
  } catch {
    // ⚠ 握り潰さない ── 決着しなかった器は下の for が `state=…` で名指しする
  }

  const broken: string[] = [];
  for (const [i, f] of MERMAID_FORMS.entries()) {
    const host = hosts.nth(i);
    const state = await host.getAttribute('data-pkc-mermaid-state').catch(() => null);
    if (state !== 'ready') {
      broken.push(`${f.name}: state=${state ?? 'なし'}`);
      continue;
    }
    const img = await host.evaluate((h) => {
      const el = h.querySelector('img');
      return { src: el?.getAttribute('src')?.slice(0, 5) ?? '', natural: el?.naturalWidth ?? 0 };
    });
    if (img.src !== 'blob:' || img.natural <= 0) {
      broken.push(`${f.name}: src=${img.src} 幅=${img.natural}`);
    }
  }
  /**
   * 🔑 **1 種で止めない** ── 全部当ててから、落ちた種類を**名前で**並べる。
   * ⚠ 途中で throw すると「1 種は分かるが、ほかは分からない」になり、
   *   1 回転で 1 件しか直せない。
   */
  expect(broken, 'マニュアルは描けると言っているのに、焼けなかった図がある').toEqual([]);
  expect(errors).toEqual([]);
});
