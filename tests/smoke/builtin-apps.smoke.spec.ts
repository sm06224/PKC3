import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, openTile } from './helpers';

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

  // ⚠ #1457: 信号機の 3 列も落とし先は `open` ── 状態の「未完了」だけを名指す
  const open = face.locator('[data-pkc-drop-status="open"]:not([data-pkc-signal])');
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

  /**
   * 🔴 **信号機の列**(#1457)── 新しい起動は足さない(この道中の続き)。実ブラウザでしか見えないもの:
   *   ① 見出しの丸が本当に色を持ち、赤・黄・緑で互いに違う(CSS 変数 `--danger` / `--warn` / `--ok` が解決される)
   *   ② 4 つの列が横に並んで見え、高さがある(落とせる) ③ 完了の列へ実際にドラッグして動く
   *   ④ 「状態」で元の 2 列へ戻せる(片道にしない)
   * ⚠ 札の日付は時計しだい(期限切れ / 3 日以内 / 先)── 「信号の 3 列のどれか 1 つに居る」ことだけ見る(日付の判定は unit)。
   */
  await clickReal(page, face.locator('[data-pkc-board-layout="signal"]'));
  const sig = (c: string) => face.locator(`[data-pkc-signal="${c}"]`);
  await expect(sig('red'), '信号機の列が出ない').toBeVisible();
  const dots = await Promise.all(
    ['red', 'yellow', 'green'].map((c) =>
      sig(c).locator('[data-pkc-field="schedule-board-head"]').evaluate((el) => getComputedStyle(el, '::before').backgroundColor),
    ),
  );
  for (const d of dots) expect(d, '見出しの丸に色が無い').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(new Set(dots).size, '赤・黄・緑の丸が同じ色').toBe(3);
  const boxes = await Promise.all([sig('red'), sig('yellow'), sig('green'), done].map((l) => l.boundingBox()));
  expect(
    boxes.every((b, i) => b !== null && b.height > 40 && (i === 0 || b.x > boxes[i - 1]!.x)),
    '4 列が左から順に横に並んで見えていない',
  ).toBe(true);
  const inSignal = await face
    .locator('[data-pkc-signal] [data-pkc-region="schedule-cards"] > [data-pkc-entry]')
    .count();
  expect(inSignal, '未完了の札が信号の列のどれにも居ない').toBe(1);
  await expect(done.locator('[data-pkc-entry]'), '完了の札が完了の列に居ない').toHaveCount(1);
  // ③ 実ブラウザの drag & drop: 信号の列の札を完了の列へ
  await face
    .locator('[data-pkc-signal] [data-pkc-region="schedule-cards"] > [data-pkc-entry]')
    .first()
    .dragTo(done);
  await expect(done.locator('[data-pkc-entry]'), '完了の列へ動いていない').toHaveCount(2, { timeout: 10_000 });
  // ④ 状態に戻す
  await clickReal(page, face.locator('[data-pkc-board-layout="status"]'));
  await expect(sig('red')).toBeHidden();
  await expect(face.locator('[data-pkc-drop-status="open"]:not([data-pkc-signal])'), '状態の未完了の列が戻らない').toBeVisible();
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

test('🔴 テキスト整形: 貼る → 整え方を押す → 右に結果 → 新しいノートにすると本物の一覧に載る (#1233)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 別ウィンドウのアプリと同じ面(中央の器)を、ショートカットキー(Ctrl+Alt+8)で開く(レビュー ⚠2)
  await page.keyboard.press('Control+Alt+8');
  const pane = page.locator('[data-pkc-view-pane="textlab"]');
  await expect(pane, 'テキスト整形の面が開かない').toBeVisible({ timeout: 15_000 });

  // 実ブラウザで打つ(input イベントが本物の経路で届く)
  const input = pane.locator('[data-pkc-field="textlab-input"]');
  await clickReal(page, input);
  await page.keyboard.type('- ＡＢＣ\n- １２３');
  const output = pane.locator('[data-pkc-field="textlab-output"]');
  await expect(output, '何も選ばないうちは入力のまま').toHaveValue('- ＡＢＣ\n- １２３');

  // 押された整え方は見分けられる(aria-pressed と、地の色が実際に変わる)
  const strip = pane.locator('[data-pkc-lab-op="strip-bullets"]');
  const bgBefore = await strip.evaluate((el) => getComputedStyle(el).backgroundColor);
  await clickReal(page, strip);
  await expect(strip).toHaveAttribute('aria-pressed', 'true');
  const bgAfter = await strip.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bgAfter, '押した整え方が見た目で区別できない').not.toBe(bgBefore);
  await clickReal(page, pane.locator('[data-pkc-lab-op="to-halfwidth"]'));
  await expect(output, '重ねた整えが結果に出ない').toHaveValue('ABC\n123');

  // 置換(正規表現)も打つそばから効く
  await clickReal(page, pane.locator('[data-pkc-field="textlab-pattern"]'));
  await page.keyboard.type('\\d+');
  await clickReal(page, pane.locator('[data-pkc-field="textlab-replacement"]'));
  await page.keyboard.type('#');
  await expect(output).toHaveValue('ABC\n#');

  // 左右が並んで見え、どちらも押せる所に在る(縦に潰れていない)
  const [ib, ob] = await Promise.all([input.boundingBox(), output.boundingBox()]);
  expect(ib && ob && ib.x < ob.x && ib.height > 80 && ob.height > 80, '左右の欄が並んで見えていない').toBe(true);

  // 新しいノートにする ── 本物の一覧(保存された側)に載る
  await clickReal(page, pane.locator('[data-pkc-action="textlab-to-note"]'));
  await expect(pane.locator('[data-pkc-field="textlab-summary"]')).toContainText('新しいノート「ABC」を作りました');
  await expect(
    page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]', { hasText: 'ABC' }),
    '作ったノートが一覧に載らない',
  ).toHaveCount(1, { timeout: 10_000 });

  /**
   * 🔴 **重い正規表現でも画面が固まらない**(レビュー ⚠1)。27 字の `(a+)+$` は、メインスレッドで回すと何秒も止まる式。
   * ⚠ 本物のワーカーと `terminate()` を通す(unit は偽のワーカー / Node のスレッド)。
   *   見るのは ①式を入れた直後にページが応答する(往復が一瞬) ②やがて「重すぎるので止めました」と出る ③そのあと軽い式がまた動く(ワーカーが作り直される)。
   */
  await input.fill('aaaaaaaaaaaaaaaaaaaaaaaaaaab');
  await pane.locator('[data-pkc-field="textlab-pattern"]').fill('(a+)+$');
  await pane.locator('[data-pkc-field="textlab-replacement"]').fill('x');
  const t0 = Date.now();
  await page.evaluate(() => 1);
  expect(Date.now() - t0, '重い置換の最中にページが固まった').toBeLessThan(1000);
  await expect(pane.locator('[data-pkc-field="textlab-summary"]'), '重い置換を止めたと言わない').toContainText(
    'この置換は重すぎるので止めました',
    { timeout: 15_000 },
  );
  await expect(output, '止めたのに結果が変わっている').toHaveValue('aaaaaaaaaaaaaaaaaaaaaaaaaaab');
  await pane.locator('[data-pkc-field="textlab-pattern"]').fill('a+');
  await expect(output, '止めたあと、軽い置換が動かない').toHaveValue('xb', { timeout: 15_000 });
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 計算スクラッチパッド: 書くと各行の右に結果が同じ高さで並び、値を直すと下も変わり、読み込み直しても式が戻る (#1230)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ショートカットキー(Ctrl+Alt+9)で開く(レビュー ⚠2)。もう一度押すと本文へ戻る
  await page.keyboard.press('Control+Alt+9');
  const pane = page.locator('[data-pkc-view-pane="calc"]');
  await expect(pane, '計算スクラッチパッドの面が開かない').toBeVisible({ timeout: 15_000 });
  const input = pane.locator('[data-pkc-field="calc-input"]');
  const results = pane.locator('[data-pkc-field="calc-results"] > div');

  await clickReal(page, input);
  await page.keyboard.type('基本単価 = 3200 円\n作業時間 = 40 時間\n小計 = 基本単価 * 作業時間\n\n電車 1200円\nバス 300円\n合計');
  await expect(results, '結果の行数が左の行数と違う').toHaveCount(7);
  await expect(results.nth(2)).toHaveText('128,000');
  await expect(results.nth(6)).toHaveText('1,500');

  // 🔴 右の結果が、左の同じ行と同じ高さに並ぶ(長い式でも 1 行ぶんずれない)
  const ys = await page.evaluate(() => {
    const ta = document.querySelector('[data-pkc-field="calc-input"]') as HTMLTextAreaElement;
    const rows = [...document.querySelectorAll('[data-pkc-field="calc-results"] > div')] as HTMLElement[];
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight);
    const top = ta.getBoundingClientRect().top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    return rows.map((r, i) => ({ row: r.getBoundingClientRect().top, line: top + i * lh }));
  });
  for (const [i, y] of ys.entries()) {
    expect(Math.abs(y.row - y.line), `${i + 1} 行目の結果が左の行とずれている`).toBeLessThan(2);
  }

  // 値を直すと、下の結果も変わる(追従)
  await input.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    t.setSelectionRange(0, 0);
    t.focus();
  });
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Backspace'); // 「3200 円」を消す
  await page.keyboard.type('4000 円');
  await expect(results.nth(2), '上の値を直しても下の結果が変わらない').toHaveText('160,000');

  // 🔴 窓を閉じる・隠れる直前に、待たずに保存される(レビュー ⚠7)。打鍵の 400ms 後を待たずに、保存先を直に読む
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(
    await page.evaluate(() => localStorage.getItem('pkc3.calc-draft')),
    'pagehide で待たずに保存されていない(最後の数文字が落ちる)',
  ).toContain('4000 円');

  // 読み込み直しても式が戻る(自動で覚える)
  await page.reload();
  await page.evaluate(() => {
    location.hash = '#pkc?view=calc';
  });
  await expect(pane).toBeVisible({ timeout: 15_000 });
  await expect(input, '読み込み直したら式が消えた').toHaveValue(/4000 円/);
  await expect(results.nth(2)).toHaveText('160,000');

  // ノートにする(表)── 本物の一覧に載る
  await clickReal(page, pane.locator('[data-pkc-action="calc-to-table"]'));
  await expect(pane.locator('[data-pkc-field="calc-status"]')).toContainText('新しいノート「計算メモ');
  await expect(
    page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]', { hasText: '計算メモ' }),
    '作ったノートが一覧に載らない',
  ).toHaveCount(1, { timeout: 10_000 });
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 差分マージ: 2 つのノートのちがいを 1 か所ずつ取り込み、保存すると本物の保存先が変わる (#1231)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const rowLids = async (): Promise<string[]> =>
    page
      .locator('[data-pkc-region="filer-table"] [data-pkc-entry]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-pkc-entry') ?? ''));
  await createEntry(page, 'text');
  await writeBody(page, '# 甲\n\nりんご\nみかん\nぶどう');
  const first = await rowLids();
  await createEntry(page, 'text');
  await writeBody(page, '# 甲\n\nバナナ\nみかん\nぶどう\nもも');
  const both = await rowLids();
  const lidA = first[0]!;
  const lidB = both.find((l) => !first.includes(l))!;
  expect(lidA && lidB && lidA !== lidB, '2 つのノートの lid が読めない').toBe(true);

  // ショートカットキー(Ctrl+Alt+0)で開く(レビュー ⚠2)
  await page.keyboard.press('Control+Alt+0');
  const pane = page.locator('[data-pkc-view-pane="diff"]');
  await expect(pane, '差分マージの面が開かない').toBeVisible({ timeout: 15_000 });
  const pickNote = (side: 'left' | 'right'): ReturnType<typeof page.locator> =>
    pane.locator(`[data-pkc-field="diff-side"][data-pkc-side="${side}"] [data-pkc-pick="note"]`);
  await pickNote('left').selectOption(lidA);
  await pickNote('right').selectOption(lidB);
  const summary = pane.locator('[data-pkc-field="diff-summary"]');
  await expect(summary, '左右のちがいが出ない').toHaveText('ちがい 2 か所', { timeout: 10_000 });

  // 左右の欄が並んで見え、塊の中の行は同じ高さで並ぶ
  const hunk = pane.locator('[data-pkc-field="diff-hunk"]').first();
  const cells = hunk.locator('li');
  const [l, r] = await Promise.all([cells.nth(0).boundingBox(), cells.nth(1).boundingBox()]);
  expect(l && r && l.x < r.x && Math.abs(l.y - r.y) < 2, '左右の升が同じ行に並んでいない').toBe(true);

  // 何も取り込んでいないうちは保存を押せない。押せる所に在る → を押す
  const save = pane.locator('[data-pkc-action="diff-save"]');
  await expect(save).toBeDisabled();
  await clickReal(page, hunk.locator('[data-pkc-action="diff-take"][data-pkc-from="b"]'));
  await expect(summary).toHaveText('ちがい 1 か所');
  await expect(save, '取り込んだのに保存が押せない').toBeEnabled();
  // 取り消せる
  await clickReal(page, pane.locator('[data-pkc-action="diff-undo"]'));
  await expect(summary).toHaveText('ちがい 2 か所');
  await clickReal(page, hunk.locator('[data-pkc-action="diff-take"][data-pkc-from="b"]'));

  // 保存 → 本物の保存先が変わる(別の相手に選び直して読み直すと、取り込んだ分のちがいが消えている)
  await clickReal(page, save);
  await expect(summary).toContainText('保存しました', { timeout: 15_000 });
  await pickNote('left').selectOption('');
  await pickNote('left').selectOption(lidA);
  await expect(summary, '保存したのに、読み直すと元のまま').toHaveText('ちがい 1 か所', { timeout: 10_000 });

  /**
   * 🔴 **塊の中の 1 行だけを取り込む**(レビュー ⚠5)。保存の後に残ったちがいは「ぶどう」(改行の有無)と「もも」(右にだけ)の
   * 2 対 ── 最後の対(右にだけある「もも」)を、行ごとのボタンで除く。本物の CSS で、ボタンが升の中で押せる所に在ることも見る。
   */
  const pairs = pane.locator('[data-pkc-action="diff-take-pair"][data-pkc-from="a"]');
  await expect(pairs, '行ごとの取り込みボタンが対の数だけ無い').toHaveCount(2);
  await expect(pairs.last()).toBeVisible();
  await clickReal(page, pairs.last());
  await expect(pairs, '行ごとに取り込んだ対が残っている').toHaveCount(1);
  await clickReal(page, pane.locator('[data-pkc-action="diff-undo"]'));
  await expect(pairs, '取り消しても対が戻らない').toHaveCount(2);

  /**
   * 🔴 **取り込みがあるのに相手を選び直すと、確認が出る**(レビュー ⚠6)。「やめる」で選び所も取り込みも元のまま。
   */
  await clickReal(page, pairs.last());
  await pickNote('right').selectOption('');
  await expect(page.getByText('取り込んだ変更は、まだ保存していません'), '確認が出ない').toBeVisible({ timeout: 10_000 });
  await clickReal(page, page.getByRole('button', { name: 'やめる' }));
  await expect(pairs, 'やめたのに取り込みが消えた').toHaveCount(1);
  await expect(pickNote('right'), 'やめたのに選び所が戻っていない').toHaveValue(lidB);
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 集計と PC: アプリの一覧のタイルから別ウィンドウで開き、本物の面が描かれる (#300)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-browse="launcher"]');

  for (const [tile, view] of [
    ['builtin:query', 'query'],
    ['builtin:pc', 'pc'],
  ] as const) {
    // ⚠ 押した瞬間に別ウィンドウが開く(確認の画面は挟まない)。開いた窓は同じアプリで、画面はアドレスの `view=` で決まる
    const opened = page.context().waitForEvent('page', { timeout: 20_000 });
    // ⚠ 2 回押す(1 回目は印が付くだけ ── #857 段①b)
    await openTile(page, `[data-pkc-action="open-tile"][data-pkc-tile="${tile}"]`);
    const popup = await opened;
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url(), `${tile} の窓が ${view} の画面を指していない`).toContain(`view=${view}`);
    const pane = popup.locator(`[data-pkc-view-pane="${view}"]`);
    await expect(pane, `${view} の画面が別ウィンドウに出ない`).toBeVisible({ timeout: 30_000 });
    if (view === 'pc') {
      // 題と中身(フォルダを選ぶボタン、または使えない理由)が描かれている ── 空の器で終わらない
      await expect(pane.locator('[data-pkc-field="pane-title"]')).toContainText('PC');
      await expect(
        pane.locator('[data-pkc-action="pc-pick-folder"], [data-pkc-field="pc-note"]').first(),
        'PC の中身が描かれていない',
      ).toBeVisible();
    } else {
      await expect(pane, '集計の画面が空').not.toBeEmpty();
    }
    await popup.close();
  }
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 コマンドシェル: 打って Enter で結果が出て、移す・作るが本物の保存先へ届き、↑ で履歴が戻り、左のタブでも同じ履歴で使える (#274)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ショートカットキー(Ctrl+Alt+;)で開く
  await page.keyboard.press('Control+Alt+Semicolon');
  const pane = page.locator('[data-pkc-view-pane="shell"]');
  await expect(pane, 'コマンドシェルの面が開かない').toBeVisible({ timeout: 15_000 });
  const input = pane.locator('[data-pkc-field="shell-input"]');
  const log = pane.locator('[data-pkc-field="shell-log"]');

  await clickReal(page, input);
  await page.keyboard.type('mkdir 資料');
  await page.keyboard.press('Enter');
  await expect(log).toContainText('1 件を実行しました', { timeout: 10_000 });
  await page.keyboard.type('new 買い物メモ 牛乳');
  await page.keyboard.press('Enter');
  await expect(log).toContainText('を作りました', { timeout: 10_000 });
  await page.keyboard.type('find 買い物');
  await page.keyboard.press('Enter');
  await expect(log, '題名で探した結果の表に出ない').toContainText('買い物メモ');
  await page.keyboard.type('mv #1 資料');
  await page.keyboard.press('Enter');
  await expect(log).toContainText('移しました', { timeout: 10_000 });
  await page.keyboard.type('ls 資料');
  await page.keyboard.press('Enter');
  const rows = log.locator('[data-pkc-field="shell-block"]').last().locator('tbody tr');
  await expect(rows, '移したノートが資料の中に居ない').toHaveCount(1);

  // 新しく作る
  await page.keyboard.type('new 資料/シェルから作った 本文です');
  await page.keyboard.press('Enter');
  await expect(log.locator('[data-pkc-field="shell-block"]').last()).toContainText('を作りました', { timeout: 10_000 });

  // 🔴 ↑ で履歴が戻る(本文は履歴に残さないので、題名までが戻る)・Tab で補完される
  await page.keyboard.press('ArrowUp');
  await expect(input).toHaveValue('new 資料/シェルから作った');
  await page.keyboard.press('ArrowDown');
  await expect(input).toHaveValue('');
  await page.keyboard.type('mk');
  await page.keyboard.press('Tab');
  await expect(input).toHaveValue('mkdir ');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // 🔴 マウスだけでも: 履歴ボタン → 行を押すと入力欄に入る
  await clickReal(page, pane.locator('[data-pkc-action="shell-history-menu"]'));
  await clickReal(page, pane.locator('[data-pkc-region="shell-complete"] [data-pkc-action="shell-recall"]').first());
  await expect(input).toHaveValue('new 資料/シェルから作った');

  // 履歴は端末に保存されている
  expect(await page.evaluate(() => localStorage.getItem('pkc3.shell-history'))).toContain('mkdir 資料');

  // 左のペインの「シェル」タブ(別ウィンドウが塞がれたときの退避先)で、同じ履歴を使える
  await openBrowseTab(page, 'shell');
  const tab = page.locator('[data-pkc-browse-pane="shell"]');
  await expect(tab, '左のシェルのタブが開かない').toBeVisible();
  const tabInput = tab.locator('[data-pkc-field="shell-input"]');
  await clickReal(page, tabInput);
  await page.keyboard.press('ArrowUp');
  await expect(tabInput, '左のタブで履歴が戻らない').not.toHaveValue('');
  await page.keyboard.press('Escape');
  await page.keyboard.type('cd 資料');
  await page.keyboard.press('Enter');
  // 🔴 cd すると「現在地:」の行も変わる(state が動かなくても塗り直す)
  await expect(tab.locator('[data-pkc-field="shell-cwd"]')).toHaveText('現在地: /資料');
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(tab.locator('[data-pkc-field="shell-block"]').last()).toContainText('/資料');

  // 🔴 F: 履歴の一覧を開いて Esc を押すと、一覧だけが閉じる(開いているノートは閉じず、選択も変わらない)
  await page.keyboard.type('ls');
  await page.keyboard.press('Enter');
  await clickReal(page, tab.locator('[data-pkc-field="shell-block"]').last().locator('tbody tr[data-pkc-entry]').first());
  const selected = page.locator('[data-pkc-region="filer-table"] [data-pkc-selected]');
  await expect(selected, '表の行を押してもノートが選ばれない').toHaveCount(1);
  const selectedLid = await selected.first().getAttribute('data-pkc-entry');
  await clickReal(page, tab.locator('[data-pkc-action="shell-history-menu"]'));
  const menu = tab.locator('[data-pkc-region="shell-complete"]');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu, 'Esc で履歴の一覧が閉じない').toBeHidden();
  await expect(tabInput, '閉じたあと入力欄にフォーカスが戻らない').toBeFocused();
  await expect(selected, 'Esc でノートの選択が変わった').toHaveCount(1);
  expect(await selected.first().getAttribute('data-pkc-entry')).toBe(selectedLid);
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 2 ペインのコマンドライン: コマンドを打つと結果がコマンドラインの上に出て、同じコマンド表の help が読める (#241)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'folder');
  await createEntry(page, 'text');
  await page.keyboard.press('Control+Alt+6');
  const dual = page.locator('[data-pkc-view-pane="dual"]');
  await expect(dual).toBeVisible({ timeout: 15_000 });
  const cmd = dual.locator('[data-pkc-region="dual-cmdline"]');
  await expect(cmd, '2 ペインにコマンドラインが無い').toBeVisible();
  const input = cmd.locator('[data-pkc-field="shell-input"]');
  const out = cmd.locator('[data-pkc-region="dual-cmd-out"]');

  await clickReal(page, input);
  await page.keyboard.type('ls');
  await page.keyboard.press('Enter');
  await expect(out, '結果がコマンドラインの上に出ない').toContainText('件');
  await page.keyboard.type('help');
  await page.keyboard.press('Enter');
  await expect(out).toContainText('コマンドは英語でも日本語でも打てます');
  await page.keyboard.type('sql SELECT 1');
  await page.keyboard.press('Enter');
  await expect(out, '2 ペインでは sql は使えない').toContainText('コマンドはありません');
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
