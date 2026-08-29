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
