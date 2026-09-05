/**
 * 🔴 **指で触る端末の押し所は、全部 24px 以上**(#706)。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * happy-dom は CSS を組まないので、`@media (hover: none) and (pointer: coarse)` の規則が
 * **本当に当たって何 px になるか**は実ブラウザでしか測れない。
 *
 * ## 🔑 要素を名指ししない(全数)
 *
 * 直す前に 24px へ届かなかったのは 9 種類(⋯ / 見出しの帯 / チェックの箱 / ⧉ / ‹ › /
 * ▾ / 目次の行 / 設定の箱 / 追記欄の帯)だが、**名指しで 9 個見る検査は 10 個目に鳴らない**。
 * だから読む面に出ている押せる物(`button / a / input / select / [data-pkc-action]`)を
 * **全部数え**、いちばん短い辺が 24px 未満の物が 0 件であることを見る。
 * ⚠ 除くのは 2 つだけ ── 追記欄の掴む帯(見た目 8px のまま、押し所は `::before` で
 *   広げる ── `boundingBox` には出ない)と、押せない入力(`pointer-events: none` /
 *   `hidden` / `file`)。
 * ⚠ **対照群**(マウスの端末)を同じ file に置く ── 片方だけでは「いつも 34px」の
 *   実装が緑のまま通る(CLAUDE.md §1)。
 */
import { expect, test, type Page } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
  useListBrowse,
  useSplitEditor,
} from './helpers';

/** 9 種類が全部生える本文(チェック / 見出し / 囲み / 目次)。 */
const BODY =
  '# 買い物\n\n- [ ] 牛乳\n- [x] 卵\n\n## 二番目\n\n```js\nconst a = 1;\n```\n\n:::toc\n:::\n\n本文の段落。\n';

async function noteWithTargets(page: Page, title = '買い物リスト'): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.fill(BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(page.locator('li.pkc-task-item').first()).toBeVisible();
}

/**
 * 画面に出ていて押せる物を全部数え、24px に届かない物の名前と大きさを返す。
 * ⚠ 見えない面(`visibility: hidden` / `inert`)の中は数えない ── そこは押せないので。
 */
async function tooSmall(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    let counted = 0;
    for (const el of document.querySelectorAll<HTMLElement>(
      'button, a, input, select, [data-pkc-action]',
    )) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      if (el.closest('[inert]') !== null) continue;
      if (el.matches('[data-pkc-region="pane-grip"]')) continue;
      if (el.matches('input[type="hidden"], input[type="file"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      counted += 1;
      if (Math.min(r.width, r.height) < 24) {
        const name =
          el.getAttribute('data-pkc-field') ??
          el.getAttribute('data-pkc-action') ??
          el.className ??
          el.tagName;
        out.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    // ⚠ 空振り防止 ── 押せる物がほとんど無い画面で「0 件」と言わない
    if (counted < 8) out.push(`(押せる物が ${counted} 個しか無い ── 台の空振り)`);
    return out;
  });
}

/** 前面の字色と、後ろで最初に不透明な地の色から、WCAG のコントラスト比を出す。 */
async function contrastOf(page: Page, sel: string): Promise<number> {
  return page.locator(sel).first().evaluate((el) => {
    const parse = (s: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(',').map((x) => Number.parseFloat(x));
      return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
    };
    const lum = ([r, g, b]: number[]): number => {
      const f = (c: number): number => {
        const v = c! / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const fg = parse(getComputedStyle(el).color);
    let bg: number[] | null = null;
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) {
        bg = c;
        break;
      }
    }
    if (bg === null) bg = [255, 255, 255, 1];
    const a = lum(fg);
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test.describe('指で触る端末(#706)', () => {
  test.use({ hasTouch: true });

  test('🔴 読む面・情報・一覧の押し所が、全数で 24px 以上(390×844)', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await useSplitEditor(page);
    await useListBrowse(page);
    await gotoApp(page);
    await dismissAnnounce(page);
    await noteWithTargets(page);

    // ① 本文ページ(⋯ / 見出しの帯 / チェックの箱 / ⧉ / 目次の行)
    expect(await tooSmall(page), '本文ページに 24px 未満の押し所がある').toEqual([]);
    // ② 情報ページ(情報ペインの目次の行)
    await clickReal(page, '[data-pkc-field="phone-info"]');
    await expect(page.locator('[data-pkc-region="inspector"]')).toBeVisible();
    expect(await tooSmall(page), '情報ページに 24px 未満の押し所がある').toEqual([]);
    // ③ 一覧ページ(‹ › / ▾ / 行)
    await clickReal(page, '[data-pkc-field="phone-back"]');
    await clickReal(page, '[data-pkc-field="phone-back"]');
    await expect(page.locator('[data-pkc-region="sidebar"]')).toBeVisible();
    expect(await tooSmall(page), '一覧ページに 24px 未満の押し所がある').toEqual([]);

    /**
     * 🔴 **⑦ 行の高さは 34px**(#706)。⚠ 24px の全数検査は 26px のままでも通る(26 ≥ 24)
     *   ので、この 1 本は名指しで pin する ── 対照群(下)がマウスでは 26px のままを見る。
     */
    const rowH = await page
      .locator('[data-pkc-slot="root"]')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--row-h').trim());
    expect(rowH, '指の端末で行が 34px になっていない').toBe('34px');

    /**
     * 🔴 **‹ › は色ではなく濃さで読ませる**(AA = 4.5:1)。
     * ⚠ 直す前は `--muted`(#59616b)で **4.1:1** ── 地が薄い灰なので AA に届かなかった。
     */
    const ratio = await contrastOf(page, '[data-pkc-action="nav-back"]');
    expect(ratio, `‹ の字が薄い(${ratio.toFixed(2)}:1 < 4.5)`).toBeGreaterThanOrEqual(4.5);

    expect(errors, 'pageerror が出た').toEqual([]);
  });

  /**
   * 🔴 **行の字を押しても印が変わる**(#706 ①)。
   * ⚠ 箱を押す道は `task-checkbox.smoke` が守る ── ここは**字**を tap する。
   *   実タップ(`tap()`)なので、`click` の `pointerType` が `touch` になる経路そのものを通る。
   */
  test('🔴 チェックリストの行の字を指で押すと、印が付いて本文に残る', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await useSplitEditor(page);
    await useListBrowse(page);
    await gotoApp(page);
    await dismissAnnounce(page);
    await noteWithTargets(page);

    const box = page.locator('li.pkc-task-item [data-pkc-action="toggle-task"]').first();
    await expect(box).not.toBeChecked();
    const size = (await box.boundingBox())!;
    expect(Math.min(size.width, size.height), '箱が 24px になっていない').toBeGreaterThanOrEqual(24);

    // 字の右端あたりを tap(箱からは十分離れている)
    const li = page.locator('li.pkc-task-item').first();
    const r = (await li.boundingBox())!;
    await page.touchscreen.tap(r.x + r.width * 0.7, r.y + r.height / 2);
    await expect(box, '字を押しても印が付かない').toBeChecked();
    /**
     * ⚠ **保存まで届いたこと** ── 別のノートへ行って戻り、disk から読み直した本文で印が
     *   残っているか(`task-checkbox.smoke` と同じ往復。見た目だけの反転ではない)。
     * ⚠ `reload` は使わない ── スマホ用画面では読み直すと一覧ページから始まる
     *   (アドレスにノートが載らない経路)ので、そこで探す物が居ない。
     */
    await clickReal(page, '[data-pkc-field="phone-back"]');
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await clickReal(page, '[data-pkc-field="phone-back"]');
    await clickReal(
      page,
      page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]', { hasText: '買い物リスト' }),
    );
    await expect(
      page.locator('li.pkc-task-item [data-pkc-action="toggle-task"]').first(),
      '往復したら印が消えた(保存されていない)',
    ).toBeChecked();

    expect(errors, 'pageerror が出た').toEqual([]);
  });
});

test.describe('対照群 ── マウスの端末', () => {
  test('⚠ 行の高さも ‹ › の色も、これまでのまま', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await useListBrowse(page);
    await gotoApp(page);
    await dismissAnnounce(page);
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    const rowH = await page
      .locator('[data-pkc-slot="root"]')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--row-h').trim());
    expect(rowH, 'マウスの端末まで行を高くしている').toBe('26px');
    const nav = page.locator('[data-pkc-action="nav-back"]');
    const [color, muted] = await nav.evaluate((el) => [
      getComputedStyle(el).color,
      getComputedStyle(el).getPropertyValue('--muted').trim(),
    ]);
    // ⚠ `--muted` は 16 進の字なので、computed の rgb と比べるために変換する
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(muted)!;
    const rgb = `rgb(${parseInt(hex[1]!, 16)}, ${parseInt(hex[2]!, 16)}, ${parseInt(hex[3]!, 16)})`;
    expect(color, 'マウスの端末で ‹ › の色が変わった').toBe(rgb);
    // ⚠ 行の字を押しても印は動かない(マウスでは字を選ぶ操作を奪わない)
    const boxH = await page
      .locator('[data-pkc-action="nav-back"]')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(boxH, 'マウスの端末のボタンが高くなった').toBeLessThan(30);
  });
});
