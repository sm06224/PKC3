/**
 * #111: **本番と同じ条件**で分離が成立するか。
 *
 * 🔴 これは 1 度そのまま出荷した穴の回帰 test である。Office は
 * `crossOriginIsolated` を要求するが、それは COOP/COEP のヘッダからしか生まれず、
 * **GitHub Pages はヘッダを返せない**。SW が被せる分を作らないまま着地させたので、
 * 手元(`vite preview` = ヘッダあり)では緑・**本番だけ動かない**状態になった。
 *
 * ⚠ **だから preview を見てはいけない。** この spec だけは
 * `plain-server.mjs`(ヘッダを何も足さない)を見る。⚠ それが本当に
 * 「足していない」ことを**先に確かめる** ── 確かめないと、うっかり preview を
 * 指したときに**通ってしまう**(救い手が変わっただけ、の形)。
 *
 * ## ⚠ 明示的な読み直しと**競争させない**
 *
 * 初稿は「SW が active になったら `page.reload()`」と書いて落ちた。原因は製品では
 * なく test で、**アプリ自身がちょうどその瞬間に読み直す**(`coi-reload.ts`)ので、
 * こちらの reload が相手の reload を踏み、まだ分離していない文書に対して assert
 * していた。🔑 **誰が読み直したかを問わず「分離した状態」を待つ**形にする。
 */
import { expect, test, type Page } from '@playwright/test';

/** ⚠ 既定の baseURL(preview)ではなく **plain** を見る。 */
function plainBase(testInfo: { config: { metadata?: Record<string, unknown> } }): string {
  const url = testInfo.config.metadata?.plainBaseURL;
  if (typeof url !== 'string') throw new Error('plainBaseURL が config に無い');
  return url;
}

/**
 * 🔴 **`ready` だけを待つ。`error` を「起動した」と読まない**(2026-08-11 に踏んだ)。
 *
 * 初稿は `[data-pkc-boot="ready"], [data-pkc-boot="error"]` を待っていた。おかげで
 * **分離した途端に storage worker が読めなくなり、起動が全部失敗していた**のに、
 * この spec は 3 件とも緑だった ── 待っていたのは「起動が終わったこと」であって
 * 「起動したこと」ではなかった。⚠ user には「起動に失敗しました」しか見えない
 * 状態を、**分離の検査が合格印を押して**送り出したことになる。
 *
 * 🔑 `error` は**待たずに落とす** ── 出たらその場で理由ごと落ちるほうが速い。
 */
async function booted(page: Page): Promise<void> {
  await page.waitForSelector('[data-pkc-boot="ready"], [data-pkc-boot="error"]', {
    timeout: 40_000,
  });
  const state = await page.evaluate(
    () => document.querySelector('[data-pkc-boot]')?.getAttribute('data-pkc-boot') ?? null,
  );
  if (state !== 'ready') {
    const why = await page.evaluate(() => document.body.innerText.slice(0, 200));
    throw new Error(`起動に失敗した(data-pkc-boot=${String(state)}): ${why}`);
  }
}

/**
 * 分離した状態まで持っていく。
 *
 * ⚠ **ブラウザで道が 2 つある。** JSPI がある環境(= Office が動きうる)は
 * アプリが自分で 1 回読み直す。無い環境はわざと読み直さないので、
 * こちらが 1 回だけ読み直して **SW の被せそのもの**を見る。
 * 🔑 どちらの道でも**主張は同じ**(SW が被せれば分離する)。
 */
async function reachIsolation(page: Page): Promise<void> {
  const jspi = await page.evaluate(() => typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function');
  if (jspi) {
    // ⚠ `waitForFunction` は navigation を跨いで評価し直すので、
    //    アプリ側の読み直しと競合しない
    await page.waitForFunction(() => window.crossOriginIsolated === true, undefined, {
      timeout: 30_000,
    });
    return;
  }
  await page.waitForFunction(
    () => navigator.serviceWorker.getRegistration().then((r) => r?.active != null),
    undefined,
    { timeout: 25_000 },
  );
  await page.reload();
  await booted(page);
}

test('🔴 ヘッダを返さない配信でも、SW が分離を成立させる', async ({ page }, testInfo) => {
  const base = plainBase(testInfo);

  // ① **前提を先に固める。** この server が COOP/COEP を返していないこと。
  //    ⚠ ここが無いと、preview を指してしまった時にこの spec は
  //    「SW が働いた」と嘘の報告をする
  const bare = await page.request.get(`${base}/index.html`);
  expect(bare.headers()['cross-origin-opener-policy'], '配信側がヘッダを返している').toBeUndefined();
  expect(bare.headers()['cross-origin-embedder-policy']).toBeUndefined();

  // ② 初回訪問。SW はまだこの文書を制御していないので、分離していない
  await page.goto(`${base}/index.html`);
  await booted(page);
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false);

  // ③ SW が被せた文書では分離する
  await reachIsolation(page);
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  // ④ 🔑 分離の**実利**まで見る。ヘッダが付いただけで SharedArrayBuffer が
  //    使えないなら、Office にとっては何も変わっていない
  expect(await page.evaluate(() => typeof SharedArrayBuffer === 'function')).toBe(true);

  /**
   * ⑤ 🔴 **分離した状態で、アプリが本当に起動しているか。**
   *
   * ここが今回いちばん重い教訓である。COEP は **worker script 自身の応答にも
   * COEP を要求する**ので、navigation にだけ被せた初稿では storage worker が
   * `net::ERR_BLOCKED_BY_RESPONSE` で読めず、**分離した瞬間にアプリが起動
   * しなくなっていた**(user 報告「起動に失敗しました: storage worker error」)。
   * ⚠ 分離の成立だけを見ていると、この形は素通りする ── **動くこと**まで見る。
   */
  await booted(page);
  expect(await page.locator('[data-pkc-boot="ready"]').count()).toBe(1);
});

test('🔴 分離した状態で worker が読める(COEP は worker script にも要る)', async ({
  page,
}, testInfo) => {
  // ⚠ 「起動できた」だけだと、worker を使わない経路で救われうる。
  //    **worker が実際に返事をした**ことまで見る
  const blocked: string[] = [];
  page.on('requestfailed', (r) => {
    if (r.failure()?.errorText.includes('BLOCKED_BY_RESPONSE')) blocked.push(r.url());
  });
  await page.goto(`${plainBase(testInfo)}/index.html`);
  await booted(page);
  await reachIsolation(page);
  await booted(page);

  expect(blocked, 'COEP が何かを弾いている').toEqual([]);
  // storage worker が生きている = ノートを 1 件作って一覧に出る
  await page.locator('[data-pkc-action="create-entry"]').first().click();
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(1);
});

test('🔴 オフラインで cache から出した文書でも分離が外れない', async ({ page, context }, testInfo) => {
  // ⚠ ここが抜けると「入っているのに、オフラインの時だけ Office が動かない」
  //    という、user から原因を名指しできない壊れ方になる
  await page.goto(`${plainBase(testInfo)}/index.html`);
  await booted(page);
  await reachIsolation(page);

  await context.setOffline(true);
  try {
    await page.reload();
    await booted(page);
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  } finally {
    await context.setOffline(false);
  }
});

test('🔴 読み直しの輪を作らない(印が残り、二度と読み直さない)', async ({ page }, testInfo) => {
  await page.goto(`${plainBase(testInfo)}/index.html`);
  await booted(page);

  const jspi = await page.evaluate(() => typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function');
  test.skip(!jspi, 'JSPI が無い = 自分では読み直さない環境なので、印も付かない');

  await page.waitForFunction(() => window.crossOriginIsolated === true, undefined, {
    timeout: 30_000,
  });
  // 印が在る = 1 度試したことを覚えている
  expect(await page.evaluate(() => sessionStorage.getItem('pkc3:coi-reload-tried'))).toBe('1');

  /**
   * 🔴 **ここが輪の検査である。** 分離した後にもう一度読み直しても、
   * アプリが「まだ分離していない」と判断して読み直し続けることが無い。
   * ⚠ 判定は URL でも回数でもなく、**同じ文書のまま一定時間留まること**で見る
   * (読み直されれば実行文脈が捨てられ、この印が消える)。
   */
  await page.reload();
  await booted(page);
  await page.evaluate(() => {
    (window as unknown as { __stayed?: boolean }).__stayed = true;
  });
  await page.waitForTimeout(1500);
  expect(
    await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed === true),
    '読み直しの輪に入っている(文書が作り直された)',
  ).toBe(true);
});
