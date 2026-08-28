import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, expectReachable } from './helpers';

/**
 * 🔴 **読む面の段組み送り**(#505 段①。user 指示 2026-08-28)。
 *
 * > 「**ウルトラワイドモニター用に閲覧時にセンターペインを任意分割して…
 * > 一つの縦に長いドキュメントを分割ウィンドウ全体でスクロールしながら見る
 * > オプションが欲しい**」
 *
 * 🔴 **unit では原理的に届かない層**(happy-dom は採寸しないので全部 0):
 * ① **本文が本当に段へ流れるか** ── 段の左端が 2 つ以上に分かれること
 * ② **送りが縦から横へ変わるか** ── `scrollWidth > clientWidth` になること
 * ③ 🔴 **縦のホイールで横へ送れるか** ── 実測でこれが**効かない**ことが分かり、
 *    読み替えを実装に入れた。⚠ 効かなければ**マウスだけで読めない**
 *    (不可侵指示 2026-08-03)
 * ④ **狭い画面で 1 段へ畳むか** ── `columns: <最小幅> <段数>` に任せてある
 * ⑤ **編集に入ると解けるか** ── selector が持っている(JS を書いていない)
 */

/** ⚠ 段が 2 本以上できるだけの長さが要る(短いと①②が空振りする)。 */
const BODY = [
  '# 議事録',
  '',
  ...Array.from(
    { length: 40 },
    (_, i) => `第 ${i + 1} 段落。横幅を使って読むための本文です。段組みにしたとき、次の段の上へ続くかを見ます。\n`,
  ),
].join('\n');

/** 本文の器の採寸と、段の左端の数。 */
async function readGeom(page: Page): Promise<{
  cW: number;
  sW: number;
  cH: number;
  sH: number;
  lefts: number;
  scrollLeft: number;
  on: boolean;
  columnCount: string;
  inlineH: string;
  /** CSS が決めた段の下限(`column-width`)。⚠ #509 はここが動くかの話である。 */
  columnWidth: string;
  /** 本文の器の `font-size`(px)。⚠ 段の下限はこれに載る。 */
  fontPx: number;
}> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-pkc-view-pane="detail"]');
    const on = pane?.hasAttribute('data-pkc-columns-on') ?? false;
    const body = document.querySelector('[data-pkc-field="detail-body"]') as HTMLElement | null;
    // ⚠ **編集中は本文の器ごと居ない** ── 採寸できないことを 0 で表す(落とさない)
    if (body === null) {
      return {
        cW: 0, sW: 0, cH: 0, sH: 0, lefts: 0, scrollLeft: 0, on,
        columnCount: '(無い)', inlineH: '', columnWidth: '(無い)', fontPx: 0,
      };
    }
    /**
     * 🔴 **見えている段だけ数える**(#505 で 1 度外した観測点)。
     * ⚠ 溢れた段は画面の右外に並ぶので、素直に数えると狭い画面でも「5 段」に
     *   見える ── user が見ているのは**器の中に入っている段**である。
     */
    const bb = body.getBoundingClientRect();
    const lefts = new Set(
      [...body.children]
        .map((k) => Math.round(k.getBoundingClientRect().left))
        .filter((x) => x >= Math.round(bb.left) - 1 && x < Math.round(bb.right)),
    );
    return {
      cW: body.clientWidth,
      sW: body.scrollWidth,
      cH: body.clientHeight,
      sH: body.scrollHeight,
      lefts: lefts.size,
      scrollLeft: Math.round(body.scrollLeft),
      on,
      columnCount: getComputedStyle(body).columnCount,
      inlineH: body.style.height,
      columnWidth: getComputedStyle(body).columnWidth,
      fontPx: Number.parseFloat(getComputedStyle(body).fontSize),
    };
  });
}

async function setColumns(page: Page, value: string): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="read-columns-select"]');
  // 🔑 押さずに「届くこと」だけ確かめる(`<select>` は押すと OS の一覧が開く)
  await expectReachable(page, select);
  await select.selectOption(value);
  // ⚠ 本文へ戻る道は**一覧の行を押す**(`set-view` に `detail` は無い)
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  /**
   * ⚠ **`toBeVisible()` では早すぎる。**
   *
   * 本文の器は**骨組みと一緒に**作られるので、markdown が届く前から「見えて」いる。
   * 段の高さが決まるのは**本文が入った直後**(markdown はワーカー越しに後から来る)
   * なので、ここで待たないと**まだ 1 段のところを測る**ことになる。
   * 🔑 待つのは印(`data-pkc-columns-on`)── user から見た「段になった」瞬間である。
   */
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: `段組み(${value})にならない`,
      timeout: 10_000,
    })
    .toBe(value !== '1');
}

/**
 * 文字の大きさを user と同じ手順で変える(設定画面 → 本文へ戻る)。
 * ⚠ `setColumns` と同じ形にする(2 本目の作法を作らない)。
 */
async function setTextScale(page: Page, value: string): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="text-scale-select"]');
  await expectReachable(page, select);
  await select.selectOption(value);
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  // ⚠ 当たったことを**画面から**確かめる(選んだ = 効いた、にしない)
  await expect
    .poll(async () => (await readGeom(page)).fontPx, {
      message: `文字の大きさ(${value})が本文に届かない`,
      timeout: 10_000,
    })
    .toBe(Number.parseFloat({ small: '12px', standard: '13px', large: '15px', xlarge: '17px' }[value] ?? '13px'));
}

async function writeNote(page: Page): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(BODY);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] p').first()).toBeVisible();
}

test('🔴 段組みにすると本文が段へ流れ、縦のホイールで横へ送れる (#505 段①)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 900 }); // ウルトラワイド相当
  await gotoApp(page);
  await writeNote(page);

  /**
   * ⚠ **空振り防止 / 対照群** ── 既定は 1 段で、**縦に送る**。
   * ここが最初から段組みだと、以下は「変わった」を見ていない。
   */
  const before = await readGeom(page);
  expect(before.lefts, '既定なのに段が分かれている').toBe(1);
  expect(before.sW, '既定なのに横へ送れる').toBeLessThanOrEqual(before.cW + 1);
  /**
   * 🔴 **既定では段組みの CSS が 1 本も当たっていない**(変異試験 M12 が教えた)。
   * ⚠ 「段が 1 つに見える」だけでは足りない ── `columns: 448px 1` が当たっていても
   *   段は 1 つに見えるので、**印を見ずに当てる**変異が生き延びる。
   */
  expect(before.on, '選んでいないのに段組みの印が付いている').toBe(false);
  expect(before.columnCount, '既定なのに段組みの CSS が当たっている').toBe('auto');
  expect(before.inlineH, '既定なのに高さを固定している').toBe('');

  await setColumns(page, '2');

  // ① 本文が段へ流れた
  const after = await readGeom(page);
  expect(after.lefts, '2 段にしたのに段が分かれていない').toBeGreaterThanOrEqual(2);
  /**
   * ② 送りが横になった。
   * ⚠ **1 回読むだけで見る**(待たない)── 待つ形にすると、
   *   「最初の採寸が間違っていて、見張りが後から直した」を**素通りさせる**。
   *   実際そういう欠陥が在り、待つ test では 4 走中 2 走しか落ちなかった。
   */
  expect(after.sW, '横へ送れない(段が溢れていない)').toBeGreaterThan(after.cW);
  /**
   * 🔴 **本文が黙って消えていない**(#505 でいちばん危なかった所)。
   *
   * ⚠ 高さを flex に決めさせると、ブラウザは**段を増やさずに縦へ溢れさせ**、
   *   `overflow-y: hidden` がそれを刈る ── 実測で **87px 見えなくなっていた**。
   * 🔑 「縦にはみ出していない」= 溢れた分が段へ回っている、の 1 行不変量である。
   */
  expect(after.sH, '本文が縦へはみ出している(その分が画面から消えている)').toBeLessThanOrEqual(
    after.cH + 1,
  );

  /**
   * ③ 🔴 **縦のホイールで横へ送れる**。
   * ⚠ ここが実装の要 ── 素の CSS では**1px も動かない**(実測 1727 → 1727)。
   */
  const box = await page.locator('[data-pkc-field="detail-body"]').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 600);
  await expect
    .poll(async () => (await readGeom(page)).scrollLeft, {
      message: '縦のホイールで横へ送れない(マウスだけで読めない)',
      timeout: 5_000,
    })
    .toBeGreaterThan(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 段組みで送った位置が、編集から戻っても残る (#505 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 900 });
  await gotoApp(page);
  await writeNote(page);
  await setColumns(page, '2');

  /**
   * 🔴 **送りの向きが変わっても、位置を憶えている**こと。
   *
   * ⚠ いまの縦送りでは `detail.ts` が `scrollTop` を憶えている ── 段組みで
   *   **横だけ憶えない**と、編集して戻るたびに**先頭へ飛ぶ**。
   *   それは user から見て「さっきまで読んでいた所が消える」であり、
   *   動線を 1 つ失うのと同じである(user 指示 2026-08-22)。
   */
  const host = page.locator('[data-pkc-field="detail-body"]');
  await host.evaluate((el) => {
    el.scrollLeft = 900;
  });
  const sent = (await readGeom(page)).scrollLeft;
  // ⚠ **空振り防止** ── そもそも送れていないなら、以下は何も見ていない
  expect(sent, '送れていない(段が溢れていない)').toBeGreaterThan(0);

  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-region="editor-live"]')).toBeVisible();
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(host).toBeVisible();

  await expect
    .poll(async () => (await readGeom(page)).scrollLeft, {
      message: '編集から戻ったら先頭へ飛んだ(読んでいた所が消える)',
      timeout: 5_000,
    })
    .toBe(sent);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 狭い画面では自動で 1 段に戻り、編集に入ると段組みが解ける (#505 段①)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 900 });
  await gotoApp(page);
  await writeNote(page);
  await setColumns(page, '3');

  const wide = await readGeom(page);
  expect(wide.lefts, '広い画面で 3 段にならない(前提が崩れている)').toBeGreaterThanOrEqual(2);
  // ⚠ ここで「横へ送れる」は**前提にできない** ── 3 段だと本文が収まってしまい、
  //   溢れないのが正しい(1 度そう書いて落とした)。見るのは段になったことだけ。

  /**
   * ④ 🔴 **狭くしたら 1 段へ畳む**(#505 の要件)。
   * 🔑 数えているのは自前のコードではなく `columns: <最小幅> <段数>` である ──
   *   最小幅を下回る段は作られない。
   */
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '狭い画面なのに段組みのまま',
      timeout: 5_000,
    })
    .toBe(false);
  /**
   * 🔴 **畳んだら「ふつうの縦送り」へ戻っている**こと。
   * ⚠ 段数が 1 になるだけでは足りない ── **横送りが残ると、ノート PC で
   *   「横スクロールで 1 段ずつめくる」画面**になる(実測でそうなっていた)。
   */
  const narrow = await readGeom(page);
  expect(narrow.lefts, '狭い画面なのに段が分かれている').toBe(1);
  expect(narrow.sW, '狭い画面なのに横送りが残っている').toBeLessThanOrEqual(narrow.cW + 1);

  // ⚠ 設定は**変えていない**(畳んだのは表示だけ)── 広げたら戻る
  await page.setViewportSize({ width: 2560, height: 900 });
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '広げても段へ戻らない(設定が失われている)',
      timeout: 5_000,
    })
    .toBe(true);
  expect((await readGeom(page)).lefts, '広げたのに段が 1 つのまま').toBeGreaterThanOrEqual(2);

  /**
   * ⑤ 🔴 **編集に入ると解ける**(user の字が「閲覧時に」)。
   * ⚠ JS を書いていない ── selector の `[data-pkc-detail-mode='view']` が持つ。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-region="editor-live"]')).toBeVisible();
  /**
   * ⚠ **「編集に入った」ではなく「段組みが解けた」を見る** ── 面の名前だけ見ると、
   *   CSS の `view` 限定を外しても緑のままになる(空振り)。
   */
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '編集に入っても段組みの印が残っている(DOM が嘘をつく)',
      timeout: 5_000,
    })
    .toBe(false);
  // 対照群 ── 読む面へ戻せば、また段になる
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect
    .poll(async () => (await readGeom(page)).on, { message: '戻っても段に戻らない', timeout: 5_000 })
    .toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
/**
 * 🔴 **文字の大きさが段組みに載る**(#509。user 指示 2026-08-28)。
 *
 * > 「**ここにユーザーによるフォントサイズ変更やブラウザの拡大率変更などが載って
 * > くれば、ユーザーは好みで見ることができるようになるはず**」
 *
 * 🔴 **unit では原理的に届かない** ── happy-dom は採寸しないので `column-width` も
 *   `font-size` も読めない。ここでしか「CSS が本当にその幅にした」は見られない。
 *
 * ⚠ 直す前は段の下限が**固定 448px** だったので、文字を大きくしても段は狭いまま
 *   だった(特大で **26 文字**。可読幅の下端 34 を大きく下回る)。
 */
test('🔴 文字を大きくすると段も広がり、狭い器では畳む (#509)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 900 });
  await gotoApp(page);
  await writeNote(page);
  await setColumns(page, '2');

  /**
   * 🔑 **見るのは px ではなく「1 段に入る全角の字数」**。
   * ⚠ px で pin すると、文字の大きさを 1 段階足しただけで落ちる検査になる ──
   *   守りたいのは**字数が保たれること**である。
   */
  const std = await readGeom(page);
  expect(std.on, '前提が崩れている(広い画面で段組みにならない)').toBe(true);
  expect(std.fontPx, '既定の本文が 13px でない(前提が違う)').toBe(13);
  const stdChars = Number.parseFloat(std.columnWidth) / std.fontPx;
  // 空振り防止 ── `column-width` が `auto` なら NaN になる
  expect(stdChars, '段の下限が読めない(auto のまま)').toBeGreaterThan(30);

  await setTextScale(page, 'xlarge');
  const big = await readGeom(page);
  expect(big.on, '特大にしたら段組みが消えた(広い画面なのに)').toBe(true);
  /**
   * 🔴 **これが #509 の本題** ── 下限が px 固定なら、ここは
   *   `448 / 17 = 26.4` に落ちる。⚠ 対照群は上の標準(約 34.5)である。
   */
  expect(
    Number.parseFloat(big.columnWidth) / big.fontPx,
    '文字を大きくしたのに、1 段に入る字数が減った(下限が px 固定のまま)',
  ).toBeCloseTo(stdChars, 1);

  /**
   * 🔴 **畳む境目も一緒に動く**。⚠ ここが動かないと、**標準なら 2 段になる幅**で
   *   段 1 本しか置けず、**横スクロールで 1 段ずつめくる**画面になる
   *   (#505 が潰したはずの症状が、文字を大きくした user にだけ戻る)。
   * 🔑 器 ≒ 912px = 標準のちょうど境目(実測 2026-08-28)。
   */
  await page.setViewportSize({ width: 1424, height: 900 });
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '特大なのに、標準の境目の幅で段組みを続けている',
      timeout: 5_000,
    })
    .toBe(false);
  const folded = await readGeom(page);
  expect(folded.sW, '畳んだのに横送りが残っている').toBeLessThanOrEqual(folded.cW + 1);

  /**
   * ⚠ **対照群 / 片道でないこと** ── 同じ幅のまま標準へ戻せば、段組みは戻る。
   *   これが無いと「特大では常に畳む」だけの検査になり、境目を見ていない。
   */
  await setTextScale(page, 'standard');
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '標準へ戻したのに段組みが戻らない(片道になっている)',
      timeout: 5_000,
    })
    .toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
/**
 * 🔴 **面を出入りせずに設定を変えても、段組みの判定が古びない**(#509)。
 *
 * ⚠ **これは user の手順ではない**(いまは設定画面を経由するしかない)。
 *   ここで直に属性を書くのは、`applyTextScale` / `applyReadColumns` が当てるのと
 *   **同じ形**である(2 本目の当て先を作っていない)。
 * 🔑 **設定画面を経由してはいけない** ── 戻るときに面が出入りして
 *   `ResizeObserver` が**偶然**測り直すので、配線を外しても緑になる
 *   (1 稿目はそう書いていて、変異試験 M5 / M6 が **2 件とも SURVIVED** で教えた)。
 *
 * 🔑 **何をどこまで守っているか**(計装して数えた。2026-08-28):
 *   - **段数**(`data-pkc-read-columns`)── 根の属性の見張りを外すと、
 *     選んだ瞬間に**印がそもそも付かない**(`RO` も `inner` も鳴らない)。
 *     ✅ ここは殺せる
 *   - ⚠ **文字の大きさ** ── 見張りから外しても、**いまは `RO` が拾う**
 *     (面の高さが中身に追随しているため。段組み中は `flex: 1 1 0` で
 *     追随しない**はず**なので、これは設計が効き切っていない偶然である)。
 *     🔴 **この test はその 1 行を殺せない** ── だから「配線を守っている」とは
 *     書かない。守っているのは**結果**(畳む / 戻る)である
 */
test('🔴 面を出入りせずに設定を変えても、段組みが古びない (#509)', async ({ page }) => {
  const errors = collectPageErrors(page);
  // 🔑 器 ≒ 912px = 標準のちょうど境目(実測 2026-08-28)
  await page.setViewportSize({ width: 1424, height: 900 });
  await gotoApp(page);
  await writeNote(page);

  /** ⚠ `applyReadColumns` / `applyTextScale` と同じ形(属性 + CSS 変数)。 */
  const put = async (attr: string, value: string, cssVar: string, cssValue: string) => {
    await page.evaluate(
      ([a, v, k, cv]) => {
        document.documentElement.setAttribute(a!, v!);
        document.documentElement.style.setProperty(k!, cv!);
      },
      [attr, value, cssVar, cssValue],
    );
  };

  // ⚠ **空振り防止 / 対照群** ── 選ぶ前は 1 段(縦送り)である
  expect((await readGeom(page)).on, '選んでいないのに段組みの印が付いている').toBe(false);

  // 🔴 段数を「面を出入りせずに」選ぶ ── 見張りが無ければ、ここで印が付かない
  await put('data-pkc-read-columns', '2', '--pkc-read-cols', '2');
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '段数を選んでも、面を出入りするまで効かない(入力の見張りが無い)',
      timeout: 5_000,
    })
    .toBe(true);

  /**
   * ⚠ **対照群** ── 同じ大きさを書き直しても畳まないこと。
   *   これが無いと「属性を書けば必ず畳む」だけの検査になり、境目を見ていない。
   */
  await put('data-pkc-text-scale', 'standard', '--pkc-text-size', '13px');
  await page.waitForTimeout(300);
  expect((await readGeom(page)).on, '同じ大きさを書き直しただけで畳んだ').toBe(true);

  await put('data-pkc-text-scale', 'xlarge', '--pkc-text-size', '17px');
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '面を出入りしていないと、文字を大きくしても測り直さない',
      timeout: 5_000,
    })
    .toBe(false);

  // ⚠ 片道でないこと ── 戻せば段組みも戻る
  await put('data-pkc-text-scale', 'standard', '--pkc-text-size', '13px');
  await expect
    .poll(async () => (await readGeom(page)).on, {
      message: '戻したのに段組みが戻らない',
      timeout: 5_000,
    })
    .toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **サイドの面を畳んでも、段組みが正しく組み直る**(#525。user 報告 2026-08-28)。
 *
 * > 「**サイドのペインを隠すと段組レンダリングの境界線表示がおかしくなるので、
 * > 再レンダリングのタイミングを再検討して欲しい**」
 *
 * ⚠ **この組み合わせを見る smoke は 1 件も無かった** ── この file の 5 本に
 *   `toggle-pane` は 1 度も出てこない(CLAUDE.md「fixture のゼロ件の次元は、
 *   測っていない次元」)。だから「畳んだら崩れる」を**誰も落とせなかった**。
 *
 * ⚠ 直す前は、畳んだことが段組みへ届く道が **`ResizeObserver` の偶然**しか
 *   無かった(`applyPaneVisibility` は `fitColumnHeight` を 1 度も呼んでいない)。
 *   実測した遅れは 1 フレームだが、**規約としては誰も面倒を見ていなかった**。
 *
 * 🔑 観測点は「線が見える」ではなく **段の幾何**にする ── 画素は配色で変わるが、
 *   「器いっぱいに段が並び、縦に溢れていない」は配色に依らない。
 */
test('🔴 サイドの面を畳んでも、段組みが器いっぱいに組み直る (#525)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 1000 });
  await gotoApp(page);
  await writeNote(page);
  await setColumns(page, '3');

  const before = await readGeom(page);
  // 空振り防止 ── 畳む前に**本当に段になっている**(なっていなければ以下は自明)
  expect(before.on, '畳む前から段組みになっていない(この次元を測れていない)').toBe(true);
  expect(before.lefts, '畳む前に段が分かれていない').toBeGreaterThanOrEqual(2);

  // 🔴 一覧を畳む(user が実際に押す導線)
  await clickReal(page, '[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]');

  /**
   * ⚠ **「幅が広がったこと」を待ってから測る** ── 固定 sleep を積まない。
   *   畳んだ瞬間と組み直った瞬間は最大 1 フレームずれる(実測 25ms)。
   */
  await expect
    .poll(async () => (await readGeom(page)).cW, {
      message: '畳んでも器が広がらない(畳む導線が効いていない)',
      timeout: 5_000,
    })
    .toBeGreaterThan(before.cW);

  const after = await readGeom(page);
  // ① 段組みのまま(畳んだ拍子に解けていない)
  expect(after.on, '畳んだら段組みが解けた').toBe(true);
  expect(after.lefts, '畳んだら段が 1 本になった').toBeGreaterThanOrEqual(2);
  // ② 🔴 **縦へ溢れていない**(溢れた分は `overflow-y: hidden` が刈る = 画面から消える)
  expect(after.sH, '畳んだら本文が縦へはみ出した(その分が画面から消えている)').toBeLessThanOrEqual(
    after.cH + 1,
  );
  // ③ 段の高さが器に合っている(古い高さを持ち越していない)
  expect(after.inlineH, '段の高さが当たっていない').not.toBe('');

  // 🔴 **戻せる**(片道だけ直っている実装を落とす)
  await clickReal(page, '[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]');
  await expect
    .poll(async () => (await readGeom(page)).cW, { timeout: 5_000 })
    .toBeLessThan(after.cW);
  const back = await readGeom(page);
  expect(back.on, '戻したら段組みが解けた').toBe(true);
  expect(back.sH, '戻したら本文が縦へはみ出した').toBeLessThanOrEqual(back.cH + 1);

  expect(errors).toEqual([]);
});
