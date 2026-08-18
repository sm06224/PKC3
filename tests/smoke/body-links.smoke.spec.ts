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
 * 🔴 **本文のリンクが実機で押せる**(2026-08-08)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は生成の正しさしか示さない。ここで見るのは unit では
 * 観測できないことだけ:
 *
 * - 🔴 **未知スキームへ遷移しない** ── `<a href="entry:…">` の既定動作は
 *   実ブラウザにしか無い。`preventDefault` を忘れると **URL が変わる /
 *   ページが飛ぶ**。happy-dom は `entry:` のナビゲーションを再現しない
 * - 🔴 **キーボードで押せる** ── Tab でフォーカスが乗るか(`tabindex` が
 *   実際に効いているか)は実ブラウザの話
 * - **本当に markdown が焼いているか** ── unit は手で属性を置いているので、
 *   焼く側が変わっても気づかない
 */
test('🔴 本文の entry: リンクを押すと、そのノートが開く(遷移しない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  // ① リンク先のノートを作る(lid は一覧の行から採る ── 手で作らない)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('リンク先');
  await page.locator('[data-pkc-field="editor-body"]').fill('着いた先の本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="entry-list"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(targetLid, 'リンク先の lid を採れていない(fixture の空振り)').toBeTruthy();

  // ② そこへリンクするノートを作る
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('リンク元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(`[あちらへ](entry:${targetLid ?? ''})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔴 焼く側が本当に action を付けている(unit の手組みが嘘でないこと)
  const link = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');
  await expect(link, '本文にアプリ内リンクが出ていない').toHaveCount(1);

  const urlBefore = page.url();
  await clickReal(page, '[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');

  // 🔴 **開く**
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('着いた先の本文');
  // 🔴 **遷移していない**(`entry:` へ飛ぼうとしていない)
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **携帯参照(`pkc://`)が、実機の cid で焼き分けられる**(2026-08-08。Issue #100 段①)。
 *
 * ## unit では届かないもの
 *
 * unit は cid を**自分で作って渡す**ので、「アプリが実際に何を渡しているか」は
 * 1 度も通らない。ここで見るのは:
 *
 * - 🔴 **本物の boot が渡す cid**(`main.ts` の `DEFAULT_CID`)が描画まで届くこと
 * - 🔴 **本物のワーカー**を通しても焼き分けが同じであること(unit の同期経路と違う)
 * - **対照群** ── 同じ本文の別コンテナあては placeholder のままであること
 *   (これが無いと「全部リンクにする」実装でも通る)
 */
test('🔴 pkc:// の自分あては押せて、別コンテナあては押せない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('携帯参照の先');
  await page.locator('[data-pkc-field="editor-body"]').fill('携帯参照で着いた本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="entry-list"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(targetLid, 'リンク先の lid を採れていない(fixture の空振り)').toBeTruthy();

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('携帯参照の元');
  /**
   * ⚠ `default` は **`main.ts` の `DEFAULT_CID`**(このアプリが boot で渡す値)。
   * ここを手で書いているのは、**アプリ側の値が変わったら鳴らす**ためである。
   */
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(
      `[こちらへ](pkc://default/entry/${targetLid ?? ''})\n\n` +
        `[よそへ](pkc://not-mine/entry/${targetLid ?? ''})\n`,
    );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const body = '[data-pkc-field="detail-body"]';
  const link = page.locator(`${body} [data-pkc-action="navigate-entry-ref"]`);
  await expect(link, '自分あての pkc:// が焼かれていない(cid が届いていない)').toHaveCount(1);
  await expect(
    page.locator(`${body} .pkc-portable-reference-placeholder`),
    '別コンテナあてまでリンクにしている',
  ).toHaveCount(1);

  const urlBefore = page.url();
  await clickReal(page, `${body} [data-pkc-action="navigate-entry-ref"]`);
  await expect(page.locator(body)).toContainText('携帯参照で着いた本文');
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **`@card` はキーボードでも押せる**(user 指示「マウスだけで完結し、
 * キーボードは近道」)。⚠ 直す前は**フォーカスできるのに Enter が効かない**
 * 要素が 1 種類だけ存在していた。
 */
test('🔴 @card の札にフォーカスが乗り、Enter で開く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('カードの先');
  await page.locator('[data-pkc-field="editor-body"]').fill('カードで着いた本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="entry-list"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('カード元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(`@[card](entry:${targetLid ?? ''})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const card = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-card-ref"]');
  await expect(card, 'カードの札が出ていない').toHaveCount(1);

  /**
   * 🔑 **フォーカスできること自体が観測点**(`tabindex` が効いているか)。
   * ⚠ `focus()` を呼んで確かめる ── Tab の回数はページの構造で変わるので、
   *   ここで数えると構造を変えるたびに壊れる(挙動ではなく形を pin してしまう)。
   */
  await card.focus();
  await expect(card, 'フォーカスが乗らない(キーボードで届かない)').toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('カードで着いた本文');
  expect(errors).toEqual([]);
});

/**
 * 🔴 **編集中に一覧の行を押しても、無言では断らない**(2026-08-08)。
 *
 * ⚠ 直す前は reducer が `SELECT_ENTRY` を**黙って捨てて**いた ── 押しても
 * 1 ドットも動かず、理由もどこにも出ない。user から見ると「クリックが効かない」。
 * 🔑 **実機で見る意味**: 理由の出口(画面下の帯)は既定で `hidden` なので、
 * 「出た」を実際の可視性で確かめられるのはここだけである。
 */
test('🔴 編集中に一覧の行を押すと、理由が画面に出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('1 件目\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('2 件目\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 編集に入る
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const status = page.locator('[data-pkc-region="status"]');
  expect(await status.isVisible(), '編集に入った時点で既に理由が出ている').toBe(false);

  // ⚠ **clickReal は使わない** ── 断られる操作なので「押した結果」を待たない
  await page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').last().click();

  // 🔴 理由が**見える**
  await expect(status, '無言で断った(押しても何も起きない)').toBeVisible();
  await expect(status).toContainText('編集');
  // ⚠ 押した場所に合った呼び名(行を押したのに「リンク先」と言わない)
  await expect(status).not.toContainText('リンク先');
  // ⚠ 編集は続いている(勝手に移っていない)
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * 🔴 #100 段②: 本文の `pkc://<自分>/asset/<key>` を押すと**所有ノートへ飛ぶ**。
 *
 * unit は「焼く」(container-id-render)と「逆引き」(storage-worker)を別々に
 * 見る ── **焼いた属性 → binder → worker の逆引き → SELECT_ENTRY** が 1 本に
 * つながるかは実物でしか確かめられない。
 */
test('🔴 pkc:// の asset あては押すと所有ノート(添付)へ飛ぶ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ① 添付を作る(所有ノート)── key は画面の実属性から採る(でっち上げない)
  await clickReal(page, '[data-pkc-action="attach-file"]');
  await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
    name: 'owner.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  const dl = page.locator('[data-pkc-action="download-asset"]');
  await expect(dl).toBeVisible({ timeout: 15000 });
  const key = await dl.getAttribute('data-pkc-asset-key');
  expect(key, '添付の key を画面から採れていない(fixture の空振り)').toBeTruthy();

  // ② 参照を本文に書いたノートを作る
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('参照の元');
  await page.locator('[data-pkc-field="editor-body"]').fill(`[図へ](pkc://default/asset/${key})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ③ 焼けていること(action + 受け手が読む key 属性)
  const link = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-asset-ref"]');
  await expect(link, '自分あての asset 参照が焼かれていない').toHaveCount(1);
  expect(await link.getAttribute('data-pkc-asset-ref')).toBe(key);

  // ④ 押すと所有ノート(添付)へ飛ぶ ── 添付の面が出る
  const urlBefore = page.url();
  await clickReal(page, '[data-pkc-field="detail-body"] [data-pkc-action="navigate-asset-ref"]');
  await expect(
    page.locator('[data-pkc-field="attachment-media"]'),
    '所有ノートに着いていない(添付の面が出ない)',
  ).toBeVisible();
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  expect(errors).toEqual([]);
});
