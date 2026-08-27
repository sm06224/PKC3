import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

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
test('🔴 名前で探して実行できる ── 開く / 絞る / Enter で走る (#425)', async ({ page }) => {
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

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
