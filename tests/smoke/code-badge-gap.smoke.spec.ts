/**
 * 🔴 **囲みの右上の言語バッジ(MERMAID / TS / CSV)が、右上のボタン(⧉ / ✎ / ▾ / ‹/›)に重ならない**(Stage 4。user 指摘 2026-11-25)。
 *
 * ⚠ 直す前: Mermaid ではバッジの右端と「‹/›」の左端の間が 2px(D が掛かって見えた)、csv ではバッジが「‹/›」の真下に丸ごと隠れていた。
 * 観測点: 触れたとき(ボタンが出ている状態)に、バッジと同じ段に居る各ボタンの矩形との横の隙間が 4px 以上あること。
 * 対照群: ボタンが 1 つ以上同じ段に居ること(居なければ「重ならない」は空振りする)。指の端末(`hasTouch` + `isMobile`)でも同じ式。
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, dismissAnnounce, useSplitEditor } from './helpers';

const BODY = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';
const SRC = ['```mermaid\ngraph TD\n  A-->B\n```', '```ts\nconst a = 1;\n```', '```csv\na,b\n1,2\n```'].join('\n\n');

async function measure(page: Page): Promise<{ kind: string; gaps: { btn: string; gap: number }[] }[]> {
  const blocks = page.locator(`${BODY} .pkc-md-block:has(> .pkc-code-lang)`);
  await expect(blocks).toHaveCount(3);
  const out: { kind: string; gaps: { btn: string; gap: number }[] }[] = [];
  for (let i = 0; i < 3; i++) {
    const b = blocks.nth(i);
    await b.hover();
    // 触れたときに出るボタン(‹/› など)が出切るまで待つ ── 透明のまま測ると、見えていない物との隙間を測ってしまう
    await expect
      .poll(() => b.evaluate((el) => [...el.querySelectorAll<HTMLElement>(':scope > .pkc-render-toggle, :scope > .pkc-md-copy-btn')].every((c) => getComputedStyle(c).opacity === '1')))
      .toBe(true);
    out.push(
      await b.evaluate((el) => {
        const badge = el.querySelector(':scope > .pkc-code-lang')!.getBoundingClientRect();
        const gaps: { btn: string; gap: number }[] = [];
        for (const c of el.querySelectorAll<HTMLElement>(':scope > :is(.pkc-md-copy-btn, .pkc-md-copy-menu-btn, .pkc-md-edit-btn, .pkc-render-toggle, .pkc-code-collapse-top-btn)')) {
          const r = c.getBoundingClientRect();
          if (r.width < 2) continue;
          if (r.bottom <= badge.top || r.top >= badge.bottom) continue; // 別の段
          // 横の隙間(負 = 重なり)
          const gap = r.left >= badge.left ? r.left - badge.right : badge.left - r.right;
          gaps.push({ btn: (c.textContent ?? '').trim() || c.className, gap: Math.round(gap * 10) / 10 });
        }
        return { kind: el.getAttribute('data-pkc-render-lang') ?? el.getAttribute('data-pkc-md-block-kind') ?? '?', gaps };
      }),
    );
  }
  return out;
}

for (const touch of [false, true]) {
  test(`🔴 言語バッジは右上のボタンから 4px 以上離れる(${touch ? '指の端末' : 'マウス'})`, async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: touch ? 820 : 1440, height: 900 },
      hasTouch: touch,
      isMobile: touch,
      baseURL: test.info().project.use.baseURL,
    });
    const page = await ctx.newPage();
    try {
      await useSplitEditor(page);
      await gotoApp(page);
      // 前提: 指の端末の context が、本当に指の端末の規則(`(hover: none) and (pointer: coarse)`)に当たっている
      expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), '前提: 指の端末の条件が成り立っていない').toBe(touch);
      await dismissAnnounce(page);
      await createEntry(page, 'text');
      await page.fill('[data-pkc-field="editor-body"]', SRC);
      await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
      await page.waitForSelector('[data-pkc-action="start-edit"]');
      const rows = await measure(page);
      expect(rows.map((r) => r.kind).sort(), '前提: mermaid / コード / csv の 3 つ').toEqual(['code', 'csv', 'mermaid']);
      // 前提: 種類ごとに、バッジと同じ段で測ったボタンが揃っている(切替・▾・✎ が測れていないまま「重ならない」と言わない)
      const want: Record<string, string[]> = { mermaid: ['‹/›', '⧉'], csv: ['‹/›', '▾', '⧉'], code: ['✎', '⧉'] };
      for (const r of rows) {
        expect(r.gaps.map((g) => g.btn).sort(), `${r.kind}: 前提 ── 測ったボタンが足りない(空振り)`).toEqual([...want[r.kind]!].sort());
        // 名目の隙間は 6px(ボタンの左端 + 6)。端数の丸めだけ許す ── 指の端末の規則を消すと 4px になり、ここで落ちる
        for (const g of r.gaps) expect(g.gap, `${r.kind}: バッジが「${g.btn}」に寄りすぎ / 掛かっている(隙間 ${g.gap}px)`).toBeGreaterThanOrEqual(5.5);
      }
      // 🔴 表として描いた囲み(csv)のバッジが、表の見出しの行(位置を持ち、後から塗られる)の**下に隠れていない**。
      //    矩形が空いていても重なり順で負ければ見えない ── バッジに当たり判定を一時的に持たせ、上下 2 段 × 左右 3 点で一番上に居る物を見る(直す前は下半分が見出しの行に塗られていた)
      const csv = page.locator(`${BODY} .pkc-md-block[data-pkc-render-lang="csv"]`).first();
      await csv.hover();
      await page.waitForTimeout(250);
      const top = await csv.evaluate((el) => {
        const badge = el.querySelector<HTMLElement>(':scope > .pkc-code-lang')!;
        badge.style.pointerEvents = 'auto';
        const r = badge.getBoundingClientRect();
        const pts = [0.25, 0.75].flatMap((fy) => [0.2, 0.5, 0.8].map((fx) => document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)));
        badge.style.pointerEvents = '';
        return pts.map((e) => (e === badge ? 'badge' : (e?.tagName.toLowerCase() ?? 'null')));
      });
      expect(top, 'csv: バッジが表の見出しの行に塗りつぶされている').toEqual(Array(6).fill('badge'));
    } finally {
      await ctx.close();
    }
  });
}
