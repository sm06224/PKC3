/**
 * smoke: **PDF を PKC3 の PDF ビューアで読み、字を選んでノートへ引く**(#275 段①)。
 *
 * 裁定(Gemini):設定で選んだ人だけ・**既定はブラウザ内蔵の表示**。この 1 本が 1 回の起動で通す物語:
 *
 *   ① 何も選んでいない(既定)── 「別のウィンドウで見る」は今までの窓(`<object>`)で、PKC3 の PDF ビューアは出ない(対照群)
 *   ② 設定の「PDF」を入にする
 *   ③ もう一度押す ── 別窓が **PKC3 の PDF ビューア**で開き、見えている頁の前後だけが PNG の `<img>` で出て、字が選べる層がある
 *   ④ 末尾へ送ると、**外れた頁の ObjectURL が revoke される**(描いたら焼き、外れたら即返す)/ 文書内を探せる
 *     🔴 そして**「作った ObjectURL の数 − 返した数 ≤ 窓の中の絵の数」**(**描いている最中に窓から外れた頁**の
 *     返し忘れ ── 外れた頁の revoke が 1 度でも出れば「返した数 > 0」は満たされるので、数では見えない)
 *   ⑤ 3 頁目の字を選んで「ノートへ引く」── 本体のノートの末尾に**頁番号(p.3)と添付名つき**の引用が入る
 *   ⑥ 読めない PDF ── **断り文を出さず**ブラウザ内蔵の表示へ退避し、状態の行に 1 行出る
 *   ⑦ 電波が無いとき ── 1 度読めた後は**オフラインでも PKC3 の PDF ビューアで読める**(`pdf/lib/` は precache に無いが、取れた後は
 *     service worker の runtime cache から出る)/ まだ 1 度も取れていない所では、内蔵の表示へ退避する
 *   ④′ 使われない間は**解析の worker を畳む**(窓の中に worker が 0 になる)/ 描いた頁の絵は残り、まだ描いていない頁を
 *     描くとき**黙って開き直す**(worker が 1 に戻る)。⚠ 60 秒は実時間では待てないので、窓の時計だけ差し替える
 *   ③′ ページの一覧(#275 段②-1a)── 窓の左に頁の数だけ小さな絵が並び、押すとその頁へ移り、いまの頁が光り、ボタンで隠す / 出す
 *   ④″ 文書内の検索の一致が **span 2 つにまたがる**とき、両方の span に**一致した範囲だけ**の強調が付く
 *
 * 🔑 起動を 1 つに収める理由(`scripts/smoke-budget.mjs` の予算): 設定の入切 → 同じ添付で窓の中身が替わる、
 *   という**切り替えの前後**が本命なので、対照群(切)と本命(入)を同じ起動の中で続けて見る必要がある
 *   (別々に起動すると、同じ添付・同じノートでの差を見ていることにならない)。
 * ⚠ 観測点は**窓の中の実物**(画像の実寸・字の層・revoke の呼び出し・本体の本文)── 属性が付いたかではなく、
 *   画面に出て、選べて、本体へ届いたかを見る。
 * ⚠ fixture は**自作**(下の `buildPdf`)── 頁ごとに字が違う(`marker<頁>`)ので、どの頁を引いたかが字で分かる。
 */
import { expect, test } from '@playwright/test';
import { clickReal, collectPageErrors, gotoApp } from './helpers';

/** 自作の PDF(`pages` 頁・Helvetica で `Hello page N marker<N>`)。xref の位置は組みながら数える。 */
function buildPdf(pages: number): Buffer {
  const objs: string[] = [];
  const kids: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const boldObj = 4 + pages * 2;
  objs[boldObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  for (let i = 0; i < pages; i += 1) {
    const pageObj = 4 + i * 2;
    kids.push(`${String(pageObj)} 0 R`);
    // 🔑 3 頁目だけ、書体を変えて 2 つの塊(= 文字の層の span 2 つ)に分かれる 1 行を足す:「split」+「match」。
    //    pdf.js は書体が変わるところで文字を別の塊にするので、「litma」の一致は 2 つの span にまたがる
    const split = i === 2 ? ' /F1 24 Tf 0 -100 Td (split) Tj /F2 24 Tf (match) Tj' : '';
    const stream = `BT /F1 24 Tf 40 300 Td (Hello page ${String(i + 1)} marker${String(i + 1)}) Tj${split} ET`;
    objs[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 3 0 R /F2 ${String(boldObj)} 0 R >> >> /Contents ${String(pageObj + 1)} 0 R >>`;
    objs[pageObj + 1] = `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${String(pages)} >>`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  for (let n = 1; n < objs.length; n += 1) {
    offs[n] = out.length;
    out += `${String(n)} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${String(objs.length)}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n += 1) out += `${String(offs[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objs.length)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PAGES = 10;

test('🔴 PDF を PKC3 の PDF ビューアで読み、字を選んでノートへ引ける(設定で選んだ人だけ)', async ({ page, context }) => {
  // ⚠ 窓の中の revoke を数える(描いた頁の ObjectURL を、外れたときに返しているか)。本体の側は数えない
  await context.addInitScript(() => {
    const w = window as unknown as { __revoked: string[]; __created: number };
    w.__revoked = [];
    w.__created = 0;
    const orig = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u: string): void => {
      w.__revoked.push(u);
      orig(u);
    };
    // 一覧の絵(小さな canvas)だけ、頼んだときに「絵にできなかった」(null)を返す ── 描き直しが止まるかを見る
    const w2 = window as unknown as { __nullThumb: boolean; __nullCalls: number };
    w2.__nullThumb = false;
    w2.__nullCalls = 0;
    const origBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, ...rest: unknown[]): void {
      if (w2.__nullThumb && this.width < 300) {
        w2.__nullCalls += 1;
        cb(null);
        return;
      }
      (origBlob as (...a: unknown[]) => void).call(this, cb, ...rest);
    };
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource): string => {
      w.__created += 1;
      return origCreate(o);
    };
  });
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '見積.pdf',
    mimeType: 'application/pdf',
    buffer: buildPdf(PAGES),
  });
  await expect(page.locator('[data-pkc-field="attachment-media"]')).toHaveAttribute(
    'type',
    'application/pdf',
  );

  // ── ① 対照群: 何も選んでいない ── 今までのブラウザ内蔵の窓(PKC3 の PDF ビューアは出ない) ──
  const [plain] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await plain.waitForSelector('[data-pkc-field="asset-window-pdf"]', { timeout: 5000 });
  expect(
    await plain.locator('[data-pkc-field="pdf-page-image"]').count(),
    '既定(切)なのに PKC3 の PDF ビューアで開いている',
  ).toBe(0);
  await plain.close();

  // ── ② 設定の「PDF」を入にする ──
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const box = page.locator('[data-pkc-field="pdf-reader"]');
  await expect(box, '設定に「PDF」が無い').toHaveCount(1);
  await expect(box, '既定が入になっている(選んでいない人の窓が変わる)').not.toBeChecked();
  await clickReal(page, '[data-pkc-field="pdf-reader"]');
  await expect(box, '押しても入にならない').toBeChecked();
  // 設定を閉じて、添付の画面へ戻る(同じボタンをもう一度押す)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  // 🔴 service worker が制御を持ってから開く ── 持つ前に窓を開くと、窓が取りに行く本体(`pdf/lib/`)が
  //    runtime cache に落ちず、⑦(オフラインで読める)が空振りする
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 30_000 });
  // 🔑 ④′(使われない間の worker の kill)のために、時計を差し替える ── 60 秒を実時間では待てない。
  //    差し替えても時間は実時間どおり流れる(`fastForward` で進めたときだけ、予約が早く来る)
  await context.clock.install();

  // ── ③ もう一度押す ── 別窓が PKC3 の PDF ビューアで開く ──
  const [win] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  const winErrors: string[] = [];
  win.on('pageerror', (e) => winErrors.push(e.message));
  const img = win.locator('[data-pkc-field="pdf-page-image"]');
  await expect(img.first(), '頁の絵が出ない(PKC3 の PDF ビューアで開いていない / 読めていない)').toBeAttached({
    timeout: 20_000,
  });
  await expect
    .poll(() => img.first().evaluate((el: HTMLImageElement) => el.naturalWidth), {
      message: '頁の絵が読み込まれていない(blob が先に返っている)',
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  expect(await win.title(), '窓の題名が添付の名前でない').toBe('見積.pdf');
  expect(await img.first().getAttribute('src'), '焼いた絵は ObjectURL の <img>').toMatch(/^blob:/);
  // 🔑 内蔵の表示(<object>)へは落ちていない
  expect(await win.locator('[data-pkc-field="pdf-reader-fallback"]').count()).toBe(0);
  expect(await win.locator('body').getAttribute('data-pkc-pdf-state')).toBe('ready');
  // 字を選べる層 ── 本文の字が入っている
  await expect(win.locator('.textLayer span').first(), '字を選べる層が出ない').toContainText('Hello page 1', {
    timeout: 15_000,
  });

  // ⑦ のための仕込み: 日本語の cmap(文書が使うまで取りに行かない部品)も 1 度取っておく ── `pdf/lib/` の
  //    **js 以外の部品**も runtime cache に落ちること(落ちていなければ、次の文書の日本語がオフラインで読めない)
  const cmapBytes = (w: typeof win): Promise<number> =>
    w.evaluate(() =>
      fetch('./lib/cmaps/90ms-RKSJ-H.bcmap').then(async (r) => (r.ok ? (await r.arrayBuffer()).byteLength : 0)),
    );
  expect(await cmapBytes(win), 'オンラインで cmap が取れない(観測が空振り)').toBeGreaterThan(0);

  const livePages = (): Promise<string[]> =>
    win.evaluate(() =>
      [...document.querySelectorAll('.page')]
        .filter((p) => p.querySelector('img') !== null)
        .map((p) => p.getAttribute('data-page') ?? ''),
    );
  const revoked = (): Promise<number> =>
    win.evaluate(() => (window as unknown as { __revoked: string[] }).__revoked.length);

  // 見えている頁の前後だけが絵になっている(10 頁全部を描いていない)
  const first = await livePages();
  expect(first, '先頭の頁が絵になっていない').toContain('1');
  expect(first, '見えていない遠い頁まで描いている(焼く範囲は前後 2 頁)').not.toContain(String(PAGES));
  expect(await revoked(), '何も外れていないのに revoke している').toBe(0);

  // ── ③′ ページの一覧(#275 段②-1a)── 窓の左に小さな絵が並び、押すとそのページへ移り、ボタンで出し入れできる ──
  const plist = win.locator('#plist');
  const thumbs = win.locator('[data-pkc-field="pdf-page-thumb"]');
  const toggle = win.locator('#toggle-list');
  const thumbImgs = win.locator('[data-pkc-field="pdf-page-thumb-image"]');
  const cssOf = (loc: typeof plist, prop: string): Promise<string> =>
    loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  await expect(plist, 'ページの一覧が既定で出ていない').toBeVisible();
  await expect(thumbs, '一覧の項目の数が頁の数と違う').toHaveCount(PAGES);
  expect(await win.locator('body').getAttribute('data-pkc-pdf-list')).toBe('on');
  await expect(toggle, '出し入れのボタンが押された印になっていない').toHaveAttribute('aria-pressed', 'true');
  // 小さな絵が実際に読み込まれている
  await expect
    .poll(() => thumbImgs.first().evaluate((el: HTMLImageElement) => el.naturalWidth), {
      message: '一覧の絵が読み込まれていない',
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  // 幅は固定の小ささで、読む側は残りを使う(読む幅を奪いすぎない)
  const plistBox = await plist.boundingBox();
  const scrollBox = await win.locator('#scroller').boundingBox();
  expect(plistBox?.width, '一覧の幅が 120px でない').toBe(120);
  expect(scrollBox?.x, '読む側が一覧の右から始まっていない').toBe(120);
  const winWidth = await win.evaluate(() => window.innerWidth);
  expect(scrollBox?.width, '読む側の幅が窓の残り(窓の幅 − 120)でない').toBe(winWidth - 120);
  // 🔑 いまの頁(1)が見分けられる ── 属性ではなく、計算後の色が他の項目と違う
  const item = (n: number) => win.locator(`[data-pkc-field="pdf-page-thumb"][data-thumb="${String(n)}"]`);
  await expect(item(1), 'いまの頁が光っていない').toHaveAttribute('aria-current', 'true');
  const curColor = await cssOf(item(1), 'border-top-color');
  const otherColor = await cssOf(item(2), 'border-top-color');
  expect(curColor, 'いまの頁の枠の色が、ほかの項目と見分けられない(CSS に受け皿が無い)').not.toBe(otherColor);
  const pressedBg = await cssOf(toggle, 'background-color');

  // 押すとそのページへ移る(3 頁目)。光る頁も移る
  await clickReal(win, '[data-pkc-field="pdf-page-thumb"][data-thumb="3"]');
  await expect
    .poll(
      async () => {
        const top = await win.locator('.page[data-page="3"]').evaluate((el) => el.getBoundingClientRect().top);
        const sTop = await win.locator('#scroller').evaluate((el) => el.getBoundingClientRect().top);
        return Math.abs(top - sTop);
      },
      { message: '3 頁目の絵を押しても、3 頁目へ移っていない', timeout: 10_000 },
    )
    .toBeLessThan(40);
  await expect(item(3), '移った頁が光っていない').toHaveAttribute('aria-current', 'true');
  await expect(item(1), '前の頁の光りが残っている').not.toHaveAttribute('aria-current', 'true');
  await expect(win.locator('#pageno'), '頁番号の欄が移っていない').toHaveValue('3');

  // ボタンで隠す ── 一覧が消え、読む側が左端まで広がり、絵は返される(隠している間は何も持たない)
  const revokedBeforeHide = await revoked();
  // 🔴 隠す前の一覧の絵の URL を控える ── 読む頁の置き場の掃除(幅合わせ)では返らない物なので、
  //    「一覧の絵を 1 つずつ返した」をこれで言う(数が増えただけでは、読む頁の分で満たされる)
  const thumbSrcs = await thumbImgs.evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
  expect(thumbSrcs.length, '隠す前に一覧の絵が無い(観測が空振り)').toBeGreaterThan(0);
  expect(thumbSrcs.every((u) => u.startsWith('blob:'))).toBe(true);
  await clickReal(win, '#toggle-list');
  await expect(plist, '隠せない').toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await win.locator('body').getAttribute('data-pkc-pdf-list')).toBe('off');
  expect((await win.locator('#scroller').boundingBox())?.x, '隠しても読む側が広がらない').toBe(0);
  expect(await cssOf(toggle, 'background-color'), '押された印と押されていない印が、色で見分けられない').not.toBe(pressedBg);
  expect(await thumbImgs.count(), '隠したのに一覧の絵を持ち続けている').toBe(0);
  await expect
    .poll(revoked, { message: '隠したのに一覧の ObjectURL を返していない', timeout: 5000 })
    .toBeGreaterThan(revokedBeforeHide);
  await expect
    .poll(
      () =>
        win.evaluate(
          (srcs) => srcs.every((u) => (window as unknown as { __revoked: string[] }).__revoked.includes(u)),
          thumbSrcs,
        ),
      { message: '隠したのに、一覧の絵の ObjectURL を 1 つずつ返していない', timeout: 5000 },
    )
    .toBe(true);
  // 出し直す ── 絵がまた出て、いまの頁(3)が光っている
  await clickReal(win, '#toggle-list');
  await expect(plist, '出し直せない').toBeVisible();
  await expect(item(3)).toHaveAttribute('aria-current', 'true');
  await expect
    .poll(() => thumbImgs.count(), { message: '出し直したのに絵が出ない', timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect(win.locator('.page img').first(), '出し入れの後に読む頁が消えている').toBeAttached({ timeout: 15_000 });

  // 絵にできなかった頁は、描き直し続けない(隠して出し直すと、もう 1 度だけ試す)
  const nullCalls = (): Promise<number> =>
    win.evaluate(() => (window as unknown as { __nullCalls: number }).__nullCalls);
  // 先に全部描き終えておく(描いている最中に印を立てると、その分も数に入る)
  await expect.poll(() => thumbImgs.count(), { message: '一覧の絵が揃わない', timeout: 20_000 }).toBe(PAGES);
  await win.evaluate(() => {
    (window as unknown as { __nullThumb: boolean }).__nullThumb = true;
  });
  await clickReal(win, '#toggle-list');
  await clickReal(win, '#toggle-list');
  await expect.poll(nullCalls, { message: '絵にできない頁を試してもいない(観測が空振り)', timeout: 10_000 }).toBeGreaterThan(0);
  await win.waitForTimeout(1500);
  const nullA = await nullCalls();
  await win.waitForTimeout(1500);
  expect(await nullCalls(), '絵にできなかった頁を描き直し続けている').toBe(nullA);
  expect(nullA, '同じ頁を何度も試している(頁の数を超えた)').toBeLessThanOrEqual(PAGES);
  await win.evaluate(() => {
    (window as unknown as { __nullThumb: boolean }).__nullThumb = false;
  });
  await clickReal(win, '#toggle-list');
  await clickReal(win, '#toggle-list');
  await expect.poll(() => thumbImgs.count(), { message: '失敗が直った後に絵が戻らない', timeout: 15_000 }).toBeGreaterThan(0);

  // キーボード: Tab の止まり先は「いまの頁」の 1 つだけ。矢印で動き、Enter でその頁へ移る
  expect(await thumbs.evaluateAll((els) => els.filter((e) => e.getAttribute('tabindex') === '0').length)).toBe(1);
  await expect(item(3), 'Tab の止まり先がいまの頁でない').toHaveAttribute('tabindex', '0');
  await expect(item(2)).toHaveAttribute('tabindex', '-1');
  await win.focus('#hit-next');
  await win.keyboard.press('Tab');
  expect(await win.evaluate(() => document.activeElement?.getAttribute('data-thumb')), 'Tab がいまの頁の項目に着かない').toBe('3');
  await win.keyboard.press('ArrowDown');
  expect(await win.evaluate(() => document.activeElement?.getAttribute('data-thumb')), '↓ で次の項目へ動かない').toBe('4');
  await win.keyboard.press('ArrowUp');
  expect(await win.evaluate(() => document.activeElement?.getAttribute('data-thumb')), '↑ で前の項目へ動かない').toBe('3');
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter');
  await expect(win.locator('#pageno'), 'Enter でその頁へ移らない').toHaveValue('4', { timeout: 10_000 });
  await expect(item(4)).toHaveAttribute('aria-current', 'true');

  // ── ④ 末尾へ送ると、外れた頁の絵が返される ──
  await win.locator('#scroller').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect
    .poll(livePages, { message: '末尾の頁が絵にならない', timeout: 15_000 })
    .toContain(String(PAGES));
  const bottom = await livePages();
  expect(bottom, '外れた先頭の頁の絵が残っている').not.toContain('1');
  await expect
    .poll(revoked, { message: '外れた頁の ObjectURL を返していない(閉じるまで積もる)', timeout: 10_000 })
    .toBeGreaterThan(0);

  // 🔴 描いている最中に窓から外れた頁も、絵を持ち越さない ──
  //    先頭 ⇄ 末尾を**待たずに**往復して、描画の途中で窓から外れる頁を作る(いま持っている絵だけが生きている)
  await win.evaluate(async () => {
    const sc = document.getElementById('scroller');
    if (sc === null) throw new Error('scroller が無い');
    const frames = (): Promise<void> =>
      new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
    for (let i = 0; i < 4; i += 1) {
      sc.scrollTop = sc.scrollHeight;
      await frames();
      sc.scrollTop = 0;
      await frames();
    }
    // 描画が落ち着くまで(作った数 + 返した数が 3 回続けて動かない)
    let last = -1;
    let same = 0;
    while (same < 3) {
      await new Promise((r) => setTimeout(r, 250));
      const w = window as unknown as { __revoked: string[]; __created: number };
      const now = w.__created + w.__revoked.length;
      same = now === last ? same + 1 : 0;
      last = now;
    }
  });
  const held = await win.evaluate(() => {
    const w = window as unknown as { __revoked: string[]; __created: number };
    return {
      created: w.__created,
      revoked: w.__revoked.length,
      imgs: document.querySelectorAll('img[data-pkc-field^="pdf-page"]').length, // 読む頁の絵 + 一覧の絵(どちらも ObjectURL を握る)
    };
  });
  expect(held.created, '往復しても 1 枚も焼いていない(観測が空振り)').toBeGreaterThan(held.imgs);
  expect(
    held.created - held.revoked,
    `作った ObjectURL(${String(held.created)})のうち返していない数が、窓の中の絵の数(${String(held.imgs)})を超えている ── 描画中に外れた頁の絵を返し忘れている`,
  ).toBeLessThanOrEqual(held.imgs);

  // ── ④′ 使われない間は、解析の worker を畳む(常駐メモリを返す)。描いた頁の絵は残り、使い直すとき黙って開き直す ──
  //    観測点は窓の中の worker の実在(`page.workers()`)── 窓の中の変数ではなく、ブラウザが持つ worker そのもの
  const workers = (): number => win.workers().length;
  expect(workers(), '頁を描いているのに worker が居ない(観測が空振り)').toBeGreaterThan(0);
  const keptBefore = await livePages();
  expect(keptBefore.length, '絵が 1 枚も無い(観測が空振り)').toBeGreaterThan(0);
  // 🔴 畳むのは「飛んでいる依頼が無いまま 60 秒」── 59 秒では畳まれない(対照群 = 早すぎる kill をしない)
  await win.clock.fastForward(59_000);
  expect(workers(), '60 秒より前に worker を畳んでいる').toBeGreaterThan(0);
  await win.clock.fastForward(2_000);
  await expect
    .poll(workers, { message: '使われないのに worker が畳まれない(常駐メモリが返らない)', timeout: 10_000 })
    .toBe(0);
  expect(await livePages(), '畳んだら描いた頁の絵まで消えている').toEqual(keptBefore);
  await expect(img.first(), '畳んだ後に絵が壊れている').toBeAttached();
  // 使い直す: まだ描いていない頁(いまは先頭の頁が絵 = 末尾の頁は絵になっていない)を描くとき、黙って開き直す
  expect(keptBefore, '末尾の頁が既に絵になっている(開き直しを要する場面ではない)').not.toContain(String(PAGES));
  await win.locator('#scroller').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect
    .poll(livePages, { message: '畳んだ後に、描いていない頁を描けない(開き直せない)', timeout: 20_000 })
    .toContain(String(PAGES));
  expect(workers(), '開き直したのに worker が居ない').toBeGreaterThan(0);
  await expect
    .poll(
      () => win.locator(`.page[data-page="${String(PAGES)}"] img`).evaluate((el: HTMLImageElement) => el.naturalWidth),
      { message: '開き直して描いた絵が読み込まれていない', timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // 文書内を探す
  await win.fill('#query', 'marker3');
  await win.press('#query', 'Enter');
  await expect(win.locator('#hits')).toContainText('1 / 1 件(3 ページ)', { timeout: 15_000 });
  await expect.poll(livePages, { message: '見つけた頁へ移っていない', timeout: 15_000 }).toContain('3');
  // 一致した範囲だけが光る(「marker3」の字だけ。行全体ではない)
  await expect(win.locator('.page[data-page="3"] .textLayer mark.hit')).toHaveText(['marker3'], { timeout: 15_000 });

  // ── ④″ 一致が span 2 つにまたがる ──「split」+「match」(書体が違うので別の span)の「litma」
  await win.fill('#query', 'litma');
  await win.press('#query', 'Enter');
  await expect(win.locator('#hits')).toContainText('1 / 1 件(3 ページ)', { timeout: 15_000 });
  const marks = win.locator('.page[data-page="3"] .textLayer mark.hit');
  // 🔴 2 つの span の両方に、その span の中の一致した範囲だけ(先頭の span にしか付かない / span 全体が光る、を許さない)
  await expect(marks, 'またがる一致が両方の span に付いていない').toHaveText(['lit', 'ma'], { timeout: 15_000 });
  const owners = await marks.evaluateAll((els) => els.map((e) => e.parentElement?.textContent ?? ''));
  expect(owners, '強調が別々の span に割り付いていない').toEqual(['split', 'match']);
  // 強調しても、選んで引く字(span の字)は変わらない
  expect(
    await win.locator('.page[data-page="3"] .textLayer span', { hasText: 'split' }).first().textContent(),
  ).toBe('split');
  // 探し直すと、前の強調は外れる(字は元の 1 つに戻る)
  await win.fill('#query', 'marker3');
  await win.press('#query', 'Enter');
  await expect(win.locator('.page[data-page="3"] .textLayer mark.hit')).toHaveText(['marker3'], { timeout: 15_000 });
  expect(await win.locator('.page[data-page="3"] .textLayer span', { hasText: 'split' }).first().innerHTML()).toBe('split');

  // ── ⑤ 3 頁目の字を選ぶ → 「ノートへ引く」──
  const quote = win.locator('#quote');
  await win.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(quote, '何も選んでいないのに押せる').toBeDisabled();
  await win.evaluate(() => {
    const el = document.querySelector('.page[data-page="3"] .textLayer span');
    if (el === null) throw new Error('3 頁目の字の層が無い');
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(el);
    sel?.addRange(r);
  });
  await expect(quote, '字を選んでも「ノートへ引く」が押せない').toBeEnabled();
  await clickReal(win, '#quote');

  // 窓へ結果が返り、本体の状態の行にも出る
  await expect(win.locator('#status')).toContainText('の末尾へ引用しました(3 ページ)', { timeout: 10_000 });
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('の末尾へ引用しました(3 ページ)');
  // 🔴 本体のノートに、頁番号と添付の名前つきの引用が入っている(結びついたノートが無いので添付自身)
  await expect
    .poll(() => page.locator('[data-pkc-region="detail"]').innerText(), {
      message: '本体のノートに引用が入っていない',
      timeout: 10_000,
    })
    .toContain('marker3 (p.3、見積.pdf)');
  await win.close();

  // ── ⑤′ 頁が多い文書の一覧(70 頁)── 持つ絵の数に上限があり、離れた頁の絵は返され、読み進めると光る項目が見える所へ動く ──
  const LONG = 70;
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '長い見本.pdf',
    mimeType: 'application/pdf',
    buffer: buildPdf(LONG),
  });
  await clickReal(
    page,
    page.locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: '長い見本.pdf' }),
  );
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', '長い見本.pdf');
  const [big] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  const bigThumbs = big.locator('[data-pkc-field="pdf-page-thumb"]');
  const bigImgs = big.locator('[data-pkc-field="pdf-page-thumb-image"]');
  await expect(bigThumbs, '70 頁なのに一覧の項目が 70 でない').toHaveCount(LONG, { timeout: 20_000 });
  await expect.poll(() => bigImgs.count(), { message: '一覧の絵が出ない', timeout: 20_000 }).toBeGreaterThan(0);
  await expect(big.locator('[data-thumb="1"] img'), '先頭の項目の絵が出ない').toHaveCount(1, { timeout: 15_000 });
  const bigRect = (n: number): Promise<{ top: number; bottom: number }> =>
    big.evaluate((k) => {
      const el = document.querySelector(`[data-pkc-field="pdf-page-thumb"][data-thumb="${String(k)}"]`);
      const list = document.getElementById('plist');
      if (el === null || list === null) throw new Error('項目が無い');
      const r = el.getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      return { top: r.top - lr.top, bottom: r.bottom - lr.top - lr.height };
    }, n);
  // 一覧を末尾までスクロール ── 先頭付近の絵は返され、持つ絵は上限(40)以内
  await big.locator('#plist').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(big.locator(`[data-thumb="${String(LONG)}"] img`), '末尾の項目の絵が出ない').toHaveCount(1, { timeout: 20_000 });
  await expect
    .poll(() => big.locator('[data-thumb="1"] img').count(), {
      message: '一覧から遠く離れた先頭の絵を持ち続けている(外れた絵を返していない)',
      timeout: 10_000,
    })
    .toBe(0);
  expect(await bigImgs.count(), '一覧の絵が上限(40)を超えている').toBeLessThanOrEqual(40);
  // 読み進めて光る項目が一覧の外へ出たら、見える所へ動く: 一覧を先頭へ戻し、頁番号の欄から末尾の頁へ送る
  await big.locator('#plist').evaluate((el) => (el.scrollTop = 0));
  await big.fill('#pageno', String(LONG));
  await big.press('#pageno', 'Enter');
  await expect
    .poll(
      async () => {
        const cur = await big.locator('[data-pkc-field="pdf-page-thumb"][aria-current="true"]').getAttribute('data-thumb');
        if (cur === null || Number(cur) < LONG - 3) return 'まだ末尾の頁が光らない';
        const r = await bigRect(Number(cur));
        return r.top >= -1 && r.bottom <= 1 ? 'ok' : `見える所の外(top=${String(r.top)} bottom=${String(r.bottom)})`;
      },
      { message: '光る項目が一覧の外のまま(読み進めても、光る頁が見える所へ動かない)', timeout: 15_000 },
    )
    .toBe('ok');
  await big.close();

  // ── ⑥ 読めない PDF ── 断り文を出さず、ブラウザ内蔵の表示へ退避する ──
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '読めない見本.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nthis is not a pdf'),
  });
  // ⚠ 取り込んでも選択は元のノートへ返る(#666)── 新しい添付を**自分で選ぶ**(選ばないと 1 つ目の窓が開く)
  await clickReal(
    page,
    page.locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: '読めない見本.pdf' }),
  );
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute(
    'data-pkc-asset-name',
    '読めない見本.pdf',
  );
  const [bad] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await expect(
    bad.locator('[data-pkc-field="pdf-reader-fallback"]'),
    '読めない PDF が内蔵の表示へ退避していない',
  ).toHaveCount(1, { timeout: 20_000 });
  expect(await bad.locator('[data-pkc-field="pdf-page-image"]').count()).toBe(0);
  // 断り文は出さない(窓の中に message は無い)── 退避したことは本体の状態の行に 1 行
  await expect(bad.locator('#msg'), '退避なのに断り文が出ている').toBeHidden();
  await expect(page.locator('[data-pkc-region="status"]')).toContainText(
    'PDF 表示で開きました',
    { timeout: 10_000 },
  );
  await bad.close();

  // ── ⑦ 電波が無いとき ──
  //    ⚠ `setOffline` ではなく **route で abort**(service worker 自身の fetch も止める。offline.smoke と同じ理由)
  await clickReal(
    page,
    page.locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: '見積.pdf' }),
  );
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', '見積.pdf');
  await context.route('**/*', (route) => route.abort('internetdisconnected'));
  // (a) 1 度読めた後は、電波が無くても PKC3 の PDF ビューアで読める(`pdf/lib/` は precache に無いが、取れた後は cache から出る)
  const [off] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await expect(
    off.locator('[data-pkc-field="pdf-page-image"]').first(),
    '電波が無いと PKC3 の PDF ビューアで読めない(1 度読めた後なのに、本体が cache から出ていない)',
  ).toBeAttached({ timeout: 20_000 });
  expect(await off.locator('body').getAttribute('data-pkc-pdf-state')).toBe('ready');
  expect(await off.locator('[data-pkc-field="pdf-reader-fallback"]').count(), '1 度読めたのに内蔵の表示へ退避している').toBe(0);
  expect(await cmapBytes(off), '日本語の cmap が電波なしで出ない').toBeGreaterThan(0);
  await off.close();
  // (b) まだ 1 度も取れていない所(runtime cache を空にする)では、内蔵の表示へ退避する ── 窓は固まらず、PDF は読める
  await page.evaluate(async () => {
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const r of await c.keys()) if (new URL(r.url).pathname.includes('/pdf/lib/')) await c.delete(r);
    }
  });
  const [cold] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await expect(
    cold.locator('[data-pkc-field="pdf-reader-fallback"]'),
    '電波が無く、まだ本体を取れていないのに、内蔵の表示へ退避しない(窓が固まる)',
  ).toHaveCount(1, { timeout: 20_000 });
  expect(await cold.locator('[data-pkc-field="pdf-page-image"]').count()).toBe(0);
  await expect(cold.locator('#msg'), '退避なのに断り文が出ている').toBeHidden();
  await cold.close();
  await context.unroute('**/*');

  expect(winErrors, '窓の中で例外が出ている').toEqual([]);
  expect(errors).toEqual([]);
});
