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
 * ⑤ 🔴 **編集に入っても段のままか**(#523、2026-08-28 に向きを裏返した)──
 *    直す前は「解ける」を pin していたが、それはこちら側の判断だった
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

/**
 * 🔴 **編集中の器を採る**(#523)。
 *
 * ⚠ `readGeom` は `detail-body` しか見ない ── 編集中はその器が居ないので
 *   **全部 0 を返す**(「編集中は採寸できない」を表す設計だった)。
 *   段組みのまま編集する以上、**器は `editor-live` に替わる**ので別に採る。
 * 🔑 どちらの器かも返す ── 「段になった」と「どこが段になったか」は別の主張である。
 */
async function editGeom(page: Page): Promise<{
  on: boolean;
  host: string;
  lefts: number;
  /** 開いている箱の、器の下からのはみ出し(px)。⚠ 正なら**打った字が見えない**。 */
  boxOver: number;
  boxH: number;
  /** 箱が器の中に見えているか(上下とも器の内側)。 */
  boxInView: boolean;
  boxCol: number;
}> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-pkc-view-pane="detail"]');
    const on = pane?.hasAttribute('data-pkc-columns-on') ?? false;
    const live = document.querySelector('[data-pkc-region="editor-live"]') as HTMLElement | null;
    const body = document.querySelector('[data-pkc-field="detail-body"]') as HTMLElement | null;
    const host = live ?? body;
    if (host === null)
      return { on, host: '(無い)', lefts: 0, boxOver: 0, boxH: 0, boxInView: false, boxCol: -1 };
    // ⚠ **見えている段だけ数える**(`readGeom` と同じ理由 ── 溢れた段は右外に並ぶ)
    const hb = host.getBoundingClientRect();
    const lefts = new Set(
      [...host.children]
        .map((k) => Math.round(k.getBoundingClientRect().left))
        .filter((x) => x >= Math.round(hb.left) - 1 && x < Math.round(hb.right)),
    );
    const ta = document.querySelector('[data-pkc-field="row-source"]') as HTMLElement | null;
    if (ta === null)
      return {
        on, host: live ? 'editor-live' : 'detail-body', lefts: lefts.size,
        boxOver: 0, boxH: 0, boxInView: false, boxCol: -1,
      };
    const r = ta.getBoundingClientRect();
    const colW = ta.offsetWidth + 16; // 段幅 + すき間(CSS の `column-gap`)
    return {
      on,
      host: live ? 'editor-live' : 'detail-body',
      lefts: lefts.size,
      boxOver: Math.round(r.bottom - hb.bottom),
      boxH: Math.round(r.height),
      boxInView: r.top >= hb.top - 1 && r.bottom <= hb.bottom + 1
        && r.left >= hb.left - 1 && r.right <= hb.right + 1,
      boxCol: Math.round((r.left - hb.left + host.scrollLeft) / colW),
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

test('🔴 狭い画面では自動で 1 段に戻り、編集に入っても段のまま (#505 段① / #523)', async ({
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
   * ⑤ 🔴 **編集に入っても解けない**(#523。user 指示 2026-08-28
   * 「**段組のままでインライン編集がしたい**」)。
   *
   * ⚠ **2026-08-28 に向きを裏返した検査である。** ここは元々
   *   「編集に入ると解ける」を pin していた ── その判断はこちら側が下したもので
   *   (「user の字が『閲覧時に』だから」)、今回の要望と正面から食い違っていた。
   * 🔑 **向きを裏返したら、空振り防止も置き直す**(CLAUDE.md §1)──
   *   「印が残っている」だけでは、**印だけ残って段が 1 本**でも緑になる。
   *   だから**段が実際に 2 本以上できていること**まで見る。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-region="editor-live"]')).toBeVisible();
  await expect
    .poll(async () => (await editGeom(page)).on, {
      message: '編集に入ると段組みが解ける(#523 の要望と逆)',
      timeout: 5_000,
    })
    .toBe(true);
  const inEdit = await editGeom(page);
  expect(inEdit.host, '段組みの器が編集の面になっていない').toBe('editor-live');
  expect(inEdit.lefts, '印は在るのに段が 1 本しかない(空振り)').toBeGreaterThanOrEqual(2);
  // 対照群 ── 読む面へ戻しても段のまま(戻す道が壊れていないこと)
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

/**
 * 🔴 **段組みで、縦に長い図と写真が段からはみ出さない**(#527。user 指示 2026-08-28)。
 *
 * > 「**段組時に縦に長い図をレンダリングすると画面外にはみ出る**」
 *
 * 🔴 直す前の実測(2560×1000 / 3 段 / 30 節点の `graph TD`):
 *   図の高さ 2867px に対し器は 522px ── **2345px がはみ出し、見えているのは 18.2%**。
 *   縦に長い写真も **17.4%** しか見えていなかった。
 * ⚠ そして **user には戻す手段が 1 本も無い** ── 縦のホイールは横送りへ
 *   読み替えられ(`installColumnWheel`)、`overflow-y: hidden` なので
 *   スクロールバーも出ず、器の外は `elementFromPoint` にも当たらない。
 * 🔑 `read-columns.ts:108-121` が 1 度直した「**画面から本文が消えて誰も
 *   気づかない**」と**同じ穴の別経路**である。
 *
 * ⚠ **この spec の既存の fixture は図も画像も 0 件**だった ── だから
 *   `:183-185` の「縦へはみ出していない」という不変量が**破れているのに鳴らなかった**
 *   (CLAUDE.md「fixture のゼロ件の次元は、測っていない次元」)。
 */
const TALL_FIGURE =
  '```mermaid\ngraph TD\n' +
  Array.from({ length: 28 }, (_, i) => `  N${i}["節点 ${i}"]-->N${i + 1}["節点 ${i + 1}"]`).join(
    '\n',
  ) +
  '\n```\n';

test('🔴 段組みで縦に長い図が段に収まり、押し所も同じ段に残る (#527)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 1000 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  /**
   * ⚠ **図の前に本文を置く**(1 稿目で踏んだ)── 図だけだと**段の頭から始まる**ので、
   *   「段をまたいで割れる」場面が 1 度も起きない。実際、この行が無いと
   *   `break-inside: avoid` を外す変異が**生き延びた**(= 何も守っていなかった)。
   * 🔑 段の途中から始まる高さにする ── 段は約 620px なので、その半分ほど埋める。
   */
  const LEAD = Array.from({ length: 6 }, (_, i) => `前置きの段落 ${i}。段の途中から図が始まるようにする。`).join(
    '\n\n',
  );
  await live
    .locator('[data-pkc-field="row-source"]')
    .fill(`# 縦に長い図\n\n${LEAD}\n\n${TALL_FIGURE}`);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const fig = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(fig).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 40_000 });

  /** 図の幾何。⚠ **器の内側の底**と比べる(器そのものの底ではない ── padding がある)。 */
  const shape = async (): Promise<{
    natural: number;
    shown: number;
    over: number;
    frags: number;
    sameColumn: boolean;
  }> =>
    page.evaluate(() => {
      const host = document.querySelector('[data-pkc-field="detail-body"]') as HTMLElement;
      const box = host.querySelector('[data-pkc-mermaid-src]') as HTMLElement;
      const img = box.querySelector('img') as HTMLImageElement;
      const save = box.querySelector('[data-pkc-field="diagram-save"]');
      const hb = host.getBoundingClientRect();
      const ib = img.getBoundingClientRect();
      const sb = save?.getBoundingClientRect() ?? null;
      const inner = hb.bottom - (Number.parseFloat(getComputedStyle(host).paddingBottom) || 0);
      return {
        natural: img.naturalHeight,
        shown: Math.round(ib.height),
        over: Math.round(ib.bottom - inner),
        // 🔑 段をまたいで割れると断片が 2 つになる
        frags: box.getClientRects().length,
        // 押し所が図と同じ段に在るか(段の幅より近ければ同じ段)
        sameColumn: sb === null ? false : Math.abs(sb.x - ib.x) < 200,
      };
    });

  // ① 🔴 **空振り防止** ── この図が**本当に縦に長い**(短ければ以下は自明に通る)
  const one = await shape();
  expect(one.natural, '図が縦に長くない(この次元を測れていない)').toBeGreaterThan(1500);
  expect(one.over, '1 段でもはみ出している(段組み固有でない = 別の話)').toBeLessThanOrEqual(0);

  // ② 3 段にする
  await setColumns(page, '3');
  await expect(fig).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 40_000 });
  await expect
    .poll(async () => (await readGeom(page)).on, { timeout: 5_000 })
    .toBe(true);

  const three = await shape();
  // ③ 🔴 **はみ出していない**(直す前は +2345px、見えているのは 18.2% だった)
  expect(three.over, `段からはみ出している(${three.over}px。user には戻す手段が無い)`).toBeLessThanOrEqual(
    0,
  );
  // ④ ⚠ **小さくなって見えている**(器ごと消えて「はみ出し 0」になる実装を落とす)
  expect(three.shown, '図が消えている').toBeGreaterThan(50);
  expect(three.shown, '段の高さに収まっていない').toBeLessThan(one.shown);
  // ⑤ 🔴 **段をまたいで割れていない** ── 割れると押し所が別の段へ落ちる
  expect(three.frags, '図の器が段をまたいで割れている').toBe(1);
  expect(three.sameColumn, '「図を保存」が図と別の段に落ちている').toBe(true);

  /**
   * ⑥ 🔴 **縮めた図を、実寸で見る道が在る**(#527 案 A)。
   *
   * ⚠ ③④ は「はみ出さないように**縮めた**」であって、**読めるようになった**とは
   *   言っていない ── 縮めた分を取り戻す道が無ければ、user は
   *   「切れない代わりに読めない」だけである。**そこがこの案 A の存在理由**である。
   * 🔑 だから観測点は「別窓が開いた」ではなく
   *   **別窓の実寸が、いま画面に出ている大きさより大きいこと** ── ここが等しければ、
   *   「大きく見る」と言いながら同じ大きさを出していることになる。
   */
  const [win] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src] img').click(),
  ]);
  await win.waitForLoadState('domcontentloaded');
  const big = await win.evaluate(() => {
    const i = document.querySelector('[data-pkc-field="asset-window-image"]') as HTMLImageElement;
    return { natural: i?.naturalHeight ?? 0, shown: Math.round(i?.getBoundingClientRect().height ?? 0) };
  });
  expect(big.natural, '別窓の絵が読めていない(この検査は何も見ていない)').toBeGreaterThan(0);
  expect(
    big.shown,
    `段で縮めた図を実寸で見られない(段では ${three.shown}px / 別窓では ${big.shown}px)`,
  ).toBeGreaterThan(three.shown);
  await win.close();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **読みながら段組みを切り替えられ、いま何段か言う**(#522 + #526)。
 *
 * > 「**段組表示を表示変更導線をセンターペインもしくはショートカット、
 * > コンテキストメニューに用意したいくらいには気に入った**」(#522)
 * > 「**段組表示設定の 2〜4 のどの数字を選んでもレンダリングは変わらなかった
 * > それはバグ?**」(#526)
 *
 * 🔑 **2 つを 1 か所で解く** ── 答えは「バグではない。**器の幅で頭打ちになる**」で、
 *   実測すると器が **928〜1390px のあいだは 2/3/4 が全部 2 段**になる。
 *   **決まっていなかったのは user に言うことだけ**だったので、押した所で言う。
 *
 * ⚠ 観測点を「段数が変わった」で止めない ── **画面に字が出たか**まで見る
 *   (変わらない幅では、字だけが唯一の答えになる)。
 */
test('🔴 Alt+C で段組みが回り、いま何段で出ているかを言う (#522 / #526)', async ({ page }) => {
  const errors = collectPageErrors(page);
  // ⚠ **わざと「頭打ちになる幅」で測る**(#526 が報告された形)── 広い画面だと
  //    3 段と 4 段が別々に出てしまい、この次元を測れない
  await page.setViewportSize({ width: 1500, height: 900 });
  await gotoApp(page);
  await writeNote(page);

  const status = page.locator('[data-pkc-region="status"]');
  const before = await readGeom(page);
  expect(before.on, '最初から段組みになっている(既定は 1 段のはず)').toBe(false);

  // ① 1 回押すと 2 段になり、**字が出る**
  await page.keyboard.press('Alt+c');
  await expect.poll(async () => (await readGeom(page)).on, { timeout: 5_000 }).toBe(true);
  await expect(status, '押しても何も言わない').toContainText('本文の段組み: 2 段');
  const two = await readGeom(page);
  expect(two.lefts, '2 段になっていない').toBe(2);

  // ② もう 1 回で 3 段。⚠ この器では **3 段を選んでも 2 段**のはず(#526 の形)
  await page.keyboard.press('Alt+c');
  await expect(status).toContainText('本文の段組み: 3 段');
  const three = await readGeom(page);
  // 🔴 **空振り防止** ── ここが「選んでも変わらない」場面であること自体を assert する
  expect(
    three.lefts,
    `この器では 3 段が出てしまう(幅 ${three.cW}px)── #526 の場面を再現できていない`,
  ).toBe(2);
  // 🔴 **だから字で言う** ── 変わらない理由が画面に在る
  await expect(
    status,
    '変わらないのに理由を言っていない(user が「バグ?」と思う形のまま)',
  ).toContainText('いまの画面では 2 段で出ています');

  // ③ 回って 1 段へ戻る(片道にしない)
  await page.keyboard.press('Alt+c'); // 4 段
  await expect(status).toContainText('本文の段組み: 4 段');
  await page.keyboard.press('Alt+c'); // 1 段
  await expect(status).toContainText('本文の段組み: 1 段');
  await expect.poll(async () => (await readGeom(page)).on, { timeout: 5_000 }).toBe(false);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **段の境界線を、user が濃くできる**(#525 段②)。
 *
 * > 「**段組の境界線を見たい。今は境界がわかりにくい**」
 *
 * 🔴 実測すると、既定の線は **コントラスト 1.52 : 1**(罫線 `205,210,217` /
 *   地 `255,255,255`)── 文字以外の要素の下限(WCAG 3 : 1)を大きく下回っていた。
 *
 * ⚠ **それでもこちらで濃さを決めない**(user 指示 2026-08-28
 *   「正直変更はユーザーに委ねて欲しい」/「user が選べる形にできるなら、
 *   そちらを先に出す」)── **既定は現行そのまま**で、選べるようにした。
 *
 * ⚠ 観測点は **画素**にする ── 「CSS が当たった」では、色が実際に濃くなったか
 *   分からない(`color-mix` が解決できない環境なら、宣言ごと捨てられる)。
 */
test('🔴 段の境界線を「はっきり」にすると、実際に濃くなる (#525)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 1000 });
  await gotoApp(page);
  await writeNote(page);
  await setColumns(page, '3');
  await expect.poll(async () => (await readGeom(page)).on, { timeout: 5_000 }).toBe(true);

  /** 段の境目の縦線を、器の画素から拾って**地との差**を返す。 */
  const ruleContrast = async (): Promise<{ rule: number[]; bg: number[]; diff: number }> =>
    page.evaluate(async () => {
      const host = document.querySelector('[data-pkc-field="detail-body"]') as HTMLElement;
      const b = host.getBoundingClientRect();
      // 段の境目 = 1 本目の段の右端 + すき間の半分
      const first = host.querySelector('p');
      const fb = first!.getBoundingClientRect();
      const x = Math.round(fb.right + 8);
      const y = Math.round(b.top + b.height / 2);
      // 画素は canvas 経由では取れない(DOM なので)── 計算値で代用せず、
      // 実際に当たっている色を `getComputedStyle` から読む
      const cs = getComputedStyle(host);
      const parse = (v: string): number[] =>
        (/rgba?\(([^)]+)\)/.exec(v)?.[1] ?? '0,0,0').split(',').slice(0, 3).map((n) => Number(n.trim()));
      void x;
      void y;
      return {
        rule: parse(cs.columnRuleColor),
        bg: parse(cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : cs.backgroundColor),
        diff: 0,
      };
    });

  /** 2 色の差(WCAG のコントラスト比)。 */
  const ratio = (a: number[], b: number[]): number => {
    const lin = (c: number): number => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c: number[]): number => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  const before = await ruleContrast();
  const thin = ratio(before.rule, before.bg);
  // 🔴 **空振り防止** ── 既定が薄いこと自体を assert する(濃かったらこの test は無意味)
  expect(thin, `既定がもう濃い(${thin.toFixed(2)}:1)── この次元を測れていない`).toBeLessThan(2.5);

  // 🔴 設定から「はっきり」を選ぶ(user が実際に触る導線)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const sel = page.locator('[data-pkc-field="column-rule-select"]');
  await expectReachable(page, sel);
  await sel.selectOption('clear');
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  await expect.poll(async () => (await readGeom(page)).on, { timeout: 5_000 }).toBe(true);

  const after = await ruleContrast();
  const clear = ratio(after.rule, after.bg);
  // 🔴 **実際に濃くなった**(宣言が捨てられていない)
  expect(clear, `「はっきり」にしても濃くならない(${clear.toFixed(2)}:1)`).toBeGreaterThan(thin);
  // ⚠ 文字以外の要素の下限(3:1)を満たす
  expect(clear, `「はっきり」でも基準に届かない(${clear.toFixed(2)}:1 / 下限 3:1)`).toBeGreaterThanOrEqual(3);

  /**
   * 🔴 **選んだ設定が、開き直しても残る**(変異試験 T5 が SURVIVED で教えた)。
   *
   * ⚠ 1 稿目は**同じ session の中でしか見ていなかった** ── 選んだ瞬間は
   *   `chooseColumnRule` が当てるので、**起動時に当てる 1 行を消しても緑**だった。
   *   つまり「次に開いたら元に戻る」という、いちばん腹の立つ壊れ方を見ていない。
   */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        page.evaluate(() => document.documentElement.getAttribute('data-pkc-column-rule')),
      { timeout: 5_000, message: '開き直したら段の線の設定が消えた' },
    )
    .toBe('clear');

  // ⚠ **戻せる**(片道にしない)
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await sel.selectOption('thin');
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect.poll(async () => (await readGeom(page)).on, { timeout: 5_000 }).toBe(true);
  const back = await ruleContrast();
  expect(ratio(back.rule, back.bg), '戻せない').toBeCloseTo(thin, 1);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **段組みのままインライン編集する**(#523。user 指示 2026-08-28
 * 「**段組のままでインライン編集がしたい**」)。
 *
 * ## 🔑 unit では原理的に見られない 3 つ
 *
 * happy-dom は採寸しないので、下は全部 0 になる:
 *
 * 1. **編集の器が本当に段へ流れるか**(段が 2 本以上できる)
 * 2. 🔴 **打っても段が変わらないか** ── 自作の対照群で測ったところ、
 *    段組みは前から順に詰めるので**箱より前の中身**だけが位置を決め、
 *    箱が伸びて押されるのは**後ろ**である。だから箱自身は動かない
 *    (実測 2026-08-28: 段の途中・上のほうで開いた場合 **0/6**)。
 *    ⚠ 唯一の例外は「段の残りに入りきらなくなった瞬間」で、そのときだけ
 *    **次の段のいちばん上**へ 1 回移る(以後は動かない)
 * 3. 🔴 **箱が段からはみ出さないか** ── 同じ実測で `rows=32` のとき
 *    **段の下へ 121px はみ出した**。縦ホイールは横送りに読み替えられ
 *    `overflow-y: hidden` なので、**はみ出した分に届く手段が 1 つも無い**
 *    = **自分が打った字が見えなくなる**(#527 の図と同じ穴。こちらのほうが重い)
 */
test('🔴 段組みのまま行を開いて打てて、箱が段からはみ出さない (#523)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1900, height: 800 });
  await gotoApp(page);
  await writeNote(page);
  await setColumns(page, '3');

  /**
   * ① 行を開く。⚠ **user の動線どおりに押す** ── 読んでいる本文から編集へ入るのは
   *   **Ctrl(mac は Command)+ クリック**である(2026-08-28 に変わった)。
   *   素のクリックはリンクや升のためのもので、行は開かない。
   */
  await page.locator('[data-pkc-field="detail-body"] p').nth(3).click({ modifiers: ['ControlOrMeta'] });
  const box = page.locator('[data-pkc-field="row-source"]');
  await expect(box).toBeVisible();

  const opened = await editGeom(page);
  expect(opened.host, '編集に入ったら器が段組みから外れた').toBe('editor-live');
  expect(opened.on, '編集に入ると段組みが解ける(#523 の要望と逆)').toBe(true);
  expect(opened.lefts, '印は在るのに段が 1 本しかない(空振り)').toBeGreaterThanOrEqual(2);
  expect(opened.boxInView, '開いた箱が器の外に居る(押した所に何も出ない)').toBe(true);

  /**
   * ② 🔴 **打っても段は彷徨わない ── 動くとしても 1 回だけ。**
   *
   * ⚠ **「1 度も動かない」と書いてはいけない**(2026-08-28 に 1 稿目でそう書いて落ちた)。
   *   実測が言っているのは「動くのは**段の残りに入りきらなくなった瞬間の 1 回だけ**で、
   *   行き先も**次の段のいちばん上**に決まっている」であって、0 回ではない。
   * 🔑 **後条件は、確かめた事実の上にだけ書く**(CLAUDE.md §1)── だから
   *   **変わった回数を数えて 1 以下**を見る。⚠ 「彷徨う」実装(打鍵ごとに流れ直る)は
   *   この検査で落ちる。
   * ⚠ 対照群として**箱が実際に伸びたこと**も見る ── 伸びていなければ
   *   「動かなかった」は何も主張していない(空振り)。
   */
  await box.click();
  const cols: number[] = [opened.boxCol];
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 2; i++) await page.keyboard.type('\n打った行 ' + round + '-' + i);
    const g = await editGeom(page);
    cols.push(g.boxCol);
    expect(g.boxInView, `打っている途中で箱が器の外へ出た(${round} 巡目)`).toBe(true);
  }
  const typed = await editGeom(page);
  expect(typed.boxH, '打ったのに箱が伸びていない(この検査は何も見ていない)').toBeGreaterThan(
    opened.boxH,
  );
  const moves = cols.filter((c, i) => i > 0 && c !== cols[i - 1]).length;
  expect(moves, `打つたびに段が変わっている(${cols.join(' → ')})`).toBeLessThanOrEqual(1);

  /**
   * ③ 🔴 **たくさん打っても段からはみ出さない**(打った字が見えなくなる穴)。
   * ⚠ 自作の対照群では `rows=32`(高さ 713px)で**段の下へ 121px** はみ出した。
   *   それを大きく超える量を打つ。
   */
  for (let i = 0; i < 40; i++) await page.keyboard.type('\nさらに打った行 ' + i);
  const grown = await editGeom(page);
  expect(grown.boxOver, `箱が段の下へ ${grown.boxOver}px はみ出した(打った字が見えない)`).
    toBeLessThanOrEqual(0);
  expect(grown.boxInView, '打っているうちに箱が器の外へ出た').toBe(true);

  /**
   * ④ 🔴 **箱の中をホイールで戻せる**(#523。実装しながら自分で作りかけた穴)。
   *
   * ⚠ 段組みの器はホイールの縦を**横送りへ読み替える**。編集の箱がその器の中へ
   *   入った以上、無条件に読み替えると **箱の中を送る手段が消える**
   *   ── 打った字は箱の下に増えるので、**読み返すのは必ず上向き**である。
   * 🔑 観測点は「箱の `scrollTop` が実際に動いたか」と
   *   「**段は動いていない**か」の 2 つ ── 片方だけだと、
   *   「両方動いた」を見抜けない。
   */
  /**
   * ⚠ **段を左端から動かしておく**(変異試験 WS が SURVIVED で教えた)。
   *   器そのものが左端(`scrollLeft === 0`)だと、逃がしを丸ごと外しても
   *   **器の「送り切っていたら既定に返す」規則に救われて**箱が素で送れてしまう
   *   ── CLAUDE.md §1「救い手が変わっただけ」の形である。
   */
  await page.evaluate(() => {
    const host = document.querySelector('[data-pkc-region="editor-live"]') as HTMLElement;
    host.scrollLeft = 120;
  });
  const before = await page.evaluate(() => {
    const ta = document.querySelector('[data-pkc-field="row-source"]') as HTMLElement;
    const host = document.querySelector('[data-pkc-region="editor-live"]') as HTMLElement;
    return { top: ta.scrollTop, room: ta.scrollHeight - ta.clientHeight, left: host.scrollLeft };
  });
  expect(before.left, '段を左端から動かせていない(この検査は救い手に守られる)').toBeGreaterThan(0);
  expect(before.top, '箱が下まで送られていない(上へ戻す余地が無い = 空振り)').toBeGreaterThan(0);
  expect(before.room, '箱が段の高さに収まっていて、中を送る余地が無い(空振り)').toBeGreaterThan(0);
  await box.hover();
  await page.mouse.wheel(0, -400); // 上へ戻す
  await expect
    .poll(async () =>
      page.evaluate(() => (document.querySelector('[data-pkc-field="row-source"]') as HTMLElement).scrollTop),
    { message: '箱の中を上へ戻せない(打った字を読み返せない)', timeout: 3_000 })
    .toBeLessThan(before.top);
  const after = await page.evaluate(() =>
    (document.querySelector('[data-pkc-region="editor-live"]') as HTMLElement).scrollLeft);
  expect(after, '箱の中を送るつもりが、段まで横へ動いた').toBe(before.left);

  // ⑤ 確定して読む面へ戻っても、段のまま
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect
    .poll(async () => (await readGeom(page)).on, { message: '戻ると段が解ける', timeout: 5_000 })
    .toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **設定の「いまの画面では N 段で出ています」が、実際に出る**(#526 / #551)。
 *
 * ⚠ **この注記は、配った日から 1 度も出ていませんでした**(2026-08-29 に判明)。
 *   `syncColumnsEffective` が `detail-body` を採寸していたが、**設定画面が出ている間
 *   読む面は `hidden` = 幅 0** なので、必ず早期 return で空文字になっていた。
 *   ⚠ `grep read-columns-effective` は **src の 2 行だけ、test は 0 件** ──
 *   誰も守っていなかったので、機能が丸ごと死んでいることに誰も気づけなかった。
 *
 * 🔑 **unit では原理的に届きません** ── happy-dom は採寸しないので、
 *   直す前も直した後も「幅 0 → 空文字」で同じ結果になる。
 *   実ブラウザで**字が出ること**を見るしかない。
 */
test('🔴 設定に「いま何段で出ているか」が実際に書かれる (#526 / #551)', async ({ page }) => {
  const errors = collectPageErrors(page);
  // ⚠ **段組が成立する幅**にする(912px 未満だと「足りない」側の字になる)
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);
  // 🔑 この file の作法で本文を入れる(自前で `fill` しない ── 面の作りが違う)
  await writeNote(page);

  // 設定で 2 段にする(`setColumns` は届くことを確かめてから値を入れる)
  await setColumns(page, '2');
  // ⚠ 注記を読むのは**設定画面の上**である(`setColumns` は本文へ戻らない作りではない)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  const note = page.locator('[data-pkc-field="read-columns-effective"]');
  const text = (await note.textContent()) ?? '';

  // ① 🔴 **空でない**(ここが「配った日から出ていなかった」ことの検算)
  expect(text.trim(), '🔴 注記が空 ── 読む面が hidden なので採寸できていない').not.toBe('');

  // ② 🔴 **段数が書いてある**(空でないだけなら、別の字でも通ってしまう)
  expect(text, `段数が書かれていない(出た字: ${text})`).toMatch(/\d+\s*段/);

  expect(errors, 'ページ例外が出ている').toEqual([]);
});

/**
 * 🔴 **段組みが畳まれたら、理由を画面に出す**(#551。user 報告 2026-08-29)。
 *
 * > 「**段組表示の際、左右のペインサイズを変化させると、段組の境界線が壊れる**」
 *
 * ⚠ 実測すると「線が壊れる」ではなく **段組みごと黙って消えていた** ──
 *   器が 912px を割った瞬間に縦送りへ戻り、**予告も説明も 1 文字も出ない**。
 * 🔑 畳むこと自体は正しい設計(#505)なので、直すのは**黙っていること**である。
 *
 * ⚠ **unit では原理的に届かない部分がある** ── happy-dom は採寸しないので、
 *   矩形を手で置いた unit は「窓を縮めたら畳まれる」という**当の出来事**を
 *   1 度も通らない。ここは**本物の器の幅**で通す。
 */
test('🔴 窓を狭めて段組みが畳まれると、理由が帯に出る (#551)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2560, height: 900 });
  await gotoApp(page);
  await writeNote(page);
  await setColumns(page, '2');

  /** ⚠ **前提** ── いま本当に段組みで出ている(空振り防止)。 */
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '前提が崩れた(そもそも段組みになっていない)',
  ).toHaveAttribute('data-pkc-columns-on', '');

  const status = page.locator('[data-pkc-region="status"]');
  // ⚠ 縮める**前**に帯が出ていないこと(後で出た文字が最初から在った、を作らない)
  // ⚠ **文言を丸ごと当てる**(#606 の 2 巡目レビュー R-10)── 口を 1 つに寄せたので
  //   「幅が足りない」は**枠の帯**(「…横に並べる枠を N 枚畳みました」)にも当たる。
  //   この spec は枠を 1 枚も留めないので今は空振りしないが、将来足したときに
  //   **別の口に満たされる**(CLAUDE.md §1「救い手が変わっただけ」)。
  await expect(status).not.toContainText('幅が足りないので段組みをやめました');

  // 🔴 912px を割る幅へ縮める
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(status, '畳まれたのに理由が出ない').toContainText('幅が足りないので段組みをやめました');
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '帯は出たが段組みは畳まれていない(帯が嘘)',
  ).not.toHaveAttribute('data-pkc-columns-on', '');

  // 🔑 **戻る道も見る**(片道にしない)
  await page.setViewportSize({ width: 2560, height: 900 });
  await expect(status, '戻ったのに黙っている').toContainText('段組みに戻しました');

  expect(errors, 'ページ例外が出ている').toEqual([]);
});
