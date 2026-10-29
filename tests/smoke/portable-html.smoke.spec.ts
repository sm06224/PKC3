import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { answerAppDialog, clickReal, createEntry,
  gotoCollectionPane,
  pickCaptureTool,
  useSplitEditor,
} from './helpers';

/**
 * 🔴 **可搬単一 HTML が `file://` で起動する**(#400 段①②)。
 *
 * > 正本 doc §9.2 は書き出し 3 形式のうち**これを「主」と呼んでいる**のに、
 * > 実装が無いまま設計 doc が 20 日間どこにも積まれていなかった(#400)。
 *
 * 🔴 **unit では原理的に届かない層**だけを見る:
 * ① **`file://` で本当に起動するか** ── `http://` で通ることは保証にならない
 *    (module worker が起動しない / OPFS が opaque origin で取れない)
 * ② **worker が classic の blob で本当に動くか** ── 畳み方が正しいかは、
 *    走らせるまで分からない
 * ③ **wasm が `data:` から読めるか** ── sqlite の loader は
 *    `self.location.href` から相対で解決するので、blob worker では解けない
 *
 * ④ 🔴 **再読込で残るか**(段③)── 器は `file://` の IndexedDB。
 *    ⚠ そして **`file://` は origin が全部 `file://` に潰れる**(実測)ので、
 *    ⑤ **別のバンドルが互いを上書きしないか**まで見ないと、正しさを主張できない。
 */
const HTML = resolve('dist-portable/pkc3.html');
/** 配信される `dist` の隣(アプリが `fetch` で取りに行く先)。 */
const TEMPLATE = resolve('dist/portable-template.html');

test.beforeAll(() => {
  /**
   * ⚠ **無ければ自分で焼く** ── 通常の `npm run build` は `dist-portable` を
   *   作らない(本番の配り物を単一化しないため)。ここで焼かないと、
   *   この spec は**環境によって走ったり走らなかったり**する
   *   (走らない回を「通った」と読む形を作らない)。
   */
  if (existsSync(HTML)) return;
  execFileSync('npx', ['vite', 'build', '--config', 'build/portable.config.ts'], {
    stdio: 'ignore',
  });
  execFileSync('node', ['build/portable/fold.mjs'], { stdio: 'ignore' });
});

/**
 * 🔴 **雛形を `dist` の隣に置く**(#400 段④)。
 *
 * 本番では CI がやる(`pages.yml` / `release.yml` の「検品の**後**」の step)──
 * ⚠ **検品の後**なのは、雛形をアプリの一部にしないためである
 *   (size cap の主張が変わる / **SW の precache に載る**)。
 * ここでもその形をそのまま真似る(smoke は `dist` を配信している)。
 */
test.beforeAll(() => {
  copyFileSync(HTML, TEMPLATE);
});

test('🔴 畳んだ 1 個の HTML が `file://` で起動する (#400 段①②)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);

  // ① 起動する
  await expect(
    page.locator('[data-pkc-boot="ready"]'),
    '`file://` で起動しない',
  ).toBeAttached({ timeout: 20_000 });
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);

  /**
   * ② 🔴 **選んだ形を「事故」として告げない**(段③ で向きが変わった)。
   *
   * ⚠ 段①② の時点ではここが `SecurityError` を**要求**していた ── OPFS を
   *   試して落ちていたからである。段③ で可搬バンドルは **OPFS を試さなくなった**
   *   ので、`fallbackReason` は載らない。
   * 🔑 主張の向きが変わったので、**空振り防止も置き直す**(CLAUDE.md §1
   *   「検査の向きを裏返したら、作法も裏返る」)── 状態の面が**実在する**ことを
   *   先に確かめてから、そこに警告が無いことを見る。
   */
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status, '状態の面が無い(検査そのものが空振りしている)').toBeAttached();
  await expect(status).not.toContainText('SecurityError');

  // ③ 🔴 **worker が動いている**(ノートを作れる = storage worker が生きている)
  await createEntry(page, 'text');
  await expect(
    page.locator('[data-pkc-field="editor-title"]'),
    'ノートを作れない(worker が動いていない)',
  ).toBeVisible({ timeout: 10_000 });
});

/**
 * 🔴 **段③ の本題 ── 再読込で残る。**
 *
 * ⚠ この test は段①② の時点では「**残らない**」を pin していた
 * (「段③ が入ったらここが落ちて、書き換えろと言ってくる」と書いてあった)──
 * その通りに落ちたので、向きを裏返した。
 */
test('🔴 `file://` で作ったノートが再読込で残る (#400 段③)', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  /**
   * ⚠ **一覧の面を明示してから数える**(1 稿目で踏んだ)。
   * 🔑 素で `[data-pkc-entry]` を数えると**情報ペインのボタン**に満たされる
   *   ── #180 で nightly を 13 晩赤にしたのと同じ罠である(§1「別の面の文字」)。
   */
  const rows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  /**
   * ⚠ **前提を assert する。** ここが 0 でないなら、前の走りの器が残っている
   *   (playwright は走りごとに profile を捨てるが、それは**前提であって観測では
   *   ない**)── 崩れたときに「残った」と読まないための門である。
   */
  await expect(rows, '最初から 1 件ある(前の走りの器が残っている)').toHaveCount(0);

  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill('可搬に残るノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows, '作ったのに一覧に出ない(前提が崩れた)').toHaveCount(1, { timeout: 10_000 });

  /**
   * 🔴 **保存は束ねて遅らせる**(打鍵ごとには書かない)。だから
   *   **閉じる合図を送ってから**再読込する ── これは製品が本当にやっている手順
   *   (`visibilitychange` の hidden で flush)であって、test 用の近道ではない。
   */
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1_500);

  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(rows, '🔴 再読込で消えた(段③ が効いていない)').toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-pkc-region="filer-table"]')).toContainText('可搬に残るノート');

  /**
   * 🔴 **2 枚のタブ ── 本体を閉じて昇格した側の書込が、両方のノートを残す**(#1087)。
   * 直す前は、昇格したタブが**古い画像**(起動時に読んだ版)で開き直すため、
   * 本体が書いた分を失った上に書いた(データ消失)。既存の再読込の道中に足す(起動は 1 つだけ増える)。
   */
  const flush = (p: typeof page) =>
    p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  const pageB = await context.newPage();
  await pageB.setViewportSize({ width: 1440, height: 900 });
  await pageB.goto(pathToFileURL(HTML).href);
  await expect(pageB.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '保存はメインのタブ経由',
    { timeout: 15_000 },
  );
  // A(本体)が B の起動後に書く ── B が起動時に読んだ画像には無い分
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('Aが書いたノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await flush(page);
  await page.waitForTimeout(1_500);
  await page.close();
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    'このタブがメインのタブになりました',
    { timeout: 15_000 },
  );
  const rowsB = pageB.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await createEntry(pageB, 'text');
  await pageB.locator('[data-pkc-field="editor-title"]').fill('昇格後のBのノート');
  await clickReal(pageB, '[data-pkc-action="commit-edit"]');
  await expect(rowsB).toHaveCount(3, { timeout: 15_000 });
  await flush(pageB);
  await pageB.waitForTimeout(1_500);
  await pageB.reload();
  await expect(pageB.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(rowsB, '🔴 昇格したタブが古い画像で書いて、A のノートが消えた').toHaveCount(3, {
    timeout: 15_000,
  });
  const tableB = pageB.locator('[data-pkc-region="filer-table"]');
  await expect(tableB).toContainText('Aが書いたノート');
  await expect(tableB).toContainText('昇格後のBのノート');
});

/**
 * 🔴 **足した直後に閉じても、次に開くと戻る**(#1589 の根治 ── 変更分の日誌)。
 *
 * 画像の保存は「1.2 秒待つ → 書き出す → 器へ書く」で、**その前に閉じると以前は直前の分が消えた**。
 * ⚠ 待たずに閉じる(150ms ── 画像の保存が始まる 1.2 秒より十分手前)。閉じる合図(`visibilitychange`)も送らず、
 *   ページをそのまま閉じる ── 日誌が先に書かれていなければ、次の起動で空になる。
 */
test('🔴 `file://` で足した直後(画像の保存の前)に閉じても、開き直すと戻る (#1589)', async ({ context }) => {
  const open = async () => {
    const p = await context.newPage();
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.goto(pathToFileURL(HTML).href);
    await expect(p.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
    return p;
  };
  const rowsOf = (p: Awaited<ReturnType<typeof open>>) =>
    p.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  const first = await open();
  await expect(rowsOf(first), '最初から 1 件ある(前の走りの器が残っている)').toHaveCount(0);
  await createEntry(first, 'text');
  await first.locator('[data-pkc-field="editor-title"]').fill('日誌で戻るノート');
  await clickReal(first, '[data-pkc-action="commit-edit"]');
  await expect(rowsOf(first)).toHaveCount(1, { timeout: 10_000 });
  // 画像の保存(1.2 秒)より手前で閉じる。⚠ 確認(離れますか)は出さずに閉じる = 離れる選択をした形
  await first.waitForTimeout(150);
  await first.close();

  const second = await open();
  await expect(rowsOf(second), '🔴 足した直後に閉じたら消えた(日誌が効いていない)').toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(second.locator('[data-pkc-region="filer-table"]')).toContainText('日誌で戻るノート');
});

/**
 * 🔴 **別のバンドルは互いを上書きしない**(#400 段③ の正しさの要件)。
 *
 * > ⚠ **`file://` では origin が全部 `file://` に潰れる**(2026-08-25 実測)──
 * > 別ディレクトリの別 HTML 同士で IndexedDB が**共有される**。
 *
 * だから器の名前を id で切っていなければ、**2 つ書き出して両方使うと片方が
 * 黙って消える**。⚠ これは unit では原理的に見えない(`file://` が要る)。
 */
test('🔴 別の id のバンドルは、互いのノートを見ない (#400 段③)', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-portable-'));
  const other = join(dir, 'other.html');
  const src = readFileSync(HTML, 'utf-8');
  const from = '{"id":"pkcb-template","exportedAt":0}';
  expect(src, '雛形に印が無い(検査そのものが空振りしている)').toContain(from);
  writeFileSync(other, src.replace(from, '{"id":"pkcb-othertest01","exportedAt":0}'));

  // ① 雛形のほうに 1 件書く
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  const rows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await expect(rows).toHaveCount(0);
  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill('雛形のノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows).toHaveCount(1, { timeout: 10_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1_500);

  // ② 別の id のバンドルを開く ── 🔴 **見えてはいけない**
  await page.goto(pathToFileURL(other).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    rows,
    '🔴 別のバンドルのノートが見えている(器の名前空間が切れていない)',
  ).toHaveCount(0, { timeout: 10_000 });

  // ③ 🔑 **対照群** ── 雛形へ戻ると、ちゃんと残っている
  //    (②が 0 件なのは「どちらも保存できていない」からではない)
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(rows, '雛形の側まで消えている(保存そのものが効いていない)').toHaveCount(1, {
    timeout: 15_000,
  });
});


/**
 * 🔴 **段④ の本題 ── 書き出した 1 枚が、そのまま PKC3 として開く。**
 *
 * ⚠ これは unit では原理的に届かない:
 * ① `fetch` で雛形を取る(同じ origin)② `<a download>` で受け取る
 * ③ **`file://` で開いて、中身が入っていること**
 *
 * 🔑 対照群を先に置く ── 「書き出した 1 枚に元の本文が在る」だけでは、
 *   **雛形をそのまま配っても通る**(雛形にも同じアプリが入っている)。
 *   だから **user が打った題名**が出ることを見る。
 */
test('🔴 書き出した 1 枚が、そのまま PKC3 として開く (#400 段④)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });

  // ⚠ 既定で開いている面は一覧とは限らない(既定はフォルダ)── 先に開く
  const title = `持ち出す本文 ${process.pid}`;
  await createEntry(page, 'text');
  await expect(page.locator('[data-pkc-field="editor-title"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-region="filer-table"]')).toContainText(title, {
    timeout: 10_000,
  });

  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)に在る ── 先に開く
  const dl = page.waitForEvent('download');
  // ⚠ #1017 段④a でこの操作は右の列(何も選んでいないとき)へ移った ── 先に出す

  /**
   * 🔴 **送り主の端末に未読のメッセージがあっても、書き出した HTML には持ち越さない**(台帳 #1852 束 L1。確認 D)。
   * 先に送り主の端末で「問題」を 1 件起こして、画面下の「未読のメッセージ」を出しておく
   * (読めない Office 一式のファイルを入れる ── 起動直後は未読 0 件で、これが無いと持ち越しの有無が見えない)。
   */
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const senderUnread = page.locator('[data-pkc-region="status"] [data-pkc-field="status-messages"]');
  const chooser = page.waitForEvent('filechooser');
  await clickReal(page, '[data-pkc-view-pane="settings"] [data-pkc-field="office-pack-file"]');
  await (await chooser).setFiles({ name: 'broken-pack.zip', mimeType: 'application/zip', buffer: Buffer.from('not a pack') });
  await expect(senderUnread, '前提が崩れている(送り主に未読が立っていない)').toBeVisible({ timeout: 15_000 });

  await gotoCollectionPane(page);

  await clickReal(page, '[data-pkc-action="export-portable"]');
  const out = join(mkdtempSync(join(tmpdir(), 'pkc3-out-')), 'carried.html');
  await (await dl).saveAs(out);

  // ① 1 枚で成立している(外部参照が 0 件 = 雛形の門がそのまま効いている)
  const bytes = readFileSync(out, 'utf-8');
  expect(bytes.length, '書き出した 1 枚が小さすぎる').toBeGreaterThan(3_000_000);
  // 🔴 印が雛形のままではない(= 器を新しく切っている)
  expect(bytes, '雛形の器のまま書き出している').not.toContain('"id":"pkcb-template"');

  // ② 🔴 `file://` で開いて、**打った題名**が出る
  const carried = await page.context().newPage();
  await carried.goto(pathToFileURL(out).href);
  await expect(carried.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  // 🔴 D. 未読の件数は読み込みの後で入る ── 少し置いてから、送り主のメッセージ(未読)が入っていないことを見る
  await carried.waitForTimeout(1_500);
  await expect(
    carried.locator('[data-pkc-region="status"] [data-pkc-field="status-messages"]'),
    '書き出した HTML に、送り主の未読のメッセージが入っている',
  ).toBeHidden();
  /**
   * 🔑 診断(#1066)── **assert より前に 1 行で残す**(落ちた回にだけ欲しい)。
   *
   * ⚠ 分けたいのは「書き出した 1 枚の中の DB 画像が古かった」か「画像は新しいのに、
   *   boot が別の画像(端末の器)を選んだ」か。判定は assert しない(門は下のまま)。
   * ⚠ 焼いた画像の `<script>` は boot が **DOM から外す**(`takeEmbeddedImage`)ので、
   *   開いた後の page からは読めない ── **書き出した file の原文**から読む。
   *   選んだ理由(`choice.why`)は **画面にも `window` にも console にも出ていない**ので、
   *   読めるのは材料(器の記録と印の時刻)まで ── 比べるのは `chooseImage` の規則どおり
   *   `savedAt >= exportedAt` なら器が選ばれる。
   */
  const tagText =
    /<script type="application\/json" data-pkc-bundle>([^<]*)<\/script>/.exec(bytes)?.[1] ?? null;
  const imagePayloads = [
    ...bytes.matchAll(
      /<script type="application\/octet-stream;base64" data-pkc-db-image(?:="[^"]*")?>([^<]*)<\/script>/g,
    ),
  ].map((mm) => mm[1]!.trim().length);
  let bundleId: string | null = null;
  let exportedAt: number | null = null;
  try {
    const parsed = JSON.parse(tagText ?? '') as { id?: string; exportedAt?: number };
    bundleId = parsed.id ?? null;
    exportedAt = parsed.exportedAt ?? null;
  } catch {
    // ⚠ 読めなければ null のまま出す(診断が落ちて本題の assert を隠さない)
  }
  const boot = await carried
    .evaluate(async (id) => {
      const domImage = document.querySelector('script[data-pkc-db-image]') !== null;
      if (!id) return { domImage, stored: 'no-id' };
      const stored = await new Promise<string>((res) => {
        const rq = indexedDB.open(`pkc3-bundle-${id}`);
        rq.onerror = () => res('open-error');
        rq.onsuccess = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains('image')) {
            db.close();
            res('no-store');
            return;
          }
          const g = db.transaction('image', 'readonly').objectStore('image').get('db');
          g.onerror = () => {
            db.close();
            res('get-error');
          };
          g.onsuccess = () => {
            db.close();
            const r = g.result as
              | { bundleId?: string; exportedAt?: number; savedAt?: number; image?: { byteLength?: number } }
              | undefined;
            res(
              r === undefined
                ? 'none'
                : `bundleId=${r.bundleId === id ? 'same' : 'other'} exportedAt=${r.exportedAt} savedAt=${r.savedAt} bytes=${r.image?.byteLength ?? 'n/a'}`,
            );
          };
        };
      });
      return { domImage, stored };
    }, bundleId)
    .catch((e: unknown) => ({ domImage: null, stored: `evaluate-error:${String(e)}` }));
  console.log(
    `[#1066] portable fileBytes=${bytes.length} bundleTag=${tagText === null ? 'none' : 'found'}` +
      ` exportedAt=${exportedAt} imageScripts=${imagePayloads.length} imagePayloadLen=[${imagePayloads.join(',')}]` +
      ` domImageAfterBoot=${boot.domImage} stored={${boot.stored}} bootChoice=n/a(not-exposed)`,
  );
  await expect(
    carried.locator('[data-pkc-region="filer-table"]'),
    '🔴 書き出した 1 枚に中身が入っていない',
  ).toContainText(title, { timeout: 15_000 });

  // ③ 🔑 **続きが書ける**(読むだけの HTML との違いはここである)
  await createEntry(carried, 'text');
  await expect(carried.locator('[data-pkc-field="editor-title"]')).toBeVisible({
    timeout: 10_000,
  });
  await carried.locator('[data-pkc-field="editor-title"]').fill('持ち出した先で足した');
  await clickReal(carried, '[data-pkc-action="commit-edit"]');
  await expect(carried.locator('[data-pkc-region="filer-table"]')).toContainText(
    '持ち出した先で足した',
    { timeout: 10_000 },
  );
  await carried.close();

  /**
   * ④ 🔴 **その 1 枚を、元の PKC3 の「取り込み」に選ぶと、ノートが戻る**(#1416)。
   *
   * 🔑 取り込み先には同じノートが**もう在る**(書き出した元) ── 戻ったなら、同じ題名が **2 件**になる
   *   (ID が衝突するので付け替えて追加される)。1 件のままなら「何も入らなかった」。
   * ⚠ 取り込む前に出る確認は、バックアップ(.pkc3-full.zip)と同じ道を通っている印である。
   */
  const rowsOf = page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]')
    .filter({ hasText: title });
  await expect(rowsOf, '前提: 取り込む前は 1 件').toHaveCount(1);
  await page.setInputFiles('[data-pkc-field="import-input"]', out);
  const asked = await answerAppDialog(page, 'ok');
  expect(asked, '取り込み前の確認にノートの件数が出ていない').toContain('1');
  await expect(rowsOf, '🔴 PKC3 入り HTML を取り込んでも、ノートが戻らない').toHaveCount(2, {
    timeout: 15_000,
  });
});

/**
 * 🔴 **持ち歩ける 1 枚でも、マニュアルの窓は 1 枚に焼き込んだ page を `blob:` で開く**
 * (#648 段③。段②までは隣に `manual.html` が無いので `about:blank` に組んでいた ──
 * **F5 で白紙** / 配色は明暗の 2 種だけ、が 1 枚ではそのままだった)。
 *
 * ここでしか確かめられないのは 4 つ ── ① `file://` の opener が作った `blob:` へ
 * 本当に navigate できるか(top-level の `data:` はブラウザが止める) ② `file://` 由来の
 * blob で **F5 が効くか**(blob URL が生きている間は読み直せる) ③ 暗い環境で読めるか
 * ④ opener が焼いた配色が届くか(`file://` 由来の blob は `localStorage` に触れないことが
 * ある ── 属性で焼く道が効いていること)。
 */
test.describe('暗い環境', () => {
  test.use({ colorScheme: 'dark' });

  test('🔴 持ち歩ける 1 枚でも、マニュアルの窓が blob: の page で開き、F5 で消えない (#648 段③)', async ({
    page,
    context,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(pathToFileURL(HTML).href);
    await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
    await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');

    const popup = context.waitForEvent('page');
    await clickReal(page, '[data-pkc-action="open-manual-window"]');
    const win = await popup;
    // ① 焼き込んだ page へ移る(about:blank のままなら段①の逃げ道へ落ちている)
    await win.waitForURL((u) => u.protocol === 'blob:');
    const toc = win.locator('[data-pkc-region="manual-window-toc"] a');
    await expect(toc.first(), '目次が出ない(page に移れていない)').toBeVisible();
    const links = await toc.count();
    expect(links, '目次が空').toBeGreaterThan(100);
    // ⚠ 段①の印(`<button>` の目次)ではない
    expect(await win.locator('[data-pkc-region="manual-window-toc"] button').count()).toBe(0);

    // ③ 暗い環境で読める(tokens の配色が効いている)
    const lum = (css: string): number => {
      const m = css.match(/\d+/gu);
      if (!m || m.length < 3) return -1;
      return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
    };
    const seen = await win.evaluate(() => ({
      fg: getComputedStyle(document.body).color,
      bg: getComputedStyle(document.body).backgroundColor,
      rootBg: getComputedStyle(document.documentElement).backgroundColor,
      theme: document.documentElement.getAttribute('data-pkc-theme'),
    }));
    expect(seen.theme, '配色の属性が立っていない').toBe('dark');
    const fg = lum(seen.fg);
    const bg = Math.max(lum(seen.bg), lum(seen.rootBg));
    expect(fg).toBeGreaterThanOrEqual(0);
    expect(fg, `暗い環境で地(${bg})より字(${fg})が暗い ── 読めない`).toBeGreaterThan(bg);

    // ② 🔴 目次を押して、F5 ── 白紙にならず、その節に居る(段①では白紙になっていた)
    const target = toc.nth(Math.floor(links * 0.6));
    const id = (await target.getAttribute('href'))!.slice(1);
    await target.click();
    /**
     * 🔴 **押した直後に、その節へ飛んでいる**(2026-09-05 実測で足した)。
     * ⚠ `blob:null/`(`file://` 由来の blob)では Chromium が `<a href="#…">` の navigate を
     *   `Not allowed to load local resource` で止める ── 断片も付かず、見出しへも送られず、
     *   **目次が丸ごと dead click** だった。それを boot script が `pushState` で肩代わりする
     *   (`manual-page.ts`)。F5 の後だけ見ると「印が消えた」に見えるが、本体はここである。
     */
    expect(decodeURIComponent(new URL(win.url()).hash), '目次を押しても節の印が付かない').toBe(
      `#${id}`,
    );
    const jumped = await win.evaluate((wanted) => {
      const el = document.getElementById(wanted);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { top: box.top, h: window.innerHeight };
    }, id);
    expect(jumped, '飛び先が本文に無い').not.toBeNull();
    expect(jumped!.top, '目次を押しても、その節へ飛ばない(dead click)').toBeGreaterThanOrEqual(0);
    expect(jumped!.top).toBeLessThan(jumped!.h);
    await win.reload();
    await expect(win.locator('[data-pkc-region="manual-window-main"]'), 'F5 で白紙になった').toBeVisible();
    expect(await toc.count()).toBe(links);
    expect(decodeURIComponent(new URL(win.url()).hash), 'F5 で節の印が消えた').toBe(`#${id}`);
    const landed = await win.evaluate((wanted) => {
      const el = document.getElementById(wanted);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { top: box.top, h: window.innerHeight };
    }, id);
    expect(landed, '飛び先が本文に無い').not.toBeNull();
    expect(landed!.top, 'F5 のあと、その節に戻っていない').toBeGreaterThanOrEqual(0);
    expect(landed!.top).toBeLessThan(landed!.h);

    // ⑤ もう一度押しても 2 枚目が開かない(同じ窓が前に出る)
    const pagesBefore = context.pages().length;
    await page.bringToFront();
    await clickReal(page, '[data-pkc-action="open-manual-window"]');
    await page.waitForTimeout(700);
    expect(context.pages().length, '2 枚目が開いた').toBe(pagesBefore);

    await win.close();
    expect(errors, `pageerror: ${errors.join(' | ')}`).toEqual([]);
  });
});

/**
 * 🔴 **④ opener が焼いた配色が届く**(#648 段③)。`file://` 由来の `blob:` は
 * `localStorage` に触れないことがある ── そのとき boot script は `<html>` に焼かれた
 * 属性を採る(`portable-manual.ts` の `bakeAppearance`)。観測点は**実際に塗られた地の色**。
 */
test('🔴 持ち歩ける 1 枚で選んだ配色(Dracula)が、blob: の窓の地の色になる (#648 段③)', async ({
  page,
  context,
}) => {
  const tokens = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
  const block = tokens.slice(tokens.indexOf(":root[data-pkc-theme='dracula']"));
  const hex = /--bg:\s*#([0-9a-f]{6})/iu.exec(block)![1]!;
  const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  // 設定画面の実物の <select> で選ぶ(保存の鍵を直に触らない)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="theme-select"]').selectOption('dracula');
  await expect(page.locator('html')).toHaveAttribute('data-pkc-theme', 'dracula');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-manual-window"]');
  const win = await popup;
  await win.waitForURL((u) => u.protocol === 'blob:');
  await expect(win.locator('[data-pkc-region="manual-window-main"]')).toBeVisible();
  const seen = await win.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-pkc-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  expect(seen.theme).toBe('dracula');
  expect(seen.bg, '選んだ配色の地の色になっていない').toBe(rgb);
  await win.close();
});

/**
 * 🔴 **`file://` の 1 枚でも、声の仕上げのワーカー(RNNoise の wasm + opus の書き出し)が動く**(#952 B1)。
 *
 * 可搬の 1 枚は worker を **classic(iife)の blob** に畳み、wasm を `data:` から読む。声の仕上げのワーカーは、最初の依頼で
 * `@shiguredo/rnnoise-wasm` を**動的 import** する(約 4.8MB の JS に wasm が base64 で入っている)── 畳んだ形でその import が
 * 解けるかは、畳んで走らせるまで分からない(普通の配布物では通る)。unit は偽のエンジンしか通さない。
 */
test('🔴 `file://` の可搬 HTML で、「雑音を減らす」が動いて新しい音の添付ができる (#952 B1)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(HTML).href);
  await expect(page.locator('[data-pkc-boot="ready"]'), '`file://` で起動しない').toBeAttached({ timeout: 20_000 });

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '声と雑音.webm',
    mimeType: 'audio/webm',
    buffer: readFileSync('tests/fixtures/media/voice-noisy-7s.webm'),
  });
  await expect(page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]'), '前提: 音が取り込めていない').toHaveCount(1, { timeout: 15_000 });
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  const row = page.locator('[data-pkc-capture]:has([data-pkc-field="capture-name"]:text-is("声と雑音.webm"))');
  await expect(row, '前提: 音の行が一覧に無い').toHaveCount(1, { timeout: 15_000 });

  await pickCaptureTool(page, row, 'denoise');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '可搬の 1 枚で声の仕上げのワーカーが動かない(wasm の動的 import が畳んだ形で解けていない)',
  ).toContainText('雑音を減らした音を作りました', { timeout: 60_000 });
  const made = page.locator('[data-pkc-capture]:has([data-pkc-field="capture-name"]:text-is("声と雑音 (雑音を減らした).webm"))');
  await expect(made, '新しい音の添付が一覧に増えない').toHaveCount(1, { timeout: 15_000 });
  await clickReal(page, made.locator('[data-pkc-field="capture-play"]'));
  const audio = made.locator('audio').first();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { message: '新しい音が読み込めない' }).toBeGreaterThanOrEqual(1);
  expect(await audio.evaluate((a: HTMLAudioElement) => a.duration), '新しい音の長さが元(7 秒)と違う').toBeGreaterThan(6.5);
  // 🔴 1 枚にまとめた版では「歌声と楽器に分ける」は使えない(ONNX Runtime の wasm 14.5MB を畳まない ── #674 / #949)。
  //    押すと取得もワーカーも始めず、理由を言う。⚠ 項目の字にも「このビルドでは使えません」が出ている
  await clickReal(page, row.locator('[data-pkc-action="open-capture-process"]'));
  await expect(page.locator('[data-pkc-action="capture-process"][data-pkc-part="separate-stems"]'), '項目の字に使えない旨が無い').toContainText('このビルドでは使えません');
  await clickReal(page, page.locator('[data-pkc-action="capture-process"][data-pkc-part="separate-stems"]'));
  await expect(page.locator('[data-pkc-region="status"]'), '使えない理由を言わない').toContainText('歌声と楽器に分ける機能は使えません', { timeout: 15_000 });
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **選んだ N 件だけの PKC3 入り HTML**(#1038 A2)。
 *
 * ① 3 件のうち 2 件を選び、「書き出す ▾」→「PKC3 入り HTML(選んだ 2 件)」で落とす
 * ② その HTML を `file://` で開くと、選んだ題名だけが一覧に在り、選んでいない題名が無い
 * ③ 開いた先で足して保存できる(続きが書ける)
 * ④ 本体の「取り込む」で戻せる(選んだ 2 件だけが増える)
 * ⚠ 選んでいない本文の字は DB 画像(base64)の中なので file の素の字では見えない ── ②の「一覧に無い」と、
 *   `tests/adapter/storage-worker-image-subset.test.ts`(画像の bytes に字が残らない)で守る。
 */
test('🔴 選んだ N 件だけの PKC3 入り HTML が開けて、編集でき、取り込み直せる (#1038 A2)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });

  const make = async (p: import('@playwright/test').Page, name: string, body: string): Promise<void> => {
    await createEntry(p, 'text');
    await p.locator('[data-pkc-field="editor-title"]').fill(name);
    await p.locator('[data-pkc-field="editor-body"]').fill(body);
    await clickReal(p, '[data-pkc-action="commit-edit"]');
    await p.waitForSelector('[data-pkc-action="start-edit"]');
  };
  await make(page, 'AlphaNote', 'alpha-body-unique');
  await make(page, 'BetaNote', 'beta-body-unique');
  await make(page, 'GammaNote', 'gamma-body-unique');
  const table = page.locator('[data-pkc-region="filer-table"]');
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(3);

  await table.locator('tbody tr:has-text("AlphaNote")').click();
  await table.locator('tbody tr:has-text("GammaNote")').click({ modifiers: ['ControlOrMeta'] });
  await clickReal(page, '[data-pkc-field="bulk-export-menu"]');
  await expect(page.locator('[data-pkc-action="export-selection-portable"]')).toContainText(
    'PKC3 入り HTML(選んだ 2 件)',
  );
  const dl = page.waitForEvent('download', { timeout: 60_000 });
  await clickReal(page, '[data-pkc-action="export-selection-portable"]');
  const out = join(mkdtempSync(join(tmpdir(), 'pkc3-sub-')), 'subset.pkc3.html');
  await (await dl).saveAs(out);
  expect(readFileSync(out, 'utf-8').length, '書き出した 1 枚が小さすぎる(アプリが入っていない)').toBeGreaterThan(3_000_000);

  // ② 開く ── 選んだ題名だけ
  const carried = await page.context().newPage();
  await carried.goto(pathToFileURL(out).href);
  await expect(carried.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  const cTable = carried.locator('[data-pkc-region="filer-table"]');
  await expect(cTable, '選んだ題名が入っていない').toContainText('AlphaNote', { timeout: 15_000 });
  await expect(cTable).toContainText('GammaNote');
  await expect(cTable, '選んでいない題名が入っている').not.toContainText('BetaNote');
  await expect(cTable.locator('tbody tr'), '一覧の行が選んだ 2 件ではない').toHaveCount(2);
  // 本文も選んだ分だけ読める
  await cTable.locator('tbody tr:has-text("AlphaNote")').click();
  await expect(carried.locator('[data-pkc-field="detail-body"]')).toContainText('alpha-body-unique');

  // ③ 編集して保存できる
  await createEntry(carried, 'text');
  await carried.locator('[data-pkc-field="editor-title"]').fill('先で足した');
  await clickReal(carried, '[data-pkc-action="commit-edit"]');
  await expect(cTable).toContainText('先で足した', { timeout: 10_000 });
  await carried.close();

  // ④ 本体へ取り込み直す ── 選んだ 2 件だけが増える(3 + 2)
  await page.setInputFiles('[data-pkc-field="import-input"]', out);
  await answerAppDialog(page, 'ok');
  await expect(rows, '取り込み直すと選んだ 2 件だけが増える').toHaveCount(5, { timeout: 15_000 });
  await expect(table.locator('tbody tr:has-text("BetaNote")'), 'Beta が増えた').toHaveCount(1);
  await expect(table.locator('tbody tr:has-text("AlphaNote")')).toHaveCount(2);
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
