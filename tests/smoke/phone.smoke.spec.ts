import { test, expect, devices } from '@playwright/test';
import { inflateSync } from 'node:zlib';
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
 * 🔴 **360px 未満は断り書きを出し、画面は止めない**(#632 段③ の裁定 ⑥ →
 * **字と消し方は #671 で user が決め直した**、2026-09-04)。
 *
 * > 「**この画面の幅では表示が崩れることがあります。横向きにすると直ります**」
 * > 「**OK 押したらで**」
 *
 * ⚠ 前の字(「この幅には対応していません ── 360px 以上でお使いください」)は、
 *   **スマホに窓が無い**ので「別の端末を使え」としか読めなかった ── 読んだ
 *   user にできることが 0 件だった。🔑 新しい字は**いまできる一手**を名指しする。
 *
 * ## ⚠ ここで測るもの / 測らないもの
 *
 * 「変わったときだけ伝える」は替え玉で数える側が持つ
 * (`tests/adapter/too-narrow.test.ts`)。ここが持つのは実ブラウザにしか無い 3 つ:
 * ① 実際に `matchMedia` が真になって**帯へ届くか** ② **止まっていないか**
 * ③ 🔴 **「OK」が本当に押せる所に在るか**(いちばん狭い画面で、帯からも
 *    画面からもはみ出していないか ── 押せない消し口は無いのと同じである)。
 */
test('🔴 340px では断り書きが出て、OK で消せて、それでも書ける (#671)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 340, height: 700 });
  await gotoApp(page);
  await dismissAnnounce(page);

  /**
   * ⚠ **状態の行へスコープする**(CLAUDE.md §1 の 7 度目 / 8 度目)── root 全体で
   *   探すと、マニュアルやお知らせの散文に満たされて**常に真**になりうる。
   */
  const status = page.locator(REGION('status'));
  await expect(status, '対応外の幅なのに何も言わない').toContainText('表示が崩れることがあります');
  /**
   * 🔴 **いまできる一手を名指しする**(user 裁定 2026-09-04、#671 の裁定 2)。
   * ⚠ 前の字「360px 以上でお使いください」は、**スマホに窓が無い**ので
   *   「別の端末を使え」としか読めなかった ── 読んだ user にできることが 0 件だった。
   */
  await expect(status, 'いまできる一手(横向き)を書いていない').toContainText('横向き');

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
  await expect(status, '書いたら断り書きが消えた').toContainText('表示が崩れることがあります');

  /**
   * 🔴 **その字が、その幅の帯に収まっている**(着地前の動線レビューが突いた盲点)。
   *
   * ⚠ `toContainText` は**画面の外へ落ちた字でも真になる**(実測:43 字の版で
   *   `scrollHeight 25 / clientHeight 20`)。
   * 🔴 **いまは押す口(OK)が横に並ぶので、字だけのときより厳しい** ──
   *   帯は `min-height` に変えて伸びるようにしたが、**伸びた結果が画面の外へ
   *   出ていないか**は実ブラウザでしか読めない。
   * 🔑 いちばん狭い画面へ向けた字は、**その画面で測る**。
   */
  const fit = await status.evaluate((el) => ({
    clientH: el.clientHeight,
    scrollH: el.scrollHeight,
    bottom: Math.round(el.getBoundingClientRect().bottom),
    innerH: window.innerHeight,
  }));
  /**
   * 🔴 **主張を「はみ出していない」から「食う丈の上限」へ書き換えた**
   * (着地前レビュー A-2、2026-09-04)。
   *
   * ⚠ 帯を `height: 20px` 固定から `min-height` + `flex-wrap` に変えた時点で、
   *   **`scrollHeight <= clientHeight` は常に真**になった(内容に合わせて伸びるので)。
   *   `bottom <= innerH` も、status の grid 行が `auto`・本文が `minmax(0,1fr)` なので
   *   **帯が伸びると本文が縮むだけ**で常に真である ── 2 本とも鳴らなくなっていた。
   * 🔑 いま守るべきは「**いちばん狭い画面で、帯が本文を食い過ぎない**」である。
   *   ⚠ 上限は**実測で置く** ── 340px では **72px**(字が 2 行 + 押す口 32px が
   *   その下に回り込む)。窓の丈 700px に対して約 10% で、しかも押せば消える。
   *   🔑 **80 は「これ以上は増やさない」の線**であって、72 が理想という意味ではない
   *   (増やすなら測り直して、なぜ増えたかを書く)。
   */
  expect(fit.clientH, `断り書きの帯が ${fit.clientH}px も食っている`).toBeLessThanOrEqual(80);
  // ⚠ 空振り防止 ── 帯そのものが画面の中に在る(0 高さで「収まった」ではない)
  expect(fit.clientH, '帯に高さが無い(何も測っていない)').toBeGreaterThan(0);
  expect(fit.bottom, '帯が画面の外に在る').toBeLessThanOrEqual(fit.innerH);

  /**
   * 🔴 **押す口が本当に押せる**(user 裁定 2026-09-04、#671 の裁定 3「OK 押したらで」)。
   *
   * ⚠ 直す前は**押す口が 1 つも無かった** ── 読んだ user は消し方を持たない。
   * ⚠ `toBeVisible()` では足りない(覆われていても真になる)ので、
   *   `clickReal` で**実際に指が当たる**ことごと見る。
   */
  const ok = page.locator('[data-pkc-field="too-narrow-ok"]');
  await expect(ok, '断り書きに押す口が無い(消し方が画面に無い)').toBeVisible();
  const okBox = await ok.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
      innerH: window.innerHeight,
      hit: at?.getAttribute('data-pkc-field') ?? null,
    };
  });
  expect(okBox.hit, 'OK が覆われていて押せない').toBe('too-narrow-ok');
  expect(okBox.h, `OK の押し所が ${okBox.h}px(32px 未満)`).toBeGreaterThanOrEqual(32);
  expect(okBox.bottom, 'OK が画面の外に在る').toBeLessThanOrEqual(okBox.innerH);

  await clickReal(page, '[data-pkc-field="too-narrow-ok"]');
  await expect(status, 'OK を押しても断り書きが消えない').not.toContainText(
    '表示が崩れることがあります',
  );

  /**
   * 🔴 **押した後は、狭め直しても出てこない。**
   * ⚠ 出るなら「押しても消えない」のと体験が同じである ── 窓を掴んでいる間じゅう
   *   同じ字を消し続けることになる。
   */
  await page.setViewportSize({ width: 800, height: 700 });
  await page.setViewportSize({ width: 340, height: 700 });
  await expect(status, 'OK を押したのにまた出てきた').not.toContainText(
    '表示が崩れることがあります',
  );

  /**
   * 🔴 **押した後は、次に開いても出ない**(#687 E-1、user 裁定 2026-09-04)。
   * ⚠ 直す前は閉包変数だったので、読み込み直すたびに同じ字が出て同じ OK を
   *   押させていた。🔑 unit は store を渡し直して再現するが、**本物の `localStorage`
   *   を跨いで残るか**は実ブラウザでしか読めない ── ここで `reload` する。
   * ⚠ 空振り防止 ── 同じ test の冒頭で「押す前は出る」を見ている(= 憶えていなければ
   *   この幅では必ず出る)ので、ここが hidden なら憶えたからである。
   */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator(REGION('shell')), '読み込み直しても版面が出ない').toBeAttached();
  await expect(status, 'OK を押したのに、読み込み直したらまた出た').not.toContainText(
    '表示が崩れることがあります',
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **押さずに広げたら畳む**(#671。上の test の**対照群**)。
 *
 * ⚠ 上だけだと「一度出たら二度と出ない」実装が素通りする ── そちらは
 *   OK を押していない人にも二度と出ないので、別の欠陥である。
 * 🔴 そして**広げたら畳む**のがここの主張である:1440px の画面で
 *   「この画面の幅では表示が崩れる」と出したままにしない(画面に嘘を出さない)。
 */
test('🔴 押さずに広げたら畳み、狭め直せばまた出る (#671)', async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 700 });
  await gotoApp(page);
  await dismissAnnounce(page);
  const status = page.locator(REGION('status'));
  await expect(status, '前提が崩れた(狭くしても出ていない)').toContainText(
    '表示が崩れることがあります',
  );

  await page.setViewportSize({ width: 800, height: 700 });
  await expect(status, '広げても出したまま(対応している幅で嘘をついている)').not.toContainText(
    '表示が崩れることがあります',
  );

  // 🔑 押していないので、狭め直せばまた出る
  await page.setViewportSize({ width: 340, height: 700 });
  await expect(status, '押していないのに二度と出ない').toContainText(
    '表示が崩れることがあります',
  );
});

/**
 * 🔴 **対照群 ── 対応している幅では 1 文字も出さない**(#632 段③)。
 *
 * ⚠ これが無いと、「いつでも言う」実装が上の test を満たして**そのまま通る**
 *   (境目を `PHONE_MIN_PX` 未満から `PHONE_MAX_PX` 以下へ広げる変異がまさにそれ)。
 * 🔑 幅は **`PHONE_MIN_PX` ちょうど**にする ── 境目の外側 1px で見る。
 */
test('🔴 360px ちょうどでは断り書きを出さない', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // ⚠ 空振り防止 ── スマホ用画面には**なっている**(幅が届いていない、ではない)
  await expect(page.locator(REGION('shell'))).toHaveAttribute('data-pkc-layout', 'phone');
  await expect(
    page.locator(REGION('status')),
    '対応している幅なのに断り書きが出ている',
  ).not.toContainText('表示が崩れることがあります');
});

/**
 * 🔴 **横に倒したスマホ(844×390)もスマホ用画面にする**(#663、推薦 ①)。
 *
 * ## なぜ要るか(`scripts/phone-probe.mjs` の実測、2026-09-04)
 *
 * 直す前は幅だけで切っていたので 844×390 は **2 列版面**に落ち、一覧 186px に
 * 帯 4 本(タブ / 探す / 作る / まとめ)が折り返して一覧の丈を超え、はみ出した
 * **「操作を探す」が、下に寝た情報ペインに覆われて押せなかった**
 * (カード開 = announce に、閉 = inspector に覆われる ── 4 行とも)。
 *
 * ## ここで測るもの
 *
 * ① 高さ 390 で **スマホ用画面になっている**こと(unit は替え玉なので寸法を測れない)
 * ② 一覧ページの **「操作を探す」が指に当たる**こと ── 判定は probe と同じ
 *    `elementFromPoint`(`toBeVisible()` は覆われていても真になる)。
 */
test('🔴 横に倒したスマホ(844×390)でもスマホ用画面になり、「操作を探す」が押せる (#663)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await gotoApp(page);
  await dismissAnnounce(page);

  await expect(
    page.locator(REGION('shell')),
    '高さ 390px なのに 2 列版面のまま(幅だけで切っている)',
  ).toHaveAttribute('data-pkc-layout', 'phone');

  // 🔴 一覧ページ(ノートを開いていない)の「操作を探す」が、自分に当たる
  const hit = await page.locator('[data-pkc-action="open-palette"]').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
      innerH: window.innerHeight,
      own: at === el || el.contains(at),
      cover: at?.closest('[data-pkc-region]')?.getAttribute('data-pkc-region') ?? null,
    };
  });
  // ⚠ 空振り防止 ── 面積を持って画面の中に在る(0×0 で「当たった」ではない)
  expect(hit.w, '「操作を探す」に幅が無い(台の空振り)').toBeGreaterThan(0);
  expect(hit.h, '「操作を探す」に高さが無い(台の空振り)').toBeGreaterThan(0);
  expect(hit.bottom, '「操作を探す」が画面の外に在る').toBeLessThanOrEqual(hit.innerH);
  expect(hit.own, `「操作を探す」が覆われている(覆っているのは ${hit.cover ?? '(なし)'})`).toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * ⚠ **対照群 ── 幅も高さも足りている窓(1280×720)はスマホ用画面にならない**(#663)。
 * 🔑 これが無いと、「いつでもスマホ用画面」にする実装が上を満たして通る。
 *   ⚠ そして「操作を探す」はここでも押せる ── 押せないなら計器の話である
 *   (`phone-probe.mjs` が対照群でやっているのと同じ検算)。
 */
test('⚠ 1280×720 はスマホ用画面にならず、「操作を探す」も押せる(対照群) (#663)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await expect(page.locator(REGION('shell')), '広い窓なのにスマホ用画面').not.toHaveAttribute(
    'data-pkc-layout',
    'phone',
  );
  const own = await page.locator('[data-pkc-action="open-palette"]').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return at === el || el.contains(at);
  });
  expect(own, '対照群で「操作を探す」が押せない(計器の話)').toBe(true);
});

/**
 * 🔴 **スマホでは 2 ペインを「1 枚ずつ」出す**(user 裁定 2026-09-04、#671)。
 *
 * > 「**左ペイン表示と右ペイン表示に分けて、どちらかを開いている際は、
 * > もう片方の行き先だけ示す。みたいな簡易 UI にすればよいのでは?**」
 *
 * ## user の物語
 *
 * 電車で写真をフォルダへ片づけたい → 2 ペインを開く → **1 枚が版面を丸ごと使う**
 * ので、どの箱に居るか(パンくず)も、何が在るか(行)も同時に読める。
 * 移したくなったら「**右へ移す**」を押す ── 相手は画面に居ないが、字が行き先を言う。
 *
 * ## ⚠ ここでしか測れないもの
 *
 * `display: none` が実際に効いて**箱が 1 つになる**ことは happy-dom では読めない
 * (unit が持つのは**規則が在ること**まで ── `tests/adapter/phone-layout.test.ts`)。
 * 🔑 ここが持つのは**解けた寸法**と、**押せるか**と、**切り替わるか**である。
 */
for (const [name, w, h] of [
  ['縦', 375, 667],
  ['横', 667, 375],
] as const) {
  /**
   * 🔑 **向きの 2 本を同じ主張で回す** ── 撤回した「積む」案は向きで得失が
   *   反転していた(縦は得・横は損)ので、向きごとに違う形を要求していた。
   *   1 枚ずつなら**どちらでも同じ**になる ── それをここで確かめる。
   */
  test(`🔴 スマホ(${name})の 2 ペインは 1 枚だけ出し、行き先の字で移せる`, async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: w, height: h });
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

    // ⚠ 空振り防止 ── この幅でもスマホ用画面には**なっている**
    await expect(page.locator(REGION('shell'))).toHaveAttribute('data-pkc-layout', 'phone');

    const shape = () =>
      page.evaluate(() => {
        const panes = [
          ...document.querySelectorAll('[data-pkc-region="dual-pane"]'),
        ] as HTMLElement[];
        const box = (p: HTMLElement) => {
          const r = p.getBoundingClientRect();
          const crumbs = p.querySelector(
            '[data-pkc-region="dual-crumbs"]',
          ) as HTMLElement | null;
          const head = p.querySelector('[data-pkc-region="dual-head"]') as HTMLElement | null;
          return {
            side: p.getAttribute('data-pkc-side'),
            /**
             * 🔴 **`visibility` で見る**(着地前の動線レビュー C の直しに合わせた)。
             * ⚠ 隠す側は `display: none` ではなく `visibility: hidden` なので、
             *   **箱は在る**(`width > 0`)── 大きさで見ると「2 枚出ている」と読む。
             */
            shown: getComputedStyle(p).visibility !== 'hidden',
            inert: p.hasAttribute('inert'),
            w: Math.round(r.width),
            h: Math.round(r.height),
            label: p.getAttribute('aria-label'),
            crumbW: crumbs ? Math.round(crumbs.clientWidth) : -1,
            headOver: head ? Math.round(head.scrollWidth) - Math.round(head.clientWidth) : -1,
          };
        };
        const sw = document.querySelector(
          '[data-pkc-region="dual-switch"]',
        ) as HTMLElement | null;
        return {
          panes: panes.map(box),
          innerW: window.innerWidth,
          /**
           * 🔴 **丈は器(`dual-body`)との比で見る**(2026-09-05、#706 で踏んだ)。
           * ⚠ 直す前は `> 200px` の実数だった ── 指の端末で行を 34px にした日に、
           *   横向き(667×375)の 2 ペインは器ごと縮んで **189px** になり、
           *   **積んでもいないのに落ちた**(主張は「1 枚が版面を丸ごと使う」であって
           *   「200px 以上ある」ではない)。積むと 1 枚は器の**半分**(136/272)になるので、
           *   比で見れば 2 つの状態は離れたまま分かれる。
           */
          bodyH: Math.round(
            document.querySelector('[data-pkc-region="dual-body"]')?.getBoundingClientRect()
              .height ?? 0,
          ),
          switcher:
            sw === null
              ? null
              : {
                  text: (sw.textContent ?? '').trim(),
                  to: sw.getAttribute('data-pkc-side'),
                  h: Math.round(sw.getBoundingClientRect().height),
                  shown: sw.getBoundingClientRect().height > 0,
                },
          moveLabel: (
            document.querySelector('[data-pkc-field="dual-move"]')?.textContent ?? ''
          ).trim(),
          /**
           * 🔴 **門を N 個置いたら、N 個目だけが鳴る場面を N 通り作る**
           * (着地前レビュー M1、2026-09-04)。⚠ `dual-move` だけを見ていたので、
           *   `it.directed` を落として**全部に行き先を付ける**変異が生き延びた
           *   (「右へ名前」「右へゴミ箱」と出るのに緑)。
           */
          copyLabel: (
            document.querySelector('[data-pkc-field="dual-copy"]')?.textContent ?? ''
          ).trim(),
          renameLabel: (
            document.querySelector('[data-pkc-field="dual-rename-begin"]')?.textContent ?? ''
          ).trim(),
          /**
           * 🔴 **字が切れていないか**(着地前の動線レビュー B、2026-09-04 に実測)。
           * ⚠ `text-overflow: ellipsis` なので、切れても画面には「右…」と出るだけ ──
           *   `textContent` を見る検査は**素通りする**(CLAUDE.md §1)。
           */
          cut: [...document.querySelectorAll('[data-pkc-field="cmd-label"]')]
            .filter((el) => el.scrollWidth > el.clientWidth)
            .map((el) => `${el.textContent}(${el.scrollWidth}/${el.clientWidth})`),
        };
      });

    const first = await shape();
    expect(first.panes, '2 ペインが揃っていない(台の前提が崩れた)').toHaveLength(2);

    // ① 🔴 **出ているのは 1 枚だけ**(積んだのでも、横に割ったのでもない)
    const shown = first.panes.filter((p) => p.shown);
    expect(shown.map((p) => p.side), '1 枚だけ出ていない').toEqual(['left']);

    const only = shown[0]!;
    // ⚠ 隠した側は**焦点も受けない**(`visibility` だけでは Tab で入れる)
    const hiddenSide = first.panes.find((p) => !p.shown)!;
    expect(hiddenSide.inert, '隠した側に焦点が入る(Tab で見えないペインへ行ける)').toBe(true);
    // ② 🔴 **その 1 枚が版面を丸ごと使う**(直す前は 184px / 積むと丈 136px)
    expect(only.w, `ペインが窓より狭い(${only.w}px / 窓 ${first.innerW}px)`).toBeGreaterThan(
      first.innerW - 20,
    );
    // ⚠ 空振り防止 ── 器そのものが潰れているなら、比で見ても何も言っていない
    expect(first.bodyH, `2 ペインの器が潰れている(${first.bodyH}px)`).toBeGreaterThan(100);
    expect(
      only.h,
      `ペインが器を丸ごと使っていない(${only.h}px / 器 ${first.bodyH}px ── 積んでいる形)`,
    ).toBeGreaterThan(first.bodyH * 0.9);
    /**
     * ③ 🔴 **実害そのもの ── パンくずに幅が在る**。
     * ⚠ 直す前の実測は `scrollWidth 41 / clientWidth 0` ── 字は在るのに 1px も見えない。
     */
    expect(only.crumbW, 'パンくずの幅が 0(どの箱に居るか読めない)').toBeGreaterThan(20);
    expect(only.headOver, `見出し帯が横に ${only.headOver}px はみ出している`).toBeLessThanOrEqual(0);
    // ④ ⚠ 呼び名は「左 / 右」のまま(積まないので「上 / 下」には戻らない)
    expect(only.label, '呼び名が左右になっていない').toBe('左のペイン');

    /**
     * ⑤ 🔴 **行き先のボタンが出ていて、押し所が 32px 以上**(user 裁定)。
     * ⚠ 相手が画面に居ないので、**これが唯一の帰り道**である ── 出ていなければ
     *   右のペインへ二度と行けない(片道の操作を作らない、user 指示 2026-08-23)。
     */
    expect(first.switcher, '行き先のボタンが組まれていない').not.toBeNull();
    expect(first.switcher!.shown, 'スマホなのに行き先のボタンが出ていない').toBe(true);
    expect(first.switcher!.text, '行き先が字に出ていない').toContain('右のペイン');
    expect(first.switcher!.h, `押し所が ${first.switcher!.h}px(32px 未満)`).toBeGreaterThanOrEqual(32);

    /**
     * ⑥ 🔴 **操作の字に行き先が入る**(user 裁定)── 相手が画面に居ないので、
     *    「移す」だけではどこへ行くか読めない。
     */
    expect(first.moveLabel, '操作の字に行き先が入っていない').toContain('右へ移す');
    /**
     * 🔴 **その字が、その幅で本当に読める**(着地前の動線レビュー B)。
     *
     * ⚠ 直す前の実測(375×667、1 行 7 等分):**7 つ全部**が切れていた ──
     *   「右へ写す」は **53px 必要 / 15px しか無い**(全角 1 字)。
     * 🔑 「行き先を字に入れる」という user 裁定は、**読めなければ果たせない**。
     */
    expect(first.cut, `操作の字が切れている: ${first.cut.join(' / ')}`).toEqual([]);
    // 🔑 **行き先が入るのは「コピー」「移す」だけ**(2 件とも見る。#587 D-1 で「写す」→「コピー」)
    expect(first.copyLabel, '「コピー」に行き先が入っていない').toContain('右へコピー');
    /**
     * 🔴 **対照群 ── 行き先を入れない側**。⚠ これが無いと、`it.directed` を
     *   無視して**全部に行き先を付ける**変異が素通りする(「右へ名前」と出る)。
     */
    expect(first.renameLabel, '行き先の要らない操作にまで行き先を付けている').not.toContain('右へ');

    /**
     * ⑦ 🔴 **押したら本当に切り替わる**(押せるだけ、では帰り道にならない)。
     * ⚠ `toBeVisible()` では足りない ── 覆われていても真になるので、
     *   `clickReal` で**実際に指が当たる**ことごと見る。
     */
    await clickReal(page, '[data-pkc-region="dual-switch"]');
    const after = await shape();
    expect(
      after.panes.filter((p) => p.shown).map((p) => p.side),
      '押しても右のペインに切り替わらない',
    ).toEqual(['right']);
    // ⚠ **行き先も裏返る**(裏返らないと、左へ戻る道がその場で消える)
    expect(after.switcher!.text, '行き先が左に裏返っていない').toContain('左のペイン');
    expect(after.moveLabel, '操作の字が左向きに裏返っていない').toContain('左へ移す');

    /**
     * ⑧ 🔴 **どちらの側でも「移す」が押せる**(片道の操作を作らない)。
     * ⚠ `elementFromPoint` で見る ── 覆われていると `toBeVisible` は素通りする。
     */
    const hitMove = () =>
      page.locator('[data-pkc-field="dual-move"]').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          field: at?.closest('[data-pkc-field]')?.getAttribute('data-pkc-field') ?? null,
          h: Math.round(r.height),
        };
      });
    const hit = await hitMove();
    expect(hit.field, '右を元にすると「移す」が押せない').toBe('dual-move');
    // 🔑 操作の 7 つも 32px(user 裁定)
    expect(hit.h, `操作の押し所が ${hit.h}px(32px 未満)`).toBeGreaterThanOrEqual(32);

    /**
     * ⑨ 🔴 **切り替えたら、新しい側へ焦点が移る**(着地前レビュー B-5)。
     *
     * ⚠ 2 ペインの鍵(F5 / F6 / Tab …)は**焦点がペインの中に在るとき**しか効かない。
     *   行き先のボタンはペインの外に在り、押した瞬間に元のペインは `inert` になるので、
     *   焦点を移さないと `<body>` へ落ちて**鍵が 1 つも効かなくなる**
     *   (720px 未満のノート PC で現実に届く)。
     */
    const focusIn = await page.evaluate(
      () =>
        document.activeElement?.closest('[data-pkc-region="dual-pane"]')?.getAttribute(
          'data-pkc-side',
        ) ?? null,
    );
    expect(focusIn, '切り替えた先へ焦点が移っていない(2 ペインの鍵が死ぬ)').toBe('right');

    // ⚠ 戻り道の対照群 ── もう一度押せば左へ帰る(往復できる)
    await clickReal(page, '[data-pkc-region="dual-switch"]');
    const back = await shape();
    expect(
      back.panes.filter((p) => p.shown).map((p) => p.side),
      '左のペインへ帰れない(片道になっている)',
    ).toEqual(['left']);

    /**
     * ⑩ 🔴 **窓の幅がパソコン側へ跨いだら、操作の字も戻る**(着地前レビュー B-1 / G。
     *    2026-09-04 に実測して**壊れていることを確かめた**)。
     *
     * ⚠ 窓の幅は `state` を 1 バイトも動かさないので、`render` に届く経路が
     *   `appPhone` の `onToggle` **1 本しか無い** ── 直す前はそこが
     *   `applyPaneVisibility` しか呼んでおらず、実測(375 → 1440)で
     *   **2 枚とも出ているのに字は「F6右へ移す」のまま**だった。
     */
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(REGION('shell'))).not.toHaveAttribute(
      'data-pkc-layout',
      'phone',
    );
    const wide = await shape();
    expect(wide.moveLabel, 'パソコンの幅にしても、スマホ用の字が残っている').not.toContain(
      'へ移す',
    );
    expect(
      wide.panes.filter((p) => p.shown).map((p) => p.side),
      'パソコンの幅にしても 1 枚のまま',
    ).toEqual(['left', 'right']);

    expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
  });
}

/**
 * 🔴 **パソコンは 1px も変えない**(user 裁定 2026-09-04)── 上の 2 本の**対照群**。
 *
 * ⚠ これが無いと「いつも 1 枚だけ出す」実装が素通りする(スマホ側の主張は
 *   全部通ってしまう)── CLAUDE.md §1「代替物で満たせない条件にする」。
 */
test('🔴 パソコンの 2 ペインは 2 枚とも出たまま、行き先のボタンは出ない (#671)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'dual');

  // ⚠ 空振り防止 ── この幅ではスマホ用画面に**なっていない**
  await expect(page.locator(REGION('shell'))).not.toHaveAttribute('data-pkc-layout', 'phone');

  const wide = await page.evaluate(() => {
    const panes = [
      ...document.querySelectorAll('[data-pkc-region="dual-pane"]'),
    ] as HTMLElement[];
    const sw = document.querySelector('[data-pkc-region="dual-switch"]') as HTMLElement | null;
    return {
      shown: panes.filter((p) => p.getBoundingClientRect().width > 0).length,
      labels: panes.map((p) => p.getAttribute('aria-label')),
      switcherShown: sw !== null && sw.getBoundingClientRect().height > 0,
      moveLabel: (
        document.querySelector('[data-pkc-field="dual-move"]')?.textContent ?? ''
      ).trim(),
    };
  });
  expect(wide.shown, 'パソコンでも 1 枚しか出ていない').toBe(2);
  expect(wide.labels, '呼び名が左右になっていない').toEqual(['左のペイン', '右のペイン']);
  expect(wide.switcherShown, 'パソコンに行き先のボタンが出ている').toBe(false);
  /**
   * 🔑 **字に行き先を入れない**(2026-08-19 の判断を守る)── 2 枚見えているので
   *   向きは焦点の地色が語っており、字を足すと焦点が移るたびに幅が変わって端が揃わない。
   */
  expect(wide.moveLabel, 'パソコンの操作にも行き先を入れている').not.toContain('へ移す');
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

/**
 * 🔴 **指で行を押し続けると印が足される**(#687 D-1。user 裁定 2026-09-04)。
 *
 * ⚠ unit(`tests/adapter/long-press.test.ts`)は `PointerEvent` を**手で撃つ**ので、
 *   「実ブラウザが指の押下を `pointerType: 'touch'` の pointerdown として届け、
 *   500ms の間 `pointerup` も `click` も撃たず、離した後の `click` が捨てられる」
 *   という**ブラウザ側の順番**は見ていない。ここはそれだけを見る。
 * ⚠ **ブラウザの長押し(`contextmenu` / drag)との取り合い**は headless の合成 touch で
 *   は決まらない ── cowork の実機で確かめる(Android の drag が 500ms より先に
 *   始まると、印ではなく行が動く)。
 * 🔑 `page.touchscreen` は `tap` しか持たないので、CDP の `Input.dispatchTouchEvent`
 *   で `touchStart` → 600ms 待つ → `touchEnd` を撃つ(`live-editor.smoke.spec.ts` が
 *   CDP を使う型)。
 */
test('🔴 スマホで行を 600ms 押し続けると、印が 2 行になる (#687 D-1)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 375, height: 667 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // ノートを 2 件作る(印を 2 行にするのに 2 行要る)
  for (let i = 0; i < 2; i++) {
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
    await clickReal(page, '[data-pkc-field="phone-back"]');
  }
  await clickReal(page, '[data-pkc-browse="launcher"]');
  await openViewPane(page, 'dual');
  await expect(page.locator(REGION('shell'))).toHaveAttribute('data-pkc-layout', 'phone');

  const rows = page.locator(
    '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-region="dual-table"] tbody tr',
  );
  await expect(rows, '台の前提が崩れている(行が 2 つ無い)').toHaveCount(2);
  const marked = () =>
    page
      .locator(
        '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-region="dual-table"] tbody tr[data-pkc-marked]',
      )
      .count();

  // ① 素のタップで 1 行目に印(前提 ── 1 件)
  await rows.nth(0).tap();
  expect(await marked(), 'タップで印が 1 件になっていない').toBe(1);

  // ② 2 行目を 600ms 押し続ける
  const box = await rows.nth(1).boundingBox();
  expect(box, '2 行目の寸法が採れない').not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // ⚠ 離した後の `click` が捨てられていれば 2 件のまま(`set` が走ると 1 件に戻る)
  await page.waitForTimeout(100);
  expect(await marked(), '長押しで印が足されていない(または直後の click で 1 件に戻った)').toBe(2);

  /**
   * ③ 対照群 ── 短いタップ(100ms)は印を 1 件に付け替える(長押しが全タップを食っていない)。
   *
   * ⚠ ここは②の発火から **700ms 以内**(消費窓の内側)である ── 直す前はそこで
   *   この `click` まで捨てられ、**押したのに何も起きなかった**(2026-09-05 に赤で判明。
   *   CDP の `touchEnd` は `pointerup type=touch` を撃っており、時計は止まっていた)。
   *   ⚠ ここに待ちを足して緑にしない ── 待ちを足すと、その穴がまた開いても鳴らない。
   */
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  expect(
    await marked(),
    '長押しの直後の短いタップが捨てられた(消費窓が次の押下の click まで食った、または短いタップが長押しになった)',
  ).toBe(1);
  expect(errors, `console/pageerror: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * 🔴 **スマホでは本文の上の題名を出さない ── 帯の題名だけ**(#705 ①、user 裁定 案 A)。
 *
 * ⚠ 直す前は帯の題名と本文の `h2` が**2 段重ね**で、本文ページの縦を 27px 食っていた。
 * 🔑 観測点は 2 つで 1 組:①本文の題名が**場所ごと消えている**(`boundingBox()` が null)
 *   ②**同じ題名が帯に在る**(消しただけで読めなくなっていない ── 対照群)。
 */
test('🔴 本文ページで題名は帯にだけ出る(本文の上には出ない) (#705 ①)', async ({ page }) => {
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await clickReal(page, `${REGION('detail')} [data-pkc-action="commit-edit"]`);
  await expect(page.locator(REGION('center'))).toBeVisible();

  // ⚠ 題名は情報ペイン(隠れているが DOM には在る)から読む ── 帯と別の口で同じ値を採る
  const title = (await page.locator('[data-pkc-field="inspector-title"]').textContent())?.trim() ?? '';
  expect(title, '題名が採れない(台の空振り)').not.toBe('');
  await expect(page.locator(REGION('phone-bar')), '帯に題名が無い(消しただけで読めなくなった)').toContainText(
    title,
  );
  const h2 = page.locator(`${REGION('center')} [data-pkc-field="detail-title"]`);
  expect(await h2.count(), '本文の題名の要素そのものが無い(DOM から消している ── CSS で消す設計と違う)').toBe(1);
  expect(await h2.boundingBox(), '本文の上に題名が出ている(帯と 2 段重ね)').toBeNull();
});

/**
 * 🔴 **書式バーの余りが、何段に折れても灰色にならない**(#705 ②、user 裁定 案 A)。
 *
 * ⚠ 直す前は `gap: 1px` + 下地 `--border` で線を作り、余りを `::after` で塗っていた ──
 *   `::after` は最後の段にしか居ないので、スマホで 2 段以上に折れると**上の段の余りが
 *   線色のベタ塗り**になった。
 * 🔑 観測点は**画素**である(`page.screenshot` を `scale: 'css'` で撮り、PNG を自前で読む)。
 *   CSS の字面は `tests/adapter/button-bars-css.test.ts` が持つ ── ここは user が見る色だけ。
 *   ⚠ 参照値は同じ画像から採る(ボタンの地 = 面の地 / ボタンの間 = 線)── 色の綴りを
 *   test に貼らない(テーマで変わる)。
 */
test('🔴 書式バーが 2 段以上に折れても、上の段の余りは地の色 ── 区切りの線は残る (#705 ②)', async ({
  page,
}) => {
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text'); // 作った直後は編集中 ── 書式バーが出ている
  const bar = page.locator(REGION('format-bar'));
  await expect(bar).toBeVisible();

  const geo = await bar.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const btns = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    // 段ごとに分ける(top が同じ物が 1 段)
    const rows = new Map<number, DOMRect[]>();
    for (const r of btns) rows.set(Math.round(r.top), [...(rows.get(Math.round(r.top)) ?? []), r]);
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, rs]) => rs.sort((a, b) => a.left - b.left));
    return {
      box: { x: box.left, y: box.top, w: box.width, h: box.height },
      rows: ordered.map((rs) => ({
        mid: (rs[0]!.top + rs[0]!.bottom) / 2,
        firstLeft: rs[0]!.left,
        gapX: rs.length > 1 ? (rs[0]!.right + rs[1]!.left) / 2 : null,
        lastRight: rs[rs.length - 1]!.right,
      })),
    };
  });
  // 🔑 前提: 2 段以上に折れている(1 段なら「上の段の余り」が存在しない ── この検査は何も主張しない)
  expect(geo.rows.length, `書式バーが折れていない(${geo.rows.length} 段)── 前提が崩れている`).toBeGreaterThan(1);
  // 余りがいちばん広い「最後でない段」を測る(最後の段は直す前も地の色だった)
  const upper = geo.rows.slice(0, -1).map((r) => ({ ...r, rest: geo.box.x + geo.box.w - r.lastRight }));
  const row = upper.sort((a, b) => b.rest - a.rest)[0]!;
  expect(row.rest, `上の段の余りが ${row.rest.toFixed(1)}px しか無い(測れない)`).toBeGreaterThan(6);
  expect(row.gapX, '段に 2 つ目のボタンが無い(線の対照群が採れない)').not.toBeNull();

  const png = await page.screenshot({
    clip: { x: geo.box.x, y: geo.box.y, width: geo.box.w, height: geo.box.h },
    scale: 'css',
  });
  const at = (x: number, y: number): string => rgbAt(png, Math.floor(x - geo.box.x), Math.floor(y - geo.box.y)).join(',');
  const ground = at(row.firstLeft + 2, row.mid); // ボタンの地(左の余白 ── 図案に当たらない)
  const line = at(row.gapX!, row.mid); // ボタンとボタンの間の 1px = 区切りの線
  const rest = at(row.lastRight + 4, row.mid); // 段の余り
  expect(line, '区切りの線が消えている(ボタンがくっついて 1 枚に見える)').not.toBe(ground);
  expect(rest, `上の段の余り(${rest})がボタンの地(${ground})と違う ── 線色のベタ塗りが残っている`).toBe(ground);
});

/**
 * PNG(8bit / 非インターレース / RGB か RGBA)の 1 画素を読む。
 * ⚠ 依存を足さない(pngjs は無い)── IDAT を inflate して行のフィルタ 5 種を戻すだけ。
 */
function rgbAt(png: Buffer, x: number, y: number): [number, number, number] {
  let off = 8;
  let w = 0;
  let h = 0;
  let bpp = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`読めない PNG(depth ${data[8]} / interlace ${data[12]})`);
      bpp = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (bpp === 0) throw new Error(`読めない PNG(colorType ${data[9]})`);
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (x < 0 || y < 0 || x >= w || y >= h) throw new Error(`画素 (${x},${y}) が画像 ${w}x${h} の外`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let r = 0; r < h; r++) {
    const f = raw[r * (stride + 1)]!;
    const src = r * (stride + 1) + 1;
    const dst = r * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = r > 0 ? out[dst - stride + i]! : 0;
      const c = r > 0 && i >= bpp ? out[dst - stride + i - bpp]! : 0;
      const v = raw[src + i]!;
      let p: number;
      if (f === 0) p = v;
      else if (f === 1) p = v + a;
      else if (f === 2) p = v + b;
      else if (f === 3) p = v + ((a + b) >> 1);
      else {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = p & 255;
    }
  }
  const o = y * stride + x * bpp;
  return [out[o]!, out[o + 1]!, out[o + 2]!];
}
