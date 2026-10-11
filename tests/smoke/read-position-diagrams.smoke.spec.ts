import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, dismissAnnounce, collectPageErrors } from './helpers';

/** 画面の先頭に見えている塊の「原文の行」と、その塊の上端から画面の上端までのずれ(px)。 */
async function firstVisible(page: Page): Promise<{ line: number; offset: number; top: number; sh: number }> {
  return page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    const host = document.querySelector<HTMLElement>('[data-pkc-field="detail-body"]');
    const st = sc.getBoundingClientRect().top;
    if (host === null) return { line: -2, offset: 0, top: Math.round(sc.scrollTop), sh: sc.scrollHeight };
    for (const c of Array.from(host.children) as HTMLElement[]) {
      const r = c.getBoundingClientRect();
      const raw = c.getAttribute('data-pkc-source-line');
      if (raw !== null && r.height > 0 && r.bottom > st + 1) {
        return { line: Number(raw), offset: Math.round(st - r.top), top: Math.round(sc.scrollTop), sh: sc.scrollHeight };
      }
    }
    return { line: -1, offset: 0, top: Math.round(sc.scrollTop), sh: sc.scrollHeight };
  });
}

function longBody(diagrams: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < 40; i++) {
    out.push(`## 節 ${i + 1}`, '');
    for (let j = 0; j < 12; j++) out.push(`段落 ${i}-${j} の字です。ここに字を並べます。`, '');
    if (diagrams) {
      const n = 3 + (i % 5) * 3; // 図の高さをばらつかせる
      const nodes = Array.from({ length: n }, (_, k) => `  N${k}["枠 ${k}"]-->N${k + 1}["枠 ${k + 1}"]`);
      out.push('```mermaid', 'graph TD', ...nodes, '```', '');
    } else {
      for (let j = 0; j < 4; j++) out.push(`代わりの段落 ${i}-${j} です。`, '');
    }
  }
  return out.join('\n');
}

async function makeNote(page: Page, body: string): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(body);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();
}

for (const diagrams of [true, false]) {
  test(`🔴 別のノートを選んで戻ると、読んでいた塊が戻る(図${diagrams ? 'あり' : 'なし'}) (#1525)`, async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    await dismissAnnounce(page);
    await makeNote(page, longBody(diagrams));
    if (diagrams) {
      await expect
        .poll(() => page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-state="ready"]').count(), {
          timeout: 60_000,
        })
        .toBe(40);
    }
    await page.waitForTimeout(1500);
    const sh0 = (await firstVisible(page)).sh;
    expect(sh0, '送れる本文でない').toBeGreaterThan(5000);
    await page.evaluate((y) => {
      document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = y;
    }, Math.round(sh0 / 2));
    await page.waitForTimeout(800);
    const before = await firstVisible(page);
    expect(before.line, '目印の塊が拾えない').toBeGreaterThan(0);

    // 別のノートを選ぶ(新規に作ると選ばれる)→ 元のノートの行(選ばれていないほう)を押して戻る
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
    await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();
    await clickReal(
      page,
      '[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry]:not([data-pkc-selected])',
    );
    const samples: Array<{ t: number; line: number; offset: number; top: number }> = [];
    let prev = 0;
    for (const t of [200, 1000, 3000, 8000]) {
      await page.waitForTimeout(t - prev);
      prev = t;
      const s = await firstVisible(page);
      samples.push({ t, line: s.line, offset: s.offset, top: s.top });
    }
    console.log(`PROBE diagrams=${diagrams} before=${JSON.stringify(before)} after=${JSON.stringify(samples)}`);
    // 🔑 図が焼け終わった後(8 秒)も、戻る前に見えていた塊が同じ所にある(行が同じ・ずれは数 px 以内)
    const last = samples[samples.length - 1]!;
    expect(last.line, `戻る前 ${before.line} 行の塊が、戻ると ${last.line} 行になった`).toBe(before.line);
    expect(Math.abs(last.offset - before.offset), '塊の中のずれが大きい').toBeLessThanOrEqual(8);
    // 🔑 読んでいる人の手を奪わない:戻った後に自分で送ったら、合わせ直しで引き戻されない
    await page.locator('[data-pkc-region="detail"]').hover();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(600);
    const moved = await firstVisible(page);
    expect(moved.top, '自分で送ったのに引き戻された').toBeGreaterThan(last.top + 300);
    expect(errors).toEqual([]);
  });
}
