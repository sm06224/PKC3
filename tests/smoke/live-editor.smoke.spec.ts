import { test, expect, type Page } from '@playwright/test';
import { clickReal, createEntry, collectPageErrors } from './helpers';

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
 * ⚠ 既定 OFF なので **flag で開く**。
 *
 * 🔴 **綴りは `?pkc-flag=editor.live`**(2026-08-07 に `?pkc-live=1` から昇格)。
 * user 指示「URL クエリパラメータ切り替えはフラグ扱いである / クエリパラメータを
 * 抜け穴にしてはいけない」── **クエリを読んでよいのは flag の解決と
 * パーマリンクだけ**で、`tests/features/flags.test.ts` の全数検査が旧い綴りを落とす。
 * ⚠ この spec は昇格の commit で**直し忘れて 12 件落ちた**(unit は緑だった) ──
 *   smoke は `dist/` を配信するので、source の綴りを変えても unit には届かない。
 */

async function gotoLive(page: Page): Promise<void> {
  await page.goto('/?pkc-flag=editor.live');
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
  // ⚠ 作った直後は**今日の 2 列**ではなく 1 面が出ている(flag が効いている)
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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
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
  // 行の**右寄り**(「さしすせそ」の辺り)を突く
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);

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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
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
  await clickReal(page, '[data-pkc-region="editor-live"] tbody tr:nth-of-type(2)');
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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  await row.fill('1 回目。');
  await page.keyboard.press('Tab');
  await expect(live).toContainText('1 回目。');

  // ② 2 か所目を書き換えて確定(= 塊を跨いだ)
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(2)');
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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
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
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
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
    const a = ps[0]!.getBoundingClientRect();
    const b = ps[1]!.getBoundingClientRect();
    return { scrollTop: el.scrollTop, ax: a.x + 40, ay: a.y + a.height / 2, bx: b.x + 80, by: b.y + b.height / 2 };
  });
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
test('🔴 最終行の ↓ で次の塊が開き、行の途中の ↓ は箱の中の移動のまま', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoLive(page);
  await openLive(page, '# 題\n\n最初の段落です。\n\n次の段落です。\n');

  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toHaveValue('最初の段落です。');

  // 1 行の値 = どこに居ても最終行 ── ↓ で確定し、次の塊が開く(caret 先頭)
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await expect(row, '次の塊が開いていない').toHaveValue('次の段落です。');
  expect(
    await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    'caret が先頭に無い',
  ).toBe(0);

  // ↑ で前の塊に戻る(caret 末尾)
  await page.keyboard.press('ArrowUp');
  await expect(row).toHaveValue('最初の段落です。');
  expect(
    await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    'caret が末尾に無い',
  ).toBe('最初の段落です。'.length);

  // 複数行にして行の途中に caret ── ↓ は**箱の中の移動**のまま(奪っていない)
  await row.fill('1 行目です。\n2 行目です。');
  await row.evaluate((el) => {
    (el as HTMLTextAreaElement).setSelectionRange(0, 0);
  });
  await page.keyboard.press('ArrowDown');
  await expect(row, '行の途中の ↓ で確定してしまった(箱の中を移動できない)').toHaveValue(
    '1 行目です。\n2 行目です。',
  );
  const caret = await row.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  expect(caret, '↓ の既定動作(次の行へ)が死んでいる').toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
