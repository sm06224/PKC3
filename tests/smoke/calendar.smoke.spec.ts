import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, openViewPane, useSplitEditor } from './helpers';

/**
 * 🔴 **カレンダー(封印の解除)**(#276。user 指示 2026-08-19
 * 「かつて無くしたカレンダーとカンバンはここで生きてきます / 発想を変え、
 * frontmatter でのカレンダー情報付与…で復活させるのです」)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * ① **導線が実際に効くか** ── アプリの一覧のタイルを**実クリック**して面が開くか
 *    (封印は「導線を畳んだ」ものなので、戻ったことは導線でしか確かめられない)
 * ② **面が本当に見えているか** ── `hidden` の付け替えと CSS の噛み合いは
 *    happy-dom では読めない(`toBeVisible` は実レイアウトを見る)
 * ③ **セルに面積が在るか** ── 日の地を押す導線なので、潰れていると狙えない
 */
test('🔴 アプリの一覧からカレンダーを開き、日を押すと予定が入る (#276)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ノートを 1 件作る(作った直後は選ばれている)
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 🔴 **アプリの一覧に居る**(封印が解けている)
  //    ⚠ 押すと**別窓**が開く(#300 段③)ので、面そのものはアドレスから開く ──
  //      タイルが窓を開くことは `launcher.smoke.spec.ts` が見る
  await clickReal(page, '[data-pkc-browse="launcher"]');
  await expect(
    page.locator('[data-pkc-action="open-tile"][data-pkc-tile="builtin:calendar"]'),
    'アプリの一覧にカレンダーが出ていない',
  ).toBeVisible();

  // ② 🔴 面が見えている(本文の面は畳まれている)
  await openViewPane(page, 'calendar');
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeHidden();

  /**
   * ③ 🔴 **日を押すと、選んでいるノートに日付が入る。**
   * ⚠ 日付は**画面から読む**(実行月に依存する値を test 側で組まない ──
   *   月替わりの日に落ちる test を作らない)。
   */
  const month = await page
    .locator('[data-pkc-field="calendar-month"]')
    .getAttribute('data-pkc-month');
  expect(month, '月が出ていない').toMatch(/^\d{4}-\d{2}$/);
  const key = `${month}-15`;
  const cell = page.locator(`[data-pkc-date="${key}"]`);
  const box = await cell.boundingBox();
  expect(box, '日のセルが描かれていない').not.toBeNull();
  expect(box!.height, 'セルに面積が無い(押せない)').toBeGreaterThan(8);

  /**
   * ⚠ 狙うのは**日の数字**(user が実際に見て押す所)。
   * 🔑 座標で「地」を狙わない ── ノートが入るとセルが伸びるので、**同じ座標が
   *   2 回目には行の上に来る**(1 稿目でそう外した。製品ではなく叩き方の問題)。
   */
  const day = cell.locator('[data-pkc-field="day-number"]');
  await day.click();
  await expect(
    cell.locator('[data-pkc-entry]'),
    '押した日にノートが出ない(日付が入っていない)',
  ).toHaveCount(1);

  /** ④ 🔴 **同じ日をもう一度押すと外れる**(付けた本人が外せない導線を作らない)。 */
  await day.click();
  await expect(cell.locator('[data-pkc-entry]'), '同じ日を押しても外れない').toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **カレンダーを開いたまま、別のノートを選べる**(2026-08-20。user 指示
 * 「カレンダーを利用するための導線が不足している」)。
 *
 * ⚠ 直す前は**閉ループ**だった ── ① カレンダーは「ノートを先に選んでから日を押す」
 *   設計 ② 開く道はアプリタブのタイルだけで、そこにノートの一覧は無い
 *   ③ 一覧へ行こうとタブを押すと**カレンダーごと閉じる**。つまり
 *   「カレンダーが開いていて、かつノート一覧が見えている」状態が**存在し得なかった**。
 * ⚠ 既存の smoke はこの穴を**踏まない** ── 直前に作ったノートが自動で選ばれているので、
 *   選ぶ導線が 1 度も要らない(CLAUDE.md §1「緑のまま欠けている」型)。
 *   だからここは **2 件目のノートを選び直す**という、実際に詰まる筋をなぞる。
 */
test('🔴 カレンダーを開いたまま一覧へ行き、別のノートに日付を付けられる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 2 件作る ── 2 件目が選ばれた状態で終わる
  for (const t of ['あ', 'い']) {
    await createEntry(page, 'text');
    const title = page.locator('[data-pkc-field="editor-title"]');
    if (await title.count()) await title.fill(t);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }

  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'calendar');
  await expect(page.locator('[data-pkc-view-pane="calendar"]')).toBeVisible();

  /**
   * 🔴 **ここが直した所** ── 一覧タブへ移っても、カレンダーは開いたまま。
   * ⚠ 観測点は「面が見えていること」にする(state ではなく画面)── 畳まれると
   *   `hidden` が付くので、`toBeVisible` が確定的に落ちる。
   */
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(
    page.locator('[data-pkc-view-pane="calendar"]'),
    '一覧タブへ移ったらカレンダーが閉じた(閉ループに戻っている)',
  ).toBeVisible();

  // 左の一覧から 1 件目を選び直す ── 面は開いたまま
  const first = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  await first.click();
  await expect(
    page.locator('[data-pkc-view-pane="calendar"]'),
    'ノートを選んだらカレンダーが閉じた',
  ).toBeVisible();

  // その状態で日を押すと、選び直したノートに日付が入る
  const month = await page
    .locator('[data-pkc-field="calendar-month"]')
    .getAttribute('data-pkc-month');
  const cell = page.locator(`[data-pkc-date="${month}-15"]`);
  await cell.locator('[data-pkc-field="day-number"]').click();
  await expect(
    cell.locator('[data-pkc-entry]'),
    '選び直したノートに日付が入っていない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **面の破れを実レイアウトで確かめる**(2026-08-20)。
 *
 * ⚠ ここは **unit では原理的に届かない層**だけを見る ── どれも「DOM に在るか」では
 *   なく「**実際に何 px どこに置かれたか**」である。直す前の実測(1440×900):
 *   曜日の列が **40.6px×6 + 696.1px×1**(予定のある列だけ伸びる)/
 *   表の高さが器の **30.6%**(626px の器に 191.5px)。
 */
test('🔴 曜日の列が等幅で、月が面の高さを使う', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  /**
   * ⚠ **長い題名のノートを 1 件入れてから測る** ── 空の月では `auto` でも
   *   等幅に見えるので、**入れずに測ると直す前でも緑になる**(§1 の空振り)。
   */
  await createEntry(page, 'text');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('とても長い題名のノートで列を押し広げる試験用の見出し');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'calendar');
  const month = await page
    .locator('[data-pkc-field="calendar-month"]')
    .getAttribute('data-pkc-month');
  await page.locator(`[data-pkc-date="${month}-15"] [data-pkc-field="day-number"]`).click();
  // ⚠ 空振り防止 ── 予定が本当にセルへ入ったか(入っていなければ列は広がらない)
  await expect(
    page.locator(`[data-pkc-date="${month}-15"] [data-pkc-entry]`),
    '前提が崩れている(予定が入っていない)',
  ).toHaveCount(1);

  const cols = await page
    .locator('[data-pkc-region="calendar-grid"] thead th')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(cols.length, '曜日が 7 列でない').toBe(7);
  expect(
    Math.max(...cols) - Math.min(...cols),
    `曜日の列が等幅でない: ${cols.map((c) => c.toFixed(1)).join(' / ')}`,
  ).toBeLessThanOrEqual(1);

  /**
   * ⚠ **観測点を変えた**(#303 の着地前レビュー B-3)。1 稿目は
   *   `表の高さ / 器の高さ > 0.7` を見ていたが、#303 でセルに下限(`5em`)を
   *   置いたので、**「配っている」ではなく「下限が在る」で満たせる条件**に
   *   変質した(6 週 × 65px + 見出し ≒ 410px が下限だけで出る)。
   * 🔑 だから**最下段の週の下端が器の下端に届いているか**で見る ──
   *   下限では満たせない(引き伸ばしが効いていないと必ず余白が残る)。
   */
  const gap = await page.evaluate(() => {
    const pane = document.querySelector('[data-pkc-view-pane="calendar"]')!;
    const rows = document.querySelectorAll('[data-pkc-region="calendar-grid"] tbody tr');
    const last = rows[rows.length - 1]!.getBoundingClientRect();
    const box = pane.getBoundingClientRect();
    return { gap: box.bottom - last.bottom, paneH: box.height, rows: rows.length };
  });
  expect(gap.rows, '週が描かれていない(この検査は空振り)').toBeGreaterThanOrEqual(4);
  expect(
    gap.gap,
    `月が面の高さを使っていない(最下段の下に ${gap.gap.toFixed(0)}px 余っている / 器 ${gap.paneH.toFixed(0)}px)`,
  ).toBeLessThanOrEqual(12);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **予定が増えても、日のセルが動かない**(#303)。
 *
 * ## 何が起きていたか
 *
 * cowork 実機レポート #15「同じ座標を 2 回押すと別の日に当たる」。⚠ 報告は
 * 「**列幅**が変わる」と書いていたが、列幅は #293 の `table-layout: fixed` で
 * 既に固定済み ── **動いていたのは行の高さ**である。
 *
 * | 段 | なぜ動くか |
 * |---|---|
 * | 予定は `td` の**直下**に積む | 1 件入るごとに、その週の内在高が ~17px 増える |
 * | 表は `flex: 1` で器いっぱいに伸びる | 伸びた週の**下の行が押し下がる** |
 *
 * ⇒ 同じ (x, y) の 2 打目が**同じ曜日の別の週**に当たる。しかも
 * `binder.ts` の分岐は `meta.date === date ? null : date` なので、
 * 2 打目は「外れる」ではなく「**その日へ移る**」── 報告の見え方と一致する。
 *
 * ## ⚠ この spec が unit では書けない理由
 *
 * 見ているのは「DOM に在るか」ではなく「**実際に何 px の所に置かれたか**」。
 * happy-dom は表の高さ配分をしないので、原理的に届かない。
 *
 * ⚠ **この test は、この spec 冒頭の「座標で地を狙わない」という戒めの
 *   製品側の答えでもある** ── あれは叩き方の問題として畳んだが、
 *   実機では user が同じ所で詰まった。
 *
 * ## ⚠ **1 件では足りない**(変異試験 M6 が教えた)
 *
 * 1 稿目は予定を **1 件**だけ入れて「行が動かない」を見ていたが、器を流れの中へ
 * 戻す変異(= 直す前の姿)が **SURVIVED** した ── セルの下限(`5em` = 65px)が
 * 予定 1 件ぶん(~19px)を**吸収してしまう**からである。
 * 🔑 **SURVIVED を「test が弱い」と読む前に、「その次元を通っているか」を疑う**
 *   (CLAUDE.md §2)── ここは assert ではなく **fixture の件数**が足りなかった。
 */
test('🔴 予定が積み上がっても、週の行が動かない (#303)', async ({ page }) => {
  const errors = collectPageErrors(page);
  // ⚠ 本文を直に書きたいので 2 ペイン(ライブは contenteditable で `fill` できない)
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  /**
   * 🔴 **5 件を同じ日へ積む。** ⚠ **1 件では足りない**(変異試験 M6 が実演した)──
   *   セルには下限(`5em` = 65px)が在るので、予定 1 件ぶん(~19px)は下限に
   *   吸収されて**行が動かない**。つまり 1 件だけ入れる稿は、器を流れの中へ
   *   戻す変異を**素通りさせる**(弱いのではなく、その次元を通っていない)。
   * 🔑 日付は frontmatter に直に書く ── 日を押して付ける手順は「選んでいる
   *   ノート」に依存し、一覧の並びが変わると**同じ日を 2 回押して外して**しまう。
   * ⚠ 月は**ブラウザの時計**から採る(test 側で固定値を組まない)。
   */
  const key = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const N = 5;
  for (let i = 0; i < N; i++) {
    await createEntry(page, 'text');
    const title = page.locator('[data-pkc-field="editor-title"]');
    if (await title.count()) await title.fill(`予定${i + 1}`);
    await page.locator('[data-pkc-field="editor-body"]').first().fill(`---\ndate: ${key}\n---\n`);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }

  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'calendar');
  await expect(page.locator('[data-pkc-view-pane="calendar"]')).toBeVisible();
  // ⚠ 作っている間に月が変わっても落ちないよう、書いた月へ寄せる
  const label = page.locator('[data-pkc-field="calendar-month"]');
  for (let i = 0; i < 2 && (await label.getAttribute('data-pkc-month')) !== key.slice(0, 7); i++) {
    await clickReal(page, '[data-pkc-action="calendar-nav"]');
  }
  const cell = page.locator(`[data-pkc-date="${key}"]`);
  // ⚠ 空振り防止 ── 予定が本当に積まれたか(積まれなければ行は動かず、常に緑)
  await expect(cell.locator('[data-pkc-entry]'), '前提が崩れている(予定が積まれていない)')
    .toHaveCount(N);

  const rowGeom = async (): Promise<{ top: number; h: number }[]> =>
    page
      .locator('[data-pkc-region="calendar-grid"] tbody tr')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, h: r.height };
        }),
      );

  const before = await rowGeom();
  expect(before.length, '週の行が描かれていない(この検査は空振り)').toBeGreaterThanOrEqual(4);

  /**
   * ① 🔴 **どの週も同じ高さ**(仕組みの側)。1 週だけ伸びれば、その下の週は
   *    全部ずれる ── 「同じ曜日の別の週に当たる」の正体はこれである。
   */
  const hs = before.map((r) => r.h);
  expect(
    Math.max(...hs) - Math.min(...hs),
    `週の高さが揃っていない: ${hs.map((h) => h.toFixed(1)).join(' / ')}px`,
  ).toBeLessThanOrEqual(1);

  /**
   * ② 🔴 **予定を動かしても、座標が動かない**(user から見える側)。
   *    選んでいるノート(最後に作ったもの)を 20 日へ移す ── 1 日は 1 件減り、
   *    20 日は 1 件増える。⚠ 増減が**別の週**に起きるので、片方だけ見ても足りない。
   */
  const other = page.locator(`[data-pkc-date="${key.slice(0, 8)}20"]`);
  await other.locator('[data-pkc-field="day-number"]').click();
  await expect(cell.locator('[data-pkc-entry]'), '1 日から減っていない').toHaveCount(N - 1);
  await expect(other.locator('[data-pkc-entry]'), '20 日に増えていない').toHaveCount(1);

  const after = await rowGeom();
  expect(after.length, '週の数が変わった(比較が成り立たない)').toBe(before.length);
  const moved = after.map((r, i) => Math.abs(r.top - before[i]!.top));
  expect(
    Math.max(...moved),
    `予定を動かしたら週の行が動いた: ${moved.map((m) => m.toFixed(1)).join(' / ')}px`,
  ).toBeLessThanOrEqual(1);

  /**
   * ③ 🔴 **日の数字の帯と、器の上端が噛み合っている**(実寸)。
   * ⚠ この 2 つは `--day-band` という 1 つの値から出ているが、**字面 pin では
   *   守れない** ── 片方を消しても、もう片方が同じ字面を含むので緑になる
   *   (着地前レビュー A-1 で実際に生き延びた)。だから実寸で見る。
   * 実測: 数字の下端 22.89px = 器の上端 22.89px。
   */
  const band = await cell.evaluate((td) => {
    const top = td.getBoundingClientRect().top;
    const num = td.querySelector('[data-pkc-field="day-number"]')!.getBoundingClientRect();
    const ev = td.querySelector('[data-pkc-field="day-events"]')!.getBoundingClientRect();
    return { numBottom: num.bottom - top, evTop: ev.top - top };
  });
  expect(
    Math.abs(band.numBottom - band.evTop),
    `帯と器が噛み合っていない(数字の下端 ${band.numBottom.toFixed(1)}px / 器の上端 ${band.evTop.toFixed(1)}px)`,
  ).toBeLessThanOrEqual(1);

  /**
   * ④ 🔴 **狭い版面**(着地前レビュー A-2)── 「セルの下限」と「面ごとスクロール」は
   *    **対で 1 つの直し**だと `app.css` に書いてあるのに、1 稿目は
   *    **どちらも通る test が 0 本**だった(新 smoke 2 本は両方 1440×900 固定)。
   * ⚠ ここが無いと `height: 5em` を `max-height: 5em` に変える変異が素通りする
   *   ── 1440×900 では `flex-grow: 1` が全行を引き伸ばすので、下限が無くても
   *   行は等しくなる(= 直しの後半分が無検査で戻る)。
   */
  await page.setViewportSize({ width: 700, height: 640 });
  const cells = await page
    .locator('[data-pkc-region="calendar-grid"] tbody td')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(
    Math.min(...cells),
    `狭い版面でセルが潰れて狙えない: 最小 ${Math.min(...cells).toFixed(1)}px`,
  ).toBeGreaterThanOrEqual(60);
  /**
   * 🔑 **観測点は「一番下の週まで実際に届くか」にする。**
   * ⚠ `scrollHeight - clientHeight > 0` だけでは弱い ── 表が縮んで行が表の箱の
   *   外へ描かれても、その値は 0 より大きくなる。**スクロールし切った先に
   *   最下段の下端が入っているか**まで見て、初めて「届く」と言える。
   */
  const reach = await page.locator('[data-pkc-view-pane="calendar"]').evaluate((el) => {
    const before = el.scrollHeight - el.clientHeight;
    el.scrollTop = el.scrollHeight; // スクロールし切る
    const rows = document.querySelectorAll('[data-pkc-region="calendar-grid"] tbody tr');
    const last = rows[rows.length - 1]!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.scrollTop = 0;
    return { over: before, overflowY: getComputedStyle(el).overflowY, below: last.bottom - box.bottom };
  });
  // ⚠ 空振り防止 ── 実際に溢れていること(溢れていなければ下の主張は自明に通る)
  expect(reach.over, '狭い版面で表が器に収まってしまった(この検査は空振り)').toBeGreaterThan(0);
  expect(reach.overflowY, '表が面の外へ出ているのにスクロールできない').toMatch(/auto|scroll/);
  expect(
    reach.below,
    `スクロールし切っても最下段が ${reach.below.toFixed(0)}px 面の外に残る(届かない)`,
  ).toBeLessThanOrEqual(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **紙では、日のセルが予定の数だけ伸びる**(#303 の対)。
 *
 * ## なぜ対で要るか
 *
 * 画面では予定を**絶対配置の器**に入れて `overflow: auto` で畳んでいる
 * (そうしないと行が動いて座標が狙えない)。⚠ ところが**紙にスクロールは無い**
 * ので、素通しへ戻さないと**箱の高さで予定が切られる** ── 印刷は 2 面目である。
 * ⚠ この `@media print` ブロックに calendar 用の規則は、直す前 **0 件**だった。
 *
 * ## ⚠ この test が守るもう 1 つのもの
 *
 * `app.css` の print ブロックには「**この節は file のいちばん最後に置く**」という
 * 戒めが在るが、そこには「2026-08-07 時点では手前へ移す変異と**等価**なので
 * 変異試験で殺せない(承知のうえで残している)」とも書いてある。
 * 🔑 **この直しで、その変異が初めて殺せるようになった** ── ここで上書きしている
 * `position` / `overflow` / `height` は画面側と同じ詳細度なので、**print ブロックを
 * 手前へ動かすと負けて、紙で予定が切られる**。この test はそれを鳴らす。
 */
test('🔴 紙では、日のセルが予定の数だけ伸びる (#303)', async ({ page }) => {
  const errors = collectPageErrors(page);
  // ⚠ 本文を直に書きたいので 2 ペイン(ライブは contenteditable で `fill` できない)
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  /**
   * 🔑 **日付は frontmatter に直に書く** ── 日を押して付ける手順は「選んでいる
   *   ノート」に依存し、一覧の並びが変わると**同じ日を 2 回押して外して**しまう
   *   (probe の 1 稿目で実際にそうなった)。
   * ⚠ 月は**ブラウザの時計**から採る(test 側で固定値を組まない)。
   */
  const key = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
  });
  /**
   * ⚠ 件数は **器が画面で溢れる最小**にする(着地前レビュー B-5)── PR gate は
   *   smoke を全量回すので、UI 経由のノート作成 1 件ぶんがそのまま gate の時間になる。
   *   1440×900 の器は約 63px、予定 1 件は約 20px なので **4 件**で溢れる。
   */
  const N = 4;
  for (let i = 0; i < N; i++) {
    await createEntry(page, 'text');
    const title = page.locator('[data-pkc-field="editor-title"]');
    if (await title.count()) await title.fill(`予定${i + 1}`);
    await page.locator('[data-pkc-field="editor-body"]').first().fill(`---\ndate: ${key}\n---\n`);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }

  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'calendar');
  /**
   * ⚠ **月境をまたいでいたら、書いた月へ寄せる** ── 作っている間に月が
   *   変わっても落ちないようにする(製品ではなく実行時刻の問題で赤くしない)。
   */
  const label = page.locator('[data-pkc-field="calendar-month"]');
  for (let i = 0; i < 2 && (await label.getAttribute('data-pkc-month')) !== key.slice(0, 7); i++) {
    await clickReal(page, '[data-pkc-action="calendar-nav"]');
  }
  expect(await label.getAttribute('data-pkc-month'), '書いた月へ寄せられない').toBe(key.slice(0, 7));

  const cell = page.locator(`[data-pkc-date="${key}"]`);
  await expect(cell.locator('[data-pkc-entry]'), '予定が入っていない(この検査は空振り)').toHaveCount(N);
  // 🔴 件数が地の上に出ている ── 器に入り切らない分の手がかり
  await expect(cell.locator('[data-pkc-field="day-count"]')).toHaveText(String(N));

  /**
   * ⚠ **空振り防止** ── 画面で本当に切られていること。切られていなければ
   *   紙で「切られない」ことを見ても何も証明しない。
   */
  const clipped = await cell.locator('[data-pkc-field="day-events"]').evaluate((el) => ({
    boxH: el.getBoundingClientRect().height,
    scrollH: el.scrollHeight,
  }));
  expect(
    clipped.scrollH,
    `画面で畳まれていない(箱 ${clipped.boxH.toFixed(0)}px / 中身 ${clipped.scrollH}px)`,
  ).toBeGreaterThan(clipped.boxH + 1);

  // 🔴 紙 ── A4 縦。⚠ `emulateMedia` **だけでは版面幅が変わらない**
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.emulateMedia({ media: 'print' });
  const printed = await cell.evaluate((td) => {
    const box = td.querySelector('[data-pkc-field="day-events"]') as HTMLElement;
    const items = [...td.querySelectorAll('[data-pkc-entry]')];
    const bottom = td.getBoundingClientRect().bottom;
    return {
      boxH: box.getBoundingClientRect().height,
      scrollH: box.scrollHeight,
      outside: items.filter((el) => el.getBoundingClientRect().bottom > bottom + 1).length,
      countShown: getComputedStyle(
        td.querySelector('[data-pkc-field="day-count"]') as HTMLElement,
      ).display,
    };
  });
  expect(
    printed.scrollH - printed.boxH,
    `紙でも予定が箱の高さで切られている(箱 ${printed.boxH.toFixed(0)}px / 中身 ${printed.scrollH}px)`,
  ).toBeLessThanOrEqual(1);
  expect(printed.outside, `${printed.outside} 件の予定がセルの外へ出ている`).toBe(0);
  // ⚠ 紙では全部出ているので、件数だけ残ると嘘になる
  expect(printed.countShown, '紙に件数が残っている').toBe('none');

  await page.emulateMedia({ media: 'screen' });
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
