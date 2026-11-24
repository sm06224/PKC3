/**
 * 🔴 **ツールバーの統一・ファイラー用の頭の畳み・リンクを足す欄の開閉**(#1442 S3-2。user 指示 2026-11-24)。実ブラウザの座標・押して開閉する動線。
 *
 * | # | 主張 | 観測 |
 * |---|---|---|
 * | 1 | ファイラー以外のタブでは、効かない部分(並び順・作る帯・グラフ/PC/シェルでは探す欄も)が**見えず**、一覧が上へ上がる。語で絞るタブでは探す欄が残り、音/動画・時間では作る帯(録音・計るの入口)が残る。フォルダへ戻ると元どおり出る(双方向) | `boundingBox` が null / 一覧の top の差 |
 * | 2 | スマホ幅でも畳まれ、メッセージの入口(作る帯の末尾に居る)は残る | 入口の矩形が画面内 |
 * | 3 | アプリの「+ リンクを追加」は既定で閉じ、組み込みアプリの 1 行目が上へ上がる / 実クリックで開く(焦点=名前)・Esc・キャンセル・追加で閉じる(焦点=ボタン) | 矩形・activeElement |
 * | 4 | 計算・差分・テキスト整形・2 ペインで、奥へ回した操作は**メニューを押すまで見えず**、開くと画面の中に出て押せる / 主は地が `--accent` | 矩形・computed style・消すが効く |
 * | 5 | 2 ペインの「その他 ▾」は**上へ**開き、画面の外へ出ない | メニューの底が summary の上 |
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce, openBrowse } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

async function commitNew(page: Page, title: string, body: string): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

/** 左のペインのタブへ(スマホ幅は一覧のページへ戻ってから)。 */
async function openLeft(page: Page, mode: string): Promise<void> {
  const back = page.locator('[data-pkc-action="phone-page"][data-pkc-page="list"]').first();
  if (await back.isVisible().catch(() => false)) await back.click({ timeout: 2000 }).catch(() => undefined);
  await openBrowse(page, mode);
}

const box = (page: Page, sel: string): Promise<{ x: number; y: number; width: number; height: number } | null> =>
  page.locator(sel).first().boundingBox();

const visible = async (page: Page, sel: string): Promise<boolean> => {
  const b = await box(page, sel);
  return b !== null && b.height > 0;
};
/** 頭の 4 つの部分(探す欄 / 並び順 / 作る帯 / 作る帯の「+ ノート」)が見えているか。 */
const parts = async (page: Page): Promise<{ search: boolean; sort: boolean; create: boolean }> => ({
  search: await visible(page, '[data-pkc-field="entry-filter"]'),
  sort: await visible(page, '[data-pkc-field="entry-sort"]'),
  create: await visible(page, '[data-pkc-region="sidebar"] [data-pkc-field="create-run"]'),
});
const hostTop = async (page: Page): Promise<number> => (await box(page, '[data-pkc-region="browse-host"]'))!.y;

test('🔴 1: ファイラー以外のタブでは効かない部分が畳まれ、一覧が上へ上がる。フォルダへ戻ると元どおり(双方向)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await commitNew(page, '議事録', '予定 2026-11-25 会議');

  // 対照群: フォルダでは探す欄・並び順・作る帯が出ている(これが出ていない台では、畳んだ主張が空振りする)
  await openLeft(page, 'filer');
  expect(await parts(page), '前提: フォルダで頭が出ていない').toEqual({ search: true, sort: true, create: true });
  const topFiler = await hostTop(page);

  // 語で絞るタブ(予定・アプリ・連絡先): 探す欄は残り、並び順と作る帯が畳まれる(約 70px 広がる)
  for (const mode of ['schedule', 'launcher', 'contacts']) {
    await openLeft(page, mode);
    expect(await parts(page), `${mode}: 畳む部分が表と違う`).toEqual({ search: true, sort: false, create: false });
    const top = await hostTop(page);
    expect(topFiler - top, `${mode}: 一覧の領域が上へ広がっていない(フォルダ ${topFiler} / ここ ${top})`).toBeGreaterThanOrEqual(50);
  }
  // 音/動画・時間: 録音・画面録画・時間を計るの入口は作る帯にしか無いので、作る帯は残す(並び順だけ畳む)
  for (const mode of ['captures', 'timers']) {
    await openLeft(page, mode);
    expect(await parts(page), `${mode}: 畳む部分が表と違う`).toEqual({ search: true, sort: false, create: true });
  }
  // 絞りが効かないタブ(グラフ・シェル): 探す欄・並び順・作る帯を畳む。⚠ 戻る・進む・最近(‹ › ◷)だけはマウスで届くよう残す
  for (const mode of ['graph', 'shell']) {
    await openLeft(page, mode);
    expect(await parts(page), `${mode}: 畳む部分が表と違う`).toEqual({ search: false, sort: false, create: false });
    for (const r of ['create-bar', 'kind-bar'])
      expect(await visible(page, `[data-pkc-region="sidebar"] > [data-pkc-region="${r}"]`), `${mode}: ${r} が見えている`).toBe(false);
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('[data-pkc-region="sidebar"] > [data-pkc-region="find-bar"] > *')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => el.getAttribute('data-pkc-action') ?? el.getAttribute('data-pkc-field') ?? el.tagName),
    );
    // ⚠ ブラウザのタブ(幅が広い・アプリとして開いていない)では ‹ › はもともと出さない(ブラウザの戻る・マウスの戻るが効く ── `nav-history.smoke`)。
    //   ここで残るのは ◷ だけ。‹ › が出る場(アプリとして開いた / スマホ幅)でも畳む規則は ‹ › を除外している(`filer-header-fold.test.ts`)
    expect(shown, `${mode}: 探す欄の段に残る物が「最近」と違う`).toEqual(['open-recent']);
    // 実際に押せる(覆われていない)── 最近を押すと最近開いたノートの一覧が出る
    const recent = page.locator('[data-pkc-region="sidebar"] [data-pkc-action="open-recent"]');
    const rb = (await recent.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null, [rb.x + rb.width / 2, rb.y + rb.height / 2]);
    expect(hit, `${mode}: 最近のボタンが覆われている`).toBe('open-recent');
    const top = await hostTop(page);
    expect(topFiler - top, `${mode}: 一覧の領域が上へ広がっていない(フォルダ ${topFiler} / ここ ${top})`).toBeGreaterThanOrEqual(50);
  }

  // 双方向: フォルダへ戻ると出る
  await openLeft(page, 'filer');
  await expect(page.locator('[data-pkc-region="sidebar"]')).not.toHaveAttribute('data-pkc-filer-fold', /.+/);
  expect(await parts(page), 'フォルダへ戻っても元に戻らない').toEqual({ search: true, sort: true, create: true });
  expect(await hostTop(page)).toBeCloseTo(topFiler, 0);

  // 狭い幅(左のペインが細くなる 1000px)でも、往復のあと作る帯は 1 段のまま(帯の測り直し = `bar-overflow.ts` が畳み直しで壊れない)
  await page.setViewportSize({ width: 1000, height: 800 });
  const rows = (): Promise<number> =>
    page.evaluate(() => {
      const bar = document.querySelector('[data-pkc-region="sidebar"] > [data-pkc-region="create-bar"]')!;
      const tops = new Set(
        [...bar.querySelectorAll('button')]
          .filter((b) => b.getBoundingClientRect().width > 0)
          .map((b) => Math.round(b.getBoundingClientRect().top)),
      );
      return tops.size;
    });
  await openLeft(page, 'filer');
  expect(await rows(), '前提: 狭い幅のフォルダで作る帯が 1 段でない').toBe(1);
  await openLeft(page, 'graph');
  await openLeft(page, 'filer');
  await page.waitForTimeout(150);
  expect(await rows(), '往復のあと、作る帯が 2 段に割れている(測り直されていない)').toBe(1);
  // スマホ幅(‹ › が出る場)では、グラフのタブでも ‹ › ◷ が残る(マウス・指だけで元のノートへ戻れる)
  await page.setViewportSize({ width: 390, height: 844 });
  await openLeft(page, 'graph');
  for (const a of ['nav-back', 'nav-forward', 'open-recent'])
    await expect(page.locator(`[data-pkc-region="sidebar"] > [data-pkc-region="find-bar"] > [data-pkc-action="${a}"]`), `スマホ幅のグラフで ${a} が消えた`).toBeVisible();
  await expect(page.locator('[data-pkc-region="sidebar"] [data-pkc-field="entry-filter"]'), 'スマホ幅のグラフで探す欄が出ている').toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });

  // 探す欄への焦点(鍵の入口): 畳んでいる(グラフ)ときはフォルダのタブへ移ってから入る / 見えている(予定)ときはタブを動かさずに入る
  await openLeft(page, 'graph');
  await page.keyboard.press('Control+Shift+f');
  await expect(page.locator('[data-pkc-region="sidebar"]')).not.toHaveAttribute('data-pkc-filer-fold', /.+/);
  await expect(page.locator('[data-pkc-field="entry-filter"]')).toBeFocused();
  await openLeft(page, 'schedule');
  await page.keyboard.press('Control+Shift+f');
  await expect(page.locator('[data-pkc-region="sidebar"]')).toHaveAttribute('data-pkc-filer-fold', 'sort create');
  await expect(page.locator('[data-pkc-field="entry-filter"]')).toBeFocused();

  // 連絡先: 語で絞って 0 件になっても、探す欄が見えているので「絞りを外す」へ辿れる(行き止まりにならない)
  await openLeft(page, 'contacts');
  await page.locator('[data-pkc-field="entry-filter"]').fill('当たらない語');
  await expect(page.locator('[data-pkc-region="sidebar"]')).toHaveAttribute('data-pkc-filer-fold', 'sort create');
  expect(await visible(page, '[data-pkc-field="entry-filter"]'), '絞っているのに探す欄が見えない').toBe(true);
  await page.locator('[data-pkc-field="entry-filter"]').fill('');
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 2: スマホ幅でも畳まれ、メッセージの入口は残る(390×844)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await commitNew(page, '買い物', '牛乳');
  await page.setViewportSize({ width: 390, height: 844 });
  await openLeft(page, 'filer');
  const entry = page.locator('[data-pkc-region="sidebar"] [data-pkc-field="message-entry"]');
  await expect(entry, '前提: フォルダでメッセージの入口が一覧のページに無い').toBeVisible();
  expect((await parts(page)).create, '前提: フォルダで作る帯が出ていない').toBe(true);
  await openLeft(page, 'graph');
  expect(await parts(page), 'グラフ: 頭が畳まれていない').toEqual({ search: false, sort: false, create: false });
  // 入口だけが残る(どの画面からも届く常設の入口)
  const eb = (await entry.boundingBox())!;
  expect(eb.height).toBeGreaterThan(0);
  expect(eb.y + eb.height, '入口が画面の外').toBeLessThanOrEqual(844);
  // 作る帯の他の子(+ ノート など)は見えない
  expect(await visible(page, '[data-pkc-region="sidebar"] [data-pkc-field="create-run"]'), '作る帯の「+ ノート」が見えている').toBe(false);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 3: アプリの「+ リンクを追加」は既定で閉じ、実クリックで開閉する(焦点・Esc・キャンセル・追加)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await openLeft(page, 'launcher');
  const open = page.locator('[data-pkc-field="launcher-add-open"]');
  const form = page.locator('[data-pkc-region="launcher-add"]');
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await expect(form, '既定で欄が開いている').toBeHidden();
  const firstTile = '[data-pkc-region="launcher-grid"] [data-pkc-tile]';
  await expect(page.locator(firstTile).first(), '前提: 組み込みアプリの一覧が出ていない').toBeVisible();
  const closedTop = (await box(page, firstTile))!.y;
  // 直す前は 3 行の欄 + ファイラー用の頭で 1 行目が y≒290 にあった。頭を畳み欄を閉じた今は 200 未満(1280×800)
  expect(closedTop, `1 行目のタイルが上へ上がっていない(y=${closedTop})`).toBeLessThan(200);
  const openBox = (await open.boundingBox())!;
  expect(openBox.y, 'ボタンが最上段にない').toBeLessThan(closedTop);

  // 開く: 欄が出て、最初の入力欄(名前)へ焦点・一覧は下へ(押される)
  await clickReal(page, open);
  await expect(form).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-pkc-field="launcher-add-name"]')).toBeFocused();
  const openedTop = (await box(page, firstTile))!.y;
  expect(openedTop, '欄を開いたのに一覧が動かない(欄が重なっている)').toBeGreaterThan(closedTop + 40);
  // 欄の矩形が一覧と重ならない
  const fb = (await form.boundingBox())!;
  expect(fb.y + fb.height, '欄が一覧の 1 行目に食い込んでいる').toBeLessThanOrEqual(openedTop + 1);

  // Esc で閉じて、焦点はボタンへ
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(open).toBeFocused();
  expect((await box(page, firstTile))!.y).toBeCloseTo(closedTop, 0);

  // キャンセルで閉じて字を消す
  await clickReal(page, open);
  await page.locator('[data-pkc-field="launcher-add-url"]').fill('https://example.com/x');
  await clickReal(page, '[data-pkc-field="launcher-add-cancel"]');
  await expect(form).toBeHidden();
  await expect(open).toBeFocused();
  await clickReal(page, open);
  await expect(page.locator('[data-pkc-field="launcher-add-url"]')).toHaveValue('');

  // 追加できたら閉じて、リンクが一覧に出る
  await page.locator('[data-pkc-field="launcher-add-name"]').fill('ざっくり地図');
  await page.locator('[data-pkc-field="launcher-add-url"]').fill('https://example.com/map');
  await clickReal(page, '[data-pkc-field="launcher-add-go"]');
  await expect(form).toBeHidden();
  await expect(open).toBeFocused();
  await expect(page.locator('[data-pkc-region="launcher-grid"]').getByText('ざっくり地図')).toBeVisible();
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

async function openView(page: Page, view: string): Promise<void> {
  await page.evaluate((v) => {
    location.hash = `#pkc?view=${v}`;
  }, view);
  await expect(page.locator(`[data-pkc-view-pane="${view}"]`)).toBeVisible({ timeout: 15_000 });
}

/** 要素の地の色が `--accent` と同じか(主の型が実際に効いているか)。 */
async function backgroundIsAccent(page: Page, sel: string): Promise<boolean> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement;
    const probe = document.createElement('div');
    probe.style.background = 'var(--accent)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(el).backgroundColor === accent;
  }, sel);
}

test('🔴 4: 計算・差分・テキスト整形の奥へ回した操作は、メニューを押すまで見えず、開くと画面の中で押せる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await commitNew(page, '下書き', '本文');

  // ── 計算
  await openView(page, 'calc');
  const calc = page.locator('[data-pkc-view-pane="calc"]');
  await calc.locator('[data-pkc-field="calc-input"]').fill('単価 = 3200\n数量 = 4\n合計');
  await expect(calc.locator('[data-pkc-action="calc-copy"]'), '常用(コピー)が直下に出ていない').toBeVisible();
  expect(await backgroundIsAccent(page, '[data-pkc-view-pane="calc"] [data-pkc-action="calc-copy"]'), '主(コピー)の地が --accent でない').toBe(true);
  await expect(calc.locator('[data-pkc-action="calc-clear"]'), '奥の「消す」が最初から見えている').toBeHidden();
  await expect(calc.locator('[data-pkc-action="calc-to-table"]'), '奥の「ノートにする」が最初から見えている').toBeHidden();
  await clickReal(page, calc.locator('[data-pkc-field="calc-out"] > summary'));
  await expect(calc.locator('[data-pkc-action="calc-to-table"]')).toBeVisible();
  await expect(calc.locator('[data-pkc-action="calc-to-text"]')).toBeVisible();
  // 外を押すと閉じる(メニューの外 = 面の題)
  await clickReal(page, calc.locator('[data-pkc-field="pane-title"]'));
  await expect(calc.locator('[data-pkc-action="calc-to-table"]')).toBeHidden();
  await clickReal(page, calc.locator('[data-pkc-field="calc-more"] > summary'));
  const clear = calc.locator('[data-pkc-action="calc-clear"]');
  await expect(clear).toBeVisible();
  const cb = (await clear.boundingBox())!;
  expect(cb.x >= 0 && cb.y >= 0 && cb.x + cb.width <= 1280 && cb.y + cb.height <= 800, '「消す」が画面の外').toBe(true);
  // 消すが効く(奥へ移しても機能は生きている)・押したらメニューは閉じる
  await clickReal(page, clear);
  await expect(calc.locator('[data-pkc-field="calc-input"]')).toHaveValue('');
  await expect(clear).toBeHidden();
  // Esc で閉じて焦点が summary へ戻る
  await clickReal(page, calc.locator('[data-pkc-field="calc-more"] > summary'));
  await page.keyboard.press('Escape');
  await expect(calc.locator('[data-pkc-action="calc-clear"]')).toBeHidden();
  await expect(calc.locator('[data-pkc-field="calc-more"] > summary')).toBeFocused();

  // ── 差分マージ
  await openView(page, 'diff');
  const diff = page.locator('[data-pkc-view-pane="diff"]');
  const save = diff.locator('[data-pkc-action="diff-save"]');
  await expect(save).toBeVisible();
  expect(await backgroundIsAccent(page, '[data-pkc-view-pane="diff"] [data-pkc-action="diff-save"]'), '主(保存)の地が --accent でない').toBe(true);
  for (const a of ['diff-undo', 'diff-redo', 'diff-toggle-all']) await expect(diff.locator(`[data-pkc-action="${a}"]`), a).toBeVisible();
  await expect(diff.locator('[data-pkc-action="diff-reset"]'), '奥の「読み込んだ状態に戻す」が最初から見えている').toBeHidden();
  const moreSum = diff.locator('[data-pkc-field="diff-bar-more"] > summary');
  const sb = (await save.boundingBox())!;
  const mb = (await moreSum.boundingBox())!;
  expect(sb.x, '保存が「その他 ▾」より右(右端)にない').toBeGreaterThan(mb.x + mb.width - 1);
  await clickReal(page, moreSum);
  for (const a of ['diff-reset']) await expect(diff.locator(`[data-pkc-action="${a}"]`)).toBeVisible();
  await expect(diff.locator('[data-pkc-action="diff-take-all"]')).toHaveCount(2);
  await expect(diff.locator('[data-pkc-action="diff-take-all"][data-pkc-from="a"]')).toBeVisible();
  await page.keyboard.press('Escape');

  // ── テキスト整形
  await openView(page, 'textlab');
  const lab = page.locator('[data-pkc-view-pane="textlab"]');
  await lab.locator('[data-pkc-field="textlab-input"]').fill('  あいう  \n\n\nえお');
  await expect(lab.locator('[data-pkc-action="textlab-copy"]')).toBeVisible();
  expect(await backgroundIsAccent(page, '[data-pkc-view-pane="textlab"] [data-pkc-action="textlab-copy"]'), '主(コピー)の地が --accent でない').toBe(true);
  await expect(lab.locator('[data-pkc-action="textlab-clear"]')).toBeHidden();
  await expect(lab.locator('[data-pkc-action="textlab-to-note"]')).toBeHidden();
  await clickReal(page, lab.locator('[data-pkc-field="textlab-out"] > summary'));
  await expect(lab.locator('[data-pkc-action="textlab-to-note"]')).toBeVisible();
  await expect(lab.locator('[data-pkc-action="textlab-apply-note"]')).toBeVisible();
  const ob = (await lab.locator('[data-pkc-action="textlab-to-note"]').boundingBox())!;
  expect(ob.x >= 0 && ob.x + ob.width <= 1280 && ob.y + ob.height <= 800, '「新しいノートにする」が画面の外・窓の外へ切れている').toBe(true);
  await page.keyboard.press('Escape');
  await clickReal(page, lab.locator('[data-pkc-field="textlab-more"] > summary'));
  await clickReal(page, lab.locator('[data-pkc-action="textlab-clear"]'));
  await expect(lab.locator('[data-pkc-field="textlab-input"]')).toHaveValue('');
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 5: 2 ペインの「その他 ▾」は上へ開き画面に収まる / 集計の数え直しは右端に出ている', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await openView(page, 'dual');
  const dual = page.locator('[data-pkc-view-pane="dual"]');
  for (const a of ['dual-copy', 'dual-move', 'dual-delete', 'dual-preview-toggle'])
    await expect(dual.locator(`[data-pkc-region="dual-commands"] > [data-pkc-action="${a}"]`), `${a} が直下に無い`).toBeVisible();
  await expect(dual.locator('[data-pkc-action="dual-mkdir"]'), '奥の「フォルダを作る」が最初から見えている').toBeHidden();
  const sum = dual.locator('[data-pkc-field="dual-more"] > summary');
  // 浮き札(消せる通知)は本文のマスの右下に出る ── 何も選ばずに「移す」を押して札を出しても、「その他 ▾」は覆われない(帯の左に並べた理由)
  await clickReal(page, dual.locator('[data-pkc-action="dual-move"]'));
  await expect(page.locator('[data-pkc-field="status-close"]'), '前提: 浮き札が出ていない').toBeVisible();
  await clickReal(page, sum);
  const sb = (await sum.boundingBox())!;
  for (const a of ['dual-rename-begin', 'dual-mkdir', 'dual-mknote']) {
    const b = (await dual.locator(`[data-pkc-action="${a}"]`).boundingBox())!;
    expect(b, `${a} が開いていない`).not.toBeNull();
    expect(b.y + b.height, `${a} が summary の下へ(下へ開いている / 重なっている)`).toBeLessThanOrEqual(sb.y + 1);
    expect(b.y, `${a} が画面の上へ切れている`).toBeGreaterThanOrEqual(0);
    expect(b.x, `${a} が画面の左へ切れている`).toBeGreaterThanOrEqual(0);
    expect(b.x, `${a} が「その他 ▾」の左端より左へはみ出している(右端へ揃えている)`).toBeGreaterThanOrEqual(sb.x - 1);
    expect(b.x + b.width, `${a} が「その他 ▾」の左端から右へ開いていない`).toBeGreaterThan(sb.x);
  }
  // 「その他 ▾」は 4 つのボタンのすぐ右(左寄せ)── 右端へ飛ばさない
  const lastTile = (await dual.locator('[data-pkc-region="dual-commands"] > [data-pkc-action="dual-preview-toggle"]').boundingBox())!;
  expect(sb.x - (lastTile.x + lastTile.width), '「その他 ▾」がボタンの列から離れている').toBeLessThan(24);
  // 押した操作は生きている(フォルダを作る → 名前の打ち替えが出る / 閉じる)
  await clickReal(page, dual.locator('[data-pkc-action="dual-mkdir"]'));
  await expect(dual.locator('[data-pkc-action="dual-mkdir"]')).toBeHidden();

  await openView(page, 'query');
  const q = page.locator('[data-pkc-view-pane="query"]');
  const rb = (await q.locator('[data-pkc-action="refresh-query"]').boundingBox())!;
  const pb = (await q.locator('[data-pkc-region="query-bar"]').boundingBox())!;
  expect(rb.x + rb.width, '数え直しが帯の右端に寄っていない').toBeGreaterThan(pb.x + pb.width - 20);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
