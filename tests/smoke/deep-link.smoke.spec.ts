import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, dismissAnnounce, gotoApp } from './helpers';

/**
 * 🔴 **`#pkc?view=…` で開くと、その面で立ち上がる**(#300 段②)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * ① **本物のアドレスから読めるか** ── unit は的を差し替えて通しているので、
 *    `location.hash` を実際に読む配線(`windowDeepLinkTarget`)は 1 度も走らない
 * ② **面が本当に見えているか** ── `hidden` の付け替えと CSS の噛み合いは
 *    happy-dom では読めない
 * ③ 🔴 **断片が実際に消えるか** ── `history.replaceState` の効きは実ブラウザにしかない。
 *    ⚠ ここが効かないと、更新の適用や昇格で読み直しが起きた瞬間に、
 *    user が見ていた場所からその面へ飛ばされる
 */
test('🔴 #pkc?view=query で開くと、その面で立ち上がる (#300)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/#pkc?view=query');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });

  // ② 面が見えていて、本文の面は畳まれている
  await expect(
    page.locator('[data-pkc-view-pane="query"]'),
    'ディープリンクで指した面が開いていない',
  ).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeHidden();

  /**
   * 🔴 **見ている間は断片が残る**(2026-08-22 に「読んだら消す」から翻した)。
   * ⚠ 消すと、マニュアルが案内している `Ctrl+D` が**素の URL**を拾い、
   *   「**成功した人だけがブックマークを作れない**」形になる。
   */
  expect(
    await page.evaluate(() => location.hash),
    '見ている間に断片が消えた(ブックマークが作れない)',
  ).toBe('#pkc?view=query');

  /**
   * 🔴 **読み直しても同じ面のまま**(user は更新しただけで、画面を替えていない)。
   * ⚠ ここは**初回訪問の分離のための読み直し**(#111)と同じ窓でもある ──
   *   断片を boot で消していた初稿は、その読み直しに食われて本文へ落ちていた。
   */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-view-pane="query"]'),
    '読み直したら面が消えた',
  ).toBeVisible();

  /**
   * 🔴 **user が自分で離れたら、その瞬間に断片が消える。**
   * ⚠ 残ると、本文を読み始めた後の読み直しでこの面へ飛ばされる。
   */
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  expect(
    await page.evaluate(() => location.hash),
    '離れても断片が残る ── 読み直しでこの面へ飛ばされる',
  ).toBe('');

  /**
   * 🔴 **履歴を積んでいない**(`replaceState` であること)。
   * ⚠ `pushState` だと「戻る」が**同一文書内の断片移動**になり、画面が
   *   1 ドットも動かない ── user は「戻るが壊れている」と読み、2 回押す。
   * ⚠ この機構を見ている test は、直前まで 1 件も無かった(着地前レビュー)。
   */
  await page.goBack();
  expect(
    new URL(page.url()).hash,
    '断片を history に積んだ(戻るで PKC から出られない)',
  ).toBe('');

  expect(errors, 'pageerror / console.error が出ている').toEqual([]);
});

/**
 * ⚠ **対照群** ── 断片が無ければ、今までどおり本文の面で立ち上がる。
 * これが無いと、上の spec は「常にその面が開く」実装でも通る。
 */
test('⚠ 対照群 ── 断片が無ければ本文の面で立ち上がる (#300)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="query"]')).toBeHidden();
  expect(errors, 'pageerror / console.error が出ている').toEqual([]);
});

/**
 * 🔴 **知らない面の名前は、黙って捨てず理由を出す**(実画面で読めること)。
 * ⚠ unit は文言を見ているが、**それが状態の行に届くか**は実ブラウザでしか見えない。
 */
test('🔴 知らない面の名前は、画面に理由が出る (#300)', async ({ page }) => {
  await page.goto('/#pkc?view=nosuchpane');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  const status = page.locator('[data-pkc-region="status"]');
  // 🔑 **打つ字が出ていること**(画面の呼び名を出すと、user は打てない字で書き直す)
  await expect(status, '知らない面を黙って捨てている').toContainText('query');
  await expect(status, '打てない字(画面の呼び名)を出している').not.toContainText('集計');
  // ⚠ 使えない名前は残す意味が無いので、その場で消す(断り文が読み直しのたびに出ない)
  expect(await page.evaluate(() => location.hash), '使えない断片が残っている').toBe('');
});

/**
 * 🔴 **栞にした `view=calendar` は、引っ越し先へ送る**(#292 段⑤、2026-08-23)。
 *
 * ## user から見た物語
 *
 * カレンダーをブックマークしていた user が、更新後にそれを開く。
 * ⇒ **左の列の「予定」が開き、どこへ移ったかが画面に出る。**
 * ⚠ 送らないと「画面名は detail / query / … のどれかです」だけが出る ──
 *   移した先を知っているのは実装した本人だけなので、user は**探せない**。
 *
 * ## unit では届かない層
 *
 * ① 本物のアドレスから読む配線(unit は的を差し替えている)
 * ② **左の列のタブが実際に切り替わるか**(`hidden` と CSS の噛み合い)
 * ③ 断り文が**状態の行に届くか**
 */
for (const name of ['calendar', 'kanban']) {
  test(`🔴 #pkc?view=${name} は「予定」タブへ送られる (#292)`, async ({ page }) => {
    await page.goto(`/#pkc?view=${name}`);
    await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
    // ② 左の列の「予定」が開いている(中央は本文のまま = 占有していない)
    await expect(
      page.locator('[data-pkc-browse-pane="schedule"]'),
      '引っ越し先が開いていない(栞が死んでいる)',
    ).toBeVisible();
    await expect(
      page.locator('[data-pkc-view-pane="detail"]'),
      '中央を占有した(引っ越しの理由と正面から逆)',
    ).toBeVisible();
    // ③ どこへ移ったかが読める
    await expect(
      page.locator('[data-pkc-region="status"]'),
      'どこへ移ったか画面に出ていない',
    ).toContainText('予定');
    // ⚠ 使えない断片は残さない(読み直しのたびに断り文が出ない)
    expect(await page.evaluate(() => location.hash), '移した後も断片が残っている').toBe('');
  });
}

/**
 * 🔴 **住所は、いま見ているノートへ追随する**(#689 案 B、2026-09-04)。
 *
 * ## user から見た物語(直す前)
 *
 * ノートへの直リンクで開いた窓で、そのまま別のノートを開いて 30 分作業する。
 * `F5` を押す ⇒ **30 分前のノートへ引き戻される**。`Ctrl+D` の栞も同じ。
 *
 * ## ⚠ ここでしか測れないもの
 *
 * unit は的を差し替えて通すので、**`location` を実際に書き換える配線**
 * (`windowDeepLinkTarget.setEntry` ← `main.ts` の購読)は 1 度も走らない。
 * 🔑 ここが持つのは「**アドレスが本当に動き、読み直すとそこが出る**」である
 * ── 両端(住所を組む所 / 選択を伝える所)が**繋がっている**ことは、
 * どちらの unit にも書けない(CLAUDE.md §7)。
 *
 * ⚠ **直リンクは、アプリ自身に組ませる**(付箋の窓の URL がそれである)──
 * 手で組むと、綴りが食い違っていても test の側だけ正しくなる(同じ盲点を共有しない)。
 */
test('🔴 直リンクの窓で別のノートを開くと、F5 でそのノートが出る (#689)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);

  // ⚠ **2 件作る** ── 1 件だと「たまたま同じノートが出た」と区別が付かない
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('さいしょ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('あとから');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /** 一覧の行(題名 → lid)。⚠ 画面から採る ── 保存の綴りを推測しない。 */
  const lidOf = async (title: string): Promise<string> =>
    await page.evaluate((t) => {
      const rows = [...document.querySelectorAll('[data-pkc-region="sidebar"] [data-pkc-entry]')];
      const hit = rows.find((r) => (r.textContent ?? '').includes(t));
      return hit?.getAttribute('data-pkc-entry') ?? '';
    }, title);

  const firstLid = await lidOf('さいしょ');
  const secondLid = await lidOf('あとから');
  expect(firstLid, '前提が崩れた(さいしょ の行が一覧に無い)').not.toBe('');
  expect(secondLid, '前提が崩れた(あとから の行が一覧に無い)').not.toBe('');
  expect(firstLid, '前提が崩れた(2 件が同じ行を指している)').not.toBe(secondLid);

  // 🔑 直リンクの形は**付箋の窓の URL** を借りる(アプリが組んだ本物である)
  await clickReal(page, `[data-pkc-entry="${firstLid}"]`);
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  const link = win.url();
  await win.close();
  expect(link, '付箋の URL がそのノートを指していない(前提が崩れた)').toContain(
    `entry=${firstLid}`,
  );

  /**
   * ⚠ **これは「入り直し」ではない**(#689 着地前レビュー ⚠4)── `link` の path は
   *   いま開いている頁と同じなので、**読み直しは起きず** `hashchange` だけが飛ぶ。
   * 🔑 起動時の経路(断片を読んでノートを選ぶ側)は、下の `page.reload()` が通す。
   */
  await page.goto(link);
  expect(
    await page.evaluate(() => location.hash),
    '前提が崩れた(直リンクの住所が残っていない)',
  ).toContain(`entry=${firstLid}`);

  // 🔴 その窓で別のノートを開く ⇒ 住所が付いてくる
  await clickReal(page, `[data-pkc-entry="${secondLid}"]`);
  await expect
    .poll(async () => await page.evaluate(() => location.hash), {
      message: '住所が古いノートを指したまま(F5 で引き戻される)',
    })
    .toContain(`entry=${secondLid}`);

  /** 🔴 **読み直すと、いま見ているノートが出る**(この直しの当の主張)。 */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-region="inspector"]'),
    '読み直したら別のノートが出た(住所が追随していない)',
  ).toContainText('あとから');

  /**
   * 🔴 **履歴を積んでいない** ── 積むと「戻る」が同一文書内の断片移動になり、
   *   画面が 1 ドットも動かない(user は「戻るが壊れている」と読む)。
   */
  await page.goBack();
  expect(
    new URL(page.url()).hash,
    '住所の書き換えを history に積んだ(戻るで PKC から出られない)',
  ).not.toContain(`entry=${firstLid}`);

  expect(errors, 'pageerror / console.error が出ている').toEqual([]);
});

/**
 * 🔴 **`#pkc?view=schedule` で、予定表が中央の面に出て、集めが終わる**(#673 段②。
 * user 裁定 2026-09-04「予定表も連絡先も別窓、アプリの基本は別窓」)。
 *
 * ## unit では届かない層
 *
 * ① 本物のアドレスから読む配線(unit は的を差し替えている)
 * ② **面が本当に見えているか** ── `[data-pkc-view-pane='schedule']` を選択子リストで
 *    束ねた CSS と `hidden` の噛み合いは happy-dom では読めない
 * ③ 🔴 **boot の経路で `REFRESH_TASK_SCAN` が worker まで届くか** ── unit は
 *    event が飛んだことしか見ていない(`open-view.test.ts`)。届かなければ面は
 *    「集めています…」で**永久に止まる**(別窓で開いた user が最初に見る画面である)。
 *
 * ⚠ ノートは作らない ── 0 件でも集めが**終わった**ことは字で分かる
 *   (「集めています…」が別の字に変わる)。
 */
test('🔴 #pkc?view=schedule で開くと、予定表が中央に出て集めが終わる (#673 段②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#pkc?view=schedule');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });

  // ② 中央の面が見えていて、本文の面は畳まれている
  const pane = page.locator('[data-pkc-view-pane="schedule"]');
  await expect(pane, 'ディープリンクで指した予定表が開いていない').toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]'), '本文の面が畳まれていない').toBeHidden();
  // 面の部品が中央の器に載っている(左の列と同じ描画器)
  await expect(pane.locator('[data-pkc-field="schedule-quick-text"]'), '足す欄が無い').toBeVisible();
  await expect(pane.locator('[data-pkc-field="schedule-month"]'), '月が無い').toBeVisible();

  // ③ 🔴 集めが頼まれて終わる ── 「集めています…」のままなら boot の経路で走査が飛んでいない
  await expect(
    pane.locator('[data-pkc-field="schedule-note"]'),
    '走査が頼まれていない(別窓は永久に「集めています…」)',
  ).not.toContainText('集めています', { timeout: 10_000 });

  // 🔑 帰り道は同じ帯の × ── 閉じれば本文へ戻る(別窓なら窓ごと閉じる。ここはタブ)
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();

  expect(errors, 'pageerror / console.error が出ている').toEqual([]);
});
