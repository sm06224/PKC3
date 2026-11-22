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

test('🔴 ペインの境目: 見た目は 4px で点々を出さず、掴む当たりはスクロールバーの無い側へ 10px ある(#6)', async ({ page }) => {
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
        appendDots: getComputedStyle(document.querySelector('[data-pkc-region="pane-grip"][data-pkc-axis="y"]') ?? g, '::after').content,
        // スクロールバーの無い側へ 6px: 左の帯は本文の側(右)、右の帯は情報ペインの側(右)
        inside: isGrip(b.right + 5.5),
        beyond: isGrip(b.right + 6.5),
        // 反対側は奪わない: 左の帯は一覧(の縦のスクロールバー)、右の帯は本文(の縦のスクロールバー)
        other: isGrip(b.left - 1.5),
      };
    }
    return out as Record<'sidebar' | 'inspector', { w: number; dots: string; appendDots: string; inside: boolean; beyond: boolean; other: boolean }>;
  });
  for (const pane of ['sidebar', 'inspector'] as const) {
    const x = r[pane];
    expect(x.w, `${pane} の帯が ${x.w}px(太りすぎ)`).toBe(4);
    expect(['none', 'normal'], `${pane} の帯に常時の点々が出ている(${x.dots})`).toContain(x.dots);
    expect(x.inside, `${pane} の帯の右 5.5px が掴めない`).toBe(true);
    expect(x.beyond, `${pane} の帯の当たりが広すぎる(本文を奪う)`).toBe(false);
    expect(x.other, `${pane} の帯が左隣(のスクロールバー)を奪っている`).toBe(false);
  }
  // 対照群: 追記欄の取っ手(横向き)は `⋮` のまま(user が畳んだ追記欄の戻し口の手がかり)
  expect(r.sidebar.appendDots, '追記欄の取っ手の ⋮ まで消えた').toBe('"⋮"');
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

/** 種類の違うノートを作る(種類の札を 2 段に折る材料)。 */
async function makeKinds(page: Page, n: number): Promise<void> {
  await clickReal(page, '[data-pkc-field="create-pick"]');
  const kinds = await page
    .locator('[data-pkc-region="create-menu"] [data-pkc-action="pick-create-kind"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-pkc-archetype')!));
  await page.keyboard.press('Escape');
  for (const k of kinds.filter((x) => x !== 'smart').slice(0, n)) {
    await createEntry(page, k);
    await clickReal(page, '[data-pkc-action="commit-edit"]').catch(() => undefined);
  }
  // フォルダを作ると中へ入ることがある ── ルートへ戻る(種類の札はルートの一覧で出る)
  await page.locator('[data-pkc-region="filer-breadcrumb"] [data-pkc-field="crumb-seg"]').first().click().catch(() => undefined);
}

test('🔴 左のペインの上の帯は重ならない: 種類の札が 2 段でも、作るボタンの行は一覧の 1 行目に食い込まない(#2)', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await gotoApp(page);
  await makeKinds(page, 6);
  const m = await page.evaluate(() => {
    const sb = document.querySelector('[data-pkc-region="sidebar"]')!;
    const kids = [...sb.children]
      .filter((c) => (c as HTMLElement).offsetHeight > 0)
      .map((c) => ({ name: c.getAttribute('data-pkc-region') ?? c.tagName, top: c.getBoundingClientRect().top, bottom: c.getBoundingClientRect().bottom }));
    const kind = document.querySelector('[data-pkc-region="kind-bar"]')!.getBoundingClientRect();
    const chip = document.querySelector('[data-pkc-region="kind-bar"] button')!.getBoundingClientRect();
    const cb = [...document.querySelectorAll<HTMLElement>('[data-pkc-region="create-bar"] button')].filter((e) => e.offsetHeight > 0);
    const row = document.querySelector('[data-pkc-region="browse-host"] tbody tr')!.getBoundingClientRect();
    return { kids, kindRows: Math.round(kind.height / chip.height), cbBottom: Math.max(...cb.map((e) => e.getBoundingClientRect().bottom)), rowTop: row.top };
  });
  expect(m.kindRows, '前提: 種類の札が 2 段に折れていない(検査の空振り)').toBeGreaterThanOrEqual(2);
  for (let i = 0; i + 1 < m.kids.length; i++)
    expect(m.kids[i]!.bottom, `${m.kids[i]!.name} が ${m.kids[i + 1]!.name} に重なる`).toBeLessThanOrEqual(m.kids[i + 1]!.top + 0.5);
  expect(m.cbBottom, '作るボタンの行が一覧の 1 行目に食い込む').toBeLessThanOrEqual(m.rowTop);
  await shot(page, 'sidebar-top', '[data-pkc-region="sidebar"]');
});

test('🔴 ボタンの段違い: 「新規作成 ▼」は 1 つの分割ボタン、「その他 ▾」・「≡ 目次」は並びのボタンと同じ高さ・上端(#3)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  const cb = await page.evaluate(() => {
    const box = (sel: string) => {
      const e = document.querySelector<HTMLElement>(`[data-pkc-region="create-bar"] ${sel}`)!;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { left: r.left, right: r.right, top: r.top, h: r.height, bg: cs.backgroundColor, rr: cs.borderTopRightRadius, lr: cs.borderTopLeftRadius };
    };
    return { run: box('[data-pkc-field="create-run"]'), pick: box('[data-pkc-field="create-pick"]'), today: box('[data-pkc-field="open-today"]'), more: box('[data-pkc-field="bar-more"]') };
  });
  expect(cb.pick.bg, '▼ の地が本体と違う(別のボタンに見える)').toBe(cb.run.bg);
  expect(Math.abs(cb.pick.left - cb.run.right), '本体と ▼ の間に隙間がある').toBeLessThanOrEqual(0.5);
  expect([cb.run.rr, cb.pick.lr], '向き合う角が丸い(一体に見えない)').toEqual(['0px', '0px']);
  for (const [name, b] of [['▼', cb.pick], ['今日', cb.today], ['その他 ▾', cb.more]] as const) {
    expect(Math.abs(b.h - cb.run.h), `${name} の高さが本体と違う(${b.h} / ${cb.run.h})`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.top - cb.run.top), `${name} の上端が本体と違う`).toBeLessThanOrEqual(1);
  }
  await shot(page, 'create-bar', '[data-pkc-region="create-bar"]');
  // 中央の帯: 目次の押しは帯のボタンと同じ見た目・高さ・上端
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-body"]', ['## 一', 'a', '## 二', 'b'].join('\n\n'));
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-region="detail"] .pkc-quick-toc-btn')).toBeVisible();
  const tb = await page.evaluate(() => {
    const box = (sel: string) => {
      const e = document.querySelector<HTMLElement>(`[data-pkc-region="detail"] [data-pkc-field="detail-toolbar"] ${sel}`)!;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { top: r.top, h: r.height, bg: cs.backgroundColor, shadow: cs.boxShadow, fs: cs.fontSize };
    };
    return { toc: box('.pkc-quick-toc-btn'), md: box('[data-pkc-action="copy-note-md"]') };
  });
  expect(Math.abs(tb.toc.top - tb.md.top), '目次の押しが帯のボタンより上に飛び出す').toBeLessThanOrEqual(1);
  expect(Math.abs(tb.toc.h - tb.md.h), '目次の押しの高さが帯のボタンと違う').toBeLessThanOrEqual(1);
  expect(tb.toc.bg, '目次の押しの地が帯のボタンと違う(白い地)').toBe(tb.md.bg);
  expect(tb.toc.shadow, '目次の押しだけ影を持つ').toBe('none');
  expect(tb.toc.fs).toBe(tb.md.fs);
  await shot(page, 'detail-toolbar', '[data-pkc-region="detail"] [data-pkc-field="detail-toolbar"]');
});

test('🔴 ゴミ箱は 1 か所: パソコンの幅では縦のバーにだけ出し、左のペインの下の「ゴミ箱を開く」は出さない / スマホの幅では出す(#7)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await expect(page.locator('[data-pkc-region="rail"] [data-pkc-action="show-trash"]'), '縦のバーのゴミ箱が無い').toBeVisible();
  await expect(page.locator('[data-pkc-region="sidebar"] [data-pkc-region="filer-trash"] [data-pkc-action="show-trash"]'), '左のペインの下にもゴミ箱を開くが出ている').toBeHidden();
  // 開いた中身は今までどおり左のペインの下に出る
  await clickReal(page, '[data-pkc-region="rail"] [data-pkc-action="show-trash"]');
  await expect(page.locator('[data-pkc-region="sidebar"] [data-pkc-region="filer-trash"] [data-pkc-action="hide-trash"]'), '開いたゴミ箱の中身が出ない').toBeVisible();
  // 対照群: スマホの幅(縦のバーが無い)では、左のペインの下の「ゴミ箱を開く」が唯一の入口
  const phone = await page.context().newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await gotoApp(phone);
  await phone.evaluate(() => localStorage.removeItem('pkc3.trash'));
  await expect(phone.locator('[data-pkc-region="rail"]')).toBeHidden();
  const trash = phone.locator('[data-pkc-region="filer-trash"] [data-pkc-action="show-trash"]');
  await trash.scrollIntoViewIfNeeded().catch(() => undefined);
  await expect(trash, 'スマホの幅でゴミ箱の入口が消えた').toBeVisible();
  await phone.close();
});

test('🔴 見切れ: タグの欄を開いた 1 行で「1 件」が切れない / 情報ペインの「つなぐ先の題名」が切れない(#8)', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click({ modifiers: ['ControlOrMeta'] });
  const bulk = page.locator('[data-pkc-field="filer-bulk"]');
  await expect(bulk).toContainText('1 件');
  await clickReal(page, '[data-pkc-field="bulk-tag-toggle"]');
  await expect(bulk.locator('[data-pkc-field="bulk-tag"]')).toBeVisible();
  const c = await page.evaluate(() => {
    const e = document.querySelector<HTMLElement>('[data-pkc-field="filer-bulk-count"]')!;
    const sb = document.querySelector('[data-pkc-region="sidebar"]')!.getBoundingClientRect();
    const r = e.getBoundingClientRect();
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(e).font}`;
    probe.textContent = e.textContent;
    document.body.append(probe);
    const need = probe.getBoundingClientRect().width;
    probe.remove();
    return { left: r.left, right: r.right, w: r.width, need, sbLeft: sb.left, sbRight: sb.right, lines: Math.round(r.height / parseFloat(getComputedStyle(e).lineHeight || '16')) };
  });
  expect(c.left, '「1 件」の左端が左のペインの外へ出て切れる').toBeGreaterThanOrEqual(c.sbLeft);
  expect(c.right).toBeLessThanOrEqual(c.sbRight);
  expect(c.w, `「1 件」が字の幅より狭い(${c.w} < ${c.need})`).toBeGreaterThanOrEqual(c.need - 0.5);
  await shot(page, 'bulk-tag', '[data-pkc-field="filer-action-row"]');
  // 情報ペインの「つなぐ先の題名」(選択を外して 1 件を開く ── 情報ペインにつながりの欄が出る)
  await clickReal(page, '[data-pkc-field="bulk-tag-back"]');
  await page.keyboard.press('Escape');
  // ⚠ 1100px 以下は情報ペインを畳む版面 ── 3 列の幅に広げる
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator('[data-pkc-region="inspector"] [data-pkc-field="relation-target"]')).toBeVisible();
  const t = await page.locator('[data-pkc-region="inspector"] [data-pkc-field="relation-target"]').evaluate((el) => {
    const input = el as HTMLInputElement;
    const cs = getComputedStyle(input);
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`;
    probe.textContent = input.placeholder;
    document.body.append(probe);
    const need = probe.getBoundingClientRect().width;
    probe.remove();
    const inner = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { need, inner };
  });
  expect(t.inner, `「つなぐ先の題名」が欄に入りきらない(${t.inner} < ${t.need})`).toBeGreaterThanOrEqual(t.need);
});

test('🔴 作るメニューの「今日」は「今日のログ / 今日のノート」の 2 つで、いまの既定に印。下段は名詞でそろう(#9)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(() => localStorage.removeItem('pkc3.today-kind'));
  await clickReal(page, '[data-pkc-field="create-pick"]');
  const menu = page.locator('[data-pkc-region="create-menu"]');
  const today = menu.locator('[data-pkc-action="open-today-as"]');
  await expect(today).toHaveText(['今日のログ', '今日のノート']);
  await expect(menu.locator('[data-pkc-action="open-today"]'), '「今日のノートを開く」が残っている(重複)').toHaveCount(0);
  await expect(menu, '助詞のちぐはぐな字が残っている').not.toContainText('で開く');
  await expect(menu.locator('[aria-checked="true"]'), '既定の印が 1 つでない').toHaveCount(1);
  await expect(menu.locator('[data-pkc-action="open-today-as"][data-pkc-archetype="text"]'), '初めは「今日のノート」が既定').toHaveAttribute('aria-checked', 'true');
  const tools = await menu.locator('[data-pkc-action="attach-file"], [data-pkc-action="start-audio-capture"], [data-pkc-action="start-screen-capture"], [data-pkc-action="start-timer"]').allTextContents();
  expect(tools.map((t) => t.trim())).toEqual(['添付', '録音', '画面録画', 'タイマー']);
  await shot(page, 'create-menu', '[data-pkc-region="create-menu"]');
  // 「今日のログ」を押すと既定がログへ移る(印も移る)
  await clickReal(page, '[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"][data-pkc-archetype="textlog"]');
  await clickReal(page, '[data-pkc-field="create-pick"]');
  await expect(menu.locator('[data-pkc-action="open-today-as"][data-pkc-archetype="textlog"]'), '押した方へ印が移らない').toHaveAttribute('aria-checked', 'true');
  await expect(menu.locator('[aria-checked="true"]')).toHaveCount(1);
});
