/**
 * 🔴 **スクショの貼付・ファイルの drop**(#250。user 指示 2026-08-18
 * 「PKC3 でスクショ貼付の導線がない。PKC2 と同様以上に実装してください」)。
 *
 * 🔴 **unit(happy-dom)では届かない層が 3 つある**。ここはその 3 つを見る:
 *  ① **本物の `ClipboardEvent` / `DragEvent`**(happy-dom に実体が無い ──
 *     unit の fake は「こちらが渡した形」しか試していない)
 *  ② **`document.execCommand('insertText')`**(happy-dom には無く、unit は
 *     必ず fallback の `value` 直代入を通る = **本命の経路を 1 度も走らせていない**)
 *  ③ **実 IDB + 実 sqlite の資産**(貼った bytes が本当に取り出せて、
 *     確定した本文の中で**画像として描かれる**か)
 *
 * ⚠ 観測点は「参照の字が入ったか」で止めない ── 字だけなら壊れた key でも入る。
 *   **確定後に `<img>` が実寸を持つ**ところまで見る(§4「届いた証拠」)。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  clickReal,
  createEntry,
  collectPageErrors,
  expectImageRendered,
  gotoApp,
  useSplitEditor,
} from './helpers';

// 1x1 PNG(67 bytes)── attach.smoke.spec.ts と同じ絵
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/**
 * 64x64 の PNG(136 bytes)。⚠ **押せる大きさが要る**ところで使う ──
 * 1x1 は版面に出ても `click` が「viewport の外」になり、実際にそう落ちた。
 */
const PNG_64_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsAt2/VMYxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywI8cEE8aU9dHgAAAABJRU5ErkJggg==';

/**
 * 本物の event を、**その要素の上で**発火させる。
 * ⚠ `File` はページの中で作る(node から渡した Buffer は `File` にならない)。
 */
async function sendFiles(
  page: Page,
  selector: string,
  kind: 'paste' | 'drop',
  files: { name: string; type: string; b64: string }[],
): Promise<void> {
  await page.evaluate(
    ({ selector, kind, files }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`要素が無い: ${selector}`);
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      // ⚠ 貼付は**焦点のある欄**へ入る ── 実際の user と同じく先に焦点を置く
      if (el instanceof HTMLElement) el.focus();
      const ev =
        kind === 'paste'
          ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
          : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(ev);
    },
    { selector, kind, files },
  );
}

/** 編集中の 1 面(既定 = live)を開いて、行の入力欄を出す。 */
async function openLiveRow(page: Page): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await expect(
    live.locator('[data-pkc-field="row-source"]'),
    '空のノートで行が開かない(貼る先が無い)',
  ).toBeVisible();
}

test('🔴 編集中の本文に貼ると、確定後に画像として出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  const row = page.locator('[data-pkc-region="editor-live"] [data-pkc-field="row-source"]');
  await sendFiles(page, '[data-pkc-region="editor-live"] [data-pkc-field="row-source"]', 'paste', [
    { name: 'clip.png', type: 'image/png', b64: PNG_1X1_B64 },
  ]);

  // ① 参照が**カーソルの位置に**入った(名前は貼った日時から作る)
  await expect(row, '貼った参照が本文に入っていない').toHaveValue(
    /!\[スクリーンショット-\d{4}-\d{2}-\d{2}-\d{6}\.png\]\(asset:[^)]+\)/,
    { timeout: 15_000 },
  );

  // ② 🔴 **ノートは増えていない**(編集中に CREATE_ENTRY を撃つと黙殺される ──
  //    bytes だけ書かれて参照が消える形になっていないことを、件数で確かめる)
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(1);

  // ③ 🔴 **取り消せる**(お知らせとマニュアルが約束している ── `Ctrl+Z`)
  //    ⚠ unit では確かめられない(happy-dom は `execCommand` を持たないので
  //    fallback を通り、ブラウザの取り消し履歴に載らない)
  await page.keyboard.press('Control+z');
  await expect(row, '取り消しで戻っていない(お知らせの約束が嘘になる)').not.toHaveValue(
    /asset:/,
  );
  await page.keyboard.press('Control+y');
  await expect(row, 'やり直しで戻せない').toHaveValue(/asset:/);

  // ④ 確定すると、その参照が**実際の画像として描かれる**(key が本物である証拠)
  await page.keyboard.press('Tab');
  await expectImageRendered(page, 'img[data-pkc-asset-key]');

  expect(errors).toEqual([]);
});

/**
 * 🔑 **2 枚同時に貼ると、2 枚とも順番どおり入る**(#250)。
 *
 * ⚠ PKC2 は先頭 1 枚だけ拾っていた。⚠ 順番は unit では測れない ──
 * happy-dom の fallback は caret を進めるが、実ブラウザは `execCommand` が進める
 * ので、**入る順は実ブラウザでしか確かめられない**。
 */
test('🔴 2 枚まとめて貼ると、2 枚とも順番どおり入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  const row = page.locator('[data-pkc-region="editor-live"] [data-pkc-field="row-source"]');
  // ⚠ **種類を変える**(名前は貼った日時から作るので、同じ秒に貼った 2 枚は
  //   `.png` どうしだと**同じ名前**になり、入る順を名前で言えない)
  await sendFiles(page, '[data-pkc-region="editor-live"] [data-pkc-field="row-source"]', 'paste', [
    { name: 'a.png', type: 'image/png', b64: PNG_1X1_B64 },
    { name: 'b.webp', type: 'image/webp', b64: PNG_64_B64 },
  ]);
  await expect(row).toHaveValue(/asset:[\s\S]*asset:/, { timeout: 15_000 });

  const keys = await row.evaluate((el) =>
    [...(el as HTMLTextAreaElement).value.matchAll(/asset:([^)]+)\)/g)].map((m) => m[1]!),
  );
  expect(keys, '2 枚入っていない').toHaveLength(2);
  expect(keys[0], '同じ鍵が 2 つ(別の絵なのに畳まれた)').not.toBe(keys[1]);
  // 🔑 **1 枚目が上**(caret が進んでいないと逆順に入る)
  const alts = await row.evaluate((el) =>
    [...(el as HTMLTextAreaElement).value.matchAll(/!\[([^\]]+)\]/g)].map((m) => m[1]!),
  );
  expect(alts, '名前が 2 つ入っていない').toHaveLength(2);
  expect(alts[0], `入る順が逆(${alts.join(' → ')})`).toMatch(/\.png$/);
  expect(alts[1], `入る順が逆(${alts.join(' → ')})`).toMatch(/\.webp$/);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **待っている間に焦点が移っても、差し先を間違えない**(#250)。
 *
 * ⚠ unit では**この行を 1 度も走らせられない** ── happy-dom に
 * `document.execCommand` が無く、必ず fallback の `value` 直代入を通るので、
 * 焦点の有無が結果を変えない(変異試験で `into.focus()` の削除が **SURVIVED**
 * した ── CLAUDE.md §2「弱いのではなく走っていない」)。
 * 🔑 だから**実ブラウザで、焦点を実際に奪ってから**確かめる。
 *
 * ⚠ **2 列の面で測る。** 1 面(live)は別の欄を触った瞬間に行を確定して閉じるので、
 * 「欄は生きているのに焦点だけ外れた」という**この次元が作れない**
 * (そちらは下の「閉じたら添付へ回す」が受け持つ)。
 */
test('🔴 貼ったあとに焦点が移っても、本文の欄に入る(2 列)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  const sel = '[data-pkc-field="editor-body"]';
  await expect(page.locator(sel)).toBeVisible();
  await sendFiles(page, sel, 'paste', [
    { name: 'clip.png', type: 'image/png', b64: PNG_1X1_B64 },
  ]);
  // ⚠ 資産を置いている**最中に**焦点を奪う(user が絞り込み欄を触った、の再現)
  // 🔴 **まだ差し込まれていないこと**を同じ evaluate の中で確かめる ── put が
  //    先に終わっていたら「焦点が移った後に差し込む」次元を**測っていない**
  //    (§2「弱いのではなく走っていない」の、smoke 版)
  await page.evaluate((sel) => {
    const ta = document.querySelector<HTMLTextAreaElement>(sel);
    if (ta?.value.includes('asset:'))
      throw new Error('この次元を測れていない(貼付が先に終わった)');
    const other = document.querySelector<HTMLElement>('[data-pkc-field="entry-filter"]');
    if (!other) throw new Error('焦点を移す先が無い(この次元を測れていない)');
    other.focus();
  }, sel);
  // 前提: **欄は生きている**(2 列は焦点が外れても閉じない ── この次元の条件)
  await expect(page.locator(sel), '前提: 編集欄が閉じてしまった').toBeVisible();

  await expect(page.locator(sel), '本文の欄に入っていない(焦点を戻していない)').toHaveValue(
    /!\[スクリーンショット-[\d-]+\.png\]\(asset:[^)]+\)/,
    { timeout: 15_000 },
  );
  // ⚠ **絞り込み欄に入っていない**(入ると検索語が壊れる ── 静かな事故)
  await expect(page.locator('[data-pkc-field="entry-filter"]')).toHaveValue('');

  expect(errors).toEqual([]);
});

/**
 * 🔴 **貼っている最中に差し先が消えたら、黙って終わらない**(#250)。
 *
 * 1 面(既定)は**別の欄を触った瞬間に行を確定して閉じる** ── そこで差し先が
 * 無くなる。⚠ ノートの編集は**まだ続いている**ので、添付へ回すこともできない
 * (`CREATE_ENTRY` は `phase !== 'ready'` を黙殺する = bytes だけ残る)。
 * 🔑 やり直せる形で断る ── クリップボードは残っているので、本当にやり直せる。
 */
test('🔴 貼っている最中に行が閉じたら、やり直せる形で断る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  await sendFiles(page, '[data-pkc-region="editor-live"] [data-pkc-field="row-source"]', 'paste', [
    { name: 'clip.png', type: 'image/png', b64: PNG_1X1_B64 },
  ]);
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
    // ⚠ 差し込みが先に終わっていたら、この test は「行が閉じた」次元を測っていない
    if (ta?.value.includes('asset:'))
      throw new Error('この次元を測れていない(貼付が先に終わった)');
    const other = document.querySelector<HTMLElement>('[data-pkc-field="entry-filter"]');
    if (!other) throw new Error('焦点を移す先が無い(この次元を測れていない)');
    other.focus();
  });

  // 🔑 黙って消えない ── 理由と次の一手が画面に出る
  await expect(page.locator('[data-pkc-region="status"]'), '断りが画面に出ていない').toContainText(
    'もう一度貼ってください',
    { timeout: 15_000 },
  );

  expect(errors).toEqual([]);
});

/**
 * 🔴 **貼った画像の塊を押して閉じても、消えない**(#250 で判明・同時に直した)。
 *
 * ⚠ これは貼付の bug ではない ── 1 面のライブエディタは**行を閉じるときに
 * 塊を原文の HTML から作り直す**ので、`<img>` が `src` の無い空の枠に戻っていた
 * (本文は変わらないので follower も来ず、**画面から画像が消えたまま**)。
 * 🔑 実測(直す前):開いて閉じた直後の `src` は **null**。
 *
 * ⚠ **借り直しが積もらない**ことも同時に見る ── 差し直すだけなら、外れた
 * `<img>` のぶんが返らずに常駐が増える(不可侵指示 2026-07-27「即破棄」)。
 */
test('🔴 画像の行を開いて閉じても、画像は消えず URL も積もらない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __urls?: { made: number; freed: number } };
    w.__urls = { made: 0, freed: 0 };
    const make = URL.createObjectURL.bind(URL);
    const free = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource): string => {
      w.__urls!.made += 1;
      return make(b);
    };
    URL.revokeObjectURL = (u: string): void => {
      w.__urls!.freed += 1;
      free(u);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  const live = page.locator('[data-pkc-region="editor-live"]');
  // ⚠ 前後に段落を置く ── 画像だけの本文だと版面の上端に貼りつき、
  //   `click` が「viewport の外」になる(1 巡目で実際に落ちた)
  await live.locator('[data-pkc-field="row-source"]').fill('上の段落\n\n');
  await sendFiles(page, '[data-pkc-region="editor-live"] [data-pkc-field="row-source"]', 'paste', [
    { name: 'clip.png', type: 'image/png', b64: PNG_64_B64 },
  ]);
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveValue(/asset:/, {
    timeout: 15_000,
  });
  await page.keyboard.press('Tab');
  const img = live.locator('img[data-pkc-asset-key]');
  await expect(img, '前提: 貼った画像が出ていない').toHaveAttribute('src', /^blob:/, {
    timeout: 15_000,
  });

  const ROUNDS = 3;
  for (let i = 0; i < ROUNDS; i += 1) {
    // ⚠ **repo の実クリック**を使う(`locator.click` は同じ座標でも
    //   「viewport の外」と断ることがあり、10 回中 9 回落ちた ── 版面は
    //   1440x900、絵は (286,178) 64x64 で、明らかに中に在る)
    await clickReal(page, '[data-pkc-region="editor-live"] img[data-pkc-asset-key]');
    // 前提: その塊が原文の入力欄に化けた(この次元を測れている)
    await expect(
      live.locator('[data-pkc-field="row-source"]'),
      `${i}: 画像の行が開かない`,
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(img, `${i}: 閉じたら画像が消えた`).toHaveAttribute('src', /^blob:/, {
      timeout: 10_000,
    });
  }

  // 🔑 借りっぱなしが積もらない(画面に出ている 1 本ぶんだけ残る)
  const urls = await page.evaluate(
    () => (window as unknown as { __urls: { made: number; freed: number } }).__urls,
  );
  expect(urls.made, '1 本も借りていない(計器が死んでいる)').toBeGreaterThan(ROUNDS);
  expect(
    urls.made - urls.freed,
    `借りたまま ${urls.made - urls.freed} 本残っている(made=${urls.made} freed=${urls.freed})`,
  ).toBeLessThanOrEqual(2);

  expect(errors).toEqual([]);
});

test('🔴 編集していないときに貼ると、添付のノートになる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await sendFiles(page, '[data-pkc-region="entry-list"]', 'paste', [
    { name: 'clip.png', type: 'image/png', b64: PNG_1X1_B64 },
  ]);

  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows, '添付のノートが出来ていない').toHaveCount(1, { timeout: 15_000 });
  await expect(rows.first()).toHaveAttribute('data-pkc-archetype', 'attachment');
  await expectImageRendered(page, '[data-pkc-field="attachment-media"]');

  expect(errors).toEqual([]);
});

test('🔴 編集中の本文へ落とした画像も、そのまま入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  const sel = '[data-pkc-region="editor-live"] [data-pkc-field="row-source"]';
  await sendFiles(page, sel, 'drop', [
    { name: 'drop.png', type: 'image/png', b64: PNG_1X1_B64 },
  ]);

  await expect(page.locator(sel), '落とした画像が本文に入っていない').toHaveValue(
    /!\[スクリーンショット-[\d-]+\.png\]\(asset:[^)]+\)/,
    { timeout: 15_000 },
  );
  // ⚠ **画面がその file へ遷移していない**(既定を止めていないと本文ごと消える)
  expect(page.url(), 'drop で画面が file へ遷移した').not.toContain('drop.png');

  expect(errors).toEqual([]);
});
