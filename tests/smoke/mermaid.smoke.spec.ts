import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';
import { MERMAID_FORMS } from '../fixtures/mermaid-forms';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * P8 段③: 図は **PNG 1 枚**で置く。
 *
 * > user 指示 2026-08-03(不可侵)「mermaid 図のエクスポートをさせるとき以外は
 * > PNG ラスタをキャッシュして、GPU レンダリングで表示して欲しい」
 *
 * 🔴 PKC3 には**描く側が存在しなかった**(placeholder を出すだけで、依存も無し)。
 * ⚠ 観測点は「図が出た」ではなく「**何が DOM に置かれたか**」── SVG を置く実装でも
 * 「図が出た」は通ってしまう。
 */
test('🔴 図は PNG の img で置かれ、SVG を DOM に残さない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図のノート');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('# 図\n\n```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n');

  // ① 編集中のプレビューにも出る(保存するまで図が見えない、を落とす)
  const inPreview = page.locator('[data-pkc-region="editor-preview"] [data-pkc-mermaid-src]');
  await expect(inPreview).toHaveAttribute('data-pkc-mermaid-state', 'ready', {
    timeout: 30000,
  });

  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  // ② 🔴 置かれているのは **img**。しかも中身は PNG
  const placed = await host.evaluate((h) => {
    const img = h.querySelector('img');
    return {
      tag: h.firstElementChild?.tagName ?? 'NONE',
      src: img?.getAttribute('src')?.slice(0, 5) ?? '',
      natural: img?.naturalWidth ?? 0,
    };
  });
  expect(placed.tag, 'img ではないものが置かれている').toBe('IMG');
  expect(placed.src, 'blob の ObjectURL ではない').toBe('blob:');
  expect(placed.natural, '画像が読めていない').toBeGreaterThan(0);

  // ③ 🔴 **図の SVG を DOM に残さない**(これが「スクロールが GPU に乗る」の実体)
  //
  // ⚠ 以前は `querySelectorAll('svg').length === 0` と書いていたが、P9 段③ で
  //    **UI の図案が単色 SVG になった**(絵文字は多色で `color` を無視し、
  //    書体ごとに大きさが変わるため。user 指示 2026-08-03 の 2 件に反していた)。
  //    「1 つも無い」では図案まで落ちてしまうので、**在ってよい場所を名指しする**形へ
  //    書き換えた ── これは弱めているのではなく、**強めている**:
  //    「図案の中に無い `<svg>` は 1 つも許さない」なので、mermaid が SVG を
  //    残した瞬間に落ちる(図の器の中でも、本文でも、プレビューでも)。
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('svg')]
        .filter((s) => !s.closest('[data-pkc-icon]'))
        .map((s) => s.parentElement?.getAttribute('data-pkc-field') ?? s.parentElement?.tagName),
    ),
    '図案の外に SVG が残っている(図が SVG で置かれている?)',
  ).toEqual([]);

  // ④ 🔴 焼いた画素が表示幅以上(Retina でボケない ── 等倍で焼く実装を落とす)
  const sharp = await host.evaluate((h) => {
    const img = h.querySelector('img')!;
    return img.naturalWidth / Math.max(1, img.clientWidth) - window.devicePixelRatio;
  });
  expect(sharp, '表示幅に対して焼いた画素が足りない(ボケる)').toBeGreaterThan(-0.05);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑦: **図を保存する**。
 *
 * 🔴 段③ の指示は「エクスポート**させるとき以外は** PNG」── つまり書き出しの導線が
 * 在る前提だったが、`renderToSvg()` は書かれたまま**呼び出し元が 0 件**だった。
 *
 * ⚠ 観測点を「ダウンロードが起きた」で止めない ── **中身がベクタか**まで見る。
 * PNG を落とす実装でもダウンロードは起きる(指示に反しているのに緑になる)。
 */
test('🔴 図を保存すると、画面の PNG ではなくベクタが落ちる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図のノート');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  // ① 導線が**図の上に見えている**(hover しないと存在すら分からない、を落とす)。
  // 🔴 `toBeVisible()` **だけでは空振りする** ── playwright は bounding box と
  // `visibility` を見るが **opacity は見ない**ので、`opacity: 0` にする変異が
  // 生き残った(実測)。⚠ ポインタを外してから測る(直前の click が hover を
  // 残していると、hover 前提の実装でも通ってしまう ── 救い手が変わるだけ)
  const save = host.locator('[data-pkc-field="diagram-save"]');
  await page.mouse.move(0, 0);
  await expect(save).toBeVisible();
  const shown = await save.evaluate((el) => ({
    opacity: Number(getComputedStyle(el).opacity),
    bg: getComputedStyle(el).backgroundColor,
  }));
  expect(shown.opacity, 'hover しないと見えない導線になっている').toBeGreaterThan(0.2);
  // ⚠ 図の上に浮くので**地が透けてはいけない**(図の線と重なって文字が読めない)
  expect(shown.bg, '導線の地が透けている').not.toMatch(/,\s*0\)$/);

  // ② 🔴 押すと落ちてくる
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickReal(page, '[data-pkc-field="diagram-save"]'),
  ]);

  // ③ 🔴 **中身がベクタである**。⚠ ファイル名は観測点にしない ── この headless
  // Chromium は**非 ASCII の `<a download>` 名を丸ごと捨てて `"download"` にする**。
  // 名前は「図1」を含むので必ず捨てられる ── 名前の規則は unit
  // (`tests/adapter/export-diagram.test.ts`)が見ている
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  expect(text.slice(0, 200), 'SVG ではない(PNG を落としている可能性)').toContain('<svg');
  // ④ 🔴 **その図**が落ちている(空の svg 枠でも `<svg` は通る)
  expect(text, '図の中身が入っていない').toContain('始め');
  expect(text, '図の中身が入っていない').toContain('終わり');

  // ⑤ 画面のほうは PNG のまま(書き出しのために SVG へ差し替わっていない)
  //    ⚠ 図案(`data-pkc-icon`)の SVG は別物なので除く ── 上の ③ と同じ規則
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('svg')].filter((s) => !s.closest('[data-pkc-icon]')).length,
    ),
    '書き出しのあと画面に SVG が残っている',
  ).toBe(0);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑬: 🔴 **図の色が配色に従う**。
 *
 * 🔴 直す前に測った(焼いた PNG の平均輝度。同じ図・同じ幅):
 * ```
 * light      231.1      dark    231.1      dracula 231.1
 * nord       231.1      terminal 231.1
 * ```
 * 鍵にテーマは入っていたので**焼き直しは走っていた**が、`mermaid.initialize()` に
 * 配色を渡していなかったので **絵が全部同じ** ── ダーク系 5 テーマで、暗い地に
 * 白い図が 1 枚だけ浮いていた。さらに配色を切り替えても `<img src>` が変わらず、
 * `docs/manual.md` の「配色を変えると焼き直します」は**両方向とも嘘**だった。
 *
 * ⚠ 観測点は **焼いた画素**。設定の中身は `tests/adapter/mermaid-palette.test.ts`
 * が見る ── 片端だけだと「設定は渡っているが絵は変わらない」を見逃す。
 */
test('🔴 配色を変えると図も焼き直り、暗い配色では図も暗い', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図の色');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  const img = host.locator('img');

  /** 焼いた PNG の平均輝度(不透明な画素だけ)。 */
  const luma = (): Promise<number> =>
    img.evaluate(
      (el: HTMLImageElement) =>
        new Promise<number>((resolve) => {
          const go = (): void => {
            const c = document.createElement('canvas');
            c.width = el.naturalWidth;
            c.height = el.naturalHeight;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(el, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let sum = 0;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i + 3]! < 128) continue;
              n++;
              sum += (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
            }
            resolve(n === 0 ? -1 : sum / n);
          };
          if (el.complete && el.naturalWidth > 0) go();
          else el.onload = go;
        }),
    );

  const srcOf = (): Promise<string> => img.evaluate((el) => el.getAttribute('src') ?? '');

  const light = await luma();
  const lightSrc = await srcOf();
  expect(light, '明るい配色なのに図が暗い').toBeGreaterThan(140);

  // 🔴 設定から配色を変える(実際の導線)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="theme-select"]').selectOption('dark');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  // 焼き直しは非同期 ── src が変わるまで待つ(固定 sleep を積まない)
  await expect
    .poll(async () => (await srcOf()) !== lightSrc, { timeout: 30000 })
    .toBe(true);
  const dark = await luma();
  expect(dark, '暗い配色にしたのに図が明るいまま').toBeLessThan(120);

  // ⚠ **戻せる**ことも見る(片道だけ直っている実装を落とす)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="theme-select"]').selectOption('light');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect.poll(async () => await luma(), { timeout: 30000 }).toBeGreaterThan(140);

  expect(errors).toEqual([]);
});

/** 器(875px)より**確実に大きい**図。⚠ 節点を横に並べて実寸を稼ぐ。 */
const WIDE_DIAGRAM =
  '```mermaid\ngraph LR\n' +
  Array.from(
    { length: 12 },
    (_, i) => `  N${i}["とても長い節点の名前 ${i}"]-->N${i + 1}["つぎの節点 ${i + 1}"]`,
  ).join('\n') +
  '\n```\n';

/**
 * P8 段⑲: 🔴 **器より大きい図が潰れない**。
 *
 * 🔴 直す前、図を使う spec は**全部が 2 節点の `graph TD A-->B`**(実寸 82px)で、
 * 器(875px)より小さかった ── つまり「**器より大きい図**」は全 fixture で
 * ゼロ件の次元 = 測っていない次元だった(CLAUDE.md の規律)。
 * 実測: 焼き幅の元を「親」から「器」へ戻すと **880px の図が 256px** で焼かれ、
 * ラベルが読めなくなるが、**unit 1393 件 + smoke 47 件が全部緑**のままだった。
 */
test('🔴 器より大きい図は、器の幅いっぱいまで使って焼かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('大きい図');
  await page.locator('[data-pkc-field="editor-body"]').fill(WIDE_DIAGRAM);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  const m = await host.evaluate((h) => {
    const img = h.querySelector('img')!;
    return {
      placed: img.clientWidth,
      natural: img.naturalWidth,
      box: h.parentElement!.clientWidth,
      dpr: devicePixelRatio,
    };
  });

  // ① 🔴 **fixture が前提を満たす**(空振り防止)── 図が器より小さいと
  //    以下の assert は「小さいまま置いた」実装でも自明に通る
  expect(m.box, '器が狭すぎて観測にならない').toBeGreaterThan(600);
  expect(
    m.natural / m.dpr,
    `図が器より小さい(${Math.round(m.natural / m.dpr)} / 器 ${m.box})── この次元を測れていない`,
  ).toBeGreaterThanOrEqual(m.box * 0.9);

  // ② 器の幅いっぱいまで使う(縮めて焼いていない)
  expect(m.placed, `大きい図が縮んで置かれた(${m.placed} / 器 ${m.box})`).toBeGreaterThanOrEqual(
    m.box * 0.9,
  );
  // ③ 焼いた画素も器ぶんある(置き幅だけ合わせて中身が粗い、を落とす)
  expect(
    m.natural,
    `焼いた画素が足りない(${m.natural} / 要 ${Math.round(m.box * m.dpr * 0.9)})`,
  ).toBeGreaterThanOrEqual(m.box * m.dpr * 0.9);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑲: 🔴 **キャッシュの上限が実際に効く**。
 *
 * 🔴 段⑰ が置いた 32MB の上限は、**判定の純関数(`planEviction`)だけ**が
 * test に守られていて、それを**起動する 1 行**(`void evictDiagramCache()`)は
 * 1 度も実行されていなかった ── 消しても全部緑になる。上限が効かないと、
 * 編集プレビューで図を打つたびに「途中の原文」が別鍵で焼かれて永久に残り、
 * 同一 origin を食い潰す。巻き添えは添付(`pkc3-assets`)と OPFS の sqlite、
 * つまり **user のデータ本体**である。
 *
 * ⚠ 上限だけでなく**下限**も見る ── 全部消す実装も「上限を守った」ことになる。
 */
test('🔴 図キャッシュが上限を超えると、古いものから落ちる(全部は消さない)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  // 上限(32MB)を超えるまで**直に**詰める。⚠ 鍵は実装と同じ形でなくてよい
  //    ── 追い出しは `getAll` した行の `at` / `size` だけを見る
  const CAP = 32 * 1024 * 1024;
  const seeded = await page.evaluate(async (cap) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('pkc3-diagram-cache', 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('png')) r.result.createObjectStore('png');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const each = 5 * 1024 * 1024;
    const n = Math.ceil((cap * 1.3) / each);
    for (let i = 0; i < n; i++) {
      const png = new Blob([new Uint8Array(each)], { type: 'image/png' });
      await new Promise<void>((res, rej) => {
        const t = db.transaction('png', 'readwrite');
        // `at` は古い順(i が小さいほど古い)
        const q = t.objectStore('png').put({ png, at: 1000 + i, size: each }, `seed-${i}`);
        q.onsuccess = () => res();
        q.onerror = () => rej(q.error);
      });
    }
    db.close();
    return { count: n, bytes: n * each };
  }, CAP);

  // 🔴 **前提が満たされている**(空振り防止)── 上限を超えていなければ
  //    「1 件も落ちない」が正しい振る舞いになってしまう
  expect(seeded.bytes, '詰めた量が上限を超えていない').toBeGreaterThan(CAP);

  // 図を 1 枚焼く = 追い出しの起動点を通る
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('```mermaid\ngraph TD\n  A-->B\n```\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]'),
  ).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  const after = await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((res, rej) => {
            const r = indexedDB.open('pkc3-diagram-cache', 1);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          const rows = await new Promise<{ size?: number }[]>((res, rej) => {
            const q = db.transaction('png', 'readonly').objectStore('png').getAll();
            q.onsuccess = () => res(q.result as { size?: number }[]);
            q.onerror = () => rej(q.error);
          });
          db.close();
          return rows.reduce((n, r) => n + (r.size ?? 0), 0);
        }),
      { timeout: 20000, message: '追い出しが走っていない(上限が効いていない)' },
    )
    .toBeLessThanOrEqual(CAP)
    .then(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open('pkc3-diagram-cache', 1);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const keys = await new Promise<IDBValidKey[]>((res, rej) => {
          const q = db.transaction('png', 'readonly').objectStore('png').getAllKeys();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        db.close();
        return keys.length;
      }),
    );

  // ⚠ **下限** ── 全部消す実装も「上限を守った」ことになる。いま焼いた 1 枚は残る
  expect(after, 'キャッシュを空にしている(毎回焼き直しになる)').toBeGreaterThan(0);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑳: 🔴 **描いた下に原文が丸ごと出ない**。
 *
 * 🔴 直す前は、焼いた PNG の**すぐ下に mermaid のソースが `<pre>` で全文**
 * 並んでいた(csv も表と生 CSV が二重)。`markdown-render.ts` は隠す前提で
 * `pkc-render-source` を吐いていたのに、**当てる CSS が 1 行も無かった**。
 * ⚠ 観測点は「規則が在るか」ではなく **実際に見えているか**(`clientHeight`)。
 */
test('🔴 図と表は、描画の下に原文を出さない(切替で入れ替わる)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('二重に出ない');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('```mermaid\ngraph TD\n  A-->B\n```\n\n```csv\nりんご,120\nみかん,80\n```\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const body = page.locator('[data-pkc-field="detail-body"]');
  await expect(body.locator('[data-pkc-mermaid-src]')).toHaveAttribute(
    'data-pkc-mermaid-state',
    'ready',
    { timeout: 30000 },
  );

  const seen = await body.evaluate((el) => {
    // ⚠ **「箱が在る」では見た目を測れない** ── 切替は 1x1 の透明な input で
    //    置いてある(`display:none` にするとキーボードで到達できなくなるため)。
    //    実際に目に入るか、で判定する
    const vis = (n: Element): boolean => {
      const cs = getComputedStyle(n);
      return (n as HTMLElement).clientHeight > 2 && cs.opacity !== '0' && cs.visibility !== 'hidden';
    };
    return {
      // 空振り防止: 原文の要素が**実在する**(消えていたら以下は自明に通る)
      sources: el.querySelectorAll('.pkc-render-source').length,
      visibleSources: [...el.querySelectorAll('.pkc-render-source')].filter(vis).length,
      // 図は焼けたので、器の中の原文 `<pre>` も見えない
      visibleMermaidSrc: [...el.querySelectorAll('.pkc-mermaid-source')].filter(vis).length,
      // 描画のほうは見えている
      visibleSlots: [...el.querySelectorAll('.pkc-render-slot')].filter(vis).length,
      // 素のチェック欄や `‹/›` が地の文に浮いていない(切替は隠してある)
      visibleToggleInputs: [...el.querySelectorAll('.pkc-render-toggle-input')].filter(vis).length,
    };
  });
  expect(seen.sources, '原文の要素が出ていない(この次元を測れていない)').toBeGreaterThan(0);
  expect(seen.visibleSources, '描画の下に原文が丸ごと出ている').toBe(0);
  expect(seen.visibleMermaidSrc, '焼けた図の下に原文が出ている').toBe(0);
  expect(seen.visibleSlots, '描画が出ていない').toBeGreaterThan(0);
  expect(seen.visibleToggleInputs, '素のチェック欄が本文に浮いている').toBe(0);

  // 🔴 切替を入れると**入れ替わる**(隠しただけで到達できない、を落とす)。
  //    ⚠ 押すのは **label**(input は 1x1 の透明 + `pointer-events: none`)──
  //      user が実際に触るのもこちらである
  await body.locator('.pkc-render-toggle').first().click();
  const after = await body.evaluate((el) => {
    const vis = (n: Element): boolean => (n as HTMLElement).clientHeight > 2;
    // 切替を持つ塊(csv 側)だけを見る ── 図の器には切替が無い
    const block = el.querySelector('.pkc-md-block:has(> .pkc-render-toggle)')!;
    return {
      checked: block.querySelector<HTMLInputElement>(':scope > .pkc-render-toggle-input')!.checked,
      src: [...block.querySelectorAll(':scope > .pkc-render-source')].filter(vis).length,
      slot: [...block.querySelectorAll(':scope > .pkc-render-slot')].filter(vis).length,
    };
  });
  expect(after.checked, '切替が効いていない').toBe(true);
  expect(after.src, '切替てもソースが出ない(到達できない)').toBe(1);
  expect(after.slot, '切替たのに描画が残っている').toBe(0);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **チェック欄は「保存できる面」でだけ押せる**(#277。2026-08-19)。
 *
 * ⚠ この test は **2026-08-19 に主張を裏返した**。以前の主張は P8 段⑳ の
 *   「**押せない**(押しても保存されないため)」で、それは正しかった ──
 *   その前は `disabled` が無く、押すとチェックが付くのに本文は 1 文字も変わらず、
 *   移動 / 追記 / 再読込で全部外れた(「チェックしたのに消えた」)。
 * 🔑 #277 で**保存する経路ができた**ので、押せない理由が消えた。
 *   ただし**理由が消えたのは読む面だけ**である ── だから主張は
 *   「押せる」ではなく「**保存できる面でだけ押せる**」になる。
 *
 * ⚠ **主張の向きを変えたら、検査も別物として書き直す**(CLAUDE.md §1)──
 *   「押せる」だけを見ると、**押しても保存されない**古い壊れ方に戻っても通る。
 *   だから**押した結果が本文に残ること**まで見る。
 */
test('🔴 本文のチェック欄は、保存できる面でだけ押せる (#277)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('- [ ] やること\n- [x] 済み\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const boxes = page.locator('[data-pkc-field="detail-body"] .pkc-task-checkbox');
  await expect(boxes, 'チェック欄が出ていない').toHaveCount(2);
  // 原文の状態が反映されている
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();

  // 🔴 読む面では押せる(受け手が居る)
  await expect(boxes.nth(0), '読む面なのに押せない').toBeEnabled();
  await expect(boxes.nth(0)).toHaveAttribute('data-pkc-action', 'toggle-task');

  /**
   * ⚠ **押した印が描き直しで消えない**(follower が描き直しても戻らない)。
   * 🔑 `toBeChecked()` はブラウザ既定の反転でも真になるので、**これだけでは
   *   保存の証拠にならない** ── **保存されて残るか**は
   *   `tests/smoke/task-checkbox.smoke.spec.ts` が往復させて見ている。
   *   ここで二重に持たない(フル smoke の時間を増やさない)。
   */
  await boxes.nth(0).click();
  await expect(boxes.nth(0), '押した印が描き直しで消えた').toBeChecked();
  await expect(boxes.nth(1), '押していない方まで変わった').toBeChecked();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **UML 4 種 + `journey` が焼ける**(#528。2026-08-28)。
 *
 * 🔑 全数調査で分かったのは「**UML は無いのではなく、知られていない**」だった ──
 * `classDiagram` / `sequenceDiagram` / `stateDiagram-v2` / `erDiagram` は
 * 今日そのまま PNG まで焼ける。⚠ ところがこの file の spec は**全部
 * `graph TD`** で、**UML 4 種は 1 度も走っていなかった**(= 測っていない次元)。
 *
 * 🔴 そして走らせたら **`journey` だけが落ちた** ── `SecurityError:
 * Tainted canvases may not be exported.`。この図は `htmlLabels` を読まず
 * `textPlacement` の既定が `'fo'` なので、`<foreignObject>` が 5 個残っていた
 * (直しは `mermaid-raster.ts` の `configFor`)。
 *
 * ⚠ 観測点は `state="ready"` **だけにしない** ── 器の属性は「描こうとした」まで
 * しか言わない。**`<img>` が blob で、実際に画素を持っている**ところまで見る
 * (`naturalWidth > 0`)。焼けなければ `failed` になるので、5 形とも別々に落ちる。
 */
/**
 * 🔴 **字は 1 か所から引く**(2026-08-29、#528)── 書き出しは
 * `tests/fixtures/mermaid-forms.ts` に 22 種ぶん在る。⚠ ここで書き直すと、
 * 全数の側(nightly)と**違う物を測る**ことになる(§7)。
 * 🔑 PR gate で回すのは**この 5 種だけ** ── 22 枚は重い(夜に回す)。
 */
const PICKED = ['classDiagram', 'sequenceDiagram', 'stateDiagram-v2', 'erDiagram', 'journey'];
const UML_FORMS: readonly (readonly [string, string])[] = PICKED.map((name) => {
  const f = MERMAID_FORMS.find((x) => x.name === name);
  /**
   * ⚠ **これは test に守られていない**(変異試験 D5 が SURVIVED で教えた)──
   *   fixture から 1 件消しても、先に
   *   `tests/features/mermaid-forms-parity.test.ts` が落ちるので、
   *   ここへは到達しない。
   * 🔑 買っているのは**そのときの読みやすさ**だけである ── 黙って 4 種で走るのではなく、
   *   消えた名前を言って止まる。「これが無いと壊れる」とは**書かない**。
   */
  if (!f) throw new Error(`fixture に ${name} が無い(mermaid-forms.ts から消えた)`);
  return [f.name, f.src] as const;
});

test('🔴 UML 4 種と journey が、どれも PNG まで焼ける (#528)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図の記法');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(UML_FORMS.map(([, src]) => '```mermaid\n' + src + '\n```').join('\n\n') + '\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const hosts = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  // 空振り防止: 器が 5 つ在る(1 つも出ていなければ以下は自明に通る)
  await expect(hosts, '図の器が 5 つ出ていない').toHaveCount(UML_FORMS.length);

  for (const [i, [name]] of UML_FORMS.entries()) {
    const host = hosts.nth(i);
    await expect(host, `${name} が焼けていない`).toHaveAttribute(
      'data-pkc-mermaid-state',
      'ready',
      { timeout: 30000 },
    );
    const img = await host.evaluate((h) => {
      const el = h.querySelector('img');
      return { src: el?.getAttribute('src')?.slice(0, 5) ?? '', natural: el?.naturalWidth ?? 0 };
    });
    expect(img.src, `${name}: blob の PNG が置かれていない`).toBe('blob:');
    expect(img.natural, `${name}: 画像が読めていない(焼きが失敗している)`).toBeGreaterThan(0);
  }

  expect(errors).toEqual([]);
});

/**
 * 🔴 **一覧から選んだ UML の雛形が、そのまま図になる**(#528 段①、2026-08-28)。
 *
 * ⚠ **unit では原理的に見られない** ── 雛形が「mermaid の文法として通るか」は
 *   実際に描かせないと分からない。文字列を pin する test は
 *   **通らない雛形でも緑**である(それは user が「赤い理由」だけを見る形になる)。
 * 🔑 だから観測点は**描けたこと**(`data-pkc-mermaid-state="ready"` + PNG の img)。
 * ⚠ 4 種を**全部**通す ── 1 種だけ通して「UML が描ける」と書くのは、
 *   数えていない次元を数えたことにする言い方である(CLAUDE.md §2)。
 */
test('🔴 一覧から選んだ UML の雛形は、そのまま図になる(#528 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const body = page.locator('[data-pkc-field="editor-body"]');
  await body.click();

  // 一覧を開く(帯の「雛形」)。⚠ 押し所は帯 ── 鍵に頼ると割り当て次第で空振りする
  await clickReal(page, '[data-pkc-action="insert-snippet"]');
  const rows = page.locator('[data-pkc-field="pick-snippet"]');
  await expect(rows.first()).toBeVisible();

  /**
   * ⚠ **空振り防止** ── 4 つの UML が一覧に**実在する**ことを先に見る。
   *   行が 0 件でも、下の「図になった」は最後の 1 種だけで真になりうる。
   */
  const titles = await rows.allTextContents();
  for (const want of ['クラス図', 'シーケンス図', '状態遷移図', 'ER 図'])
    expect(titles, `一覧に「${want}」が無い`).toContain(want);

  // 4 種を順に入れる(1 度開いた一覧は 1 つ選ぶと閉じるので、毎回開き直す)
  // ⚠ **2 度目以降に本文を click し直さない**(1 稿目はそれで落ちた)── click は
  //    caret を押した所へ動かすので、**前に入れた囲みの途中**に次の囲みが刺さり、
  //    4 つ入れたのに fence は 3 つになる。雛形の入口は caret を自分で握り直すので、
  //    帯を押すだけでよい
  for (const [i, label] of ['クラス図', 'シーケンス図', '状態遷移図', 'ER 図'].entries()) {
    if (i > 0) {
      await clickReal(page, '[data-pkc-action="insert-snippet"]');
      await expect(page.locator('[data-pkc-field="pick-snippet"]').first()).toBeVisible();
    }
    await page.locator(`[data-pkc-field="pick-snippet"]`, { hasText: label }).first().click();
    await expect(page.locator('[data-pkc-field="pick-snippet"]').first()).toBeHidden();
  }

  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const hosts = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(hosts).toHaveCount(4);
  for (let i = 0; i < 4; i++)
    await expect(hosts.nth(i)).toHaveAttribute('data-pkc-mermaid-state', 'ready', {
      timeout: 30000,
    });

  // 🔴 4 枚とも **PNG が実際に焼けている**(state だけ ready で中身が空、を落とす)
  const widths = await hosts.evaluateAll((hs) =>
    hs.map((h) => h.querySelector('img')?.naturalWidth ?? 0),
  );
  expect(widths.filter((w) => w > 0), `焼けていない図がある: ${widths.join(', ')}`).toHaveLength(4);

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * 🔴 **図を押すと別窓で実寸で開き、拡大縮小できる**(#527 案 A。user 指示 2026-08-28
 * 「**別ウィンドウで実寸で開いて拡大縮小できるようにしてほしい**」)。
 *
 * ## 🔑 unit では原理的に見られない 3 つ
 *
 * 1. **別窓が本当に開くか**(happy-dom に窓は無い ── unit は差した偽物と話している)
 * 2. 🔴 **実寸が「縮む前の大きさ」か** ── ここが**この機能が要る理由**である。
 *    段組みでは段の高さに収めるため図を縮めてある(#527 の頭打ち)ので、
 *    **画面の見かけより大きい**ことを見ないと「実寸で開いた」と言えない
 * 3. **編集の面では奪わない** ── あちらは図を押すと**原文が開く**のが動線で、
 *    ⚠ 実際、印を付けたまま測ったら**窓が開いて行は開かなかった**
 *    (= 図の原文を直す道を丸ごと奪っていた)。実ブラウザで測って気づいた
 */
test('🔴 図を押すと別窓で実寸で開き、拡大縮小できる (#527 案 A)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('# 図\n\n```mermaid\ngraph TD\n  A["始め"]-->B["途中"]-->C["終わり"]\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const fig = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(fig).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  const img = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src] img');
  // ⚠ **押せることが画面に出ている**(カーソルと吹き出し)── 常設のボタンは増やさない
  expect(await img.getAttribute('title'), '押せることが画面に出ていない').toContain('別のウィンドウ');
  await expect(
    page.locator('[data-pkc-field="detail-body"] [data-pkc-field="diagram-open"]'),
    '常設のボタンが増えている(#501 と逆向き)',
  ).toHaveCount(0);

  // ① 押すと別窓が開く
  const [win] = await Promise.all([context.waitForEvent('page'), img.click()]);
  await win.waitForLoadState('domcontentloaded');

  const g = await win.evaluate(() => {
    const i = document.querySelector('[data-pkc-field="asset-window-image"]') as HTMLImageElement;
    return {
      natural: i?.naturalWidth ?? 0,
      shown: Math.round(i?.getBoundingClientRect().width ?? 0),
      bar: document.querySelector('[data-pkc-field="asset-window-zoom"]') !== null,
    };
  });
  // ② 🔴 **実寸で出ている**(収めるために縮めていない)
  expect(g.natural, '別窓の絵が読めていない(この検査は何も見ていない)').toBeGreaterThan(0);
  expect(g.shown, `実寸で出ていない(実寸 ${g.natural} / 出ている ${g.shown})`).toBe(g.natural);
  expect(g.bar, '拡大縮小の帯が無い').toBe(true);

  // ③ 押すと本当に倍率が動く(帯が在るだけでは押せる証拠にならない)
  await win.locator('[data-pkc-field="asset-window-zoom"] button', { hasText: '＋' }).click();
  await expect
    .poll(async () =>
      win.evaluate(() =>
        Math.round(
          (
            document.querySelector('[data-pkc-field="asset-window-image"]') as HTMLImageElement
          ).getBoundingClientRect().width,
        ),
      ),
    { message: '＋ を押しても大きくならない', timeout: 3_000 })
    .toBeGreaterThan(g.shown);
  await win.close();

  /**
   * ⚠ **編集の面(1 面)で奪っていないこと**は、この file では見られない ──
   *   ここは `beforeEach` が **2 ペイン**を選んでいるので `editor-live` が存在しない
   *   (1 稿目はここで測ろうとして落ち、それで気づいた)。
   * 🔑 そちらは `live-editor.smoke.spec.ts`(既定 = 1 面)が守る。
   */
  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * 🔴 **拡大窓はベクタを開く**(user 報告 2026-08-28)。
 *
 * > 「別窓で開いた時、ラスタ化された方の画像が開くのは BAD!
 * >  巨大な MerMaid を開いたらぽしょぽしょの図になってしまったよ」
 *
 * 🔑 **`WIDE_DIAGRAM` を使う** ── 器より大きい図でないと再現しない。
 *   器に収まる小さい図は焼き幅が実寸で頭打ちになるので、raster でも粗く見えない
 *   (= **ゼロ件の次元**になる。CLAUDE.md「fixture のゼロ件の次元は測っていない次元」)。
 *
 * 観測点は 2 つとも**直接**見る(粗さの代用品を見ない):
 *
 * | 見るもの | 何が分かるか |
 * |---|---|
 * | 窓の絵の blob の **MIME** | 🔑 **本当にベクタか**(`image/svg+xml`) |
 * | 窓の絵の **`naturalWidth`** | **実寸で開いたか** ── 300px でも、焼いた幅でもない |
 *
 * ⚠ 2 つ目が要る理由: mermaid の SVG は `width="100%"` なので、素で渡すと
 *   `<img>` の自然幅が **300px** になり、「粗い」を直して「**小さい**」を作る。
 */
test('🔴 図を押して開く別窓は、焼いた PNG ではなくベクタ (#527 / user 報告)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(WIDE_DIAGRAM);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  // ⚠ **前提の検算** ── 本文に置かれているのは焼いた PNG である(これが「元の姿」)
  const body = await host.evaluate(async (h) => {
    const i = h.querySelector('img')!;
    return { natural: i.naturalWidth, type: (await (await fetch(i.src)).blob()).type };
  });
  expect(body.type, '前提が崩れている ── 本文が既に PNG ではない').toBe('image/png');

  const img = host.locator('img');
  const [win] = await Promise.all([context.waitForEvent('page'), img.click()]);
  await win.waitForSelector('[data-pkc-field="asset-window-image"]', { timeout: 15_000 });
  const shown = await win.evaluate(async () => {
    const i = document.querySelector(
      '[data-pkc-field="asset-window-image"]',
    ) as HTMLImageElement;
    if (!i.complete) await new Promise((ok) => i.addEventListener('load', ok, { once: true }));
    return { natural: i.naturalWidth, type: (await (await fetch(i.src)).blob()).type };
  });

  // ① 🔴 **ベクタである**(これが user の報告そのもの)
  expect(shown.type, `窓が焼いた画像を開いている(${shown.type})`).toBe('image/svg+xml');

  // ② 🔴 **実寸で開いている** ── 300px(SVG の既定)でも、焼いた幅でもない
  expect(shown.natural, '窓の絵が読めていない(この検査は何も見ていない)').toBeGreaterThan(0);
  expect(shown.natural, '🔴 300px で開いている ── 実寸を書き込めていない').not.toBe(300);
  expect(
    shown.natural,
    `焼いた幅のまま開いている(窓 ${shown.natural} / 本文 ${body.natural})`,
  ).toBeGreaterThan(body.natural);

  expect(errors, 'ページ例外が出ている').toEqual([]);
});

/**
 * 🔴 **grafu の拡大窓も、画面の小さい PNG ではない**(user 報告 2026-08-28 の続き)。
 *
 * ⚠ 1 稿目の直しは `data-pkc-mermaid-src` **だけ**を見ていたので、
 *   **grafu は小さい PNG が開いたまま**だった ── user の「ぽしょぽしょ」が
 *   grafu では直っていなかった(2026-08-29 の棚卸しで判明)。
 *
 * 🔑 **図と grafu で直し方が違う**:
 *   ・mermaid は SVG を吐く → **ベクタ**にできる
 *   ・chart.js は**ベクタを吐かない**(`chart-raster.ts` の `savable: false`)
 *     → **大きく焼き直す**しかない
 *
 * ⚠ だから観測点も違う。ここで見るのは MIME ではなく **画素の幅**である
 *   (どちらも image/png なので、MIME では 1 バイトも区別できない)。
 */
test('🔴 grafu を押して開く別窓は、画面より大きく焼き直されている (#527 / user 報告)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(
      '```chart\n{"type":"bar","labels":["1月","2月","3月"],' +
        '"datasets":[{"label":"売上","data":[10,20,30]}]}\n```\n',
    );
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-chart-src]');
  // ⚠ 状態属性は種類ごとに違う(`data-pkc-<name>-state`)── grafu は `chart`
  await expect(host).toHaveAttribute('data-pkc-chart-state', 'ready', { timeout: 30000 });

  // ⚠ **前提の検算** ── 本文に置かれているのは焼いた PNG である
  const body = await host.evaluate(async (h) => {
    const i = h.querySelector('img');
    return i === null
      ? null
      : { natural: i.naturalWidth, type: (await (await fetch(i.src)).blob()).type };
  });
  expect(body, '前提が崩れている ── grafu の絵が置かれていない').not.toBeNull();
  const bodyPng = body!;
  expect(bodyPng.type, '前提が崩れている ── grafu が PNG ではない').toBe('image/png');

  const [win] = await Promise.all([context.waitForEvent('page'), host.locator('img').click()]);
  await win.waitForSelector('[data-pkc-field="asset-window-image"]', { timeout: 20_000 });
  const shown = await win.evaluate(async () => {
    const i = document.querySelector('[data-pkc-field="asset-window-image"]') as HTMLImageElement;
    if (!i.complete) await new Promise((ok) => i.addEventListener('load', ok, { once: true }));
    return { natural: i.naturalWidth, type: (await (await fetch(i.src)).blob()).type };
  });

  // ① 空振り防止 ── 窓の絵が読めていること
  expect(shown.natural, '窓の絵が読めていない(この検査は何も見ていない)').toBeGreaterThan(0);

  // ② 🔴 **画面より大きく焼き直されている**(ここが user の報告そのもの)
  expect(
    shown.natural,
    `画面の焼きをそのまま開いている(窓 ${shown.natural} / 本文 ${bodyPng.natural})`,
  ).toBeGreaterThan(bodyPng.natural);

  expect(errors, 'ページ例外が出ている').toEqual([]);
});
