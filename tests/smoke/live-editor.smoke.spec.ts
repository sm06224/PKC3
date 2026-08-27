import { test, expect, type Page } from '@playwright/test';
import { clickReal, modClickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **1 面のライブエディタ**(2026-08-05。ライブエディタ S5。
 * 設計 doc `docs/development/live-editor-design-2026-08.md`)。
 *
 * > user 指示「typora風の日本語対応の確定行の即時レンダリング差分反映を実装してください /
 * > コレがストレージと2本柱となるPKC3の最大改良点にしたい」
 *
 * 🔴 **unit(happy-dom)では届かない層が 2 つある**。ここはその 2 つだけを見る:
 *  ① **座標 → caret**(`caretPositionFromPoint`)── happy-dom に無い。
 *     行の途中をクリックしたとき、原文の**その位置**に caret が入るか
 *  ② **本物の日本語入力**(CDP の IME)── `compositionstart/end` を手で
 *     dispatch しても、確定の `input` が `isComposing === true` で来ることや
 *     `compositionend` の後に `input` が来ないことは**再現できない**
 *
 * 🔴 **既定が live になった**(#104 第 2 弾、user 裁定 2026-08-08「既定でON」)
 * ── この file は**素で開く**。⚠ 旧い `?pkc-flag=editor.live` を残してはいけない:
 * flag は退役して**未知名は黙殺**されるので、綴りを残すと「flag で開けている」
 * ように見えて実は**新既定に救われているだけ**の空振りになる(§1 の型)。
 */

async function gotoLive(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
}

/**
 * 編集に入って、本文を 1 面のライブエディタで書き込む。
 *
 * 🔑 **user と同じ手順**で入れる ── 空のノートは描画が空なので押す所が無い。
 * 本文の下の余白を押すと末尾に行が開く(それが空のノートの入口である)。
 * ⚠ test 用の裏口(`window.__setBody` の類)は置かない ── 入口自体が
 * 検査対象だからである。
 */
async function openLive(page: Page, body: string): Promise<void> {
  await createEntry(page, 'text');
  // ⚠ 作った直後は 2 列ではなく 1 面が出ている(**既定が live** ── #104 第 2 弾)
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row, '空のノートで行が開かない(1 文字も打てない)').toBeVisible();
  await row.fill(body.replace(/\n$/, ''));
  await page.keyboard.press('Tab');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);
  await expect(live.locator('h1')).toBeVisible({ timeout: 8000 });
}

test('🔴 1 面で、クリックした行だけが原文になる(周りは描画のまま)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n最初の段落です。\n\n次の段落です。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  // ① 2 列の原文欄は出ていない(1 面に畳んだ)
  await expect(page.locator('[data-pkc-region="editor-split"]')).toHaveCount(0);
  await expect(page.locator('[data-pkc-field="editor-body"]')).toHaveCount(0);

  // ② 段落をクリックすると、その塊だけが原文の入力欄になる
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toHaveValue('最初の段落です。');
  // 周りは描画のまま
  await expect(live.locator('h1')).toHaveText('題');
  await expect(live.locator('p')).toContainText(['次の段落です。']);

  // ③ 書き換えて確定すると、その行だけが描画に戻る
  await row.fill('書き換えました。');
  await page.keyboard.press('Tab');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);
  await expect(live).toContainText('書き換えました。');
  await expect(live).toContainText('次の段落です。');
  await expect(live.locator('h1')).toHaveText('題');
  expect(errors).toEqual([]);
});

test('🔴 ① 行の途中をクリックすると、原文の**その位置**に caret が入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  // 装飾を含む行 ── 描画の文字位置と原文の文字位置がずれる(そこが本題)
  await openLive(page, '# 題\n\nあいうえお**かきくけこ**さしすせそ\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  const p = live.locator('p').first();
  const box = (await p.boundingBox())!;
  /**
   * 行の**右寄り**(「さしすせそ」の辺り)を突く。
   * ⚠ 開くのは **Ctrl(⌘)+クリック**(#495)── `mouse.click` は `modifiers` を
   *   受け取らないので、キーを自分で押す(下の Shift の注記と同じ理由)。
   */
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
  await page.keyboard.up('ControlOrMeta');

  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toHaveValue('あいうえお**かきくけこ**さしすせそ');
  const caret = await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);

  /**
   * 🔴 観測点は「**行の先頭に落ちていない**」+「**飛び越していない**」。
   *
   * 誤差の向きは 2 ポインタで**後ろに固定**されている(設計 §5.5)ので、
   * 上限だけでなく**下限も置く**(CLAUDE.md「tripwire は上限だけでなく下限も」)
   * ── `return 0` にする実装は「行頭に落ちる」ので下限で捕まる。
   */
  expect(caret, 'caret が行頭に落ちている(座標 → 位置が効いていない)').toBeGreaterThan(10);
  expect(caret, 'caret が原文の長さを超えている').toBeLessThanOrEqual(
    'あいうえお**かきくけこ**さしすせそ'.length,
  );
  // 装飾記号を数えない実装(= 描画の文字位置をそのまま使う)は 15 前後で止まる。
  // 原文では「さ」は 15 + 4(`**` × 2)= 19 文字目以降に在る
  expect(caret, '装飾記号ぶんを数えていない(描画の位置をそのまま使っている)').toBeGreaterThan(15);
  expect(errors).toEqual([]);
});

test('🔴 ② 本物の日本語入力で確定できる(1 回だけ・文字が落ちない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\nもとの段落。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeFocused();
  await row.fill('');

  // 起きた出来事を数える(契約が実機で成り立っているかを見る)
  await page.evaluate(() => {
    const ta = document.querySelector('[data-pkc-field="row-source"]')!;
    const log: string[] = [];
    (window as unknown as { __ime: string[] }).__ime = log;
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
      ta.addEventListener(type, () => log.push(type));
    }
    ta.addEventListener('input', (e) => {
      log.push(`input:${(e as InputEvent).inputType}:${(e as InputEvent).isComposing}`);
    });
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: 'にほんご',
    selectionStart: 4,
    selectionEnd: 4,
  });
  await cdp.send('Input.insertText', { text: '日本語' });

  const ime = await page.evaluate(() => (window as unknown as { __ime: string[] }).__ime);
  // 前提: **本当に変換が起きた**(ここが空なら以降は何も見ていない)
  expect(ime, `IME が動いていない(${JSON.stringify(ime)})`).toContain('compositionstart');
  await expect(row).toHaveValue('日本語');

  // 🔴 確定して抜ける ── 変換した文字が本文に入る(落ちない)
  await page.keyboard.press('Tab');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);
  await expect(live.locator('p').first()).toHaveText('日本語');

  // 🔴 保存して閲覧に戻っても同じ(state に届いている = 画面だけの嘘ではない)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('日本語');
  await expect(page.locator('[data-pkc-field="detail-body"]')).not.toContainText('もとの段落');
  expect(errors).toEqual([]);
});

test('🔴 打鍵ではレンダリングが 1 回も走らない(確定のときだけ描く)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\nもとの段落。\n\nもう 1 つ。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeFocused();
  // ⚠ caret は**クリックした所**に入る(= 塊の中央 → 行末)。打った文字が
  //    どこに入るかは別の test の主題なので、ここでは空にしてから打つ
  await row.fill('');

  // 見出しの要素に印を付ける ── 描き直されたら消える
  await page.evaluate(() => {
    const h = document.querySelector('[data-pkc-region="editor-live"] h1')!;
    (h as HTMLElement & { __mark?: string }).__mark = 'same';
  });

  // 1 文字ずつ実際に打つ(20 打鍵)
  await page.keyboard.type('あいうえおかきくけこさしすせそたちつてと', { delay: 5 });
  // ⚠ 静穏(500ms)を**跨いで**待つ ── ここで描いてしまう実装を落とす
  await page.waitForTimeout(1200);

  // 🔴 打っている間、原文はまだ入力欄の中(描画になっていない)
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(1);
  const stillSame = await page.evaluate(
    () =>
      (
        document.querySelector('[data-pkc-region="editor-live"] h1') as
          | (HTMLElement & { __mark?: string })
          | null
      )?.__mark ?? null,
  );
  expect(stillSame, '打鍵の途中で描き直している(1 面が丸ごと作り直された)').toBe('same');

  // 確定したら**そのときだけ**描く
  await page.keyboard.press('Tab');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);
  await expect(live.locator('p').first()).toHaveText('あいうえおかきくけこさしすせそたちつてと');
  // 触っていない見出しは同じ実体のまま(塊ごとのパッチが効いている)
  const afterCommit = await page.evaluate(
    () =>
      (
        document.querySelector('[data-pkc-region="editor-live"] h1') as
          | (HTMLElement & { __mark?: string })
          | null
      )?.__mark ?? null,
  );
  expect(afterCommit, '確定で触っていない塊まで作り直した').toBe('same');
  expect(errors).toEqual([]);
});

test('🔴 表の 1 行だけを差し替えられる(表ごとにならない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n| 品 | 数 |\n|---|---|\n| りんご | 1 |\n| みかん | 2 |\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live.locator('tbody tr')).toHaveCount(2);
  await modClickReal(page, '[data-pkc-region="editor-live"] tbody tr:nth-of-type(2)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toHaveValue('| みかん | 2 |');

  await row.fill('| ぶどう | 3 |');
  await page.keyboard.press('Tab');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);
  await expect(live.locator('tbody tr')).toHaveCount(2);
  await expect(live.locator('tbody tr').nth(0)).toContainText('りんご');
  await expect(live.locator('tbody tr').nth(1)).toContainText('ぶどう');
  expect(errors).toEqual([]);
});

test('🔴 行頭で ``` を打ち切ると閉じが入る + それが Ctrl+Z で戻る(S5c)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\nもとの段落。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeFocused();
  await row.fill('');

  // ① 🔴 3 打鍵で**閉じが次の行に**入る(開放終端をそもそも作らせない)
  await page.keyboard.type('```');
  await expect(row).toHaveValue('```\n```');
  // caret は言語を打てる位置 = 開き記号の直後
  expect(await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(3);
  await page.keyboard.type('js');
  await expect(row).toHaveValue('```js\n```');
  // 閉じ待ちの印は付かない
  await expect(live.locator('[data-pkc-row-slot]')).not.toHaveAttribute('data-pkc-open-end', 'fence');

  /**
   * ② 🔴 **補った閉じが Ctrl+Z で戻る**。実機でしか分からない ──
   * `execCommand('insertText')` で挿さないと**取り消せない飾り**になる
   * (`value` 直代入は undo スタックに載らない)。
   */
  await page.keyboard.press('Control+z'); // 'js' を戻す
  await page.keyboard.press('Control+z'); // 補った '`\n```' を戻す
  const afterUndo = await row.inputValue();
  expect(afterUndo, `補完が undo に載っていない(いま "${afterUndo}")`).not.toBe('```js\n```');
  expect(afterUndo.length, '取り消しで縮んでいない').toBeLessThan('```js\n```'.length);
  expect(errors).toEqual([]);
});

test('🔴 閉じていない ``` は色が変わり、確定すると理由が出る(user 提案)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\nもとの段落。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeFocused();
  // ⚠ **貼り付け相当**(`fill`)で入れる ── 打鍵だと auto pair が閉じてしまうので、
  //    「閉じていない状態」は貼り付け・取り込み経由でしか作れない
  await row.fill('```js');

  // ① 開放終端の印が付く(色が変わる = 左端の帯が出る)
  const slot = live.locator('[data-pkc-row-slot]');
  await expect(slot).toHaveAttribute('data-pkc-open-end', 'fence');
  const border = await slot.evaluate((el) => getComputedStyle(el).borderLeftWidth);
  expect(border, '色変えの帯が出ていない(CSS が届いていない)').not.toBe('0px');

  // ② 閉じたら印が消える
  await row.fill('```js\nconst a = 1;\n```');
  await expect(slot).not.toHaveAttribute('data-pkc-open-end', 'fence');

  // ③ 閉じないまま確定したら、確定はするが理由が出る
  await row.fill('```js');
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-pkc-field="row-note"]')).toContainText('閉じていない');
  expect(errors).toEqual([]);
});

test('🔴 塊を跨ぐ Ctrl+Z が実機で効く(行の中は OS の取り消しに任せる)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n最初の段落。\n\n次の段落。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  const row = live.locator('[data-pkc-field="row-source"]');

  // ① 1 か所目を書き換えて確定
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  await row.fill('1 回目。');
  await page.keyboard.press('Tab');
  await expect(live).toContainText('1 回目。');

  // ② 2 か所目を書き換えて確定(= 塊を跨いだ)
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(2)');
  await row.fill('2 回目。');
  await page.keyboard.press('Tab');
  await expect(live).toContainText('2 回目。');
  await expect(row).toHaveCount(0);

  /**
   * 🔴 **行の外で Ctrl+Z**。実機でしか確かめられないのは「焦点がどこに在るか」
   * ── 確定で入力欄が消えた後、焦点は `<body>` に戻っている(その状態で
   * 履歴の取り消しが効く、というのがこの段の契約)。
   */
  await page.keyboard.press('Control+z');
  await expect(live).toContainText('次の段落。');
  await expect(live).toContainText('1 回目。');
  await page.keyboard.press('Control+z');
  await expect(live).toContainText('最初の段落。');
  await expect(page.locator('[data-pkc-field="row-note"]')).toContainText('取り消しました');

  // ③ 保存して閲覧に戻っても、取り消した後の本文になっている(画面だけの嘘ではない)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const shown = page.locator('[data-pkc-field="detail-body"]');
  await expect(shown).toContainText('最初の段落。');
  await expect(shown).not.toContainText('1 回目。');
  expect(errors).toEqual([]);
});

test('🔴 行の中の Ctrl+Z は打鍵単位で戻る(履歴の取り消しが割り込まない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\nもとの段落。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeFocused();
  await row.fill('');
  await page.keyboard.type('あいうえお');
  await expect(row).toHaveValue('あいうえお');

  // 🔴 入力欄の中なので、ブラウザ自前の取り消しが働く(= 入力欄が消えたりしない)
  await page.keyboard.press('Control+z');
  await expect(row, '行の中の Ctrl+Z で入力欄が閉じた(履歴の取り消しが奪っている)').toHaveCount(1);
  await expect(row).not.toHaveValue('あいうえお');
  expect(errors).toEqual([]);
});

test('🔴 Ctrl+A で全文が 1 つの入力欄になる(S6。今日の編集画面の縮退形)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n最初の段落。\n\n次の段落。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live.locator('p')).toHaveCount(2);

  // 🔴 行の外で Ctrl+A(確定の直後は焦点が body に戻っている)
  await page.keyboard.press('Control+a');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toHaveValue('# 題\n\n最初の段落。\n\n次の段落。');
  // 描画の塊は 1 つも残っていない(2 つの画面が同居しない)
  await expect(live.locator('p')).toHaveCount(0);
  await expect(live.locator('h1')).toHaveCount(0);

  // 丸ごと書き換えて確定 ── 今日の編集画面と同じことができる
  await row.fill('# 作り直した\n\n本文も入れ替えた。');
  await page.keyboard.press('Tab');
  await expect(live.locator('h1')).toHaveText('作り直した');
  await expect(live).toContainText('本文も入れ替えた。');
  await expect(live).not.toContainText('最初の段落。');

  // 保存して閲覧に戻っても同じ
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('本文も入れ替えた。');
  expect(errors).toEqual([]);
});

test('🔴 Shift+クリックで 2 つの塊を 1 つの入力欄にできる(S6)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n1 つめ。\n\n2 つめ。\n\n3 つめ。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toHaveValue('1 つめ。');

  /**
   * Shift+クリックで 2 つめまで広げる。
   * ⚠ **`mouse.click` は `modifiers` を受け取らない**(`locator.click` の option)
   * ── 渡しても黙って無視され、ただの単独クリックになる。キーを自分で押す。
   * ⚠ 塊が入力欄に化けているので `nth()` の番号がずれる ── **文字で探す**。
   */
  const target = live.getByText('2 つめ。', { exact: true });
  const box = (await target.boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.up('Shift');
  await expect(row).toHaveValue('1 つめ。\n\n2 つめ。');

  // まとめて書き換えて確定 ── その範囲だけが変わる
  await row.fill('まとめた。');
  await page.keyboard.press('Tab');
  await expect(live).toContainText('まとめた。');
  await expect(live).toContainText('3 つめ。');
  await expect(live).not.toContainText('1 つめ。');
  expect(errors).toEqual([]);
});

/**
 * 🔴 **塊を跨いでドラッグ選択しても、版面が飛ばない**(2026-08-06。user 報告
 * 「編集しようとして選択すると勝手にスクロールしてフォーカスが外れる /
 * スクロールが発生するくらい長くて複雑なものだけです」)。
 *
 * `click` の target は **mousedown と mouseup の共通祖先**なので、塊を跨ぐ選択では
 * target が pane 自身になる。直す前は余白判定が `target === this.host` だったので
 * ここが真になり、`appendRow()` が**文末**に空の入力欄を開き `focus()` が版面を
 * 文末まで引っぱっていた。実測(60 節): `scrollTop` 1214 → **2457(+1243px)**、
 * 開いた入力欄は**空**、**選択が消滅**、焦点がその空欄へ。
 *
 * ⚠ **短い本文では 1px も動かない**(文末が画面内に在るから)── だから既存の
 *   11 本は全部緑のまま出荷された。この spec は**長い本文を要求する**。
 * ⚠ `clickReal` を使わない ── あれは毎回 `scrollIntoViewIfNeeded()` を撃つので
 *   「勝手にスクロールした」が観測できなくなる。
 */
test('🔴 塊を跨ぐドラッグ選択で、版面が文末へ飛ばない(長い本文)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await gotoLive(page);
  const long = ['# 長い文書', ''];
  for (let i = 1; i <= 30; i++) {
    long.push(`## 節 ${i}`, '', `これは節 ${i} の段落です。${'あ'.repeat(50)}`, '');
    long.push(`節 ${i} の 2 つめの段落です。${'い'.repeat(50)}`, '');
  }
  await openLive(page, long.join('\n'));

  const live = page.locator('[data-pkc-region="editor-live"]');
  // ⚠ **空振り防止** ── スクロールが実際に発生していること(発生しなければ何も測れない)
  const geom = await live.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(geom.sh, 'スクロールが発生していない(この fixture では事故が起きない)').toBeGreaterThan(
    geom.ch + 600,
  );
  await live.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
  });
  const before = await page.evaluate(() => {
    const el = document.querySelector('[data-pkc-region="editor-live"]') as HTMLElement;
    const ps = [...el.querySelectorAll('p')].filter((p) => {
      const r = p.getBoundingClientRect();
      return r.top > 150 && r.bottom < window.innerHeight - 150;
    });
    /**
     * 🔴 **狙うのは「箱の真ん中」ではなく「1 行目の真ん中」**(2026-08-08)。
     *
     * 箱の高さの半分は、**折り返した段落では行と行の境目**に当たる ── そこから
     * 押し下げると chromium は選択を 1 文字も作らない。⚠ これは**アプリの不具合では
     * ない**:PKC を一切通さない素の HTML(段落 2 つ・`max-width:672px`)で
     * 対照群を取ったところ**同じ 0 文字**で、`y` を **1px** ずらすと 73 文字選べた。
     * つまり `height/2` は「段落が 1 行である」を暗黙に前提した座標であり、
     * 読み幅(紙面フォーマット)が入って 2 行になった瞬間に**アプリと無関係に**落ちる。
     * 🔑 **行の矩形から取れば折返し数に依らない**(`Range.getClientRects()[0]`)。
     */
    const firstLine = (p: HTMLElement): DOMRect => {
      const r = document.createRange();
      r.selectNodeContents(p);
      return r.getClientRects()[0] ?? p.getBoundingClientRect();
    };
    const a = firstLine(ps[0]!);
    const b = firstLine(ps[1]!);
    const ax = a.x + 40;
    const ay = a.y + a.height / 2;
    const bx = b.x + 80;
    const by = b.y + b.height / 2;
    return {
      scrollTop: el.scrollTop,
      ax,
      ay,
      bx,
      by,
      // ⚠ **空振り防止** ── 2 つの点が**狙った別々の塊**に当たっていること
      //   (外れていれば「跨ぐドラッグ」が 1 度も起きず、事故も起きない)
      onTarget:
        document.elementFromPoint(ax, ay)?.closest('p') === ps[0] &&
        document.elementFromPoint(bx, by)?.closest('p') === ps[1],
    };
  });
  expect(before.onTarget, '狙った点が段落に当たっていない(塊を跨いでいない)').toBe(true);
  // ⚠ 器の真ん中に居ること(端だと clamp されて動けない = 測っていない)
  expect(before.scrollTop, 'スクロール位置が 0(focus は 1px も動かせない)').toBeGreaterThan(100);

  // 🔴 塊 A の途中から塊 B の途中へ**ドラッグ選択**する
  await page.mouse.move(before.ax, before.ay);
  await page.mouse.down();
  await page.mouse.move(before.bx, before.by, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);

  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-pkc-region="editor-live"]') as HTMLElement;
    return {
      scrollTop: el.scrollTop,
      rows: el.querySelectorAll('[data-pkc-field="row-source"]').length,
      selection: (window.getSelection()?.toString() ?? '').length,
    };
  });
  expect(after.scrollTop, '版面が動いた(文末へ飛んでいる)').toBe(before.scrollTop);
  expect(after.rows, '選択したのに入力欄が開いた(文末の空行)').toBe(0);
  expect(after.selection, '選択が消えた').toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

/**
 * 🔴 **カーソルキーで隣の塊へ**(2026-08-08。user 裁定「カーソルキーで下に行く」)。
 *
 * unit(happy-dom)では届かない層: 実ブラウザの textarea は ↓ の**既定動作**で
 * caret を動かす ── `preventDefault` の掛け漏れ・掛けすぎは実機でしか見えない
 * (行の途中の ↓ を奪うと、複数行の入力欄の中を移動できなくなる)。
 */
test('🔴 Alt+↓ で次の塊が開き、素の ↓ は箱の中の移動のまま', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n最初の段落です。\n\n次の段落です。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toHaveValue('最初の段落です。');

  /**
   * 🔴 **素の ↓ で飛ばない**(2026-08-15、user 報告の暴発)。
   * ⚠ 1 行の塊は「改行が無い側」に必ず居るので、**旧実装ではここで飛んでいた**。
   */
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await expect(row, '素の ↓ で隣の塊へ飛んだ').toHaveValue('最初の段落です。');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await expect(row, '素の ↑ で隣の塊へ飛んだ').toHaveValue('最初の段落です。');

  // Alt+↓ で確定し、次の塊が開く(caret 先頭)
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(row, '次の塊が開いていない').toHaveValue('次の段落です。');
  expect(
    await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    'caret が先頭に無い',
  ).toBe(0);

  // Alt+↑ で前の塊に戻る(caret 末尾)
  await page.keyboard.press('Alt+ArrowUp');
  await expect(row).toHaveValue('最初の段落です。');
  expect(
    await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    'caret が末尾に無い',
  ).toBe('最初の段落です。'.length);

  // 複数行にして先頭に caret ── 素の ↓ は**箱の中の移動**のまま(奪っていない)
  await row.fill('1 行目です。\n2 行目です。');
  await row.evaluate((el) => {
    (el as HTMLTextAreaElement).setSelectionRange(0, 0);
  });
  await page.keyboard.press('ArrowDown');
  await expect(row, '素の ↓ で確定してしまった(箱の中を移動できない)').toHaveValue(
    '1 行目です。\n2 行目です。',
  );
  const caret = await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  expect(caret, '↓ の既定動作(次の行へ)が死んでいる').toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

/**
 * 🔴 **長い 1 段落を開いたら、折り返した高さの箱になる**(2026-08-15、user 報告
 * 「1 行の選択をすると表示が適切なサイズのテキストブロックにならないため編集しにくい」)。
 *
 * ⚠ **unit では原理的に届かない** ── happy-dom は版面を持たないので折り返しが
 * 起きない(unit 側は値を差して分岐を走らせるだけ)。ここが**折り返しを本当に
 * 起こせる唯一の場所**である。
 * 🔑 観測点は `rows` ではなく **「先頭が見えていること」**(`scrollTop === 0` かつ
 * 溢れていない)── user が困ったのは箱が文の**途中から**始まって見えたことだった。
 */
test('🔴 長い 1 段落は折り返したぶんだけ箱が伸びる(先頭が隠れない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 900, height: 900 });
  await gotoLive(page);
  const long = `あ${'長い段落の本文です。'.repeat(30)}ん`; // 改行を 1 つも持たない
  await openLive(page, `# 題\n\n${long}\n`);

  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = page.locator('[data-pkc-region="editor-live"] [data-pkc-field="row-source"]');
  await expect(row).toHaveValue(long);

  const m = await row.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    return {
      rows: ta.rows,
      clientHeight: ta.clientHeight,
      scrollHeight: ta.scrollHeight,
      scrollTop: ta.scrollTop,
      lineHeight: Number.parseFloat(getComputedStyle(ta).lineHeight),
    };
  });
  // 前提: この幅で本当に折り返している(折り返していなければ以下は空振りになる)
  expect(m.clientHeight, '折り返していない ── 本文が短すぎて何も測っていない').toBeGreaterThan(
    m.lineHeight * 2,
  );
  expect(m.rows, '改行の数(=1)のままになっている').toBeGreaterThan(1);
  expect(m.scrollHeight, '箱の中に押し込まれている(溢れている)').toBeLessThanOrEqual(
    m.clientHeight + 1,
  );
  expect(m.scrollTop, '先頭が隠れている(文の途中から見えている)').toBe(0);
  expect(errors).toEqual([]);
});

/**
 * 🔴 **生になった行の幅は、置き換えた塊の幅に揃う**(2026-08-08。紙面フォーマット
 * #102 段 1 のレビューで空いた穴)。
 *
 * 読み幅は**散文だけ**に掛かる allow-list なので、スロット(`[data-pkc-row-slot]`)を
 * 一律に散文の幅へ入れると**表・コードを押した瞬間に編集欄が縮む**。実測(1600px):
 * 表は 1036px で描かれているのに編集欄が 672px になり、106 字の原文が 2 行に
 * 折り返していた。逆に一律で外すと、段落を押した行だけ全幅へ跳ねる。
 *
 * ⚠ **unit では届かない。** 判定は `getComputedStyle(el).maxWidth`(= CSS の
 *   allow-list の結果)を読むので、CSS を持たない happy-dom では常に「上限なし」に
 *   なる ── ここが唯一の門である。
 */
test('🔴 表・コードの行を押しても編集欄が縮まない(段落は散文の幅のまま)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoLive(page);
  const WIDE =
    '| ' + Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 列の見出しがここ`).join(' | ') + ' |';
  // ⚠ `openLive` は描画の完了を `h1` で待つ ── 見出しの無い本文では止まる
  await openLive(
    page,
    `# 題\n\nふつうの段落です。\n\n${WIDE}\n${'|---'.repeat(7)}|\n${WIDE}\n\n\`\`\`\nconst x = 1;\n\`\`\`\n`,
  );

  const live = page.locator('[data-pkc-region="editor-live"]');
  const w = async (sel: string): Promise<number> =>
    Math.round((await live.locator(sel).first().boundingBox())!.width);
  const box = async (): Promise<number> => w('[data-pkc-field="row-source"]');

  const proseW = await w('p');
  const tableW = await w('table');
  const codeW = await w('pre');
  // ⚠ **空振り防止** ── 散文と表で幅が違うこと(同じなら以下は何も判定していない)
  expect(tableW, '表が散文より広くない(この窓では違いが出ない)').toBeGreaterThan(proseW + 100);

  // 表を押す → 編集欄は表の幅(縮まない)
  await live.locator('table td, table th').first().click({ modifiers: ['ControlOrMeta'] });
  await expect(live.locator('[data-pkc-field="row-source"]')).toBeVisible();
  expect(await box(), '表の編集欄が散文の幅へ縮んだ').toBeGreaterThan(proseW + 100);

  // コード fence も同じ
  await page.keyboard.press('Escape');
  await live.locator('pre').first().click({ modifiers: ['ControlOrMeta'] });
  await expect(live.locator('[data-pkc-field="row-source"]')).toBeVisible();
  expect(await box(), 'コードの編集欄が散文の幅へ縮んだ').toBeGreaterThan(proseW + 100);
  expect(codeW, 'コードが散文より広くない').toBeGreaterThan(proseW + 100);

  // 段落は散文の幅のまま(= 押した行だけ全幅へ跳ねない)
  await page.keyboard.press('Escape');
  await live.locator('p').first().click({ modifiers: ['ControlOrMeta'] });
  await expect(live.locator('[data-pkc-field="row-source"]')).toBeVisible();
  expect(await box(), '段落の編集欄が全幅へ跳ねた').toBeLessThan(proseW + 20);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **設定昇格の visual parity**(#104 第 2 弾)── 設定の「編集の仕方」を
 * split にすると、次の編集から 2 列に戻る。⚠ 「選択欄が在る」で止めない ──
 * 押して、編集の面が実際に切り替わるまで見る(dead control を出さない)。
 */
test('🔴 設定「編集の仕方」= 2 ペインで、次の編集から 2 列に戻る', async ({ page }) => {
  await gotoLive(page);

  // 設定を開いて、本物の選択欄を split にする
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="editor-mode-select"]');
  await expect(select).toBeVisible();
  await select.selectOption('split');

  // ノートを作って編集に入る ── 2 列(split)が出て、live は出ない
  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-region="editor-split"]')).toBeVisible();
  await expect(page.locator('[data-pkc-region="editor-live"]')).toHaveCount(0);
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
});

/**
 * 🔴 **文書の情報(frontmatter)を、普通の編集で失わない**(#284)。
 *
 * 🔴 **unit では届かない層**:
 * ① **札が本当に見えているか** ── `display:none` / `[data-pkc-has-frontmatter]` の
 *    噛み合いは happy-dom では読めない(`toBeVisible` は実レイアウトを見る)
 * ② **実マウスで行を押したときに開く原文が、原文のその行か** ── 行の対応は
 *    座標から引くので、1 行ずれていても unit の合成クリックでは同じ答えになる
 */
test('🔴 文書の情報は札に出て、本文の編集で消えない (#284)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '---\ntags: [あ, い]\n---\n# 題\n\n最初の段落です。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  const card = page.locator('[data-pkc-region="live-frontmatter"]');

  // ① 🔴 **札が見えている**(器が潰れていない・display が噛み合っている)
  await expect(card, '情報の札が見えていない').toBeVisible();
  await expect(card.locator('[data-pkc-field="fm-summary"]')).toContainText('tags: あ, い');

  // ② 🔴 **本文には出ていない**(謎の水平線・謎の見出しが無い)
  await expect(live.locator('hr'), '情報が水平線として本文に出ている').toHaveCount(0);
  await expect(live.locator('h1')).toHaveText('題');
  await expect(live.locator('h2'), '情報が見出しとして本文に出ている').toHaveCount(0);

  /**
   * ③ 🔴 **実マウスで段落を押して書き換えても、情報の行を潰さない。**
   * ⚠ ここが 1 行ずれていると、`---` の行が段落として開く。
   */
  await live.locator('p', { hasText: '最初の段落です。' }).click({ modifiers: ['ControlOrMeta'] });
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row, '押した行が原文とずれている').toHaveValue('最初の段落です。');
  await row.fill('書き換えました。');
  await page.keyboard.press('Tab');
  await expect(live.locator('p', { hasText: '書き換えました。' })).toBeVisible();
  // 🔴 札は残っている(= 情報が失われていない)
  await expect(card.locator('[data-pkc-field="fm-summary"]'), '情報が消えた').toContainText(
    'tags: あ, い',
  );

  // ④ 🔴 **札から情報を編集できる**(触れなくしただけにしない)
  await clickReal(page, '[data-pkc-field="fm-edit"]');
  const src = card.locator('[data-pkc-field="fm-source"]');
  await expect(src, '情報の原文が開かない').toBeVisible();
  await expect(src).toHaveValue('---\ntags: [あ, い]\n---');
  await src.fill('---\ntags: [う]\n---');
  await clickReal(page, '[data-pkc-field="fm-commit"]');
  await expect(card.locator('[data-pkc-field="fm-summary"]')).toContainText('tags: う');
  // ⚠ 本文は巻き添えになっていない
  await expect(live.locator('p', { hasText: '書き換えました。' })).toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **閉じ記号を打っても二重にならない**(2026-08-21、cowork 実機レポート #15)。
 *
 * ⚠ **unit だけでは守れない。** `insertText` は `execCommand('insertText')` を
 *   使い、**happy-dom にはそれが無い**ので unit は必ず fallback 側を通る
 *   (CLAUDE.md §2「環境が持たないから代わりに動く道を書いたら、そちらが本物と
 *   同じ意味論かを必ず確かめる」)。**実打鍵で通るのはここだけ**である。
 *
 * ⚠ そして**この面は打鍵そのものを避けていた** ── この file の別の spec に
 *   「打鍵だと auto pair が閉じてしまうので `fill` で入れる」と注記が在り、
 *   `[` を含む本文を打つ他の smoke は **split の `editor-body`**(auto pair の
 *   無い面)を入力の道具に使っていた。つまり**実打鍵で閉じを打つ経路は、
 *   unit にも smoke にも存在しなかった**。
 *
 * 🔑 観測点は**保存される原文**(行の `value`)── 画面の見た目ではない。
 *   直す前は `tags: [あ, い]]` になり、frontmatter が**警告 0 件で**
 *   `{tags:["あ","い]"]}` と読んでいた(= タグが無言で別物になる)。
 */
test('🔴 実打鍵で括弧を閉じても二重にならない (#299 / cowork #15)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\nもとの段落。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeFocused();

  /**
   * ⚠ **空にしてから打つ。** 全選択したまま開き記号を打つと、それは
   *   **囲む**という別の正しい挙動になる(1 稿目はここを取り違えて、
   *   `["あ"]` を「壊れた」と読みかけた ── test の期待の側が誤りだった)。
   */
  const clear = async (): Promise<void> => {
    await row.press('Control+a');
    await row.press('Backspace');
    await expect(row).toHaveValue('');
  };

  // ⚠ **打鍵で入れる**(`fill` にすると auto pair を 1 度も通らない = 空振り)
  await clear();
  await page.keyboard.type('tags: [あ, い]');
  await expect(row, '閉じが二重になった(タグが無言で別物になる形)').toHaveValue(
    'tags: [あ, い]',
  );

  // ⚠ 同字対も見る ── 直す前はこちらのほうが被害が 1 文字多かった
  await clear();
  await page.keyboard.type('"あ"');
  await expect(row, '同字対で新しい対を開いてしまっている').toHaveValue('"あ"');

  // ⚠ 開いたまま閉じないときは、これまでどおり閉じが補われる(壊していない)
  await clear();
  await page.keyboard.type('[');
  await expect(row, '開きの補完まで消してしまった').toHaveValue('[]');

  /**
   * ⚠ **選択があるときは囲む**(通り抜けに巻き込まれていない)。
   * ⚠ **ASCII の対で見る。** Playwright の `type` は全角文字を
   *   `Input.insertText` で入れるので **keydown が飛ばず**、auto pair の経路を
   *   1 度も通らない(2 稿目でここを踏んだ ── `「ここ」` を期待して `「` が返った)。
   *   🔑 全角 4 対の網羅は unit の全数表が持っている。ここは
   *   **実打鍵でしか通らない層**(`execCommand('insertText')`)だけを見る。
   */
  await clear();
  await page.keyboard.type('ここ');
  await row.press('Control+a');
  await page.keyboard.type('[');
  await expect(row, '選んだ文字を囲めていない').toHaveValue('[ここ]');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **読む面を Ctrl(⌘)クリックすると、その塊が開いた状態で編集に入る**
 * (#395 段③。⚠ 割当は #495 で `Alt` → `Ctrl` へ移した)。
 *
 * ⚠ **unit では 1 度も走らない層である** ── 予約(`RowSwap.openAt`)を果たすのは
 *   ワーカーの描き直しが着いた後(`update` → `openPending`)で、happy-dom には
 *   その往復が無い。unit が見ているのは `editOpenAt` が state に載るところまでで、
 *   **押した塊が本当に開くか**はここでしか確かめられない
 *   (CLAUDE.md §2「本命の分岐を、unit は 1 度も通らないことがある」)。
 */
test('🔴 読む面を Ctrl クリックすると、押した段落が開いて編集に入る (#395 段③)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n最初の段落です。\n\n2 つめの段落です。\n');
  // 読む面へ戻す(ここからが本題)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const read = page.locator('[data-pkc-field="detail-body"]');
  await expect(read.locator('p').nth(1)).toContainText('2 つめの段落です。');

  // 🔴 2 つめの段落を Ctrl(⌘)クリック(#495 で割当が移った)
  const box = await read.locator('p').nth(1).boundingBox();
  expect(box, '押す所が見えていない').not.toBeNull();
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.up('ControlOrMeta');

  // ① 編集に入っている
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live, '編集に入っていない').toBeVisible();
  // ② 🔴 **押した段落が開いている**(先頭の段落ではない ── ここが本題)
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row, '押した塊が開いていない').toHaveValue('2 つめの段落です。', {
    timeout: 8000,
  });
  // ③ 周りは描画のまま(1 面の性質は保たれている)
  await expect(live.locator('h1')).toHaveText('題');
  expect(errors).toEqual([]);
});

/**
 * ⚠ **素のクリックでは入らない**(browse-first の裁定 2026-08-18 を変えない)。
 * 🔑 上の test と**対で置く** ── 片方だけだと「Alt が効いた」のか
 *   「何を押しても編集に入る」のかが区別できない(対照群)。
 */
test('🔴 素のクリックでは編集に入らない (#395 段③ の対照群)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n最初の段落です。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const read = page.locator('[data-pkc-field="detail-body"]');
  await expect(read.locator('p').first()).toContainText('最初の段落です。');
  await clickReal(page, '[data-pkc-field="detail-body"] p');
  await expect(
    page.locator('[data-pkc-region="editor-live"]'),
    '素のクリックで編集に入った',
  ).toHaveCount(0);
});

/**
 * 🔴 **表の 1 行を開いても、表は画面に残る**(#423。user 報告 2026-08-26
 * 「インライン編集で複数行のブロックが1行しか表示されないバグあり / 表とかで起きてる」)。
 *
 * 🔴 **unit では届かない層**:器を `<table>` の中へ入れるのは**HTML の parser の
 *   話**である ── `<div>` を入れると実ブラウザは表の外へ追い出すので、
 *   欄がどこにも居なくなる。happy-dom はそこまで真似ない。
 *   そして「表の中の `<textarea>` に本当に打てて、確定がその行だけを変える」かは
 *   実機でしか分からない。
 */
test('🔴 表の行を開いても表は残り、その行だけを直せる (#423)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoLive(page);
  await openLive(page, '# 表\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live.locator('table'), '表が描かれていない').toHaveCount(1);
  const rowsBefore = await live.locator('tr').count();
  expect(rowsBefore, '前提: 表に複数の行が在る').toBeGreaterThan(1);

  // 2 行目(`| 3 | 4 |`)のセルを押す
  await live
    .locator('tbody tr', { hasText: '3' })
    .first()
    .locator('td')
    .first()
    .click({ modifiers: ['ControlOrMeta'] });
  const box = live.locator('[data-pkc-field="row-source"]');
  await expect(box, '行が開かない').toBeVisible();
  await expect(box).toHaveValue('| 3 | 4 |');

  /**
   * 🔴 **ここが本題** ── 直す前は、押した瞬間に表が丸ごと消えて
   *   1 行の欄だけになっていた。
   */
  await expect(live.locator('table'), '表ごと消えた').toHaveCount(1);
  await expect(live.locator('tr'), '表の行が消えた').toHaveCount(rowsBefore);
  // 🔑 欄は**表の中**に居る(実ブラウザの parser が外へ出していない)
  await expect(
    live.locator('table [data-pkc-row-slot]'),
    '欄が表の外へ出ている(器が表の文法に合っていない)',
  ).toHaveCount(1);
  // ⚠ 触っていない行の字は見えたまま
  await expect(live.locator('table')).toContainText('1');

  // 打てて、確定するとその行だけが変わる
  await box.fill('| 30 | 40 |');
  await page.keyboard.press('Tab');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);
  await expect(live.locator('table')).toContainText('30');
  await expect(live.locator('table'), '触っていない行まで変わった').toContainText('1');
  await expect(live.locator('tr')).toHaveCount(rowsBefore);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
