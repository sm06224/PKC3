import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **実機で見つかった UI の崩れ(user 指示 2026-11-22)を実寸で固定する**。
 * 見る物は「崩れていないこと」の数値(矩形の重なり・幅・高さ・枠の有無)。各 test は崩れていた形で落ちることを
 * 変異で確かめてある(PR の記録)。スクリーンショットは目視の記録として test の出力に残す。
 */

async function shot(page: Page, name: string, selector?: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  if (selector === undefined) await page.screenshot({ path });
  else await page.locator(selector).first().screenshot({ path });
}

test('🔴 情報ペインの目次: 3 行に折り返す見出しも上端が切れず、下の項目にめり込まない(#4)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    [
      '## はじめに',
      '本文',
      '## とても長い見出しが情報ペインの狭い目次で三行以上に折り返しても上端が切れずに読めるかを確かめるための見出し',
      '本文',
      '## おわりに',
      '本文',
    ].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const links = page.locator('[data-pkc-region="inspector"] [data-pkc-field="inspector-toc-link"]');
  await expect(links).toHaveCount(3);
  const m = await links.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      return { top: r.top, bottom: r.bottom, h: r.height, sh: el.scrollHeight, ch: el.clientHeight, lines: Math.round((r.height - 4) / lh) };
    }),
  );
  expect(m[1]!.lines, '前提: 長い見出しが 3 行以上に折り返していない(検査が空振り)').toBeGreaterThanOrEqual(3);
  for (const [i, x] of m.entries()) expect(x.sh, `目次の ${i + 1} 行目の字が切れている(scrollHeight ${x.sh} > ${x.ch})`).toBeLessThanOrEqual(x.ch + 1);
  for (let i = 0; i + 1 < m.length; i++) expect(m[i]!.bottom, `目次の ${i + 1} 行目が下の項目にめり込む`).toBeLessThanOrEqual(m[i + 1]!.top + 0.5);
  await shot(page, 'inspector-toc', '[data-pkc-region="inspector"]');
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 パンくずはアドレスバーの形: 段はボタン箱でなく、現在地は太字、操作ボタンと見分けが付き、押せば戻れる(#5)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'folder');
  await page.locator('[data-pkc-field="editor-title"]').fill('はこ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]').first().dblclick();
  const crumb = page.locator('[data-pkc-region="filer-breadcrumb"]');
  await expect(crumb).toContainText('はこ');
  const st = await crumb.evaluate((nav) => {
    const box = (sel: string) => {
      const el = nav.querySelector<HTMLElement>(sel)!;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { border: cs.borderTopWidth, bg: cs.backgroundColor, weight: cs.fontWeight, top: r.top, bottom: r.bottom, h: r.height, text: el.textContent };
    };
    return {
      path: box('[data-pkc-field="crumb-path"]'),
      root: box('[data-pkc-field="crumb-seg"]:not([aria-current])'),
      here: box('[data-pkc-field="crumb-seg"][aria-current="location"]'),
      sep: nav.querySelector('[data-pkc-field="crumb-sep"]')?.textContent ?? null,
      move: box('[data-pkc-field="crumb-move"]'),
    };
  });
  expect(st.path.border, 'パスの枠(アドレスバー)が無い').toBe('1px');
  expect([st.root.border, st.here.border], '段がボタンの箱(枠)になっている').toEqual(['0px', '0px']);
  expect(st.root.bg, '段がボタンの地を持っている').toBe('rgba(0, 0, 0, 0)');
  expect(st.here.text).toBe('はこ');
  expect(Number(st.here.weight), '現在地が太字でない').toBeGreaterThanOrEqual(700);
  expect(Number(st.root.weight), '親の段まで太字').toBeLessThan(700);
  expect(st.sep, '区切りは ›').toBe('›');
  expect(st.move.border, '対照群: 操作ボタンは箱のまま').toBe('1px');
  expect(Math.abs(st.path.h - st.move.h), 'アドレスバーと操作ボタンの高さが違う(段違い)').toBeLessThanOrEqual(1);
  await shot(page, 'breadcrumb', '[data-pkc-region="filer-breadcrumb"]');
  // 押せば戻れる(働きは今までどおり)
  await clickReal(page, '[data-pkc-region="filer-breadcrumb"] [data-pkc-field="crumb-seg"]:not([aria-current])');
  await expect(crumb).not.toContainText('はこ');
  await expect(crumb.locator('[data-pkc-field="crumb-seg"][aria-current="location"]'), 'ルートが現在地にならない').toHaveText('ルート');
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 ペインの境目: 見た目は 4px で点々を出さず、掴む当たりは本文の側へ 10px ある(#6)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  const r = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    for (const pane of ['sidebar', 'inspector'] as const) {
      const g = document.querySelector<HTMLElement>(`[data-pkc-region="pane-grip"][data-pkc-pane="${pane}"]`)!;
      const b = g.getBoundingClientRect();
      const y = Math.round(b.top + b.height / 2);
      const isGrip = (x: number) => document.elementFromPoint(x, y)?.closest('[data-pkc-region="pane-grip"]') === g;
      out[pane] = {
        w: Math.round(b.width * 10) / 10,
        dots: getComputedStyle(g, '::after').content,
        // 本文の側へ: 左の帯は右へ、右の帯は左へ
        inside: pane === 'sidebar' ? isGrip(b.right + 5) : isGrip(b.left - 5),
        beyond: pane === 'sidebar' ? isGrip(b.right + 8) : isGrip(b.left - 8),
        // 反対側(左の一覧・右の情報ペイン)は奪わない
        other: pane === 'sidebar' ? isGrip(b.left - 2) : isGrip(b.right + 2),
      };
    }
    return out as Record<'sidebar' | 'inspector', { w: number; dots: string; inside: boolean; beyond: boolean; other: boolean }>;
  });
  for (const pane of ['sidebar', 'inspector'] as const) {
    const x = r[pane];
    expect(x.w, `${pane} の帯が ${x.w}px(太りすぎ)`).toBe(4);
    expect(['none', 'normal'], `${pane} の帯に常時の点々が出ている(${x.dots})`).toContain(x.dots);
    expect(x.inside, `${pane} の帯の本文側 5px が掴めない`).toBe(true);
    expect(x.beyond, `${pane} の帯の当たりが広すぎる(本文を奪う)`).toBe(false);
    expect(x.other, `${pane} の帯が反対側のペインを奪っている`).toBe(false);
  }
  // 掴んで広げられる(当たりの中で掴む)
  const g = await page.locator('[data-pkc-region="pane-grip"][data-pkc-pane="sidebar"]').boundingBox();
  const sw = () => page.locator('[data-pkc-region="sidebar"]').evaluate((el) => el.getBoundingClientRect().width);
  const before = await sw();
  await page.mouse.move(g!.x + g!.width + 5, g!.y + g!.height / 2);
  await page.mouse.down();
  await page.mouse.move(g!.x + g!.width + 45, g!.y + g!.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await sw(), '当たり(本文側 5px)で掴んで広げられない').toBeGreaterThan(before + 20);
});

test('🔴 ログの「新しい順 / 古い順」は押せるボタンの形(薄い地 + 枠・標準の高さ)(#3)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'textlog');
  await page.fill('[data-pkc-field="editor-body"]', ['## 2026-11-22 09:00:00', '朝', '## 2026-11-22 10:00:00', '昼'].join('\n\n'));
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const btn = page.locator('[data-pkc-region="detail"] [data-pkc-field="log-order"]');
  const st = await btn.evaluate((el) => {
    const cs = getComputedStyle(el);
    const probe = document.createElement('button');
    probe.type = 'button';
    probe.textContent = 'x';
    document.querySelector('[data-pkc-region="detail"]')!.append(probe);
    const rowH = probe.getBoundingClientRect().height;
    probe.remove();
    return { border: cs.borderTopWidth, bg: cs.backgroundColor, h: el.getBoundingClientRect().height, rowH };
  });
  expect(st.border, '枠が無い(ボタンに見えない)').toBe('1px');
  expect(st.bg, '地が無い(ボタンに見えない)').not.toBe('rgba(0, 0, 0, 0)');
  expect(Math.abs(st.h - st.rowH), `標準のボタンと高さが違う(${st.h} / ${st.rowH})`).toBeLessThanOrEqual(1);
  await shot(page, 'log-order-button', '[data-pkc-region="detail"]');
});
