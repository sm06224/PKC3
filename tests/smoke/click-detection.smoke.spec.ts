/**
 * 🔴 **押す道具そのものを検める**(2026-08-27、#419 の作業中に穴と分かった)。
 *
 * `clickReal` / `expectReachable` は「その座標の最前面が target(かその子孫)か」を
 * 見てから押す ── **dead click / occlusion を捕まえる唯一の仕掛け**である。
 *
 * 🔴 **そして 55 本の spec がこれに乗っているのに、これ自身を検める test は
 *   1 本も無かった。** ⚠ 判定が黙って通るようになると、全部の `clickReal` が
 *   **ただのクリックに退化する** ── 覆われていても・`pointer-events:none` でも
 *   素通りし、**その日から dead click の回帰が 1 件も鳴らなくなる**。
 *   ⚠ しかも **suite は緑のまま**なので、誰も気づけない
 *   (CLAUDE.md「検品する側・test する側も変異試験の対象にする」)。
 *
 * 🔑 だから**対で置く**:届く場面で通り、**覆った場面で落ちる**。
 *   ⚠ 片側だけでは足りない ── 「常に通る」実装も「常に落ちる」実装も、
 *   片側の test だけなら緑にできる。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, expectReachable } from './helpers';

/** 押す相手は何でもよい ── 常に画面に在るものを選ぶ。 */
const TARGET = '[data-pkc-action="set-browse"]';

test('🔴 素の画面では届く(対照群 ── これが落ちたら以降の判定は無意味)', async ({ page }) => {
  await gotoApp(page);
  const { x, y } = await expectReachable(page, page.locator(TARGET).last());
  expect(x, '座標が出ていない').toBeGreaterThan(0);
  expect(y, '座標が出ていない').toBeGreaterThan(0);
});

test('🔴 覆うと落ちる ── 検出力が生きている', async ({ page }) => {
  await gotoApp(page);
  /**
   * ⚠ **ほぼ透明で覆う**(`rgba(0,0,0,.01)`)── 見た目では気づけないのに
   *   押せなくなる、という**実際に踏む形**を再現する。
   * ⚠ `opacity: 0` にはしない ── それでも当たり判定は残るが、
   *   「見えないから覆っていない」と読み違える人が出る。
   */
  await page.evaluate(() => {
    const o = document.createElement('div');
    o.setAttribute('data-pkc-test-overlay', '');
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.01)';
    document.body.appendChild(o);
  });

  let msg = '';
  try {
    await expectReachable(page, page.locator(TARGET).last());
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  // ⚠ 文言まで見る ── 「何かで落ちた」ではなく**覆いを理由に落ちた**ことを確かめる
  expect(msg, '覆われているのに通ってしまった(検出力が死んでいる)').toContain('覆われている');
});

/**
 * 🔑 **Locator を受けられること**(#419)。
 *
 * ⚠ 選択子を**文字列で組み立てさせない**ために要る ── 行の相手は
 *   `data-pkc-entry="<lid>"` で識別するが、**lid には引用符が入りうる**
 *   (実際に `shell.ts` の選択子の組み立てがそれで壊れた)。
 * ⚠ そして `.last()` を渡したとき、**測る箱と当たり判定が同じ要素**であること ──
 *   以前は `document.querySelector(sel)` で引き直していたので、
 *   **箱は最後の行・判定は最初の行**という食い違いが原理的に起こりえた。
 */
test('🔴 .last() を渡すと、最後の 1 枚で判定する(先頭に化けない)', async ({ page }) => {
  await gotoApp(page);
  const tabs = page.locator(TARGET);
  expect(await tabs.count(), 'タブが 2 枚未満(この検査が意味を持たない)').toBeGreaterThan(1);

  const first = await expectReachable(page, tabs.first());
  const last = await expectReachable(page, tabs.last());
  // ⚠ **違う座標が返る**こと ── 同じなら、どちらかが先頭に化けている
  expect(last.x, '.last() が .first() と同じ座標を返した(先頭に化けている)').toBeGreaterThan(
    first.x,
  );
});
