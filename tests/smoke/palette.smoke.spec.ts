import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

/**
 * 🔴 **「操作を探す」から「マニュアルを別のウィンドウで開く」**(#1452 案 1)。
 * ⚠ ヘルプの面は開くまで組まれないので、ボタンを撃つ形は「ヘルプを 1 度開いた後」しか押せない。
 *   ここは**ヘルプを開かずに**、パレットの Enter(dialog が閉じた後の microtask)で `window.open` を撃つ。
 *   transient activation の内側かどうかは、実ブラウザでしか分からない。
 * 返すのは開いた窓(`manual.html` に着き、帯の題名が出るまで待つ)。
 */
async function openManualFromPalette(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
) {
  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, 'マニュアルの窓を探すためにパレットが開かない').toBeVisible();
  await page.locator('[data-pkc-field="palette-filter"]').fill('マニュアル');
  const row = page.locator('[data-pkc-field="palette-row"][data-pkc-command="open-manual-window"]');
  await expect(row, '「マニュアルを別のウィンドウで開く」が探せない').toBeVisible();
  await expect(row, '押せないことになっている(編集中でも押せるはず)').toBeEnabled();
  // ⚠ 行が先頭でなければ Enter が別の操作を撃つ ── 先頭であることまで見る
  await expect(
    page.locator('[data-pkc-field="palette-row"]').first(),
    '「マニュアル」と打っても先頭が別の操作(Enter が別の物を撃つ)',
  ).toHaveAttribute('data-pkc-command', 'open-manual-window');
  const popup = context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const win = await popup;
  await win.waitForURL((u) => /\/manual\.html$/u.test(u.pathname));
  await expect(win.locator('[data-pkc-region="manual-window-main"]')).toBeVisible();
  await expect(win.locator('[data-pkc-field="manual-window-head"]')).toContainText('マニュアル — PKC3');
  expect(await win.locator('[data-pkc-region="manual-window-toc"] a').count(), '目次が空').toBeGreaterThan(100);
  await expect(dialog, 'Enter のあとパレットが閉じていない').toBeHidden();
  return win;
}

/**
 * 🔴 **操作を名前で探す**(#425 段①)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **本物の `<dialog showModal()`** ── happy-dom にも `<dialog>` は在るが、
 *    **焦点が本当に器の中へ移るか**(開いた直後に打てるか)は実機でしか見えない。
 *    ⚠ ここが落ちると「開いたのに打てない」= 面が丸ごと使えない。
 * 2. **実ブラウザが配る `code`** ── `Ctrl+Shift+P` は unit では自分で書いた
 *    `code` を渡している。実際の打鍵で同じ名前が来るかはここでしか確かめられない。
 * 3. **既定動作を奪っていないか** ── `Ctrl+Shift+P` は Firefox の
 *    「プライベートウィンドウ」と同じ綴りである。少なくとも Chromium で
 *    **アプリが生きたまま**開けることを見る。
 */
test('🔴 名前で探して実行できる ── 開く / 絞る / Enter で走る (#425)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  const filter = page.locator('[data-pkc-field="palette-filter"]');
  const rows = page.locator('[data-pkc-field="palette-row"]');

  // ① 押しボタンで開く ── **マウスだけで完結する**(不可侵指示)
  await clickReal(page, '[data-pkc-action="open-palette"]');
  await expect(dialog, '押しても開かない').toBeVisible();
  await expect(rows.first(), '一覧が空のまま出ている').toBeVisible();

  /**
   * ② 🔴 **開いた直後にそのまま打てる** ── 焦点が探す欄に無いと、
   *   user は「開いたのに反応しない」と受け取る(実機でしか見えない層)。
   */
  await expect(filter, '開いた直後に探す欄へ焦点が無い').toBeFocused();
  const before = await rows.count();
  await page.keyboard.type('集計');
  await expect
    .poll(() => rows.count(), { message: '打っても絞られない' })
    .toBeLessThan(before);
  await expect(rows.first()).toHaveAttribute('data-pkc-command', 'view-query');

  // ③ Enter で走る(いちばん上の押せる行)
  await page.keyboard.press('Enter');
  await expect(dialog, 'Enter を押しても器が閉じない').toBeHidden();
  await expect(
    page.locator('[data-pkc-view-pane="query"]'),
    'Enter で選んだ操作が走っていない',
  ).toBeVisible();

  /**
   * ④ 🔴 **近道でも開く**(実ブラウザの `code` が届くか)。
   * ⚠ アプリが生きたまま開くこと ── ここで窓ごと持っていかれると `errors` 以前に
   *   以降の locator が全部落ちる。
   */
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '近道で開かない(実機の code が届いていない)').toBeVisible();

  // ⑤ 押せない操作も**出る**が、理由つきで押せない
  await page.keyboard.type('確定');
  const first = rows.first();
  await expect(first, '押せない操作を隠している(user は「無い」と読む)').toBeVisible();
  await expect(first, '押せないのに押せることになっている').toBeDisabled();
  await expect(
    first.locator('[data-pkc-field="palette-why"]'),
    '押せない理由が出ていない',
  ).toContainText('いまは押せません');

  /**
   * ⑥ 🔴 **字を打った状態でも Escape で閉じる**(2026-08-26 にここで踏んだ)。
   *
   * ⚠ 欄を `type="search"` にしていたら、Chromium は **`Escape` を食べて
   *   欄を空にする** ── 器は開いたままで、user には「押しても閉じない」と
   *   しか見えなかった。⚠ **字を消してから押すと通ってしまう**ので、
   *   ここは**打った直後に押す**(空にしない)。
   */
  await expect(filter, '前提が崩れている(欄が空 ── Escape を食べる場面になっていない)')
    .not.toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog, 'Escape で閉じない').toBeHidden();
  await page.keyboard.press('Alt+1');
  await expect(
    page.locator('[data-pkc-region="detail"]'),
    '閉じた後に鍵が死んでいる(焦点が返っていない)',
  ).toBeVisible();

  /**
   * ⑦ 🔴 **ヘルプを 1 度も開かずに、「マニュアル」で探して Enter ── 別のウィンドウが開く**(#1452 案 1)。
   * ⚠ 同じ起動の続き(この test は `help` の面を一度も開いていない = 「ヘルプのボタン」は
   *   まだ組まれていない)。
   */
  expect(
    await page.locator('[data-pkc-action="open-manual-window"]').count(),
    '前提が崩れている(ヘルプを開いていないのにマニュアルのボタンが在る)',
  ).toBe(0);
  const manualWin = await openManualFromPalette(page, context);
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
  await manualWin.close();

  /**
   * ⑧ 🔴 **場面ごとに足した操作(#582 段③ 第 1 群)が、実ブラウザで走る**。
   * ⚠ 同じ起動の続き(新しい起動を足さない)。見るのは 3 つ:
   *   ア 開いていない場面の操作は**灰色 + 理由**(予定の画面を開いていない)
   *   イ 欄が先に要る操作(タグを足す)は、空なら**欄へ移り**、字を入れて呼び直すと**足せる**
   *   ウ 「今日のノートを開く」は、押しボタンと同じく今日のノートを作って開く
   */
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const ask = async (q: string): Promise<void> => {
    await page.keyboard.press('Control+Shift+P');
    await expect(dialog).toBeVisible();
    await page.locator('[data-pkc-field="palette-filter"]').fill(q);
  };
  const rowOf = (id: string) => page.locator(`[data-pkc-field="palette-row"][data-pkc-command="${id}"]`);
  await ask('予定を足す');
  await expect(rowOf('schedule-quick-add'), '予定の画面を開いていないのに押せる顔').toBeDisabled();
  await expect(rowOf('schedule-quick-add').locator('[data-pkc-field="palette-why"]')).toContainText(
    '予定の画面を開いているとき',
  );
  // 🔴 場面の名前(#582 段③)── 灰色の行にも右端に出る(押せない行を場面で見分けられる)
  await expect(
    rowOf('schedule-quick-add').locator('[data-pkc-field="palette-scene"]'),
    '押せない行に場面の名前が出ていない',
  ).toHaveText('予定');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const tagField = page.locator('[data-pkc-field="tag-add-input"]');
  await ask('タグを足す');
  await expect(rowOf('add-tag'), 'ノートを選んでいるのに押せない').toBeEnabled();
  await expect(page.locator('[data-pkc-field="palette-row"]').first()).toHaveAttribute('data-pkc-command', 'add-tag');
  /**
   * 🔴 **場面の名前に見た目の規則が在る**(属性が付いているだけでは「付けた」しか言わない ── 実ブラウザの計算後の値で見る)。
   *   ア 行の名前とは別の控えめな色 イ 行の右端に寄っている(名前の直後ではない)
   */
  const sceneLook = await rowOf('add-tag').evaluate((row) => {
    const scene = row.querySelector('[data-pkc-field="palette-scene"]');
    const label = row.querySelector('[data-pkc-field="palette-label"]');
    if (scene === null || label === null) return null;
    const sr = scene.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    return {
      text: scene.textContent,
      sceneColor: getComputedStyle(scene).color,
      labelColor: getComputedStyle(label).color,
      gapToRight: rr.right - sr.right,
      gapFromLabel: sr.left - label.getBoundingClientRect().right,
    };
  });
  expect(sceneLook, '行に場面の名前が出ていない').not.toBeNull();
  expect(sceneLook!.text).toBe('ノート');
  expect(sceneLook!.sceneColor, '場面の名前が行の名前と同じ色(控えめになっていない)').not.toBe(sceneLook!.labelColor);
  expect(sceneLook!.gapToRight, '場面の名前が行の右端に寄っていない').toBeLessThan(40);
  expect(sceneLook!.gapFromLabel, '場面の名前が名前の直後に詰まっている(右端へ寄せる規則が効いていない)').toBeGreaterThan(60);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(tagField, '欄が空なのに、欄へ移っていない').toBeFocused();
  await page.keyboard.type('烏龍');
  await ask('タグを足す');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('[data-pkc-field="inspector-tag-chips"]'),
    '字を入れて呼び直したのに、タグが足されていない',
  ).toContainText('烏龍');

  const listed = page.locator('[data-pkc-region="sidebar"] [data-pkc-entry]');
  const listedBefore = await listed.count();
  await ask('今日のノートを開く');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => listed.count(), { message: '今日のノートが作られていない' })
    .toBe(listedBefore + 1);

  /**
   * ⑩ 🔴 **打っている場所に入れる操作(#582 段③ 第 3 群)が、1 面のライブ編集で「打っていた場所」に入る**。
   * ⚠ 同じ起動の続き(新しい起動を足さない)。一覧を閉じた直後は欄の選択が先頭(0,0)へ戻る(実ブラウザで測った)ので、
   *   戻していなければ**全部が本文の先頭に入る**。`hello world` の 5 字目(`hello` と `world` の間)に caret を置いて呼ぶ。
   *   見るのは 5 つ:日付 / アイコン / 図(caret)/ ノートリンク(前から登記済みで同じ穴を持っていた)と、図(選んだ範囲)。
   */
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  const liveRow = page.locator('[data-pkc-field="row-source"]');
  await expect(liveRow, '1 面の行が開かない(前提)').toBeVisible();
  const caretAt = async (text: string, from: number, to = from): Promise<void> => {
    await liveRow.fill(text);
    await liveRow.evaluate((el, [a, b]) => (el as HTMLTextAreaElement).setSelectionRange(a!, b!), [from, to]);
  };
  const callByName = async (q: string, cmd: string): Promise<void> => {
    await ask(q);
    await expect(rowOf(cmd), `「${q}」が本文を打っている間に押せない`).toBeEnabled();
    await page.keyboard.press('Enter');
  };
  // 日付
  await caretAt('hello world', 5);
  await callByName('日付を入れる', 'insert-date');
  await page.locator('[data-pkc-field="pick-shortcut"]').first().click();
  await page.locator('[data-pkc-field="dialog-ok"]').click();
  await expect(dialog).toBeHidden();
  await expect(liveRow, '日付が打っていた場所(hello と world の間)に入っていない').toHaveValue(
    /^hello @\d{4}-\d{2}-\d{2} world$/u,
  );
  // アイコン
  await caretAt('hello world', 5);
  await callByName('アイコンを入れる', 'insert-icon');
  const iconBtn = page.locator('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name]').first();
  const iconName = await iconBtn.getAttribute('data-pkc-icon-name');
  expect(iconName, '前提:押したアイコンの名前が読めない').toBeTruthy();
  await iconBtn.click();
  await expect(dialog).toBeHidden();
  await expect(liveRow, 'アイコンが打っていた場所に入っていない(先頭に入った?)').toHaveValue(`hello:${iconName}: world`);
  // 図(caret): 種類を聞かれ、選ぶとそこへ入る
  await caretAt('hello world', 5);
  await callByName('図を入れる', 'insert-diagram');
  await page.locator('[data-pkc-field="pick-diagram"]').first().click();
  await expect(dialog).toBeHidden();
  // ⚠ 器が閉じる(`open` が外れる)のは、本文へ入る**より前**(`close` event は後の task で来て、答えを返してから書く)
  //   ── 閉じたのを見た直後の読みは、負荷がかかると入る前の値を拾う。入るのを待ってから読む
  await expect(liveRow, '図が入っていない').toHaveValue(/```mermaid/u);
  const diagramValue = await liveRow.inputValue();
  expect(diagramValue.startsWith('hello'), `図が先頭に入った: ${diagramValue}`).toBe(true);
  expect(diagramValue, '図が入っていない').toContain('```mermaid');
  expect(diagramValue.trimEnd().endsWith('world'), `後ろの字が動いた: ${diagramValue}`).toBe(true);
  // 図(選んだ範囲): 一覧を出さずに、選んだ範囲だけを囲む
  await caretAt('あいうえお', 1, 4);
  await callByName('図を入れる', 'insert-diagram');
  await expect(dialog).toBeHidden();
  // ⚠ 上と同じ:パレットが閉じたのを見ても、命令が本文へ書くのはその後
  await expect(liveRow, '選んだ範囲が図の囲みにならない').toHaveValue(/```mermaid/u);
  const wrapped = await liveRow.inputValue();
  expect(wrapped, `選んだ範囲(いうえ)が図の囲みになっていない: ${wrapped}`).toMatch(/^あ\n?```mermaid\nいうえ\n```\n?お$/u);
  // ノートリンク(前から登記済み。同じ穴)
  await caretAt('hello world', 5);
  await callByName('ノートリンクを入れる', 'insert-entry-link');
  await page.locator('[data-pkc-field="entry-pick-row"]').first().click();
  await expect(dialog).toBeHidden();
  await expect(liveRow, 'リンクが入っていない').not.toHaveValue('hello world');
  const linked = await liveRow.inputValue();
  expect(linked.startsWith('hello'), `リンクが先頭に入った: ${linked}`).toBe(true);
  expect(linked.endsWith('world'), `後ろの字が動いた: ${linked}`).toBe(true);
  expect(linked.length, 'リンクが入っていない').toBeGreaterThan('hello world'.length);
  // マウスで「操作を探す」のボタンを押して開く(焦点が欄からボタンへ移る道)── 開いたときの caret の位置へ入る
  await caretAt('hello world', 5);
  await clickReal(page, '[data-pkc-action="open-palette"]');
  await expect(dialog, 'マウスで操作を探すが開かない').toBeVisible();
  await page.locator('[data-pkc-field="palette-filter"]').fill('アイコンを入れる');
  await expect(rowOf('insert-icon'), 'マウスで開くと、本文を打っている間なのに押せない').toBeEnabled();
  await page.keyboard.press('Enter');
  const mouseIcon = page.locator('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name]').first();
  const mouseIconName = await mouseIcon.getAttribute('data-pkc-icon-name');
  await mouseIcon.click();
  await expect(dialog).toBeHidden();
  await expect(liveRow, 'マウスで開いたら、アイコンが本文の先頭に入った').toHaveValue(`hello:${mouseIconName}: world`);
  /**
   * ⑩-b 🔴 **左の探す欄の `>` から呼んでも、1 面の行の「打っていた場所」に入る**(#582)。
   * ⚠ 同じ起動の続き。探す欄を押すと行が確定して消える(前提として確かめる)── 消えた行を開き直して caret を戻してから入れる。
   *   日付(小窓が同期で開く)とアイコン(選ぶ一覧が非同期で出る)の 2 つを見る。
   */
  const leftFilter = page.locator('[data-pkc-field="entry-filter"]');
  const callFromLeft = async (q: string, cmd: string): Promise<void> => {
    await caretAt('hello world', 5);
    await clickReal(page, '[data-pkc-field="entry-filter"]');
    await expect(liveRow, '前提: 探す欄を押したら行が確定して消える').toHaveCount(0);
    await leftFilter.fill(q);
    const rowBtn = page.locator(`[data-pkc-region="sidebar"] [data-pkc-command="${cmd}"]`);
    await expect(rowBtn, `左の一覧に「${q}」が出ていない`).toBeEnabled();
    await rowBtn.click();
  };
  await callFromLeft('>日付を入れる', 'insert-date');
  await page.locator('[data-pkc-field="pick-shortcut"]').first().click();
  await page.locator('[data-pkc-field="dialog-ok"]').click();
  await expect(dialog).toBeHidden();
  await expect(liveRow, '左の探す欄から呼んだ日付が、打っていた場所に入っていない').toHaveValue(
    /^hello @\d{4}-\d{2}-\d{2} world$/u,
  );
  await callFromLeft('>アイコンを入れる', 'insert-icon');
  const leftIcon = page.locator('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name]').first();
  const leftIconName = await leftIcon.getAttribute('data-pkc-icon-name');
  await leftIcon.click();
  await expect(dialog).toBeHidden();
  await expect(liveRow, '左の探す欄から呼んだアイコンが、打っていた場所に入っていない').toHaveValue(
    `hello:${leftIconName}: world`,
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * ⑨-0 🔴 **「選択範囲をコピー」を「操作を探す」から呼ぶ**(#582 段③ 依頼 22 の Q3 = A)。
   * ⚠ 同じ起動の続き(新しい起動を足さない)。直前に確定した 1 面のノートを読んでいる。実ブラウザで見るのは 3 つ:
   *   ア 選択が無いときは灰色 + 理由 イ 本文の中を選んでから開くと押せる(開いた瞬間に選択が消えても、開く前の字を控えている)
   *   ウ 選ぶと本物のクリップボードに **Markdown の原文**が入る
   */
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await expect(page.locator('[data-pkc-field="detail-body"] p').first(), '前提が崩れている(読む面に本文が無い)').toBeVisible();
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await ask('選択範囲をコピー');
  await expect(rowOf('copy-selection-md'), '選択が無いのに押せる').toBeDisabled();
  await expect(rowOf('copy-selection-md').locator('[data-pkc-field="palette-why"]')).toContainText(
    '本文の中を選択してから呼んでください',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // 読む面の先頭の段落の「hello」を選ぶ(原文では `hello` ── 後ろの `:アイコン:` は含まない)
  await page.evaluate(() => {
    const p = document.querySelector('[data-pkc-field="detail-body"] p')!;
    const t = p.firstChild!;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await ask('選択範囲をコピー');
  await expect(rowOf('copy-selection-md'), '本文の中を選んでから開いたのに押せない').toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { message: '選んだ範囲が本物のクリップボードに入っていない' })
    .toBe('hello');

  /**
   * ⑨ 🔴 **場面ごとに足した操作 第 2 群(#582 段③)が、実ブラウザで走る**。
   * ⚠ 同じ起動の続き(新しい起動を足さない)。見るのは 3 つ(どれも「押すのと同じことが起きる」):
   *   ア ゴミ箱を開く → 閉じる(フォルダの一覧の中のボタンを撃つ。往復で元へ戻る)
   *   イ 時間を計る(ノートを開いている間だけ意味がある ── 今日のノートが開いている)
   *   ウ お知らせを開く(押しボタンはヘルプの中にしか無い特例 ── ヘルプを開かずに「システム」のお知らせの節へ着く)
   */
  await ask('ゴミ箱を開く');
  await expect(rowOf('show-trash'), 'フォルダの一覧を開いているのに押せない').toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-pkc-action="hide-trash"]'), 'ゴミ箱が開いていない').toBeVisible();
  await ask('ゴミ箱を閉じる');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-pkc-action="show-trash"]:not([hidden])'), 'ゴミ箱が閉じていない').toBeVisible();

  await ask('時間を計る');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '時間を計り始めていない(ボタンと同じ受け手に届いていない)',
  ).toContainText('計り始めました');

  expect(
    await page.locator('[data-pkc-region="settings-notices-section"]').isVisible(),
    '前提が崩れている(お知らせの節が最初から見えている)',
  ).toBe(false);
  await ask('お知らせを開く');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('[data-pkc-region="settings-notices-section"]'),
    'ヘルプを開かずに、お知らせの節へ着かない',
  ).toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **編集中の記法をパレットから入れる**(#425 段②-b)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * 1. 器は本物の **`<dialog showModal()`** ── **開いた瞬間に編集欄から焦点が外れ**、
 *    閉じるときに**返る**。この往復が本当に起きるかは実機でしか見えない
 * 2. 🔑 **選択範囲が焦点を失っている間も残るか** ── 残らなければ
 *    「選んだ所ではない所」に記法が入る。⚠ **推測せず、ここで測る**
 *    (2026-08-26 の実測: 開く前 1-4 → 開いている間 1-4 → 閉じた後 1-4)
 */
/**
 * 🔴 **説明が器からはみ出さない**(#474、cowork の実機検証レポート #16)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * これは**折り返しの話**なので、happy-dom では 1 文字も測れない
 * (レイアウトを持たない)。
 *
 * ## 何が起きていた
 *
 * 行に規則が 1 つも無く、`button` の既定(`white-space: nowrap` /
 * 高さを `--row-h` に固定)をそのまま受けていた ── あれは
 * **帯に並ぶ道具**のための規則である。実測(1280x900、51 行):
 * 器 486px に対し行が **1124px** = **638px はみ出し**、横スクロールバーが出ていた。
 *
 * 🔑 見るのは 2 つ:**横に溢れていない**ことと、**実際に折り返している**こと。
 * ⚠ 後者が空振り防止である ── 行が短ければ「溢れていない」は自明に通る。
 */
test('🔴 パレットの説明が横に溢れず、折り返す (#474)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await clickReal(page, '[data-pkc-action="open-palette"]');
  const list = page.locator('[data-pkc-field="palette-list"]');
  await expect(list, 'パレットが開いていない').toBeVisible({ timeout: 10_000 });

  const m = await page.evaluate(() => {
    const l = document.querySelector('[data-pkc-field="palette-list"]')!;
    const dlg = document.querySelector('[data-pkc-region="app-dialog"]')!;
    const rows = [...document.querySelectorAll('[data-pkc-field="palette-row"]')];
    const rowH = rows.map((r) => Math.round(r.getBoundingClientRect().height));
    const oneLine = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
    return {
      listScrollW: l.scrollWidth,
      listClientW: l.clientWidth,
      dlgScrollW: dlg.scrollWidth,
      dlgClientW: dlg.clientWidth,
      rowCount: rows.length,
      // 折り返した行がいくつあるか(1 行の高さより高い = 折り返している)
      wrapped: rowH.filter((h) => h > oneLine + 4).length,
      // 🔴 **縦に切れている行**(高さを固定したままだと 2 行目が見えない)
      clipped: rows.filter((r) => r.scrollHeight > r.clientHeight + 1).length,
      widest: Math.max(...rows.map((r) => Math.round(r.getBoundingClientRect().width))),
      narrowest: Math.min(...rows.map((r) => Math.round(r.getBoundingClientRect().width))),
    };
  });

  // ⚠ 空振り防止 ── 行が無ければ以下は自明に通る
  expect(m.rowCount, 'パレットに行が 1 つも無い').toBeGreaterThan(10);
  /**
   * 🔴 **空振り防止の本体は「長い中身が在るか」である**(2026-08-27、変異試験 P2/P5)。
   *
   * ⚠ 1 稿目はここを「**折り返している行が在るか**」で書いていた ── ところが
   *   直しを消す変異は**まさに折り返しを止める**ので、この門が先に鳴り、
   *   「検査にならない」という**原因を取り違えたメッセージ**で落ちていた
   *   (実際には縦に切れている / 横へ溢れている、という実害が出ている)。
   * 🔑 **門が問うべきは「器に対して長い中身が在るか」**であって、
   *   「いま折り返せているか」ではない ── 後者は**直っていることそのもの**なので、
   *   門に置くと壊れた状態を全部この門が飲み込む。
   * 🔑 だから 3 つのどれかで真にする:折り返した / 縦に切れた / 横へ溢れた。
   *   登記表が短くなって本当に測れなくなった日だけ、ここが鳴る。
   */
  expect(
    m.wrapped + m.clipped + (m.listScrollW > m.listClientW + 1 ? 1 : 0),
    '器より長い説明が 1 つも無い ── 溢れも折り返しも起き得ないので検査にならない',
  ).toBeGreaterThan(0);

  // 🔴 本体 ── 横に溢れていない(横スクロールバーが出ない)
  expect(
    m.listScrollW,
    `一覧が横に溢れている(${m.listScrollW} > ${m.listClientW})── 隠れた説明に気づけない`,
  ).toBeLessThanOrEqual(m.listClientW + 1);
  expect(
    m.dlgScrollW,
    `器が横に溢れている(${m.dlgScrollW} > ${m.dlgClientW})`,
  ).toBeLessThanOrEqual(m.dlgClientW + 1);
  // 🔑 行が器の幅に収まっている(上の 2 つは器ごと広がっても通りうる)
  expect(m.widest, `行が一覧より広い(${m.widest} > ${m.listClientW})`).toBeLessThanOrEqual(
    m.listClientW + 1,
  );

  /**
   * 🔴 **縦に切れていない**(#474、変異試験 P2)。⚠ 高さの固定
   * (`max-height: var(--row-h)`)を解かないと、折り返した 2 行目が**器の中で
   * 切れる** ── そのとき上の「折り返している行がある」が先に落ちるので、
   * **「検査にならない」という的外れな理由**で赤くなる。ここで名前を付けておく。
   */
  expect(m.clipped, `${m.clipped} 行が縦に切れている(説明の 2 行目が読めない)`).toBe(0);

  /**
   * 🔴 **行はどれも器いっぱい**(押せる場所を揃える)。⚠ `width: 100%` を外すと
   *   行は**字の長さぶんしか無く**なり、右側の空白を押しても何も起きない
   *   (見た目は一覧なのに、当たるのは字の上だけ)。
   * ⚠ 変異試験 P3 はこれを足すまで生き延びた ── 溢れの検査だけでは
   *   `inline-flex` へ戻す変異を殺せない(器の幅で折り返すので溢れはしない)。
   */
  expect(
    m.narrowest,
    `行の幅が揃っていない(いちばん狭い行 ${m.narrowest} / 一覧 ${m.listClientW})`
      + ' ── 右側の空白を押しても何も起きない',
  ).toBeGreaterThanOrEqual(m.listClientW - 1);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **一覧を送っても、探す欄と「やめる」は動かない**(#474)。
 *
 * ⚠ 直す前は**器ごと**流れていたので、下の行を見に行くと**探す欄が画面から出て**
 *   いた(実測: 器 868px に対し中身 1437px)。⚠ 折り返すと行が高くなるので、
 *   直さないとこの症状は**悪化する**側だった。
 * 🔑 #151 と同じ形である ── **高さを切ってよいのは読むものだけで、
 *   操作する手を切ってはいけない**。
 */
test('🔴 パレットの一覧を送っても、探す欄と「やめる」はそこに在る (#474)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await clickReal(page, '[data-pkc-action="open-palette"]');
  const list = page.locator('[data-pkc-field="palette-list"]');
  await expect(list, 'パレットが開いていない').toBeVisible({ timeout: 10_000 });

  const at = (): Promise<{ input: number; cancel: number }> =>
    page.evaluate(() => ({
      input: Math.round(
        document
          .querySelector('[data-pkc-field="palette-filter"]')!
          .getBoundingClientRect().top,
      ),
      cancel: Math.round(
        document
          .querySelector('[data-pkc-field="dialog-cancel"]')!
          .getBoundingClientRect().bottom,
      ),
    }));
  const before = await at();

  // ⚠ 空振り防止 ── 一覧が実際に溢れていること(溢れなければ送っても動かないのは自明)
  const fit = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(fit.scroll, `一覧が溢れていない(${fit.scroll} ≤ ${fit.client})`).toBeGreaterThan(
    fit.client + 1,
  );

  const box = await list.boundingBox();
  expect(box, '一覧が画面に出ていない').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 600);
  // 🔴 **送れたことを確かめる**(`hidden` ならここで止まる)
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop), { message: '一覧を送れない' })
    .toBeGreaterThan(0);

  const after = await at();
  expect(after.input, '送ったら探す欄が動いた(器ごと流れている)').toBe(before.input);
  expect(after.cancel, '送ったら「やめる」が動いた').toBe(before.cancel);

  expect(errors).toEqual([]);
});

test('🔴 選んでからパレットで記法を入れると、選んだ範囲に入る (#425 段②-b)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('あいうえお');
  await ta.click();
  // 「いうえ」を選ぶ
  await ta.evaluate((el) => {
    (el as HTMLTextAreaElement).setSelectionRange(1, 4);
  });

  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  const filter = page.locator('[data-pkc-field="palette-filter"]');

  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '編集中に開けない').toBeVisible();

  // 🔴 **「押せません」と出ないこと** ── 段②-a まではここで止まっていた
  await filter.fill('ハイライト');
  const first = page.locator('[data-pkc-field="palette-row"]').first();
  await expect(first, '一覧に出ていない').toBeVisible();
  await expect(
    first.locator('[data-pkc-field="palette-why"]'),
    '本文の欄に居るのに「押せません」と出ている',
  ).not.toContainText('いまは押せません');

  await page.keyboard.press('Enter');
  await expect(dialog, '選んでも閉じない').toBeHidden();

  // 🔴 **選んだ範囲に入っている**(先頭でも末尾でもない)
  await expect(ta, '選んだ範囲に入っていない').toHaveValue('あ==いうえ==お');

  /**
   * 🔑 **続けて打てる** ── 焦点が返っていなければ、次の字は本文に入らない。
   * ⚠ 「入った」だけを見て終えると、**打てなくなっているのに緑**になる
   *   (CLAUDE.md §10 ── 器が「ついでに」返していた性質)。
   */
  await page.keyboard.type('か');
  await expect(ta, '閉じた後に焦点が返っていない').toHaveValue(/か/);

  /**
   * 🔴 **表の列幅を揃える**(#1171)── 同じ道中(2 列の欄 + パレット)に 1 つ足す。
   * ⚠ 本物のブラウザでは `insertText` が `execCommand` で入る(unit の happy-dom は
   *   手で書き換える側を通る)── **実際に揃い、カーソルが同じ升に残る**ことを見る。
   */
  const table = '| 名前 | 価格 |\n|---|---|\n| りんご | 100 |';
  await ta.fill(table);
  await ta.evaluate((el, at) => {
    (el as HTMLTextAreaElement).setSelectionRange(at, at);
  }, table.indexOf('ご'));
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '編集中に開けない(表)').toBeVisible();
  await filter.fill('列幅');
  await expect(
    page.locator('[data-pkc-field="palette-row"]').first(),
    '「表の列幅を揃える」が探せない',
  ).toHaveAttribute('data-pkc-command', 'align-table');
  await page.keyboard.press('Enter');
  await expect(dialog, '選んでも閉じない(表)').toBeHidden();
  await expect(ta, '表の列幅が揃っていない').toHaveValue(
    '| 名前   | 価格 |\n| ------ | ---- |\n| りんご | 100  |',
  );
  // 🔑 カーソルは同じ升の「ご」の手前に残る(続けて打った字がそこへ入る)
  await page.keyboard.type('X');
  await expect(ta, 'カーソルが同じ升に残っていない').toHaveValue(/りんXご/);

  /**
   * 🔴 **編集中(打った字が下書きにある)でも、別のウィンドウが開き、元のタブは編集のまま**(#1452 案 1)。
   * ⚠ マニュアルの窓は本文に触らない ── 打った字が残り、編集の欄がそのまま在ること。
   */
  const draft = await ta.inputValue();
  expect(draft, '前提が崩れている(打った字が無い)').toMatch(/りんXご/);
  const manualWin = await openManualFromPalette(page, context);
  await expect(ta, '別のウィンドウを開いたら編集の欄が消えた').toBeVisible();
  await expect(ta, '別のウィンドウを開いたら打った字が変わった').toHaveValue(draft);
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '別のウィンドウを開いたら編集が終わった(読む形に戻った)',
  ).toHaveCount(0);
  await manualWin.close();

  /**
   * 🔴 **2 列の編集でも、マウスで操作を探すを開いて「アイコンを入れる」を呼ぶと、打っていた場所に入る**(#582 段③ 第 3 群)。
   * ⚠ 同じ起動の続き。ボタンを押すと焦点が欄からボタンへ移る道(キーで開く道は上で見た)。
   */
  await ta.fill('hello world');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(5, 5));
  await clickReal(page, '[data-pkc-action="open-palette"]');
  await expect(dialog, 'マウスで操作を探すが開かない(2 列)').toBeVisible();
  await filter.fill('アイコンを入れる');
  await expect(
    page.locator('[data-pkc-field="palette-row"][data-pkc-command="insert-icon"]'),
    'マウスで開くと押せない(2 列)',
  ).toBeEnabled();
  await page.keyboard.press('Enter');
  const colIcon = page.locator('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name]').first();
  const colIconName = await colIcon.getAttribute('data-pkc-icon-name');
  await colIcon.click();
  await expect(dialog).toBeHidden();
  await expect(ta, '2 列でマウスで開いたら、アイコンが本文の先頭に入った').toHaveValue(`hello:${colIconName}: world`);

  /** 2 列の編集は欄が残るので、左の探す欄の `>` からも(開き直しの手前の道を通らず)打っていた場所に入る(#582。壊していないことの対照群)。 */
  await ta.fill('hello world');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(5, 5));
  await clickReal(page, '[data-pkc-field="entry-filter"]');
  await page.locator('[data-pkc-field="entry-filter"]').fill('>アイコンを入れる');
  await page.locator('[data-pkc-region="sidebar"] [data-pkc-command="insert-icon"]').click();
  const leftColIcon = page.locator('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name]').first();
  const leftColIconName = await leftColIcon.getAttribute('data-pkc-icon-name');
  await leftColIcon.click();
  await expect(dialog).toBeHidden();
  await expect(ta, '2 列で左の探す欄から呼んだアイコンが、打っていた場所に入っていない').toHaveValue(
    `hello:${leftColIconName}: world`,
  );

  /**
   * 🔴 **2 列の編集で「すべて置換」(操作を探すから)→ Ctrl+Z で置き換える前に戻る**(#1087)。
   * ⚠ `syncBody` が `ta.value =` で書くと、ブラウザの取り消し履歴が捨てられて Ctrl+Z が効かない
   *   (unit の happy-dom では観測できない)。同じ起動の続きに足す(新しい起動は足さない)。
   */
  const before = 'りんごとみかんとりんご';
  await ta.fill(before);
  await clickReal(page, '[data-pkc-action="toggle-replace"]');
  await page.locator('[data-pkc-field="replace-find"]').fill('りんご');
  await page.locator('[data-pkc-field="replace-with"]').fill('もも');
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '置換のためにパレットが開かない').toBeVisible();
  await filter.fill('すべて置換');
  await expect(
    page.locator('[data-pkc-field="palette-row"][data-pkc-command="replace-all"]'),
    '操作を探すの「すべて置換」が押せない',
  ).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(ta, '「すべて置換」が 2 列の欄に映っていない').toHaveValue('ももとみかんともも');
  await page.keyboard.press('Control+z');
  await expect(ta, '置換の直後の Ctrl+Z で置き換える前に戻らない(取り消し履歴が捨てられている)').toHaveValue(before);

  expect(errors,`page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **器を外から閉じても、編集を終えられる**(#723)。
 *
 * ## 何を守っているか
 *
 * cowork が 1 回だけ「**編集を終えられなくなった**」を観測した(再現せず)。
 * ⚠ 自前の `<dialog>` は **1 本の鎖**(`app-dialog.ts` の `enqueue`)に並ぶので、
 *   1 枚が**解決しないまま**残ると以後の確認が 1 枚も開かない ── 確認を経由する
 *   操作が丸ごと無反応になる、という形で同じ症状になりうる。
 * 🔑 だから「押し所を経由せずに閉じられた」形をわざと作って、**その後で編集を
 *   終えられるか**を見る。⚠ unit にも同じ形の pin を置いたが、**本物の
 *   `showModal()` / `close()` の意味論**は実ブラウザにしか無い(happy-dom は
 *   `returnValue` の扱いが実機と違う、と `app-dialog.ts` が実測している)。
 */
test('🔴 パレットを外から閉じた後でも、編集を保存できる (#723)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, 'パレットが開かない(台が崩れている)').toBeVisible();

  // 🔴 字幕ファイル(.srt)で書き出す(#1447)── ノートを開いていないときは**出るが押せず、理由が出る**
  //   (同じ道中に assert を足す。新しく起動しない)
  await page.locator('[data-pkc-field="palette-filter"]').fill('字幕');
  const srtRow = page.locator('[data-pkc-field="palette-row"][data-pkc-command="export-transcript-srt"]');
  await expect(srtRow, '字幕の操作が名前で探せない').toHaveCount(1);
  await expect(srtRow, 'ノートを開いていないのに押せる').toBeDisabled();
  await expect(
    srtRow.locator('[data-pkc-field="palette-why"]'),
    '押せない理由が出ていない(字幕)',
  ).toContainText('いまは押せません');

  /**
   * ⚠ **押し所を経由せず、器を直に閉じる。** `Escape` ではこの形にならない
   *   (`Escape` も `close` を出すが、それは器が自分で閉じる道である)。
   */
  await page.evaluate(() => {
    document.querySelector<HTMLDialogElement>('[data-pkc-region="app-dialog"]')?.close();
  });
  await expect(dialog, '外から閉じても器が残っている').toBeHidden();

  // 🔑 **鎖が詰まっていないこと** ── もう 1 枚開けるか(詰まっていれば永久に出ない)
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '外から閉じた後、次のダイアログが開かない(列が詰まった)').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // 🔴 本題 ── ここから編集して、**終えられる**
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  // ⚠ 行頭に時刻のある行(文字起こしの形)を 2 行足す ── 後段の字幕ファイル(#1447)の材料
  await ta.fill('パレットを外から閉じた後の本文\n0:15 こんにちは\n0:20 さようなら');
  await page.keyboard.press('Control+s');

  // 保存できた = 編集の面から出ている(読む形の本文が出ている)
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '保存しても編集の面から出られない(#723 の症状)',
  ).toContainText('パレットを外から閉じた後の本文');
  // ⚠ 断り文が出ていないこと(黙って捨てられていない ── #723 の計器)
  await expect(page.locator('[data-pkc-region="status"]')).not.toContainText(
    '保存できませんでした',
  );

  /**
   * 🔴 字幕ファイル(.srt)で書き出す(#1447)── 開いたノートに時刻つきの行が在れば**押せて、落ちる**。
   * ⚠ 日本語の題名では `suggestedFilename` が当てにならない環境なので、見るのは**中身**だけ(拡張子は unit が見る)。
   */
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '保存後にパレットが開かない').toBeVisible();
  // 🔑 「字幕 書き出し」で 1 件に絞り、**Enter で走る道**(鍵だけの user の道)を通す。埋め込みの行は「書き出し」を持たない
  await page.locator('[data-pkc-field="palette-filter"]').fill('字幕 書き出し');
  const srtRow2 = page.locator('[data-pkc-field="palette-row"]').first();
  await expect(srtRow2).toHaveAttribute('data-pkc-command', 'export-transcript-srt');
  await expect(srtRow2, '時刻つきの行が在るのに押せない').toBeEnabled();
  const srtDl = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const srtFile = await srtDl;
  const srtPath = await srtFile.path();
  const srtText = readFileSync(srtPath, 'utf8');
  expect(srtText, 'SRT の 1 件目が組まれていない').toContain('00:00:15,000 --> 00:00:20,000');
  expect(srtText).toContain('こんにちは');
  expect(srtText).toContain('さようなら');

  // 🔴 #1447 の残り ── 右の列に「字幕ファイル(.srt)で書き出す」が出て(時刻つきの行があるノートだけ)、押すと落ちる
  const srtBtn = page.locator('[data-pkc-region="inspector"] [data-pkc-action="export-entry-srt"]');
  await expect(srtBtn, '時刻つきの行があるノートなのに、右の列に字幕のボタンが出ていない').toBeVisible();
  const srtDl2 = page.waitForEvent('download');
  await srtBtn.click();
  expect(readFileSync(await (await srtDl2).path(), 'utf8'), '右の列から落とした字幕が違う').toContain(
    '00:00:15,000 --> 00:00:20,000',
  );

  // 🔴 字幕(SRT)を本文の末尾に埋め込む ── ```srt の囲みが本文に足される
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog).toBeVisible();
  await page.locator('[data-pkc-field="palette-filter"]').fill('埋め込む');
  const embedRow = page.locator('[data-pkc-field="palette-row"][data-pkc-command="embed-transcript-srt"]');
  await expect(embedRow, '時刻つきの行が在るのに押せない(埋め込み)').toBeEnabled();
  await embedRow.click();
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '字幕の囲みが本文の末尾に足されていない',
  ).toContainText('00:00:15,000 --> 00:00:20,000');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
