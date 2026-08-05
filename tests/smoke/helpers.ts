/**
 * smoke 共通 helper(P3-8)。
 * - boot 待ちは DOM 契約 `[data-pkc-boot="ready"]`(main.ts が boot 完了で刻む)
 * - クリックは「その座標で実際に見えて・最前面にある」ことを elementFromPoint で
 *   確認してから実マウスで行う(happy-dom では検証できない層 ── visual parity 規約)
 * - pageerror / console.error は各 spec の最後に 0 件を assert する
 */
import { expect, type Page } from '@playwright/test';

export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({
    timeout: 15_000,
  });
}

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

/**
 * 役割メニューの中の項目を押す(P7b 段⑨b)。
 *
 * ⚠ **メニューを開いてから押す**。畳んだ結果 `clickReal` が
 * 「閉じたメニューの中は見えない」で落ちるのは**正しい** ── 実際の user も
 * 開かなければ押せない。ここでその動線を再現する。
 * ⚠ 開けるかどうかも観測点である(`summary` が押せなければここで落ちる)。
 */
/**
 * 🔑 新規作成の**実際の導線**(P8)。種類は `<select>` で選び、`新規` を押す。
 * ⚠ 封印中の種類(`features/sealed.ts`)は選べない ── 選ぼうとすると
 * playwright が落ちるので、それ自体が「封印が効いている」の観測点になる。
 */
export async function createEntry(page: Page, archetype: string): Promise<void> {
  // 🔴 **user と同じ手順**(P10 で分割ボタンへ)── ▼ を押して種類を選び、本体を押す。
  // ⚠ `selectOption` だけでは足りない ── 本体のボタンが `data-pkc-archetype` を持ち、
  //    binder はそちらを先に見るので、select だけ変えると別の種類が出来る
  await clickReal(page, '[data-pkc-field="create-pick"]');
  await clickReal(page, `[data-pkc-region="create-menu"] [data-pkc-archetype="${archetype}"]`);
  await clickReal(page, '[data-pkc-field="create-run"]');
}

/**
 * 実クリック: 中心座標の最前面要素が target(またはその子孫 / 祖先)であることを
 * 確認してから page.mouse.click。dead click / occlusion / zero-height を検出する。
 */
export async function clickReal(page: Page, selector: string): Promise<void> {
  /**
   * 🔴 **再描画で node が差し替わるのは正常**(2026-08-05、CI で実際に落ちた)。
   *
   * 右の情報ペインは値が変わると作り直される(`inspector.ts` の指紋ガードは
   * **値が変わったとき**に通す)。保存の直後は worker から時刻が遅れて届くので、
   * その瞬間に押すと `scrollIntoViewIfNeeded` が
   * `Element is not attached to the DOM` / `element is not stable` で落ちる ──
   * 遅い機械(CI)ほど当たりやすい。実際に手元 3/3 緑・CI 赤になった。
   *
   * ⚠ **retry で誤魔化さない**。差し替わったら**やり直す**が、
   *   「見えている位置に本当に在るか」の検証は**毎回**やる ──
   *   dead click / occlusion の検出力は 1 ミリも下げない。
   * ⚠ 回数を切る ── 永遠に作り直され続ける(= 本物の不具合)なら落ちるべき。
   */
  const ATTEMPTS = 3;
  for (let i = 1; ; i += 1) {
    try {
      await clickRealOnce(page, selector);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const replaced =
        msg.includes('not attached to the DOM') || msg.includes('element is not stable');
      if (!replaced || i >= ATTEMPTS) throw e;
      // 差し替わった直後は次の描画がまだ来ていることがある ── 1 フレーム待つ
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
  }
}

async function clickRealOnce(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  await el.scrollIntoViewIfNeeded(); // fold 下の要素を「覆われている」と誤診しない
  const box = await el.boundingBox();
  expect(box, `${selector} に boundingBox が無い(画面に出ていない)`).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  // 判定は「target 自身か、その子孫がヒット」のみ。祖先ヒットを許すと
  // pointer-events:none 等の dead click が素通りする(binder は ev.target から
  // closest するため、祖先ヒットでは target のハンドラに届かない ── review #2)
  const hit = await page.evaluate(
    ({ x, y, sel }) => {
      const at = document.elementFromPoint(x, y);
      const target = document.querySelector(sel);
      return !!(at && target && (at === target || target.contains(at)));
    },
    { x: cx, y: cy, sel: selector },
  );
  expect(hit, `${selector} の中心 (${cx},${cy}) が別要素に覆われている / 届かない`).toBe(
    true,
  );
  await page.mouse.click(cx, cy);
}

/**
 * 画像が **実際に読み込まれて描画されている**ことを確かめる。
 *
 * `src` 属性が blob: になった瞬間と、画像が decode されて面積を持つ瞬間は違う ──
 * `![alt](asset:…)` は decode 前に alt テキストでボックスを持つので、
 * 「toBeVisible → src を assert → boundingBox」は **src 設定直後にレイアウトが
 * 一度潰れる窓**を踏みうる(CI で実際に踏んだ)。`naturalWidth` は decode 完了で
 * しか立たないので、これを待ってから面積を見る(assert は弱めず強めている)。
 */
export async function expectImageRendered(page: Page, selector: string): Promise<void> {
  const img = page.locator(selector).first();
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(
      () =>
        img.evaluate(
          (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth,
        ),
      { message: `${selector} が decode されない(blob: を差したのに読めていない)` },
    )
    .toBeTruthy();
  const box = await img.boundingBox();
  expect(box, `${selector} が画面に出ていない`).not.toBeNull();
  expect(box!.height).toBeGreaterThan(0);
}
