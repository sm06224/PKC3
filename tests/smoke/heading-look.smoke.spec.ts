import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **見出しが見出しに見える**(user 報告 2026-08-27)。
 *
 * > 見出し行が見づらいんだよね。特に見出しのレベルが高いと文字が小さくなるから
 * > 文と一緒の大きさに見える。いっそのこと見出し行の折りたたみ記号を廃止して、
 * > 装飾の薄いアンダーラインとか左端に幅の狭いインデックスカラーつけるとか?
 *
 * 🔴 **unit では原理的に届かない層**:主張が全部**計算後の値**である ──
 * `font-size: 1em` が本文と比べて何 px になるか / `opacity` が実際に 0 か /
 * `:hover` で 1 になるかは、**本物のブラウザが解決するまで決まらない**。
 * ⚠ CSS の字面を読む test では「規則が在る」しか言えず、
 *   **UA 既定に負けている**(h5 = 0.83em)ことは見えない ── それが元の不具合である。
 */
test('🔴 深い見出しも本文より小さくならず、左端の帯で見出しと分かる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await page
    .locator('[data-pkc-region="editor-live"] [data-pkc-field="row-source"]')
    .fill(
      '# 一\n\n地の文です。\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n\n最後の段落。',
    );
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const pane = page.locator('[data-pkc-view-pane="detail"] .pkc-md-rendered');
  // ⚠ **空振り防止** ── 6 段そろって描かれていなければ、以下の測定は何も言えない
  for (let lv = 1; lv <= 6; lv += 1) {
    await expect(pane.locator(`h${lv}`), `h${lv} が描かれていない(前提が崩れた)`).toHaveCount(1);
  }

  /** 計算後の font-size(px)。 */
  const px = async (sel: string): Promise<number> =>
    Number(
      (await pane.locator(sel).first().evaluate((el) => getComputedStyle(el).fontSize)).replace(
        'px',
        '',
      ),
    );

  const body = await px('p');
  expect(body, '地の文の大きさが取れていない').toBeGreaterThan(0);

  // ① 🔴 **本文より小さい見出しを作らない** ── これが user 報告の本体。
  //    ⚠ 直す前は h5 = 0.83em / h6 = 0.67em で、**本文より小さかった**
  for (const lv of [4, 5, 6]) {
    expect(
      await px(`h${lv}`),
      `h${lv} が地の文より小さい(見出しに見えない)`,
    ).toBeGreaterThanOrEqual(body);
  }
  // ② 段が下がるほど大きくならない(1〜3 は大きい側、4〜6 は本文と同じ)
  expect(await px('h1'), 'h1 が h2 より大きくない').toBeGreaterThan(await px('h2'));
  expect(await px('h2'), 'h2 が h3 より大きくない').toBeGreaterThan(await px('h3'));

  // ③ 🔴 **どの段にも左端の帯が出る** ── 段に依らず「これは見出しである」を示す印
  for (let lv = 1; lv <= 6; lv += 1) {
    const w = await pane
      .locator(`h${lv}`)
      .evaluate((el) => getComputedStyle(el).borderInlineStartWidth);
    expect(Number(w.replace('px', '')), `h${lv} に左端の帯が無い`).toBeGreaterThanOrEqual(2);
  }

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **畳みの印は「要るときだけ」出す**(同 user 報告「折りたたみ記号を廃止して」)。
 *
 * ⚠ **廃止はしていない** ── 見出しをそのまま押すと編集に入るので、この口を消すと
 *   **畳む動線が 1 つも無くなる**。だから「消す」ではなく「出す場面を絞る」。
 * 🔴 ③ の「畳んでいる間は必ず出す」が**この test の主眼**である ──
 *   そこが効いていないと、畳んだ見出しが**ただの短い見出しに見え**、
 *   開き直す口も画面から消える(片道の操作になる)。
 */
test('🔴 畳みの印はふだん出ず、触れたときと畳んでいる間だけ出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await page
    .locator('[data-pkc-region="editor-live"] [data-pkc-field="row-source"]')
    .fill('# 見出し\n\n配下の段落です。\n\n## 次の見出し\n\nもう 1 つの段落。');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const pane = page.locator('[data-pkc-view-pane="detail"] .pkc-md-rendered');
  /**
   * 🔑 **畳むのは h2 のほう**。h1 を畳むと**配下ごと隠れる**ので、
   *   h1 が対照群として使えなくなる(1 稿目はそれで詰まった)。
   *   h2 を畳めば h1 は見えたまま残り、**触れる相手**として使える。
   */
  const h1 = pane.locator('h1').first();
  const h2 = pane.locator('h2').first();
  const mark1 = h1.locator('[data-pkc-field="heading-fold"]');
  const mark2 = h2.locator('[data-pkc-field="heading-fold"]');
  await expect(mark1, 'h1 の畳む口が出ていない(前提が崩れた)').toHaveCount(1);
  await expect(mark2, 'h2 の畳む口が出ていない(前提が崩れた)').toHaveCount(1);

  const op = async (m: typeof mark1): Promise<number> =>
    Number(await m.evaluate((el) => getComputedStyle(el).opacity));

  // ① 何も畳んでいない・触れていないときは**出ない**(行を混ませない)
  await pane.locator('p').first().hover();
  expect(await op(mark2), 'ふだんから畳みの印が出ている(行が混む)').toBe(0);

  // ② 見出しに触れると出る
  // ⚠ **待って読む** ── 0.12 秒かけて濃くなるので、触れた直後に 1 度読むと
  //   途中の値(0.0x)が返る。1 度だけ読む test は**必ず落ちる**(実際に落ちた)
  await h2.hover();
  await expect.poll(() => op(mark2), { message: '見出しに触れても畳みの印が出ない' }).toBe(1);

  // ③ 🔴 畳んだら、**触れていなくても**出たままになる
  await mark2.click();
  const folded = pane.locator('p').last();
  await expect(folded, '押しても配下が畳まれていない(前提が崩れた)').toBeHidden();

  /**
   * 🔴 **対照群で「薄れ終わった」を確かめてから読む**(2026-08-27 に踏んだ)。
   *
   * ⚠ 1 稿目は「隅へ退避 → `expect.poll` で 1 を待つ」と書いたが、
   *   `poll` は**最初の一読で当たれば通る** ── 薄れ始めの 1 をそのまま採るので、
   *   **門を外す変異が生き延びた**(SURVIVED)。時間で待つのも同じ穴である。
   * 🔑 だから**畳んでいない h1 に触れ、そちらが 1 になるまで待つ** ──
   *   これが 1 になった時点で「pointer は h2 を離れ、遷移は走り切った」が
   *   **観測できている**。そのうえで h2 の印を読む。
   */
  await h1.hover();
  await expect
    .poll(() => op(mark1), { message: '対照群(h1)が濃くならない ── 前提が崩れた' })
    .toBe(1);
  expect(
    await op(mark2),
    '畳んでいるのに印が消えた(畳んだ事実も開き直す口も見えない)',
  ).toBe(1);

  // ④ もう一度押すと開く(片道にしない)
  await mark2.click();
  await expect(folded, '開き直せない').toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
