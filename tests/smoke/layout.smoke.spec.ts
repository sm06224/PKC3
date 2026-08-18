import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, expectReachable, useSplitEditor, useListBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

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

  // ② 🔴 **下の帯は言うことがあるときだけ出る**(P10、user 指示「上下の帯は不要」)。
  //    直す前は 99% の時間「pkc3 v3.0.0」を出す常設の帯だった。
  //    ⚠ 消してはいない ── **エラーの唯一の出口**なので、出たときは
  //    「いちばん下にあって本文と重ならない」ことを見る
  const statusRegion = page.locator('[data-pkc-region="status"]');
  expect(await statusRegion.isVisible(), '言うことが無いのに下の帯が出ている').toBe(false);
  // 出したときの位置を見る(場所の契約はここでしか確かめられない)
  await statusRegion.evaluate((el) => {
    (el as HTMLElement).hidden = false;
    el.textContent = '検査用';
  });
  const status = await statusRegion.boundingBox();
  expect(status, '出しても場所を持たない').not.toBeNull();
  // ⚠ **本文を測り直す** ── 帯が出ると grid が組み替わって本文が縮むので、
  //    出す前に測った箱と比べると必ずずれる(実際に落ちた)
  const detailNow = await page.locator('[data-pkc-region="detail"]').boundingBox();
  expect(status!.y).toBeGreaterThanOrEqual(detailNow!.y + detailNow!.height - 1);
  await statusRegion.evaluate((el) => {
    (el as HTMLElement).hidden = true;
    el.textContent = '';
  });

  // ③ 面(更新の案内 / 注意)は**既定で場所を取らない**
  //    ⚠ `hidden` が grid item に効かないと、空の箱が行を占めて本文が縮む
  expect(await page.locator('[data-pkc-region="update"]').isVisible()).toBe(false);
  expect(await page.locator('[data-pkc-region="notices"]').isVisible()).toBe(false);

  // ③' 🔴 面が**2 つ同時に出ても重ならない**。
  //    ⚠ ③ は「既定で出ない」しか見ておらず、**両方に同じ grid area を割り当てる
  //    変異が生き残った**(実際に一度そう書いた)── 重なりは「両方出たとき」に
  //    しか観測できない。自然に両方出す(取込の注意 + 待機中の SW)のは高くつくので、
  //    ここでは**強制的に出して位置関係だけ**を見る
  //    ⚠ **お知らせ(P11)も同じ表に足す** ── 帯を 1 つ足すたびに「重なっていない」
  //    の検査対象を増やさないと、新しい帯だけが誰にも見られない
  await page.evaluate(() => {
    for (const name of ['announce', 'update', 'notices']) {
      const el = document.querySelector<HTMLElement>(`[data-pkc-region="${name}"]`);
      if (!el) continue;
      el.hidden = false;
      el.textContent = 'x';
    }
  });
  const ann = (await page.locator('[data-pkc-region="announce"]').boundingBox())!;
  const upd = (await page.locator('[data-pkc-region="update"]').boundingBox())!;
  const noti = (await page.locator('[data-pkc-region="notices"]').boundingBox())!;
  expect(ann.height).toBeGreaterThan(0);
  expect(upd.height).toBeGreaterThan(0);
  expect(noti.height).toBeGreaterThan(0);
  expect(ann.y + ann.height, 'お知らせと更新の案内が重なっている').toBeLessThanOrEqual(upd.y + 1);
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
  await clickReal(page, '[data-pkc-browse="filer"]');
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
  // 🔴 情報ペインは**消さず、下へ回す**(P8 段⑱。レビュー H)。
  //    かつては `display:none` にしていたので、その面が持つ
  //    「書き出す / 履歴 / 削除」に到達する導線が画面から消えていた。
  //    ⚠ 狭い画面で**横に 3 列にはしない**(本文が読めなくなる)ので、
  //    「消えていない」かつ「本文の下」の両方を見る
  const inspector = (await page.locator('[data-pkc-region="inspector"]').boundingBox())!;
  expect(inspector, '情報ペインが消えている(操作に手が届かない)').not.toBeNull();
  expect(inspector.y, '横に並べている(本文が潰れる)').toBeGreaterThanOrEqual(detail.y);
});

/**
 * P10: 🔴 **設定への入口が左の列に在り、押せる大きさがある**。
 *
 * 🔴 上の帯は**撤去した**(user 指示 2026-08-05「UI の上下の帯は不要だと思う。
 * 大して働いていない。設定への導線だけどこかに残す必要がある」)── 載っていたのは
 * 「PKC3」の文字と設定ボタンだけで、現在地を出すはずの区画は**書き手が 1 つも
 * 無かった**(ずっと空)。
 *
 * ⚠ だからここが見るのは 2 つ:**帯が無いこと**と、**設定へ行けること**。
 * 片方だけだと「導線ごと消した」も「帯が残っている」も通ってしまう。
 */
test('🔴 上の帯は無く、設定は左の列から押せる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  const m = await page.evaluate(() => {
    const btn = document.querySelector('[data-pkc-region="sidebar"] [data-pkc-view="settings"]');
    const r = btn?.getBoundingClientRect();
    const others = [
      ...document.querySelectorAll('[data-pkc-region="collection-bar"] button'),
    ].map((b) => Math.round(b.getBoundingClientRect().height));
    return {
      hasBrand: document.querySelector('[data-pkc-region="brand"]') !== null,
      inSidebar: btn !== null,
      h: r ? Math.round(r.height) : -1,
      w: r ? Math.round(r.width) : -1,
      heights: [...new Set(others)],
    };
  });
  // ① 帯が無い(撤去の pin ── 戻ってきたら落ちる)
  expect(m.hasBrand, '上の帯が戻っている').toBe(false);
  // ② 設定へ行ける(導線ごと消す変異を落とす)
  expect(m.inSidebar, '設定への導線が左の列に無い').toBe(true);
  // ③ 的が小さすぎない ── ⚠ 帯にいた頃の寸法(20px / 11px)を引きずると
  //    1 つだけ小さいボタンになる(実際にそうなった)
  expect(m.h, `設定ボタンが小さい(${m.h}px)`).toBeGreaterThanOrEqual(24);
  expect(m.w, `設定ボタンが細い(${m.w}px)`).toBeGreaterThanOrEqual(40);
  // ④ 隣と**同じ高さ**(揃っていない 1 個を作らない)
  expect(m.heights, `高さがばらついている: ${JSON.stringify(m.heights)}`).toHaveLength(1);
});


/**
 * P8 段⑱: 🔴 **狭い列でも探し方のタブが重ならない**。
 *
 * 左の列は 900px を切ると 180px まで縮む。3 つのタブに図案と語を両方載せると
 * 入りきらず、**互いに重なって語が読めなくなる**(段⑱ 以前の実際の姿)。
 * ⚠ 「畳まない」(user 指示)ので**タブは 3 つとも出したまま**、図案だけ落とす。
 */
test('🔴 狭い列でも探し方のタブが重ならない(3 つとも出たまま)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await gotoApp(page);
  const m = await page.evaluate(() => {
    const host = document.querySelector('[data-pkc-region="browse-tabs"]')!;
    const tabs = [...host.querySelectorAll('[data-pkc-browse]')].map((b) => {
      const r = b.getBoundingClientRect();
      const label = b.querySelector('[data-pkc-field="label"]')!;
      return {
        right: Math.round(r.right),
        // ⚠ タブは `flex: 1; min-width: 0` なので**箱は重ならない** ── 溢れるのは
        //    中身のほう。だから見るのは箱の位置ではなく「**語が自分の箱に
        //    収まっているか**」である(箱の重なりで書くと何も守らない)
        labelRight: Math.round(label.getBoundingClientRect().right),
        overflow: b.scrollWidth - b.clientWidth,
        label: (label.textContent ?? '').trim(),
      };
    });
    return { tabs, hostW: host.clientWidth, scrollW: host.scrollWidth };
  });
  // ① 3 つとも在る(畳んでいない)
  expect(m.tabs.length, 'タブが減っている(畳んだ形に戻っている)').toBe(3);
  expect(m.tabs.every((t) => t.label !== ''), '語が消えている(図案だけでは分からない)').toBe(true);
  // ② 語が自分の箱から溢れて隣に被っていない
  for (const t of m.tabs) {
    expect(
      t.labelRight,
      `「${t.label}」が隣のタブに被っている(語の右端 ${t.labelRight} / 箱の右端 ${t.right})`,
    ).toBeLessThanOrEqual(t.right);
    expect(t.overflow, `「${t.label}」の中身が箱に入っていない(+${t.overflow}px)`).toBeLessThanOrEqual(0);
  }
  // ③ 列から溢れていない(溢れると 3 つ目が見えない)
  expect(m.scrollW, `タブが列から溢れている(${m.scrollW} / 列 ${m.hostW})`).toBeLessThanOrEqual(
    m.hostW + 1,
  );
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
  // 左の列に残るもの ── よく押す / 押せないと詰まるもの
  for (const action of ['import-file', 'export-archive']) {
    await expect(
      page.locator(`[data-pkc-action="${action}"]`),
      `${action} が見えていない`,
    ).toBeVisible();
  }
  /**
   * 🔴 **移した先でも「畳んでいない」**(#239、user 指示 2026-08-17)。
   *
   * ⚠ 逃がすことと畳むことは違う ── 設定は面(region)なので、開けば 3 つとも
   * **見えて押せる**。ここを見ないと「設定へ移した」と称して**実は消えていた**を
   * 素通りさせる(押す口が消えて受け手だけ残る形は、こちらの検査に 1 つも鳴らない)。
   */
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  for (const action of ['export-html', 'export-markdown', 'purge-orphan-assets']) {
    await expect(
      page.locator(`[data-pkc-action="${action}"]`),
      `${action} が設定の面でも見えていない`,
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
    [...document.querySelectorAll('[data-pkc-region="collection-bar"] button')].map((b) => ({
      h: Math.round(b.getBoundingClientRect().height),
      // ⚠ 図案は **SVG** になった(P9 段③)── `textContent` は空なので、
      //    「描かれている物が在る」を **svg の path 数**で見る(空振り防止の要)
      icon: (b.querySelector('[data-pkc-icon] svg')?.querySelectorAll('path').length ?? 0) > 0,
    })),
  );
  expect(sizes.length).toBeGreaterThanOrEqual(5);
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
    const g = document
      .querySelector('[data-pkc-region="pane-grip"][data-pkc-pane="sidebar"]')!
      .getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector('[data-pkc-region="sidebar"]')!);
    return {
      toGrip: Math.round(g.left - s.right),
      grip: Math.round(g.width),
      fromGrip: Math.round(d.left - g.right),
      border: cs.borderRightWidth,
    };
  });
  /**
   * 🔴 **線は 1 本ずつ**(user 指示 2026-08-03「境界線は全て共有」)。
   * ⚠ 2026-08-15 に**掴む帯**が面と面のあいだへ入った(user 指示「センターペインの
   * 上を潰しすぎ」)ので、見る場所は「面と面」から「**面と帯**」×2 に変わった ──
   * 守る中身は同じである(隣り合う要素のあいだが 1px を超えない = 2 重線を作らない)。
   * ⚠ 帯の幅も pin する ── 黙って太る帯にしない。
   */
  expect(gap.toGrip, `左の面と帯の間が ${gap.toGrip}px`).toBe(1);
  expect(gap.fromGrip, `帯と本文の間が ${gap.fromGrip}px`).toBe(1);
  expect(gap.grip, `掴む帯が ${gap.grip}px(太りすぎ)`).toBe(8);
  // 面そのものは border を持たない(持つと 1px + 1px = 2px になる)
  expect(gap.border, 'サイドバーが自前の境界線を持っている').toBe('0px');
});

/**
 * P8 段⑫: 🔴 **一覧のスクロールも殺さない**。
 *
 * > user 指示 2026-08-03「**サイドバーも同じ、スクロールが発生するすべての画面が
 * > 対象だよ**」
 *
 * 🔴 直す前に測った実測(`✗` が飛んでいたもの):
 * ```
 * 一覧: 追記で再描画      ✓ 保つ      ← 行を再利用しているので元から平気
 * 一覧: 絞り込み → 戻す   ✗ 飛ぶ (250 → 0)
 * フォルダ: 絞り込み      ✗ 飛ぶ (250 → 0)
 * ```
 * 絞り込むと中身が縮んで `scrollTop` が 0 に丸められ、戻しても 0 のままだった。
 *
 * ⚠ 面の中を playwright でクリックしない ── `scrollIntoViewIfNeeded` が走って
 * **計器が自分でスクロールを潰す**(この罠で 1 度誤診した)。操作は面の外から。
 */
test('🔴 一覧のスクロール: 絞り込みを戻しても、タブを往復しても位置が残る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 700 });
  await gotoApp(page);

  // 一覧が溢れるだけ作る。
  // ⚠ **件数を増やした**(P10)── 上下の帯を撤去して左の列が 46px 高くなったので、
  //    24 件では溢れが 89px しか無く、`scrollTop = 200` が届かなくなった(実測)。
  //    ⚠ 絶対値で park するのをやめ、**溢れ量に対する相対**で置く(下記)
  for (let i = 0; i < 32; i++) {
    await createEntry(page, 'text');
    await page.locator('[data-pkc-field="editor-title"]').fill(`ノート ${i}`);
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  }

  const host = page.locator('[data-pkc-region="browse-host"]');
  // ⚠ フォルダの面も同じ器の中に居る(隠れているだけ)── 行は一覧に絞って数える
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  const shape = await host.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(shape.sh, '一覧が溢れていない(観測の前提が崩れている)').toBeGreaterThan(shape.ch + 50);

  // 溢れの真ん中あたりへ置く(端だと「戻った」と「動いていない」が区別できない)
  await host.evaluate((el) => (el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)));
  const parked = await host.evaluate((el) => el.scrollTop);
  // ⚠ 端に張り付いていないこと(0 でも最下端でもない = 記憶する意味がある位置)
  expect(parked, 'park した位置が先頭のまま(観測の前提が崩れている)').toBeGreaterThan(20);
  expect(
    await host.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    'park した位置が最下端(戻り先と区別できない)',
  ).toBeGreaterThan(20);

  // ① 🔴 絞り込んで戻す(入力欄は面の外なので、計器はスクロールしない)
  await page.locator('[data-pkc-field="entry-filter"]').fill('ノート 1');
  await expect(rows.first()).toBeVisible();
  await page.locator('[data-pkc-field="entry-filter"]').fill('');
  await expect(rows).toHaveCount(32);
  expect(
    Math.abs((await host.evaluate((el) => el.scrollTop)) - parked),
    '絞り込みを戻したら先頭へ飛んだ',
  ).toBeLessThan(30);

  // ② 🔴 タブを往復する(3 つの面が**同じ器**を使い回している)
  await clickReal(page, '[data-pkc-browse="filer"]');
  // ⚠ **フォルダ側を別の位置にしてから**戻る ── 同じ位置のままだと、
  //    面ごとに覚えていない実装(器の位置を持ち回すだけ)でも通ってしまう
  //    (変異試験で実際に素通りした)
  await host.evaluate((el) => (el.scrollTop = 0));
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(rows).toHaveCount(32);
  expect(
    Math.abs((await host.evaluate((el) => el.scrollTop)) - parked),
    'タブを往復したら位置が混ざった(面ごとに覚えていない)',
  ).toBeLessThan(30);

  // ③ ⚠ **絞り込んだ結果は先頭から**(探しているのだから、そこは動いて正しい)
  await page.locator('[data-pkc-field="entry-filter"]').fill('ノート 2');
  await expect(rows.first()).toBeVisible();
  expect(
    await host.evaluate((el) => el.scrollTop),
    '絞り込んだ結果を途中から見せている',
  ).toBeLessThan(30);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑱: 🔴 **幅が足りなくても操作は消さない**(レビュー H)。
 *
 * 🔴 直す前: 1100px 以下で付随情報を `display:none` にしていたので、
 * その面が持つ **書き出す / 履歴 / 削除**に到達する導線が画面から消えていた
 * (キーボードでも届かない)。幅が足りないなら**場所を変える**のであって、
 * 操作を無くしてよい理由にはならない。
 *
 * ⚠ 観測点は「要素が在るか」ではなく「**押せるか**」── `display:none` の
 * 要素は DOM に在るので、存在だけ見ると直す前でも緑になる。
 */
test('🔴 狭い画面でも「書き出す / 履歴 / 削除」に手が届く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('狭い画面');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const ACTIONS = ['export-entry', 'show-history', 'delete-entry'];
  for (const width of [1440, 1024, 900, 700]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(120);
    for (const a of ACTIONS) {
      const el = page.locator(`[data-pkc-action="${a}"]`).first();
      await expect(el, `${width}px で ${a} が画面から消えた`).toBeVisible();
      // ⚠ **押せる場所に居る**ことまで見る(0 幅・画面外だと押せない)
      const box = await el.boundingBox();
      expect(box, `${width}px で ${a} に大きさが無い`).not.toBeNull();
      expect(box!.width, `${width}px で ${a} が潰れている`).toBeGreaterThan(8);
      expect(box!.height).toBeGreaterThan(8);
    }
  }

  expect(errors).toEqual([]);
});

/**
 * P8 段⑱: 🔴 **図を器いっぱいに引き伸ばさない**(レビュー H)。
 * 直す前は 2 節点の図が 875×1286px を占めていた。
 */
test('🔴 小さい図は小さいまま置かれる(器いっぱいに広げない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('小さい図');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('```mermaid\ngraph TD\n  A-->B\n```\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  const size = await host.evaluate((h) => {
    const img = h.querySelector('img')!;
    // ⚠ **器は本文欄**(親)── `[data-pkc-mermaid-src]` 自身は `display: table` で
    //    中身に合わせて縮むので、そこを測ると「図と同じ幅」しか返らず、
    //    **どんな実装でも比が 1 未満にならない = 何も守らない**(実際に踏んだ)
    const box = h.parentElement!;
    return { w: img.clientWidth, hostW: box.clientWidth, natural: img.naturalWidth };
  });
  expect(size.hostW, '器が狭すぎて観測にならない').toBeGreaterThan(400);
  // 🔴 2 節点の図が器の幅いっぱいを占めない
  expect(size.w, `図が器いっぱいに広がっている(${size.w} / 器 ${size.hostW})`).toBeLessThan(
    size.hostW * 0.9,
  );
  expect(size.w, '図が消えた').toBeGreaterThan(10);

  // 🔴 **焼いた実寸で置く** ── 焼いた大きさと置く大きさがずれると、
  //    ぼやける(引き伸ばし)か切れる。dpr=1 なので natural と一致するのが正
  expect(size.w, `焼いた実寸で置いていない(置 ${size.w} / 焼 ${size.natural})`).toBe(size.natural);

  // 🔴 **開き直しても小さいまま**(キャッシュから返す道も同じ大きさを覚えている)。
  //    ⚠ 焼き直しに救われないよう、鍵が同じであること(同じ幅・同じテーマ)を保つ
  const rows = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('pkc3-diagram-cache', 1);
        req.onsuccess = () => {
          const c = req.result.transaction('png', 'readonly').objectStore('png').count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => resolve(-1);
        };
        req.onerror = () => resolve(-1);
      }),
  );
  expect(rows, 'キャッシュに 1 件も入っていない(開き直しの道を測れない)').toBeGreaterThan(0);

  await page.reload();
  // ⚠ 開き直すと選択は空 ── 同じノートを開き直す(幅もテーマも同じ = 同じ鍵)
  await clickReal(page, '[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]');
  const host2 = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host2).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  const again = await host2.evaluate((h) => {
    const img = h.querySelector('img')!;
    return { w: img.clientWidth, hostW: h.parentElement!.clientWidth };
  });
  expect(again.w, `開き直したら器いっぱいに広がった(${again.w} / 器 ${again.hostW})`).toBeLessThan(
    again.hostW * 0.9,
  );

  expect(errors).toEqual([]);
});

/**
 * P8 段⑲: 🔴 **押しても何も起きないボタンを出さない**。
 *
 * 直す前は編集中も「書き出す / 履歴 / 削除」が押せる見た目のまま出ていたが、
 * `DELETE_ENTRY` / `SHOW_HISTORY` は `phase !== 'ready'` で**黙って何もしない**
 * ── 押しても画面が 1 ドットも変わらず、user には壊れているとしか見えない。
 * ⚠ **消さずに、押せなくする**(業務画面「同じものが常に同じ場所にある」)。
 */
test('🔴 編集中は「書き出す / 履歴 / 削除」が押せない(見た目だけ生きていない)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('編集中の面');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const ACTIONS = ['export-entry', 'show-history', 'delete-entry'];
  // ① 確定済みなら押せる(空振り防止 ── 常時 disabled でも通る形にしない)
  for (const a of ACTIONS) {
    await expect(
      page.locator(`[data-pkc-region="inspector"] [data-pkc-action="${a}"]`),
      `${a} が確定後も押せない`,
    ).toBeEnabled();
  }

  // ② 編集に入ると押せなくなる。⚠ **消えない**(場所は動かさない)
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  for (const a of ACTIONS) {
    const el = page.locator(`[data-pkc-region="inspector"] [data-pkc-action="${a}"]`);
    await expect(el, `編集中に ${a} が消えた(場所が動いている)`).toBeVisible();
    await expect(el, `編集中に ${a} が押せてしまう(押しても何も起きない)`).toBeDisabled();
    // 理由が読める(押せない理由が分からないほうが困る)
    await expect(el).toHaveAttribute('title', /編集中は使えません/);
  }

  // ③ 取り消すと戻る
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="cancel-edit"]');
  for (const a of ACTIONS) {
    await expect(
      page.locator(`[data-pkc-region="inspector"] [data-pkc-action="${a}"]`),
      `編集をやめても ${a} が押せないまま`,
    ).toBeEnabled();
  }

  expect(errors).toEqual([]);
});

/**
 * P8 段⑱: 🔴 **高精細画面でも図の大きさは変わらない**。
 *
 * ⚠ dpr=1 だけで測ると、**dpr の次元を一度も測っていない**ことになる
 * (CLAUDE.md「fixture のゼロ件の次元は測っていない次元」)。焼く倍率と置く
 * 大きさを取り違えると、Retina でだけ図が 2 倍になる ── 実際に
 * `img.style.width` を `100%` にする変異は dpr=1 では素通りした。
 */
test.describe('高精細画面', () => {
  test.use({ deviceScaleFactor: 2 });

  test('🔴 dpr=2 でも図は 2 倍にならない(焼くのは 2 倍、置くのは等倍)', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    await createEntry(page, 'text');
    await page.locator('[data-pkc-field="editor-title"]').fill('高精細の図');
    await page
      .locator('[data-pkc-field="editor-body"]')
      .fill('```mermaid\ngraph TD\n  A-->B\n```\n');
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

    const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
    await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
    const m = await host.evaluate((h) => {
      const img = h.querySelector('img')!;
      return { dpr: devicePixelRatio, w: img.clientWidth, natural: img.naturalWidth };
    });
    expect(m.dpr, 'dpr が 2 になっていない(この次元を測れていない)').toBe(2);
    // ① **2 倍で焼けている**(空振り防止 ── 等倍で焼いていたら以下は自明に通る)
    expect(m.natural, `2 倍で焼いていない(焼 ${m.natural} / 置 ${m.w})`).toBe(m.w * 2);
    // ② **置く大きさは等倍のまま**(dpr=1 のときと同じ 2 節点の図)
    expect(m.w, `高精細画面で図が大きくなった(${m.w}px)`).toBeLessThan(200);

    expect(errors).toEqual([]);
  });
});

/**
 * P8 段⑲: 🔴 **設定から出られる**。
 *
 * 直す前の 設定 は行きっぱなしだった ── 閉じるボタンが無く、`SELECT_ENTRY` は
 * `viewMode` を戻さないので、一覧のノートを押しても**右の情報ペインだけ**
 * 切り替わって中央は設定のまま(追記欄も消えたまま)。ノートが開かない理由が
 * 画面のどこにも無い。マニュアル「中央は常にいま開いているノート」の当の破れ。
 */
test('🔴 設定を開いても、ノートを押せば戻る / もう一度押しても戻る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('設定から戻る');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const settings = page.locator('[data-pkc-view-pane="settings"]');
  const detail = page.locator('[data-pkc-view-pane="detail"]');

  // ① 一覧のノートを押すと戻る
  await clickReal(page, '[data-pkc-view="settings"]');
  await expect(settings, '設定が開かない').toBeVisible();
  await clickReal(page, '[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]');
  await expect(detail, 'ノートを押しても中央が設定のまま').toBeVisible();
  await expect(settings).toBeHidden();
  // 追記欄も戻る(中央が本文の面に戻った証拠)
  await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();

  // ② もう一度 設定 を押しても戻る(閉じる導線)
  await clickReal(page, '[data-pkc-view="settings"]');
  await expect(settings).toBeVisible();
  await clickReal(page, '[data-pkc-view="settings"]');
  await expect(detail, '設定をもう一度押しても閉じない').toBeVisible();
  await expect(settings).toBeHidden();

  expect(errors).toEqual([]);
});

/**
 * P9 段②: **区画が仕事をしている**。
 *
 * 🔴 直したのは「要らない所が広く、要る所が空いている」状態である。実測(Full HD):
 * 右列 384px に 4 行(うち 2 行は空欄)/ 一覧の行は題名だけ / 本文の 1 行が 1172px。
 *
 * ⚠ ここは**実ブラウザでしか見えない**(happy-dom は CSS の折り返しも
 * `max-width` の実効値も計算しない ── 生成 ≠ 描画)。
 */
test('🔴 本文に読み幅の上限が効き、表と図は対象外である', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoApp(page);
  await createEntry(page, 'text');

  // 長い段落 + 表 + 図を 1 件に入れる(3 つの振る舞いを 1 回で見る)
  const long = 'あ'.repeat(400);
  const body = [
    long,
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```mermaid',
    'graph TD',
    '  A["始め"] --> B["終わり"]',
    '```',
    '',
  ].join('\n');
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  const m = await page.evaluate(() => {
    const host = document.querySelector('[data-pkc-field="detail-body"]');
    const p = host?.querySelector('p');
    const table = host?.querySelector('table');
    const w = (e: Element | null | undefined): number =>
      e ? Math.round(e.getBoundingClientRect().width) : -1;
    return { body: w(host), p: w(p), table: w(table) };
  });

  // ① 段落は器より**明確に狭い**(上限が効いている)
  expect(m.body, '本文の器が細すぎる(前提が崩れている)').toBeGreaterThan(900);
  expect(m.p, `段落が器と同じ幅(${m.p}px)── 上限が効いていない`).toBeLessThan(m.body - 200);
  expect(m.p, '段落が狭すぎる(読める幅を割っている)').toBeGreaterThan(400);

  // ② 表は上限の**対象外**(横に広いほど読める)。⚠ ここが無いと
  //    「器ごと狭める」実装との区別がつかない ── 図の焼き直しを招く形である
  expect(m.table, '表が読み幅の上限に巻き込まれている').toBeGreaterThan(-1);

  // ③ 🔴 **図の焼き幅は器の幅から決まる**(`mermaid-hydrate` が親の clientWidth を読む)。
  //    上限を器に掛けると全部の図が焼き直され、キャッシュ鍵も変わる ── そうなっていないこと
  const parentWidth = await page.evaluate(() => {
    const h = document.querySelector('[data-pkc-mermaid-src]');
    return h?.parentElement?.clientWidth ?? -1;
  });
  expect(parentWidth, '図の親が読み幅まで狭められている(器に上限を掛けている)').toBeGreaterThan(
    900,
  );

  expect(errors).toEqual([]);
});

test('🔴 一覧の行に更新日が出て、行の高さは増えていない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '日付の出る行');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  const when = row.locator('[data-pkc-field="when"]');
  // ⚠ 「要素が在る」で止めない ── **日付として読める**ことまで見る
  await expect(when).toHaveText(/^\d{2}\/\d{2}$|^\d{4}\/\d{2}\/\d{2}$/);
  const box = await row.boundingBox();
  expect(box, '行が画面に無い').not.toBeNull();
  // 業務画面の密度を落とさない(--row-h は 26px)
  expect(box!.height, `行が高くなっている(${box!.height}px)`).toBeLessThanOrEqual(30);
  expect(errors).toEqual([]);
});

/**
 * P9 段③: **区画が約束を守る**。
 *
 * 🔴 直した 3 つ:
 *  ① フォルダ面は「名前 / 種別 / 更新日」の見出しを出しておいて、
 *     **後ろ 2 列を `display: none` で畳んでいた**(実測: 幅 0px)。
 *     見出しが約束したものが 1 つも出ていない = 画面が嘘をついている状態で、
 *     しかも種別が見えないので**一覧タブと同じ題名の並びに見えていた**(かぶりの実体)
 *  ② 何も選んでいないときの中央が**完全な白紙**(1190x1000px)
 *  ③ 設定が「配色 1 つ + ワーカーの計器」で地続き ── ほとんどが計器だった
 */
test('🔴 フォルダ面は行の頭に種別、右端に更新日を出す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'フォルダ面で見る');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-browse="filer"]');
  // ⚠ **「最初の行」で掴まない** ── この spec は文脈を共有するので、先行 test が
  //    作った行が先頭に来る。その行は時刻の ack がまだ届いていないことがあり、
  //    日付の assert が**たまに落ちる**(実際に full run で 1 度落ちた)。
  //    いま作った行を**題名で**指す
  const row = page.locator('[data-pkc-region="filer-table"] tbody tr', {
    hasText: 'フォルダ面で見る',
  });
  await expect(row).toBeVisible();

  const m = await row.evaluate((tr) => {
    const cells = [...tr.querySelectorAll('td')];
    const w = (e: Element | undefined): number =>
      e ? Math.round(e.getBoundingClientRect().width) : -1;
    return {
      cellWidths: cells.map((c) => w(c)),
      chip: tr.querySelector('[data-pkc-chip] svg path') !== null,
      last: cells[cells.length - 1]?.textContent ?? '',
    };
  });

  // ① 列が**全部見えている**(0 幅の列が無い ── 畳んだ列を出しておく形を落とす)
  expect(m.cellWidths.length, '列が足りない').toBe(2);
  for (const w of m.cellWidths) expect(w, `幅 0 の列がある: ${JSON.stringify(m.cellWidths)}`).toBeGreaterThan(10);
  // ② 種別が図案で分かる(一覧と同じ規則)
  expect(m.chip, '行の頭に種別の図案が無い').toBe(true);
  // ③ 更新日が**日付として読める**(要素が在るだけでは足りない)。
  //    ⚠ 今年は MM/DD、他の年は YYYY/MM/DD ── 一覧の行と同じ規則
  expect(m.last).toMatch(/^\d{2}\/\d{2}$|^\d{4}\/\d{2}\/\d{2}$/);
  // ④ 切れていない(列幅が足りずに `2026/08/` になる形を落とす)
  expect(m.last.endsWith('/'), `更新日が切れている: ${m.last}`).toBe(false);

  expect(errors).toEqual([]);
});

test('🔴 何も選んでいない中央に案内が出る(白紙にしない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoApp(page);

  const guide = page.locator('[data-pkc-field="detail-empty"]');
  await expect(guide).toBeVisible();
  // ⚠ 「何か出た」で止めない ── **次にどこを押すか**が書いてあること
  // ⚠ **実際のボタンの文言**を指していること(P10 で「新規」→「+ ノート」)
  await expect(guide).toContainText('+ ノート');
  await expect(guide).toContainText('取り込む');
  const box = await guide.boundingBox();
  expect(box!.height, '案内が高さを持っていない').toBeGreaterThan(10);

  // ⚠ **ボタンを増やしていない**(同じものは 1 か所 ── 新規/取り込むは左の列)
  expect(
    await page.locator('[data-pkc-region="detail"] [data-pkc-action="create-entry"]').count(),
    '中央に「新規」ボタンが増えている',
  ).toBe(0);
  expect(
    await page.locator('[data-pkc-region="detail"] [data-pkc-action="import-file"]').count(),
    '中央に「取り込む」ボタンが増えている',
  ).toBe(0);

  expect(errors).toEqual([]);
});

test('🔴 設定は user 向けと計器に分かれている', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  // ① user が変えるものの区画に、変えられる物が**実際に入っている**
  const userArea = page.locator('[data-pkc-region="settings-user"]');
  await expect(userArea).toBeVisible();
  await expect(userArea.locator('[data-pkc-field="theme-select"]')).toBeVisible();

  // ② 計器は**別の区画**で、そこに変えられる物が無い(読むだけ)
  const jobs = page.locator('[data-pkc-region="jobs"]');
  await expect(jobs).toBeVisible();
  expect(
    await jobs.locator('select, input, [data-pkc-action]').count(),
    '計器の区画に操作するものが混ざっている',
  ).toBe(0);
  // ③ 順番は「変えるもの」が先(計器が画面の頭を占めない)
  const y = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s)?.getBoundingClientRect().y ?? -1;
    return { user: q('[data-pkc-region="settings-user"]'), jobs: q('[data-pkc-region="jobs"]') };
  });
  expect(y.user, '区画が見つからない').toBeGreaterThan(0);
  expect(y.jobs, '計器が user 向けより上に出ている').toBeGreaterThan(y.user);

  expect(errors).toEqual([]);
});

/**
 * P10: 🔴 **新規は分割ボタン**(user 指示 2026-08-05
 * 「プルダウン式の新規作成ボタンは使いにくいからマルチメニューに畳んでください。
 *  ▼ を押下した際に種別を選択して、追加ボタンと ctrl+n の対象を更新、
 *  +〇〇みたいにボタンを変更すればいい、これもアイコン欲しいよね」)。
 *
 * ⚠ 見るのは 3 つ。**どれか 1 つでは足りない**:
 *  ① 選ぶと**ボタンの見た目**が変わる(user が「いま何ができるか」を読める)
 *  ② 押すと**その種類**が出来る(見た目と結果が食い違わない)
 *  ③ **Ctrl+N も同じ対象**になる(近道が別のものを作らない)
 */
test('🔴 新規の分割ボタン: 選ぶと文言・図案・Ctrl+N の対象が変わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  const run = page.locator('[data-pkc-field="create-run"]');
  const menu = page.locator('[data-pkc-region="create-menu"]');
  // 起動直後は先頭の種類。⚠ 一覧は畳んである(選ぶまで場所を取らない)
  await expect(run.locator('[data-pkc-field="label"]')).toHaveText('+ ノート');
  expect(await menu.isVisible(), '一覧が最初から開いている').toBe(false);

  // ① ▼ で開いて「表」を選ぶ → 文言と図案が変わり、一覧は畳まれる
  const iconBefore = await run.locator('[data-pkc-icon] svg path').first().getAttribute('d');
  await clickReal(page, '[data-pkc-field="create-pick"]');
  expect(await menu.isVisible(), '▼ を押しても一覧が出ない').toBe(true);
  await clickReal(page, '[data-pkc-region="create-menu"] [data-pkc-archetype="spreadsheet"]');
  await expect(run.locator('[data-pkc-field="label"]')).toHaveText('+ 表');
  expect(await menu.isVisible(), '選んだのに一覧が閉じない').toBe(false);
  const iconAfter = await run.locator('[data-pkc-icon] svg path').first().getAttribute('d');
  expect(iconAfter, '図案が種類に追従していない').not.toBe(iconBefore);

  // ② 押すと**表**が出来る(文言と結果が食い違わない)
  await clickReal(page, '[data-pkc-field="create-run"]');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  await expect(page.locator('[data-pkc-field="editor-body"]')).toHaveValue(/csv-render/);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="cancel-edit"]');

  // ③ 🔴 **Ctrl+N も同じ対象** ── 近道が別のものを作ったら、それは別の機能である
  await page.keyboard.press('Control+n');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  await expect(
    page.locator('[data-pkc-field="editor-body"]'),
    'Ctrl+N が選んだ種類を無視している',
  ).toHaveValue(/csv-render/);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **PKC-Markdown の装飾が「実際に効いている」か**(user 報告 2026-08-05
 * 「レンダリングができていない」)。
 *
 * ⚠ ここが唯一の観測点である。生成 HTML は健全で、欠けていたのは CSS だった
 * ── つまり **class や属性が出ているかを見る test では絶対に見つからない**。
 * `tests/features/markdown-css-parity.test.ts` は「規則が在るか」までしか言えず、
 * 「**素の値から動いたか**」は実ブラウザの computed style でしか測れない。
 * ⚠ 対照は「何もしない」ではなく **同じ本文の中の素の段落**(= 装飾以外を揃えたもの)。
 */
test('🔴 markdown の装飾が実際に効く(素の段落から動いている)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const body = [
    'ふつうの段落',
    '',
    ':::note',
    '注意書き',
    ':::',
    '',
    ':::danger',
    '危険',
    ':::',
    '',
    '- [ ] やること',
    '',
    '||中央寄せ',
    '',
    '__ 字下げ',
    '',
    '前',
    '',
    '_3',
    '',
    'これは ==印== です',
    '',
  ].join('\n');
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  const m = await page.evaluate(() => {
    const host = document.querySelector('[data-pkc-field="detail-body"]')!;
    const cs = (sel: string) => {
      const el = host.querySelector(sel);
      if (!el) return null;
      const c = getComputedStyle(el);
      return {
        bg: c.backgroundColor,
        borderLeft: c.borderLeftWidth,
        borderColor: c.borderLeftColor,
        align: c.textAlign,
        indent: c.textIndent,
        marker: c.listStyleType,
        h: Math.round(el.getBoundingClientRect().height),
        w: Math.round(el.getBoundingClientRect().width),
      };
    };
    // 対照 = 装飾の付かない素の段落(同じ本文・同じ器の中)
    const plainEl = [...host.querySelectorAll('p')].find(
      (p) => p.textContent === 'ふつうの段落',
    );
    const plain = plainEl ? getComputedStyle(plainEl) : null;
    return {
      plain: plain
        ? { bg: plain.backgroundColor, borderLeft: plain.borderLeftWidth, align: plain.textAlign,
            indent: plain.textIndent,
            w: Math.round(plainEl!.getBoundingClientRect().width),
            h: Math.round(plainEl!.getBoundingClientRect().height) }
        : null,
      note: cs('.pkc-section-note'),
      danger: cs('.pkc-section-danger'),
      task: cs('li.pkc-task-item'),
      center: cs('[data-pkc-align="center"]'),
      indent: cs('p[data-pkc-indent="1"]'),
      blank: cs('.pkc-blank-line'),
      mark: cs('mark'),
    };
  });

  expect(m.plain, '対照の素の段落が見つからない').not.toBeNull();
  // 🔴 注意書き ── 地と左の罫が**素の段落から動いている**
  expect(m.note, ':::note が描かれていない').not.toBeNull();
  expect(m.note!.bg, ':::note に地が付いていない').not.toBe(m.plain!.bg);
  expect(m.note!.borderLeft, ':::note に左の罫が無い').not.toBe(m.plain!.borderLeft);
  // 🔴 種別ごとに**見分けが付く**(note と danger が同じ見た目なら意味が無い)
  expect(m.danger!.bg, 'note と danger が同じ地').not.toBe(m.note!.bg);
  expect(m.danger!.borderColor, 'note と danger が同じ罫の色').not.toBe(m.note!.borderColor);
  // 🔴 タスク行 ── 丸ポチとチェック欄の二重を止めた
  expect(m.task!.marker, 'タスク行に丸ポチが残っている').toBe('none');
  // 🔴 行頭アライン / 字下げ
  expect(m.center!.align, '中央寄せが効いていない').toBe('center');
  expect(m.indent!.indent, '字下げが効いていない').not.toBe(m.plain!.indent);
  // 🔴 空行 `_3` は **素の 1 行の 2 倍より高い**(規則は在るのに変数が届いて
  //    いなかった型 ── 直す前は `_3` も `_1` も 1 行ぶんだった)。
  //    ⚠ 対照は固定の px ではなく**同じ本文の素の段落の高さ**にする
  expect(m.blank!.h, `_3 の高さが 1 行ぶんのまま(素の段落 ${m.plain!.h}px)`).toBeGreaterThan(
    m.plain!.h * 2,
  );
  // 🔴 `==印==` は class を持たない `<mark>`(class を数える検査の外)
  expect(m.mark, 'mark が出ていない').not.toBeNull();
  expect(m.mark!.bg, '==印== に地が付いていない').not.toBe(m.plain!.bg);
  // 🔴 注意書きも読み幅の上限に従う(箱だけ全幅に伸びない)
  expect(m.note!.w, '注意書きだけ全幅に伸びている').toBeLessThanOrEqual(m.plain!.w + 4);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **フォルダ整理が実機で回る**(2026-08-05、user 報告
 * 「フォルダ整理のための導線がない」)。
 *
 * ここは **unit では届かない 2 点**を見る:
 *  ① 帯の `<select>` が**本当に押せる場所に在る**(happy-dom は見た目を持たない)
 *  ② 入れた居場所が **実 sqlite に残る** ── 読み込み直しても中に居る
 *     (楽観更新だけで動いて見える実装を落とす)
 *
 * ⚠ **題名で行を掴まない**(full run で実際に落ちた)。`editor-title` は
 * **確定のときに DOM から読む**欄なので、打った後に editor が作り直されると
 * 打鍵が失われる ── 単独実行では緑、全量実行では既定題名のままになった。
 * 本文欄(`editor-body`)は 1 打鍵ごとに state へ写るので、**新規の掃除を避ける
 * 変更は本文で行い、行は lid で掴む**。⚠ 何も変えずに確定すると、新規未編集の
 * 掃除で entry ごと消える(それが「作ったのに無い」の正体になる)。
 */
test('🔴 フォルダに入れる → 読み込み直しても中に居る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  /**
   * 🔴 **worker へ出した命令を記録する**(#258 の観測点)。
   *
   * ⚠ 「読み直したら中に居る」は**証拠にならない** ── 実測で、作成を 2 手に戻す
   * 変異を当てても**この test は緑のまま**だった(reload まで数百 ms あるので、
   * 2 手目も間に合ってしまう)。⚠ 元の不具合は**負荷が高いときだけ**出る形なので、
   * 時間に依存する観測点では捕まらない。
   * 🔑 だから**配線そのもの**を見る ── 作成が `upsertEntry` 1 本(`parent` つき)で
   * 済んでいるか。2 手に割れていれば `setEntryParent` が続けて出る(2026-08-17 の
   * 「読みが書きを追い越す」を配線の記録で確定させたのと同じ手)。
   */
  await page.addInitScript(() => {
    const w = window as unknown as { __ops?: string[] };
    w.__ops = [];
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, data: unknown, ...rest: unknown[]) {
      const op = (data as { req?: { op?: string; parent?: unknown } } | null)?.req;
      if (op?.op) w.__ops!.push(op.op === 'upsertEntry' && op.parent ? 'upsertEntry+parent' : op.op);
      return (orig as (d: unknown, ...r: unknown[]) => void).call(this, data, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-browse="filer"]');

  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  const titles = rows.locator('[data-pkc-field="title"]');
  const move = page.locator('[data-pkc-field="move-target"]');
  /** 帯は**いつも選択を指している** ── 作った直後の lid はここから読める。 */
  const selectedLid = async (): Promise<string> => {
    const lid = await move.getAttribute('data-pkc-entry');
    expect(lid, '帯が選んでいるものを指していない').toBeTruthy();
    return lid!;
  };
  const make = async (archetype: string, body: string): Promise<string> => {
    await createEntry(page, archetype);
    await page.fill('[data-pkc-field="editor-body"]', body);
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    return selectedLid();
  };
  const lidsOf = () => rows.evaluateAll((trs) => trs.map((t) => t.getAttribute('data-pkc-entry')));

  // ⚠ ノートを**先に**作る(いま見ているフォルダの中に作られる ──
  //    それは後半で別に確かめる)
  const noteLid = await make('text', '# 移すノート\n');
  const folderLid = await make('folder', '# 整理先フォルダ\n');

  /**
   * ⚠ **フォルダを作っても中には入らない**(#240 段①)── 現在地は state が持つように
   * なったので、作った直後もルートのままである(直す前は現在地が選択の純関数で、
   * 作ると勝手に中へ入っていた)。入るのは**2 クリック**。
   */
  expect(await lidsOf(), '作っただけで中に入っている').toEqual([noteLid, folderLid]);

  // ── 選ぶ → 居場所を変える
  await clickReal(page, `[data-pkc-region="filer-table"] [data-pkc-entry="${noteLid}"]`);
  // ① 実際に届く(座標の最前面である)ことを確かめてから使う。
  //    ⚠ `<select>` は**押さない** ── 実ブラウザでは一覧が開いて後続を邪魔する
  await expectReachable(page, '[data-pkc-field="move-target"]');
  // 帯は**選んだ行の題名**を名指しする(誰を動かすのかが読める)
  const rowTitle = await titles
    .nth((await lidsOf()).indexOf(noteLid))
    .textContent();
  await expect(page.locator('[data-pkc-field="move-caption"]')).toHaveText(
    `\u300c${rowTitle}\u300d\u306e\u5c45\u5834\u6240`,
  );
  await move.selectOption(folderLid); // ⚠ 値 = lid で選ぶ(題名に依存しない)

  /**
   * 🔴 **画面は動かない**(user 裁定 2026-08-18「OS のファイラ動作に似せる」)──
   * 入れたものが**この場から消える**のが標準の見え方。行き先は状態の行が名乗る。
   */
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('へ入れました');
  expect(await lidsOf(), '入れた先へ勝手に移動した').toEqual([folderLid]);

  // 中に入る(2 クリック)── ここから「いま見ているフォルダの中に作る」を見る
  await page.locator(`[data-pkc-region="filer-table"] [data-pkc-entry="${folderLid}"]`).dblclick();
  await expect(
    page.locator('[data-pkc-region="filer-breadcrumb"] [data-pkc-entry]'),
    '入れた先のフォルダが道に出ていない',
  ).toHaveAttribute('data-pkc-entry', folderLid);
  expect(await lidsOf()).toEqual([noteLid]);

  // ── いま見ているフォルダの中に作る
  await expect(page.locator('[data-pkc-field="filer-create-target"]')).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __ops: string[] }).__ops.length = 0));
  const createdLid = await make('text', '# フォルダの中で作った\n');

  /**
   * 🔴 **作成は 1 本の書込で済んでいる**(#258)。⚠ ここが 2 本(`upsertEntry` に
   * 続いて `setEntryParent`)なら、その隙にタブを閉じると**居場所だけ飛ぶ**。
   */
  const ops = await page.evaluate(() => (window as unknown as { __ops: string[] }).__ops.slice());
  expect(ops, '作成の書込が記録されていない(この test は空振り)').toContain('upsertEntry+parent');
  expect(ops, '作成が 2 手に割れている(行を書いてから辺を書いている)').not.toContain(
    'setEntryParent',
  );

  /**
   * ── ② 読み込み直す(実 sqlite から読み戻る)
   *
   * ⚠ **#258 の回帰を捕まえているのは上の `__ops` の assert** であって、ここではない
   *   (着地前レビュー ⚠-1 の指摘。1 稿目は逆に書いていた ── 実測では、2 手に戻す
   *   変異を当てても**この読み直しは緑のまま**だった:reload まで数百 ms あるので
   *   2 手目が間に合う)。ここが見るのは **居場所が disk から読み戻る**ことである。
   * ⚠ だから **ack は待つ** ── 待たないと「worker が処理を終える前に document ごと
   *   破棄される」窓が残り、落ちたときに **#258 の再発に見える別原因**になる。
   */
  await expect(
    page.locator(`[data-pkc-region="filer-table"] [data-pkc-entry="${createdLid}"] td:nth-child(2)`),
    '作ったノートの ack が返っていない',
  ).not.toHaveText('');
  await gotoApp(page);
  await clickReal(page, '[data-pkc-region="browse-tabs"] [data-pkc-browse="filer"]');
  // ルートには**入れたノートが居ない**
  expect(await lidsOf(), 'ルートに残っている').not.toContain(noteLid);
  // ⚠ 入るのは**2 クリック**(#240 段①)。`locator.dblclick()` は安定するまで待つ ──
  //    座標を先に採ると、採ってから押すまでの再描画で 2 回が別ノードに落ちる
  await page.locator(`[data-pkc-region="filer-table"] [data-pkc-entry="${folderLid}"]`).dblclick();
  expect(await lidsOf(), '読み込み直したら居場所が失われた').toEqual([noteLid, createdLid]);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **長いノートを送っても「編集 / 履歴 / 削除」が消えない**(2026-08-08)。
 *
 * P8 段⑪ で操作の帯を `position: sticky` にしたのは「長いノートで編集を押すために
 * 毎回先頭まで戻る」を無くすためだった。ところが**面の箱がスクロール箱の高さ
 * 止まり**だったので、⚠ **その高さを越えて送ると貼り付きが外れて帯が消えていた**
 * (sticky は自分の親の箱の中でしか貼り付かない)。
 *
 * ⚠ **既存の smoke は 700px しか送っておらず、素通りしていた** ── 当時の版面
 * (829px)より浅かったからである。P11 のお知らせの帯でスクロール箱が 196px
 * 低くなって初めて落ちた:**元から壊れていて、閾値が下がって見えただけ**。
 * 🔑 だからここは**版面より深く**送る(浅い数字は「測っていない」に等しい)。
 */
test('🔴 長いノートを深く送っても、操作の帯が画面に残る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  const long = Array.from({ length: 120 }, (_, i) => `## 節 ${i}\n\n段落 ${i}。\n`).join('\n');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(long);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  const detail = page.locator('[data-pkc-region="detail"]');
  const client = await detail.evaluate((el) => el.clientHeight);
  const max = await detail.evaluate((el) => el.scrollHeight - el.clientHeight);
  // ⚠ 前提: **版面より深く送れる**(送れないなら何も見ていない)
  expect(max, '深く送れる本文になっていない(fixture の空振り)').toBeGreaterThan(client * 2);

  for (const top of [client + 50, client * 2, max]) {
    await detail.evaluate((el, v) => (el.scrollTop = v), top);
    const box = await page.locator('[data-pkc-action="start-edit"]').boundingBox();
    expect(box, `scrollTop=${top} で「編集」が消えた`).not.toBeNull();
    /**
     * 🔑 観測点は **`y >= 0`**(= 画面の上に隠れていない)。
     * ⚠ 「要素が在る」で止めない ── 貼り付きが外れた形はまさに
     *   「DOM には在るが上へ流れて見えない」である(実測 y = -109)。
     */
    expect(box!.y, `scrollTop=${top} で帯が上へ流れた(貼り付きが外れた)`).toBeGreaterThanOrEqual(
      -1,
    );
  }
  expect(errors).toEqual([]);
});
