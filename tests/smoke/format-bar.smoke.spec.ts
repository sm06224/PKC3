import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, useListBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

/**
 * P8 段⑥: **書式パネル**と**追記**を実機で。
 *
 * > user 指摘 2026-08-03「**書式設定系のパネルも必要 / 何もかも足りない /
 * > ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * 🔴 unit(`tests/adapter/format-append.test.ts`)は繋がりを見ている。
 * **ここが見るのは「実際に押せるか」と「並びが揃っているか」** ──
 * user 指摘の中身は寸法の話でもある(「ボタンサイズ揃えはしてください」)。
 * happy-dom には CSS が無いので、揃っているかは実機でしか分からない。
 */
test('🔴 書式パネルが押せて、寸法が揃っていて、プレビューに効く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  const bar = page.locator('[data-pkc-region="format-bar"]');
  await expect(bar).toBeVisible();

  // ① 🔴 **高さが 1 種類**(user 指示「ボタンサイズ揃えはしてください」)。
  // ⚠ 「同じ CSS 規則を当てた」ではなく**実測の高さ**を見る ── 文字数の違う
  // ボタンが 14 個並ぶので、揃っていなければここで露見する
  const heights = await bar.locator('button').evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().height)),
  );
  expect(heights.length).toBeGreaterThan(10);
  expect([...new Set(heights)], `ボタンの高さがばらついている: ${heights.join(',')}`).toHaveLength(1);

  // ② 🔴 パネルが**編集欄の上に接している**(離れていると「何に効くか」が読めない)
  const barBox = (await bar.boundingBox())!;
  const taBox = (await ta.boundingBox())!;
  expect(Math.abs(barBox.y + barBox.height - taBox.y), 'パネルと編集欄が離れている').toBeLessThan(4);

  // ③ 🔴 **選んでから押すと、その範囲に効く**(実マウスで)
  await ta.fill('強調したい');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 2));
  await clickReal(page, '[data-pkc-format="bold"]');
  await expect(ta).toHaveValue('**強調**したい');
  await expect(preview.locator('strong')).toHaveText('強調');

  // ④ 押し直すと外れる(選択は残っているので、そのまま押せる)
  await clickReal(page, '[data-pkc-format="bold"]');
  await expect(ta).toHaveValue('強調したい');

  // ⑤ 雛形も入る(表 = 2 列。⚠ プレビューまで見る ── 記号だけ入って
  // markdown として壊れている、を落とす)
  await ta.fill('');
  await clickReal(page, '[data-pkc-format="table"]');
  await expect(preview.locator('table th')).toHaveCount(2);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑧: **追記型が実際に追記型として動く**。
 *
 * > user 指示 2026-08-03「**追記型は今すぐ実装して、今のままだと、なんの意味もない**」
 *
 * ⚠ 観測点は「本文が増えた」ではなく「**編集画面を開かずに**増えた」── 段⑥ の
 * 実装(編集に入って末尾へ飛ぶ)でも本文は増えるので、そこで止めると作り直しの
 * 意味が test に写らない。
 */
test('🔴 打って押すと、編集画面を開かずに末尾へ足される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'textlog');
  await page.locator('[data-pkc-field="editor-body"]').fill('前の記録');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const box = page.locator('[data-pkc-field="append-input"]');
  await expect(box).toBeVisible();
  await box.fill('1 件目');
  await clickReal(page, '[data-pkc-action="append-entry"]');

  // ① 🔴 **編集画面が開いていない**(ここが段⑥ との違いの本体)
  await expect(page.locator('[data-pkc-field="editor-body"]')).toHaveCount(0);
  // ② 本文に日時の節ごと入った
  const body = page.locator('[data-pkc-field="detail-body"]');
  await expect(body).toContainText('1 件目');
  await expect(body.locator('h2')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // ③ 欄が空になり、続けて打てる
  await expect(box).toHaveValue('');

  // ④ 2 件目(節が 2 つになる ── 上書きしていない)
  await box.fill('2 件目');
  await page.keyboard.press('Control+Enter');
  await expect(body).toContainText('2 件目');
  await expect(body).toContainText('1 件目');
  await expect(body.locator('h2')).toHaveCount(2);

  // ⑤ 🔴 **再読込しても残っている**(disk に着いている)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15000 });
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('2 件目');

  expect(errors).toEqual([]);
});

test('🔴 編集中は追記できず、理由と出口が画面に出る(競合ロック)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'textlog');
  await page.locator('[data-pkc-field="editor-body"]').fill('元');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-action="start-edit"]');
  // 欄ではなくロックの帯が出る ── **押せないだけ**にしない
  await expect(page.locator('[data-pkc-field="append-form"]')).toBeHidden();
  await expect(page.locator('[data-pkc-field="append-lock-reason"]')).toContainText('編集中');
  // ⚠ 失わない出口が在る(帯の中の「保存」── #716 まで「保存して解放」)
  const resolve = page.locator('[data-pkc-field="append-lock"] [data-pkc-action="commit-edit"]');
  await expect(resolve).toBeVisible();
  await clickReal(page, '[data-pkc-field="append-lock"] [data-pkc-action="commit-edit"]');
  // 解けて追記できる
  await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * P8 段⑪: 🔴 **描き直しても本文のスクロールがトップへ戻らない**。
 *
 * > user 指示 2026-08-03「**あとはレンダリングした後にスクロールがトップに戻る
 * > no-op も塞いでね**」
 *
 * 🔴 view の描画は毎回 `region.textContent = ''` から組み直していたので、
 * 本文が変わるたび(追記 / 保存 / トグルの ack)に**読んでいた位置が先頭へ飛んで**
 * いた。長いログでは、追記した先が見えなくなる。
 *
 * ⚠ 観測点は 2 つ:
 *  ① **追記しても位置が動かない**(同じノートを見続けている)
 *  ② **保存して戻っても位置が戻る**(編集の面は別物なので、覚えて戻す)
 * ⚠ 逆に「**別のノートへ移ったら先頭から**」は正しい ── そこも一緒に見る
 * (「常に動かさない」実装だと、次のノートを途中から読まされる)。
 */
test('🔴 追記・保存しても本文のスクロールがトップへ戻らない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 長いログを 2 件(1 件目で位置を見る / 2 件目で「移ったら先頭」を見る)
  const long = Array.from({ length: 80 }, (_, i) => `## 節 ${i}\n\n段落 ${i}。\n`).join('\n');
  await createEntry(page, 'textlog');
  await page.locator('[data-pkc-field="editor-body"]').fill(long);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'textlog');
  await page.locator('[data-pkc-field="editor-body"]').fill('2 件目\n\n' + long);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const detail = page.locator('[data-pkc-region="detail"]');
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  await detail.evaluate((el) => (el.scrollTop = 700));
  const parked = await detail.evaluate((el) => el.scrollTop);
  expect(parked, 'スクロールできていない(観測の前提が崩れている)').toBeGreaterThan(100);

  // ⚠ **同じ実体が残るか**も見る ── scroll だけだと「同じ tick で入れ替える」
  // 実装が素通りする(層が崩れても scroll は clamp されない。変異試験で判明)
  await page.evaluate(() => {
    const b = document.querySelector('[data-pkc-field="detail-body"]');
    b!.firstElementChild!.setAttribute('data-mark', 'V');
  });

  // ① 🔴 追記しても位置が動かない
  await page.locator('[data-pkc-field="append-input"]').fill('追記した行');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('追記した行');
  expect(
    Math.abs((await detail.evaluate((el) => el.scrollTop)) - parked),
    '追記でスクロールがトップへ飛んだ',
  ).toBeLessThan(40);
  expect(
    await page.evaluate(
      () =>
        document
          .querySelector('[data-pkc-field="detail-body"]')!
          .firstElementChild!.getAttribute('data-mark'),
    ),
    '触っていない所まで作り直した(図や画像が焼き直しになる)',
  ).toBe('V');

  // ② 🔴 編集 → 保存で戻っても位置が戻る
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  expect(
    Math.abs((await detail.evaluate((el) => el.scrollTop)) - parked),
    '保存で戻ったらスクロールがトップへ飛んだ',
  ).toBeLessThan(40);

  // ③ ⚠ **別のノートへ移ったら先頭から**(ここは動いて正しい)
  await rows.nth(1).click();
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('2 件目');
  expect(
    await detail.evaluate((el) => el.scrollTop),
    '別のノートを途中から見せている',
  ).toBeLessThan(40);
  await expect(rows).toHaveCount(2);

  // ⚠ 「編集に入ったまま別のノートへ移る」経路は **unit** で見る
  //    (`tests/adapter/detail-scroll.test.ts`)── 実機では編集中に一覧を
  //    押しても切り替わらないので、smoke ではその窓を作れない
  expect(errors).toEqual([]);
});

/**
 * 🔴 **日付を入れる道具**(user 指示 2026-08-23)。
 *
 * > 「**日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
 * > ついてくるツールとか用意されてもいいかも**」
 *
 * 🔴 unit(`tests/adapter/format-append.test.ts`)は繋がりを見ている。
 * **ここが見るのは「実機の `<input type=date/time>` がそのまま使えるか」**である ──
 * 格子を自作せず native を使う判断は、**実ブラウザでしか裏が取れない**
 * (happy-dom の `<input type="date">` は文字列を入れているだけ)。
 */
test('🔴 日付の道具が実機で開き、選んだ日付が本文に入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('- [ ] 見積を送る');
  // ⚠ caret を末尾へ(実 UI と同じ ── 押す前に位置は決まっている)
  await ta.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    t.setSelectionRange(t.value.length, t.value.length);
  });

  await clickReal(page, '[data-pkc-action="insert-date"]');
  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  await expect(dialog, '日付の窓が開かない').toBeVisible();

  /**
   * 🔴 **端末のピッカーをそのまま使っている**ことを、型で確かめる。
   * ⚠ ここが `text` に落ちていたら、地域の書式もキーボード操作も自作になっている。
   */
  await expect(dialog.locator('[data-pkc-field="pick-date"]')).toHaveAttribute('type', 'date');
  await expect(dialog.locator('[data-pkc-field="pick-time"]')).toHaveAttribute('type', 'time');

  // 🔑 近道は**日付欄を埋めるだけ**(閉じない ── そのまま時刻も決められる)
  await clickReal(page, '[data-pkc-shortcut="tomorrow"]');
  await expect(dialog, '近道を押しただけで閉じた').toBeVisible();
  const picked = await dialog.locator('[data-pkc-field="pick-date"]').inputValue();
  expect(picked, '近道で日付が埋まっていない').toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // 時刻も入れる(`fill` は実機の time 入力にも効く)
  await dialog.locator('[data-pkc-field="pick-time"]').fill('14:00');
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect(dialog).toBeHidden();

  // 🔴 本文に入り、記法として読める形になっている
  await expect(ta, '本文に入っていない').toHaveValue(`- [ ] 見積を送る @${picked} 14:00`);

  /**
   * 🔴 **`Ctrl+Z` で戻せる**(user が打った字を捨てさせない)。
   * ⚠ これは**実機でしか通らない主張**である ── `execCommand('insertText')` が
   *   在るのは実ブラウザだけで、unit は必ず fallback を通る(CLAUDE.md §2)。
   */
  await ta.press('ControlOrMeta+z');
  await expect(ta, '入れた日付が Ctrl+Z で戻らない').toHaveValue('- [ ] 見積を送る');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **「図」を押すと 5 種から選べる**(#528 案 B。user 裁定 2026-09-04)。
 *
 * 🔴 unit(`tests/adapter/format-append.test.ts`)は繋がりを見ている。
 * **ここが見るのは実ブラウザでしか通らない 2 つ** ── ① `Enter` が焦点のあるボタンを
 * `click` にする(happy-dom は合成しない)= **鍵だけで選べる** ② `showModal()` が
 * 実際に焦点を奪ったあとでも **caret の位置**に入る(unit は手で再現しているだけ)。
 * ⚠ 先に `Escape` の側を通す ── 「閉じて何も入らない」が通ってから「選ぶと入る」を
 *   見ないと、後者が「何かの理由で常に入る」実装でも緑になる。
 */
test('🔴 「図」を押すと 5 種の一覧が出て、Esc なら入らず、↓ Enter で選んだ雛形が入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('まえ\nうしろ');
  await ta.evaluate((el) => {
    (el as HTMLTextAreaElement).setSelectionRange(3, 3);
  });

  // ① 押すと一覧(5 行)。先頭がフローチャート
  await clickReal(page, '[data-pkc-action="insert-diagram"]');
  const rows = page.locator('[data-pkc-field="pick-diagram"]');
  await expect(rows, '図の一覧が 5 行出ていない').toHaveCount(5);
  await expect(rows.first()).toHaveText('フローチャート');
  await expect(rows.first(), '焦点が先頭の行に無い(鍵だけで選べない)').toBeFocused();

  // ② Esc で閉じて、何も入らない
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
  await expect(ta, 'Esc で閉じたのに何か入った').toHaveValue('まえ\nうしろ');

  // ③ もう一度開き、↓ で 2 行目(クラス図)へ移って Enter ── 鍵だけで選ぶ
  await clickReal(page, '[data-pkc-action="insert-diagram"]');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1), '↓ で焦点が 2 行目へ移らない').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
  // 🔴 caret の位置に、クラス図の雛形が入る。⚠ 後ろに字が続くので `insertBlock` が
  //    閉じの後に**改行を 1 つ足す**(段落の途中に fence が生えると壊れる)── だから
  //    閉じとうしろの間は空行 1 つ。⚠ 1 稿目はここを `\n` 1 つで書いて外していた
  //    (走らせずに書いた regex を node で検算して判明。2026-09-04)
  await expect(ta, 'クラス図の雛形が caret の位置に入っていない').toHaveValue(
    /^まえ\n```mermaid\nclassDiagram\n[\s\S]*```\n\nうしろ$/,
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
