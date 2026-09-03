/**
 * 🔴 **指で触る端末の手当て**(user 裁定 2026-09-02 の ④ ⑤。#632 段②)。
 *
 * ⚠ **スマホ用画面(幅で切り替える)とは別の話である** ── こちらは**入力の種類**で
 *   切り替わるので、指で触る大きな板にも効き、細くしただけの PC には効かない。
 *
 * 🔴 **unit では原理的に届かない** ── `@media (hover: none)` / `(pointer: coarse)` は
 *   happy-dom が評価しないので、規則が在るかを字面で見ることしかできない。
 *   **本当に当たっているか**(computed style がどうなるか)は実ブラウザだけである。
 * 🔑 だから**同じ file に対照群**(触らない端末)を置く ── 片方だけでは
 *   「いつも 1」「いつも 16px」の実装が緑のまま通る(CLAUDE.md §1)。
 */
import { expect, test, type Page } from '@playwright/test';
import {
  clickReal,
  createEntry,
  dismissAnnounce,
  expectReachable,
  gotoApp,
  useSplitEditor,
} from './helpers';

/** 囲みと図を 1 つずつ持つノートを作る(乗せたときだけ出る物が両方生える本文)。 */
async function noteWithBlocks(page: Page): Promise<void> {
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.fill('# 触る端末\n\n```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

/**
 * いま画面に出ている**打つ欄**を全部数え、field 名と computed な字の大きさを返す。
 * ⚠ `checkbox` / `radio` は除く(素の規則と同じ理由 ── 印は字を持たない)。
 */
async function measureFields(page: Page): Promise<Array<{ name: string; px: number }>> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
      ),
    ]
      .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0)
      .map((el) => ({
        name: el.getAttribute('data-pkc-field') ?? el.tagName.toLowerCase(),
        px: Number.parseFloat(getComputedStyle(el).fontSize),
      })),
  );
}

/** 器の computed な `opacity`(乗せずに読む ── 乗せると hover の規則が入る)。 */
async function opacityOf(page: Page, sel: string): Promise<number> {
  return page.locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));
}

test.describe('指で触る端末', () => {
  // ⚠ `hasTouch` だけで `(hover: none)` と `(pointer: coarse)` が両方真になる(実測)
  test.use({ hasTouch: true });

  test('🔴 ⑤ 乗せたときだけ出る 2 つが、最初から見えている', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useSplitEditor(page);
    await gotoApp(page);
    await dismissAnnounce(page);
    await noteWithBlocks(page);

    // ⚠ **前提** ── 器そのものが在ること(0 件なら以降は何も見ていない)
    await expect(
      page.locator('.pkc-md-copy-btn'),
      '囲みのコピーが 1 つも出ていない(台の空振り)',
    ).not.toHaveCount(0);
    await expect(
      page.locator('.pkc-render-toggle'),
      '図の切替が 1 つも出ていない(台の空振り)',
    ).not.toHaveCount(0);

    expect(await opacityOf(page, '.pkc-md-copy-btn'), 'コピーが見えない(触る端末)').toBe(1);
    expect(await opacityOf(page, '.pkc-render-toggle'), '切替が見えない(触る端末)').toBe(1);

    /**
     * 🔴 **見えているだけでは足りない** ── 指で押せる所に居るかまで見る
     * (`opacity` は「そこに在るように見える」しか言わない。CLAUDE.md の
     * dead click / occlusion の規則と同じ `elementFromPoint` で確かめる)。
     */
    await expectReachable(page, page.locator('.pkc-md-copy-btn').first());
    await expectReachable(page, page.locator('.pkc-render-toggle').first());
  });

  /**
   * 🔴 **打つ欄を全数走査する**(#632 段② の着地前レビュー A。**1 個だけ見ない**)。
   *
   * ⚠ 1 稿目は探す欄(`entry-filter`)**1 個だけ**を見ていて、**緑だった** ──
   *   ところがその欄は **field 側に `font-size` を持たない唯一の類**で、
   *   本文を打つ 4 つ(`editor-body` / `append-input` / `row-source` / `fm-source`)は
   *   `[data-pkc-field='…']`(0,1,0)で 12.5px を当てており、素の `textarea`(0,0,1)に
   *   **勝っていた**。実測:直す前は `editor-body` **12.5px** / `append-input` **12.5px**
   *   ── つまり **ノートを書く欄では、直したはずの拡大がそのまま起きていた**。
   * 🔑 これは #588 が名指しで戒めている「1 個目だけを見た」形そのものである。
   */
  test('🔴 ④ 打つ欄は全数、字が 16px を下回らない(iPhone の勝手な拡大を防ぐ)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useSplitEditor(page);
    await gotoApp(page);
    await dismissAnnounce(page);
    // ⚠ **打つ欄が出る状態を作る** ── 編集の欄・追記の欄まで含めて数える
    await createEntry(page, 'text');
    const seenEditing = await measureFields(page);
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    const seenReady = await measureFields(page);

    const all = [...seenEditing, ...seenReady];
    // ⚠ **空振り防止** ── 欄が数個しか出ていなければ、この test は何も見ていない
    expect(all.length, '打つ欄がほとんど出ていない(台の空振り)').toBeGreaterThanOrEqual(6);
    const small = all.filter((f) => f.px < 16);
    expect(
      small,
      `16px を下回る欄がある(iOS が頁ごと拡大する): ${small.map((f) => `${f.name}=${f.px}`).join(' / ')}`,
    ).toEqual([]);
  });

  /**
   * 🔴 **下限であって、固定ではない**(#632 段② の着地前レビュー M1)。
   * ⚠ `font-size: 16px` と書くと、設定で**特大(17px)**を選んだ user の欄だけ
   *   **縮む** ── 頼まれていない縮小である(CLAUDE.md 2026-08-28)。
   * ⚠ `>= 16` の検査だけでは、この変異が**緑のまま通る**。
   */
  test('🔴 ④ 字を大きくした user の欄は、縮まない(16px 固定にしていない)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('pkc3.text-scale', 'xlarge');
      } catch {
        /* sandbox の frame ── アプリの設定とは無関係 */
      }
    });
    await gotoApp(page);
    await dismissAnnounce(page);
    const body = await page.evaluate(
      () => Number.parseFloat(getComputedStyle(document.body).fontSize),
    );
    // ⚠ **前提** ── 特大が本当に効いていること(効いていなければ何も見ていない)
    expect(body, `特大が効いていない(地が ${body}px)`).toBeGreaterThan(16);
    const px = await page
      .locator('[data-pkc-field="entry-filter"]')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(px, `欄が ${px}px へ縮んだ(地は ${body}px)`).toBe(body);
  });

  /**
   * 🔴 **帯の押し所を、指で押せる大きさにする**(#632 段②「帯のボタン最小丈」)。
   * ⚠ 帯の字は 12px・詰めは 2px なので、直す前の押し所は **20px 弱**しかなかった
   *   ── 指では隣を押す。🔑 **ページの帯と同じ 32px** に揃えた。
   */
  test('🔴 走っている物の帯のボタンが、指で押せる丈を持つ', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await dismissAnnounce(page);
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
    await clickReal(page, '[data-pkc-field="phone-menu"]');
    await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="start-timer"]');

    const stop = page.locator('[data-pkc-region="timer-bar"] [data-pkc-action="stop-timer"]');
    await expect(stop, '帯が出ない(台の空振り)').toBeVisible();
    const h = (await stop.boundingBox())!.height;
    expect(h, `止める口の丈が ${h}px(指では隣を押す)`).toBeGreaterThanOrEqual(32);
  });

  test('🔴 ⋯ の項目に触れた瞬間、説明の欄が埋まる', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await dismissAnnounce(page);
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');

    await page.locator('[data-pkc-field="phone-menu"]').tap();
    const menu = page.locator('[data-pkc-region="context-menu"]');
    await expect(menu, '⋯ でメニューが出ない').toBeVisible();
    const hint = menu.locator('[data-pkc-field="context-menu-hint"]');
    await expect(hint, '説明の欄が無い(台の空振り)').toHaveCount(1);

    /**
     * 🔑 **触っている最中の値を採る** ── タップは押して離すまでが 1 つなので、
     *   離した時点ではメニューが閉じている。⚠ だから**変化を記録してから**触る。
     */
    await hint.evaluate((el) => {
      const seen: string[] = [];
      (globalThis as unknown as { __hints: string[] }).__hints = seen;
      new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
    await menu.locator('button[data-pkc-action="copy-entry-ref"]').tap();
    const seen = await page.evaluate(
      () => (globalThis as unknown as { __hints?: string[] }).__hints ?? [],
    );
    expect(
      seen.filter((t) => t.trim() !== ''),
      '触れても説明の欄が一度も埋まらなかった(押す前に読めない)',
    ).not.toHaveLength(0);
  });

  /**
   * 🔴 **`pointerdown` の口そのものを守る**(#632 段②)。
   *
   * ⚠ **上の tap の test では、この口を落としても落ちない**(変異試験 D が SURVIVED)
   *   ── Chromium は tap のときに `mouseover` を**合成する**ので、`mouseover` の口
   *   だけでも欄は埋まる。つまりあの test が守っているのは「**触れたら埋まる**」と
   *   いう user から見た主張であって、**どの口が埋めたか**ではない。
   * 🔴 **この口が要るのは iOS Safari である** ── 合成が来る保証は無く、CI に
   *   WebKit は **0 件**(設計 doc §6)。だから**その口へ素の `pointerdown` を
   *   1 つだけ**投げて、埋まることを見る(合成に救われない形)。
   * ⚠ これは合成イベントなので「指で触った」ことの証明にはならない ── そちらは
   *   上の tap の test が持つ。**2 つで 1 組**である。
   */
  test('🔴 素の pointerdown だけでも、説明の欄が埋まる(iOS Safari のための口)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await dismissAnnounce(page);
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
    await clickReal(page, '[data-pkc-field="phone-menu"]');

    const menu = page.locator('[data-pkc-region="context-menu"]');
    const hint = menu.locator('[data-pkc-field="context-menu-hint"]');
    await expect(hint, '説明の欄が無い(台の空振り)').toHaveCount(1);

    /**
     * ⚠ **開いた直後の欄は空ではない** ── 先頭の項目に焦点が入り、その `focusin` が
     *   先頭の説明で埋める(`context-menu.ts` の注記どおり)。だから「空 → 埋まる」で
     *   は測れない。🔑 **別の項目の説明へ入れ替わるか**を見る。
     */
    const target = menu.locator('button[data-pkc-action="copy-entry-ref"]');
    const want = (await target.getAttribute('data-pkc-hint')) ?? '';
    expect(want, '相手に説明が付いていない(台の空振り)').not.toBe('');
    expect(
      (await hint.textContent())?.trim() ?? '',
      '前提: 触る前から相手の説明が出ている(この test は何も見ていない)',
    ).not.toBe(want);

    // ⚠ **`bubbles` を明示する** ── 受け口はメニューの器に 1 本だけ張ってあるので、
    //    上がらない event は誰にも届かない(既定では上がらなかった ── 実測)
    await target.dispatchEvent('pointerdown', { bubbles: true });
    expect(
      (await hint.textContent())?.trim() ?? '',
      'pointerdown だけでは切り替わらない(iOS Safari で押す前に読めない)',
    ).toBe(want);
  });
});

test.describe('対照群 ── マウスの端末', () => {
  test('⚠ 乗せるまでは出ない / 打つ欄の字は設定のまま', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await useSplitEditor(page);
    await gotoApp(page);
    await dismissAnnounce(page);
    await noteWithBlocks(page);

    expect(await opacityOf(page, '.pkc-md-copy-btn'), 'マウスの端末で最初から出ている').toBe(0);
    expect(await opacityOf(page, '.pkc-render-toggle'), 'マウスの端末で最初から出ている').toBe(0);

    const px = await page
      .locator('[data-pkc-field="entry-filter"]')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(px, `マウスの端末の欄まで太らせている(${px}px)`).toBeLessThan(16);
  });
});
