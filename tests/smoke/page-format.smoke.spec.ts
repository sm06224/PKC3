import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **紙面フォーマット**(2026-08-08。user 裁定「読み幅は A4 と A3、フル HD と
 * 4:3 の縦横を選べるようにし、デフォは A4 縦」)。
 *
 * unit は「規則が在るか / 印が付いているか」しか見られない ── **実際に幅が変わるか**は
 * 実ブラウザでしか分からない(`--read-w` の解決・継承・`max-width:none` の効き方)。
 *
 * 観測点は 3 つ:
 * ① 既定(A4 縦)で段落が **672px 前後**に収まっている
 * ② フル HD にすると段落が**器いっぱいまで**広がる(= cap が外れる)
 * ③ ⚠ **表に読み幅の cap は掛からない** ── 器の幅で実装していないことの証拠。
 *    表が読み幅を**超える**ことで見る。
 *    🔴 **かつてここは「表は 1px も動かない」だった**(#722 P2-11 で書き直した)──
 *    user 裁定で表・図も段落と同じ左端に揃えたので、A4 では左の余白のぶん
 *    **表は狭くなる**(実測 1036 → 854)。⚠ 古い主張のままだと、**裁定どおりに
 *    直すたびに落ちる**検査になる。
 */
test('🔴 紙面を変えると散文の幅が変わる(表に読み幅の cap は掛からない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  /**
   * ⚠ **表は内容に合わせて縮む**(shrink-to-fit)。短い表だと読み幅より**狭くなる**ので、
   * 「表に上限が掛かっていない」を幅の比較で見る主張が**成立しない fixture** になる
   * (2026-08-08 に実際に踏んだ ── 2 列の短い表で落ちた)。
   * 🔑 だから **読み幅を超える内容**を持たせる ── これで「掛かっていれば 672px で
   * 切られ、掛かっていなければ超える」が初めて判定になる。
   */
  const WIDE_ROW = '| ' + ['とても長い見出しの列'.repeat(2)].concat(Array.from({ length: 5 }, (_, i) => `第 ${i + 1} 列の値がここに入る`)).join(' | ') + ' |';
  const SEP = '|' + '---|'.repeat(6);
  await ta.fill(`よく読む段落。\n\n${WIDE_ROW}\n${SEP}\n${WIDE_ROW}\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const para = page.locator('[data-pkc-field="detail-body"] p').first();
  const table = page.locator('[data-pkc-field="detail-body"] table').first();
  await expect(para).toBeVisible();
  await expect(table).toBeVisible();

  const widthOf = async (loc: typeof para): Promise<number> =>
    (await loc.boundingBox())!.width;

  // ① 既定は A4 縦 = 42rem(672px)。⚠ 幅ぴったりに貼らない(font-size で動く)
  const a4 = await widthOf(para);
  expect(a4, `既定の読み幅が広すぎる(${a4}px)`).toBeLessThan(720);
  expect(a4, `既定の読み幅が狭すぎる(${a4}px)`).toBeGreaterThan(600);
  const tableA4 = await widthOf(table);
  // 表は読み幅の外(横に広いほど読める)── ここが 672px なら allow-list が壊れている
  expect(tableA4, '表に読み幅が掛かっている').toBeGreaterThan(a4);

  // ② 設定からフル HD にする(実際の導線)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="page-format-select"]').selectOption('fullhd');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  await expect.poll(async () => await widthOf(para), { timeout: 5000 }).toBeGreaterThan(a4 + 100);
  const wide = await widthOf(para);

  /**
   * ③ 🔴 **器に cap が掛かっていない**(= 図が焼き直される実装に戻っていない)。
   *
   * ⚠ **主張を書き直した**(#722 P2-11、2026-09-06)── かつては「表の幅が
   *   **1px も動かない**」で見ていたが、user 裁定で**表も読み幅の左端に揃える**
   *   ことにしたので、A4 では左に余白が入って**表は狭くなる**(実測 1036 → 854)。
   *   ⚠ 古い主張のままだと、**裁定どおりに直すたびに落ちる**検査になる。
   * 🔑 器に cap が掛かっていないことは、**表が読み幅を超える**ことで見る ──
   *   掛かっていれば表も 672px で切られる(それが元の実害である)。
   *   ⚠ そして**フル HD では余白が 0 になる**ので、表は器いっぱいまで戻る。
   */
  const tableWide = await widthOf(table);
  expect(tableWide, '表に読み幅が掛かっている(器に cap を掛けた実装)').toBeGreaterThan(wide - 1);
  expect(
    tableWide,
    '上限を外したのに表が広がっていない(左の余白が 0 に戻っていない)',
  ).toBeGreaterThan(tableA4);

  // ⚠ **戻せる**(片道だけ効く実装を落とす)。選び直したら元の幅へ
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="page-format-select"]').selectOption('a4-portrait');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect.poll(async () => await widthOf(para), { timeout: 5000 }).toBeLessThan(wide - 100);

  // ⚠ 選んだ紙面は**覚えている**(端末の設定)── 開き直しても続く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="page-format-select"]').selectOption('a3-landscape');
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator('[data-pkc-field="page-format-select"]')).toHaveValue('a3-landscape');

  expect(errors).toEqual([]);
});

/**
 * 🔴 **語の途中で折れない列を持つ表**(着地前レビューが実害を実測した形)。
 * ⚠ 日本語だけの表は文字間で折れるので縮む ── **英字の列が入った瞬間**に
 *   min-content が器を超える。`app.css` の `td, th { overflow-wrap: break-word }` の
 *   注記どおり、これは**設計上の通常ケース**である。
 */
const WIDE_TABLE =
  '| ' + Array.from({ length: 14 }, (_, i) => `Column${i + 1}Header`).join(' | ') + ' |\n' +
  '|' + '---|'.repeat(14) + '\n' +
  '| ' + Array.from({ length: 14 }, (_, i) => `Value${i + 1}Content`).join(' | ') + ' |\n';

/**
 * 🔴 **読み幅を列の中央に置く**(#722 P2-11。user 裁定 2026-09-06 = 案 A)。
 *
 * ⚠ 直す前は左寄せで、1440px の窓では中央の列 941px に対して本文が 672px、
 *   **右に 269px がいつも空いていた**(cowork 実測 2026-09-05)。
 *
 * 観測点は 2 つ ── **どちらも実ブラウザにしか無い**(happy-dom に版面は無い):
 * ① 段落の**左右の余白が同じ**(= 中央に在る)
 * ② 🔴 **表が段落と同じ左端に在る** ── ここが肝である。塊を素直に中央へ置くと
 *    **読み幅より狭い表が段落から離れて浮く**(実測:4 列の表 240px が L=342、
 *    段落は L=126 で **216px** ずれた)。だから表・図は「読み幅の**左端**」に揃える。
 * ⚠ **器には cap を掛けない**(掛けると全部の図が焼き直される)ので、ここも
 *   「器が狭まっていないこと」を上の test と同じ形で守っている。
 */
test('🔴 本文が列の中央に置かれ、表は段落と同じ左端に揃う (#722 P2-11)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('幅');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(
      '# 見出し\n\n段落です。読み幅いっぱいに広がるくらいの長さを持たせてあります。\n\n' +
        '| 品名 | 数量 | 単価 |\n|---|---|---|\n| りんご | 3 | 120 |\n\n' +
        // ⚠ **図とコードも裁定の対象**(「表・図・コードも段落と同じ左端」)──
        //    表だけ見ていると、規則を表だけに絞る変異が生き延びる(M3)
        '```mermaid\ngraph TD\n  A-->B\n```\n\n' +
        '```js\nconst x = 1;\n```\n\n' +
        // 🔴 **語の途中で折れない列を持つ広い表**(着地前レビューが実測した実害)。
        //    セルは `break-word` なので min-content が器より広くなる ── そのとき
        //    超過が**表の器の中**で流れず面ごと横へ広がると、読む面が横スクロールする
        WIDE_TABLE,
    );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  // ⚠ 描き終わるまで待つ ── 待たずに測ると器がまだ空で「前提が崩れている」で落ちる
  await expect(
    page.locator('[data-pkc-field="detail-body"] p').first(),
    '読む面に本文が出ていない',
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-field="detail-body"] table').first(),
    '読む面に表が出ていない',
  ).toBeVisible({ timeout: 15_000 });

  const box = async (sel: string): Promise<{ l: number; w: number; r: number }> =>
    page.evaluate((s) => {
      /**
       * ⚠ **器の探し方で 2 度外した**(1 稿目・2 稿目)── `data-pkc-prose` は
       *   本文の器**そのもの**に付く(子孫ではない)が、同じ名前の器は
       *   **分割プレビュー側にも在る**ので、`[…][data-pkc-prose]` の 1 件目は
       *   段落を 1 つも持たない器に当たった。
       * 🔑 **中身で選ぶ** ── 段落を持っている本文の器を採り、
       *   それが散文の器だと名乗っていることも見る(空振り防止)。
       */
      const host = [...document.querySelectorAll('[data-pkc-field="detail-body"]')].find(
        (el) => el.querySelector('p') !== null,
      );
      if (host !== undefined && !host.hasAttribute('data-pkc-prose'))
        throw new Error('前提が崩れている: 本文の器が散文と名乗っていない');
      if (host === undefined) throw new Error('前提が崩れている: 散文の器が無い');
      const hr = host.getBoundingClientRect();
      const el = host.querySelector(s);
      if (el === null) throw new Error(`前提が崩れている: ${s} が描かれていない`);
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left - hr.left), w: Math.round(r.width), r: Math.round(hr.right - r.right) };
    }, sel);

  const p = await box('p');
  // ① 左右の余白が同じ(± 2px は端数)
  expect(Math.abs(p.l - p.r), `本文が中央に無い(左 ${p.l} / 右 ${p.r})`).toBeLessThanOrEqual(2);
  // ⚠ 空振り防止 ── 余白が 0 なら「中央」も自明に成り立つ
  expect(p.l, '器と読み幅が同じで、中央かどうかを見ていない').toBeGreaterThan(20);

  // ② 表・図・コードは段落と同じ左端(浮かせない)。⚠ **3 種とも見る**
  const t = await box('.pkc-md-block[data-pkc-md-block-kind="table"]');
  expect(Math.abs(t.l - p.l), `表が段落と違う左端に在る(表 ${t.l} / 段落 ${p.l})`).toBeLessThanOrEqual(2);
  // ⚠ 空振り防止 ── 表が読み幅より狭いときにだけ、この検査は意味を持つ
  expect(t.w, '表が読み幅と同じ幅で、左端の揃いを見ていない').toBeLessThan(p.w - 50);
  const m = await box('.pkc-md-block[data-pkc-render-lang="mermaid"]');
  expect(Math.abs(m.l - p.l), `図が段落と違う左端に在る(図 ${m.l} / 段落 ${p.l})`).toBeLessThanOrEqual(2);
  // ⚠ 素のコード fence は `render-lang` を持たない(描く言語だけが持つ)── 1 度外した
  const c = await box('.pkc-md-block[data-pkc-md-block-kind="code"]:not([data-pkc-render-lang])');
  expect(Math.abs(c.l - p.l), `コードが段落と違う左端に在る(コード ${c.l} / 段落 ${p.l})`).toBeLessThanOrEqual(2);

  /**
   * ③ 🔴 **横に広い表が、読む面ごと横スクロールさせない**(着地前レビュー、実測)。
   *
   * ⚠ `max-width: 100%` は**包含ブロックの幅**なので、左の余白(126px)を引かない ──
   *   塊が「左端 126px・幅 925px」になり、右へ 126px はみ出していた
   *   (実測: pane の scrollWidth 925 → **1052**)。超過は**表の器の中**で流す。
   */
  const over = await page.evaluate(() => {
    const host = [...document.querySelectorAll('[data-pkc-field="detail-body"]')].find(
      (el) => el.querySelector('p') !== null,
    ) as HTMLElement | undefined;
    if (host === undefined) throw new Error('前提が崩れている: 散文の器が無い');
    const wide = [...host.querySelectorAll('.pkc-md-block[data-pkc-md-block-kind="table"]')].pop() as
      | HTMLElement
      | undefined;
    if (wide === undefined) throw new Error('前提が崩れている: 表が描かれていない');
    return {
      hostScroll: host.scrollWidth,
      hostClient: host.clientWidth,
      // ⚠ 空振り防止:器より広い中身を実際に持っているか(持っていなければ、
      //    この観測点は「はみ出しうる状態」を 1 度も作っていない)
      blockScroll: wide.scrollWidth,
      blockClient: wide.clientWidth,
    };
  });
  expect(
    over.blockScroll,
    `広い表が器より広くなっていない(表の中身 ${over.blockScroll} / 器 ${over.blockClient})── はみ出しうる状態を作れていない`,
  ).toBeGreaterThan(over.blockClient + 10);
  expect(
    over.hostScroll,
    `読む面が横スクロールする(scroll ${over.hostScroll} / client ${over.hostClient})── 超過は表の器の中で流す`,
  ).toBeLessThanOrEqual(over.hostClient + 1);

  /**
   * ④ 🔴 **器が読み幅より狭いときは、余白を 0 にする**(変異 M1)。
   *
   * ⚠ `max(0px, …)` を外すと値が**負**になり、実測で塊が **L=−136** ── 左へはみ出し、
   *   そちら側はスクロールできないので**表の左端が永久に見えない**。
   *   1440px の 1 状態しか見ていないと、この変異は生き延びる。
   */
  await page.setViewportSize({ width: 820, height: 900 });
  await expect
    .poll(async () => (await box('p')).w, { timeout: 5000 })
    .toBeLessThan(p.w);
  const np = await box('p');
  const nt = await box('.pkc-md-block[data-pkc-md-block-kind="table"]');
  // ⚠ 空振り防止 ── 器が読み幅より狭い状態にいることを、段落の余白 0 で確かめる
  expect(np.l, `器がまだ読み幅より広い(段落の左 ${np.l})── 狭い器を見ていない`).toBeLessThanOrEqual(2);
  expect(nt.l, `狭い器で表が左へはみ出している(左 ${nt.l})`).toBeGreaterThanOrEqual(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **本文の置き場所を選べる**(#722、2026-09-08)。
 *
 * unit は「トークンが在るか / 規則がトークンを読んでいるか」しか見られない ──
 * **実際に本文が左へ寄るか**は実ブラウザでしか分からない
 * (`margin-inline: var(--prose-lead) auto` の解決と、`auto` の潰れ方)。
 *
 * 観測点は 3 つ:
 * ① 既定(中央)で段落の左右の余白が同じ
 * ② 「左」にすると**段落の左端が 0 になり、右に余白が残る**
 * ③ 🔴 **表・図・コードも一緒に動く** ── 片方だけ効くと「段落は左端なのに
 *    表だけ内側」という食い違いが出る(トークン 2 つが対で動いていることの証拠)
 */
test('🔴 本文の置き場所を「左」にすると、段落も表も左端へ寄る (#722)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('置き場所');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(
      '段落です。読み幅いっぱいに広がるくらいの長さを持たせてあります。\n\n' +
        '| 品名 | 数量 |\n|---|---|\n| りんご | 3 |\n',
    );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-field="detail-body"] table').first(),
    '読む面に表が出ていない',
  ).toBeVisible({ timeout: 15_000 });

  const box = async (sel: string): Promise<{ l: number; r: number; w: number }> =>
    page.evaluate((s) => {
      // ⚠ **中身で選ぶ**(同じ名前の器が分割プレビュー側にも在る ── 上の test と同じ罠)
      const host = [...document.querySelectorAll('[data-pkc-field="detail-body"]')].find(
        (el) => el.querySelector('p') !== null,
      );
      if (host === undefined) throw new Error('前提が崩れている: 散文の器が無い');
      const hr = host.getBoundingClientRect();
      const el = host.querySelector(s);
      if (el === null) throw new Error(`前提が崩れている: ${s} が描かれていない`);
      const r = el.getBoundingClientRect();
      return {
        l: Math.round(r.left - hr.left),
        r: Math.round(hr.right - r.right),
        w: Math.round(r.width),
      };
    }, sel);

  // ① 既定は中央 ── 左右の余白が同じ
  const before = await box('p');
  expect(
    Math.abs(before.l - before.r),
    `既定で中央に無い(左 ${before.l} / 右 ${before.r})`,
  ).toBeLessThanOrEqual(2);
  // ⚠ 空振り防止 ── 余白が 0 なら「左へ寄った」も自明に成り立つ
  expect(before.l, '器と読み幅が同じで、寄せを見ていない').toBeGreaterThan(20);

  // ② 設定から「左」にする(実際の導線)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="prose-align-select"]').selectOption('start');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  await expect.poll(async () => (await box('p')).l, { timeout: 5000 }).toBeLessThanOrEqual(2);
  const left = await box('p');
  expect(left.r, `左へ寄せたのに右に余白が残っていない(右 ${left.r})`).toBeGreaterThan(20);
  // ⚠ 幅は変えない ── 変わったら読み幅の上限まで巻き込んでいる
  expect(Math.abs(left.w - before.w), '読み幅まで変わっている').toBeLessThanOrEqual(2);

  // ③ 🔴 表も一緒に動く(トークン 2 つが対で効いている証拠)
  const t = await box('.pkc-md-block[data-pkc-md-block-kind="table"]');
  expect(t.l, `段落は左端なのに表が内側に在る(表 ${t.l})`).toBeLessThanOrEqual(2);

  // ④ 戻せる ── 「中央」を選べば元どおり
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="prose-align-select"]').selectOption('center');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect.poll(async () => (await box('p')).l, { timeout: 5000 }).toBeGreaterThan(20);

  expect(errors, `例外が出ている: ${errors.join(' / ')}`).toEqual([]);
});
