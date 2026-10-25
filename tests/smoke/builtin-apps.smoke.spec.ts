import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **組み込みアプリ 3 つを、実ブラウザで押す**(#281 ① 関係グラフ / #277 カンバン / #683 ① 計った時間)。
 *
 * unit(happy-dom)では届かない層:
 * ① 節点・列・行が**本当に見えて、押せる所に在る**(`elementFromPoint` / 実座標)
 * ② HTML5 の drag(`dragstart` → `dragover` → `drop`)が実ブラウザで列に届き、**保存された本文**が変わる
 * ③ タイマーを止める → 本文の行 → worker の走査 → 面 の全段(配線)
 */

/**
 * 左のタブを開く。⚠ 8 枚になって、1440px では「グラフ」「時間」が「⋯」の下へ畳まれる(#1621)── 畳まれていれば
 * user と同じに「⋯」を開いて名前つきの項目を押す(畳んだ物が押せることの確認も兼ねる)。
 */
async function openBrowseTab(page: import('@playwright/test').Page, mode: string): Promise<void> {
  const tab = page.locator(`[data-pkc-region="browse-tabs"] [data-pkc-browse="${mode}"]`);
  if (await tab.evaluate((el) => el.hasAttribute('data-pkc-overflow'))) {
    await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-field="bar-more"]');
    await clickReal(
      page,
      `[data-pkc-region="context-menu"] [data-pkc-action="set-browse"][data-pkc-browse="${mode}"]`,
    );
  } else {
    await clickReal(page, tab);
  }
}

/** 本文を書いて保存する(連絡先の smoke と同じ手順)。 */
async function writeBody(page: import('@playwright/test').Page, body: string): Promise<void> {
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(body);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('🔴 関係グラフ: 本文のリンクが図になり、節点を押すとそのノートへ移る (#281 ①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // B を作り、その lid を読む。A は B へのリンクを持つ
  await createEntry(page, 'text');
  await writeBody(page, '# 行き先B');
  const row = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').first();
  const lidB = await row.getAttribute('data-pkc-entry');
  expect(lidB, 'B の lid が読めない').toBeTruthy();
  await createEntry(page, 'text');
  await writeBody(page, `# 起点A\n\n[行き先B](entry:${lidB})`);

  await openBrowseTab(page, 'graph');
  const pane = page.locator('[data-pkc-browse-pane="graph"]');
  await expect(pane, 'グラフのタブが開かない').toBeVisible();
  const nodes = pane.locator('[data-pkc-action="select-entry"]');
  await expect(nodes, '本文のリンクが図になっていない(節点が 2 つ出ない)').toHaveCount(2);
  await expect(pane.locator('[data-pkc-field="graph-edge"]'), '辺が出ていない').toHaveCount(1);

  // ① 🔴 節点が本当に押せる所に在る(別の要素に覆われていない)
  const hits = await nodes.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { w: Math.round(r.width), hit: at === el || el.contains(at) };
    }),
  );
  for (const h of hits) {
    expect(h.w, '節点が潰れている').toBeGreaterThan(8);
    expect(h.hit, '節点が別の要素に覆われていて押せない').toBe(true);
  }

  // ② 手先のボタン / 全体 の切替が画面に効く
  await expect(pane.locator('[data-pkc-graph-depth="2"]')).toHaveAttribute('aria-pressed', 'true');
  await clickReal(page, pane.locator('[data-pkc-graph-scope="all"]'));
  await expect(pane.locator('[data-pkc-graph-scope="all"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.locator('[data-pkc-graph-depth]'), '全体なのに手先のボタンが残っている').toHaveCount(0);
  // 全体は関係(relations)だけ ── 本文のリンクだけの組は出ず、その旨の案内が出る
  await expect(pane.locator('[data-pkc-field="graph-note"]')).toContainText('つながり');
  await clickReal(page, pane.locator('[data-pkc-graph-scope="selected"]'));
  await expect(nodes).toHaveCount(2);

  // ③ 🔴 節点を押すと、そのノートへ移る(選択が替わり、印も移る)
  const current = pane.locator('[aria-current="true"]');
  const before = await current.getAttribute('data-pkc-entry');
  const other = pane.locator('[data-pkc-field="graph-node"]'); // 選んでいない側の節点
  await expect(other, '選んでいない側の節点が 1 つ').toHaveCount(1);
  await clickReal(page, other);
  await expect
    .poll(async () => await pane.locator('[aria-current="true"]').getAttribute('data-pkc-entry'), {
      message: '節点を押しても選択が移らない',
    })
    .not.toBe(before);
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 カンバン: 別ウィンドウの予定表で、カードを完了の列へ動かすと本文が [x] になる (#277)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await writeBody(page, '# やること\n\n- [ ] 見積を送る @2026-10-30\n- [x] 済んだ件 @2026-10-29\n- [ ] 体裁のチェック');

  // 別ウィンドウの予定表と同じ面(中央の器)を開く
  await page.evaluate(() => {
    location.hash = '#pkc?view=schedule';
  });
  const face = page.locator('[data-pkc-view-pane="schedule"]');
  await expect(face, '予定表の面が開かない').toBeVisible();
  await clickReal(page, face.locator('[data-pkc-mode="board"]'));

  const open = face.locator('[data-pkc-drop-status="open"]');
  const done = face.locator('[data-pkc-drop-status="done"]');
  await expect(open.locator('[data-pkc-entry]'), '未完了の列に日付付きのカードが 1 枚').toHaveCount(1);
  await expect(done.locator('[data-pkc-entry]'), '完了の列に済んだカードが 1 枚').toHaveCount(1);
  await expect(face.locator('[data-pkc-region="schedule-board"]'), '日付なしがカードになっている').not.toContainText('体裁のチェック');
  // 列が横に並び、どちらも見えて高さがある(押せる・落とせる)
  const [ob, db] = await Promise.all([open.boundingBox(), done.boundingBox()]);
  expect(ob && db && ob.x < db.x && ob.height > 40 && db.height > 40, '2 列が並んで見えていない').toBe(true);

  // 🔴 実ブラウザの drag & drop(dragstart → dragover → drop)
  await open.locator('[data-pkc-entry]').first().dragTo(done);
  await expect(done.locator('[data-pkc-entry]'), '完了の列へ動いていない(本文に書かれていない)').toHaveCount(2, {
    timeout: 10_000,
  });
  await expect(open.locator('[data-pkc-entry]')).toHaveCount(0);
  // 戻す方向(片道にしない)
  await done.locator('[data-pkc-entry]', { hasText: '見積を送る' }).dragTo(open);
  await expect(open.locator('[data-pkc-entry]'), '未完了へ戻せない').toHaveCount(1, { timeout: 10_000 });
  await expect(open.locator('[data-pkc-entry]')).toContainText('見積を送る');
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 計った時間: 止めた行が一覧に並び、名前を付けて、消せる (#683 ①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await writeBody(page, '# 設計メモ');
  await clickReal(page, '[data-pkc-field="start-timer"]');
  await expect(page.locator('[data-pkc-region="timer-bar"]')).toBeVisible();
  await clickReal(page, '[data-pkc-action="stop-timer"]');
  await expect(page.locator('[data-pkc-region="timer-bar"]')).toBeHidden();

  // タブを開いたときに集める(本文 → worker の走査 → 面 の全段)
  await openBrowseTab(page, 'timers');
  const pane = page.locator('[data-pkc-browse-pane="timers"]');
  await expect(pane, '時間のタブが開かない').toBeVisible();
  const row = pane.locator('[data-pkc-work-run]');
  await expect(row, '止めた行が一覧に並ばない').toHaveCount(1, { timeout: 15_000 });
  await expect(row.locator('[data-pkc-field="timers-when"]')).toHaveText(/^\d\d:\d\d–\d\d:\d\d\(\d+:\d\d\)$/);
  await expect(pane.locator('[data-pkc-field="timers-day-head"]')).toContainText('合計');

  // 名前を付ける(小窓で打つ)
  await clickReal(page, row.locator('[data-pkc-action="timer-run-rename"]').first());
  await page.locator('[data-pkc-field="prompt-input"]').fill('設計の見直し');
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect(row.locator('[data-pkc-field="timers-name"]'), '名前が一覧に出ない').toHaveText('設計の見直し', {
    timeout: 10_000,
  });
  // 本文にも入っている(正本は本文)
  await clickReal(page, row.locator('[data-pkc-field="timers-note-open"]'));
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toContainText('設計の見直し');

  // 外す → 付け直す前に消す
  await clickReal(page, row.locator('[data-pkc-timer-clear]'));
  await expect(row.locator('[data-pkc-field="timers-name"]'), '名前が外れない').toHaveCount(0, { timeout: 10_000 });
  await clickReal(page, row.locator('[data-pkc-action="timer-run-delete"]'));
  await expect(row, '消しても一覧に残る').toHaveCount(0, { timeout: 10_000 });
  await expect(pane.locator('[data-pkc-field="timers-note"]')).toContainText('まだありません');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('元に戻す');
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
