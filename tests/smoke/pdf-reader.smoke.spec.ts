/**
 * smoke: **PDF を PKC の画面で読み、字を選んでノートへ引く**(#275 段①)。
 *
 * 裁定(Gemini):設定で選んだ人だけ・**既定はブラウザ内蔵の表示**。この 1 本が 1 回の起動で通す物語:
 *
 *   ① 何も選んでいない(既定)── 「別のウィンドウで見る」は今までの窓(`<object>`)で、PKC の画面は出ない(対照群)
 *   ② 設定の「PDF」を入にする
 *   ③ もう一度押す ── 別窓が **PKC の画面**で開き、見えている頁の前後だけが PNG の `<img>` で出て、字が選べる層がある
 *   ④ 末尾へ送ると、**外れた頁の ObjectURL が revoke される**(描いたら焼き、外れたら即返す)/ 文書内を探せる
 *     🔴 そして**「作った ObjectURL の数 − 返した数 ≤ 窓の中の絵の数」**(**描いている最中に窓から外れた頁**の
 *     返し忘れ ── 外れた頁の revoke が 1 度でも出れば「返した数 > 0」は満たされるので、数では見えない)
 *   ⑤ 3 頁目の字を選んで「ノートへ引く」── 本体のノートの末尾に**頁番号(p.3)と添付名つき**の引用が入る
 *   ⑥ 読めない PDF ── **断り文を出さず**ブラウザ内蔵の表示へ退避し、状態の行に 1 行出る
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
  for (let i = 0; i < pages; i += 1) {
    const pageObj = 4 + i * 2;
    kids.push(`${String(pageObj)} 0 R`);
    const stream = `BT /F1 24 Tf 40 300 Td (Hello page ${String(i + 1)} marker${String(i + 1)}) Tj ET`;
    objs[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageObj + 1)} 0 R >>`;
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

test('🔴 PDF を PKC の画面で読み、字を選んでノートへ引ける(設定で選んだ人だけ)', async ({ page, context }) => {
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

  // ── ① 対照群: 何も選んでいない ── 今までのブラウザ内蔵の窓(PKC の画面は出ない) ──
  const [plain] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await plain.waitForSelector('[data-pkc-field="asset-window-pdf"]', { timeout: 5000 });
  expect(
    await plain.locator('[data-pkc-field="pdf-page-image"]').count(),
    '既定(切)なのに PKC の画面で開いている',
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

  // ── ③ もう一度押す ── 別窓が PKC の画面で開く ──
  const [win] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  const winErrors: string[] = [];
  win.on('pageerror', (e) => winErrors.push(e.message));
  const img = win.locator('[data-pkc-field="pdf-page-image"]');
  await expect(img.first(), '頁の絵が出ない(PKC の画面で開いていない / 読めていない)').toBeAttached({
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
      imgs: document.querySelectorAll('img[data-pkc-field="pdf-page-image"]').length,
    };
  });
  expect(held.created, '往復しても 1 枚も焼いていない(観測が空振り)').toBeGreaterThan(held.imgs);
  expect(
    held.created - held.revoked,
    `作った ObjectURL(${String(held.created)})のうち返していない数が、窓の中の絵の数(${String(held.imgs)})を超えている ── 描画中に外れた頁の絵を返し忘れている`,
  ).toBeLessThanOrEqual(held.imgs);

  // 文書内を探す
  await win.fill('#query', 'marker3');
  await win.press('#query', 'Enter');
  await expect(win.locator('#hits')).toContainText('1 / 1 件(3 頁)', { timeout: 15_000 });
  await expect.poll(livePages, { message: '見つけた頁へ移っていない', timeout: 15_000 }).toContain('3');
  await expect(win.locator('.page[data-page="3"] .textLayer span.hit')).toHaveCount(1, { timeout: 15_000 });

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
  await expect(win.locator('#status')).toContainText('の末尾へ引きました(3 頁)', { timeout: 10_000 });
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('の末尾へ引きました(3 頁)');
  // 🔴 本体のノートに、頁番号と添付の名前つきの引用が入っている(結びついたノートが無いので添付自身)
  await expect
    .poll(() => page.locator('[data-pkc-region="detail"]').innerText(), {
      message: '本体のノートに引用が入っていない',
      timeout: 10_000,
    })
    .toContain('marker3 (p.3、見積.pdf)');
  await win.close();

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
    'ブラウザの表示で開きました',
    { timeout: 10_000 },
  );
  await bad.close();

  expect(winErrors, '窓の中で例外が出ている').toEqual([]);
  expect(errors).toEqual([]);
});
