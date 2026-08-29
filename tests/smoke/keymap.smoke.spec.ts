import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors, useSplitEditor } from './helpers';

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

  // ① 既定(Ctrl+N)でノートができる ── **実際の打鍵**で
  await page.keyboard.press('Control+n');
  await expect(rows, 'Ctrl+N が実機で効いていない').toHaveCount(1);
  // ⚠ 作ると**編集に入る**ので、確定して `ready` へ戻す ── 戻さないと以降の
  //    「作られない」は**編集中だから断られた**だけになる(1 稿目がそれで偽陽性だった)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.keyboard.press('Control+n');
  await expect(rows, '2 回目が作られない ── 以降の否定の検査が無意味になる').toHaveCount(2);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ② 面の切替(Alt+3 = 設定)。⚠ **数字キーの `code`(Digit3)**が実機で来るかの検査でもある
  await page.keyboard.press('Alt+3');
  await expect(page.locator('[data-pkc-region="settings-body"]')).toBeVisible();

  // ③ 設定の中に割当の一覧が在り、既定が見えている
  const row = page.locator('[data-pkc-field="keymap-row"][data-pkc-command="toggle-sidebar"]');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-pkc-field="keymap-chord"]')).toHaveCount(2);

  // ④ 🔴 捕まえている最中の打鍵は**アプリに届かない**
  //    (`Ctrl+N` を割り当てようとしただけでノートが増える、を落とす)
  await clickReal(page, '[data-pkc-field="keymap-assign"][data-pkc-command="edit-entry"]');
  await page.keyboard.press('Control+n');
  await expect(rows, '割り当てようとしただけでノートができた').toHaveCount(2);
  // ぶつかる相手なので断られる(= 断り文が出る)
  await expect(
    page.locator('[data-pkc-field="keymap-row"][data-pkc-command="edit-entry"]'),
  ).toContainText('ノートを作る');

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

  // ⑧ すべて既定に戻す → 既定が戻り、割り当てた鍵は効かなくなる
  await page.keyboard.press('Alt+3');
  await clickReal(page, '[data-pkc-field="keymap-reset-all"]');
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

  await page.keyboard.press('Control+n');
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
  expect(prevented('n'), 'Ctrl+N をアプリが受けて止めていない').toBe(true);
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

  await page.keyboard.press('Control+n');
  const body = page.locator('[data-pkc-field="editor-body"]');
  await expect(body, '編集に入っていない').toBeVisible({ timeout: 15_000 });
  await body.fill('あいう');
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

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
