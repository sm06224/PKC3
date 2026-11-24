/**
 * 🔴 **UI/UX 官能評価・UX 監査の修正の幾何・色の観測**(Stage 2 PR-3)。
 *
 * 画面を見て出た 8 項目を、**実ブラウザの幾何・computed style・画素**で留める(unit の CSS 原文検査と対)。
 *
 * | # | 主張 | 観測 |
 * |---|---|---|
 * | 1 | 緑の主ボタンの中のアイコンが `--accent-fg`(字と同じ色)で、全 12 配色で地と区別できる | `::after` の computed `color` = `--accent-fg`、`--accent` との対比 ≥ 4.5 |
 * | 2 | 編集中の「+ ノート ▾」の分割ボタンが割れない | 本体と ▾ の地・減光・上端・高さが同じ |
 * | 3 | 1 行のコードブロックで言語バッジがコードに重ならない(長い 1 行も) | バッジの矩形とコードの行の矩形が交差しない |
 * | 4 | SQL の「ER 図」タブで SQL の欄が見えず、図が残りの高さを使い、面の外へはみ出さない | 欄が非表示・図の底 ≒ 面の底・`sql-main` に縦のあふれが無い |
 * | 6 | スマホ幅で並び順の「⇅」が単独の行へ折り返さない | 並び順の `<select>` と ⇅ の上端が同じ(390 / 360px) |
 * | 7 | ログの並び順ボタンと「すべて折りたたむ」が同じ行に並ぶ | 2 つの上端が同じ |
 * | 8-1 | ヘルプを開いた時点で検索欄と本文が画面の中・目次 / 検索の結果で該当の見出しが画面に入る・Ctrl+F(`window.find`)で末尾の WebMCP まで当たる | 矩形が viewport の中 |
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce } from './helpers';
import { THEMES } from '../../src/adapter/ui/render/theme';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

async function commitNew(page: Page, archetype: string, title: string, body: string): Promise<void> {
  await createEntry(page, archetype);
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

const setTheme = (page: Page, theme: string, dark: boolean): Promise<void> =>
  page.evaluate(
    ([t, d]) => {
      document.documentElement.setAttribute('data-pkc-theme', t!);
      document.documentElement.setAttribute('data-pkc-tone', d === 'true' ? 'dark' : 'light');
    },
    [theme, String(dark)],
  );

/** 相対輝度のコントラスト比(`rgb(r, g, b)` / `color(srgb …)` の computed 値を読む)。 */
const CONTRAST = `
  (a, b) => {
    const rgb = (s) => {
      const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = '#000'; c.fillStyle = s; c.fillRect(0, 0, 1, 1);
      return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
    const x = lum(rgb(a)), y = lum(rgb(b));
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }`;

test('🔴 1・2: 主ボタンの中のアイコンは --accent-fg(全配色)/ 編集中の分割ボタンは割れない (Stage 2 PR-3)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await commitNew(page, 'text', 'アイコンの色', '本文');

  // ── 1: 「ノートを編集する」の主ボタンのアイコン
  const edit = page.locator('[data-pkc-region="detail"] button[data-pkc-action="start-edit"][data-pkc-variant="primary"]');
  await expect(edit, '前提: 主のボタンが見えない').toBeVisible();
  const icon = edit.locator('[data-pkc-icon]').first();
  await expect(icon, '前提: 主のボタンに図案が無い').toBeAttached();
  expect(THEMES.length).toBe(12);
  for (const t of THEMES) {
    await setTheme(page, t.id, t.dark === true);
    await page.waitForTimeout(80); // 色の移り変わり(transition)が済むのを待つ
    const r = await icon.evaluate((el, contrastSrc) => {
      const root = getComputedStyle(document.documentElement);
      const fg = root.getPropertyValue('--accent-fg').trim();
      const accent = root.getPropertyValue('--accent').trim();
      const line = getComputedStyle(el, '::after').color;
      // `--accent-fg` を実際に色へ解決する(var を直に比べない)
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent-fg)';
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      const contrast = (eval(contrastSrc) as (a: string, b: string) => number)(line, accent);
      return { fg, accent, line, resolved, contrast };
    }, CONTRAST);
    expect(r.line, `${t.id}: アイコンの線が --accent-fg(${r.fg})と同じ色でない`).toBe(r.resolved);
    expect(r.contrast, `${t.id}: アイコンと緑の地の対比が足りない(${r.line} on ${r.accent})`).toBeGreaterThanOrEqual(4.5);
  }
  await setTheme(page, 'light', false);

  // ── 2: 編集中の分割ボタン(作る本体 + ▾)
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  type Box = { bg: string; op: string; top: number; h: number; color: string };
  const split = async (): Promise<{ run: Box; pick: Box }> =>
    page.evaluate(() => {
      const g = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { bg: cs.backgroundColor, op: cs.opacity, top: Math.round(r.top), h: Math.round(r.height), color: cs.color };
      };
      return { run: g('[data-pkc-field="create-run"]'), pick: g('[data-pkc-field="create-pick"]') };
    });
  await expect(page.locator('[data-pkc-field="create-run"]'), '前提: 編集中は本体が押せない').toBeDisabled();
  for (const t of [THEMES.find((x) => !x.dark)!, THEMES.find((x) => x.dark)!]) {
    await setTheme(page, t.id, t.dark === true);
    await page.waitForTimeout(80);
    const s = await split();
    expect(s.pick.bg, `${t.id}: 編集中、▾ だけ別の地(割れている)`).toBe(s.run.bg);
    expect(s.pick.op, `${t.id}: 編集中、▾ だけ減光が違う(割れている)`).toBe(s.run.op);
    expect(s.pick.color, `${t.id}: 編集中、▾ だけ字の色が違う`).toBe(s.run.color);
    expect(s.pick.top).toBe(s.run.top);
    expect(s.pick.h).toBe(s.run.h);
  }
  await setTheme(page, 'light', false);
  // 対照群: 編集を終えたら、また本体と ▾ が同じ緑
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const after = await split();
  expect(after.pick.bg, '編集を終えたのに本体と ▾ の地が違う').toBe(after.run.bg);
  expect(after.run.op).toBe('1');
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 3: 1 行のコードブロックで言語バッジがコードに重ならない(長い 1 行も) (Stage 2 PR-3)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  const long = 'SELECT ' + Array.from({ length: 60 }, (_, i) => `col_${i}`).join(', ') + ' FROM entries';
  await commitNew(page, 'text', 'コードの言語バッジ', ['```sql', 'SELECT 1', '```', '', '```sql', long, '```', '', '```ts', 'const a = 1;', 'const b = 2;', '```'].join('\n'));
  const body = page.locator('[data-pkc-field="detail-body"]');
  const blocks = body.locator('.pkc-md-block[data-pkc-md-block-kind="code"]');
  await expect(blocks).toHaveCount(3);
  await expect(body.locator('.pkc-code-lang')).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    const r = await blocks.nth(i).evaluate((blk) => {
      const badge = blk.querySelector('.pkc-code-lang') as HTMLElement;
      const code = blk.querySelector('pre > code') as HTMLElement;
      const b = badge.getBoundingClientRect();
      // コードの最初の行の矩形(横にあふれる長い 1 行は、箱ではなく行の矩形で見る)
      const rects = [...code.getClientRects()];
      const first = rects[0]!;
      return { badge: { l: b.left, r: b.right, t: b.top, b: b.bottom }, first: { l: first.left, r: first.right, t: first.top, b: first.bottom } };
    });
    const overlap = r.badge.l < r.first.r && r.badge.r > r.first.l && r.badge.t < r.first.b && r.badge.b > r.first.t;
    expect(overlap, `${i} 番目のコードブロック: 言語バッジ ${JSON.stringify(r.badge)} がコードの 1 行目 ${JSON.stringify(r.first)} に重なっている`).toBe(false);
    expect(r.badge.b, `${i} 番目: バッジの下端がコードの 1 行目の上端より下にある`).toBeLessThanOrEqual(r.first.t + 0.5);
  }
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 4: SQL の「ER 図」タブは、SQL の欄が見えず、図が残りの高さを使う (Stage 2 PR-3)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await page.evaluate(() => {
    location.hash = '#pkc?view=sql';
  });
  const sql = page.locator('[data-pkc-view-pane="sql"]');
  await expect(sql.locator('[data-pkc-field="sql-tree-table"][data-pkc-name="entries"]')).toHaveCount(1, { timeout: 15_000 });
  await clickReal(page, sql.locator('[data-pkc-field="sql-er-toggle"]'));
  await expect(sql.locator('[data-pkc-field="sql-er-box"]').first()).toBeVisible({ timeout: 15_000 });
  const m = await page.evaluate(() => {
    const pane = document.querySelector('[data-pkc-view-pane="sql"]') as HTMLElement;
    const main = pane.querySelector('[data-pkc-field="sql-main"]') as HTMLElement;
    const rect = (sel: string): DOMRect | null => (pane.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect() ?? null;
    const vis = (sel: string): boolean => {
      const el = pane.querySelector(sel) as HTMLElement | null;
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const paneR = pane.getBoundingClientRect();
    return {
      editorVisible: vis('[data-pkc-field="sql-editor"]') || vis('[data-pkc-field="sql-input"]'),
      mainOverflow: main.scrollHeight - main.clientHeight,
      paneBottom: paneR.bottom,
      scroll: rect('[data-pkc-field="sql-er-scroll"]'),
      panel: rect('[data-pkc-field="sql-er-panel"]'),
      sqlLine: rect('[data-pkc-field="sql-er-sql"]'),
      docOverflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  expect(m.editorVisible, 'ER 図のタブなのに SQL の欄が見えている').toBe(false);
  expect(m.mainOverflow, 'SQL の面が縦にあふれている(最下端へはみ出す)').toBeLessThanOrEqual(1);
  expect(m.scroll, '前提: 図の枠が無い').not.toBeNull();
  expect(m.panel, '前提: ER の欄が無い').not.toBeNull();
  // 図が残りの高さを使う: 図の枠の高さが ER の欄の高さの大半を占める(3 割の固定ではない)
  expect(m.scroll!.height / m.panel!.height, '図が残りの高さを使っていない(固定の高さのまま)').toBeGreaterThan(0.6);
  // 読み取り専用の SQL の 1 行が面の中に収まる
  if (m.sqlLine !== null && m.sqlLine.height > 0) expect(m.sqlLine.bottom, 'SQL の 1 行が面の下へはみ出している').toBeLessThanOrEqual(m.paneBottom + 1);
  expect(m.docOverflow, '画面全体が縦にあふれている').toBeLessThanOrEqual(1);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

for (const width of [390, 360, 320]) {
  test(`🔴 6: スマホ幅 ${width}px で並び順の「⇅」が単独の行へ折り返さない (Stage 2 PR-3)`, async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width, height: 844 });
    await gotoApp(page);
    await expect(page.locator('[data-pkc-region="shell"]')).toHaveAttribute('data-pkc-layout', 'phone');
    // 🔴 いちばん長い選択肢(幅が最大になる並び順)を選んでから測る ── 短い字のときだけ収まる偽の緑を作らない
    await page.evaluate(() => {
      const sel = document.querySelector('[data-pkc-field="entry-sort"]') as HTMLSelectElement;
      const longest = [...sel.options].sort((x, y) => y.text.length - x.text.length)[0]!;
      sel.value = longest.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const q = (s: string) => (document.querySelector(s) as HTMLElement).getBoundingClientRect();
      const sort = q('[data-pkc-field="entry-sort"]');
      const rev = q('[data-pkc-field="entry-sort-reverse"]');
      const filter = q('[data-pkc-field="entry-filter"]');
      const bar = q('[data-pkc-region="find-bar"]');
      return { sortTop: Math.round(sort.top), sortW: sort.width, revTop: Math.round(rev.top), filterTop: Math.round(filter.top), barRight: bar.right, revRight: rev.right, revW: rev.width };
    });
    expect(r.revW, '前提: ⇅ が描かれていない').toBeGreaterThan(0);
    expect(r.revTop, '⇅ が並び順の欄と別の行に落ちている').toBe(r.sortTop);
    expect(r.sortW, '並び順の欄が細すぎて字が切れる').toBeGreaterThan(110);
    expect(r.revRight, '⇅ が帯の外へはみ出している').toBeLessThanOrEqual(r.barRight + 0.5);
    expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
  });
}

test('🔴 7: ログの並び順ボタンと「すべて折りたたむ」が同じ行に並ぶ (Stage 2 PR-3)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  const log = Array.from({ length: 6 }, (_, i) => [`## 2026-10-0${1 + Math.floor(i / 2)} ${String(8 + (i % 2) * 4).padStart(2, '0')}:00:00`, `記録${i + 1}の本文です。`]).flat().join('\n\n');
  await commitNew(page, 'textlog', 'ログの並び', log);
  const order = page.locator('[data-pkc-field="detail-body"] [data-pkc-field="log-order"]');
  const all = page.locator('[data-pkc-field="detail-body"] [data-pkc-log-all]');
  await expect(order, '並び順のボタンが出ない').toBeVisible();
  await expect(all, '「すべて折りたたむ」が出ない').toBeVisible();
  const r = await page.evaluate(() => {
    const g = (s: string) => (document.querySelector(s) as HTMLElement).getBoundingClientRect();
    const o = g('[data-pkc-field="detail-body"] [data-pkc-field="log-order"]');
    const a = g('[data-pkc-field="detail-body"] [data-pkc-log-all]');
    const days = document.querySelector('[data-pkc-log-days]') as HTMLElement;
    const first = ([...days.children].find((c) => !(c as HTMLElement).matches('[data-pkc-field="log-order"], [data-pkc-log-all]')) as HTMLElement).getBoundingClientRect();
    return { oTop: Math.round(o.top), aTop: Math.round(a.top), oBottom: o.bottom, aBottom: a.bottom, firstTop: first.top };
  });
  expect(r.aTop, '並び順のボタンと「すべて折りたたむ」が別の行に分かれている').toBe(r.oTop);
  expect(r.firstTop - Math.max(r.oBottom, r.aBottom), 'ボタンの行と最初の日の行の間が空きすぎている').toBeLessThan(24);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

for (const vp of [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
]) {
  test(`🔴 8-1: ヘルプを開いた時点で検索欄と本文が画面に入り、目次・検索で該当の見出しが見える・Ctrl+F で WebMCP まで当たる(${vp.w}×${vp.h}) (Stage 2 PR-3)`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await gotoApp(page);
    await dismissAnnounce(page);
    // スマホ幅には左のバーが無いので、どちらの幅でも断片で開く
    await page.evaluate(() => {
      location.hash = '#pkc?view=help';
    });
    const find = page.locator('[data-pkc-field="help-find"]');
    const manual = page.locator('[data-pkc-region="help-manual"]');
    await expect(find).toBeVisible();
    await expect(manual.locator('h1,h2,h3').first(), 'マニュアルが描かれない').toBeVisible({ timeout: 20_000 });
    const inView = (sel: string): Promise<{ top: number; bottom: number; vh: number }> =>
      page.evaluate((s) => {
        const r = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      }, sel);
    // ① 開いた時点で検索欄と本文の頭が画面の中
    const f = await inView('[data-pkc-field="help-find"]');
    expect(f.top, '検索欄が画面の外にある').toBeLessThan(f.vh - 40);
    const m = await inView('[data-pkc-region="help-manual"]');
    expect(m.top, `本文の箱が画面の外にある(top=${m.top}, vh=${m.vh})`).toBeLessThan(m.vh - 80);
    expect(await manual.evaluate((el) => getComputedStyle(el).overflowY), '入れ子のスクロールの箱が残っている').toBe('visible');
    // 版は出したまま・畳んだ欄は閉じている
    await expect(page.locator('[data-pkc-field="help-version"]')).toBeVisible();
    expect(await page.locator('[data-pkc-region="help-meta"]').evaluate((el) => (el as HTMLDetailsElement).open), 'メタ情報の欄が開いている').toBe(false);

    // ② 検索 → 結果を押す → 該当の見出しが画面の中に来て光り、本文の一致箇所が塗られる
    await find.fill('WebMCP');
    const hits = page.locator('[data-pkc-region="help-find-hits"] button');
    await expect(hits.first()).toBeVisible();
    await hits.first().scrollIntoViewIfNeeded();
    await hits.first().click();
    await expect.poll(async () => {
      const h = await page.evaluate(() => {
        const el = document.querySelector('[data-pkc-region="help-manual"] [data-pkc-jump-flash]') as HTMLElement | null;
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });
      return h !== null && h.top >= 0 && h.bottom <= h.vh;
    }, { message: '検索結果を押しても、該当の見出しが画面の中へ来ない' }).toBe(true);
    // 塗り(CSS Custom Highlight)が使える環境では、登録されている
    const painted = await page.evaluate(() => (window.CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.has('pkc-search-hit') ?? null);
    if (painted !== null) expect(painted, '探した語が本文で塗られていない').toBe(true);
    await expect(page.locator('[data-pkc-field="manual-jump-back"]')).toBeInViewport();

    // ③ 目次を押す → 該当の見出しが画面の中
    await find.fill('');
    await page.locator('[data-pkc-field="manual-jump-back"]').click().catch(() => undefined);
    const row = page.locator('[data-pkc-field="help-toc-row"]').nth(30);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect.poll(async () => {
      const h = await page.evaluate(() => {
        const el = document.querySelector('[data-pkc-region="help-manual"] [data-pkc-jump-flash]') as HTMLElement | null;
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });
      return h !== null && h.top >= 0 && h.bottom <= h.vh;
    }, { message: '目次を押しても、該当の見出しが画面の中へ来ない' }).toBe(true);

    // ④ Ctrl+F 相当(window.find): 末尾の WebMCP まで当たり、描画済みで、画面の中に出る
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const found = await page.evaluate(async () => {
      (document.querySelector('[data-pkc-region="detail"]') as HTMLElement).scrollTop = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = (window as any).find('WebMCP', true, false, true, false, false, false);
      const sel = window.getSelection();
      const rng = sel !== null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      // 送りが落ち着くまで待つ(最大 2 秒)
      let r = rng?.getBoundingClientRect() ?? null;
      for (let i = 0; i < 40 && r !== null && !(r.top >= 0 && r.bottom <= window.innerHeight); i += 1) {
        await new Promise((res) => setTimeout(res, 50));
        r = rng?.getBoundingClientRect() ?? null;
      }
      // 🔴 描画済みの語へ、ブラウザの検索と同じ「選択を画面へ送る」を行い、画面の中に入ることを見る
      rng?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((res) => setTimeout(res, 100));
      r = rng?.getBoundingClientRect() ?? null;
      return { ok, text: sel?.toString() ?? '', rect: r === null ? null : { top: r.top, bottom: r.bottom, w: r.width, h: r.height }, vh: window.innerHeight };
    });
    expect(found.ok, 'window.find(WebMCP) が当たらない').toBe(true);
    expect(found.text.toLowerCase()).toContain('webmcp');
    expect(found.rect, '当たった所に矩形が無い(描画されていない)').not.toBeNull();
    expect(found.rect!.w * found.rect!.h, '当たった所の矩形が 0(描画されていない)').toBeGreaterThan(0);
    expect(found.rect!.top >= 0 && found.rect!.bottom <= found.vh, `当たった所が画面の外(${JSON.stringify(found.rect)} / vh ${found.vh})`).toBe(true);
    expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
  });
}
