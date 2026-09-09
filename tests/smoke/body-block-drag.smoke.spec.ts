/**
 * 🔴 **本文の塊を掴んで並べ替える**(#684 段①)を、実ブラウザで見る。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 実マウスで ⠿ を掴み、別の塊の下へ落とすと**本文が書き替わって刻印の並びが変わる** | 本物の HTML5 D&D(`DataTransfer` / dragover の座標 / 保存の往復)は happy-dom に無い |
 * | 🔴 **字の選択が生きている** ── 段落の字をドラッグすると選べる(塊が動き出さない) | 選択は layout と本物の D&D の判定で決まる |
 *
 * 🔑 観測点は **`data-pkc-source-line` の並び**(本文から描き直された刻印)── DOM の順だけ
 *   見ると「見た目は動いたが本文に書けていない」を素通りする(`place-board.smoke` と同じ型)。
 */
import { test, expect } from '@playwright/test';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  useSplitEditor,
  useListBrowse,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = ['# 題', '', '段落 A', '', '## 章 B', '', '本文 B', '', '## 章 C', '', '本文 C', ''].join(
  '\n',
);

const HOST = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';

/** 本文の直下の塊の字(刻印順)。 */
async function order(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator(`${HOST} > [data-pkc-source-line]`).evaluateAll((els) =>
    els.map((e) => (e.textContent ?? '').trim()),
  );
}

test('🔴 ⠿ を掴んで別の塊の下へ落とすと、本文の並びが書き替わる (#684 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '並べ替えるノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${HOST}[data-pkc-painted]`)).toBeAttached();
  expect(await order(page), '前提: 描いた並び').toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);

  // 段落 A に乗せると ⠿ が横に出る
  const para = page.locator(`${HOST} > p`).first();
  await para.hover();
  const grip = page.locator('[data-pkc-field="block-grip"]');
  await expect(grip, '乗せても口が出ない').toBeVisible();
  await expect(grip).toHaveAttribute('data-pkc-block-start', '2');

  // 🔴 実マウスで掴み、「本文 C」の下半分へ落とす
  const g = (await grip.boundingBox())!;
  const target = page.locator(`${HOST} > p`).last();
  const t = (await target.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 40, g.y + 40, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.8, { steps: 8 });
  // ⚠ 線が出ている = dragover が受けている(落とす前に見る ── 落とした後は印が消える)
  await expect(target, '落とし先に「後」の線が出ない').toHaveAttribute('data-pkc-drop-edge', 'after');
  await page.mouse.up();

  /**
   * 🔴 観測点は**本文から描き直された刻印の並び** ── 保存 → 再読込 → 再描画の往復が
   * 通って初めてこの並びになる。
   */
  await expect
    .poll(() => order(page), { timeout: 5000, message: '本文の並びが書き替わっていない' })
    .toEqual(['題', '章 B', '本文 B', '章 C', '本文 C', '段落 A']);
  // 知らせの隣に「元に戻す」が出る(片道の操作にしない)
  await expect(page.locator('[data-pkc-field="status-undo"]')).toBeVisible();
  await clickReal(page, '[data-pkc-field="status-undo"]');
  await expect
    .poll(() => order(page), { timeout: 5000, message: '元に戻らない' })
    .toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);

  expect(errors, 'pageerror が出た').toEqual([]);
});

test('🔴 段落の字はドラッグで選べる(塊そのものは掴めない)(#684 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '選ぶノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const para = page.locator(`${HOST} > p`).first();
  const r = (await para.boundingBox())!;
  // 字の上を左から右へドラッグ
  await page.mouse.move(r.x + 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height / 2, { steps: 6 });
  await page.mouse.up();
  const selected = await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim());
  expect(selected, '字をドラッグしても選べない(塊が draggable になっている)').not.toBe('');
  expect('段落 A'.includes(selected) || selected.includes('段落'), `選ばれた字が段落の字でない: ${selected}`).toBe(
    true,
  );
  // 対照群 ── 塊は動いていない
  expect(await order(page)).toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);
  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **一覧の行を本文へ落とすとリンクになる**(#684 段②)。
 * ⚠ unit は合成 event で `insert-lines` が飛ぶ所まで ── 本物の D&D で一覧の行(`draggable`)が
 *   本文の面まで運ばれ、保存 → 再描画で **押せるリンク**として出ることは実ブラウザでしか見えない。
 */
test('🔴 一覧の行を本文へ落とすと、そのノートへのリンクが本文に入る (#684 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  // 相手のノートを先に作り、次に落とし先のノートを作って開いたままにする
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '相手のノート');
  await page.fill('[data-pkc-field="editor-body"]', '中身\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '受け取るノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${HOST}[data-pkc-painted]`)).toBeAttached();

  // 左の一覧(フォルダ面)の「相手のノート」の行を掴む
  const row = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]', { hasText: '相手のノート' }).first();
  await expect(row, '掴む行が無い(前提が崩れた)').toBeVisible();
  const from = (await row.boundingBox())!;
  const target = page.locator(`${HOST} > p`).first(); // 段落 A
  const t = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 30, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.8, { steps: 8 });
  await expect(target, '本文の上で「後」の線が出ない').toHaveAttribute('data-pkc-drop-edge', 'after');
  await page.mouse.up();

  // 🔴 観測点: 本文から描き直された**押せるリンク**(段落 A の直後に入る)
  const link = page.locator(`${HOST} a`, { hasText: '相手のノート' });
  await expect(link, 'リンクが本文に入っていない').toBeVisible({ timeout: 5000 });
  await expect
    .poll(() => order(page), { timeout: 5000 })
    .toEqual(['題', '段落 A', '相手のノート', '章 B', '本文 B', '章 C', '本文 C']);
  // 対照群 ── 掴んだ行は一覧から消えていない(移していない)
  await expect(row).toBeVisible();
  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **パソコンの中のファイルを、落とした所へ入れる**(#684 段④)。
 *
 * ⚠ unit は合成 event で「落とした所が `attachFiles` へ渡る」までしか見ない ──
 *   本物の `DataTransfer`(`Files`)を実レイアウトの座標で受け、bytes を IDB へ置き、
 *   本文を書き替えて**絵として描き直す**所は実ブラウザにしか無い。
 * 🔑 観測点は**刻印の並び**(本文から描き直した順)+ 画面の下の 1 行。
 */
test('🔴 ファイルを本文の塊の上へ落とすと、その所に添付が入る (#684 段④)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '受け取るノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${HOST}[data-pkc-painted]`)).toBeAttached();

  const target = page.locator(`${HOST} > p`).first(); // 段落 A
  const t = (await target.boundingBox())!;
  const at = { x: t.x + t.width / 2, y: t.y + t.height * 0.8 }; // 下半分 = 後

  /**
   * ⚠ **本物の OS ドラッグは Playwright から起こせない** ── `DataTransfer` を箱の中で
   *   組み、実レイアウトの座標で `dragover` / `drop` を撃つ(受け側の座標計算・CSS の線・
   *   取込の往復は本物である)。⚠ **1 回目と 2 回目で同じ荷物**を使う(別の荷物にすると、
   *   dragover が受けた物と drop で来た物が食い違う)。
   */
  await page.evaluate((p) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], '猫.png', { type: 'image/png' }));
    (window as unknown as { __dropDt: DataTransfer }).__dropDt = dt;
    const el = document.elementFromPoint(p.x, p.y)!;
    el.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, dataTransfer: dt }),
    );
  }, at);
  // ⚠ 線は**落とす前**に見る(落とした後は消える)── 「落とせる」印が出ているか
  await expect(target, '本文の上で「後」の線が出ない').toHaveAttribute('data-pkc-drop-edge', 'after');

  await page.evaluate((p) => {
    const dt = (window as unknown as { __dropDt: DataTransfer }).__dropDt;
    const el = document.elementFromPoint(p.x, p.y)!;
    el.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, dataTransfer: dt }),
    );
  }, at);

  /**
   * 🔴 観測点は**描き直した刻印の並び** ── 絵の塊は字を持たないので `IMG` と読む。
   * ⚠ 「末尾に入った」なら最後に来る ── そこが**直す前の姿**である。
   */
  const kinds = async (): Promise<string[]> =>
    page.locator(`${HOST} > [data-pkc-source-line]`).evaluateAll((els) =>
      els.map((e) => (e.querySelector('img') ? 'IMG' : (e.textContent ?? '').trim())),
    );
  await expect
    .poll(kinds, { timeout: 8000, message: '落とした所に入っていない(末尾に入っていないか)' })
    .toEqual(['題', '段落 A', 'IMG', '章 B', '本文 B', '章 C', '本文 C']);
  // どこに入ったかを字でも言う(画面は動かないので、字が唯一の手がかり)
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('落とした所に入れました');
  // 🔴 片道にしない ── 追記欄の「元に戻す」1 回で消える
  const undo = page.locator('[data-pkc-action="undo-append"]');
  await expect(undo, '「元に戻す」が出ない').toBeVisible();
  await clickReal(page, '[data-pkc-action="undo-append"]');
  await expect
    .poll(kinds, { timeout: 8000, message: '元に戻らない' })
    .toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **塊を別のノートへ持っていく**(#684 段③)。
 *
 * ⚠ unit は「正しい座標で `HANDOFF_BLOCK` が飛ぶ」までと「入れてから切る」まで ──
 *   **実マウスで一覧の行まで運べること**と、**2 つのノートの本文が保存されて描き直る**
 *   往復は実ブラウザにしか無い。
 * 🔑 観測点は**両側**(元から消え、行き先に出る)── 片側だけ見ると、
 *   「入ったが元にも残っている」(二重)を素通りする。
 */
test('🔴 ⠿ を一覧の行へ落とすと、その塊が別のノートへ移る (#684 段③)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  // 行き先を先に作る
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '行き先のノート');
  await page.fill('[data-pkc-field="editor-body"]', '受け皿\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  // 掴む側
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '持っていくノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${HOST}[data-pkc-painted]`)).toBeAttached();
  expect(await order(page), '前提: 描いた並び').toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);

  // 段落 A に乗せて ⠿ を出し、実マウスで「行き先のノート」の行まで運ぶ
  await page.locator(`${HOST} > p`).first().hover();
  const grip = page.locator('[data-pkc-field="block-grip"]');
  await expect(grip, '乗せても口が出ない').toBeVisible();
  const g = (await grip.boundingBox())!;
  const row = page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]', { hasText: '行き先のノート' })
    .first();
  await expect(row, '行き先の行が無い(前提が崩れた)').toBeVisible();
  const r = (await row.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 40, g.y + 40, { steps: 4 });
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 8 });
  // ⚠ 落とす前に「落とせる」印が出ている(落とした後は消える)
  await expect(row, '一覧の行に落とせる印が出ない').toHaveAttribute('data-pkc-dropping', '');
  /**
   * 🔴 **画面が本当に変わっているか**(2026-09-09 の UX レビュー)。
   * ⚠ 属性が付くことは unit も見ているが、**CSS が当たっているか**はここでしか分からない ──
   *   1 稿目は `[data-pkc-drop][data-pkc-dropping]` の規則しか無く、`data-pkc-drop` は
   *   **フォルダの行にしか付かない**ので、普通のノートの行は**1px も変わらなかった**。
   */
  const outline = await row.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline, '落とせる行が光っていない(印は付いているのに画面が変わらない)').toBe('dashed');
  await page.mouse.up();

  // 🔴 元から消える
  await expect
    .poll(() => order(page), { timeout: 8000, message: '元の本文から消えていない' })
    .toEqual(['題', '章 B', '本文 B', '章 C', '本文 C']);
  // どこへ行ったかを言う
  await expect(page.locator('[data-pkc-region="status"]')).toContainText(
    // ⚠ #809-3 でノートの名前を『』へ揃えた(file を落とした回の知らせと同じ括弧)
    '本文の塊を『行き先のノート』のいちばん下へ持っていきました',
  );
  // ⚠ 帰り道を同じ 1 行で言う(事故の瞬間に読むのはここだけ)
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('持ち帰って');
  // 🔴 行き先に出る(「開く」で行ける ── 帰り道もここから)
  await clickReal(page, '[data-pkc-field="status-open"]');
  await expect
    .poll(() => order(page), { timeout: 8000, message: '行き先に入っていない' })
    .toEqual(['受け皿', '段落 A']);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **横に留めた枠の本文へ落としたファイルは、その枠のノートへ入る**(#684 ㋑)。
 *
 * ⚠ 直す前は入れ先が「いま開いているノート」**固定**だったので、留めた枠へ落としても
 *   そこには 1 バイトも入らず、**主の枠のノートのいちばん下**へ落ちていた ──
 *   同じ枠へ**塊**(段③)や**一覧の行**(段②)を落とすとその枠のノートへ書くので、
 *   file だけ行き先が違った。
 *
 * 🔑 ここでしか見られないもの:**本当に 2 枠並んでいる**状態で、留めた枠の座標に
 *   線が出て、**その枠の本文だけ**が描き直され、**主の枠は 1 文字も動かない**こと。
 *   (unit は合成 event なので、枠が本当に並んでいるかも、どちらが描き直されるかも見ない)
 */
test('🔴 横に留めた枠へファイルを落とすと、その枠のノートへ入る (#684 ㋑)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await useListBrowse(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);

  const write = async (title: string, body: string): Promise<void> => {
    await createEntry(page, 'text');
    await page.fill('[data-pkc-field="editor-title"]', title);
    await page.fill('[data-pkc-field="editor-body"]', body);
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    await expect(page.locator(`${HOST}[data-pkc-painted]`)).toBeAttached();
  };
  await write('主のノート', '# 主のノート\n\n卵\n');
  await write('留める側', '# 留める側\n\n牛乳\n\nパン\n');

  // 「留める側」を横に留める(実物のメニューを実物のマウスで)
  await page.locator(`${HOST} p`).first().click({ button: 'right' });
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu, '本文で右クリックしてもメニューが出ない').toBeVisible();
  await menu.locator('button[data-pkc-action="pin-split"]').click();
  await expect(page.locator('[data-pkc-split-lid]'), '横に留まっていない').toHaveCount(1);

  // 主の枠は別のノートへ ── ここで「見ているノート ≠ 留めた枠のノート」が成立する
  await page
    .locator('[data-pkc-region="entry-list"] [data-pkc-entry]')
    .filter({ hasText: '主のノート' })
    .first()
    .click();
  const SIDE = '[data-pkc-split-lid] [data-pkc-field="split-body"]';
  await expect(page.locator(`${HOST} h1`).first(), '前提: 主の枠が別のノートでない').toContainText(
    '主のノート',
  );
  await expect(page.locator(`${SIDE} h1`).first(), '前提: 留めた枠が入れ替わった').toContainText(
    '留める側',
  );

  const kinds = async (sel: string): Promise<string[]> =>
    page.locator(`${sel} > [data-pkc-source-line]`).evaluateAll((els) =>
      els.map((e) => (e.querySelector('img') ? 'IMG' : (e.textContent ?? '').trim())),
    );
  expect(await kinds(SIDE), '前提: 留めた枠の並び').toEqual(['留める側', '牛乳', 'パン']);

  // 🔴 留めた枠の「牛乳」の下半分へ落とす
  const target = page.locator(`${SIDE} > p`).first();
  const t = (await target.boundingBox())!;
  const at = { x: t.x + t.width / 2, y: t.y + t.height * 0.8 };
  await page.evaluate((p) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([9, 8, 7, 6])], '猫.png', { type: 'image/png' }));
    (window as unknown as { __dropDt: DataTransfer }).__dropDt = dt;
    const el = document.elementFromPoint(p.x, p.y)!;
    el.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, dataTransfer: dt }),
    );
  }, at);
  await expect(target, '留めた枠の本文に「後」の線が出ない').toHaveAttribute(
    'data-pkc-drop-edge',
    'after',
  );
  await page.evaluate((p) => {
    const dt = (window as unknown as { __dropDt: DataTransfer }).__dropDt;
    const el = document.elementFromPoint(p.x, p.y)!;
    el.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, dataTransfer: dt }),
    );
  }, at);

  await expect
    .poll(() => kinds(SIDE), { timeout: 8000, message: '留めた枠のノートの落とした所に入っていない' })
    .toEqual(['留める側', '牛乳', 'IMG', 'パン']);
  // 🔴 主の枠は 1 文字も動かない(見ていた本文を奪わない)
  expect(await kinds(HOST), '見ていたノートの本文が動いた').toEqual(['主のノート', '卵']);
  // 行き先の名前を言う ── 見ている本文と違う所へ入るので、名前が唯一の手がかり
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('『留める側』');
  /**
   * 🔴 **戻す道を、画面を動かさずに残す**(「片道の操作を作らない」)。
   *
   * ⚠ 追記欄の「元に戻す」は**開いているノートの欄にしか出ない**ので、留めた枠へ
   *   入れた 1 行はそこからは戻せない。⚠ 「開く」で行き先を開いてから戻すと、
   *   **戻すために読んでいた本文を明け渡す**ことになる(#300 と同じ形)。
   * 🔑 だから知らせの隣の「元に戻す」で、**画面を動かさずに**その行だけ消す。
   */
  const open = page.locator('[data-pkc-field="status-open"]');
  await expect(open, '行き先へ行く「開く」が出ない').toBeVisible();
  const undo = page.locator('[data-pkc-field="status-undo"]');
  await expect(undo, '知らせの隣に「元に戻す」が出ない(戻す道が無い)').toBeVisible();
  await expect(undo, '押すと別の物が戻る').toHaveAttribute('data-pkc-action', 'undo-append');
  await clickReal(page, '[data-pkc-field="status-undo"]');
  await expect
    .poll(() => kinds(SIDE), { timeout: 8000, message: '「元に戻す」で行が消えない' })
    .toEqual(['留める側', '牛乳', 'パン']);
  // 🔴 戻した後も、見ていた本文は中央のまま(戻すために画面を明け渡していない)
  await expect(page.locator(`${HOST} h1`).first(), '戻したら中央が入れ替わった').toContainText(
    '主のノート',
  );

  expect(errors, 'pageerror が出た').toEqual([]);
});
