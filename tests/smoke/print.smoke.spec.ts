/**
 * 印刷(2026-08-07)。
 *
 * 🔴 **直す前は画面から印刷すると 1 頁しか出なかった**(実測)。本文の器が
 * `overflow: auto` の唯一のスクロール箱で、650px の窓に 6271px の中身が入っていた
 * ── 紙に出るのは窓の分だけで、**残り約 90% が黙って落ちていた**。
 * `+++`(改頁)もどの面でも改頁を起こしていなかった。
 *
 * ⚠ **独立した spec にする** ── ここは `emulateMedia` と viewport を触るので、
 *   ほかの spec の assert を汚す。
 *
 * ## 観測点の作り方(3 つの罠を避ける)
 *
 * 🔴 **罠①: `break-after` だけを見ると緑のまま壊れる。** `display: none` を併せると
 *    **改頁は消える**のに、計算後の `break-after` は `'page'` のまま残る(実測)。
 *    だから **`getClientRects().length > 0`(箱が在る)と対にする**。
 * ⚠ **罠②: 印刷時の版面幅は紙の幅**(A4 縦 = 794px)。だから既存の
 *    `max-width: 1100px` / `900px` の上書きが**発火する** ── 紙の見え方を測るには
 *    この幅にしなければならない。⚠ ただし 2026-08-07 時点の狭幅ブロックは
 *    `display` / `overflow` を設定していないので、`@media print` を手前へ移す変異は
 *    **今日は等価**で殺せない(app.css の同名の節に理由を書いた)。
 * 🔴 **罠③: `emulateMedia({media:'print'})` だけでは viewport 幅が変わらない**。
 *    紙で効く規則を観測するには `setViewportSize(794×1123)` が要る。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gotoApp,
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  useSplitEditor,
  gotoCollectionPane,
} from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/** A4 縦(96dpi 換算)。⚠ 罠② の狭幅上書きがここで発火する。 */
const A4 = { width: 794, height: 1123 };

test('🔴 画面から印刷すると全文が紙に乗り、+++ で改頁する', async ({ page }) => {
  /**
   * 🔴 **例外を 1 度も見ていなかった**(#713、2026-09-05)。
   * ⚠ 印刷は **blob の寿命**を触る経路である ── CLAUDE.md §5 に
   *   「`afterprint` の revoke が読み込み中の blob URL を消し、紙から画像が落ちた」
   *   と記録が在るのに、この spec は `pageerror` も `console.error` も拾って
   *   いなかった(= **同じ事故がもう一度起きても紙の中身が合えば緑**)。
   */
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  // 3 種の区切りを 1 つずつ + 紙 2 枚を超える長さ
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `## 見出し ${i}\n\n本文の行 ${i}`).join('\n\n');
  await ta.fill(
    `${filler(40)}\n\n+++\n\n${filler(40)}\n\n:::break{kind=page}\n\n中\n\n---\n\n最後\n`,
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const body = page.locator('[data-pkc-field="detail-body"]');
  await expect(body).toBeVisible();

  /**
   * ⚠ **空振り防止を先に置く** ── 改頁のマーカーと素の罫線が実際に出ていること。
   * 0 件なら、以下の assert は何も見ていない。
   */
  const counts = await page.evaluate(() => {
    const host = document.querySelector('[data-pkc-field="detail-body"]')!;
    const all = [...host.querySelectorAll('hr')];
    return {
      breaks: all.filter((h) => h.classList.contains('pkc-section-break')).length,
      plain: all.filter((h) => !h.classList.contains('pkc-section-break')).length,
      scrollH: host.scrollHeight,
    };
  });
  expect(counts.breaks, '改頁のマーカーが出ていない(何も測っていない)').toBeGreaterThanOrEqual(2);
  expect(counts.plain, '素の罫線(kind=rule)が出ていない').toBeGreaterThanOrEqual(1);
  expect(counts.scrollH, '本文が紙 1 枚に収まる短さ(切れても気づけない)').toBeGreaterThan(2000);

  // 罠③: 紙の幅にする。罠②: この幅で狭幅の上書きが発火する
  await page.setViewportSize(A4);
  await page.emulateMedia({ media: 'print' });

  const printed = await page.evaluate(() => {
    const cs = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? getComputedStyle(el) : null;
    };
    const host = document.querySelector('[data-pkc-field="detail-body"]')!;
    const hrs = [...host.querySelectorAll('hr')].map((h) => ({
      isBreak: h.classList.contains('pkc-section-break'),
      breakAfter: getComputedStyle(h).breakAfter,
      // 🔴 罠①: 箱が在るかを **break-after と対で**見る
      boxes: h.getClientRects().length,
      display: getComputedStyle(h).display,
    }));
    return {
      shellDisplay: cs("[data-pkc-region='shell']")?.display ?? '(無し)',
      detailOverflowY: cs("[data-pkc-region='detail']")?.overflowY ?? '(無し)',
      sidebar: cs("[data-pkc-region='sidebar']")?.display ?? '(無し)',
      inspector: cs("[data-pkc-region='inspector']")?.display ?? '(無し)',
      hrs,
    };
  });

  // ① 器がほどけている(ここがほどけないと窓の分しか紙に出ない)
  expect(printed.shellDisplay, '紙でも grid のまま(器がほどけていない)').toBe('block');
  expect(printed.detailOverflowY, '紙でもスクロール箱のまま').toBe('visible');
  // ② 紙に押せないものを出さない
  expect(printed.sidebar, '紙に一覧が出ている').toBe('none');
  expect(printed.inspector, '紙に付随情報が出ている').toBe('none');

  // ③ 🔴 改頁のマーカーは **break-after が page** かつ **箱が在る**
  const breaks = printed.hrs.filter((h) => h.isBreak);
  expect(breaks.length, '改頁のマーカーを 1 つも見ていない').toBeGreaterThanOrEqual(2);
  for (const h of breaks) {
    expect(h.breakAfter, '改頁が指定されていない').toBe('page');
    expect(h.display, 'display:none にすると改頁も消える(罠①)').not.toBe('none');
    expect(h.boxes, '箱が無い ── break-after は page でも改頁は起きない(罠①)').toBeGreaterThan(0);
  }

  // ④ 出し分け ── `---`(kind=rule)は改頁しないし、線は残る
  const plain = printed.hrs.filter((h) => !h.isBreak);
  expect(plain.length, '素の罫線を見ていない').toBeGreaterThanOrEqual(1);
  for (const h of plain) {
    expect(h.breakAfter, 'kind=rule でも改頁している(hr 全体に当ててしまっている)').toBe('auto');
  }

  /**
   * ⑤ 🔴 **実際に紙が増えたことを頁数で見る**(計算後の style は「指定した」だけ)。
   * ⚠ `page.pdf()` は headless 限定 ── headed のときは飛ばす。
   */
  const pdf = await page.pdf({ format: 'A4' }).catch(() => null);
  if (pdf) {
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages, `紙が 1 枚しか出ていない(切れている)。頁数=${pages}`).toBeGreaterThan(2);
  }

  /**
   * ⑥ 🔴 **配る HTML でも同じことが成り立つ**(経路ごとに pin する)。
   *
   * ⚠ 画面側だけ見ていると、書き出し側の改頁を落とす変異が**生き延びる**
   * (実測で生き延びた)。`+++` の意味が面で食い違うのは、この PR が直しに来た
   * 「約束が面ごとに違う」そのものである。
   * ⚠ 書き出したファイルは `file://` で**単体で**開く ── アプリの CSS は届かない。
   */
  await page.emulateMedia({ media: 'screen' });
  // ⚠ 紙の幅(794px)のままだと右の列が出ない(`data-pkc-layout` が tablet)──
  //   ここから先は紙ではなく**画面の話**なので、窓を元の幅へ戻す。
  await page.setViewportSize({ width: 1280, height: 900 });
  const dl = page.waitForEvent('download');
  // ⚠ #1017 段④a でこの操作は右の列(何も選んでいないとき)へ移った ── 先に出す
  await gotoCollectionPane(page);
  await clickReal(page, '[data-pkc-action="export-html"]');
  const download = await dl;
  const file = join(tmpdir(), `pkc3-print-${process.pid}.html`);
  await download.saveAs(file);

  const viewer = await page.context().newPage();
  await viewer.goto(`file://${file}`);
  await expect(viewer.locator('#pkc-body')).toBeVisible();
  await viewer.setViewportSize(A4);
  await viewer.emulateMedia({ media: 'print' });
  const exported = await viewer.evaluate(() => {
    const hrs = [...document.querySelectorAll('#pkc-body hr')].map((h) => ({
      isBreak: h.classList.contains('pkc-section-break'),
      breakAfter: getComputedStyle(h).breakAfter,
      boxes: h.getClientRects().length,
      display: getComputedStyle(h).display,
    }));
    return hrs;
  });
  const expBreaks = exported.filter((h) => h.isBreak);
  expect(expBreaks.length, '配る HTML に改頁のマーカーが出ていない').toBeGreaterThanOrEqual(2);
  for (const h of expBreaks) {
    expect(h.breakAfter, '配る HTML で改頁が指定されていない').toBe('page');
    expect(h.display, '配る HTML で display:none にしている(罠①)').not.toBe('none');
    expect(h.boxes, '配る HTML で箱が無い(改頁は起きない ── 罠①)').toBeGreaterThan(0);
  }
  const expPlain = exported.filter((h) => !h.isBreak);
  expect(expPlain.length, '配る HTML に素の罫線が出ていない').toBeGreaterThanOrEqual(1);
  for (const h of expPlain) {
    expect(h.breakAfter, '配る HTML で kind=rule も改頁している').toBe('auto');
  }
  await viewer.close();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **紙に出す口が画面に在り、押すと印刷が始まる**(#187、2026-08-23)。
 *
 * ⚠ **観測点は「印刷が始まる瞬間」**(`beforeprint`)であって、押した直後ではない
 * ── CLAUDE.md §5:`chrome` は `beforeprint` のみ、CI 既定の `headless_shell` は
 * `beforeprint` + `afterprint` を**同期発火**する。どちらのビルドでも成立するのは
 * この 1 点だけである。
 *
 * ⚠ 台帳(#180)が「PDF の書き出し口が無い」と書いていた実体は**これ**だった ──
 * `@media print` も `Ctrl+P` も最初から在り、**一覧に並んでいなかった**だけ。
 *
 * ⚠ **既存の smoke は 1 件も `window.print()` を呼んでいない**
 * (`import.smoke.spec.ts` は合成 `beforeprint` を撃つ)。だから §5 のとおり
 * **2 つのビルド両方で通してから push した** ── `chromium-1194` / CI 既定の
 * `chromium_headless_shell-1194`(`PKC3_CHROMIUM` で差す)。どちらも 1 秒台。
 */
test('🔴 情報ペインの「PDF」を押すと印刷が始まる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  // 🔴 章の中の「添付から読む囲み」(```csv asset:K)── 刷る瞬間に「添付にあります」の案内が残らないことを下で見る(#1087 A4)
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'uriage.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('しなもの,かず\nりんご,120\n', 'utf8'),
  });
  const csvKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  expect(csvKey, '前提:csv の添付の鍵が取れている').toBeTruthy();
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill('# 見出し\n\n本文が 1 行。\n\n```csv asset:' + csvKey + '\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  /**
   * 🔴 **章を埋め込んだノートを開いた直後に押しても、`print()` の瞬間に「読み込んでいます」が残らない**(#1087)。
   * ⚠ 新しい起動は足さない(同じ道中)。1 件目の「見出し」の章を 2 件目に埋め込み、刷るのは 2 件目。
   * ⚠ 刷りは 1 回だけ ── `chrome` の `window.print()` は印刷画面が閉じるまで返らず、2 回目は受けない(`busy`)。
   */
  const srcLid = await page
    .locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry]', { hasNotText: 'uriage.csv' })
    .first()
    .getAttribute('data-pkc-entry');
  expect(srcLid, '前提:1 件目の lid が引けている').toBeTruthy();
  await createEntry(page, 'text');
  const ta2 = page.locator('[data-pkc-field="editor-body"]');
  await ta2.click();
  // 🔴 #528 ② React の囲みを、**画面の外**(長い余白の先)へ置く ── 印刷は画面の外の物まで箱にして待つ
  const spacer = Array.from({ length: 150 }, (_, i) => `余白 ${String(i)} 行目`).join('\n\n');
  await ta2.fill(
    `![章](entry:${srcLid}#h/見出し)\n\n${spacer}\n\n\`\`\`react\nexport default function App(){ return <p id="pr">印刷の React</p>; }\n\`\`\`\n`,
  );
  // 🔑 本文の読み出しを 800ms 遅らせる ── 章の中身が「押した瞬間にまだ届いていない」場面を、決定的に作る
  //    (遅らせないと 8 回に 1 回しか出ない競合で、直す前の実装も緑になる)
  await page.evaluate(() => {
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: unknown[]) {
      const op = (msg as { req?: { op?: string } } | null)?.req?.op;
      if (op === 'getBody') {
        setTimeout(() => (orig as (...a: unknown[]) => unknown).call(this, msg, ...rest), 800);
        return;
      }
      return (orig as (...a: unknown[]) => unknown).call(this, msg, ...(rest as []));
    } as typeof Worker.prototype.postMessage;
  });
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  // 前提:画面の外の React は、まだ箱になっていない(見えていないので作らない)
  await expect(page.locator('[data-pkc-react-src]')).toHaveCount(1);
  await expect(page.locator('iframe.pkc-react-frame'), '前提:画面の外なのに箱が作られている(この検査は空振り)').toHaveCount(0);

  // 押した瞬間ではなく、**印刷が始まった**ことを採る
  await page.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__printed = 0;
    g.__atPrint = null;
    window.addEventListener('beforeprint', () => {
      g.__printed = ((g.__printed as number | undefined) ?? 0) + 1;
      // 🔑 紙に出る瞬間の本文(押した直後ではない)
      const body = document.querySelector('[data-pkc-field="detail-body"]');
      g.__atPrint = {
        notes: body?.querySelectorAll('[data-pkc-field="section-embed-note"]').length ?? -1,
        embeds: body?.querySelectorAll('.pkc-section-embed').length ?? -1,
        text: body?.querySelector('.pkc-section-embed')?.textContent ?? '',
        fencePending: body?.querySelectorAll('[data-pkc-fence-asset-pending]').length ?? -1,
        csvText: body?.querySelector('.pkc-section-embed table')?.textContent ?? '',
        reactFrames: body?.querySelectorAll('iframe.pkc-react-frame').length ?? -1,
      };
    });
  });

  const pdf = page.locator('[data-pkc-action="export-entry-pdf"]');
  await expect(pdf, '紙に出す口が画面に無い').toBeVisible();
  // ⚠ 説明は「起きること」で書く(user 指示 2026-08-21)── file は落ちない
  await expect(pdf).toHaveAttribute('title', /印刷画面/);

  await clickReal(page, '[data-pkc-action="export-entry-pdf"]');
  await expect
    .poll(async () => page.evaluate(() => (globalThis as unknown as Record<string, number>).__printed))
    .toBeGreaterThan(0);

  const atPrint = (await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__atPrint)) as {
    notes: number;
    embeds: number;
    text: string;
    fencePending: number;
    csvText: string;
    reactFrames: number;
  };
  expect(atPrint.embeds, '前提:章の埋め込みが本文に在る').toBeGreaterThan(0);
  expect(atPrint.notes, '🔴 刷る瞬間に「読み込んでいます」などの 1 行が残っている').toBe(0);
  expect(atPrint.text, '章の中身が紙に出ていない').toContain('本文が 1 行');
  expect(atPrint.fencePending, '🔴 刷る瞬間に、章の中の「添付にあります」の案内が残っている').toBe(0);
  expect(atPrint.csvText, '🔴 章の中の添付から読む囲みが、表として紙に出ていない').toContain('りんご');
  expect(atPrint.reactFrames, '🔴 画面の外の React が、刷る瞬間に箱になっていない(紙に描かれない)').toBe(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **狭い紙(A5)に刷っても、本文が紙に出る**(#632 段③、設計 doc §2-17)。
 *
 * ## なぜ独立した腕が要るか
 *
 * 上の A4(794px)の腕は、**スマホ用画面をただの 1 度も通らない** ── 794px は
 * `PHONE_MAX_PX`(720px)より広いからである。ところが 🔴 **印刷中の版面幅は
 * 紙の幅**なので、A5 縦(**559px**)では `matchMedia` が真になり、
 * **スマホ用画面のまま紙へ行く**。
 *
 * そのとき中央の面は `visibility: hidden` で重なっているので、
 * ⚠ **本文が 1 文字も出ない**(一覧ページで刷ると、白紙が出る)。
 * 🔑 だから `@media print` が中央を `visibility: visible` へ戻している ──
 * この腕は**その 1 行が本当に効いているか**を、紙の側から見る。
 *
 * ## ⚠ いちばん危ない状態から測る
 *
 * **一覧ページに戻ってから**刷る ── 本文ページのまま刷ると中央は元から見えていて、
 * 戻しの 1 行を消しても緑のままになる(§1「別の理由で成立している」)。
 */
test('🔴 A5(559px)の紙でも、一覧ページのまま刷って本文が出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 559, height: 794 });
  await gotoApp(page);
  // ⚠ この幅ではお知らせが**画面いっぱい**である(user 裁定 2026-09-02)── 畳まないと
  //   作る口に触れない。⚠ 紙の主張とは無関係なので、ここは前提を整えるだけである。
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill(
    Array.from({ length: 60 }, (_, i) => `## 章 ${i}\n\n紙に出るはずの行 ${i}`).join('\n\n'),
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔴 **いちばん危ない状態**へ移る ── 一覧ページ(中央が隠れている)
  await clickReal(page, '[data-pkc-field="phone-back"]');
  const shell = page.locator('[data-pkc-region="shell"]');
  await expect(shell, 'この幅でスマホ用画面になっていない(何も測っていない)').toHaveAttribute(
    'data-pkc-layout',
    'phone',
  );
  await expect(shell, '一覧ページに居ない(危ない状態を作れていない)').toHaveAttribute(
    'data-pkc-page',
    'list',
  );
  // ⚠ 空振り防止 ── 画面ではまだ中央は**隠れている**(戻しは印刷だけの話である)
  const onScreen = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('[data-pkc-region="center"]')!).visibility,
  );
  expect(onScreen, '画面でも中央が見えている(この幅はスマホ用画面ではない)').toBe('hidden');

  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => {
    const cs = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? getComputedStyle(el) : null;
    };
    const body = document.querySelector('[data-pkc-field="detail-body"]') as HTMLElement | null;
    return {
      center: cs("[data-pkc-region='center']")?.visibility ?? '(無し)',
      shell: cs("[data-pkc-region='shell']")?.display ?? '(無し)',
      sidebar: cs("[data-pkc-region='sidebar']")?.display ?? '(無し)',
      bar: cs("[data-pkc-region='phone-bar']")?.display ?? '(無し)',
      // 🔴 「見える」だけでなく**箱が在る**ことを対で見る(この file の罠①)
      boxes: body?.getClientRects().length ?? 0,
      scrollH: body?.scrollHeight ?? 0,
    };
  });

  expect(printed.center, '🔴 一覧ページのまま刷ると本文が 1 文字も出ない').toBe('visible');
  expect(printed.boxes, '中央は見えているのに本文の箱が無い(罠①)').toBeGreaterThan(0);
  expect(printed.scrollH, '本文が 1 行も組まれていない').toBeGreaterThan(2000);
  // ⚠ 紙に押せない物は出さない(A4 の腕と同じ約束が、この幅でも成り立つ)
  expect(printed.shell, '紙でも grid のまま(器がほどけていない)').toBe('block');
  expect(printed.sidebar, '紙に一覧が出ている').toBe('none');
  expect(printed.bar, '紙にページの帯が出ている(押せる物が無い)').toBe('none');

  /**
   * 🔴 **紙が本当に増えたことまで見る**(計算後の style は「指定した」だけ)。
   * ⚠ `page.pdf()` は headless 限定 ── headed のときは飛ばす。
   */
  const pdf = await page.pdf({ format: 'A5' }).catch(() => null);
  if (pdf) {
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages, `A5 の紙が 1 枚しか出ていない(本文が落ちている)。頁数=${pages}`)
      .toBeGreaterThan(2);
  }

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});


/**
 * 🔴 暗い配色のまま刷っても、紙は白地に濃い字で、リンクも読める(#1387)。
 *
 * 全部の暗い配色を 1 回の起動で回す(配色は CSS の属性 1 つなので、属性を差し替えて測る)。
 * 観測点は計算後の色。⚠ 画面側(対照群)でも同じ要素を測る ── 画面が暗くない回は
 * 「刷っても暗くない」が空振りで通るので、先に「画面では地が暗く字が明るい」を assert する。
 * リンクは WCAG のコントラスト比で見る(白地に 4.5 以上)。直す前は terminal 1.34 / nord 2.00 /
 * dracula 2.41 / solarized-dark 2.64 / github-dark 3.10 / dark 4.04 / retro 2.08 だった。
 */
test('🔴 暗い配色で刷ると、地は白・字は濃く、リンクは白地で読める(全部の暗い配色)', async ({
  page,
}) => {
  // 暗い配色の一覧は tokens.css から引く(手で並べると、配色を足した日に漏れる)
  const tokens = readFileSync('src/styles/tokens.css', 'utf8');
  const darkIds = [...tokens.matchAll(/:root\[data-pkc-theme='([a-z-]+)'\] \{([^}]*)\}/g)]
    .filter((m) => m[2]!.includes('color-scheme: dark'))
    .map((m) => m[1]!);
  expect(darkIds.length, '暗い配色が 6 つ未満(この検査は空振り)').toBeGreaterThanOrEqual(6);

  await gotoApp(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill('紙に出る本文\n\n[リンク](https://example.com/)\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  const sample = (): Promise<{ bg: string; text: string; link: string }> =>
    page.evaluate(() => {
      const host = document.querySelector('[data-pkc-field="detail-body"]')!;
      return {
        bg: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(host.querySelector('p')!).color,
        link: getComputedStyle(host.querySelector('a')!).color,
      };
    });
  const rgb = (c: string): number[] => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    expect(m, `色が読めない: ${c}`).not.toBeNull();
    return [Number(m![1]), Number(m![2]), Number(m![3])];
  };
  const lum = (c: string): number => {
    const [r, g, b] = rgb(c).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrastOnWhite = (c: string): number => 1.05 / (lum(c) + 0.05);

  await page.setViewportSize(A4);
  for (const id of darkIds) {
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate((t) => document.documentElement.setAttribute('data-pkc-theme', t), id);
    const screen = await sample();
    expect(lum(screen.bg), `${id}: 画面で地が暗くない(この検査は空振り)`).toBeLessThan(0.1);
    expect(lum(screen.text), `${id}: 画面で字が明るくない(この検査は空振り)`).toBeGreaterThan(0.3);

    await page.emulateMedia({ media: 'print' });
    const paper = await sample();
    expect(lum(paper.bg), `${id}: 紙の地が白くない: ${paper.bg}`).toBeGreaterThan(0.9);
    expect(contrastOnWhite(paper.text), `${id}: 紙の字が薄い: ${paper.text}`).toBeGreaterThan(7);
    expect(
      contrastOnWhite(paper.link),
      `${id}: 紙のリンクが白地で読めない: ${paper.link}`,
    ).toBeGreaterThanOrEqual(4.5);
  }

  /**
   * 🔴 **同じ起動で、図の色と折りたたみを見る**(束 K1 / #1163 依頼 232・234・349)。
   * 暗い配色で、図と「閉じた折りたたみの中の図」を持つノートを刷る。**印刷が始まった瞬間**に
   * 図が明るい地で描かれ、折りたたみが開いており、**刷り終えたら**画面の配色(暗い地)と閉じた状態に戻る。
   * ⚠ 新しい起動は足さない。対照群:押す前の画面では図の地が暗く、折りたたみが閉じている。
   */
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await createEntry(page, 'text');
  const ta2 = page.locator('[data-pkc-field="editor-body"]');
  await ta2.click();
  const fig = '```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n';
  // 🔴 束 K2(#1163 依頼 116-1):見出しで畳んだ章も、同じ道中で見る(下の beforeprint で数える)
  await ta2.fill(`${fig}\n:::details{summary="畳み"}\n${fig}:::\n\n# 畳む章\n\n畳まれる本文の段落。\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  const chapterMark = page.locator('[data-pkc-field="detail-body"] h1 [data-pkc-field="heading-fold"]');
  await expect(chapterMark, '前提:章の畳む口が出ている').toHaveCount(1);
  await clickReal(page, '[data-pkc-field="detail-body"] h1 [data-pkc-field="heading-fold"]');
  const chapterBody = page.locator('[data-pkc-field="detail-body"] p', { hasText: '畳まれる本文の段落' });
  await expect(chapterBody, '前提:章を畳んだら本文が隠れる(対照群)').toBeHidden();
  const figs = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(figs.first()).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30_000 });
  // 折りたたみの中の図は、閉じている間は焼かれない(見えない器は描かない)
  const folded = page.locator('[data-pkc-field="detail-body"] details:not([open])');
  expect(await folded.count(), '前提:閉じた折りたたみが在る').toBe(1);

  // 図の地の明るさ(画像の左上の 1 画素。0 = 黒 / 255 = 白、透明は -1)
  const shot = (): Promise<number[]> =>
    page.evaluate(() => {
      return [...document.querySelectorAll<HTMLImageElement>('[data-pkc-field="mermaid-image"]')].map((img) => {
        const c = document.createElement('canvas');
        c.width = 4;
        c.height = 4;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 1, 1).data;
        return d[3]! < 8 ? -1 : Math.round((d[0]! + d[1]! + d[2]!) / 3);
      });
    });
  const before = await shot();
  expect(before.length, '前提:画面に図が在る').toBeGreaterThanOrEqual(1);
  expect(before[0]!, `前提:画面の図の地が暗くない(この検査は空振り): ${before[0]}`).toBeGreaterThanOrEqual(0);
  expect(before[0]!, `前提:画面の図の地が暗くない(この検査は空振り): ${before[0]}`).toBeLessThan(100);

  await page.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__printedK1 = 0;
    g.__afterK2 = false;
    window.addEventListener('afterprint', () => {
      g.__afterK2 = true;
    });
    g.__figAtPrint = null;
    window.addEventListener('beforeprint', () => {
      g.__printedK1 = ((g.__printedK1 as number | undefined) ?? 0) + 1;
      const imgs = [...document.querySelectorAll<HTMLImageElement>('[data-pkc-field="mermaid-image"]')];
      g.__chapterAtPrint = [...document.querySelectorAll<HTMLElement>('[data-pkc-field="detail-body"] p')].find(
        (p) => (p.textContent ?? '').includes('畳まれる本文の段落'),
      )?.hidden;
      g.__figAtPrint = {
        open: document.querySelectorAll('[data-pkc-field="detail-body"] details:not([open])').length,
        shades: imgs.map((img) => {
          const c = document.createElement('canvas');
          c.width = 4;
          c.height = 4;
          const x = c.getContext('2d')!;
          x.drawImage(img, 0, 0, 4, 4);
          const d = x.getImageData(0, 0, 1, 1).data;
          return d[3]! < 8 ? -1 : Math.round((d[0]! + d[1]! + d[2]!) / 3);
        }),
      };
    });
  });
  await clickReal(page, '[data-pkc-action="export-entry-pdf"]');
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as Record<string, number>).__printedK1))
    .toBeGreaterThan(0);
  const atPrint = (await page.evaluate(
    () => (globalThis as unknown as Record<string, unknown>).__figAtPrint,
  )) as { open: number; shades: number[] };
  expect(atPrint.open, '🔴 刷る瞬間に、閉じた折りたたみが残っている').toBe(0);
  expect(
    await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__chapterAtPrint),
    '🔴 刷る瞬間に、見出しで畳んだ章が開いていない(hidden のまま)',
  ).toBe(false);
  // 🔴 刷る前に出す案内(画面の下)
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '🔴 印刷の画面で「PDF として保存」を選ぶ案内が出ていない',
  ).toContainText('印刷の画面で「PDF として保存」を選ぶと');
  expect(atPrint.shades.length, '🔴 刷る瞬間、折りたたみの中の図が描かれていない').toBe(2);
  for (const v of atPrint.shades) expect(v, `🔴 刷る瞬間の図が暗い地のまま: ${v}`).toBeGreaterThan(200);

  /**
   * 刷り終えたら、畳んだ章は畳み直る。⚠ フル chromium は `afterprint` を撃たない(headless_shell は同期で撃つ)ので、
   * 撃たれていなければここで合成して撃つ ── どちらのビルドでも「afterprint で畳み直す」を見る(import.smoke と同じ作法)。
   */
  await page.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g.__afterK2 !== true) window.dispatchEvent(new Event('afterprint'));
  });
  // 刷り終えたら、畳んだ章は畳み直る
  await expect(chapterBody, '🔴 刷り終えたのに、畳んだ章が開いたまま').toBeHidden();
  // 刷り終えたら、画面の配色と閉じた状態へ戻る
  await expect(folded, '🔴 刷り終えたのに折りたたみが開いたまま').toHaveCount(1);
  await expect
    .poll(async () => (await shot())[0], { message: '🔴 刷り終えたのに図が明るいまま' })
    .toBeLessThan(100);
});
