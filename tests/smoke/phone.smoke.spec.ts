import { test, expect, devices } from '@playwright/test';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  dismissAnnounce,
  openViewPane,
  useSplitEditor,
} from './helpers';

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
  await dismissAnnounce(page);
  await createEntry(page, 'text');

  /**
   * ⚠ **お知らせは先に畳む**(2026-09-02 に条件を書き直した)。
   *
   * 直す前のここは「**畳まない**(起動直後のカードが縦を 3 割取った状態で、なお
   * 保存が押せる)」だった ── #588 の 3 つの縦潰れ要因の 1 つがカードだったからである。
   * ⚠ ところが user 裁定でカードは**スマホでは画面いっぱい**になった:
   *   もう本文から縦を削る物ではなく、**読んで畳む 1 枚の画面**である。
   *   だから「カードを出したまま編集する」は**そもそも到達できない状態**になった
   *   (畳まないと編集を始める口に触れない)。
   * 🔑 縦潰れの主張はカード抜きで測り、**カードが画面いっぱいに出ること・
   *   そこから出られること**は下の専用 test が見る(条件を実装に寄せて緩めたのでは
   *   なく、**画面が変わったので測る所が移った**)。
   */
  /**
   * 🔴 **`commit-edit` を全数走査する**(#588 が書いた「直ったと言える条件」そのもの)。
   *
   * ⚠ この画面には「保存」が **2 個**在る(中央の帯と追記欄の場所 ── マニュアルが
   *   「どちらを押しても結果は同じ」と約束している)。#588 の発見が遅れた理由は
   *   **1 個目だけを測った**ことなので、ここで `.first()` を使ってはいけない。
   * 🔑 条件は「**どれも自分に当たる**、または**押せない物は DOM に出ていない**」。
   *   ⚠ `toBeVisible()` では見えない ── 覆われていても通る。
   */
  const saves = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-action="commit-edit"]')].map((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        where: el.closest('[data-pkc-region]')?.getAttribute('data-pkc-region') ?? '?',
        hidden: (el as HTMLElement).offsetParent === null && r.width === 0 && r.height === 0,
        w: Math.round(r.width),
        h: Math.round(r.height),
        hit: at?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null,
      };
    }),
  );
  expect(saves.length, '「保存」が 1 つも無い(台の空振り)').toBeGreaterThan(0);
  // ⚠ 2 個在ることまで前提にしない(片方を畳む直し方でも条件は満たせる)が、
  //    出ている物は**全部**押せなければならない
  for (const s of saves) {
    if (s.hidden) continue;
    expect(s.w, `${s.where} の保存が潰れている`).toBeGreaterThan(8);
    expect(s.h, `${s.where} の保存が潰れている`).toBeGreaterThan(8);
    expect(s.hit, `${s.where} の保存が覆われている(押しても保存されない)`).toBe('commit-edit');
  }
  expect(errors, '例外が出た').toEqual([]);
});

/**
 * 🔴 **本文が画面の主役である**(#588 の逆側)。
 * ⚠ 直す前は一覧 30vh + 情報 30vh + お知らせ 30vh が先に取り、本文が 18〜74px だった。
 */
test('🔴 本文ページでは、本文が画面の 3 割以上を取る', async ({ page }) => {
  await gotoApp(page);
  await dismissAnnounce(page);
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
  await dismissAnnounce(page);
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
  /**
   * 🔴 **情報ページは画面いっぱいを使う**(着地前レビューの記録)。
   * ⚠ スマホの規則から `max-height: none` を落とすと、`@media (max-width: 1100px)` の
   *   `30vh` が当たって**画面の 3 割で切れ、残り 7 割が空白**になる ── そこを見る
   *   検査が 1 つも無かった(消しても全部緑だった)。
   */
  const info = (await page.locator(REGION('inspector')).boundingBox())!;
  /**
   * ⚠ **切られた姿(30vh)と、いまの姿を確実に分ける値にする**。実測は
   *   **69.0%**(502px / 727px。残りはお知らせと状態の行)で、切られると **30%** ──
   *   50% はその真ん中である。⚠ 実測ぎりぎりの 70% にすると、帯を 1 本足した日に
   *   **製品は正しいのにここが落ちる**(観測点ではなく閾値の問題になる)。
   */
  expect(
    info.height / page.viewportSize()!.height,
    `情報ページの丈が 30vh で切られている(${Math.round(info.height)}px)`,
  ).toBeGreaterThan(0.5);
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
  await dismissAnnounce(page);
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
  await dismissAnnounce(page);
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
  await dismissAnnounce(page);
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
 * 🔴 **隠した面は「場所を持ったまま」隠す**(`visibility` であって `display: none` ではない)。
 *
 * ⚠ **この 1 件は変異試験が要求して足した**(2026-09-02)── `visibility: hidden` を
 *   `display: none` へ変える変異が、下の「図を焼き直さない」だけでは **SURVIVED**
 *   だった。図の焼き直しは**描く順**(面の属性より先に本文を描く)に左右されるので、
 *   毎回は起きない ── つまり**あの test は、選んだ隠し方を守っていなかった**。
 * 🔑 だから**仕組みそのものを pin する**:隠れている面が**大きさを持ち続ける**こと。
 *   これが `display: none` との唯一の機械的な差であり、
 *   mermaid の `widthOf`(`parentElement.clientWidth || … || 640`)も
 *   スクロール位置の保存も、**全部ここに乗っている**。
 * ⚠ 観測点は `boundingBox()` ── `display: none` の要素では **null** が返る。
 */
test('🔴 隠れている面も大きさを持ち続ける(display:none で隠していない)', async ({ page }) => {
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await clickReal(page, `${REGION('detail')} [data-pkc-action="commit-edit"]`);

  // いまは本文ページ ── 一覧と情報は隠れている
  await expect(page.locator(REGION('center'))).toBeVisible();
  for (const region of ['sidebar', 'inspector']) {
    const box = await page.locator(REGION(region)).boundingBox();
    expect(box, `${region}: 隠れた面が場所ごと消えている(display:none で隠している)`).not.toBeNull();
    expect(box!.width, `${region}: 隠れた面の幅が 0`).toBeGreaterThan(100);
    expect(box!.height, `${region}: 隠れた面の丈が 0`).toBeGreaterThan(100);
  }

  // 一覧ページへ移ると、こんどは本文が隠れる ── そちらも場所は残る
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(page.locator(REGION('sidebar'))).toBeVisible();
  const body = await page.locator(REGION('center')).boundingBox();
  expect(body, '隠れた本文が場所ごと消えている(図の焼き直しと読んでいた場所の消失を招く)').not.toBeNull();
  expect(body!.width, '隠れた本文の幅が 0(mermaid の widthOf が 640 に落ちる)').toBeGreaterThan(100);
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
 *
 * 🔴 **往復する先は「情報」である**(2 稿目。変異試験 M4 が SURVIVED で教えた)。
 * ⚠ 一覧へ戻る道では **`display: none` に変えても鍵が増えなかった** ── 一覧へ
 *   戻ると選択が外れて**本文の器ごと作り直される**ので、図は次に開いたとき
 *   **見えている幅で**焼かれる。つまりその往復は 2 つの実装を分けない。
 * 🔑 情報ページなら選択は変わらないので**器は生きたまま**で、中央だけが隠れる ──
 *   `display: none` だと親の箱が 0 になって `ResizeObserver` が鳴り、
 *   `widthOf` の逃げ道 640 で**別の鍵の 2 枚目が焼かれる**。
 */
test('🔴 本文⇄情報を往復しても、図を焼き直さない', async ({ page }) => {
  // ⚠ 全文の textarea を入力の道具に使うので、既定(live)ではなく split を明示する
  await useSplitEditor(page);
  await gotoApp(page);
  await dismissAnnounce(page);
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
    await clickReal(page, '[data-pkc-field="phone-info"]');
    await expect(page.locator(REGION('inspector'))).toBeVisible();
    // ⚠ 隠れている間に焼き直しが走る ── 戻る前に一拍置いて、走らせてから数える
    await page.waitForTimeout(400);
    await clickReal(page, '[data-pkc-field="phone-back"]');
    await expect(page.locator(REGION('center'))).toBeVisible();
    await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  }
  await page.waitForTimeout(400);
  expect(
    await bakedKeys(),
    '往復のたびに図を焼き直している(面を display:none で隠して幅が 0 になっている)',
  ).toBe(before);
});

/**
 * 🔴 **お知らせはスマホでは画面いっぱい ── そして必ず出られる**
 * (user 裁定 2026-09-02「**全画面でだせばいいじゃん。不要ならみんな設定するでしょ？**」)。
 *
 * ## ⚠ ここが唯一の逃げ道である
 *
 * 全画面にした以上、**畳めなければアプリごと行き止まり**になる(起動のたびに
 * 同じカードが画面を覆う)。裁定の後半「不要ならみんな設定するでしょ」は
 * **「今後は出さない」が本当に効く**ことを前提にしているのに、
 * ⚠ **実ブラウザで端から端まで通す検査は無かった** ── `announce.test.ts` は
 * store の状態(恒久オフ + 既読)まで見ているが、**押して読み直す**所までは
 * 誰も通していない。
 *
 * 🔴 **「出ない」だけでは足りない**(2026-09-02 の着地前レビュー 8)。`mute()` は
 * `markSeen` と `setEnabled(false)` の**2 つ**をするので、⚠ 恒久オフを消す変異でも
 * **既読になったぶんだけ「出ない」は成り立つ** ── だから設定そのものも見る。
 *
 * 🔑 観測点は 4 つ:①**覆っている**(高さの割合)②**押せる**(`elementFromPoint` ──
 * `toBeVisible()` では覆われていても通る)③**読み直しても出ない**
 * ④**恒久オフの設定が残っている**。
 */
test('🔴 お知らせは画面いっぱいに出て、「今後は出さない」で二度と出ない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  /**
   * ⚠ **ノートが 1 件在る状態でカードを出し直す** ── 後半で「帯より上に居るか」を
   *   測るのに、選べるノートが要る。⚠ 起動直後は 0 件なので、
   *   一度畳んで作り、**既読の印を消して読み直す**(印の綴りは実測した ──
   *   畳んだ後に `localStorage` へ増えた鍵がこれ 1 つだった)。
   */
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await clickReal(page, `${REGION('detail')} [data-pkc-action="commit-edit"]`);
  await page.evaluate(() => localStorage.removeItem('pkc3.notices.seen'));
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });

  const band = page.locator(REGION('announce'));
  await expect(band, '既読を消しても出直さない(台の前提が崩れた)').toBeVisible({
    timeout: 10_000,
  });

  /**
   * ⚠ **切られた姿と確実に分ける値にする**(情報ページの丈と同じ考え方)。
   *   直す前は `max-height: 30vh` = **3 割**、裁定後は主面いっぱい。
   *   5 割はその真ん中で、帯を 1 本足しても揺れない。
   */
  const box = (await band.boundingBox())!;
  expect(
    box.height / page.viewportSize()!.height,
    `お知らせが 30vh で切られている(${Math.round(box.height)}px)`,
  ).toBeGreaterThan(0.5);

  /**
   * 🔴 **本文の面を実際に覆っている** ── 「大きい」だけでは重なりを主張できない
   *   (`z-index` を落とすと、同じ大きさのまま**後ろへ回る**)。
   * ⚠ 中央の面の真ん中を突いて、お知らせ側に当たることを見る。
   */
  const over = await page.evaluate(() => {
    const c = document.querySelector('[data-pkc-region="center"]')!.getBoundingClientRect();
    const at = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
    return at?.closest('[data-pkc-region]')?.getAttribute('data-pkc-region') ?? null;
  });
  expect(over, 'お知らせが本文の後ろに回っている(全画面になっていない)').toBe('announce');

  /**
   * 🔴 **ページの帯より上に居る**(変異試験 S1 が SURVIVED で要求した)。
   *
   * ⚠ 上の観測点(本文の真ん中)だけでは **`z-index: 2` を落としても緑**だった ──
   *   お知らせは shell の**後ろのほうの子**なので、重ね順を指定しなくても
   *   面 3 枚より上に来る。⚠ 上に来ないのは**ページの帯だけ**である
   *   (帯は `position: relative; z-index: 1` を持つ)。
   * 🔑 だから帯が出ている状態を作って測る。⚠ 起動直後は一覧ページなので帯は出ない
   *   ── ノートを選ぶ必要があるが、**カードに覆われていて指では押せない**
   *   (それが「全画面」の意味である)。狭い窓 + キーボードでは辿り着けるので、
   *   **状態の用意だけ** JS の click で済ませ、**測るのは実際の重なり**にする。
   */
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-action="select-entry"]')?.click();
  });
  const bar = page.locator(REGION('phone-bar'));
  await expect(bar, '台の前提が崩れた ── 帯が出ていない(ノートを選べていない)').toBeVisible();
  const overBar = await bar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return at?.closest('[data-pkc-region]')?.getAttribute('data-pkc-region') ?? null;
  });
  expect(overBar, 'ページの帯がお知らせを突き抜けて出ている').toBe('announce');

  // 🔴 逃げ道が**押せる**(覆われた全画面の中で、手だけは最前面に居る)
  const hit = await page
    .locator('[data-pkc-action="mute-announce"]')
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return at?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null;
    });
  expect(hit, '「今後は出さない」が押せない ── 全画面の行き止まり').toBe('mute-announce');

  await clickReal(page, '[data-pkc-action="mute-announce"]');
  await expect(band, '押しても消えない').toBeHidden();

  // 🔴 **読み直しても出ない**(ここが裁定の前提そのもの)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(band, '「今後は出さない」が次の起動で効いていない').toBeHidden();
  // ⚠ 空振り防止 ── アプリ自体は起動しており、一覧が出ている
  await expect(page.locator(REGION('sidebar')), '起動していない(何も測っていない)').toBeVisible();
  /**
   * 🔴 **恒久オフそのものを見る**(上の docstring の④)。⚠ 綴りは実測した
   *   (`notice-store.ts` の `OFF_KEY`)。これが無いと、`setEnabled(false)` を
   *   落とす変異が**既読に救われて**生き延びる。
   */
  const off = await page.evaluate(() => localStorage.getItem('pkc3.notices.off'));
  expect(off, '恒久オフが保存されていない(既読になっただけ)').toBe('1');

  expect(errors).toEqual([]);
});

/**
 * 🔴 **一覧へ戻っても、読んでいたノートは開いたまま**(user 裁定 2026-09-02
 * 「**開いたままにし、一覧の上に「ノートへ →」を出す**」)。
 *
 * ## user の物語
 *
 * 買い物メモを読んでいる → 別のメモを探そうと **← 一覧** → 一覧が出る →
 * やっぱり戻りたい → 🔴 いままでは**戻り道が無かった**(選択ごと消えていた)。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * 「行が**押せる**」= 一覧の面がいま最前面に居ること。`elementFromPoint` は
 * happy-dom では答えられない(CSS を組まない)。
 */
test('🔴 ← 一覧 で戻っても、「ノートへ →」で読んでいた所へ帰れる', async ({ page }) => {
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await clickReal(page, `${REGION('detail')} [data-pkc-action="commit-edit"]`);

  const back = page.locator('[data-pkc-field="phone-return"]');
  await expect(back, '本文を読んでいる間から「ノートへ →」が出ている').toBeHidden();

  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(page.locator(REGION('sidebar')), '一覧に出られない').toBeVisible();
  await expect(back, '一覧に戻る口が出ていない').toBeVisible();

  // 🔴 **押せる**(一覧の面の中で、実際に最前面に居る)
  await clickReal(page, '[data-pkc-field="phone-return"]');
  await expect(page.locator(REGION('center')), '「ノートへ →」で本文へ帰れない').toBeVisible();
  await expect(back, '本文に帰ったのに行が残っている').toBeHidden();

  /**
   * 🔴 **一覧の「実物の行」でも帰れる**(2026-09-02 の着地前レビュー 9)。
   *
   * ⚠ この裁定でいちばん難しい主張(**同じ行をもう一度押しても本文へ戻る** ──
   *   設計 doc §2-6 が bit を一度棄却した当の理由)を守っていたのは、
   *   unit が **手で組んだ `<button>`** を押す 1 本だけだった。
   * 🔴 行の markup が内側の `<span>` へ移った日、`select-entry` の受け手は
   *   `closest` せずに `data-pkc-entry` を読むので **lid が null になって無反応**
   *   ── 実機の dead tap が戻るのに unit は緑である。だから**実物を押す**。
   */
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(page.locator(REGION('sidebar'))).toBeVisible();
  const row = page.locator(`${REGION('sidebar')} [data-pkc-action="select-entry"][data-pkc-entry]`).first();
  await expect(row, '一覧に行が 1 つも出ていない(台の前提が崩れた)').toBeVisible();
  await clickReal(page, row);
  await expect(
    page.locator(REGION('center')),
    '一覧の行を押しても本文へ戻らない(dead tap)',
  ).toBeVisible();
});

/**
 * 🔴 **360px 未満は「対応していません」と出し、画面は止めない**
 * (#632 段③、user 裁定 ⑥ 2026-08-30)。
 *
 * > 「幅 360px 未満は、下の行に **1 度だけ**『この幅には対応していません ──
 * > 360px 以上で』と出し、**画面は止めない**」
 *
 * ## ⚠ ここで測るもの / 測らないもの
 *
 * 帯は **1 行しか持たない**ので、同じ字を 2 回書いても実ブラウザからは
 * **同じ画面に見える** ── 🔑 だから「**1 度だけ**」は
 * `tests/adapter/phone-layout.test.ts` が持ち(替え玉を何度も動かして数える)、
 * ここが持つのは実ブラウザにしか無い 2 つ:
 * ① 実際に `matchMedia` が真になって**帯へ届くか** ② **止まっていないか**。
 */
test('🔴 340px では「対応していません」と出て、それでも書ける', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 340, height: 700 });
  await gotoApp(page);
  await dismissAnnounce(page);

  /**
   * ⚠ **状態の行へスコープする**(CLAUDE.md §1 の 7 度目 / 8 度目)── root 全体で
   *   探すと、マニュアルやお知らせの散文に満たされて**常に真**になりうる。
   */
  const status = page.locator(REGION('status'));
  await expect(status, '対応外の幅なのに何も言わない').toContainText('この幅には対応していません');
  await expect(status, '何をすればよいか書いていない').toContainText('360px 以上');

  /**
   * 🔴 **止めない**(裁定の後半。ここが本題である)── 断り書きを出したあとも
   *   **ふつうに書けて、書いたものが残る**。
   * ⚠ 「行が増えた」ではなく**題名で**見る ── 数だけ見ると、別の理由で増えた行に
   *   満たされる。
   */
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('細い端末のメモ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await expect(
    page.locator(REGION('sidebar')),
    '対応外の幅だと書けない(画面が止まっている)',
  ).toContainText('細い端末のメモ');

  // ⚠ 断り書きは消えていない(書いたら流れる、では「1 度だけ」の意味が無い)
  await expect(status, '書いたら断り書きが消えた').toContainText('この幅には対応していません');

  /**
   * 🔴 **その字が、その幅の帯に収まっている**(着地前の動線レビューが突いた盲点)。
   *
   * ⚠ `toContainText` は**画面の外へ落ちた字でも真になる** ── 状態の行は
   *   `height: 20px` 固定で `overflow` を持たないので、長い字は 2 行に折り返して
   *   **下half が窓の外**へ出る(実測:43 字の版で `scrollHeight 25 / clientHeight 20`)。
   * 🔑 いちばん狭い画面へ向けた字は、**その画面で測る**。
   */
  const fit = await status.evaluate((el) => ({
    clientH: el.clientHeight,
    scrollH: el.scrollHeight,
    bottom: Math.round(el.getBoundingClientRect().bottom),
    innerH: window.innerHeight,
  }));
  expect(fit.scrollH, `断り書きが帯からはみ出している(${fit.scrollH} / ${fit.clientH})`)
    .toBeLessThanOrEqual(fit.clientH);
  // ⚠ 空振り防止 ── 帯そのものが画面の中に在る(0 高さで「収まった」ではない)
  expect(fit.clientH, '帯に高さが無い(何も測っていない)').toBeGreaterThan(0);
  expect(fit.bottom, '帯が画面の外に在る').toBeLessThanOrEqual(fit.innerH);

  /**
   * 🔴 **広げたら消える**(着地前の動線レビュー ── いちばん重い指摘)。
   *
   * ⚠ 直す前は、窓を 800px に広げても字が残っていた ── **対応している幅で
   *   「対応していません」と書いてある** = 画面が嘘をつく。しかも状態の行は
   *   1 行しか無いので、**本当に読ませたい文を押し出す**(#300 段④ が
   *   常設バッジを外したのと同じ形)。
   */
  await page.setViewportSize({ width: 800, height: 700 });
  await expect(status, '広げても「対応していません」が残っている').not.toContainText(
    'この幅には対応していません',
  );
  // 🔑 戻せばまた出る(消したら二度と出ない、を作らない)
  await page.setViewportSize({ width: 340, height: 700 });
  await expect(status, '狭め直しても出ない(一度消したら終わりになっている)').toContainText(
    'この幅には対応していません',
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **対照群 ── 対応している幅では 1 文字も出さない**(#632 段③)。
 *
 * ⚠ これが無いと、「いつでも言う」実装が上の test を満たして**そのまま通る**
 *   (境目を `PHONE_MIN_PX` 未満から `PHONE_MAX_PX` 以下へ広げる変異がまさにそれ)。
 * 🔑 幅は **`PHONE_MIN_PX` ちょうど**にする ── 境目の外側 1px で見る。
 */
test('🔴 360px ちょうどでは「対応していません」と出さない', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // ⚠ 空振り防止 ── スマホ用画面には**なっている**(幅が届いていない、ではない)
  await expect(page.locator(REGION('shell'))).toHaveAttribute('data-pkc-layout', 'phone');
  await expect(
    page.locator(REGION('status')),
    '対応している幅なのに「対応していません」と出ている',
  ).not.toContainText('この幅には対応していません');
});

/**
 * 🔴 **スマホでは 2 ペインを上下に積む**(#632 段③)。
 *
 * ## user の物語
 *
 * 電車で写真をフォルダへ片づけたい → 2 ペインを開く → 🔴 直す前は
 * **左右が 184px ずつ**に割れ、**パンくずの幅が 0px** になっていた(実測)──
 * つまり「いまどの箱に居るか」が読めないまま「移す」を押すことになる。
 *
 * ## ⚠ ここでしか測れないもの
 *
 * `grid-template-columns` が実際に何 px に解けるかは happy-dom では読めない
 * (unit が持つのは**規則が在ること**まで ── `tests/adapter/phone-layout.test.ts`)。
 * 🔑 ここが持つのは**解けた寸法**と、**押せるか**である。
 */
test('🔴 スマホの 2 ペインは上下に積まれ、どちらの箱に居るかが読める', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 375, height: 667 });
  await gotoApp(page);
  await dismissAnnounce(page);

  await createEntry(page, 'folder');
  await page.locator('[data-pkc-field="editor-title"]').fill('はこ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-field="phone-back"]');

  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'dual');

  const shape = await page.evaluate(() => {
    const panes = [
      ...document.querySelectorAll('[data-pkc-region="dual-pane"]'),
    ] as HTMLElement[];
    const one = (p: HTMLElement) => {
      const r = p.getBoundingClientRect();
      const part = (name: string): [number, number] => {
        const el = p.querySelector(`[data-pkc-region="${name}"]`) as HTMLElement | null;
        return el ? [Math.round(el.scrollWidth), Math.round(el.clientWidth)] : [-1, -1];
      };
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        crumbs: part('dual-crumbs'),
        head: part('dual-head'),
      };
    };
    return { panes: panes.map(one), innerW: window.innerWidth };
  });

  expect(shape.panes, '2 ペインが揃っていない(台の前提が崩れた)').toHaveLength(2);
  const [a, b] = shape.panes as [(typeof shape.panes)[0], (typeof shape.panes)[0]];

  // ① 🔴 **上下に積まれている**(同じ左端・違う上端)
  expect(a.x, '左右に並んだまま(左端が揃っていない)').toBe(b.x);
  // ⚠ **重なっていない**ことまで見る(上端が違うだけでは、半分被っていても真になる)
  expect(b.y, '上下に積まれていない(2 枚目が 1 枚目の下端より上に居る)').toBeGreaterThanOrEqual(
    a.y + a.h - 2,
  );

  // ② 🔴 **どちらも窓の幅を丸ごと使う**(直す前は 184px ずつだった)
  for (const p of [a, b])
    expect(p.w, `ペインが窓より狭い(${p.w}px / 窓 ${shape.innerW}px)`).toBeGreaterThan(
      shape.innerW - 20,
    );

  /**
   * ③ 🔴 **実害そのもの ── パンくずに幅が在る**。
   * ⚠ 直す前の実測は `scrollWidth 41 / clientWidth 0` ── 字は在るのに
   *   **1px も見えない**。ここを見ないと、ペインを広げただけで満足してしまう。
   */
  for (const p of [a, b]) {
    expect(p.crumbs[1], 'パンくずの幅が 0(どの箱に居るか読めない)').toBeGreaterThan(20);
    expect(p.head[0], `見出し帯が横にはみ出している(${p.head[0]} > ${p.head[1]})`)
      .toBeLessThanOrEqual(p.head[1]);
  }

  /**
   * ④ 🔴 **どちらの箱を選んでも「移す」が押せる**(片道の操作を作らない ──
   *    user 指示 2026-08-23)。⚠ `toBeVisible()` では足りない ── 覆われていても
   *    真になるので、`elementFromPoint` で**実際に指が当たる**ことを見る。
   */
  const hitMove = () =>
    page.locator('[data-pkc-field="dual-move"]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return at?.closest('[data-pkc-field]')?.getAttribute('data-pkc-field') ?? null;
    });
  for (const side of ['left', 'right'] as const) {
    await clickReal(page, `[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`);
    await expect(
      page.locator(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`),
      `${side} を押しても焦点が移らない`,
    ).toHaveAttribute('data-pkc-focused', '');
    expect(await hitMove(), `${side} を元にすると「移す」が押せない`).toBe('dual-move');
  }

  /**
   * ⑤ 🔴 **読み上げる呼び名が、置かれ方と合っている**(着地前の動線レビュー)。
   *
   * ⚠ 直す前は上下に積んでも **「左のペイン」「右のペイン」**と読み上げていた ──
   *   画面と逆のことを言っている。⚠ **変異試験 N9 が SURVIVED で教えた** ──
   *   `stackedNow` を潰しても unit は 1 件も落ちない(happy-dom は採寸しないので、
   *   実寸から採る判定は**実ブラウザでしか通らない**)。
   */
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-region="dual-pane"]')].map((p) =>
      p.getAttribute('aria-label'),
    ),
  );
  expect(names, '上下に積んだのに「左 / 右」と読み上げている').toEqual([
    '上のペイン',
    '下のペイン',
  ]);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **横に持ったときは積まない**(#632 段③ の着地前レビュー → 実測で確定)。
 *
 * ⚠ 上の test の**対照群**である。`orientation` で切らずに「スマホなら積む」と
 *   書くと、667×375(横に持ったスマホ)で**丈が 136px** になり、
 *   **6 行のうち 1 行しか出ない**(実測)── 「どこに居るか」を買って
 *   「何が在るか」を失う、正味で悪い取引になる。
 * 🔑 横のままなら左右で**パンくずが 136px** 出ているので、直す理由がそもそも無い。
 */
test('🔴 横に持ったスマホでは、2 ペインを積まずに左右のまま出す', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-field="phone-back"]');
  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'dual');

  // ⚠ 空振り防止 ── この幅でもスマホ用画面には**なっている**
  await expect(page.locator(REGION('shell'))).toHaveAttribute('data-pkc-layout', 'phone');

  const shape = await page.evaluate(() => {
    const panes = [
      ...document.querySelectorAll('[data-pkc-region="dual-pane"]'),
    ] as HTMLElement[];
    return panes.map((p) => {
      const r = p.getBoundingClientRect();
      const c = p.querySelector('[data-pkc-region="dual-crumbs"]') as HTMLElement | null;
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        crumbW: c ? Math.round(c.clientWidth) : -1,
      };
    });
  });
  expect(shape, '2 ペインが揃っていない(台の前提が崩れた)').toHaveLength(2);
  const [a, b] = shape as [(typeof shape)[0], (typeof shape)[0]];

  // ① 🔴 **左右のまま**(積んでいない)
  expect(b.x, '横に持っても上下に積んでいる').toBeGreaterThan(a.x + a.w - 1);
  expect(Math.abs(a.y - b.y), '上端が揃っていない').toBeLessThan(2);
  // ② 🔴 **丈を失っていない**(積むと 136px まで潰れて 1 行しか出なかった)
  for (const p of [a, b])
    expect(p.h, `ペインの丈が足りない(${p.h}px)`).toBeGreaterThan(200);
  // ③ 🔑 この幅なら左右のままでもパンくずは読める(積む理由が無いことの根拠)
  for (const p of [a, b])
    expect(p.crumbW, 'パンくずの幅が 0(横でも積む理由が在ることになる)').toBeGreaterThan(20);

  /**
   * ④ ⚠ **呼び名の対照群** ── 左右のままなら「左 / 右」と読み上げる。
   * 🔑 縦の腕と対で置く ── 片方だけだと「いつも上下と言う」実装が素通りする。
   */
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-region="dual-pane"]')].map((p) =>
      p.getAttribute('aria-label'),
    ),
  );
  expect(names, '左右に並んでいるのに「上 / 下」と読み上げている').toEqual([
    '左のペイン',
    '右のペイン',
  ]);
});

/**
 * 🔴 **集中モードの鍵を押しても、見えない畳みが残らない**(#632 段④)。
 *
 * ## なぜ実ブラウザで見るか
 *
 * ⚠ 害の本体は **`localStorage` に残る**こと ── unit も台の `appPanes` は見られるが、
 *   **本物の `localStorage` へ書かれるか**と**画面が本当に動かないか**は
 *   実ブラウザにしか無い。
 * 🔴 実測(直す前、375×667):`pkc3.panes` が `null` → **`'sidebar inspector'`**
 *   に変わるのに、状態の行は**空のまま**で画面も 1px も動かなかった。
 *   ⚠ PC の幅へ戻すと**身に覚えのない畳み**が残る。
 */
test('🔴 スマホで集中モードの鍵を押すと理由が出て、畳みの記録は残らない', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const before = await page.evaluate(() => localStorage.getItem('pkc3.panes'));
  await page.keyboard.press('Control+Alt+Backslash');

  await expect(
    page.locator(REGION('status')),
    '黙って受けている(理由が出ていない)',
  ).toContainText('列は畳めません');
  const after = await page.evaluate(() => localStorage.getItem('pkc3.panes'));
  expect(after, `畳みの記録が動いた(${String(before)} → ${String(after)})`).toBe(before);

  /**
   * 🔑 **対照群 ── 追記欄の鍵は効く**(まとめて断っていない)。
   * ⚠ 置かないと「スマホでは畳む鍵を全部殺す」実装がこの test を素通りする
   *   ── それは user 指示 2026-08-27 の道を 1 本殺すことになる。
   */
  const box = page.locator(REGION('append'));
  const shown = await box.isVisible();
  await page.keyboard.press('Alt+Backslash');
  await expect(box, '追記欄の鍵まで殺している').toBeVisible({ visible: !shown });
});
