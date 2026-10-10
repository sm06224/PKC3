import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
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

  // ④' 🔴 #950 ① ── 選んでいるあいだだけ、表 / 図 / コードブロック / 数式の説明が
  //     「選んだ範囲を囲みます」になる(2 列の面。live の 1 面は live-editor.smoke が見る)。
  //     ⚠ 字と帯の高さは 1px も動かない
  const wraps = bar.locator('[data-pkc-wraps-selection]');
  const wrapTitles = (): Promise<string[]> => wraps.evaluateAll((els) => els.map((e) => (e as HTMLElement).title));
  await expect(wraps, '帯の「囲む 4 つ」が拾えていない').toHaveCount(4);
  const labelsBefore = await wraps.locator('[data-pkc-field="label"]').allTextContents();
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(1, 3));
  await expect.poll(wrapTitles, '選んだのに説明が切り替わらない').toEqual(Array(4).fill('選んだ範囲を囲みます'));
  const barBoxOn = (await bar.boundingBox())!;
  expect(barBoxOn.height, '選んだら帯の高さが動いた').toBe(barBox.height);
  expect(await wraps.locator('[data-pkc-field="label"]').allTextContents(), '帯の字が変わった').toEqual(labelsBefore);
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(2, 2));
  await expect
    .poll(async () => (await wrapTitles()).some((t) => t === '選んだ範囲を囲みます'), '選びを外しても戻らない')
    .toBe(false);
  expect((await bar.boundingBox())!.height, '戻したあと帯の高さが動いた').toBe(barBox.height);

  // ④'' 🔴 #1215 ── 選んでいるあいだ、編集の帯(`detail-toolbar`)の右端の**常設の枠**に
  //     「選択: N 文字(M 行)」。選びを外すと空(枠は残る)。⚠ 帯の高さは 1px も動かない。
  //     幅が足りないとき(1024)に**折り返して帯が 2 段にならない**ことまで実機で見る(#300)。
  const toolbar = page.locator('[data-pkc-field="detail-toolbar"]');
  const stats = toolbar.locator('[data-pkc-field="selection-stats"]');
  await expect(stats, '枠が帯の中に常設されていない').toHaveCount(1);
  await expect(stats, '選んでいないのに字が出ている').toHaveText('');
  const toolbarH = (await toolbar.boundingBox())!.height;
  await ta.fill('あ\n'.repeat(1200)); // 2,400 字 = 1,200 行(プレビューを描き直すのは 1 回だけ)
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 2400));
    await expect(stats, `${width}: 選んだ範囲の字が出ない`).toHaveText('選択: 2,400 文字(1,200 行)');
    const on = (await stats.boundingBox())!;
    const tb = (await toolbar.boundingBox())!;
    expect(tb.height, `${width}: 字が出たら帯の高さが動いた`).toBe(toolbarH);
    expect(on.y + on.height, `${width}: 枠が帯からはみ出した(折り返した)`).toBeLessThanOrEqual(tb.y + tb.height + 0.5);
    expect(tb.x + tb.width - (on.x + on.width), `${width}: 枠が右端に寄っていない`).toBeLessThan(2);
    // 字は読める大きさと、地と区別できる色(色の規則が実際に当たっている)
    const look = await stats.evaluate((e) => {
      const cs = getComputedStyle(e);
      return { size: parseFloat(cs.fontSize), color: cs.color, bg: getComputedStyle(e.parentElement!).backgroundColor };
    });
    expect(look.size, `${width}: 字が小さすぎる`).toBeGreaterThanOrEqual(11);
    expect(look.color, `${width}: 字の色が地と同じ`).not.toBe(look.bg);
    await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(5, 5));
    await expect(stats, `${width}: 選びを外しても消えない`).toHaveText('');
    const off = (await stats.boundingBox())!;
    const tbOff = (await toolbar.boundingBox())!;
    expect(tbOff.x + tbOff.width - (off.x + off.width), `${width}: 空の枠が右端にいない(出入りで動く)`).toBeLessThan(2);
    expect((await toolbar.boundingBox())!.height, `${width}: 外したら帯の高さが動いた`).toBe(toolbarH);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ④'' の続き 🔴 #1451 ── 同じ枠に、caret が表の行に在るときだけ「Tab で次のセル」。
  //     選んでいれば選択の数が勝ち、表の外では空。⚠ どの場面でも帯の高さは動かない。
  await ta.fill('段落\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(8, 8)); // 表の 1 行目
  await expect(stats, '表の行に caret があるのに案内が出ない').toHaveText('Tab で次のセル');
  expect((await toolbar.boundingBox())!.height, '案内が出たら帯の高さが動いた').toBe(toolbarH);
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(8, 11));
  await expect(stats, '選んでいるのに案内が勝った').toHaveText('選択: 3 文字(1 行)');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(1, 1)); // 「段落」の行
  await expect(stats, '表の外なのに案内が残った').toHaveText('');
  expect((await toolbar.boundingBox())!.height, '案内を外したら帯の高さが動いた').toBe(toolbarH);

  // ④''' 🔴 行の入れ替え(#1213)── 2 列の欄で Alt+↓ / Alt+↑。caret が行に付いていき、
  //     端では動かず、Ctrl+Z で 1 回で戻る(⚠ `insertText` を通っていないと戻らない)
  await ta.fill('あ\nい\nう');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(3, 3));
  await ta.press('Alt+ArrowDown');
  await expect(ta, 'Alt+↓ で行が入れ替わらない').toHaveValue('あ\nう\nい');
  expect(await ta.evaluate((el) => (el as HTMLTextAreaElement).selectionStart), 'caret が行に付いていかない').toBe(5);
  await ta.press('Alt+ArrowDown');
  await expect(ta, '末尾の行で Alt+↓ が動いた').toHaveValue('あ\nう\nい');
  await ta.press('Control+z');
  await expect(ta, 'Ctrl+Z で 1 回で戻らない(取り消しの履歴が切れている)').toHaveValue('あ\nい\nう');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await ta.press('Alt+ArrowUp');
  await expect(ta, '先頭の行で Alt+↑ が動いた').toHaveValue('あ\nい\nう');

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
  await clickReal(page, '[data-pkc-region="filer-table"] [data-pkc-entry]');
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
 *  ① **追記しても先頭へ戻らない**(同じノートを見続けている)
 *  ② **保存して戻っても位置が戻る**(編集の面は別物なので、覚えて戻す)
 * ⚠ 逆に「**別のノートへ移ったら先頭から**」は正しい ── そこも一緒に見る
 * (「常に動かさない」実装だと、次のノートを途中から読まされる)。
 *
 * ## 🔴 ①の主張を書き直した(#782 B。user 裁定 2026-09-07)
 *
 * > 「**追記した見出しや末尾にジャンプ ただし、別窓で開いている場合の
 * > 再レンダリングは固定**」
 *
 * ⚠ ①はもともと `|scrollTop - parked| < 40` = 「**1 px も動かない**」で pin して
 *   いたが、それは題名(「**トップへ戻らない**」)より**強い主張**だった ──
 *   2026-08-03 の指示が塞ぎたかったのは「**先頭へ飛ぶ**」ことである。
 * 🔑 裁定で「足した所へ動く」が正になったので、主張を**目的の側**へ書き直した:
 *   **先頭へ戻っていない**(位置が 0 付近でない)+ **足した所へ動いた**
 *   (`parked` より下)。⚠ 2026-08-03 の指示は**捨てていない** ── 前者が守る。
 * ⚠ ②の基準も `parked` から**追記の後の位置**へ移した(追記で動くようになった
 *   以上、そこが「読んでいた場所」である)。
 */
test('🔴 追記すると足した所へ動き、保存しても先頭へ戻らない', async ({ page }) => {
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
  const rows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await clickReal(page, '[data-pkc-region="filer-table"] [data-pkc-entry]');
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

  // ① 🔴 追記すると足した所へ動く(先頭へは戻らない)
  await page.locator('[data-pkc-field="append-input"]').fill('追記した行');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('追記した行');
  const afterAppend = await detail.evaluate((el) => el.scrollTop);
  // 🔴 2026-08-03 の指示が塞いだもの ── これは裁定が変わっても守り続ける
  expect(afterAppend, '追記でスクロールが先頭へ飛んだ').toBeGreaterThan(100);
  // 🔴 #782 B の裁定 ── 足した字は末尾なので、置いた所より**下**へ動く
  expect(afterAppend, '追記しても足した所へ動いていない').toBeGreaterThan(parked);
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
    Math.abs((await detail.evaluate((el) => el.scrollTop)) - afterAppend),
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
test('🔴 「図」は Esc で入らず ↓ Enter で雛形が入り、「図案」は絵を選ぶと本文で絵になる', async ({ page }) => {
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

  /**
   * ── ④ 同じ帯の「図案」(#853 段①、2026-09-13)。
   *
   * 🔴 **新しく起動しない** ── 既に開いている編集の道中に足す(起動 1 つ = 以後すべての
   *   回に 1.63 秒。CLAUDE.md「増える向きを変える」)。
   * ⚠ 図の雛形は捨てる ── 残すと保存で mermaid の焼きが走り、**この動線と無関係な
   *   時間と揺れ**を抱き込む。
   */
  await ta.fill('きょうは ');
  await ta.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    t.setSelectionRange(t.value.length, t.value.length);
  });

  await clickReal(page, '[data-pkc-action="insert-icon"]');
  const picks = page.locator('[data-pkc-field="pick-body-icon"] button');
  // ⚠ 数を名指しで pin しない(絵は増える)── **「なし」が無いこと**が主張である
  await expect(picks, '絵の表が出ていない').not.toHaveCount(0);
  await expect(
    page.locator('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name=""]'),
    '入れる表に「なし」が出ている(空の字を入れる押し所になる)',
  ).toHaveCount(0);
  await expect(picks.first(), '焦点が先頭の絵に無い(鍵だけで選べない)').toBeFocused();

  // Esc で閉じて、何も入らない ── 先にこちらを通す(後の「入る」が常に真でないこと)
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
  await expect(ta, 'Esc で閉じたのに何か入った').toHaveValue('きょうは ');

  // もう一度開いて、家の絵を押す ── caret の位置に `:home:` が入る
  await clickReal(page, '[data-pkc-action="insert-icon"]');
  await clickReal(page, '[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name="home"]');
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
  await expect(ta, '選んだ絵の字が caret の位置に入っていない').toHaveValue('きょうは :home:');
  // ⚠ **対照群を同じ本文に置く** ── 表に無い語は字のまま出ること(次の assert と対で読む)
  await page.keyboard.type(' と :smile:');

  /**
   * ── ⑤ 保存すると、閲覧の面でその場所が**絵になる**。
   *
   * 🔴 ここが実ブラウザでしか通らない所である ── 絵を出すのは CSS の `::before` なので、
   *   unit(happy-dom)では「器が在る」までしか言えない。
   */
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const body = page.locator('[data-pkc-field="detail-body"]');
  const glyph = body.locator('[data-pkc-symbol="home"]');
  await expect(glyph, '本文の図案が出ていない').toHaveCount(1);
  await expect(glyph, '読み上げの名前が無い(本文の図案は中身そのもの)').toHaveAttribute(
    'aria-label',
    '家',
  );
  await expect(body, '打った字がそのまま残っている(絵になっていない)').not.toContainText(':home:');
  // 🔴 対照群 ── 表に無い語は**字のまま**(何でも絵にする実装なら、ここで落ちる)
  await expect(body, '表に無い語まで絵にした').toContainText(':smile:');

  /**
   * 🔴 **周りの字に載っている**(`.pkc-md-rendered [data-pkc-icon]` の主張)。
   * ⚠ 器の既定は **16px 固定**(帯のボタン向けの値)なので、その規則を外すと比が 1.0 になる
   *   ── つまりこの 1 行が、規則を消す変異を殺す。
   */
  const ratio = await glyph.evaluate((el) => {
    const host = el.closest('p') ?? el.parentElement!;
    return parseFloat(getComputedStyle(el).fontSize) / parseFloat(getComputedStyle(host).fontSize);
  });
  expect(ratio, `図案が周りの字に載っていない(比 ${String(ratio)})`).toBeCloseTo(1.15, 2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
