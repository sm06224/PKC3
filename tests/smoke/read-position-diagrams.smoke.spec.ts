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

/** 本文の図(mermaid)の器のうち、焼き上がった数。 */
function readyDiagrams(page: Page): Promise<number> {
  return page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-state="ready"]').count();
}

/**
 * 🔴 **「落ち着いた」を状態で待つ**(固定の `waitForTimeout` を置かない)。
 *
 * ⚠ 直す前は 1.5 秒 / 0.8 秒 / 8 秒 / 3 秒の**固定の待ち**(計 13.3 秒)を積んでいた。全量の負荷では図を焼くのが
 *   遅れて、待ちの途中で per-test の 30 秒を使い切り、`waitForTimeout` の行が時間切れで落ちた
 *   (2026-11-03 の実測:`--workers=4 --repeat-each=5` で図ありが 5 回中 2 回)。
 *   逆に、速い箱では「まだ焼いている最中」を「焼き上がった後」として読みうる(時間は焼き上がりの証拠にならない)。
 * 🔑 見る物は 3 つ:①図の器が**全部** `ready`(`want` 個)②本文の絵が全部読み込み済み
 *   ③本文の高さと送り位置が **連続 400ms** 動かない(図が焼けるたびに高さが変わり、合わせ直しが送りを書く)。
 */
async function settled(page: Page, want: number): Promise<void> {
  if (want > 0) {
    await expect
      .poll(() => readyDiagrams(page), { timeout: 60_000, message: '図が焼き上がらない' })
      .toBe(want);
  }
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>('[data-pkc-field="detail-body"] img')].every(
        (i) => i.complete,
      ),
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const sc = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
        let last = '';
        let since = performance.now();
        const tick = (): void => {
          const now = `${sc.scrollTop}/${sc.scrollHeight}`;
          if (now !== last) {
            last = now;
            since = performance.now();
          }
          if (performance.now() - since >= 400) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
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
    /**
     * ⚠ **図ありは 40 枚の図を 2 度焼く筋書き**で、中の待ちは 60 秒を名乗っている ── per-test の 30 秒のままでは
     *   その待ちが**使い切れない**(SKILL「長い筋書きの中の timeout」)。実測(2026-11-03):直す前、
     *   `--workers=4` で通った回でも 27〜29 秒(壁の手前)。⚠ 伸ばすのは枠だけで、門は変えない。
     */
    test.setTimeout(diagrams ? 90_000 : 45_000);
    const errors = collectPageErrors(page);
    const want = diagrams ? 40 : 0;
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    await dismissAnnounce(page);
    await makeNote(page, longBody(diagrams));
    await settled(page, want);
    const sh0 = (await firstVisible(page)).sh;
    expect(sh0, '送れる本文でない').toBeGreaterThan(5000);
    await page.evaluate((y) => {
      document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = y;
    }, Math.round(sh0 / 2));
    await settled(page, want);
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
    /**
     * 🔑 戻った直後の 1 読みは**記録だけ**(図が焼ける途中の姿 ── 診断のため)。判定は焼き上がって落ち着いた後。
     * ⚠ 直す前は「8 秒後」を焼き上がりの代わりにしていた(`HOLD_MS` と同じ長さ)── 負荷の高い箱では 8 秒で
     *   焼き終わる保証が無く、速い箱では焼き終わりより前に読む。焼き上がりそのものを待つ。
     */
    const t0 = Date.now();
    const early = await firstVisible(page);
    await settled(page, want);
    const last = { t: Date.now() - t0, ...(await firstVisible(page)) };
    console.log(`PROBE diagrams=${diagrams} before=${JSON.stringify(before)} early=${JSON.stringify(early)} after=${JSON.stringify(last)}`);
    // 🔑 図が焼け終わった後も、戻る前に見えていた塊が同じ所にある(行が同じ・ずれは数 px 以内)
    expect(last.line, `戻る前 ${before.line} 行の塊が、戻ると ${last.line} 行になった`).toBe(before.line);
    expect(Math.abs(last.offset - before.offset), '塊の中のずれが大きい').toBeLessThanOrEqual(8);
    // 🔑 読んでいる人の手を奪わない:もう一度別のノートへ移って戻り、**図がまだ焼けている最中**に自分で送る。
    //    ⚠ 焼き上がった後(上の 8 秒後)に送っても、合わせ直しはもう止まっているので何も確かめていない
    const row =
      '[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry]:not([data-pkc-selected])';
    await clickReal(page, row); // 別のノートへ
    await clickReal(page, row); // 元のノートへ戻る
    await expect
      .poll(async () => (await firstVisible(page)).line, { timeout: 5000, intervals: [10] })
      .toBeGreaterThan(0);
    const back = await firstVisible(page);
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, 4000);
    await expect
      .poll(async () => (await firstVisible(page)).top, { timeout: 2000, intervals: [20] })
      .toBeGreaterThan(back.top + 2000);
    const wheeled = await firstVisible(page);
    // 🔑 焼き上がって落ち着くまで待つ(直す前は固定の 3 秒)── 引き戻しが起きるなら、焼き上がりで起きる
    await settled(page, want);
    const after = await firstVisible(page);
    console.log(`PROBE2 diagrams=${diagrams} back=${JSON.stringify(back)} wheeled=${JSON.stringify(wheeled)} settled=${JSON.stringify(after)}`);
    if (diagrams) {
      // ⚠ 空振り防止:送った後に本文の高さが大きく動く場面であること(動かなければ、止める働きを何も確かめていない)
      expect(after.sh - wheeled.sh, '送った後に図が焼けて高さが動いていない').toBeGreaterThan(5000);
    }
    expect(after.line, '自分で送ったのに、焼き上がりで元の塊へ引き戻された').toBeGreaterThan(before.line + 20);
    expect(errors).toEqual([]);
  });
}
