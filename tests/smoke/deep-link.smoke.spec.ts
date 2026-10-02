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

/**
 * 🔴 **`#pkc?view=search` で、探す面が中央に出て、打つと本文の当たりが並ぶ**(#680)。
 *
 * ## unit では届かない層
 *
 * ① 本物のアドレスから読む配線
 * ② **面が本当に見えているか**(`[data-pkc-view-pane='search']` の CSS と `hidden`)
 * ③ 🔴 **boot の経路で `searchDetail` が worker まで届くか** ── unit は fake の口で
 *    答えている。届かなければ面は「探しています…」で止まるか「探せません」と言う
 *    (別窓で開いた user が最初に見る画面である)。
 *
 * ⚠ ノートは 1 件作り、本文に**題名には無い語**を書く ── 題名検索では当たらない形で、
 *   本文の索引まで通っていることを見る。
 * ⚠ 書いただけで走らせていない(2026-09-05)── 手元で回すときは
 *   `npm run test:smoke -- tests/smoke/deep-link.smoke.spec.ts`。
 */
test('🔴 #pkc?view=search で開くと、探す面が中央に出て本文の語で当たる (#680)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // 本文に、題名には無い語を書いて保存する(作法は `append-ui.smoke.spec.ts` の `makeNote`)
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  /**
   * 🔴 **語を本文の「奥」に 2 回書く**(#1102 段①)── 開いた窓で、送った位置が画面の中に在ることを
   *   見るには、**送らなければ見えない所**に当たりが要る(短い本文だと、送らなくても見えて通る)。
   *   ⚠ 2 回の間は 40 字より離す ── 一覧の抜粋に印が 1 つだけ出る前提(下の `row.locator('mark')`)を保つ。
   * 🔴 **「奥」は字体に依らない距離で取る**(2026-10-02)── 以前は 700 字(開いた窓は幅 420px で 1 つ目が
   *   本文の 534px 付近)で、「送った後の scrollTop > 300」を要求していた。送る先は画面の上から 35% の所
   *   (`scrollToHit` の `LAND_RATIO`)なので scrollTop = 位置 − 210px で、**余裕は 24px しか無かった**。
   *   CJK の字体が変わる(行の高さが数 % 動く)と 286px になり、**送れているのに「送っていない」と落ちた**
   *   (CI のフル Chromium で実際に落ちた。手元で字体を IPA ゴシックへ替えると同じ値で再現する)。
   *   1500 字にして、1 つ目が**窓の高さより十分下**に在るようにする。
   */
  const filler = (n: number): string => `ここは長い文です${'あ'.repeat(n)}。`;
  const FILLER_LEN = 1500;
  await live
    .locator('[data-pkc-field="row-source"]')
    .fill(`探す面の本文に書いた ${filler(FILLER_LEN)} けんさくご という語 ${filler(FILLER_LEN)} けんさくご の 2 つ目`);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // ⚠ 追記の入り先(`append-target`)は見出しの無い本文では畳まれる ── 描けた印で待つ
  await expect(page.locator('[data-pkc-field="detail-body"][data-pkc-painted]').first()).toBeVisible();

  await page.goto('/#pkc?view=search');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });

  // ② 中央の面が見えていて、本文の面は畳まれている
  const pane = page.locator('[data-pkc-view-pane="search"]');
  await expect(pane, 'ディープリンクで指した探す面が開いていない').toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]'), '本文の面が畳まれていない').toBeHidden();
  const input = pane.locator('[data-pkc-field="search-page-input"]');
  await expect(input, '打つ欄が無い').toBeVisible();
  await expect(input, '開いたのに欄へ焦点が入っていない').toBeFocused();

  // ③ 🔴 打つと worker まで届き、本文の語で行が出る(題名には無い語)
  await input.fill('けんさくご');
  const row = pane.locator('[data-pkc-search-row]');
  await expect(row, '本文の語で行が出ない(searchDetail が worker まで届いていない)').toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(row.locator('mark'), '当たった語に印が無い').toHaveText('けんさくご');
  // ⚠ 面の語で左の一覧は絞られない(別のもの)
  await expect(page.locator('[data-pkc-field="entry-filter"]')).toHaveValue('');

  /**
   * 🔴 **行を押すと、開いた窓で、探した語が塗られ、当たりが画面の中に送られる**(#1102 段①)。
   *
   * ## unit では届かない層
   *
   * 塗り(`CSS.highlights`)も送った位置(`getBoundingClientRect`)も happy-dom には無い。
   * ⚠ **起動は足していない** ── 既存の探す面の道中で、行を押して出る**窓**を見るだけ
   *   (窓は `gotoApp` / `page.goto` を通らない)。
   * ⚠ 塗りは `getComputedStyle` では読めない ── 観測点は **①塗りの表の件数 ②送った後の当たりが
   *   画面の中 ③塗りを消す前後で、その位置の画素が変わる**(= 本当に見える色が付いている)。
   *   ③は `::highlight` の色が効いていること(`var()` が解けていること)の証拠でもある。
   */
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-search-row] [data-pkc-action="open-note-window"]');
  const win = await popup;
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  const hits = () =>
    win.evaluate(() => {
      const css = (window as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS;
      return {
        supported: css.highlights !== undefined,
        all: css.highlights?.get('pkc-search-hit')?.size ?? 0,
        current: css.highlights?.get('pkc-search-hit-current')?.size ?? 0,
      };
    });
  await expect
    .poll(async () => (await hits()).all, {
      message: '開いた窓で、探した語が塗られていない(find が窓まで届いていない / 描き終わりで塗っていない)',
      timeout: 20_000,
    })
    .toBe(2);
  expect((await hits()).current, 'いまの 1 つが強く塗られていない').toBe(1);
  await expect(
    win.locator('[data-pkc-field="search-jump-count"]'),
    '帯に「1/2 件」が出ていない',
  ).toHaveText('1/2 件');
  // 🔑 語は使ったらアドレスから外れる(栞・F5 に焼き付かない)
  expect(win.url(), '探した語が住所に残っている').not.toContain('find=');

  /** いまの 1 つの位置(画面の座標)。 */
  const currentRect = () =>
    win.evaluate(() => {
      const css = (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS;
      const range = [...css.highlights.get('pkc-search-hit-current')!][0]!;
      const r = range.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: window.innerHeight, w: window.innerWidth };
    });
  const inView = async (label: string): Promise<{ top: number; bottom: number; left: number; right: number }> => {
    const r = await currentRect();
    expect(r.bottom - r.top, `${label}: 当たりの箱が無い`).toBeGreaterThan(0);
    expect(r.top, `${label}: 当たりが画面の上へはみ出している(top=${r.top})`).toBeGreaterThanOrEqual(0);
    expect(r.bottom, `${label}: 当たりが画面の下へはみ出している(bottom=${r.bottom} / 画面 ${r.h})`).toBeLessThanOrEqual(r.h);
    return r;
  };
  // ② 送った位置が画面の中に在る(本文の奥に在るので、送らなければ見えない)
  await expect
    .poll(async () => win.evaluate(() => document.querySelector('[data-pkc-region="detail"]')!.scrollTop), {
      message: '送っていない(scrollTop が 0 のまま)',
    })
    .toBeGreaterThan(0);
  const first = await inView('1 件目');
  // 🔑 前提を assert する ── 1 つ目は**送らなければ見えない所**(本文の先頭から窓の高さより下)に在る。
  //   崩れたら「送っていない」ではなく「前提が崩れている」と読める文言で落とす(字体で行の高さが動いても)
  const premise = await win.evaluate(() => {
    const d = document.querySelector('[data-pkc-region="detail"]') as HTMLElement;
    const css = (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS;
    const r = [...css.highlights.get('pkc-search-hit-current')!][0]!.getBoundingClientRect();
    return { docTop: r.top - d.getBoundingClientRect().top + d.scrollTop, clientHeight: d.clientHeight };
  });
  expect(
    premise.docTop,
    `前提が崩れている: 1 つ目の当たりが本文の先頭から窓の高さ(${premise.clientHeight}px)の内に在る = 送らなくても見える`,
  ).toBeGreaterThan(premise.clientHeight);
  // ③ 塗りが画素として見える ── 塗りを消す前後で、その位置の画素が変わる
  const clip = { x: Math.max(0, first.left), y: Math.max(0, first.top), width: Math.max(1, first.right - first.left), height: Math.max(1, first.bottom - first.top) };
  const painted = await win.screenshot({ clip });

  // ‹ › で送る ── 2 件目へ、画面の中へ
  await clickReal(win, '[data-pkc-action="search-jump-next"]');
  await expect(win.locator('[data-pkc-field="search-jump-count"]')).toHaveText('2/2 件');
  const second = await inView('2 件目');
  expect(second.top, '次を押しても当たりの位置が動いていない').not.toBeCloseTo(first.top, 0);
  // 端で回る
  await clickReal(win, '[data-pkc-action="search-jump-next"]');
  await expect(win.locator('[data-pkc-field="search-jump-count"]'), '端で回っていない').toHaveText('1/2 件');
  await inView('回って 1 件目');

  // × で、塗りも帯も消える
  await clickReal(win, '[data-pkc-action="search-jump-end"]');
  expect((await hits()).all, '× を押しても塗りが残っている').toBe(0);
  await expect(win.locator('[data-pkc-field="search-jump-count"]')).toBeHidden();
  const bare = await win.screenshot({ clip });
  expect(
    Buffer.compare(painted, bare),
    '塗りを消しても画素が変わらない = 塗りは付いていたが、見える色が無かった(::highlight の色が解けていない)',
  ).not.toBe(0);
  expect(winErrors, '開いた窓に pageerror / console.error が出ている').toEqual([]);
  await win.close();
  await page.bringToFront();

  /**
   * 🔴 **左の列の欄に語を打ってから行を押しても、本文の当たりへ送られて塗られる**(#1102 段②)。
   *
   * ⚠ **起動は足していない**(同じ道中の本体の窓。「探す」の面を出したまま、左の列を使う)。
   * ⚠ 見るのは**押す経路から画面まで**:欄に打つ → 本文の語で行が残る → 行を押す → 本文の面へ戻り、
   *   塗りの表・帯・送った位置が出る。→ 欄を空にすると**塗りも帯も消える**(欄の語の持ち物なので)。
   *   ⚠ 「探す」の行から来た塗りが欄を空にしても残る側は unit(`search-jump-state.test.ts`)が持つ
   *   ── 本体の窓では、探す窓の行は別の窓を開くだけで、本体の塗りにならない。
   */
  // 🔑 本体の窓は広い(1440x900)ので、1 つ目の当たり(本文の 674px 付近)が**送らなくても見える**。
  //   窓の高さを縮めて、送らなければ見えない所に置く(前提は下で assert する)
  await page.setViewportSize({ width: 1440, height: 520 });
  // 探す面は「本文を畳んで中央を占める面」── 行を押しても中央はその面に留まるので、本文へ戻してから使う
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await expect(page.locator('[data-pkc-view-pane="detail"]'), '× パネルを閉じるで本文へ戻らない').toBeVisible();
  const field = page.locator('[data-pkc-field="entry-filter"]');
  await field.fill('けんさくご');
  const sideRow = page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry]');
  await expect(sideRow, '本文の語で左の列が絞られていない(本文の索引が返っていない)').toHaveCount(1, {
    timeout: 10_000,
  });
  await clickReal(page, '[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry]');
  const mainHits = () =>
    page.evaluate(() => {
      const css = (window as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS;
      return {
        all: css.highlights?.get('pkc-search-hit')?.size ?? 0,
        current: css.highlights?.get('pkc-search-hit-current')?.size ?? 0,
      };
    });
  await expect
    .poll(async () => (await mainHits()).all, {
      message: '左の列の欄の語で行を押したのに、本文が塗られていない',
      timeout: 15_000,
    })
    .toBe(2);
  expect((await mainHits()).current, 'いまの 1 つが強く塗られていない').toBe(1);
  await expect(
    page.locator('[data-pkc-field="search-jump-count"]'),
    '本文の右上に「1/2 件」が出ていない',
  ).toHaveText('1/2 件');
  // 🔑 前提:1 つ目の当たりは**送らなければ見えない所**に在る。崩れたら「前提が崩れている」と読める文言で落とす
  const mainPos = () =>
    page.evaluate(() => {
      const d = document.querySelector('[data-pkc-region="detail"]') as HTMLElement;
      const css = (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS;
      const r = [...css.highlights.get('pkc-search-hit-current')!][0]!.getBoundingClientRect();
      const d0 = d.getBoundingClientRect();
      return {
        scrollTop: d.scrollTop,
        clientHeight: d.clientHeight,
        docTop: r.top - d0.top + d.scrollTop,
        inTop: r.top - d0.top,
        inBottom: r.bottom - d0.top,
        h: r.bottom - r.top,
      };
    });
  const mp = await mainPos();
  expect(mp.h, '当たりの箱が無い').toBeGreaterThan(0);
  expect(
    mp.docTop,
    `前提が崩れている: 1 つ目の当たりが本文の先頭から窓の高さ(${mp.clientHeight}px)の内に在る = 送らなくても見える`,
  ).toBeGreaterThan(mp.clientHeight);
  expect(mp.scrollTop, '送っていない(scrollTop が 0 のまま)').toBeGreaterThan(0);
  expect(mp.inTop, `当たりが本文の面の上へはみ出している(${mp.inTop})`).toBeGreaterThanOrEqual(0);
  expect(mp.inBottom, `当たりが本文の面の下へはみ出している(${mp.inBottom} / 面 ${mp.clientHeight})`).toBeLessThanOrEqual(mp.clientHeight);
  // 欄を空にすると、塗りも帯も消える
  await field.fill('');
  await expect
    .poll(async () => (await mainHits()).all, { message: '欄の語を消したのに、塗りが残っている' })
    .toBe(0);
  await expect(page.locator('[data-pkc-field="search-jump-count"]'), '欄の語を消したのに、帯が残っている').toBeHidden();

  /**
   * 🔴 **同じ道中で SQL の面まで見る**(#681 段②)。
   *
   * ⚠ **起動を足さない**(`location.hash` を書き換えるだけ ── 読み直しは要らない、と
   *   マニュアルが約束している側の経路である)。CLAUDE.md「新しく起動する test を
   *   足すのではなく、既に在る道中に assert を足す」。
   *
   * ## unit では届かない層
   *
   * unit は `runReadOnlySql` を fake の口で答えている ── ここで見るのは
   * **本物の worker の本物の sqlite が、いま保存した本文を返すか**である。
   * ⚠ 届かなければ「この版では SQL を打てません」と出る(押しても何も出ない、ではない)。
   */
  await page.evaluate(() => {
    location.hash = '#pkc?view=sql';
  });
  const sql = page.locator('[data-pkc-view-pane="sql"]');
  await expect(sql, 'アドレスで指した SQL の面が開いていない').toBeVisible();
  await sql
    .locator('[data-pkc-field="sql-input"]')
    .fill("SELECT count(*) AS n FROM entries WHERE body LIKE '%けんさくご%'");
  await clickReal(page, '[data-pkc-field="sql-run"]');
  await expect(
    sql.locator('[data-pkc-field="sql-table"] tbody td'),
    '本物の worker から答えが返らない(SQL が sqlite まで届いていない)',
  ).toHaveText('1', { timeout: 10_000 });
  await expect(sql.locator('[data-pkc-field="sql-table"] thead th'), '列の名前が出ない').toHaveText(
    'n',
  );
  await expect(
    sql.locator('[data-pkc-field="sql-note"]'),
    '件数と時間の 1 行が出ない',
  ).toContainText('1 行');

  /**
   * 🔴 **答えをノートへ書き出せる**(#681 段③ の 3 つ目)。
   *
   * ⚠ **起動は 1 つも足していない**(いま開いている面で 1 回押すだけ)──
   *   CLAUDE.md「新しく起動する test を足すのではなく、既に在る道中に assert を足す」。
   * ⚠ unit(happy-dom)では**本文が disk へ渡ったか**までしか見られない ──
   *   ここで見るのは**実物の worker と実物の sqlite を通って、左の一覧に出るか**である。
   */
  await clickReal(page, '[data-pkc-field="sql-to-note"]');
  await expect(
    sql.locator('[data-pkc-field="sql-note"]'),
    '書き出したことを画面が言わない(別の窓では、言わないと押せなかったように見える)',
  ).toContainText('書き出しました');
  await expect(
    page.locator('[data-pkc-region="browse-host"]'),
    '書き出したノートが左の一覧に出ない',
  ).toContainText('SQL の答え', { timeout: 10_000 });

  expect(errors, 'pageerror / console.error が出ている').toEqual([]);
});
