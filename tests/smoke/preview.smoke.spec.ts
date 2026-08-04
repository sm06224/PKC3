import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * P8 段②: **書きながら見える**。
 *
 * > user 指摘 2026-08-03「プレビューとmermaidどこいった？」
 *
 * 🔴 PKC3 にはプレビューが**存在しなかった**(編集は素の textarea 1 枚)。
 * ⚠ 更新は state ではなく textarea の `input` で駆動する ── `render()` は
 * 編集中の同一 entry では早期 return する(カーソルと IME を壊さないため)ので、
 * **state 経由の test では通らない**。実際に打って確かめる。
 */
test('🔴 編集しながらプレビューが追いつく', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  await expect(preview).toBeVisible();

  // ① 原文とプレビューが**横に並ぶ**(縦に積まれていない)
  const a = (await ta.boundingBox())!;
  const b = (await preview.boundingBox())!;
  expect(a.x + a.width, 'プレビューが原文と重なっている').toBeLessThanOrEqual(b.x + 1);

  // ② 🔴 **打つと変わる**。markdown として解釈されている(生の記号が出ていない)
  await ta.fill('# 見出し\n\n- りんご\n- みかん\n');
  await expect(preview.locator('h1')).toHaveText('見出し');
  await expect(preview.locator('li')).toHaveCount(2);
  await expect(preview).not.toContainText('# 見出し');

  // ③ 続けて打つと**追いつく**(1 回目だけ描いて止まる実装を落とす)
  await ta.fill('## 別の見出し\n\n| 項目 | 値 |\n|---|---|\n| A | 1 |\n');
  await expect(preview.locator('h2')).toHaveText('別の見出し');
  await expect(preview.locator('table td')).toHaveCount(2);

  // ④ frontmatter は**プレビューに出さない**(本文だけを見せる)
  await ta.fill('---\ntitle: x\n---\n本文だけ\n');
  await expect(preview).not.toContainText('title: x');
  await expect(preview).toContainText('本文だけ');

  // ⑤ 保存して抜けても、閲覧側が同じものを出す
  // ⚠ 観測点は `detail-body` ── markdown 記法が無い本文は `<pre>` で出るので
  // `.pkc-md-rendered` を見ると**書き方によって落ちる**(実際に踏んだ)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('本文だけ');
  await expect(page.locator('[data-pkc-field="detail-body"]')).not.toContainText('title: x');
  expect(errors).toEqual([]);
});

/**
 * P8 段⑨: **描いているのはワーカーである**。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し…」
 *
 * 🔴 unit は偽 worker で機構を見ている。**本物が本当に読み込まれて使われたか**は
 * 実ブラウザでしか分からない ── ここを置かないと、`Worker` が使えない環境判定に
 * 落ちて**ずっと同期で描いていても全部緑**になる(そういう負け方を実際にする)。
 */
test('🔴 プレビューはワーカーが描いている(同期に落ちていない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① 編集に入る**前**はワーカーを起こしていない(遅延起動)
  const before = await page.evaluate(() =>
    performance.getEntriesByType('resource').filter((e) => e.name.includes('markdown-worker'))
      .length,
  );
  expect(before, '使う前からワーカーを起こしている').toBe(0);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('# 見出し\n\n本文です\n');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  await expect(preview.locator('h1')).toHaveText('見出し');

  // ② 🔴 **本物のワーカーが読み込まれた**
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            performance
              .getEntriesByType('resource')
              .filter((e) => e.name.includes('markdown-worker')).length,
        ),
      { message: 'markdown worker が読み込まれていない(同期経路に落ちている)' },
    )
    .toBeGreaterThan(0);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑩: **ジョブの可視化とログ**。
 *
 * > user 指示 2026-08-03「**ジョブスケジューラーは可視化機構とセットでお願いします /
 * > ログもみたい**」
 *
 * ⚠ 「画面が出る」で止めない ── **実際のジョブが数字とログに現れる**ことを見る。
 * 空の表を出すだけの実装でも「出た」は通ってしまう。
 */
test('🔴 設定にジョブの状態とログが出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 何か仕事をさせる(プレビューを描かせる)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('# 見出し\n\n本文\n');
  await expect(page.locator('[data-pkc-region="editor-preview"] h1')).toHaveText('見出し');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-view="settings"]');
  const lanes = page.locator('[data-pkc-field="job-lanes"] tbody tr');
  // ① 🔴 markdown のワーカーが行として出る
  await expect(lanes.filter({ hasText: 'markdown' })).toHaveCount(1);
  const row = lanes.filter({ hasText: 'markdown' }).first();
  // ② 🔴 **完了件数が 1 以上**(空の表を出しているだけではない)
  const done = await row.locator('td').nth(4).textContent();
  expect(Number(done), '完了したジョブが数えられていない').toBeGreaterThan(0);
  // ③ 中央値が出ている(所要時間を測っている)
  await expect(row.locator('td').nth(7)).not.toHaveText('—');

  // ④ 🔴 ログに実際の出来事が並ぶ
  const log = page.locator('[data-pkc-field="job-log"] li');
  await expect(log.first()).toBeVisible();
  await expect(page.locator('[data-pkc-field="job-log"] li[data-pkc-phase="done"]').first()).toContainText('markdown');
  await expect(page.locator('[data-pkc-field="job-log"] li[data-pkc-phase="spawn"]').first()).toBeVisible();

  // ⑤ ⚠ ログに**本文の中身**は出さない(文字数だけ)
  await expect(page.locator('[data-pkc-field="job-log"]')).not.toContainText('見出し');

  expect(errors).toEqual([]);
});

/**
 * P8 段⑩: 🔴 **打っても画面がガクガクしない**。
 *
 * > user 指示 2026-08-03「1 打鍵ではなく、3 秒周期で差分反映してください /
 * > **1 打鍵では、そんなことしたら、重たくなるし、レンダリングで画面がガクガクする**」
 *
 * 🔴 「ガクガク」を long task の数字で語ると外す(計器側のコストに埋もれる ──
 * 実際に埋もれた)。**user が見ているもの**を直接観測点にする:
 *  ① スクロール位置が飛ばない
 *  ② 触っていない図の `<img>` が**同じ実体のまま**残る(= 絵が消えて焼き直らない)
 * 丸ごと差し替える実装では、この 2 つが必ず壊れる。
 */
test('🔴 打ってもスクロールが飛ばず、触っていない図が消えない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  const filler = Array.from({ length: 60 }, (_, i) => `## 節 ${i}\n\n段落 ${i}。\n`).join('\n');
  await ta.fill('```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n\n' + filler);

  const host = preview.locator('[data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  await page.evaluate(() => {
    const img = document.querySelector(
      '[data-pkc-region="editor-preview"] [data-pkc-field="mermaid-image"]',
    );
    (img as HTMLElement & { __mark?: string }).__mark = 'same-element';
  });
  const srcBefore = await preview.locator('[data-pkc-field="mermaid-image"]').getAttribute('src');

  await preview.evaluate((el) => (el.scrollTop = 800));
  const scrollBefore = await preview.evaluate((el) => el.scrollTop);
  expect(scrollBefore, 'スクロールできていない(観測の前提が崩れている)').toBeGreaterThan(100);

  await ta.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    t.value += '\n\n末尾に足した段落。\n';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(preview).toContainText('末尾に足した段落。', { timeout: 8000 });

  const scrollAfter = await preview.evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollAfter - scrollBefore), 'スクロールが飛んだ').toBeLessThan(40);

  const stillSame = await page.evaluate(
    () =>
      (
        document.querySelector(
          '[data-pkc-region="editor-preview"] [data-pkc-field="mermaid-image"]',
        ) as (HTMLElement & { __mark?: string }) | null
      )?.__mark ?? null,
  );
  expect(stillSame, '触っていない図まで作り直した(絵が一度消える)').toBe('same-element');
  await expect(preview.locator('[data-pkc-field="mermaid-image"]')).toHaveAttribute(
    'src',
    srcBefore!,
  );

  expect(errors).toEqual([]);
});

/**
 * P8 段⑲: 🔴 **編集中に図の生成物が積もらない**。
 *
 * > user 指示 2026-07-27(不可侵)「ゼロコピー、生成とライフサイクル後の
 * > 速やかな破棄を徹底してください」
 *
 * 🔴 段⑰ が置いた修理の本体は `detail.ts` の `pruneScopes(scopes)`(静穏 tick
 * ごとに、器が外れた塊を畳む)だが、それを守る test は
 * `scope.prune()` を**直接**呼ぶ unit だけで、**呼び出し側は 1 行も通っていなかった**
 * ── 呼び出しを消しても unit 1393 件 + smoke 47 件が全部緑になる。
 * 積もると、画面に無い PNG の ObjectURL と観測器が編集を抜けるまで生き続ける。
 *
 * ⚠ 観測点は「同じ要素か」ではなく **createObjectURL - revokeObjectURL の残高**。
 * ⚠ グローバルを丸ごと差し替えない ── **静的メソッド 2 つだけ**を包む
 *   (`URL` をコンストラクタでなくすと happy-dom / Chromium の別経路が壊れる。
 *    2026-07-26 に PKC2 で実際に踏んだ罠)。
 */
test('🔴 図を打ち替えても、生成した URL が積もらない', async ({ page }) => {
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
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  const ROUNDS = 4;
  for (let i = 0; i < ROUNDS; i++) {
    await ta.evaluate((el, n) => {
      const t = el as HTMLTextAreaElement;
      t.value = '```mermaid\ngraph TD\n  A["始め ' + n + '"]-->B["終わり"]\n```\n';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }, i);
    // 🔴 **この回の原文が実際に反映される**まで待つ ── 待たないと 4 回の打鍵が
    //    静穏の畳み込みで 1 回に潰れ、「焼き直しが起きていない = 積もらない」で
    //    自明に通ってしまう(1 巡目で実際に踏んだ)
    await expect(preview.locator('[data-pkc-mermaid-src]')).toHaveAttribute(
      'data-pkc-mermaid-src',
      new RegExp(`始め ${i}`),
      { timeout: 30000 },
    );
    await expect(preview.locator('[data-pkc-mermaid-src]')).toHaveAttribute(
      'data-pkc-mermaid-state',
      'ready',
      { timeout: 30000 },
    );
    // 焼けた PNG が実際に貼られるまで待つ(貼る時点で URL を作る)
    await expect(preview.locator('[data-pkc-field="mermaid-image"]')).toHaveAttribute(
      'src',
      /^blob:/,
      { timeout: 30000 },
    );
  }

  const u = await page.evaluate(
    () => (window as unknown as { __urls: { made: number; freed: number } }).__urls,
  );
  // ① 🔴 **測る次元が非ゼロ**(空振り防止)── 焼き直しが起きていなければ
  //    「積もっていない」は自明に通る
  expect(u.made, `図が焼き直されていない(made=${u.made})`).toBeGreaterThanOrEqual(ROUNDS);
  // ② 残高が**回数で増えない**。いま画面に出ている 1 枚ぶんに収まる
  //    (直す前は ROUNDS 回ぶんが丸ごと残った)
  expect(
    u.made - u.freed,
    `生成した URL が積もっている(作 ${u.made} / 解放 ${u.freed})`,
  ).toBeLessThanOrEqual(2);

  expect(errors).toEqual([]);
});

/**
 * P8 段㉗: 🔴 **図を「消すだけ」の編集でも生成物が返る**。
 *
 * 🔴 段⑲ は `pruneLends()` を `if (applied.inserted.length > 0)` の**外**へ出し、
 * 「塊が**消えるだけ**のときは inserted が空で、そこが一番溜まる」と
 * コメントまで書いた。にもかかわらず、**1 行上の `pruneScopes` は `if` の中に
 * 残っていた** ── 同じ穴を隣同士で片方だけ塞いでいた。
 *
 * 壊れ方: 図を書いてから**図だけ消す**(本文は残す)と、`inserted` は空なので
 * `pruneScopes` が呼ばれず、消えた図の PNG の ObjectURL が編集を抜けるまで
 * 返らない。図をいくつも書いては消す推敲で、そのぶんだけ積む。
 *
 * ⚠ 観測点は上の test と同じく **残高**(作った数 - 返した数)。
 * ⚠ 上の test は毎回**別の図に差し替える**ので `inserted` が常に非ゼロ ──
 *   この経路は 1 度も通っていなかった(だから穴が残っていた)。
 */
test('🔴 図を消すだけの編集でも、生成した URL が返る', async ({ page }) => {
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
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  const type = async (text: string): Promise<void> => {
    await ta.evaluate((el, t) => {
      const x = el as HTMLTextAreaElement;
      x.value = t;
      x.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
  };

  // ① 図を書く → 焼けて `<img>` が貼られる(= ここで URL を 1 本作る)
  await type('```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n\nあとがき\n');
  await expect(preview.locator('[data-pkc-field="mermaid-image"]')).toHaveAttribute(
    'src',
    /^blob:/,
    { timeout: 30000 },
  );
  const made = await page.evaluate(
    () => (window as unknown as { __urls: { made: number; freed: number } }).__urls.made,
  );
  // 前提: 焼けている(ここが 0 なら以降は何も見ていない)
  expect(made, '図が焼かれていない').toBeGreaterThan(0);

  // ② 🔴 **図だけ消す**。本文は残すので、塊は「消えるだけ」になる
  await type('あとがき\n');
  await expect(preview.locator('[data-pkc-mermaid-src]')).toHaveCount(0, { timeout: 30000 });

  // ③ 消えた図のぶんが**返っている**(直す前は返らなかった)
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const u = (window as unknown as { __urls: { made: number; freed: number } }).__urls;
          return u.made - u.freed;
        }),
      { timeout: 15000, message: '図を消したのに URL が返っていない' },
    )
    .toBe(0);

  expect(errors).toEqual([]);
});
