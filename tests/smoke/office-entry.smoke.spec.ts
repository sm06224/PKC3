/**
 * smoke(#88 / O3-c): 添付の画面に出る **Office の入口**。
 *
 * 🔴 **主張は 1 つ** ── 「Office の添付には、押せるボタンか名指しの理由が**必ず**
 * 出る。押しても何も起きないボタンは出ない」。
 *
 * ⚠ **どちらが出るかは環境で変わる**(JSPI と分離が揃っているか)。だから
 * 「ボタンが出る」を assert すると、ブラウザの版で赤くなる test になる ──
 * 観測点は**状態のどれかであること**と、**理由のときに押せる物が無いこと**にする。
 * 🔑 CLAUDE.md「主張が違えば観測点も違う」/「実害の形へ書き直す」。
 *
 * ⚠ unit(`tests/adapter/office-entry-view.test.ts`)は happy-dom なので
 * **能力が必ず足りない側**でしか通らない。分離が実際に効いているか、
 * `crossOriginIsolated` が本当に立つかは**実ブラウザでしか分からない**。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal } from './helpers';

/** 中身は問わない ── 入口は MIME と拡張子で決まる(開くのは別窓の仕事)。 */
const FAKE_DOCX = Buffer.from('PK\u0003\u0004 not a real docx', 'utf-8');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('🔴 Office の添付には入口が必ず出る(押しても無言のボタンを出さない)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  /**
   * 🔴 **分離が実際に効いていることを、配る物で確かめる**。
   * `tests/features/coi-headers.test.ts` は `vite.config.ts` の**原文**しか
   * 見ていない ── 書いてあるのに配られていない、を落とせるのはここだけである。
   */
  expect(
    await page.evaluate(() => window.crossOriginIsolated),
    'COOP/COEP が配られていない(Office の前提が崩れている)',
  ).toBe(true);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '報告書.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: FAKE_DOCX,
  });

  const entry = page.locator('[data-pkc-office]');
  await expect(entry, 'Office の添付なのに入口が 1 つも無い').toHaveCount(1, {
    timeout: 15000,
  });
  const state = await entry.getAttribute('data-pkc-office-state');
  expect(['open', 'setup', 'unsupported']).toContain(state);
  // ⚠ 何が出たかは残す(版が変わって状態が動いたら、ログで気づける)
  test.info().annotations.push({ type: 'office-entry-state', description: String(state) });

  if (state === 'open') {
    // 押せる側 ── 開くのに要る 3 つが載っていること(同期で読めないと窓が開かない)
    await expect(entry).toHaveAttribute('data-pkc-asset-name', '報告書.docx');
    expect(await entry.getAttribute('data-pkc-asset-key')).toBeTruthy();
    expect(await entry.getAttribute('data-pkc-asset-mime')).toContain('wordprocessingml');
  } else {
    // 理由の側 ── 🔴 **押せる物を出さない**。ここが本 spec の中心である
    expect(
      await entry.evaluate(
        (el) => el.hasAttribute('data-pkc-action') || el.querySelector('[data-pkc-action]') !== null,
      ),
      '理由を出しているのに押せる物がある(無言の dead click)',
    ).toBe(false);
    expect((await entry.textContent())?.trim(), '理由が空文').not.toBe('');
  }

  // ── Office でない添付には出ない(空振り防止の対照群)──
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await expect(page.locator('[data-pkc-field="attachment-media"]')).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator('[data-pkc-office]'),
    '画像の添付に Office の入口が出ている',
  ).toHaveCount(0);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **設定の面に、入れる導線が実在する**(#88 / O6-a)。
 *
 * ⚠ unit は器を単体で組んで見ているだけ ── **設定を開いたら本当に載っているか**は
 * 実ブラウザでしか分からない(`settings.ts` が置き忘れても unit は通る形がある)。
 * ⚠ **77MB を実際には取らない** ── ここが見るのは「導線が在って、押せる状態か」まで。
 *   取得そのものは配布元に依存するので、smoke の主張にしない。
 */
test('🔴 設定に Office 一式の状態と、入れる 2 つの導線が出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  const section = page.locator('[data-pkc-region="settings-office"]');
  await expect(section, '設定に Office の節が無い').toBeVisible({ timeout: 15000 });
  await expect(section.locator('[data-pkc-field="office-pack-status"]')).toHaveText(
    '入っていません',
  );
  // 🔴 **導線は 2 つとも押せる** ── 配布元に届かない環境の唯一の道
  //    (ファイルから)を、押せない形にしない
  for (const field of ['office-pack-url', 'office-pack-file']) {
    await expect(section.locator(`[data-pkc-field="${field}"]`)).toBeEnabled();
  }
  // ⚠ 入っていないのに「削除」が押せると、押しても何も起きないボタンになる
  await expect(section.locator('[data-pkc-field="office-pack-remove"]')).toBeDisabled();
  /**
   * 🔴 **設定の初期化は、一式が入っていなくても押せる**(#634)。
   *
   * ⚠ ここは「削除」と**わざと違う** ── 落ちて開けなくなった user が使う口なので、
   *   一式の状態で塞ぐと**出口が消える**。押した結果は「すでに初期状態です」と答える。
   */
  await expect(
    section.locator('[data-pkc-field="office-pack-reset-profile"]'),
    '設定の初期化が押せない(落ちた user の出口が塞がっている)',
  ).toBeEnabled();
  // ⚠ 何もしていないときに進捗を出さない
  await expect(section.locator('[data-pkc-field="office-pack-progress"]')).toBeHidden();

  // この環境で動くかを名指しで言う ── Chromium なら「動きます」
  const cap = await section.locator('[data-pkc-field="office-pack-capability"]').textContent();
  expect(cap ?? '', '環境の可否を 1 行も言っていない').not.toBe('');
  test.info().annotations.push({ type: 'office-capability', description: String(cap) });

  expect(errors).toEqual([]);
});
