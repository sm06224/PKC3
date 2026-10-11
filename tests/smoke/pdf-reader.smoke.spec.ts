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
 *   ⑤″ ページの編集(#275 段②-1b)── キーボードだけで全部外す(0 ページは保存できない)→ 編集をやめる → 外す・回す・
 *     ドラッグ・Alt+↑↓ → 「別の PDF として保存」で新しい添付が 1 つ増える(元と、読んでいた画面は動かない)→ できた PDF は
 *     順・向き・外したページの字が依頼どおり / 元は 5 ページのまま / パスワード付きは読めて、編集は理由つきで断る
 *   ⑤‴ ページを選んで抜き出す(#275 段②-1c)── 0 件では押せない → Ctrl+クリック / Shift+クリック / Ctrl+Space・Shift+↑↓ / Esc で選ぶ
 *     (選んだページは画面で見分けられる)→ 「選んだページを別の PDF にする」で新しい添付が 1 つ増える(元と、読んでいた画面は動かない)
 *     → できた PDF は選んだ 2 ページだけ・順と向きは一覧のとおり・選ばなかったページの字は無い
 *   ⑤⁗ ハイライト(#275 段②-2b/c)── 字を選ぶまで「ハイライト」と色は押せない → 色(黄・緑・青・ピンク)を選んで付けると、その色で字の上に
 *     乗算で重なる(絵には焼かれない)→ 付けたハイライトも、他のアプリが付けたハイライトも、押すと「ハイライトを外す」が出て外れ
 *     (外すと決めた物は破線で見分けられ、もう一度押すとやめられる)→ 「別の PDF として保存」で新しい添付が増える(元は変わらない)
 *     → できた PDF を開くと、付けた緑が絵に焼かれていて、外した物は無い → 保存した PDF のハイライトも外せる。
 *     上のバーは、窓が狭くて入りきらないとき 2 行になり、「ノートへ引用する」が切れない
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

/**
 * 自作の PDF(`pages` 頁・Helvetica で `Hello page N marker<N>`)。xref の位置は組みながら数える。
 * `opts.box` = 1 頁の大きさ(既定 400x400)/ `opts.outline` = しおりを 1 つ付ける(ページの編集の「引き継がれない物」の観測用)/
 * `opts.highlight` = 1 頁目の字に**他のアプリが付けた形**のハイライト(`/P` つき・外観なし)を 1 つ付ける(#275 段②-2c の「外す」の観測用)。
 */
function buildPdf(pages: number, opts: { box?: [number, number]; outline?: boolean; highlight?: boolean } = {}): Buffer {
  const [bw, bh] = opts.box ?? [400, 400];
  const objs: string[] = [];
  const kids: string[] = [];
  const boldObj = 4 + pages * 2;
  const outlinesObj = boldObj + 1;
  const outlineItemObj = boldObj + 2;
  const annotObj = opts.outline ? boldObj + 3 : boldObj + 1;
  objs[1] = opts.outline
    ? `<< /Type /Catalog /Pages 2 0 R /Outlines ${String(outlinesObj)} 0 R >>`
    : '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objs[boldObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  if (opts.outline) {
    objs[outlinesObj] = `<< /Type /Outlines /First ${String(outlineItemObj)} 0 R /Last ${String(outlineItemObj)} 0 R /Count 1 >>`;
    objs[outlineItemObj] = `<< /Title (Chapter) /Parent ${String(outlinesObj)} 0 R /Dest [4 0 R /Fit] >>`;
  }
  for (let i = 0; i < pages; i += 1) {
    const pageObj = 4 + i * 2;
    kids.push(`${String(pageObj)} 0 R`);
    // 🔑 3 頁目だけ、書体を変えて 2 つの塊(= 文字の層の span 2 つ)に分かれる 1 行を足す:「split」+「match」。
    //    pdf.js は書体が変わるところで文字を別の塊にするので、「litma」の一致は 2 つの span にまたがる
    const split = i === 2 ? ' /F1 24 Tf 0 -100 Td (split) Tj /F2 24 Tf (match) Tj' : '';
    const stream = `BT /F1 24 Tf 40 300 Td (Hello page ${String(i + 1)} marker${String(i + 1)}) Tj${split} ET`;
    const annots = opts.highlight && i === 0 ? ` /Annots [${String(annotObj)} 0 R]` : '';
    objs[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(bw)} ${String(bh)}] /Resources << /Font << /F1 3 0 R /F2 ${String(boldObj)} 0 R >> >> /Contents ${String(pageObj + 1)} 0 R${annots} >>`;
    objs[pageObj + 1] = `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
  }
  if (opts.highlight) {
    // 1 頁目の 1 行目(x=40・基準線 y=300・24pt)を囲む黄色のハイライト。外観(/AP)は持たない ── 読み手(pdf.js)が自分で描く
    objs[annotObj] =
      '<< /Type /Annot /Subtype /Highlight /Rect [40 294 200 324] /QuadPoints [40 324 200 324 40 294 200 294] /C [1 1 0] /F 4 /P 4 0 R /Contents (other-app-highlight) >>';
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

/**
 * パスワードで守られた PDF(2 ページ・空白)。ユーザーのパスワードは空、オーナーのパスワードだけ設定 ──
 * 読む側(pdf.js)は開けるが、ページの編集(pdf-lib)は暗号化として断る形。pypdf で AES-128 に暗号化した 1094 byte。
 * ⚠ 自作(中身は空白のページ 2 枚)。
 */
const ENCRYPTED_PDF_BASE64 =
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDM5MjVlNTJlY2M0YzkxN2ZlYjhlYzk0OGQ4YTliNzNlM2FjMjU1YWRmZmU2MTA5MmY0ZjVjZmFmOTIyZWJjNmE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMgovS2lkcyBbIDQgMCBSIDUgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAzMDAgNDAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovVHlwZSAvUGFnZQovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAuMCAwLjAgMzAwIDQwMCBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL1YgNAovUiA0Ci9MZW5ndGggMTI4Ci9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDkxM2IwNzNmNWI2NTk1NGM4YjZkYTIyMTY5OTcxYTE3N2I3ZTZkOTRhMTA2ZmY3NWMwYzE2Mjk2YmMxNTQxMmU+Ci9VIDw4NTc3NDRkMDc0MmNhNTVhMmRmODc1NzE4Y2ZjM2IzNjI4YmY0ZTVlNGU3NThhNDE2NDAwNGU1NmZmZmEwMTA4PgovQ0YgPDwKL1N0ZENGIDw8Ci9BdXRoRXZlbnQgL0RvY09wZW4KL0NGTSAvQUVTVjIKL0xlbmd0aCAxNgo+Pgo+PgovU3RtRiAvU3RkQ0YKL1N0ckYgL1N0ZENGCj4+CmVuZG9iagp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDExMyAwMDAwMCBuIAowMDAwMDAwMTc4IDAwMDAwIG4gCjAwMDAwMDAyMjcgMDAwMDAgbiAKMDAwMDAwMDMyMSAwMDAwMCBuIAowMDAwMDAwNDE1IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNwovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzkzOTM0NjEzNTMzMzk2MjY1MzQzMTY0NjY2MzMxMzE2NTM3NjUzNzM4NjUzMzMyMzkzNzY0MzYzNzMzNjU2Mz4gPDM5MzkzNDYxMzUzMzM5NjI2NTM0MzE2NDY2NjMzMTMxNjUzNzY1MzczODY1MzMzMjM5Mzc2NDM2MzczMzY1NjM+IF0KL0VuY3J5cHQgNiAwIFIKPj4Kc3RhcnR4cmVmCjcyMgolJUVPRgo=';

test('🔴 PDF を PKC3 の PDF ビューアで読み、字を選んでノートへ引ける(設定で選んだ人だけ)', async ({ page, context }) => {
  // ⑤″(ページの編集)を足して 1 本の物語が 28 秒を超えたので、既定の 30 秒を広げる(待ちを緩めたのではなく、通す道が増えた)
  test.setTimeout(150_000);
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

  // 🔴 ページの編集の対照群: 元にしおり・入力欄・電子署名が 1 つも無い PDF では、引き継がれない物の字を出さない
  await win.locator('.thumb-cell[data-thumb-cell="2"]').scrollIntoViewIfNeeded();
  await clickReal(win, '[data-pkc-field="pdf-page-remove"][data-thumb-page="2"]');
  await expect(win.locator('#edit-note')).toContainText('9 / 10 ページ', { timeout: 15_000 });
  const plainNote = await win.locator('#edit-note').innerText();
  for (const w of ['しおり', '入力欄', '電子署名']) {
    expect(plainNote, `元に ${w} が無いのに「${w}」と言っている`).not.toContain(w);
  }
  await expect(win.locator('#edit-warn'), '引き継がれない物が無いのに、その行が出ている').toBeHidden();
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


  // ── ⑤″ ページの編集(#275 段②-1b)── 並べ替え・回す・外す → 「別の PDF として保存」で新しい添付が増える ──
  //    fixture は自作の 5 ページ(縦長・しおり付き)。⚠ 窓ごとに頁の字(marker<頁>)が違うので、どのページが
  //    どの順で入ったかを字で言える。縦長なので、回すと横長になるのを箱の縦横で見られる。
  const ED_NAME = 'ページ編集.pdf';
  const ED_OUT = 'ページ編集 (編集).pdf';
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: ED_NAME,
    mimeType: 'application/pdf',
    buffer: buildPdf(5, { box: [300, 400], outline: true }),
  });
  const entryNamed = (name: string) =>
    page.locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: name });
  await clickReal(page, entryNamed(ED_NAME));
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', ED_NAME);
  await expect(entryNamed(ED_OUT), '保存の前に編集後の添付がある(観測が空振り)').toHaveCount(0);
  // 🔴 「置いた」の放送を止められる口(保存の最中の状態を保つため)。`__holdEdited` が真の間だけ、窓から本体への
  //    `edited` を手元に留める。⚠ 留めるだけで書き換えない(放す `__releaseEdited` は、留めた物をそのまま送る)
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const orig = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, m: unknown): void {
      if (w['__holdEdited'] === true && (m as Record<string, unknown> | null)?.['pkc3Pdf'] === 'edited') {
        w['__held'] = { chan: this, msg: m };
        return;
      }
      orig.call(this, m);
    };
    w['__releaseEdited'] = (): boolean => {
      const h = w['__held'] as { chan: BroadcastChannel; msg: unknown } | undefined;
      if (h === undefined) return false;
      w['__holdEdited'] = false;
      w['__held'] = undefined;
      orig.call(h.chan, h.msg);
      return true;
    };
  });
  const [ed] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  const edErrors: string[] = [];
  ed.on('pageerror', (e) => edErrors.push(e.message));
  await ed.setViewportSize({ width: 1100, height: 900 });
  await expect(ed.locator('[data-pkc-field="pdf-page-thumb"]')).toHaveCount(5, { timeout: 20_000 });
  await expect(ed.locator('body')).toHaveAttribute('data-pkc-pdf-state', 'ready');
  const edImgs = ed.locator('[data-pkc-field="pdf-page-thumb-image"]');
  await expect.poll(() => edImgs.count(), { message: '一覧の絵が揃わない', timeout: 20_000 }).toBe(5);
  const shown = ed.locator('.thumb-cell:not([hidden])');
  const order = (): Promise<string[]> =>
    ed
      .locator('.thumb-cell:not([hidden]) [data-pkc-field="pdf-page-thumb"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-thumb') ?? ''));
  const labels = (): Promise<string[]> =>
    ed.locator('.thumb-cell:not([hidden]) .thumb-no').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  const holderBox = async (n: number): Promise<{ w: number; h: number }> => {
    const b = await ed.locator(`.thumb-cell[data-thumb-cell="${String(n)}"] .thumb-img`).boundingBox();
    return { w: b?.width ?? 0, h: b?.height ?? 0 };
  };
  const save = ed.locator('#edit-save');
  const note = ed.locator('#edit-note');

  // 何も変えていない間は、保存ボタンも案内の 1 行も出ない(対照群)
  await expect(save, '何も変えていないのに「別の PDF として保存」が出ている').toBeHidden();
  await expect(ed.locator('#edit-bar')).toBeHidden();
  expect(await order()).toEqual(['1', '2', '3', '4', '5']);
  // 🔴 使い方の 1 行が、触れる前から常に出ている(↻ × は触れないと出ない物ではない)
  await expect(ed.locator('#plist-hint')).toBeVisible();
  await expect(ed.locator('#plist-hint')).toHaveText(
    'ドラッグか ↑↓ で並べ替え・↻ で回す・× で外す・Ctrl+クリックで選ぶ',
  );
  // 使い方の欄に字が収まっている(はみ出して切れていない)
  expect(
    await ed.locator('#plist-hint').evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    '使い方の欄から字がはみ出している',
  ).toBe(true);
  const unloadAsks = (): Promise<boolean> =>
    ed.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await unloadAsks(), '何も変えていないのに、閉じるときの確認が出る').toBe(false);
  // ↻ × ↑ ↓ は触れる前から見える(0 でない不透明度)/ 触れるともっとはっきりする
  await ed.mouse.move(700, 600);
  const opacityOf = async (sel: string): Promise<number> =>
    Number(await ed.locator(sel).evaluate((el) => getComputedStyle(el).opacity));
  for (const f of ['pdf-page-rotate', 'pdf-page-remove', 'pdf-page-up', 'pdf-page-down']) {
    const o = await opacityOf(`[data-pkc-field="${f}"][data-thumb-page="1"]`);
    expect(o, `${f} が触れる前は見えない(タッチでは押せない)`).toBeGreaterThan(0.3);
    expect(o).toBeLessThan(1);
  }

  // (a) キーボードだけで全部外す ── 1 つ外すごとに、焦点は同じ位置の次のページへ。全部外したら保存できない
  await ed.focus('[data-pkc-field="pdf-page-thumb"][data-thumb="1"]');
  for (let left = 4; left >= 0; left -= 1) {
    await ed.keyboard.press('Delete');
    await expect.poll(() => shown.count(), { message: 'Delete でページが外れない', timeout: 15_000 }).toBe(left);
    if (left > 0) {
      expect(
        await ed.evaluate(() => document.activeElement?.getAttribute('data-thumb')),
        '外した後の焦点が、残ったページに無い',
      ).not.toBeNull();
    }
  }
  await expect(save, '全部外したのに保存ボタンが消えている').toBeVisible();
  await expect(save, '0 ページの PDF を保存できてしまう').toBeDisabled();
  await expect(note).toContainText('すべてのページを外したので、保存できません');
  // 「変更を元に戻す」で元に戻る(片道にしない)── 一覧も、保存ボタンも元どおり
  await clickReal(ed, '#edit-reset');
  await expect(shown).toHaveCount(5);
  expect(await order()).toEqual(['1', '2', '3', '4', '5']);
  await expect(save).toBeHidden();
  await expect(ed.locator('body')).toHaveAttribute('data-pkc-pdf-edited', 'off');

  // (b) 2 ページ目を外す(×)── 保存ボタンが出て、案内の 1 行は「しおりは引き継がれません」だけを言う
  await clickReal(ed, '[data-pkc-field="pdf-page-remove"][data-thumb-page="2"]');
  await expect(shown).toHaveCount(4);
  expect(await order()).toEqual(['1', '3', '4', '5']);
  expect(await labels(), '位置の番号が詰まっていない').toEqual(['1', '2', '3', '4']);
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(save).toHaveText('別の PDF として保存');
  await expect(note).toContainText('4 / 5 ページ');
  await expect(note).toContainText('元の PDF は変わりません');
  const warn = ed.locator('#edit-warn');
  await expect(warn, '元にしおりがあるのに、引き継がれないと言っていない').toContainText('しおりは引き継がれません');
  // 引き継がれない物は別の行(案内の 1 行には混ぜない)
  expect(await note.innerText(), '案内の 1 行に、引き継がれない物の字が混ざっている').not.toContain('しおり');
  const warnText = await warn.innerText();
  expect(warnText, '元に入力欄が無いのに言っている').not.toContain('入力欄');
  expect(warnText, '元に電子署名が無いのに言っている').not.toContain('電子署名');
  expect(await unloadAsks(), '保存していない変更があるのに、閉じるときの確認が出ない').toBe(true);
  // 🔴 案内が折り返しても、下の面と重ならない(窓を狭めて 2 行 + 折り返しにしても)
  const noOverlap = async (label: string): Promise<void> => {
    const bar = await ed.locator('#edit-bar').boundingBox();
    const sc = await ed.locator('#scroller').boundingBox();
    const pl = await ed.locator('#plist').boundingBox();
    if (bar === null || sc === null || pl === null) throw new Error('位置が取れない');
    expect(sc.y, `${label}: 読む面が案内に重なっている`).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
    expect(pl.y, `${label}: 一覧が案内に重なっている`).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
  };
  await noOverlap('広い窓');
  await ed.setViewportSize({ width: 520, height: 900 });
  await expect
    .poll(async () => (await ed.locator('#edit-bar').boundingBox())?.height ?? 0, { message: '狭めても案内が折り返さない(観測が空振り)' })
    .toBeGreaterThan(40);
  await noOverlap('狭い窓');
  await ed.setViewportSize({ width: 1100, height: 900 });
  // 保存ボタンは画面で見分けられる(属性ではなく、計算後の色が他のボタンと違う)
  expect(await cssOf(save, 'background-color'), '保存ボタンが他のボタンと色で見分けられない').not.toBe(
    await cssOf(ed.locator('#zoom-in'), 'background-color'),
  );

  // (c) 3 ページ目を右へ回す(↻)── 絵が縦長から横長になる。4 ページ目は R キーで 4 回(= 元の向き)
  const before3 = await holderBox(3);
  expect(before3.h, '回す前は縦長のはず(観測が空振り)').toBeGreaterThan(before3.w);
  await clickReal(ed, '[data-pkc-field="pdf-page-rotate"][data-thumb-page="3"]');
  await expect
    .poll(async () => (await holderBox(3)).w - (await holderBox(3)).h, { message: '回したページの絵が横長にならない', timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(
      () => ed.locator('[data-thumb="3"] img').evaluate((el: HTMLImageElement) => el.naturalWidth > el.naturalHeight),
      { message: '回したページの絵が描き直されていない(古い向きのまま)', timeout: 15_000 },
    )
    .toBe(true);
  await ed.focus('[data-pkc-field="pdf-page-thumb"][data-thumb="4"]');
  await ed.keyboard.press('r');
  await expect
    .poll(async () => (await holderBox(4)).w - (await holderBox(4)).h, { message: 'R キーで回らない', timeout: 15_000 })
    .toBeGreaterThan(0);
  for (let i = 0; i < 3; i += 1) await ed.keyboard.press('r');
  await expect
    .poll(async () => (await holderBox(4)).h - (await holderBox(4)).w, { message: '4 回回しても元の向きに戻らない', timeout: 15_000 })
    .toBeGreaterThan(0);

  // (d) 5 ページ目を先頭へドラッグ ── 入る場所に線が出て、離すと並びが替わる
  const drag = async (from: number, to: number): Promise<void> => {
    const a = await ed.locator(`[data-pkc-field="pdf-page-thumb"][data-thumb="${String(from)}"]`).boundingBox();
    const b = await ed.locator(`[data-pkc-field="pdf-page-thumb"][data-thumb="${String(to)}"]`).boundingBox();
    if (a === null || b === null) throw new Error('項目の位置が取れない');
    await ed.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await ed.mouse.down();
    await ed.mouse.move(a.x + a.width / 2, a.y + a.height / 2 - 20, { steps: 3 });
    await ed.mouse.move(b.x + b.width / 2, b.y + 4, { steps: 8 });
    await expect(ed.locator('[data-pkc-drop]'), 'ドラッグ中に入る場所の線が出ない').toHaveCount(1);
    await ed.mouse.up();
  };
  await drag(5, 1);
  await expect.poll(order, { message: 'ドラッグで並びが替わらない', timeout: 10_000 }).toEqual(['5', '1', '3', '4']);
  expect(await labels()).toEqual(['1', '2', '3', '4']);
  await expect(ed.locator('[data-pkc-drop]'), '離した後も線が残っている').toHaveCount(0);
  // 離した直後のクリックは「押した」にならない(読む側が動かない)
  expect(await ed.locator('#pageno').inputValue()).not.toBe('5');

  // (e) キーボードだけでも並べ替えられる ── Alt+↑ / Alt+↓(同じ関数)。焦点は動かしたページに残る
  await ed.focus('[data-pkc-field="pdf-page-thumb"][data-thumb="4"]');
  await ed.keyboard.press('Alt+ArrowUp');
  await expect.poll(order, { message: 'Alt+↑ で並びが替わらない', timeout: 10_000 }).toEqual(['5', '1', '4', '3']);
  expect(await ed.evaluate(() => document.activeElement?.getAttribute('data-thumb')), '動かしたページから焦点が外れた').toBe('4');
  await ed.keyboard.press('Alt+ArrowDown');
  await expect.poll(order, { message: 'Alt+↓ で並びが戻らない', timeout: 10_000 }).toEqual(['5', '1', '3', '4']);
  // ↑ ↓ のボタン(ドラッグできない端末でも並べ替えられる)
  await clickReal(ed, '[data-pkc-field="pdf-page-up"][data-thumb-page="3"]');
  await expect.poll(order, { message: '↑ ボタンで 1 つ上がらない', timeout: 10_000 }).toEqual(['5', '3', '1', '4']);
  await clickReal(ed, '[data-pkc-field="pdf-page-down"][data-thumb-page="3"]');
  await expect.poll(order, { message: '↓ ボタンで 1 つ下がらない', timeout: 10_000 }).toEqual(['5', '1', '3', '4']);

  // (f) 保存 ── 新しい添付が 1 つ増える。元の添付と、いま読んでいる画面は動かない
  const originalDetail = await page.locator('[data-pkc-region="detail"]').innerText();
  await clickReal(ed, '#edit-save');
  await expect(ed.locator('#status'), '保存の結果が窓に出ない').toContainText(
    '保存しました。ノートの画面で「開く」を押すと新しい PDF が開きます',
    { timeout: 20_000 },
  );
  await expect(entryNamed(ED_OUT), '新しい添付が増えていない').toHaveCount(1, { timeout: 10_000 });
  await expect(entryNamed(ED_NAME).filter({ hasNotText: '(編集)' }), '元の添付が消えた').toHaveCount(1);
  await expect(
    page.locator('[data-pkc-action="view-asset"]'),
    '保存で、いま読んでいたノートの画面が新しい添付へ動いた',
  ).toHaveAttribute('data-pkc-asset-name', ED_NAME);
  expect(await page.locator('[data-pkc-region="detail"]').innerText(), '保存で元のノートの表示が変わった').toBe(originalDetail);
  await expect(page.locator('[data-pkc-region="status"]')).toContainText(
    `「${ED_OUT}」を元の PDF と同じフォルダの添付に加えました`,
  );
  // 🔴 保存した並びが新しい基準になる: 保存ボタンは消え、閉じる確認も出ない(押し直して同じ添付を増やさせない)
  await expect(save, '保存した後も保存ボタンが残っている(押し直すと同じ PDF の添付が増える)').toBeHidden();
  await expect(ed.locator('#edit-bar')).toBeHidden();
  expect(await order()).toEqual(['5', '1', '3', '4']);
  expect(await unloadAsks(), '保存した後なのに、閉じるときの確認が出る').toBe(false);
  await expect(entryNamed(ED_OUT)).toHaveCount(1);
  // 保存の後にまた変えれば、また保存でき、確認も出る / 「変更を元に戻す」は保存した並びへ戻る
  await clickReal(ed, '[data-pkc-field="pdf-page-rotate"][data-thumb-page="4"]');
  await expect(save).toBeVisible();
  expect(await unloadAsks()).toBe(true);
  await clickReal(ed, '#edit-reset');
  await expect(save).toBeHidden();
  expect(await order(), '元に戻したら、保存した並びでなく元の並びへ戻っている').toEqual(['5', '1', '3', '4']);
  expect((await holderBox(3)).w, '保存した向き(3 ページ目は横長)まで戻っていない').toBeGreaterThan((await holderBox(3)).h);

  // (f') 選んだページだけを別の PDF にする(#275 段②-1c)── 一覧は 5,1,3,4(3 は回してある)
  const extract = ed.locator('#extract');
  const thumbBtn = (n: number): string => `[data-pkc-field="pdf-page-thumb"][data-thumb="${String(n)}"]`;
  const cell = (n: number) => ed.locator(`.thumb-cell[data-thumb-cell="${String(n)}"]`);
  const withKey = async (key: string, f: () => Promise<void>): Promise<void> => {
    await ed.keyboard.down(key);
    try {
      await f();
    } finally {
      await ed.keyboard.up(key);
    }
  };
  const outlineOf = (n: number): Promise<string> => cssOf(cell(n), 'outline-color');
  const widthOf = (n: number): Promise<string> => cssOf(cell(n), 'outline-width');
  const PICK_OUT = 'ページ編集 (抜き出し).pdf';
  // 0 件では押せない(対照群 ── 何も選んでいない)。案内の行も出ない
  await expect(extract).toHaveText('選んだページを別の PDF にする');
  await expect(extract, '何も選んでいないのに、抜き出すボタンが押せる').toBeDisabled();
  await expect(ed.locator('#edit-bar')).toBeHidden();
  await expect(entryNamed(PICK_OUT), '抜き出す前に添付がある(観測が空振り)').toHaveCount(0);
  // 普通のクリックはこれまでどおり「そのページへ移る」だけで、選びにならない
  await clickReal(ed, thumbBtn(4));
  await expect(extract).toBeDisabled();
  // Ctrl+クリックで 5 を選ぶ ── 見た目が変わる(計算後の枠の太さ。選んでいないページは 0)
  expect(await widthOf(5), '選ぶ前なのに枠が付いている(観測が空振り)').toBe('0px');
  await withKey('Control', () => clickReal(ed, thumbBtn(5)));
  await expect(cell(5)).toHaveAttribute('data-pkc-selected', 'true');
  expect(await widthOf(5), '選んだページが画面で見分けられない(枠が無い)').toBe('2px');
  expect(await outlineOf(5), '選んだ枠の色が、いまの頁の青い枠と同じ').not.toBe(await cssOf(ed.locator(thumbBtn(4)), 'border-top-color'));
  await expect(extract).toBeEnabled();
  await expect(ed.locator('#edit-note')).toContainText('1 ページを選んでいます');
  await expect(ed.locator('#edit-warn'), '元にしおりがあるのに、選んだときに引き継がれないと言っていない').toContainText('しおりは引き継がれません');
  // Shift+クリックで範囲(5 から 3 = 見えている順で 5,1,3)── ページ番号の大小ではなく並びで数える
  await withKey('Shift', () => clickReal(ed, thumbBtn(3)));
  for (const n of [5, 1, 3]) await expect(cell(n), `${String(n)} が範囲に入っていない`).toHaveAttribute('data-pkc-selected', 'true');
  await expect(cell(4), '範囲の外まで選んでいる').not.toHaveAttribute('data-pkc-selected', 'true');
  await expect(ed.locator('#edit-note')).toContainText('3 ページを選んでいます');
  // Ctrl+クリックでもう一度押すと外れる(片道にしない)→ 5 と 3 が残る
  await withKey('Control', () => clickReal(ed, thumbBtn(1)));
  await expect(cell(1)).not.toHaveAttribute('data-pkc-selected', 'true');
  await expect(ed.locator('#edit-note')).toContainText('2 ページを選んでいます');
  // 選んだだけでは「保存していない変更」にならない(保存ボタンは出ず、閉じる確認も出ない)
  await expect(save).toBeHidden();
  expect(await unloadAsks(), '選んだだけなのに、閉じるときの確認が出る').toBe(false);
  // Esc で選びが全部外れ、押せなくなる / キーボードだけでも選べる(Ctrl+Space・Shift+↓)
  await ed.focus(thumbBtn(5));
  await ed.keyboard.press('Escape');
  await expect(extract).toBeDisabled();
  await expect(ed.locator('[data-pkc-selected="true"]')).toHaveCount(0);
  await ed.keyboard.press('Control+Space');
  await expect(cell(5), 'Ctrl+Space で選べない').toHaveAttribute('data-pkc-selected', 'true');
  await ed.keyboard.press('Shift+ArrowDown');
  await ed.keyboard.press('Shift+ArrowDown');
  for (const n of [5, 1, 3]) await expect(cell(n), `Shift+↓ で ${String(n)} まで広がらない`).toHaveAttribute('data-pkc-selected', 'true');
  await ed.keyboard.press('Shift+ArrowUp');
  await expect(cell(3), 'Shift+↑ で範囲が縮まない').not.toHaveAttribute('data-pkc-selected', 'true');
  await expect(cell(1)).toHaveAttribute('data-pkc-selected', 'true');
  // 5 と 3 を選び直して(1 を外す)抜き出す
  await withKey('Control', () => clickReal(ed, thumbBtn(3)));
  await withKey('Control', () => clickReal(ed, thumbBtn(1)));
  await expect(ed.locator('[data-pkc-selected="true"]')).toHaveCount(2);
  // 🔴 作っている間(本体の返事を待つ間)は、選びを動かせない: 「置いた」を手元に留めて、その間に触ってみる
  await ed.evaluate(() => ((window as unknown as Record<string, unknown>)['__holdEdited'] = true));
  await clickReal(ed, '#extract');
  await expect
    .poll(() => ed.evaluate(() => (window as unknown as Record<string, unknown>)['__held'] !== undefined), { message: '保存の最中の状態を作れない(観測が空振り)', timeout: 20_000 })
    .toBe(true);
  await expect(ed.locator('#status')).toContainText('保存しています');
  await withKey('Control', () => clickReal(ed, thumbBtn(4)));
  await ed.focus(thumbBtn(5));
  await ed.keyboard.press('Control+a');
  await ed.keyboard.press('Escape');
  await expect(ed.locator('[data-pkc-selected="true"]'), '作っている間に選びが動いた').toHaveCount(2);
  await expect(cell(4)).not.toHaveAttribute('data-pkc-selected', 'true');
  await expect(ed.locator('#edit-unpick'), '作っている間に「選びを外す」が押せる').toBeDisabled();
  expect(await ed.evaluate(() => (window as unknown as { __releaseEdited: () => boolean }).__releaseEdited())).toBe(true);
  await expect(ed.locator('#status'), '抜き出しの結果が窓に出ない').toContainText('選んだページを新しい PDF にしました', { timeout: 20_000 });
  await expect(entryNamed(PICK_OUT), '新しい添付が増えていない').toHaveCount(1, { timeout: 10_000 });
  await expect(entryNamed(ED_NAME).filter({ hasNotText: '(編集)' }).filter({ hasNotText: '(抜き出し)' }), '元の添付が消えた').toHaveCount(1);
  await expect(page.locator('[data-pkc-action="view-asset"]'), '抜き出しで読んでいた画面が動いた').toHaveAttribute('data-pkc-asset-name', ED_NAME);
  // 抜き出せたら選びは外れ、押し直して同じ添付を増やせない。並びは動かない(抜き出しは「保存した」ことにならない)
  await expect(extract).toBeDisabled();
  await expect(ed.locator('[data-pkc-selected="true"]')).toHaveCount(0);
  expect(await order()).toEqual(['5', '1', '3', '4']);
  await expect(entryNamed(PICK_OUT)).toHaveCount(1);
  // 外したページは選びから落ちる: 4 を選んでから × で外すと、抜き出せなくなる
  await withKey('Control', () => clickReal(ed, thumbBtn(4)));
  await expect(extract).toBeEnabled();
  await clickReal(ed, '[data-pkc-field="pdf-page-remove"][data-thumb-page="4"]');
  await expect(extract, '外したページが選びに残っている').toBeDisabled();
  await clickReal(ed, '#edit-reset');
  await ed.close();

  // (g) できた PDF を開く ── 4 ページ。順は 5,1,3,4 / 3 番目だけ横長 / 外した 2 ページ目の字はどこにも無い
  await clickReal(page, entryNamed(ED_OUT));
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', ED_OUT);
  const [out] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await expect(out.locator('#pagecount')).toHaveText('/ 4', { timeout: 20_000 });
  const textOf = (n: number) => out.locator(`.page[data-page="${String(n)}"] .textLayer`);
  await expect(textOf(1)).toContainText('marker5', { timeout: 20_000 });
  for (const [n, m] of [[2, 'marker1'], [3, 'marker3'], [4, 'marker4']] as const) {
    await out.locator(`.page[data-page="${String(n)}"]`).scrollIntoViewIfNeeded();
    await expect(textOf(n), `${String(n)} ページ目に ${m} が入っていない`).toContainText(m, { timeout: 20_000 });
  }
  const dims = async (n: number): Promise<{ w: number; h: number }> => {
    const b = await out.locator(`.page[data-page="${String(n)}"]`).boundingBox();
    return { w: b?.width ?? 0, h: b?.height ?? 0 };
  };
  const d3 = await dims(3);
  expect(d3.w, '回したページ(できた PDF の 3 ページ目)が横長でない').toBeGreaterThan(d3.h);
  for (const n of [1, 2, 4]) {
    const d = await dims(n);
    expect(d.h, `${String(n)} ページ目まで回っている`).toBeGreaterThan(d.w);
  }
  await out.fill('#query', 'marker2');
  await out.press('#query', 'Enter');
  await expect(out.locator('#hits'), '外したはずの 2 ページ目の字が、できた PDF に残っている').toContainText('見つかりません', {
    timeout: 15_000,
  });
  await out.close();
  // 抜き出した PDF(5 と 3 の 2 ページ)── 順・向き・選ばなかったページの字が無い
  await clickReal(page, entryNamed(PICK_OUT));
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', PICK_OUT);
  const [ex] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await expect(ex.locator('#pagecount'), '抜き出した PDF が 2 ページでない').toHaveText('/ 2', { timeout: 20_000 });
  await expect(ex.locator('.page[data-page="1"] .textLayer')).toContainText('marker5', { timeout: 20_000 });
  await ex.locator('.page[data-page="2"]').scrollIntoViewIfNeeded();
  await expect(ex.locator('.page[data-page="2"] .textLayer')).toContainText('marker3', { timeout: 20_000 });
  const exBox = async (n: number): Promise<{ w: number; h: number }> => {
    const b = await ex.locator(`.page[data-page="${String(n)}"]`).boundingBox();
    return { w: b?.width ?? 0, h: b?.height ?? 0 };
  };
  expect((await exBox(2)).w, '抜き出した PDF の 3 ページ目(回してあった)が横長でない').toBeGreaterThan((await exBox(2)).h);
  expect((await exBox(1)).h, '回していないページまで回っている').toBeGreaterThan((await exBox(1)).w);
  for (const m of ['marker1', 'marker2', 'marker4']) {
    await ex.fill('#query', m);
    await ex.press('#query', 'Enter');
    await expect(ex.locator('#hits'), `選ばなかったページの字 ${m} が、抜き出した PDF に残っている`).toContainText('見つかりません', { timeout: 15_000 });
  }
  await ex.close();
  // 元は変わっていない: 5 ページのまま、外したページの字も残っている

  await clickReal(page, entryNamed(ED_NAME).filter({ hasNotText: '(編集)' }));
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', ED_NAME);
  const [orig] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await expect(orig.locator('#pagecount')).toHaveText('/ 5', { timeout: 20_000 });
  await orig.fill('#query', 'marker2');
  await orig.press('#query', 'Enter');
  await expect(orig.locator('#hits'), '元の PDF から 2 ページ目の字が消えている(元を書き換えた)').toContainText('1 / 1 件(2 ページ)', {
    timeout: 15_000,
  });
  await orig.close();

  // (h) パスワードで守られた PDF ── 読める。編集は断る(理由を言い、保存ボタンは出ない)
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'パスワード付き.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'),
  });
  await clickReal(page, entryNamed('パスワード付き.pdf'));
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', 'パスワード付き.pdf');
  const [enc] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await expect(enc.locator('#pagecount'), 'パスワード付きの PDF が読めない(観測が空振り)').toHaveText('/ 2', { timeout: 20_000 });
  expect(await enc.locator('[data-pkc-field="pdf-reader-fallback"]').count()).toBe(0);
  await clickReal(enc, '[data-pkc-field="pdf-page-rotate"][data-thumb-page="1"]');
  await expect(enc.locator('#status')).toContainText('パスワードで守られた PDF は、ページを編集できません', { timeout: 15_000 });
  await expect(enc.locator('#edit-save'), '編集できない PDF に保存ボタンが出ている').toBeHidden();
  await expect(enc.locator('body')).toHaveAttribute('data-pkc-pdf-edited', 'off');
  // 読む側は今までどおり: 2 ページ目へ移れる
  await clickReal(enc, '[data-pkc-field="pdf-page-thumb"][data-thumb="2"]');
  await expect(enc.locator('#pageno')).toHaveValue('2', { timeout: 10_000 });
  await enc.close();
  expect(edErrors, '編集の窓で例外が出た').toEqual([]);

  // ── ⑤⁗ ハイライト(#275 段②-2b/c)── 字を選んで色を付ける → 付いたハイライトを押して外す → 保存 → 開き直すと反映されている ──
  //    fixture は自作の 3 ページ。1 頁目の 1 行目に**他のアプリが付けた形**のハイライト(`/P` つき)が 1 つ付いている。
  const HL_NAME = 'ハイライト.pdf';
  const HL_OUT = 'ハイライト (編集).pdf';
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: HL_NAME,
    mimeType: 'application/pdf',
    buffer: buildPdf(3, { highlight: true }),
  });
  await clickReal(page, entryNamed(HL_NAME));
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', HL_NAME);
  await expect(entryNamed(HL_OUT), '保存の前に編集後の添付がある(観測が空振り)').toHaveCount(0);
  const openHl = async (): Promise<typeof win> => {
    const [w] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      clickReal(page, '[data-pkc-action="view-asset"]'),
    ]);
    await w.setViewportSize({ width: 1100, height: 900 });
    await expect(w.locator('body')).toHaveAttribute('data-pkc-pdf-state', 'ready', { timeout: 20_000 });
    return w;
  };
  const hw = await openHl();
  const hwErrors: string[] = [];
  hw.on('pageerror', (e) => hwErrors.push(e.message));
  const pageLayer = (w: typeof hw, n: number) => w.locator(`.page[data-page="${String(n)}"] [data-pkc-field="pdf-highlight-layer"]`);
  const existingOn = (w: typeof hw, n: number) =>
    w.locator(`.page[data-page="${String(n)}"] [data-pkc-field="pdf-highlight-existing"]`);
  const newOn = (w: typeof hw, n: number) => w.locator(`.page[data-page="${String(n)}"] [data-pkc-field="pdf-highlight-new"]`);
  for (const n of [1, 2, 3]) await expect(pageLayer(hw, n), `${String(n)} ページ目にハイライトの層が出ない`).toBeAttached({ timeout: 20_000 });
  // 他のアプリが付けたハイライトは、押せる印として重なっている(1 頁目だけ)/ 何も選んでいない間は、ボタンは押せない
  await expect(existingOn(hw, 1), '元のハイライトが読まれていない').toHaveCount(1);
  await expect(existingOn(hw, 2)).toHaveCount(0);
  const hlBtn = hw.locator('#hl-apply');
  const swatch = (id: string) => hw.locator(`#bar button.swatch[data-hl-color="${id}"]`);
  await expect(hlBtn).toHaveText('ハイライト');
  await expect(hlBtn, '何も選んでいないのにハイライトが押せる').toBeDisabled();
  for (const id of ['yellow', 'green', 'blue', 'pink']) await expect(swatch(id)).toBeDisabled();
  await expect(hw.locator('#edit-save')).toBeHidden();
  // 帯に収まらないときは 2 行に折り返し、右端の「ノートへ引用する」も「ハイライト」も窓の外へ切れず、読む面に重ならない
  //   (既定の窓の幅 1000 でも、広い窓 1400 でも。1400 では 1 行のまま ── 折り返しは要るときだけ)
  const barGeometry = async (): Promise<{ right: number; barBottom: number; scrollerTop: number; barH: number; width: number }> =>
    hw.evaluate(() => {
      const r = (id: string): DOMRect => (document.getElementById(id) as HTMLElement).getBoundingClientRect();
      return {
        right: Math.max(r('quote').right, r('hl-apply').right),
        barBottom: r('bar').bottom,
        scrollerTop: r('scroller').top,
        barH: r('bar').height,
        width: window.innerWidth,
      };
    });
  for (const [w, wraps] of [
    [1000, true],
    [1100, true],
    [1500, false],
  ] as const) {
    await hw.setViewportSize({ width: w, height: 900 });
    await expect
      .poll(async () => (await barGeometry()).right <= w, { message: `幅 ${String(w)} で「ノートへ引用する」が窓の外へ切れている` })
      .toBe(true);
    const g = await barGeometry();
    expect(g.scrollerTop, `幅 ${String(w)} で、帯が読む面に重なっている`).toBeGreaterThanOrEqual(g.barBottom - 1);
    expect(g.barH > 45, `幅 ${String(w)}: 折り返しの有無が想定と違う(帯の高さ ${String(g.barH)})`).toBe(wraps);
  }
  await hw.setViewportSize({ width: 1100, height: 900 });
  // 幅を変えると、窓は 200ms 後に幅合わせで頁を描き直す ── 字の層が作り直される前に選ぶと選びが消えるので、描き直しを待つ
  await hw.waitForTimeout(600);
  for (const n of [1, 2, 3]) await expect(hw.locator(`.page[data-page="${String(n)}"] .textLayer span`).first()).toBeAttached({ timeout: 15_000 });
  // 色のボタン: 4 色が窓の色の表どおりに見え、押された色(既定は黄)は枠の色で見分けられる
  const cssOfHw = (loc: ReturnType<typeof swatch>, prop: string): Promise<string> =>
    loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  expect(await cssOfHw(swatch('yellow'), 'background-color')).toBe('rgb(255, 235, 51)');
  expect(await cssOfHw(swatch('green'), 'background-color')).toBe('rgb(115, 230, 115)');
  expect(await cssOfHw(swatch('blue'), 'background-color')).toBe('rgb(128, 199, 255)');
  expect(await cssOfHw(swatch('pink'), 'background-color')).toBe('rgb(255, 140, 199)');
  await expect(swatch('yellow')).toHaveAttribute('aria-pressed', 'true');
  expect(await cssOfHw(swatch('yellow'), 'border-top-color'), '押された色が、押されていない色と見分けられない').not.toBe(
    await cssOfHw(swatch('green'), 'border-top-color'),
  );

  /** `n` ページ目の 1 つ目の字の塊を選ぶ(選びの複製を残す ── ボタンを押す間に選びが消えても読める)。 */
  const selectFirstSpan = async (n: number): Promise<void> => {
    await hw.locator(`.page[data-page="${String(n)}"] .textLayer span`).first().waitFor({ state: 'attached', timeout: 15_000 });
    await hw.evaluate((k) => {
      const el = document.querySelector(`.page[data-page="${String(k)}"] .textLayer span`);
      if (el === null) throw new Error('字の層が無い');
      const sel = window.getSelection();
      sel?.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(el);
      sel?.addRange(r);
    }, n);
  };
  const pixelAt = (w: typeof hw, n: number, from: 'existing' | 'new'): Promise<number[]> =>
    w.evaluate(
      async ([k, kind]) => {
        const box = document.querySelector(`.page[data-page="${String(k)}"]`);
        const img = box?.querySelector('img');
        const mark = box?.querySelector(`[data-pkc-field="pdf-highlight-${String(kind)}"]`);
        if (!box || !img || !mark) throw new Error('絵かハイライトの印が無い');
        const bb = box.getBoundingClientRect();
        const mb = mark.getBoundingClientRect();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        if (ctx === null) throw new Error('canvas が無い');
        ctx.drawImage(img, 0, 0);
        const ratio = img.naturalWidth / bb.width;
        // ハイライトの左端のすぐ内側・真ん中の高さ(字の左の余白 ── 字の黒に当たらない)
        const x = Math.round((mb.left - bb.left + 1.5) * ratio);
        const y = Math.round((mb.top - bb.top + mb.height / 2) * ratio);
        return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      },
      [n, from] as const,
    );

  // (a) 2 頁目の字を選ぶ → 緑を選ぶ → ハイライト ── 選びの上に緑が付き、案内の行と保存ボタンが出る
  await selectFirstSpan(2);
  await expect(hlBtn, '字を選んでもハイライトが押せない').toBeEnabled();
  await expect(hw.locator('#quote'), '同じ選びから引用もできる').toBeEnabled();
  for (const id of ['yellow', 'green', 'blue', 'pink']) await expect(swatch(id)).toBeEnabled();
  await clickReal(hw, '#bar button.swatch[data-hl-color="green"]');
  await expect(swatch('green')).toHaveAttribute('aria-pressed', 'true');
  await expect(swatch('yellow')).toHaveAttribute('aria-pressed', 'false');
  await expect(newOn(hw, 2), '付ける前から付いている(観測が空振り)').toHaveCount(0);
  await clickReal(hw, '#hl-apply');
  await expect(newOn(hw, 2), '字を選んで押したのに、ハイライトが付かない').not.toHaveCount(0);
  expect(await newOn(hw, 2).first().evaluate((el) => getComputedStyle(el).backgroundColor), '選んだ色(緑)で付いていない').toBe(
    'rgb(115, 230, 115)',
  );
  expect(await newOn(hw, 2).first().evaluate((el) => getComputedStyle(el).mixBlendMode), '字を隠す(乗算でない)').toBe('multiply');
  // 付いた位置は選んだ字の上(字の層の span と重なる)
  const spanBox = await hw.locator('.page[data-page="2"] .textLayer span').first().boundingBox();
  const markBox = await newOn(hw, 2).first().boundingBox();
  expect(markBox !== null && spanBox !== null && markBox.x < spanBox.x + spanBox.width && markBox.x + markBox.width > spanBox.x).toBe(true);
  expect(Math.abs((markBox?.y ?? 0) + (markBox?.height ?? 0) / 2 - ((spanBox?.y ?? 0) + (spanBox?.height ?? 0) / 2))).toBeLessThan(
    spanBox?.height ?? 0,
  );
  await expect(hw.locator('#edit-note')).toContainText('ハイライトを 1 件付けています');
  await expect(hw.locator('#edit-save'), '付けたのに保存ボタンが出ない').toBeVisible();
  await expect(hw.locator('#edit-save')).toBeEnabled();
  // 絵に焼かれていない(保存の前は、窓が重ねて見せるだけ ── 絵の同じ場所はまだ白い。対照: 元のハイライトは黄色く焼かれている)
  expect(await pixelAt(hw, 2, 'new'), '保存の前なのに、絵の側が緑になっている').toEqual([255, 255, 255]);
  const origPx = await pixelAt(hw, 1, 'existing');
  expect(origPx[0]! > 200 && origPx[1]! > 200 && origPx[2]! < 140, `元のハイライトが黄色く描かれていない(${origPx.join(',')})`).toBe(true);
  // 同じ範囲にもう一度付けても重ならない(色の取り替え): 青にして押し直す → 1 件のまま、色だけ青
  await clickReal(hw, '#bar button.swatch[data-hl-color="blue"]');
  await clickReal(hw, '#hl-apply');
  await expect(hw.locator('#edit-note')).toContainText('ハイライトを 1 件付けています');
  expect(await newOn(hw, 2).first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(128, 199, 255)');
  // 緑へ戻す(この後の保存で緑を確かめる)
  await clickReal(hw, '#bar button.swatch[data-hl-color="green"]');
  await clickReal(hw, '#hl-apply');
  expect(await newOn(hw, 2).first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(115, 230, 115)');

  // (b) 3 頁目にピンクで付け、押して「ハイライトを外す」── 付けた分は外れて、案内の数が戻る(色は窓の間覚えている)
  await hw.locator('.page[data-page="3"]').scrollIntoViewIfNeeded();
  await selectFirstSpan(3);
  await clickReal(hw, '#bar button.swatch[data-hl-color="pink"]');
  await clickReal(hw, '#hl-apply');
  await expect(hw.locator('#edit-note')).toContainText('ハイライトを 2 件付けています');
  await expect(newOn(hw, 3)).not.toHaveCount(0);
  await expect(hw.locator('#hl-pop'), '押す前から「外す」が出ている').toBeHidden();
  const clickCenter = async (w: typeof hw, loc: ReturnType<typeof existingOn>): Promise<void> => {
    const b = await loc.first().boundingBox();
    if (b === null) throw new Error('印の位置が取れない');
    await w.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  await clickCenter(hw, newOn(hw, 3));
  await expect(hw.locator('#hl-pop'), '付いたハイライトを押しても「外す」が出ない').toBeVisible();
  await expect(hw.locator('#hl-remove')).toHaveText('ハイライトを外す');
  await clickReal(hw, '#hl-remove');
  await expect(newOn(hw, 3), '外したのに残っている').toHaveCount(0);
  await expect(hw.locator('#hl-pop')).toBeHidden();
  await expect(hw.locator('#edit-note')).toContainText('ハイライトを 1 件付けています');
  await expect(newOn(hw, 2), '外していない 2 頁目のハイライトまで消えた').not.toHaveCount(0);

  // (c) 他のアプリが付けたハイライトを押す → 外す(破線で見分けられる)→ もう一度押してやめる(片道にしない)→ また外す
  await hw.locator('.page[data-page="1"]').scrollIntoViewIfNeeded();
  await clickCenter(hw, existingOn(hw, 1));
  await expect(hw.locator('#hl-remove')).toHaveText('ハイライトを外す');
  await expect(existingOn(hw, 1).first()).not.toHaveAttribute('data-pkc-removed', 'true');
  expect(await existingOn(hw, 1).first().evaluate((el) => getComputedStyle(el).outlineStyle), '外す前から破線が付いている').toBe('none');
  await clickReal(hw, '#hl-remove');
  await expect(existingOn(hw, 1).first()).toHaveAttribute('data-pkc-removed', 'true');
  expect(await existingOn(hw, 1).first().evaluate((el) => getComputedStyle(el).outlineStyle), '外すと決めたハイライトが見分けられない(破線が無い)').toBe('dashed');
  await expect(hw.locator('#edit-note')).toContainText('ハイライトを 1 件付け、1 件外しています');
  await clickCenter(hw, existingOn(hw, 1));
  await expect(hw.locator('#hl-remove')).toHaveText('ハイライトを外すのをやめる');
  await clickReal(hw, '#hl-remove');
  await expect(existingOn(hw, 1).first()).not.toHaveAttribute('data-pkc-removed', 'true');
  await expect(hw.locator('#edit-note')).toContainText('ハイライトを 1 件付けています');
  await expect(hw.locator('#edit-note')).not.toContainText('外しています');
  await clickCenter(hw, existingOn(hw, 1));
  await clickReal(hw, '#hl-remove');
  await expect(existingOn(hw, 1).first()).toHaveAttribute('data-pkc-removed', 'true');
  // 外すを出したあと、Esc で消える
  await clickCenter(hw, existingOn(hw, 1));
  await expect(hw.locator('#hl-pop')).toBeVisible();
  await hw.keyboard.press('Escape');
  await expect(hw.locator('#hl-pop')).toBeHidden();

  // (d) 保存 ── 新しい添付が 1 つ増える。元の添付は残り、読んでいた画面は動かない / 保存した後は保存ボタンが消える
  const hlDetail = await page.locator('[data-pkc-region="detail"]').innerText();
  const unloadAsksHw = (w: typeof hw): Promise<boolean> =>
    w.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await unloadAsksHw(hw), '保存していないハイライトがあるのに、閉じるときの確認が出ない').toBe(true);
  await clickReal(hw, '#edit-save');
  await expect(hw.locator('#status'), '保存の結果が窓に出ない').toContainText('保存しました', { timeout: 20_000 });
  await expect(entryNamed(HL_OUT), '新しい添付が増えていない').toHaveCount(1, { timeout: 10_000 });
  await expect(entryNamed(HL_NAME).filter({ hasNotText: '(編集)' }), '元の添付が消えた').toHaveCount(1);
  await expect(page.locator('[data-pkc-action="view-asset"]'), '保存で、読んでいたノートの画面が動いた').toHaveAttribute('data-pkc-asset-name', HL_NAME);
  expect(await page.locator('[data-pkc-region="detail"]').innerText()).toBe(hlDetail);
  await expect(hw.locator('#edit-save'), '保存した後も保存ボタンが残っている').toBeHidden();
  expect(await unloadAsksHw(hw), '保存した後なのに、閉じるときの確認が出る').toBe(false);
  // 保存した後も、窓には付けたハイライトが見え続ける(窓の絵には焼かれていないので、重ねたまま)
  await expect(newOn(hw, 2)).not.toHaveCount(0);
  expect(hwErrors, 'ハイライトの窓で例外が出た').toEqual([]);
  await hw.close();
  // 元の PDF は変わっていない: 開き直しても、1 頁目の元のハイライトはそのまま・2 頁目には何も付いていない
  const again = await openHl();
  await expect(pageLayer(again, 2)).toBeAttached({ timeout: 20_000 });
  await expect(existingOn(again, 1), '元の PDF から他のアプリのハイライトが消えている(元を書き換えた)').toHaveCount(1);
  await expect(existingOn(again, 2), '元の PDF に 2 頁目のハイライトが付いている(元を書き換えた)').toHaveCount(0);
  await again.close();

  // (e) できた PDF を開く ── 2 頁目の緑のハイライトが PDF の中に在り(絵にも焼かれて緑に見える)、
  //     3 頁目のピンク(外した)は無く、1 頁目の元のハイライト(外した)も無い
  await clickReal(page, entryNamed(HL_OUT));
  await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', HL_OUT);
  const saved = await openHl();
  for (const n of [1, 2, 3]) await expect(pageLayer(saved, n)).toBeAttached({ timeout: 20_000 });
  await expect(existingOn(saved, 2), '保存した PDF に、付けたハイライトが入っていない').not.toHaveCount(0);
  await expect(existingOn(saved, 3), '外したはずのピンクが保存した PDF に在る').toHaveCount(0);
  await expect(existingOn(saved, 1), '外したはずの他のアプリのハイライトが保存した PDF に在る').toHaveCount(0);
  await expect(saved.locator('#edit-save'), '開いただけなのに保存ボタンが出ている').toBeHidden();
  await expect
    .poll(() => saved.locator('.page[data-page="2"] img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
      message: '2 頁目の絵が読み込まれていない',
      timeout: 15_000,
    })
    .toBe(true);
  const greenPx = await pixelAt(saved, 2, 'existing');
  expect(
    greenPx[1]! > greenPx[0]! + 60 && greenPx[1]! > greenPx[2]! + 60,
    `保存した PDF の 2 頁目が緑に描かれていない(${greenPx.join(',')})`,
  ).toBe(true);

  // (f) 保存した PDF のハイライトも外せる(2 頁目の緑を押す → 外す → 保存)── 名前は元と同じ「(編集)」のまま、もう 1 つ増える
  await saved.locator('.page[data-page="2"]').scrollIntoViewIfNeeded();
  await clickCenter(saved, existingOn(saved, 2));
  await expect(saved.locator('#hl-remove')).toHaveText('ハイライトを外す');
  await clickReal(saved, '#hl-remove');
  await expect(saved.locator('#edit-note')).toContainText('ハイライトを 1 件外しています');
  await clickReal(saved, '#edit-save');
  await expect(saved.locator('#status')).toContainText('保存しました', { timeout: 20_000 });
  await expect(entryNamed(HL_OUT), '外して保存した PDF が増えていない').toHaveCount(2, { timeout: 10_000 });
  await saved.close();
  // 2 つのうち、片方は 2 頁目にハイライトが 1 つ(最初の保存)、もう片方は 0(外して保存)── 順には依らない
  const counts: number[] = [];
  for (const i of [0, 1]) {
    await clickReal(page, entryNamed(HL_OUT).nth(i));
    await expect(page.locator('[data-pkc-action="view-asset"]')).toHaveAttribute('data-pkc-asset-name', HL_OUT);
    const w = await openHl();
    await expect(pageLayer(w, 2)).toBeAttached({ timeout: 20_000 });
    counts.push(await existingOn(w, 2).count());
    await w.close();
  }
  expect(counts.map((c) => (c > 0 ? 1 : 0)).sort(), '外して保存した PDF から 2 頁目のハイライトが消えていない').toEqual([0, 1]);

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
