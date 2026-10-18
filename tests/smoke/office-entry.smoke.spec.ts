/**
 * smoke(#88 / O3-c): 添付の画面に出る **Office の入口**。
 *
 * 🔴 **主張は 1 つ** ── 「Office の添付には、押せるボタンか名指しの理由が**必ず**
 * 出る。押しても何も起きないボタンは出ない」。
 *
 * ⚠ **どちらが出るかは環境で変わる**(JSPI と分離が揃っているか)。だから
 * 「ボタンが出る」を assert すると、ブラウザの版で赤くなる test になる ──
 * 観測点は**状態のどれかであること**と、**理由のときに押せる物が無いこと**にする。
 * 🔑 CLAUDE.md「主張が違えば観測点も違う」/「実害の形へ書き直す」。
 *
 * ⚠ unit(`tests/adapter/office-entry-view.test.ts`)は happy-dom なので
 * **能力が必ず足りない側**でしか通らない。分離が実際に効いているか、
 * `crossOriginIsolated` が本当に立つかは**実ブラウザでしか分からない**。
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gotoApp, collectPageErrors, clickReal } from './helpers';
import { OFFICE_LARGE_DOC_BYTES } from '../../src/features/office/office-entry';
import { ALIVE_TTL_MS } from '../../src/adapter/platform/office/office-window';
import {
  SHADOW_OPENED_NOTICE,
  SHADOW_OPEN_SAVED_LABEL,
  SHADOW_OPEN_SHADOW_LABEL,
} from '../../src/features/office/office-shadow';

/** 中身は問わない ── 入口は MIME と拡張子で決まる(開くのは別窓の仕事)。 */
const FAKE_DOCX = Buffer.from('PK\u0003\u0004 not a real docx', 'utf-8');
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('🔴 Office の添付には入口が必ず出る(押しても無言のボタンを出さない)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  /**
   * ⚠ **一覧タブで開く**(#666)── 2 枚目の添付は**開いていたほうが開いたまま**に
   *   なったので、対照群を見るには行を押して開き直す必要がある。
   */
  await gotoApp(page);

  /**
   * 🔴 **分離が実際に効いていることを、配る物で確かめる**。
   * `tests/features/coi-headers.test.ts` は `vite.config.ts` の**原文**しか
   * 見ていない ── 書いてあるのに配られていない、を落とせるのはここだけである。
   */
  expect(
    await page.evaluate(() => window.crossOriginIsolated),
    'COOP/COEP が配られていない(Office の前提が崩れている)',
  ).toBe(true);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '報告書.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: FAKE_DOCX,
  });

  const entry = page.locator('[data-pkc-office]');
  await expect(entry, 'Office の添付なのに入口が 1 つも無い').toHaveCount(1, {
    timeout: 15000,
  });
  const state = await entry.getAttribute('data-pkc-office-state');
  expect(['open', 'setup', 'unsupported']).toContain(state);
  // ⚠ 何が出たかは残す(版が変わって状態が動いたら、ログで気づける)
  test.info().annotations.push({ type: 'office-entry-state', description: String(state) });

  if (state === 'open') {
    // 押せる側 ── 開くのに要る 3 つが載っていること(同期で読めないと窓が開かない)
    await expect(entry).toHaveAttribute('data-pkc-asset-name', '報告書.docx');
    expect(await entry.getAttribute('data-pkc-asset-key')).toBeTruthy();
    expect(await entry.getAttribute('data-pkc-asset-mime')).toContain('wordprocessingml');
  } else {
    // 理由の側 ── 🔴 **押せる物を出さない**。ここが本 spec の中心である
    expect(
      await entry.evaluate(
        (el) => el.hasAttribute('data-pkc-action') || el.querySelector('[data-pkc-action]') !== null,
      ),
      '理由を出しているのに押せる物がある(無言の dead click)',
    ).toBe(false);
    expect((await entry.textContent())?.trim(), '理由が空文').not.toBe('');
  }

  // ── Office でない添付には出ない(空振り防止の対照群)──
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  /**
   * 🔴 **開き直してから見る**(user 裁定 2026-09-02、#666)。
   * ⚠ 直す前は「取り込んだものが**勝手に開く**」ことに寄りかかっていたが、いまは
   *   **読んでいたもの(1 枚目の docx)が開いたまま**である ── 開き直さないと
   *   `[data-pkc-office]` は **docx のほうの入口**を数え、対照群が対照群でなくなる。
   */
  await clickReal(page, '[data-pkc-region="filer-table"] [data-pkc-entry]:has-text("dot.png")');
  await expect(page.locator('[data-pkc-field="attachment-media"]')).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator('[data-pkc-office]'),
    '画像の添付に Office の入口が出ている',
  ).toHaveCount(0);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **設定の面に、入れる導線が実在する**(#88 / O6-a)。
 *
 * ⚠ unit は器を単体で組んで見ているだけ ── **設定を開いたら本当に載っているか**は
 * 実ブラウザでしか分からない(`settings.ts` が置き忘れても unit は通る形がある)。
 * ⚠ **77MB を実際には取らない** ── ここが見るのは「導線が在って、押せる状態か」まで。
 *   取得そのものは配布元に依存するので、smoke の主張にしない。
 */
test('🔴 設定に Office 一式の状態と、入れる 2 つの導線が出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  const section = page.locator('[data-pkc-region="settings-office"]');
  await expect(section, '設定に Office の節が無い').toBeVisible({ timeout: 15000 });
  await expect(section.locator('[data-pkc-field="office-pack-status"]')).toHaveText(
    '入っていません',
  );
  // 🔴 **導線は 2 つとも押せる** ── 配布元に届かない環境の唯一の道
  //    (ファイルから)を、押せない形にしない
  for (const field of ['office-pack-url', 'office-pack-file']) {
    await expect(section.locator(`[data-pkc-field="${field}"]`)).toBeEnabled();
  }
  // ⚠ 入っていないのに「削除」が押せると、押しても何も起きないボタンになる
  await expect(section.locator('[data-pkc-field="office-pack-remove"]')).toBeDisabled();
  /**
   * 🔴 **設定の初期化は、一式が入っていなくても押せる**(#634)。
   *
   * ⚠ ここは「削除」と**わざと違う** ── 落ちて開けなくなった user が使う口なので、
   *   一式の状態で塞ぐと**出口が消える**。押した結果は「すでに初期状態です」と答える。
   */
  await expect(
    section.locator('[data-pkc-field="office-pack-reset-profile"]'),
    '設定の初期化が押せない(落ちた user の出口が塞がっている)',
  ).toBeEnabled();
  // ⚠ 何もしていないときに進捗を出さない
  await expect(section.locator('[data-pkc-field="office-pack-progress"]')).toBeHidden();

  /**
   * 🔴 台帳 #1852 束 T1(依頼 156 ②)── 取り込み中に「取り込みをやめる」を押すと、何も書かれず、また押せる。
   * 🔑 起動を増やさない ── 道中に足す。配布元の返事を返さないまま止めて(取得の最中)、やめる。
   */
  await expect(section.locator('[data-pkc-field="office-pack-cancel"]'), '取り込んでいないのにやめるが出ている').toBeHidden();
  await page.route('**/office-pack/**', () => {
    /* 返さない(取得が終わらない状態を作る) */
  });
  await clickReal(page, '[data-pkc-field="office-pack-url"]');
  const cancel = section.locator('[data-pkc-field="office-pack-cancel"]');
  await expect(cancel, '取り込み中に「取り込みをやめる」が出ない').toBeVisible({ timeout: 10000 });
  await clickReal(page, '[data-pkc-field="office-pack-cancel"]');
  await expect(cancel, 'やめたのに「取り込みをやめる」が残る').toBeHidden({ timeout: 10000 });
  await expect(page.locator('[data-pkc-region="status"]'), 'やめた知らせが出ない').toContainText('取り込みをやめました');
  await expect(section.locator('[data-pkc-field="office-pack-status"]'), 'やめたのに何か書かれた').toHaveText('入っていません');
  await expect(section.locator('[data-pkc-field="office-pack-url"]'), 'やめた後にまた押せない').toBeEnabled();
  await page.unroute('**/office-pack/**');

  // この環境で動くかを名指しで言う ── Chromium なら「動きます」
  const cap = await section.locator('[data-pkc-field="office-pack-capability"]').textContent();
  expect(cap ?? '', '環境の可否を 1 行も言っていない').not.toBe('');
  test.info().annotations.push({ type: 'office-capability', description: String(cap) });

  expect(errors).toEqual([]);
});

/**
 * 🔴 **保存していない編集の控え(影)が残っていれば、Office で開く前に 2 択を訊く**(#1228 段 2、裁定 Q1 = A / Q2 = A)。
 *
 * ⚠ unit は happy-dom で `window.open` も OPFS の実体も無い ── **押す → 確認が出る(窓はまだ開かない)→ 選ぶ →
 * 窓が開く / 控えが消える**という 1 本の線は実ブラウザでしか通らない。
 * 🔑 控えは**実物の窓の書き手**(`public/office/office-shadow.js` の `shelve`)で置く ── 棚の綴りを test が手で組むと、
 *    書く側と読む側の食い違いが両側緑のまま通る。窓の役(「文書をちょうだい」)だけは放送で演じる(本物の LO は要らない)。
 * 🔑 見るのは 5 つ: ①確認が出ている間は窓が開かない(ポップアップ遮断の折り合い)②やめる → 何も開かず控えも残る
 *    ③「一時保存した内容で開く」→ 窓が開き、渡る bytes は**控えの版**(`fromShadow`)④「保存済みの版で開く」→ 控えが消え、
 *    渡る bytes は保存済みの版 ⑤控えが無くなれば、次は訊かずに窓が開く(対照群)。
 */
test('🔴 保存していない編集があれば、開く前に 2 択を訊く(やめる / 一時保存した内容で開く / 保存済みの版)', async ({
  page,
  context,
}) => {
  // 窓の閉じを待つ道(`closeWindow`)と、境目を越える大きい文書の知らせ(依頼 242)を足したので、既定の 30 秒では足りない
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  await gotoApp(page);
  // Office 一式の meta を仕込む(`launcher.smoke.spec.ts` の Office タイルと同じ ── 入っているかの判定は meta の有無)。
  // ⚠ 控え(appOfficePack)は boot で読む ── 仕込んだ後にもう一度起動する(1 回目の起動では仕込めない)
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('pkc3-office-pack', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files');
        if (!req.result.objectStoreNames.contains('meta')) req.result.createObjectStore('meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction('meta', 'readwrite');
        t.objectStore('meta').put(
          { version: 'smoke-pack', installedAt: Date.now(), source: 'url', totalBytes: 1, files: [] },
          'pack',
        );
        t.oncomplete = () => { db.close(); resolve(); };
        t.onerror = () => reject(t.error ?? new Error('idb write failed'));
      };
      req.onerror = () => reject(req.error ?? new Error('idb open failed'));
    });
  });
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '報告書.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: FAKE_DOCX,
  });
  const open = page.locator('[data-pkc-action="open-office"]');
  await expect(open, 'Office で開くが出ていない(一式の meta を読めていない)').toHaveCount(1, { timeout: 15000 });
  const lid = await open.getAttribute('data-pkc-office-lid');
  expect(lid, '保存の戻り先(lid)が載っていない').toBeTruthy();

  // 窓の役を演じる口: 本体が窓へ送る文書の封筒を拾い、「ちょうだい」を送る
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const docs: { bytes: number[]; token: string; fromShadow: boolean | null }[] = [];
    w.__docs = docs;
    w.__closed = 0;
    w.__aliveAt = Date.now();
    const listen = new BroadcastChannel('pkc3-office');
    listen.onmessage = (e) => {
      const d = e.data as { pkc3Office?: string; payload?: { bytes?: Uint8Array; token?: string; fromShadow?: boolean } };
      if (d?.pkc3Office === 'closed') w.__closed = (w.__closed as number) + 1;
      if (d?.pkc3Office === 'alive') w.__aliveAt = Date.now();
      if (d?.pkc3Office === 'document' && d.payload?.bytes) {
        docs.push({
          bytes: Array.from(d.payload.bytes),
          token: String(d.payload.token ?? ''),
          fromShadow: 'fromShadow' in d.payload ? d.payload.fromShadow ?? null : null,
        });
      }
    };
    w.__listen = listen;
    w.__ask = new BroadcastChannel('pkc3-office');
  });
  const docs = (): Promise<{ bytes: number[]; token: string; fromShadow: boolean | null }[]> =>
    page.evaluate(() => (window as unknown as { __docs: never[] }).__docs);
  /**
   * 🔴 **窓を閉じたら、本体が「窓はもう無い」と見なすまで待つ**。⚠ 本体は窓が開いていそうな間(`isProbablyOpen`)は
   *   「開く」を押されても、控えを訊かず・新しい窓も開かず、開いている窓へ頼むだけにする(2 つ立てない)。
   *   「無い」と見なすのは ① 窓の `pagehide` が放つ「閉じた」放送を受けたとき ② 生存通知が `ALIVE_TTL_MS` 途絶えたとき の
   *   どちらか早いほう。Playwright の `page.close()` は窓を落とすだけで、放送が必ず先に出る保証が無い
   *   (負荷を掛けた実測で、放送が 5 秒待っても本体に来ない回があった)── そのときは ② になる。
   *   閉じた直後に押すと、①②のどちらも来ていない本体を押すことになり、`:302` では訊く確認が出ず、`:315` では窓が開かない。
   *   本体の受け口(`OfficeWindow.receive`)と同じ放送を、本体より後に作った受け口で数える。
   *   ⚠ これは検査が先走っていた分の修正で、本体は変えていない(閉じ方が「放送なし」の窓を ALIVE_TTL_MS のあいだ
   *   開いていると見なすのは設計どおり ── `isProbablyOpen` の注記「断定はできない」)。
   */
  const closeWindow = async (w: import('@playwright/test').Page): Promise<void> => {
    const state = (): Promise<{ closed: number; silentMs: number }> =>
      page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 0));
        const g = window as unknown as { __closed: number; __aliveAt: number };
        return { closed: g.__closed, silentMs: Date.now() - g.__aliveAt };
      });
    const before = (await state()).closed;
    await w.close();
    await expect
      .poll(
        async () => {
          const st = await state();
          // ② は本体の物差し(`ALIVE_TTL_MS`)に余裕を足して見る(本体と受け口で、受けた時刻が数 ms ずれる)
          return st.closed > before || st.silentMs > ALIVE_TTL_MS + 300;
        },
        { message: '窓を閉じた後、本体が「窓はもう無い」と見なさない', timeout: ALIVE_TTL_MS + 10_000 },
      )
      .toBe(true);
  };
  const windowAsks = (): Promise<void> =>
    page.evaluate(() => {
      (window as unknown as { __ask: BroadcastChannel }).__ask.postMessage({ pkc3Office: 'ready-for-document', payload: {} });
    });
  const shelf = (): Promise<string[]> =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      try {
        const top = await root.getDirectoryHandle('pkc3-office-shadow');
        const out: string[] = [];
        for await (const [name] of (top as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) out.push(name);
        return out;
      } catch {
        return [];
      }
    });

  // 控えを置く: 実物の窓の書き手(`office-shadow.js`)で、このノートの棚へ
  await page.addScriptTag({ url: '/office/office-shadow.js' });
  await page.evaluate(
    async ({ lid: id }) => {
      const SH = (window as unknown as { PKC3OfficeShadow: { safeId(t: string, f: string): string; shelve(d: unknown): Promise<unknown> } }).PKC3OfficeShadow;
      const bytes = new Uint8Array([7, 7, 7]);
      // ⚠ 正本(いま取り込んだ添付)より**新しい**時刻で置く(古い控えは訊かない)
      await SH.shelve({
        storage: navigator.storage,
        id: SH.safeId(id, 'w-smoke'),
        ext: 'docx',
        size: bytes.length,
        now: () => Date.now() + 2000,
        read: (into: Uint8Array, wanted: number, pos: number) => { into.set(bytes.subarray(pos, pos + wanted)); return wanted; },
        origin: { name: '報告書.docx', size: 1, lid: id },
      });
      // 窓の放送で、本体が「在るかもしれない」を読み直す(本物の窓が書いたときと同じ経路)
      new BroadcastChannel('pkc3-office').postMessage({ pkc3Office: 'shadow-written', payload: { at: Date.now() } });
    },
    { lid: lid! },
  );
  expect(await shelf(), '前提: 控えが棚に在る').toHaveLength(1);
  // 放送で本体が棚を読み直すのを待つ。⚠ 押した瞬間に間に合わないと「在るかもしれない」が偽のまま**同期で窓が開く**
  //    (その回は 1 つ目の確認の assert が窓の数で落ちる ── 気づける)。読み直しは棚の一覧と meta の数件だけ(数 ms)
  await page.waitForTimeout(500);
  const popups: import('@playwright/test').Page[] = [];
  context.on('page', (p) => popups.push(p));
  await clickReal(page, open);

  // ① 確認が出ている間は、窓を開いていない(押した click の続きで開くのは、答えを押したとき)
  const rows = page.locator('[data-pkc-field="pick-office-shadow"]');
  await expect(rows).toHaveText([SHADOW_OPEN_SHADOW_LABEL, SHADOW_OPEN_SAVED_LABEL]);
  await expect(rows.first(), '既定の押し所が保存していない編集の版でない').toBeFocused();
  await expect(page.locator('[data-pkc-field="pick-office-shadow-note"]')).toContainText('一時保存した内容があります');
  await expect(page.locator('[data-pkc-field="pick-office-shadow-note"]')).toContainText('保存済みの版で開くと、その内容は消えます');
  expect(popups, '確認を出している間に窓を開いた').toHaveLength(0);

  // ② やめる: 何も開かず、控えも残る
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  // ⚠ 閉じても中身は器に残る(器は使い回す)── 見るのは器が閉じたこと
  await expect(rows.first(), '確認が閉じていない').toBeHidden();
  await page.waitForTimeout(300);
  expect(popups, 'やめたのに窓が開いた').toHaveLength(0);
  expect(await shelf(), 'やめたのに控えを消した').toHaveLength(1);

  // ③ 一時保存した内容で開く: 窓が開き、渡る bytes は控えの版
  await clickReal(page, open);
  await expect(rows.first()).toBeVisible();
  const first = context.waitForEvent('page');
  await clickReal(page, rows.nth(0));
  const win1 = await first;
  expect(win1.url()).toContain('office/host.html');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText(SHADOW_OPENED_NOTICE);
  await windowAsks();
  await expect.poll(async () => (await docs()).length, { message: '文書が窓へ送られない' }).toBe(1);
  expect((await docs())[0], '控えの版が渡っていない').toEqual({ bytes: [7, 7, 7], token: lid, fromShadow: true });
  expect(await shelf(), '控えの版で開いただけで控えを消した(保存するまで残す)').toHaveLength(1);
  await closeWindow(win1);

  // ④ 保存済みの版で開く: 控えが消え、渡る bytes は保存済みの版
  await clickReal(page, open);
  await expect(rows.first()).toBeVisible();
  const second = context.waitForEvent('page');
  await clickReal(page, rows.nth(1));
  const win2 = await second;
  await windowAsks();
  await expect.poll(async () => (await docs()).length, { message: '2 回目の文書が窓へ送られない' }).toBe(2);
  const saved = (await docs())[1]!;
  expect(saved.bytes, '保存済みの版が渡っていない').toEqual(Array.from(FAKE_DOCX));
  expect(saved.fromShadow, '保存済みの版に fromShadow が載った').toBeNull();
  expect(await shelf(), '保存済みの版で開いたのに控えが残っている').toEqual([]);
  await closeWindow(win2);

  // ⑤ 対照群: 控えが無ければ、訊かずに窓が開く
  const third = context.waitForEvent('page');
  await clickReal(page, open);
  const win3 = await third;
  expect(win3.url()).toContain('office/host.html');
  await expect(rows.first(), '控えが無いのに訊いた').toBeHidden();
  await closeWindow(win3);

  /**
   * 🔴 **大きい文書は、開く前に「開けないことがあります」と言う**(台帳 #1852 束 A1。依頼 242)。
   * ⚠ 直す前は、とても大きい文書で Office の窓が空のまま止まり、PKC3 は何も言わなかった。言うだけで、開くのは止めない。
   * 🔑 境目(300MB)を越える疎なファイルを**経路で**渡す(bytes を CDP に載せない)── 新しい起動は足さない。
   *   対照群は上の小さい文書(開いたとき、この知らせは出ていない)。
   */
  await expect(page.locator('[data-pkc-region="status"]'), '対照群:小さい文書で大きい文書の知らせが出ている').not.toContainText('大きい文書');
  // ⚠ 名前は ASCII ── この headless は非 ASCII の名前の file を経路で渡すと添付にならない(CLAUDE.md §4 の download 名と同じ癖)
  const bigPath = join(mkdtempSync(join(tmpdir(), 'pkc3-big-')), 'big2.docx');
  writeFileSync(bigPath, '');
  truncateSync(bigPath, OFFICE_LARGE_DOC_BYTES + 1024 * 1024);
  try {
    await page.setInputFiles('[data-pkc-field="attach-input"]', bigPath);
    const bigRow = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]:has-text("big2.docx")');
    await expect(bigRow, '大きい文書の添付が一覧に出ない').toHaveCount(1, { timeout: 90_000 });
    await clickReal(page, bigRow);
    const bigOpen = page.locator('[data-pkc-action="open-office"]');
    await expect(bigOpen, '大きい文書の「Office で開く」が出ない').toHaveCount(1, { timeout: 60_000 });
    const fourth = context.waitForEvent('page');
    await clickReal(page, bigOpen);
    const win4 = await fourth;
    await expect(
      page.locator('[data-pkc-region="status"]'),
      '🔴 大きい文書なのに「開けないことがあります」と言っていない',
    ).toContainText('Office で開けないことがあります', { timeout: 60_000 });
    await expect(page.locator('[data-pkc-region="status"]')).toContainText('「big2.docx」は大きい文書');
    await win4.close();
  } finally {
    rmSync(dirname(bigPath), { recursive: true, force: true });
  }

  expect(errors).toEqual([]);
});
