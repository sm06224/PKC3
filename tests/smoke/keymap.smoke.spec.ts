import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors, useSplitEditor, answerAppDialog } from './helpers';

/**
 * ショートカットキーと、その割り当て直し(#256。user 指示 2026-08-18)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **実ブラウザが配る `code`** ── unit は `code` を**自分で書いて**渡している。
 *    実際の打鍵で同じ名前が来るかは、ここでしか確かめられない
 *    (`Alt+[` は mac で `key` が化ける ── だから `code` に賭けている)。
 * 2. **既定動作を止められているか** ── `Ctrl+S` でブラウザの保存が開かない、
 *    `Ctrl+N` で新しい窓が開かない。`preventDefault` の効き目は DOM に出ない。
 * 3. **捕まえている最中に、アプリへ打鍵が漏れないか** ── capture 段と
 *    バブリング段の順序は happy-dom でも動くが、**実際の listener の並び**は
 *    実機で見るのがいちばん確か。
 * 4. **設定 → 効く鍵**の往復が、器を作り直さずに成立するか。
 */
test('🔴 既定の鍵が実機で効き、設定で割り当て直すと入れ替わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ⚠ 左の列の既定は**フォルダ**(#240 段⑤)── 作ったノートはこちらに出る
  const rows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  const shell = page.locator('[data-pkc-region="shell"]');
  await expect(rows).toHaveCount(0);

  // ① 既定(Alt+N)でノートができる ── **実際の打鍵**で
  await page.keyboard.press('Alt+n');
  await expect(rows, 'Alt+N が実機で効いていない').toHaveCount(1);
  // ⚠ 作ると**編集に入る**ので、確定して `ready` へ戻す ── 戻さないと以降の
  //    「作られない」は**編集中だから断られた**だけになる(1 稿目がそれで偽陽性だった)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.keyboard.press('Alt+n');
  await expect(rows, '2 回目が作られない ── 以降の否定の検査が無意味になる').toHaveCount(2);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔴 D1(依頼 153): 「操作を探す」で「ノートを上へ動かす」── 自分で並べた順で、選んでいる 2 件目が 1 つ上へ
  const lidsNow = () => rows.evaluateAll((trs) => trs.map((t) => t.getAttribute('data-pkc-entry')));
  const order0 = await lidsNow();
  expect(order0.length, '前提が崩れている(2 件)').toBe(2);
  await page.keyboard.press('Control+Shift+P');
  await expect(page.locator('[data-pkc-field="palette-filter"]'), '操作を探すが開かない').toBeFocused();
  await page.keyboard.type('ノートを上へ動かす');
  await expect(
    page.locator('[data-pkc-field="palette-row"][data-pkc-command="move-order-up"]').first(),
    '「ノートを上へ動かす」が操作を探すに出ない',
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
  await expect
    .poll(lidsNow, { message: '選んだノートが 1 つ上へ動いていない' })
    .toEqual([order0[1], order0[0]]);

  // 🔴 #1145: 文字を打っていないときの `?` で、ヘルプが開いてショートカットキーの一覧まで送られる(実座標で画面の中)。
  //     ⚠ 文字を打つ欄(絞り込み欄)の中の `?` は効かない ── 打てなくなるのを防ぐ対照群
  await page.locator('[data-pkc-field="entry-filter"]').focus();
  await page.keyboard.press('Shift+Slash');
  await expect(page.locator('[data-pkc-region="help-keymap"]'), '打鍵中の ? でヘルプが開いた').toBeHidden();
  await expect(page.locator('[data-pkc-field="entry-filter"]')).toHaveValue('?');
  await page.locator('[data-pkc-field="entry-filter"]').fill('');
  await page.locator('[data-pkc-field="entry-filter"]').blur();
  await page.keyboard.press('Shift+Slash');
  await expect(page.locator('[data-pkc-region="help-keymap"]'), '? でヘルプの一覧が開かない').toBeInViewport();
  await page.keyboard.press('Alt+1');

  // ② 面の切替(Alt+3 = 設定)。⚠ **数字キーの `code`(Digit3)**が実機で来るかの検査でもある
  await page.keyboard.press('Alt+3');
  await expect(page.locator('[data-pkc-region="settings-body"]')).toBeVisible();

  // ③ 設定の中に割当の一覧が在り、既定が見えている
  const row = page.locator('[data-pkc-field="keymap-row"][data-pkc-command="toggle-sidebar"]');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-pkc-field="keymap-chord"]')).toHaveCount(2);

  // ④ 🔴 捕まえている最中の打鍵は**アプリに届かない**
  //    (`Alt+N` を割り当てようとしただけでノートが増える、を落とす)
  await clickReal(page, '[data-pkc-field="keymap-assign"][data-pkc-command="edit-entry"]');
  await page.keyboard.press('Alt+n');
  await expect(rows, '割り当てようとしただけでノートができた').toHaveCount(2);
  // ぶつかる相手なので断られる(= 断り文が出る)
  await expect(
    page.locator('[data-pkc-field="keymap-row"][data-pkc-command="edit-entry"]'),
  ).toContainText('ノートを作る');

  // 🔴 D1(依頼 117-3): 本文の計算に Ctrl+Backspace(単語ごとに消す)は割り当てられない
  await clickReal(page, '[data-pkc-field="keymap-assign"][data-pkc-command="inline-calc"]');
  await page.keyboard.press('Control+Backspace');
  await expect(
    page.locator('[data-pkc-field="keymap-row"][data-pkc-command="inline-calc"]'),
    'Ctrl+Backspace の断りの字が出ない',
  ).toContainText('文字を打つ欄の編集に使うキーです');
  await expect(
    page
      .locator('[data-pkc-field="keymap-row"][data-pkc-command="inline-calc"] [data-pkc-field="keymap-chord"]'),
    'Ctrl+Backspace が割り当てられてしまった',
  ).not.toContainText('Backspace');

  // ⑤ 既定を 2 つとも外して、別の鍵を割り当てる
  //    ⚠ 観測点はペインの畳み具合(属性)── **何度でも押せて、状態を持ち越さない**
  for (const chord of ['Alt+BracketLeft', 'Mod+Backslash']) {
    await clickReal(
      page,
      `[data-pkc-field="keymap-drop"][data-pkc-command="toggle-sidebar"][data-pkc-chord="${chord}"]`,
    );
  }
  await clickReal(page, '[data-pkc-field="keymap-assign"][data-pkc-command="toggle-sidebar"]');
  await page.keyboard.press('Alt+g');
  await expect(row.locator('[data-pkc-field="keymap-chord"]')).toHaveCount(1);
  await expect(row).toContainText('Alt + G');

  // 🔴 #1087: 素の Tab は「やめる合図」── 割当は増えず、捕まえる状態が終わる(Esc と同じ)
  const assignBtn = page.locator('[data-pkc-field="keymap-assign"][data-pkc-command="toggle-sidebar"]');
  await clickReal(page, '[data-pkc-field="keymap-assign"][data-pkc-command="toggle-sidebar"]');
  await expect(assignBtn).toHaveAttribute('data-pkc-capturing', '1');
  await page.keyboard.press('Tab');
  await expect(assignBtn, 'Tab で捕まえる状態が終わっていない').not.toHaveAttribute('data-pkc-capturing', '1');
  await expect(row.locator('[data-pkc-field="keymap-chord"]'), 'Tab が割り当てられた').toHaveCount(1);
  await expect(row).not.toContainText('Tab');

  // ⑥ 🔴 入れ替わったことを**効き目**で見る(表示だけ変わって効かない、を落とす)
  await expect(shell).not.toHaveAttribute('data-pkc-hidden-panes', /sidebar/);
  await page.keyboard.press('Alt+BracketLeft');
  await expect(shell, '外した既定がまだ効いている').not.toHaveAttribute(
    'data-pkc-hidden-panes',
    /sidebar/,
  );
  await page.keyboard.press('Alt+g');
  await expect(shell, '割り当てた鍵が効いていない').toHaveAttribute(
    'data-pkc-hidden-panes',
    /sidebar/,
  );
  await page.keyboard.press('Alt+g');
  await expect(shell).not.toHaveAttribute('data-pkc-hidden-panes', /sidebar/);

  // ⑦ ヘルプの一覧も同じ表から出ている(PKC2 はここが手書きでズレた)
  await page.keyboard.press('F1');
  await expect(
    page.locator('[data-pkc-field="help-key-chords"][data-pkc-command="toggle-sidebar"]'),
  ).toHaveText('Alt + G');
  // 🔴 D1(依頼 96-2): キーのある操作だけ並び、「割り当てなし」の行は無く、案内の 1 行が出る
  const chordCells = page.locator('[data-pkc-field="help-key-chords"]');
  expect(await chordCells.count(), '前提が崩れている(一覧が空)').toBeGreaterThan(5);
  expect(
    (await chordCells.allTextContents()).filter((t) => t.trim() === '' || t.includes('割り当てなし')),
    '割り当てなしの行がヘルプに残っている',
  ).toEqual([]);
  await expect(page.locator('[data-pkc-field="help-key-guide"]'), '案内の 1 行が出ない').toContainText(
    'システム → 設定 → ショートカットキー',
  );
  // 🔴 #1145: ヘルプのショートカット一覧が文脈ごとにグループ化され、ジャンプボタンが機能する
  await expect(page.locator('[data-pkc-field="help-key-group"]').first()).toBeVisible();
  await expect(page.locator('[data-pkc-field="help-jump-keys"]')).toBeVisible();
  await clickReal(page, '[data-pkc-field="help-jump-keys"]');
  await expect(page.locator('[data-pkc-field="help-jump-top"]')).toBeVisible();

  // ⑧ すべて既定に戻す → 既定が戻り、割り当てた鍵は効かなくなる
  await page.keyboard.press('Alt+3');
  await clickReal(page, '[data-pkc-field="keymap-reset-all"]');
  // 🔴 #1660: 消える数を見せてから聞く
  expect(await answerAppDialog(page, 'ok')).toMatch(/自分で変えた割り当て \d+ 件を、全部はじめに戻します/);
  await page.keyboard.press('Alt+g');
  await expect(shell, '戻したのに割り当てた鍵が生きている').not.toHaveAttribute(
    'data-pkc-hidden-panes',
    /sidebar/,
  );
  await page.keyboard.press('Alt+BracketLeft');
  await expect(shell, '既定に戻っていない').toHaveAttribute('data-pkc-hidden-panes', /sidebar/);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **ブラウザの既定を止めている**(`preventDefault`)。
 *
 * ⚠ 観測点は「押した event が `defaultPrevented` で戻ってくること」──
 * 保存ダイアログや新しい窓は playwright から見えないので、**アプリが止めた事実**を
 * 直接採る(CLAUDE.md §4「観測点はアプリ自身の信号にする」)。
 */
test('🔴 近道はブラウザの既定を止める(保存ダイアログ / 新しい窓を開かせない)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await page.evaluate(() => {
    const seen: { key: string; prevented: boolean }[] = [];
    (window as unknown as { __keys: typeof seen }).__keys = seen;
    // ⚠ **バブリングの最後**で見る ── アプリの listener より後に来る位置
    window.addEventListener('keydown', (e) => {
      seen.push({ key: e.key, prevented: e.defaultPrevented });
    });
  });

  await page.keyboard.press('Alt+n');
  /**
   * 🔴 #1221: 作った直後は**題名の欄に焦点が在る**(打っている最中)── 打鍵中は
   * `Alt+3` のような近道を受けない(本文を打っているときと同じ規則)。この spec が
   * 見るのは「受けた鍵の既定を止める」ことなので、焦点を外してから押す。
   */
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Alt+3');
  // ⚠ 対照群 ── 誰も割り当てていない鍵は**止めない**(全部止める実装を落とす)
  await page.keyboard.press('Control+Shift+F9');

  const seen = await page.evaluate(
    () => (window as unknown as { __keys: { key: string; prevented: boolean }[] }).__keys,
  );
  const prevented = (k: string) => seen.find((s) => s.key.toLowerCase() === k)?.prevented;
  /**
   * ⚠ 見ているのは「**アプリが既定を止めた**」ことだけである(着地前レビュー 10)。
   * ブラウザが予約している鍵(`Ctrl+N` / `Ctrl+T` / `Ctrl+W`)を実際に奪えるかは
   * **ページからは確かめられない** ── そこは user の実機で見る話で、ここでは
   * 「アプリが受けて止めている」までを主張する(計器の名前を主張より広げない)。
   */
  expect(prevented('n'), 'Alt+N をアプリが受けて止めていない').toBe(true);
  expect(prevented('3'), 'Alt+3 をアプリが受けて止めていない').toBe(true);
  expect(prevented('f9'), '割り当てていない鍵まで止めている').toBe(false);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **帯に出していない記法の鍵**(#425 段②-a)。
 *
 * 🔴 **unit では届かない層**:`Alt+Shift+<字>` の `code`(`KeyH` 等)が
 *   実ブラウザで本当に届くか。⚠ unit は `code` を**自分で書いて**渡している。
 * ⚠ そして **mac では `Alt+字` が記号を打つ** ── 既定を止められているか
 *   (本文に `˙` が混ざらないか)も、ここでしか見えない。
 */
/**
 * 🔴 **一覧を畳んでいても `Ctrl+F` が効く**(#583)。
 *
 * ## unit では原理的に届かない
 *
 * ⚠ happy-dom は版面を組まないので、**`display: none` の欄にも `focus()` が通り**、
 *   `activeElement` になってしまう ── 「**畳んでいると入らない**」は
 *   **実ブラウザでしか見えません**(unit が守れるのは「戻す側」だけ)。
 *
 * ## 直す前に何が起きていたか(実測)
 *
 * | | 焦点はどこへ |
 * |---|---|
 * | 畳む前 | `entry-filter` ✅ |
 * | 🔴 畳んだ後 | **`BODY`**(どこにも入らない) |
 *
 * 🔴 しかも `prevent()` が先なので、**鍵を食ったうえで無反応**だった
 * (ブラウザ既定の検索にも譲れない)。
 */
test('🔴 一覧を畳んでいても Ctrl+F で絞り込みの欄へ入る (#583)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  const filter = page.locator('[data-pkc-field="entry-filter"]');
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-pkc-field') ?? document.activeElement?.tagName ?? null);

  // 対照群 ── 畳む前は効く
  await page.keyboard.press('ControlOrMeta+f');
  expect(await focused(), '畳む前から効いていない(台の空振り)').toBe('entry-filter');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // 🔴 畳んでから押す
  await clickReal(page, '[data-pkc-region="pane-grip"][data-pkc-pane="sidebar"]');
  await expect(filter, '畳めていない(台の空振り)').toBeHidden();
  await page.keyboard.press('ControlOrMeta+f');
  expect(await focused(), '畳んでいると焦点が入らない(鍵を食って無反応)').toBe('entry-filter');
  // 🔑 **見えるようになっている**(見えない欄に焦点だけ入れて終わりにしない)
  await expect(filter, '一覧が畳まれたまま焦点だけ入れている').toBeVisible();

  // 🔴 D1(依頼 185): 字があるとき Esc で字が消え(欄に居る)、字が無いとき Esc で欄から出る
  await filter.fill('あいう');
  await page.keyboard.press('Escape');
  await expect(filter, '字があるときの Esc で字が消えない').toHaveValue('');
  expect(await focused(), '字を消しただけで欄から出た(1 回目の Esc)').toBe('entry-filter');
  await page.keyboard.press('Escape');
  expect(await focused(), '字が無いときの Esc で欄から出ない').not.toBe('entry-filter');

  expect(errors, '例外が出た').toEqual([]);
});

test('🔴 帯に無い記法が、鍵で本文に入る (#425)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  /**
   * ⚠ **既定は 1 面編集**(live)── 全文の欄(`editor-body`)を使うので、
   *   設定で 2 列を明示する(`copy-body.smoke.spec.ts` と同じ作法)。
   * 🔑 命令は `contexts: ['editor', 'row']` を名乗っているので、
   *   ここで見ているのは **`editor` の側**である。
   */
  await useSplitEditor(page);
  await gotoApp(page);

  // 🔴 D1(依頼 180): 戻る先(前のノート)を先に用意する ── 作った 2 件を 1 → 2 と選んで戻れる履歴を作り、
  //    2 件目の本文欄で Alt+← を押す(欄の中では戻らない / 欄の外では戻る、の両方を見る)
  const noteRows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  for (const t of ['一', '二']) {
    await page.keyboard.press('Alt+n');
    const f = page.locator('[data-pkc-field="editor-body"]');
    await expect(f).toBeVisible({ timeout: 15_000 });
    await f.fill(`ノート${t}`);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  await expect(noteRows, '前提が崩れている(2 件)').toHaveCount(2);
  await clickReal(page, noteRows.nth(0));
  await clickReal(page, noteRows.nth(1));
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const body = page.locator('[data-pkc-field="editor-body"]');
  await expect(body, '編集に入っていない').toBeVisible({ timeout: 15_000 });
  await body.fill('あいう');
  await body.focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(body, '本文欄の Alt+← で前のノートへ戻ってしまった(編集が閉じた)').toBeVisible();
  await expect(body).toHaveValue('あいう');
  // 全部選んでから押す(選んだ範囲に効く)
  await body.selectText();
  await page.keyboard.press('Alt+Shift+H');
  await expect(body, 'Alt+Shift+H でハイライトが入らない').toHaveValue('==あいう==');

  // ⚠ **もう一度で外れる**(トグル)── 押しっぱなしで二重に囲まれない
  await body.selectText();
  await page.keyboard.press('Alt+Shift+H');
  await expect(body, 'もう一度押しても外れない').toHaveValue('あいう');

  // 🔑 別の 1 つも通す(表の配線が 1 本だけ生きている、を防ぐ)
  await body.selectText();
  await page.keyboard.press('Alt+Shift+X');
  await expect(body, 'Alt+Shift+X で打ち消しが入らない').toHaveValue('~~あいう~~');

  /**
   * ⚠ **帯には出ていない**こと ── 出したら「横に長くしない」という前提が崩れる。
   * 🔑 空振り防止に、帯そのものは在ることを先に見る。
   */
  const bar = page.locator('[data-pkc-action="format-text"]');
  await expect(bar.first(), '書式の帯が出ていない').toBeVisible();
  await expect(
    page.locator('[data-pkc-action="format-text"][data-pkc-format="highlight"]'),
    'ハイライトが帯に出てしまっている',
  ).toHaveCount(0);

  // 🔴 D1(依頼 180)の対照群: 欄の外(確定した後)の Alt+← は、前のノートへ戻る
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const selectedRow = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry][data-pkc-selected]');
  await expect(selectedRow, '前提が崩れている(確定後に選択が 1 件でない)').toHaveCount(1);
  const selBefore = await selectedRow.getAttribute('data-pkc-entry');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Alt+ArrowLeft');
  await expect
    .poll(() => selectedRow.getAttribute('data-pkc-entry'), { message: '欄の外の Alt+← で前のノートへ戻らない' })
    .not.toBe(selBefore);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
