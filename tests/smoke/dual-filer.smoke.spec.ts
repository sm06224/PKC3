import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 2 ペインタブファイラ(#241 段⑥-a)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **実マウスの 2 クリック** ── 合成 `click` を 2 回撃つのと、実機で 2 回押すのは別
 * 2. **面が本当に見えているか** ── `hidden` の付け替えと CSS の噛み合いは
 *    happy-dom では読めない(`toBeVisible` は実レイアウトを見る)
 * 3. **左右が本当に横に並んでいるか** ── `grid-template-columns: 1fr auto 1fr` が
 *    効いていなければ、片方が画面の外へ落ちる(unit は幅を持たない)
 */

const PANE = (side: string): string =>
  `[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`;
const ROWS = (side: string): string => `${PANE(side)} [data-pkc-region="dual-table"] tbody tr`;

/**
 * 🔴 **本物の導線で開く**(user 指摘 2026-08-19「2 ペインファイラは**アプリとして**
 * Office のように組み込みの導線を用意しろ」)。
 * ⚠ 1 稿目は左の列の帯のボタンを押していたが、**そのボタンはもう無い** ──
 *   ここを直さないと、導線を消した瞬間に smoke ごと嘘になる。
 * ⚠ タイルは**アプリのタブを開かないと描かれない**(左の列は探し方で切り替わる)。
 */
async function openDual(page: Page): Promise<void> {
  await clickReal(page, '[data-pkc-browse="launcher"]');
  await clickReal(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:dual"]');
}

async function makeFolder(page: Page, title: string): Promise<void> {
  await createEntry(page, 'folder');
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('🔴 2 ペインを開いて、左で選んだものを右の場所へ移す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 面を開く(左の列のボタン)
  await openDual(page);
  await expect(page.locator('[data-pkc-view-pane="dual"]')).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]'), '本文の面が出たまま').toBeHidden();

  /**
   * ② 🔴 **左右が横に並んでいる**(縦積みや、片方が画面外に落ちていない)。
   * ⚠ 「要素が在る」だけでは足りない ── **座標**で見る(CSS が効いていなければ
   *   `x` が同じになる / 片方の幅が 0 になる)。
   */
  const left = await page.locator(PANE('left')).boundingBox();
  const right = await page.locator(PANE('right')).boundingBox();
  expect(left, '左のペインが描かれていない').not.toBeNull();
  expect(right, '右のペインが描かれていない').not.toBeNull();
  expect(right!.x, '左右が横に並んでいない').toBeGreaterThan(left!.x + left!.width - 1);
  expect(Math.abs(left!.width - right!.width), '左右の幅が違う(元と先が対等に見えない)')
    .toBeLessThan(2);

  await expect(page.locator(ROWS('left'))).toHaveCount(2);
  await expect(page.locator(ROWS('right'))).toHaveCount(2);

  // ③ 🔴 実マウスの 2 クリックで、**右だけ**がフォルダの中へ入る
  await page.locator(ROWS('right')).first().dblclick();
  /**
   * ⚠ **パンくずだけを見る**(着地前レビュー R7)。ペイン全体で探すと、
   * ルートに居るときは**表の行そのものが「はこ」**なので、ダブルクリックが
   * 1 ミリも効かなくても真になる(CLAUDE.md §1「面へスコープする」)。
   */
  await expect(page.locator(`${PANE('right')} [data-pkc-region="dual-crumbs"]`)).toContainText(
    'はこ',
  );
  await expect(page.locator(ROWS('right')), '右がフォルダに入れていない').toHaveCount(0);
  await expect(page.locator(ROWS('left')), '押していない左まで動いた').toHaveCount(2);

  /**
   * ④ 左のノートを選ぶ ── 焦点が左へ移り、**そちらが「元」だと情報行が言う**。
   * ⚠ 2026-08-19 の作り直しで、向きは**操作の文言から情報行へ移った**
   *   (操作行は `F6 移す` で固定 ── 焦点で字が入れ替わると端が揃わない)。
   */
  await page.locator(ROWS('left')).nth(1).click();
  await expect(page.locator(PANE('left'))).toHaveAttribute('data-pkc-focused', '');
  await expect(
    page.locator(`${PANE('left')} [data-pkc-field="dual-count"]`),
    '焦点の側が「元」だと出ていない',
  ).toContainText('(ここが元)');
  await expect(page.locator('[data-pkc-field="dual-move"]')).toContainText('移す');

  // ⑤ 移す ── 右(= はこの中)に現れ、左からは消える
  await clickReal(page, '[data-pkc-field="dual-move"]');
  await expect(page.locator(ROWS('right')), '右へ移っていない').toHaveCount(1);
  await expect(page.locator(ROWS('left')), '左から消えていない').toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 何も選ばずに押したら、理由が画面に出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await openDual(page);

  await clickReal(page, '[data-pkc-field="dual-move"]');
  /**
   * ⚠ **観測点は状態の行だけ**(CLAUDE.md §1 の 7 度目)── root 全体の
   * `textContent` で探すと、お知らせのカードや本文に満たされて常に真になる。
   */
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('移すものを選んでください');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 タブを足して、別の場所を 1 つのペインに持てる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await openDual(page);

  const tabs = page.locator(`${PANE('left')} [data-pkc-region="dual-tab"]`);
  await expect(tabs).toHaveCount(1);
  // ⚠ 最後の 1 枚には閉じる口を出さない(押しても何も起きないボタンを作らない)
  await expect(page.locator(`${PANE('left')} [data-pkc-action="dual-tab-close"]`)).toHaveCount(0);

  await clickReal(page, `[data-pkc-action="dual-tab-add"][data-pkc-side="left"]`);
  await expect(tabs).toHaveCount(2);
  await page.locator(ROWS('left')).first().dblclick();
  await expect(tabs.nth(1), '2 枚目のタブが行き先を名乗っていない').toContainText('はこ');
  await expect(tabs.nth(0), '足す前のタブまで動いた').toContainText('ルート');

  // 1 枚目へ戻ると、ルートの中身が出る
  await tabs.nth(0).locator('[data-pkc-action="dual-tab-activate"]').click();
  await expect(page.locator(ROWS('left'))).toHaveCount(1);

  await page.locator(`${PANE('left')} [data-pkc-action="dual-tab-close"]`).first().click();
  await expect(tabs).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **キーボードだけで動かせる**(#273。user 指摘 2026-08-19
 * 「OS のファイラと同じことができないといけません / 往年の FD などを見習って」)。
 *
 * ⚠ unit は合成 event と happy-dom の `activeElement` を見ている ── 実機で
 * **本当に焦点が乗り、本当のキーが届くか**はここでしか分からない
 * (焦点の移動は実ブラウザと happy-dom で最も食い違う所である)。
 */
test('🔴 2 ペインをキーボードだけで動かす (#273)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await openDual(page);

  // ① 行を押して焦点を作る(ここから先は**キーだけ**)
  await page.locator(ROWS('left')).first().click();
  await expect(page.locator(PANE('left'))).toHaveAttribute('data-pkc-focused', '');

  // ② ↓ で送れる ── 印が動いた行に付く
  await page.keyboard.press('ArrowDown');
  await expect(
    page.locator(`${PANE('left')} [data-pkc-entry][data-pkc-marked]`),
    '↓ で印が動いていない',
  ).toHaveCount(1);

  // ③ Tab で反対のペインへ(FD の基本操作)
  await page.keyboard.press('Tab');
  await expect(page.locator(PANE('right')), 'Tab で反対側へ移っていない').toHaveAttribute(
    'data-pkc-focused',
    '',
  );

  // ④ Enter でフォルダの中へ ── 押した側だけが入る
  await page.keyboard.press('Enter');
  await expect(page.locator(`${PANE('right')} [data-pkc-region="dual-crumbs"]`)).toContainText(
    'はこ',
  );
  await expect(page.locator(ROWS('left')), '押していない側まで入った').toHaveCount(2);

  // ⑤ Backspace で戻れる
  await page.keyboard.press('Backspace');
  await expect(page.locator(ROWS('right')), 'Backspace で親へ戻れない').toHaveCount(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **その場で名前を打ち替える**(#273 段④)。
 * ⚠ 焦点と `select()`、そして「打っている最中に面の鍵へ化けない」ことは
 * 実ブラウザでしか確かめられない(合成 event では焦点の意味論が違う)。
 */
test('🔴 F2 で名前を打ち替えられる (#273)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await openDual(page);

  await page.locator(ROWS('left')).first().click();
  await page.keyboard.press('F2');
  const input = page.locator(`${PANE('left')} [data-pkc-field="dual-rename"]`);
  await expect(input, 'F2 で入力欄が出ていない').toBeVisible();
  // ⚠ 出た時点で**打てる**(全選択されている)── 打ち直すだけで置き換わる
  await page.keyboard.type('あたらしい名前');
  await page.keyboard.press('Enter');
  await expect(input, '確定したのに入力欄が残っている').toHaveCount(0);
  await expect(page.locator(ROWS('left')).first()).toContainText('あたらしい名前');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **面を一巡して、押しても何も起きない口が無いことを見る**(#273)。
 *
 * user 指示 2026-08-14「**自前の headless で拾える不具合を cowork に拾わせたら、
 * それはこちらのテスト不足**」── 実機へ渡す前に、**この面の押せる口を全部押す**。
 * ⚠ 観測点は「何かが起きたか」= **状態の行に何か出るか / 画面が変わるか** ──
 *   dead click は「押しても状態の行が空のまま、画面も同じ」で現れる。
 */
test('🔴 2 ペインの押せる口に、無反応が 1 つも無い (#273)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await openDual(page);

  /** 何も選ばずに押す ── **全部が理由を出す**(無言で終わらない)。 */
  for (const field of ['dual-move', 'dual-copy', 'dual-rename-begin', 'dual-delete']) {
    await page.locator('[data-pkc-region="status"]').evaluate((el) => (el.textContent = ''));
    await clickReal(page, `[data-pkc-field="${field}"]`);
    await expect(
      page.locator('[data-pkc-region="status"]'),
      `${field}: 何も選ばずに押したのに無言(dead click)`,
    ).not.toHaveText('');
  }

  /** 選んだ状態で、壊さない口(名前を変える)が本当に開く。 */
  await page.locator(ROWS('left')).first().click();
  await clickReal(page, '[data-pkc-field="dual-rename-begin"]');
  await expect(
    page.locator(`${PANE('left')} [data-pkc-field="dual-rename"]`),
    '選んでいるのに入力欄が出ない',
  ).toBeVisible();
  await page.keyboard.press('Escape');

  /** 新しいフォルダ ── 押したら**行が増える**(押しても何も起きない、にしない)。 */
  const before = await page.locator(ROWS('left')).count();
  await clickReal(page, '[data-pkc-field="dual-mkdir"]');
  await expect(page.locator(ROWS('left')), 'フォルダが増えていない').toHaveCount(before + 1);

  /**
   * 写す ── 反対側が空のルートなので、押したら右の件数が増える。
   * ⚠ **さっき押したのと別の行**を押す ── 同じ座標を短い間に 2 回押すと、
   *   ブラウザが**ダブルクリック**と数えてフォルダの中へ入ってしまう
   *   (この test を書いたとき実際に踏んだ。製品ではなく叩き方の問題)。
   */
  await page.locator(ROWS('left')).last().click();
  // ⚠ 空振り防止 ── 押した行が本当に印になっているか(なっていなければ以降は無意味)
  await expect(
    page.locator(`${PANE('left')} [data-pkc-entry][data-pkc-marked]`),
    '行を押したのに印が付いていない',
  ).toHaveCount(1);
  await clickReal(page, '[data-pkc-field="dual-copy"]');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('写しました');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **左右のあいだで掴んで落とす**(#273 段⑤)。
 *
 * 🔴 **unit では原理的に届かない層**をここで見る:
 * ① **実 HTML5 D&D** ── `DataTransfer` は happy-dom に無いので、unit が見ているのは
 *    「stub を渡したときの分岐」であって、**ブラウザが本当に drag を始めるか**ではない
 *    (`draggable` 属性の綴り違い・CSS の `user-select` による掴み損ねは unit を素通りする)
 * ② **ペインの地に本当に面積が在るか** ── 落とし先として使うのは行の無い所なので、
 *    高さが 0 だと**狙えない**(unit は幅も高さも持たない)
 */
test('🔴 左のペインから掴んで、右のペインへ落とす (#273 段⑤)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await openDual(page);

  await expect(page.locator(ROWS('left'))).toHaveCount(2);
  await expect(page.locator(ROWS('right'))).toHaveCount(2);

  // ① 右だけを「はこ」の中へ入れる(左右が別の場所を見ている状態を作る)
  await page.locator(ROWS('right')).first().dblclick();
  await expect(page.locator(`${PANE('right')} [data-pkc-region="dual-crumbs"]`)).toContainText(
    'はこ',
  );
  await expect(page.locator(ROWS('right')), '右が空のフォルダに入れていない').toHaveCount(0);

  /**
   * ② 🔴 **左の平のノートを掴んで、右のペインの地へ落とす。**
   * ⚠ 落とし先はペインそのもの(行が 0 件なので、狙えるのは地しかない)──
   *   ここに面積が無ければ Playwright は落とす座標を作れず、この test は落ちる。
   */
  const note = `${ROWS('left')}[data-pkc-archetype="text"]`;
  await page.dragAndDrop(note, PANE('right'));

  /**
   * ⚠ **アプリ自身の信号を先に待つ**(#240 の smoke と同じ理由)── 行数を先に
   *   見ると、合成 D&D の掴み損ねを「移動が壊れた」と読み違える。
   */
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '掴んで落とせていない(または行き先を名乗っていない)',
  ).toContainText('「はこ」へ入れました');
  await expect(page.locator(ROWS('right')), '右(はこ の中)へ入っていない').toHaveCount(1);
  await expect(page.locator(ROWS('left')), '左から消えていない').toHaveCount(1);

  /**
   * ③ 🔴 **逆向きも通る** ── 右から掴んで、ルートを見ている左のペインへ落とす。
   * ⚠ 片方向だけ確かめて「D&D が効く」と書かない(§7「対称の反対側を疑う」)。
   */
  await page.dragAndDrop(`${ROWS('right')}[data-pkc-archetype="text"]`, PANE('left'));
  await expect(page.locator(ROWS('left')), '左(ルート)へ戻せていない').toHaveCount(2);
  await expect(page.locator(ROWS('right')), '右から出ていない').toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
