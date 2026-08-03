import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry } from './helpers';

/**
 * P7b 段⑨: **枠が組めている**(設計 doc §1-4)。
 *
 * 🔴 「CSS が読み込まれた」で止めない ── 読み込まれていてもレイアウトが崩れて
 * いれば同じことである。ここが見るのは**位置関係**:
 * サイドバーと本文が横に並ぶ / かんばんの列が横に並ぶ / 面が重なっていない。
 *
 * ⚠ 段⑨ 以前の実際の姿は「サイドバーが本文の**上に**縦に流れ、かんばんの列が
 * **縦に積まれる**」だった ── どちらもこの spec が落とす形である。
 */
test('🔴 枠が組めている(3 列 / 重なりなし)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  // ① サイドバーと本文が**横に並ぶ**(縦に流れていない)
  const sidebar = await page.locator('[data-pkc-region="sidebar"]').boundingBox();
  const detail = await page.locator('[data-pkc-region="detail"]').boundingBox();
  expect(sidebar, 'サイドバーが画面に無い').not.toBeNull();
  expect(detail, '本文が画面に無い').not.toBeNull();
  expect(sidebar!.width).toBeGreaterThan(0);
  expect(sidebar!.height).toBeGreaterThan(0);
  // 右端が本文の左端を越えない = 重なっていない
  expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(detail!.x + 1);

  // ② status は**いちばん下**にあり、本文と重なっていない
  const status = await page.locator('[data-pkc-region="status"]').boundingBox();
  expect(status).not.toBeNull();
  expect(status!.y).toBeGreaterThanOrEqual(detail!.y + detail!.height - 1);

  // ③ 面(更新の案内 / 注意)は**既定で場所を取らない**
  //    ⚠ `hidden` が grid item に効かないと、空の箱が行を占めて本文が縮む
  expect(await page.locator('[data-pkc-region="update"]').isVisible()).toBe(false);
  expect(await page.locator('[data-pkc-region="notices"]').isVisible()).toBe(false);

  // ③' 🔴 面が**2 つ同時に出ても重ならない**。
  //    ⚠ ③ は「既定で出ない」しか見ておらず、**両方に同じ grid area を割り当てる
  //    変異が生き残った**(実際に一度そう書いた)── 重なりは「両方出たとき」に
  //    しか観測できない。自然に両方出す(取込の注意 + 待機中の SW)のは高くつくので、
  //    ここでは**強制的に出して位置関係だけ**を見る
  await page.evaluate(() => {
    for (const name of ['update', 'notices']) {
      const el = document.querySelector<HTMLElement>(`[data-pkc-region="${name}"]`);
      if (!el) continue;
      el.hidden = false;
      el.textContent = 'x';
    }
  });
  const upd = (await page.locator('[data-pkc-region="update"]').boundingBox())!;
  const noti = (await page.locator('[data-pkc-region="notices"]').boundingBox())!;
  expect(upd.height).toBeGreaterThan(0);
  expect(noti.height).toBeGreaterThan(0);
  expect(upd.y + upd.height, '更新の案内と注意の面が重なっている').toBeLessThanOrEqual(
    noti.y + 1,
  );
  await page.reload();
  await expect(page.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached();

  // ④ サイドバーの行が**覆われていない**(実際にその点に居るのが自分の子孫か)
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  const box = await row.boundingBox();
  expect(box, '一覧の行が画面に無い').not.toBeNull();
  const covered = await page.evaluate(
    ({ x, y }) => {
      const at = document.elementFromPoint(x, y);
      const row2 = document.querySelector('[data-pkc-region="entry-list"] [data-pkc-entry]');
      return !(at && row2 && (row2 === at || row2.contains(at)));
    },
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
  );
  expect(covered, '一覧の行が何かに覆われている').toBe(false);

  // ⑤ 🔴 **右の情報ペインが本文の隣に居る**(P8 ── 1 画面で完結)
  const inspector = (await page.locator('[data-pkc-region="inspector"]').boundingBox())!;
  expect(inspector.width, '情報ペインが出ていない').toBeGreaterThan(0);
  expect(detail!.x + detail!.width, '本文と情報ペインが重なっている').toBeLessThanOrEqual(
    inspector.x + 1,
  );

  // ⑥ 🔴 **編集に入っても列が動かない**(以前は本文以外が全部消えていた)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const inspector2 = (await page.locator('[data-pkc-region="inspector"]').boundingBox())!;
  expect(inspector2.x, '編集に入ると情報ペインが動く').toBe(inspector.x);
  const sidebar2 = (await page.locator('[data-pkc-region="sidebar"]').boundingBox())!;
  expect(sidebar2.width, '編集に入ると一覧が動く').toBe(sidebar!.width);

  // ⑦ 🔴 **編集欄が下まで伸びる**(以前は固定高で下に 280px の死に領域があった)
  const ta = (await page.locator('[data-pkc-field="editor-body"]').boundingBox())!;
  const pane = (await page.locator('[data-pkc-view-pane="detail"]').boundingBox())!;
  const dead = pane.y + pane.height - (ta.y + ta.height);
  expect(dead, `編集欄の下に ${Math.round(dead)}px の死に領域`).toBeLessThan(40);
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  // ⑧ ファイラの表が**列ズレしていない**(単漢字マークの ::before が匿名セルを
  //    作って全ヘッダを 1 列ずらしていた ── 実測で見つけた本物のバグ)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="filer"]');
  const cells = await page
    .locator('[data-pkc-region="filer-table"] tbody tr')
    .first()
    .evaluate((tr) => tr.children.length);
  const heads = await page
    .locator('[data-pkc-region="filer-table"] thead tr')
    .first()
    .evaluate((tr) => tr.children.length);
  expect(cells, '表の列数がヘッダと合っていない').toBe(heads);
});

test('🔴 狭い画面では 1 カラムへ折る(横に潰れない)', async ({ page }) => {
  // ⚠ 折らないと、サイドバーの最小幅 180px が本文を圧迫して読めなくなる
  await page.setViewportSize({ width: 480, height: 800 });
  await gotoApp(page);
  const sidebar = (await page.locator('[data-pkc-region="sidebar"]').boundingBox())!;
  const detail = (await page.locator('[data-pkc-region="detail"]').boundingBox())!;
  // 縦に積まれる = サイドバーの下端が本文の上端以下
  expect(sidebar.y + sidebar.height).toBeLessThanOrEqual(detail.y + 1);
  // 本文が画面幅いっぱいを使う(480px 画面なので、余白を引いた分)
  expect(detail.width).toBeGreaterThan(440);
  // ⚠ 情報ペインは**畳まれる**(狭い画面で 3 列にすると本文が読めない)
  expect(await page.locator('[data-pkc-region="inspector"]').isVisible()).toBe(false);
});

/**
 * P8: **畳まない**(user 指示 2026-08-03「シンプルかつ高機能さ」)。
 *
 * ⚠ 以前は `取り込む▾ 書き出す▾ 整理▾ 表示▾` と `<details>` に畳んでいた。
 * 業務画面の作法では主要な導線は**全部見えている**ので、畳んだ形に戻ったら落とす。
 */
test('🔴 主要な導線が畳まれず、その場で押せる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  expect(await page.locator('details').count(), '導線が畳まれている').toBe(0);
  for (const action of ['import-file', 'export-archive', 'export-html', 'export-markdown', 'purge-orphan-assets']) {
    await expect(
      page.locator(`[data-pkc-action="${action}"]`),
      `${action} が見えていない`,
    ).toBeVisible();
  }
  // 押せること(覆われていない)まで見る ── 見えていても押せない配置がある
  page.once('dialog', (d) => void d.dismiss());
  await clickReal(page, '[data-pkc-action="purge-orphan-assets"]');
});

/**
 * P7b 段⑨c: **導線の再考**(user 指示 2026-08-03
 * 「PKC2 の導線設計も再考する形で実装してください」)。
 *
 * 🔴 PKC3 には**検索・絞り込みの導線が 1 つも無かった** ── ノートが増えたときに
 * 真っ先に要るのは「作る」ではなく「探す」である。サイドバーの先頭をそこに充てた。
 */
test('🔴 一覧を絞り込める(探す導線)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  for (const name of ['りんご', 'みかん', 'りんごジャム']) {
    await createEntry(page, 'text');
    await page.locator('[data-pkc-field="editor-title"]').fill(name);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(3);

  // 絞り込むと**行が減る**(隠すのではなく外す)
  const box = page.locator('[data-pkc-field="entry-filter"]');
  await expect(box).toBeVisible();
  await box.fill('りんご');
  await expect(rows).toHaveCount(2);
  await box.fill('みかん');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('みかん');

  // ⚠ **大文字小文字を問わない**(題名は日本語だけではない)
  await box.fill('');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('Apple Pie');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await box.fill('apple');
  await expect(rows).toHaveCount(1);

  // 消せば全部戻る(絞り込みは**捨てていない**)
  await box.fill('');
  await expect(rows).toHaveCount(4);
});

/**
 * P7b review M-4: 絞り込みの**戻り**で行を作り直さない。
 *
 * 🔴 15,000 件で実測すると、絞り込みを消すたびに 0.2〜0.75 秒メインスレッドが
 * 止まっていた ── 外した行を捨てて `createRow` からやり直していたためで、
 * CLAUDE.md が PKC2 の体感悪化の主因として名指しした
 * 「5000 行のサイドバーを作り直す」と同型である。
 * ⚠ 「速くなった」は結果に出ないので、**同じノードが戻ってくるか**で見る
 * (作り直す実装ではここが落ちる)。
 */
test('🔴 絞り込みを戻したとき、行は作り直されない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  for (const name of ['りんご', 'みかん']) {
    await createEntry(page, 'text');
    await page.locator('[data-pkc-field="editor-title"]').fill(name);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(2);

  // 印を付ける ── 同じ DOM ノードが戻れば印も残る
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(
      '[data-pkc-region="entry-list"] [data-pkc-entry]',
    ))
      (el as HTMLElement).dataset.probe = 'kept';
  });
  const box = page.locator('[data-pkc-field="entry-filter"]');
  await box.fill('りんご');
  await expect(rows).toHaveCount(1);
  await box.fill('');
  await expect(rows).toHaveCount(2);
  const kept = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-pkc-region="entry-list"] [data-pkc-entry][data-probe="kept"]',
      ).length,
  );
  expect(kept).toBe(2);
});

/**
 * P8: 種別は**チップ**で出す(裸の単漢字を地の文の前に置かない)。
 * ⚠ 旧実装は CSS の `::before` で「文 」を生やしており、`<tr>` に当たると
 * **匿名セルができてファイラの表が 1 列ずれ、全ヘッダが嘘になっていた**。
 */
test('🔴 種別はチップで出る(地の文に裸の記号を混ぜない)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('印の確認');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  // ① チップが**要素として**在る(CSS の生成文字ではない)
  await expect(row.locator('[data-pkc-chip]')).toBeVisible();
  // ② 題名は題名だけ ── 記号が混ざっていない
  await expect(row.locator('[data-pkc-field="title"]')).toHaveText('印の確認');
  // ③ 🔴 `::before` の生成文字が**どこにも生えていない**
  const generated = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-archetype]')]
      .map((el) => getComputedStyle(el, '::before').content)
      .filter((c) => c && c !== 'none' && c !== 'normal' && c !== '""'),
  );
  expect(generated, 'archetype に生成文字が残っている').toEqual([]);
});

/**
 * P8: 配色は 9 つ(user 指示 2026-08-03「github と solarized と Dracula と Nord は欲しい」)。
 *
 * 🔴 「属性が付いた」で止めない ── **実際に色が変わる**ところまで見る。
 * ⚠ この test が無かったせいで、`main.ts` に `light | dark` だけを通す古いガードが
 * 残っていることに**スクリーンショットを見るまで気づかなかった**(選んでも何も
 * 起きない = 9 つ中 7 つが死んでいた)。
 */
test('🔴 配色を選ぶと実際に色が変わる(全テーマ)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  // ⚠ 配色は**設定の画面**にある(user 指示 2026-08-03「普段から必要ではない」)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="theme-select"]');
  const ids = await select.evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((o) => o.value),
  );
  expect(ids.length, '配色が少なすぎる').toBeGreaterThanOrEqual(9);

  const seen = new Map<string, string>();
  for (const id of ids) {
    await select.selectOption(id);
    await expect(page.locator(`html[data-pkc-theme="${id}"]`)).toBeAttached();
    const bg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    // 🔴 **どれかと同じ色**なら、その配色は効いていない(既定に落ちている)
    const dup = [...seen.entries()].find(([, v]) => v === bg);
    expect(dup, `配色 ${id} が ${dup?.[0]} と同じ色 ── 効いていない`).toBeUndefined();
    seen.set(id, bg);
  }

  // 覚えていること(再読込しても選んだ配色のまま)
  await select.selectOption('nord');
  await page.reload();
  await expect(page.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached();
  await expect(page.locator('html[data-pkc-theme="nord"]')).toBeAttached();
  // 設定を開き直すと、覚えている配色が選ばれている
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator('[data-pkc-field="theme-select"]')).toHaveValue('nord');
});

/**
 * P8 段④: 図案を入れても**ボタンの大きさが変わらない**。
 *
 * > user 指示 2026-08-03「**絵文字を使うとボタンの高さが合わないから、
 * > UI デザインとしてボタンサイズ揃えはしてください**」
 *
 * ⚠ 「絵文字が出ている」で止めない ── 出ていても**高さがばらつく**のが指摘の中身。
 */
test('🔴 図案つきボタンの高さが揃っている', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-region="cmdbar"] button')].map((b) => ({
      h: Math.round(b.getBoundingClientRect().height),
      icon: (b.querySelector('[data-pkc-icon]')?.textContent ?? '').length > 0,
    })),
  );
  expect(sizes.length).toBeGreaterThan(5);
  // ① 図案が**実際に入っている**(空振り防止 ── 図案なしなら高さは当然揃う)
  expect(sizes.every((s) => s.icon), '図案の入っていないボタンがある').toBe(true);
  // ② 高さが**全部同じ**
  expect(new Set(sizes.map((s) => s.h)).size, `高さがばらついている: ${JSON.stringify(sizes.map((s) => s.h))}`).toBe(1);
});

/**
 * P8 段④: **境界線は共有し、余白は置かない**(user 指示 2026-08-03)。
 * ⚠ 面ごとに border を持たせると、隣り合わせで **2px の線**になる。
 */
test('🔴 面の境界が 1 本になっている(2 重線を作らない)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  const gap = await page.evaluate(() => {
    const s = document.querySelector('[data-pkc-region="sidebar"]')!.getBoundingClientRect();
    const d = document.querySelector('[data-pkc-region="detail"]')!.getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector('[data-pkc-region="sidebar"]')!);
    return { between: Math.round(d.left - s.right), border: cs.borderRightWidth };
  });
  // 面と面の間は **1px ちょうど**(共有の線)
  expect(gap.between, `面の間が ${gap.between}px`).toBe(1);
  // 面そのものは border を持たない(持つと 1px + 1px = 2px になる)
  expect(gap.border, 'サイドバーが自前の境界線を持っている').toBe('0px');
});
