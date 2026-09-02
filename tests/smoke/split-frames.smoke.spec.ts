import { test, expect, type Page } from '@playwright/test';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  useListBrowse,
  useSplitEditor,
} from './helpers';

/** 右クリックのメニュー(`context-menu.smoke.spec.ts` と同じ在り処)。 */
const MENU = '[data-pkc-region="context-menu"]';

/**
 * 🔴 **読む面を横に並べて、枠ごとに別のノートを出す**(#505 段②。user 指示 2026-08-28)。
 *
 * > 「ウルトラワイドモニター用に閲覧時にセンターペインを任意分割して、
 * > **複数ドキュメントを開いたり**…」
 *
 * 🔴 **unit では原理的に届かない層**(happy-dom は採寸も送りもしない):
 * ① **本当に横に並ぶか** ── 2 つの枠の左端が違うこと
 * ② 🔴 **枠ごとに送れるか** ── 片方を送っても、もう片方の `scrollTop` が動かないこと
 * ③ **右クリックから留められるか** ── 実物のメニューを実物のマウスで押す
 * ④ **外せるか**(置けるなら外せる)
 */

/**
 * 送れるだけの長さが要る(短いと②が空振りする)。
 *
 * ⚠ **段落は空行で分ける**(2026-08-29 に踏んだ)── 単一改行で並べると
 * `breaks: true` の markdown が **1 つの `<p>` に 60 行**を入れるので、
 * その**中央**を押すために画面が大きく送られ、⚠ **開いた直後のメニューが
 * `scroll` で閉じる**(`onCloseMenu` は capture の `scroll` を見ている)。
 * 症状は「メニューが出る回と出ない回がある」で、**製品ではなく押し方の問題**である
 * (既存の `context-menu.smoke.spec.ts` は空行で分けていて、そちらは安定している)。
 */
const LONG = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段落の本文。`).join('\n\n');

/**
 * ⚠ **作った直後は編集の面に居る**ので `start-edit` は押さない
 * (`context-menu.smoke.spec.ts` と同じ作法)。
 */
async function writeBody(page: Page, text: string): Promise<void> {
  await page.locator('[data-pkc-field="editor-body"]').fill(text);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  /**
   * 🔴 **描き終わるまで待つ**(2026-08-29、この test を書いていて踏んだ)。
   *
   * ⚠ 本文は worker 越しに描かれるので、`detail-body` が**見えているだけ**では
   * まだ塊が入れ替わる。そこで段落を右クリックすると、**押した瞬間にその節点が
   * 差し替わって** contextmenu が誰にも届かない ── 症状は「メニューが出る回と
   * 出ない回がある」という間欠で、**test の書き方の問題**である
   * (製品は正しく、押す前提が崩れていた)。
   * 🔑 `detail.ts` は描けたら `data-pkc-painted` にその lid を焼く ── それを待つ。
   */
  await expect(
    page.locator('[data-pkc-field="detail-body"][data-pkc-painted]').first(),
  ).toBeAttached();
}

/** 枠の位置と送り。 */
async function frames(page: Page): Promise<{ x: number; top: number; lid: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-region="split-frame"]')].map((el) => ({
      x: Math.round(el.getBoundingClientRect().x),
      top: Math.round((el as HTMLElement).scrollTop),
      lid: el.getAttribute('data-pkc-split-lid') ?? '(主)',
    })),
  );
}

/** ⚠ 打ち込みを安定させる仕込み(`context-menu.smoke.spec.ts` と同じ)。 */
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

test('🔴 本文を右クリックして横に留めると、2 つの枠が並び、枠ごとに送れる (#505 段②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  // ⚠ ウルトラワイドを想定した機能なので、窓を広く取る(狭いと自動で畳む)
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await writeBody(page, `# 資料 A\n\n${LONG}`);
  await createEntry(page, 'text');
  await writeBody(page, `# 資料 B\n\n${LONG}`);

  // ③ 本文を右クリック → 「このノートを横に留める」
  // ⚠ **段落の上で押す**(器の中央は余白に当たる ── context-menu smoke と同じ作法)
  await page.locator('[data-pkc-field="detail-body"] p').first().click({ button: 'right' });
  const menu = page.locator(MENU);
  // ⚠ **前提**: メニューが開いたこと(開かなかった回を「押せなかった」と読まない)
  await expect(menu, '本文で右クリックしてもメニューが出ない').toBeVisible();
  await menu.locator('button[data-pkc-action="pin-split"]').click();

  // ① 横に並んだ ── 枠が 2 つ、左端が違う
  await expect(page.locator('[data-pkc-split-lid]')).toHaveCount(1);
  const two = await frames(page);
  expect(two, '主 + 留めた枠の 2 つ').toHaveLength(2);
  expect(two[1]!.x, '2 つ目は右に在る').toBeGreaterThan(two[0]!.x);

  // ② 🔴 枠ごとに送れる ── 留めた枠だけ送って、主が動かないこと
  /**
   * 🔴 **押す前に「送れる高さが在る」ことを待つ**(2026-08-29、CI で落ちて分かった)。
   *
   * ⚠ 1 稿目は `scrollTop = 200` を代入して、その後で「0 より大きい」を見ていた ──
   * つまり**前提を assert せずに仮定していた**。本文は worker 越しに描かれるので、
   * 器に中身が入る前に代入すると `scrollTop` は**黙って 0 に丸められる**。
   * ⚠ 手元では 4 走とも緑で、CI(shard 2、同じ headless_shell)でだけ落ちた ──
   * CI のほうが速いので、押す瞬間が描画より前へ寄ったのだと読む
   * (CLAUDE.md 2026-08-27「CI は 25〜35% 速い。疑うのは待ち不足ではなく順番」)。
   * 🔑 これは test を緩めているのではない ── **仮定していた前提を、待って確かめる**
   * 形にしただけで、成り立たなければここで落ちる。
   */
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-pkc-split-lid]');
          return el === null ? 0 : el.scrollHeight - el.clientHeight;
        }),
      { message: '留めた枠に送れる高さが無い(本文がまだ入っていない)' },
    )
    .toBeGreaterThan(0);
  await page.locator('[data-pkc-split-lid]').first().evaluate((el) => {
    (el as HTMLElement).scrollTop = 200;
  });
  const after = await frames(page);
  expect(after[1]!.top, '留めた枠は送れた').toBeGreaterThan(0);
  expect(after[0]!.top, '主の枠は動いていない').toBe(0);

  // 🔴 **一覧を押しても、留めた枠は動かない**(横に並べて突き合わせる、が成立する)
  await page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first().click();
  await expect(
    page.locator('[data-pkc-split-main] [data-pkc-field="detail-body"] h1').first(),
    '主の枠が押したノートへ入れ替わっていない',
  ).toContainText('資料 A');
  await expect(
    page.locator('[data-pkc-split-lid] [data-pkc-field="split-body"] h1').first(),
    '留めた枠が一緒に動いてしまった',
  ).toContainText('資料 B');

  /**
   * 🔴 **段組み(段①)と喧嘩しない** ── 段組みが効くかは**枠の幅**で決まる。
   *
   * ⚠ 器の幅で判定していると、並べて枠が狭くなっても「2 段置ける」と誤判定し、
   * **横送りだけが残る**(#505 段① が 1 度出荷しかけた形)。
   * 🔑 枠は 1600px を 2 つに割った幅なので、段組みの下限(912px)に届かない ──
   * だから **段組みは効かないのが正しい**。
   */
  await page.keyboard.press('Alt+c');
  // ⚠ 前提: 設定そのものは動いた(空振りで通っていない)
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-pkc-read-columns')))
    .not.toBe('1');
  expect(
    await page.evaluate(() =>
      document.querySelector('[data-pkc-view-pane="detail"]')?.hasAttribute('data-pkc-columns-on'),
    ),
    '枠が狭いのに段組みが効いている(器の幅で判定している)',
  ).toBe(false);

  // ④ 外せる
  await clickReal(page, '[data-pkc-action="unsplit-entry"]');
  await expect(page.locator('[data-pkc-split-lid]')).toHaveCount(0);
  // 🔑 外した後も本文は生きている(器の出し入れで壊していない)
  await expect(page.locator('[data-pkc-field="detail-body"]').first()).toBeVisible();

  expect(errors, 'ページ例外 0 件').toEqual([]);
});

/**
 * 🔴 **狭い窓で枠が 0 枚 ⇄ 3 枚に入れ替わり続ける / 窓を狭めても畳まない**(#608)。
 *
 * ## 🔴 unit では原理的に届かない
 *
 * 振動の原因は「何も並べていない間の器が `display: contents` で**幅 0**」である。
 * happy-dom は**そもそも採寸しない**ので、器も面も 0 ── **どちらを測っていても
 * 同じ答え**になり、区別できない。🔑 だから**実ブラウザで、実際に狭めて**見る。
 *
 * ## 見るのは 2 つ
 *
 * ① **窓を狭めただけで畳む**(押さなくても) ── 直す前は 900px で 203px の枠が 3 枚
 * ② **押しても入れ替わらない** ── 直す前は押すたびに 0 / 3 / 0 / 3
 */
test('🔴 狭い窓では枠が畳まれ、押しても入れ替わらない (#608)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await writeBody(page, `# 資料 A\n\n${LONG}`);
  await createEntry(page, 'text');
  await writeBody(page, `# 資料 B\n\n${LONG}`);

  await page.locator('[data-pkc-field="detail-body"] p').first().click({ button: 'right' });
  await expect(page.locator(MENU), 'メニューが出ない').toBeVisible();
  await page.locator(MENU).locator('button[data-pkc-action="pin-split"]').click();

  /**
   * 出ている枠の数(主 + 留め)。
   *
   * ⚠ **`[data-pkc-region="split-frame"]` を数えない** ── 1 枠まで畳むと
   * `mark(false)` が主の印を外すので、**0 件**になる(枠は在るのに 0 と読める)。
   * 🔑 数えるのは**留めた枠 + 主の 1**(unit 側と同じ数え方)。
   */
  const count = async (): Promise<number> =>
    (await page.locator('[data-pkc-split-lid]').count()) + 1;

  /**
   * ⚠ **前提 = 対照群** ── 広い窓では 2 枠出ている。
   *
   * 🔴 1 稿目は「3 枠」と書いて落ちた ── 2 枚留めても、1600px の窓の**面**は
   * 3 枠ぶん(448 × 3 + 16 × 2 = 1376px)に届かないので、**正しく 2 枠**である。
   * ⚠ 前提を assert していなければ、「押しても入れ替わらなかった」を
   * **畳みが 1 度も起きていない回**で言うところだった。
   */
  expect(await count(), '広い窓で 2 枠出ていない(台の前提)').toBe(2);

  /**
   * 🔴 **各枠が下限を満たしている** ── #608 の「203px の枠が 3 枚」の直接の否定。
   * ⚠ 見るのは**枠の中身の幅**(留めた枠には `border-left` + `padding-left` が
   * 付くので、外寸で見ると甘く読める)。
   */
  const inner = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-region="split-frame"]')].map((el) => {
      const cs = getComputedStyle(el);
      const num = (v: string): number => Number.parseFloat(v) || 0;
      return Math.round(
        el.getBoundingClientRect().width -
          num(cs.paddingLeft) -
          num(cs.paddingRight) -
          num(cs.borderLeftWidth) -
          num(cs.borderRightWidth),
      );
    }),
  );
  expect(inner.length, '枠が 1 つも無い').toBe(2);
  for (const w of inner) {
    // ⚠ 1 枠の下限は本文の文字の大きさに載る(標準 13px なら 448px)
    expect(w, `枠が下限より狭い: ${inner.join(' / ')}`).toBeGreaterThanOrEqual(448);
  }

  // ① 🔴 **押さずに窓だけ狭める** ── これで畳めば `ResizeObserver` が効いている
  await page.setViewportSize({ width: 900, height: 900 });
  await expect
    .poll(count, { message: '窓を狭めても畳まない(resize を見ていない)' })
    .toBe(1);

  // 🔴 **黙って消していない**(#606 の口が生きていること)
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '枠を畳んだのに理由が出ていない',
  ).toContainText('幅が足りないので');

  // ② 🔴 **押しても入れ替わらない**(直す前は 0 / 3 / 0 / 3)
  const seen: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').nth(i % 2).click();
    await expect(page.locator('[data-pkc-split-main]')).toBeVisible();
    seen.push(await count());
  }
  expect(new Set(seen).size, `押すたびに枠数が入れ替わっている: ${seen.join(' / ')}`).toBe(1);
  expect(seen[0], '狭めた直後と、押した後で枠数が違う').toBe(1);

  expect(errors, 'ページ例外 0 件').toEqual([]);
});

/**
 * 🔴 **留めた並びは、開き直しても残る**(#505 段②「憶える」── 2026-09-02、#633 の調査で
 * **一度も成立していなかった**と判明)。
 *
 * ⚠ 直す前:起動直後の描画の購読が、復元より**前**に空の並びを localStorage へ書いていた。
 *   お知らせ(2026-08-31)もマニュアル(§「横に並べて読む」)も「次に開いても同じ枠が
 *   出ます」と書いていたのに、開き直すと**毎回外れていた**。
 * ⚠ unit では原理的に届かない ── `main.ts` の**購読と復元の順番**の話で、`main.ts` は
 *   どの test からも実行されない(原文 pin は `bootstrap-wiring.test.ts`)。
 * 🔑 R1: 直す前の dist でこの test が赤いことを見てから直した(2026-09-02 実測)。
 */
test('🔴 横に留めた枠は、開き直しても留まったまま出る (#505 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await writeBody(page, `# 資料 A\n\n${LONG}`);
  await createEntry(page, 'text');
  await writeBody(page, `# 資料 B\n\n${LONG}`);
  await page.locator('[data-pkc-field="detail-body"] p').first().click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, '本文で右クリックしてもメニューが出ない').toBeVisible();
  await menu.locator('button[data-pkc-action="pin-split"]').click();
  await expect(page.locator('[data-pkc-split-lid]')).toHaveCount(1);
  const lid = await page.locator('[data-pkc-split-lid]').first().getAttribute('data-pkc-split-lid');
  expect(lid, '留めた枠に lid が無い(前提が崩れている)').toBeTruthy();
  // ⚠ 前提:憶えた(ここが空なら、以降の「戻った」は何も言わない)
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem('pkc3.split-lids')), {
      message: '留めたのに憶えていない',
    })
    .toContain(lid!);

  // 🔴 開き直す ── 直す前はここで空を書いてから読んでいたので、枠が外れていた
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-pkc-split-lid]'), '開き直したら枠が外れた').toHaveCount(1);
  await expect(page.locator('[data-pkc-split-lid]').first()).toHaveAttribute(
    'data-pkc-split-lid',
    lid!,
  );
  await expect(
    page.locator('[data-pkc-split-lid] [data-pkc-field="split-body"] h1').first(),
    '枠は戻ったが中身が入っていない',
  ).toContainText('資料 B');

  // 対照群:外して開き直せば、外れたまま(「全部外した」も憶える ── 片道にしない)
  await clickReal(page, '[data-pkc-action="unsplit-entry"]');
  await expect(page.locator('[data-pkc-split-lid]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-pkc-split-lid]'), '外したのに開き直したら戻った').toHaveCount(0);

  expect(errors, 'ページ例外 0 件').toEqual([]);
});
