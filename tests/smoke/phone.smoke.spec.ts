import { test, expect, devices } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

/**
 * 🔴 **スマホ用画面**(#632 段①)。設計 doc:
 * `docs/development/mobile-screen-design-2026-09.md`
 *
 * > user 裁定 2026-08-30:「**スマホの幅なら、スマホ用画面に切り替える。
 * > それ以下なら対応外とする。スマホ用画面がないなら、作る**」
 *
 * ## ⚠ ここでしか見られないもの
 *
 * happy-dom は CSS を組まないので、「重ねた 3 面のうち 1 枚だけが見える」も
 * 「本文が画面の何割を取るか」も **unit では原理的に測れない**。
 * 🔑 だからここで見るのは**寸法と押せるか**だけにする ── 属性の付け替えや
 * 情報 bit の閉じ方は `tests/adapter/phone-layout.test.ts` が持つ(重複させない)。
 *
 * ⚠ **触る端末として開く**(`hasTouch`)── `playwright.config.ts` に
 * `devices` の指定は無いので、この spec の中で `test.use` する。
 */
test.use({ ...devices['Pixel 5'], hasTouch: true });

const REGION = (name: string): string => `[data-pkc-region="${name}"]`;

/**
 * 🔴 **#588 の実害そのもの**(実測: 480×800・お知らせ開・編集中で本文 18px)。
 *
 * ⚠ 観測点は **`elementFromPoint`** ── `toBeVisible()` は「他の物に覆われて
 * 押せない」を通してしまう(#588 はまさにその形だった:保存が追記欄に覆われていた)。
 */
test('🔴 スマホの縦で、編集中の「保存」が本当に押せる (#588)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  /**
   * ⚠ **お知らせは畳まない**(#588 の条件を再現する)── 起動直後のカードが
   *   縦を 3 割取った状態で、なお保存が押せることが主張である。
   */
  const save = page.locator(`${REGION('detail')} [data-pkc-action="commit-edit"]`).first();
  await expect(save, '編集の「保存」が画面に無い').toBeVisible();
  const hit = await save.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      action: at?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null,
    };
  });
  expect(hit.w, '保存が潰れている').toBeGreaterThan(8);
  expect(hit.h, '保存が潰れている').toBeGreaterThan(8);
  expect(hit.action, '保存の上に別の物が重なっている(押しても保存されない)').toBe('commit-edit');
  expect(errors, '例外が出た').toEqual([]);
});

/**
 * 🔴 **本文が画面の主役である**(#588 の逆側)。
 * ⚠ 直す前は一覧 30vh + 情報 30vh + お知らせ 30vh が先に取り、本文が 18〜74px だった。
 */
test('🔴 本文ページでは、本文が画面の 3 割以上を取る', async ({ page }) => {
  await gotoApp(page);
  await createEntry(page, 'text');
  const vh = page.viewportSize()!.height;
  const body = (await page.locator(REGION('detail')).boundingBox())!;
  expect(body, '本文の大きさが採れない').not.toBeNull();
  expect(
    body.height / vh,
    `本文が画面の 3 割も無い(${Math.round(body.height)}px / 窓 ${vh}px)`,
  ).toBeGreaterThan(0.3);
  // ⚠ 横にはみ出していない(#586 の型)
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, '横にはみ出している').toBeLessThanOrEqual(0);
});

/**
 * 🔴 **どのページからも戻れる**(#609 の行き止まりを作らない)。
 * ⚠ 3 ページ全部で「戻る口が画面に在って、押せる」ことを見る。
 */
test('🔴 3 ページのどこからでも戻れる(行き止まりが無い)', async ({ page }) => {
  await gotoApp(page);
  await createEntry(page, 'text');
  // ⚠ 作った直後は**編集中**なので、そのままでは ← も 情報 も断られる(それは正しい)
  await clickReal(page, `${REGION('detail')} [data-pkc-action="commit-edit"]`);

  const pressable = async (sel: string): Promise<string | null> =>
    page.locator(sel).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return at?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null;
    });

  // 本文ページ: ← 一覧 が押せる
  expect(await pressable('[data-pkc-field="phone-back"]'), '本文ページの戻る口が押せない').toBe(
    'phone-page',
  );
  // 情報ページ: 帯ごと消えていない(1 稿目はここで消していた)
  await clickReal(page, '[data-pkc-field="phone-info"]');
  await expect(page.locator(REGION('inspector'))).toBeVisible();
  await expect(page.locator(REGION('phone-bar')), '情報ページで帯が消えた').toBeVisible();
  expect(await pressable('[data-pkc-field="phone-back"]'), '情報ページの戻る口が押せない').toBe(
    'phone-page',
  );
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(page.locator(REGION('center'))).toBeVisible();
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(page.locator(REGION('sidebar'))).toBeVisible();
});

/**
 * 🔴 **畳んだ列を持ち込まない**(#609)。
 * ⚠ PC で一覧を畳んだまま窓を狭めると、`data-pkc-hidden-panes~='sidebar'` が
 *   残ったまま重ねた一覧が `display: none` になり、**一覧ページが真っ白**になる。
 * 🔑 保存を先に仕込んでから開く ── 「写し直し」が効いていることを見る。
 */
test('🔴 一覧を畳んだ状態で開いても、一覧ページは出る (#609)', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('pkc3.panes', 'sidebar inspector');
    } catch {
      /* 読めない環境でも落ちない */
    }
  });
  await gotoApp(page);
  await expect(page.locator(REGION('sidebar')), '畳んだ設定のせいで一覧が消えている').toBeVisible();
  const box = (await page.locator(REGION('sidebar')).boundingBox())!;
  expect(box.width, '一覧が全幅を使っていない').toBeGreaterThan(300);
  // 🔑 保存値は消していない(PC へ戻れば効く)
  const saved = await page.evaluate(() => localStorage.getItem('pkc3.panes'));
  expect(saved, '保存値を書き換えている(PC の畳みが失われる)').toContain('sidebar');
});

/**
 * 🔴 **左の列にしか無い道具が、本文ページから届く**(設計 doc §2-7)。
 * ⚠ 4 つとも `selectedLid` が要るのに押し口は一覧の中 ── 戻ると対象が消える。
 */
test('🔴 ⋯ から「時間を計る」が押せて、止める帯が出る', async ({ page }) => {
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-field="phone-menu"]');
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="start-timer"]');
  const bar = page.locator(REGION('timer-bar'));
  await expect(bar, '⋯ から計り始められない').toBeVisible();
  await clickReal(page, '[data-pkc-action="stop-timer"]');
  await expect(bar, '止められない').toBeHidden();
});

/**
 * 🔴 **編集中に本文ページから出ようとしたら、理由を言う**(無言の dead click にしない)。
 * ⚠ `disabled` にしないのは、触る画面では `title` が読めないからである。
 */
test('🔴 編集中に ← を押すと理由が出る(黙って何も起きない、にしない)', async ({ page }) => {
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(
    page.locator(REGION('status')),
    '編集中に戻ろうとしても何も出ない(押せない理由が画面に無い)',
  ).toContainText('保存するか取り消してから');
  // 🔑 ページは動いていない(戻ったふりをしない)
  await expect(page.locator(REGION('center'))).toBeVisible();
});

/**
 * 🔴 **図の焼き直しを起こさない**(`display: none` にしていないことの実測)。
 *
 * ⚠ `visibility` を `display: none` に変えると、`mermaid-hydrate.ts` の `widthOf` が
 *   幅 0 で **640 に落ちて鍵が変わり、ページを往復するたびに焼き直す** ──
 *   画面は同じに見えるので、**これだけが観測点**である。
 * 🔑 観測点は **IDB の焼き置き場に積まれた鍵の数**である。
 * ⚠ **`<img>` の `src` を見てはいけない**(1 稿目で踏んだ)── ObjectURL は
 *   表示の寿命ごとに作り直されるので、**焼き直していなくても毎回変わる**
 *   (CLAUDE.md §4「観測点が放っておいても変わるなら、変化は証拠にならない」)。
 * 🔑 鍵には**幅**が入る ── `display: none` にすると `widthOf` が 0 → 640 に落ち、
 *   **別の鍵で 2 枚目が焼かれる**。だから鍵が 1 本のままなら焼き直していない。
 */
test('🔴 一覧⇄本文を往復しても、図を焼き直さない', async ({ page }) => {
  // ⚠ 全文の textarea を入力の道具に使うので、既定(live)ではなく split を明示する
  await useSplitEditor(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');

  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('```mermaid\ngraph TD\n  A-->B\n```\n');
  await clickReal(page, `${REGION('detail')} [data-pkc-action="commit-edit"]`);
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  /** 焼き置き場の鍵を数える。⚠ 幅が鍵に入るので、幅が変われば必ず増える。 */
  const bakedKeys = async (): Promise<number> =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open('pkc3-diagram-cache', 1);
          req.onerror = () => resolve(-1);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('png')) {
              resolve(0);
              return;
            }
            const all = db.transaction('png', 'readonly').objectStore('png').getAllKeys();
            all.onsuccess = () => resolve(all.result.length);
            all.onerror = () => resolve(-1);
          };
        }),
    );

  const before = await bakedKeys();
  expect(before, '図が 1 枚も焼けていない(台の空振り)').toBeGreaterThan(0);

  for (let i = 0; i < 3; i += 1) {
    await clickReal(page, '[data-pkc-field="phone-back"]');
    await expect(page.locator(REGION('sidebar'))).toBeVisible();
    await clickReal(page, '[data-pkc-entry]');
    await expect(page.locator(REGION('center'))).toBeVisible();
    await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  }
  expect(
    await bakedKeys(),
    '往復のたびに図を焼き直している(面を display:none で隠して幅が 0 になっている)',
  ).toBe(before);
});
