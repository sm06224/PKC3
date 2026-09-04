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
 * ⚠ ただし 22 枚を焼くのは**重い**。smoke lane は 2026-08-28 に
 * **10 分の門へ実際にぶつかっている**ので、PR gate には入れない
 * (プロセス指示「CI を長くしない」)。
 * 🔑 だから `PKC3_HEAVY=1` のときだけ走らせ、nightly がそれを渡す。
 * ⚠ **名前が揃っているか**は `tests/features/mermaid-forms-parity.test.ts` が
 * PR gate で見る ── マニュアルに行を足したのに fixture を足し忘れたら、
 * **その場で**落ちる(nightly まで待たない)。⚠ 行数(22)も同じ test が名指しで pin する
 * ── 両側を同時に 1 つ消す形は集合では見えない(2026-09-04、#528 (2))。
 *
 * ⚠ 実測 2026-09-04(手元の箱、同梱のフル chromium、`PKC3_HEAVY=1` で 1 回):
 *   **22 枚で 5.5 秒**(spec 全体 7.6 秒)、22 / 22 が `ready` + blob の PNG。
 *   「重い」の見積もりはこの箱では当たっていない ── PR gate へ戻すかは、
 *   CI の headless_shell で測ってから決める(ここでは決めない)。
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

/**
 * 🔴 **重い検査は頼まれたときだけ**。⚠ `skip` は「走らなかった」= 確かめていない
 *   なので、nightly 側は**渡し忘れたら気づけるように** step を分けてある。
 */
const HEAVY = process.env['PKC3_HEAVY'] === '1';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 マニュアルの 22 種が、どれも PNG まで焼ける (#528)', async ({ page }) => {
  test.skip(!HEAVY, 'PKC3_HEAVY=1 のときだけ走る(22 枚は重い ── nightly で回す)');
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
