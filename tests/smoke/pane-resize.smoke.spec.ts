/**
 * 🔴 **掴んで大きさを変える**(#497)を、実ブラウザで見る。
 *
 * > user 指示 2026-08-27:「**この枠のサイズは可変にし、ユーザーが変更できるように
 * > して欲しい。追記メインで使う場合はわくを大きくしたいとか、閲覧メインで使う時は
 * > 消したいとかあると思う。リサイズニーズは、両サイドペインも一緒だと思う**」
 *
 * ## ⚠ ここでしか見られないもの(unit で足りない理由)
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 **列が本当に太くなる** | happy-dom は寸法を持たない ── 変数を書いたことしか見えない |
 * | 🔴 `clamp(0px, Npx, 45vw)` が**効く** | CSS の計算そのもの |
 * | 🔴 追記欄の帯が `:has()` で**出たり消えたり**する | happy-dom は `:has()` を解決しない |
 * | 実マウスの掴み(`setPointerCapture`) | 合成 event では捕まえが起きない |
 *
 * 🔑 観測点は**面の実寸**にする(`boundingBox().width`)── 変数の字面を見ると、
 *   「変数は書いたが CSS が読んでいない」を素通りする(§4「計器の名前が範囲より広い」)。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
} from './helpers';

const SHELL = '[data-pkc-region="shell"]';
const grip = (pane: string) => `[data-pkc-region="pane-grip"][data-pkc-pane="${pane}"]`;

async function widthOf(page: Page, region: string): Promise<number> {
  const box = await page.locator(`[data-pkc-region="${region}"]`).boundingBox();
  return box?.width ?? 0;
}

/** 帯を掴んで動かす。⚠ **途中に 1 点入れる** ── 一気に飛ばすと `pointermove` が 1 度も出ない。 */
async function dragGrip(page: Page, pane: string, dx: number, dy = 0): Promise<void> {
  const box = await page.locator(grip(pane)).boundingBox();
  expect(box, `${pane}: 帯が画面に無い`).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2);
  await page.mouse.move(x + dx, y + dy);
  await page.mouse.up();
}

test('🔴 左の列を掴んで広げられ、読み直しても覚えている (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  const before = await widthOf(page, 'sidebar');
  expect(before, '一覧が出ていない').toBeGreaterThan(100);
  await dragGrip(page, 'sidebar', 120);
  const after = await widthOf(page, 'sidebar');
  /**
   * ⚠ **ぴったりの値では見ない** ── 掴んだ位置は帯の中心なので、始点は
   * 数 px ずれる。見るのは「**動かした向きへ、動かしたぶん近く動いた**」こと。
   */
  expect(after, `広げたのに太くならない(${before} → ${after})`).toBeGreaterThan(before + 90);

  // 🔴 **覚える** ── 読み直しても同じ幅
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  const reloaded = await widthOf(page, 'sidebar');
  expect(Math.abs(reloaded - after), `読み直しで幅が戻った(${after} → ${reloaded})`).toBeLessThan(4);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **右の面は左へ引くと広がる。** ⚠ 向きを取り違えた実装は、掴んだ瞬間に
 * 分かるのに、**変数の字面しか見ない test では永久に緑**である。
 */
test('🔴 右の列は左へ引くと広がる (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  const before = await widthOf(page, 'inspector');
  expect(before, '情報が出ていない').toBeGreaterThan(100);
  await dragGrip(page, 'inspector', -120);
  const after = await widthOf(page, 'inspector');
  expect(after, `左へ引いたのに広がらない(${before} → ${after})`).toBeGreaterThan(before + 90);

  expect(errors, 'pageerror が出た').toEqual([]);
});

test('🔴 押しただけなら畳み、掴んで動かした直後は畳まれない (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  // ① 押す = 畳む(#197 の既存の動きを壊していない)
  await page.locator(grip('sidebar')).click();
  expect(await widthOf(page, 'sidebar'), '押しても畳めない').toBe(0);
  // ⚠ **帯は残る**(残らないと二度と戻せない)
  await expect(page.locator(grip('sidebar')), '畳んだら帯まで消えた').toBeVisible();
  await page.locator(grip('sidebar')).click();
  expect(await widthOf(page, 'sidebar'), '押しても戻らない').toBeGreaterThan(100);

  /**
   * ② 🔴 **掴んで動かした後に畳まれない。** ⚠ ブラウザは指を離した後に `click` も
   * 撃つので、捨てていないと**広げた直後にその面が消える**。
   */
  await dragGrip(page, 'sidebar', 100);
  expect(
    await widthOf(page, 'sidebar'),
    '広げた直後に畳まれた(離したときの click を捨てていない)',
  ).toBeGreaterThan(100);

  expect(errors, 'pageerror が出た').toEqual([]);
});

test('🔴 小さくしすぎると畳まれ、押せば元の大きさで戻る (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await dragGrip(page, 'sidebar', 100);
  const wide = await widthOf(page, 'sidebar');
  expect(wide).toBeGreaterThan(200);

  await dragGrip(page, 'sidebar', -600);
  expect(await widthOf(page, 'sidebar'), '小さくしても畳まれない(0 px の面が残る)').toBe(0);
  await expect(page.locator(grip('sidebar')), '畳んだら帯まで消えた').toBeVisible();

  // 🔑 **元の大きさで戻る** ── 畳むときに大きさまで捨てていない
  await page.locator(grip('sidebar')).click();
  const back = await widthOf(page, 'sidebar');
  expect(Math.abs(back - wide), `戻したのに幅が違う(${wide} → ${back})`).toBeLessThan(4);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **決めた幅のせいで本文が消えない**(#497 の「狭い画面で壊れない」)。
 * ⚠ `clamp(0px, Npx, 45vw)` が効いていないと、狭くしたときに一覧が
 *   画面のほとんどを占めて本文が潰れる ── **CSS の計算そのもの**なので
 *   ここでしか見られない。
 */
test('🔴 広げた後で画面を狭めても、本文は残る (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);

  await dragGrip(page, 'sidebar', 300);
  expect(await widthOf(page, 'sidebar'), '広がっていない').toBeGreaterThan(400);

  await page.setViewportSize({ width: 900, height: 900 });
  const side = await widthOf(page, 'sidebar');
  const center = await widthOf(page, 'center');
  expect(side, `狭めても一覧が縮まない(${side})`).toBeLessThanOrEqual(900 * 0.45 + 2);
  expect(center, `本文が潰れた(一覧 ${side} / 本文 ${center})`).toBeGreaterThan(300);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **追記欄の帯**(#497)。⚠ 出るのは**ノートを開いているとき**だけ ──
 * 開いていない回に帯だけ浮いていると、押しても何も起きない導線になる。
 * 🔑 `:has()` で決めているので、**実ブラウザでしか確かめられない**。
 */
test('🔴 追記欄の帯は、ノートを開いたときだけ出る (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  // ノートを 1 件も開いていない ── 追記欄が無いので帯も出ない
  await expect(
    page.locator(grip('append')),
    '追記欄が無いのに帯だけ出ている(押しても何も起きない導線)',
  ).toBeHidden();

  await createEntry(page, 'text');
  /**
   * ⚠ **作った直後は編集中** ── そのとき追記欄は「自分が編集を握っている」を出す
   * 器に変わり、打つ欄は出ない。保存してから見る(実物の動線と同じ順)。
   */
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-region="append"]')).toBeVisible();
  await expect(page.locator(grip('append')), 'ノートを開いても帯が出ない').toBeVisible();

  // 🔴 掴んで高くする ── 観測点は**打つ欄の実寸**
  const input = page.locator('[data-pkc-field="append-input"]');
  const before = (await input.boundingBox())?.height ?? 0;
  expect(before, '打つ欄が出ていない').toBeGreaterThan(10);
  await dragGrip(page, 'append', 0, -80);
  const after = (await input.boundingBox())?.height ?? 0;
  expect(after, `上へ引いたのに高くならない(${before} → ${after})`).toBeGreaterThan(before + 50);

  // 🔴 押すと消え、帯は残る(「閲覧メインで使う時は消したい」)
  await page.locator(grip('append')).click();
  await expect(page.locator('[data-pkc-region="append"]'), '押しても消えない').toBeHidden();
  await expect(page.locator(grip('append')), '消したら戻す口まで消えた').toBeVisible();
  await page.locator(grip('append')).click();
  await expect(page.locator('[data-pkc-region="append"]'), '押しても戻らない').toBeVisible();

  expect(errors, 'pageerror が出た').toEqual([]);
});

/** 🔴 **掴めない人も同じことができる**(帯に `Tab` で移り、矢印キー)。 */
test('🔴 矢印キーでも幅が変わる (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  const before = await widthOf(page, 'sidebar');
  await page.locator(grip('sidebar')).focus();
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
  const after = await widthOf(page, 'sidebar');
  expect(after, `鍵で広がらない(${before} → ${after})`).toBeGreaterThan(before + 60);
  // ⚠ 逆向きも見る(片道の操作を作らない)
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft');
  const backed = await widthOf(page, 'sidebar');
  expect(Math.abs(backed - before), `戻らない(${before} → ${backed})`).toBeLessThan(4);

  expect(errors, 'pageerror が出た').toEqual([]);
});

test('🔴 shell に変数が書かれ、CSS がそれを読んでいる (#497)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);
  await dragGrip(page, 'sidebar', 100);
  /**
   * ⚠ **変数の字面は「補助の観測点」である** ── 上の各 test が実寸を見ている。
   * ここで見るのは「**計算された列**が変数の値になっている」= CSS が読んでいる証拠。
   */
  const cols = await page.locator(SHELL).evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  const side = await widthOf(page, 'sidebar');
  expect(cols.split(/\s+/)[0], `列の値が実寸と違う(${cols})`).toBe(`${side}px`);
  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **畳んだら本文は広くなる ── 狭い窓でも**(#607)。
 *
 * ## user から見て何が起きていたか
 *
 * スマホ相当(480px)で一覧を畳むと、本文が **480px → 241px** に**狭くなった**。
 * ⚠ 畳むのは「本文を広く見たい」からなので、**逆に働いていた**。
 *
 * ## 🔴 unit では原理的に届かない
 *
 * 原因は **CSS の詳細度**である ── 畳んだ版面 `[shell][data-pkc-hidden-panes~='…']`
 * は **(0,2,0)**、狭い版面は `@media` の中の `[shell]` = **(0,1,0)** で、
 * **`@media` は詳細度を上げない**。happy-dom は CSS を組まないので、
 * どちらが勝つかは**実ブラウザでしか分からない**。
 *
 * 🔑 観測点は**本文の実寸** ── 版面の字面ではなく、user が見る幅を測る。
 */
/**
 * 🔴 **2026-09-02 に主張を書き換えた**(#632 段①)。
 *
 * ⚠ 直す前の主張は「480px で畳んでも本文が狭くならない」で、`Alt+[` が
 *   `data-pkc-hidden-panes` を**書くこと**を台の前提にしていた。スマホ用画面では
 *   `applyPaneVisibility` が**列の畳みを画面へ写さない**(列そのものが無い)ので、
 *   この前提は成り立たない ── そこで落ちるのは**正しい**。
 * 🔑 主張は同じ向きへ書き換える:**スマホでは畳む鍵を押しても本文が動かない**
 *   (押しても一覧ページが消えず、幅も変わらない)。⚠ 観測点は変えない
 *   ── 本文の実寸と、横にはみ出していないこと。
 * ⚠ **#607 そのものは 721px 以上の 2 列版面で見る**(下の腕)── あちらは
 *   いまも `@media (max-width: 1100px)` と頭の畳み規則が競う場所である。
 */
test('🔴 狭い窓でペインを畳んでも、本文は狭くならない (#607)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 480, height: 900 });
  await gotoApp(page);
  // ⚠ スマホの幅ではお知らせが画面いっぱい(user 裁定 2026-09-02)── 先に畳む
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  // ⚠ 作った直後は編集中 ── ← は断られるので、先に保存して閲覧へ出る
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const detail = async (): Promise<number> => widthOf(page, 'center');

  /**
   * ⚠ **前提 = 対照群** ── 畳む前の幅を採る。
   * 🔑 これが無いと「畳んだら広くなった」を**何とも比べずに**言うことになる。
   */
  const before = await detail();
  expect(before, '本文の幅を測れていない(台の空振り)').toBeGreaterThan(0);

  for (const [pane, chord] of [
    ['sidebar', 'Alt+BracketLeft'],
    ['inspector', 'Alt+BracketRight'],
  ] as const) {
    await page.keyboard.press(chord);
    /**
     * 🔴 **「鍵が届いた」を先に見る**(2026-09-02 の着地前レビュー 7)。
     * ⚠ 直す前の腕は `not.toHaveAttribute` だけだったので、**`Alt+[` が何も
     *   しなくても全部緑**だった ── 旧版は「畳めた」で鍵の到達を兼ねていたのに、
     *   裏返したときにその足場ごと落としていた(CLAUDE.md §1 の逆向き)。
     * 🔑 いまは断り文が出るので、それが**鍵が受け手まで届いた証拠**になる。
     */
    await expect(
      page.locator('[data-pkc-region="status"]'),
      `${pane}: 鍵が受け手まで届いていない(この腕は何も見ていない)`,
    ).toContainText('スマホの画面では');
    // 🔴 スマホでは畳みを**画面へ写さない** ── 写すと一覧ページが真っ白になる
    await expect(
      page.locator(SHELL),
      `${pane}: スマホなのに畳みを画面へ写している(一覧ページが消える)`,
    ).not.toHaveAttribute('data-pkc-hidden-panes', new RegExp(pane));
    const after = await detail();
    expect(after, `${pane} を押したら本文の幅が動いた: ${before} → ${after}`).toBe(before);
    // 🔴 保存値も動いていない(PC へ戻したとき身に覚えのない畳みが残らない)
    expect(
      // ⚠ 一度も書いていなければ `null` ── 「動いていない」の正しい姿なので '' に潰す
      await page.evaluate(() => localStorage.getItem('pkc3.panes') ?? ''),
      `${pane}: 見えないのに保存値が動いた`,
    ).not.toContain(pane);
  }

  /**
   * 🔴 **一覧ページはちゃんと出る**(#609 の行き止まりが戻っていない)。
   * ⚠ 上の 2 回の押下で保存値には `sidebar` が入りうる ── それでも
   *   ← 一覧 で一覧が出ること、が守りたい当のことである。
   */
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(
    page.locator('[data-pkc-region="sidebar"]'),
    '畳む鍵を押した後、一覧ページが出てこない',
  ).toBeVisible();
  const both = await detail();
  expect(both, `本文の幅が動いた: ${before} → ${both}`).toBe(before);

  /**
   * 🔴 **画面から溢れていない**(#586 と同じ実害の裏取り)。
   * ⚠ 「本文が広い」だけを見ると、**器ごと窓の外へ出た**回も合格になる。
   */
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, '横にはみ出している').toBeLessThanOrEqual(0);

  expect(errors, 'ページ例外 0 件').toEqual([]);
});

/**
 * 🔴 **追記欄も鍵で畳める**(#609)。
 *
 * ⚠ 直す前、畳める 3 面のうち**追記欄だけ**が「掴む帯は在るが鍵もパレットも無い」
 * 状態だった ── そして #607 と重なると、狭い窓では**マウスの戻し口も消えていた**。
 *
 * 🔑 unit は「登記が在る」までしか見られない ── **本当に畳むか**は
 * `COMMAND_TARGETS` → 実物のボタン → binder という配線を通って初めて分かるので、
 * ここで端から端まで 1 度通す(CLAUDE.md §7「両端が stub と話していると通る」)。
 */
test('🔴 追記欄も鍵で畳めて、戻せる (#609)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  const shell = page.locator(SHELL);

  // ⚠ 前提 ── 追記欄が出ていること(ノートを開いていないと器ごと無い)
  await expect(page.locator('[data-pkc-region="append"]'), '追記欄が出ていない').toBeVisible();
  await expect(shell, '最初から畳まれている(台の前提)').not.toHaveAttribute(
    'data-pkc-hidden-panes',
    /append/,
  );

  await page.keyboard.press('Alt+Backslash');
  await expect(shell, '鍵で畳めていない').toHaveAttribute('data-pkc-hidden-panes', /append/);
  await expect(page.locator('[data-pkc-region="append"]'), '印は付いたが消えていない').toBeHidden();

  // 🔴 **片道の操作を作らない**(2026-08-23)── 同じ鍵で戻る
  await page.keyboard.press('Alt+Backslash');
  await expect(shell, '同じ鍵で戻らない').not.toHaveAttribute('data-pkc-hidden-panes', /append/);
  await expect(page.locator('[data-pkc-region="append"]')).toBeVisible();

  // 🔴 **掴む帯は畳んでも残る**(#197 ── 鍵を知らない user の戻し口)
  await page.keyboard.press('Alt+Backslash');
  await expect(
    page.locator('[data-pkc-region="pane-grip"][data-pkc-pane="append"]'),
    '畳んだら掴む帯まで消えた(戻し口が無くなる)',
  ).toBeVisible();

  expect(errors, 'ページ例外 0 件').toEqual([]);
});
