/**
 * 🔴 **自由配置の板**(#283 P4)を、実ブラウザで見る。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 塊が**実際にその座標に描かれる**(CSS の position が効く) | happy-dom は layout を持たない |
 * | 🔴 **実マウスの掴み → 本文の x= / y= が書き替わり、描き直しても残る** | pointer capture・座標・保存の往復は実物でしか通らない |
 *
 * 🔑 観測点は **data-pkc-x(本文の記法から描き直された値)** ── style だけ見ると
 *   「見た目は動いたが本文に書けていない」を素通りする(#513 の「成功と同じ見た目」の型)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **線の宣言を末尾に持つ**(#530 段③a)。
 *
 * ⚠ 足す前、この spec は `from=` / `to=` を **1 件も持っていなかった** ──
 *   `applyPlaceLines` は線が 0 本なら `<svg>` を作らずに戻るので、
 *   **層が板の上に敷かれた状態**は実ブラウザで 1 度も作られていなかった
 *   (CLAUDE.md §2「経路が一度も通っていない」)。掴む口が層に塞がれないことは、
 *   層が在って初めて確かめられる。
 * ⚠ **末尾に置く** ── 既存の test が当てにしている `#p1` / `#p2` の
 *   `data-pkc-source-line` を動かさないため。
 */
const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place x=460 y=40 w=200 h=120}',
  'めも',
  ':::',
  '',
  ':::format{.pkc-line from=p1 to=p2}',
  ':::',
  /**
   * 🔴 **日本語の名前**(#530、user 裁定 2026-09-15)。
   * ⚠ 上の `#p1` / `#p2` が**対照群**である ── 同じ筋書きの中に ASCII と日本語が
   *   並ぶので、「両方まとめて壊れた日」を緑と読めない。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── 既に在る道中に足す。
   */
  '',
  ':::format{#今日 .pkc-place x=120 y=300 w=200 h=120}',
  'にほんご',
  ':::',
  '',
  ':::format{#明日 .pkc-place x=460 y=300 w=200 h=120}',
  'となり',
  ':::',
  '',
  ':::format{.pkc-line from=今日 to=明日}',
  ':::',
  /** ⚠ 使えない名前は今までどおり断る ── 広げたのは**字の種類だけ**である。 */
  '',
  ':::format{.pkc-line from=a.b to=今日}',
  ':::',
].join('\n');

test('🔴 板の塊が座標に置かれ、掴んで動かすと本文が書き替わる (#283 P4)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板のノート');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 🔴 2 つの塊が、書いた座標に置かれている(相対位置で見る ── 器の原点に依らない)
  const p1 = page.locator('[data-pkc-region="detail"] #p1');
  const p2 = page.locator('[data-pkc-region="detail"] #p2');
  await expect(p1).toBeVisible();
  const b1 = (await p1.boundingBox())!;
  const b2 = (await p2.boundingBox())!;
  expect(Math.round(b2.x - b1.x), '横の並びが記法どおりでない').toBe(460 - 120);
  expect(Math.round(b2.y - b1.y), '縦の並びが記法どおりでない').toBe(0);
  expect(Math.round(b1.width), '幅が記法どおりでない').toBe(320);

  /**
   * 🔴 **線が実際に引かれ、層が掴む口を塞がない**(#530 段③a)。
   *
   * ⚠ ここが**実ブラウザでしか見られない所**である ── happy-dom は
   *   `offsetWidth` に 0 を返すので、unit が通るのは「測れないときは札へ落とす」枝だけ。
   *   **測って引く枝**はこの 1 行でしか走らない。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── この筋書きの続きで確かめる。
   */
  const lines = page.locator('[data-pkc-field="place-lines"] line');
  /**
   * ⚠ **2 本である** ── ASCII の `p1 → p2` と、日本語の `今日 → 明日`(#530)。
   * 🔑 3 本目(`from=a.b`)は**引けてはいけない** ── 等値で見るので、
   *   使えない名前を黙って通した日にここが落ちる。
   */
  await expect(lines, '線の本数が違う(日本語の名前が引けていないか、断るはずの線を引いた)')
    .toHaveCount(2);
  const line = lines.first();
  const x1Before = Number(await line.getAttribute('x1'));
  expect(Number.isFinite(x1Before) && x1Before > 0, `線の座標が読めない(x1=${x1Before})`).toBe(
    true,
  );
  /**
   * 🔴 **日本語の名前が、そのまま `id` として実ブラウザの DOM に載る**(#530)。
   *
   * ⚠ unit(happy-dom)では「名前を受けたか」しか見られない ── ここで見るのは
   *   **実ブラウザが非 ASCII の `id` を素直に持つか**と、
   *   **その名前で線が引けたか**(= 引く側が `Map` の鍵として名前を使えている)。
   * 🔑 名前は `place-board.ts:244-245` で `el.id` から `Map` を作るだけで、
   *   **選択子を組み立てる所は 1 つも無い**(実測)── だから risk はここに閉じる。
   */
  await expect(
    page.locator('[data-pkc-region="detail"] [id="今日"]'),
    '日本語の名前が id として載っていない',
  ).toBeVisible();
  /** ⚠ 使えない名前(`a.b`)には、断りの 1 行が出る ── 黙って消えない。 */
  await expect(
    page.locator('[data-pkc-field="place-line-note"]'),
    '使えない名前の断りが出ていない(または、要らない断りが出ている)',
  ).toHaveCount(1);
  await expect(page.locator('[data-pkc-field="place-line-note"]')).toContainText(
    '名前に「a.b」は使えません',
  );

  /**
   * 🔴 **層が「板の無い所」で最前面に来ていない**(= `pointer-events: none` が効いている)。
   *
   * ⚠ 1 稿目はここで**掴む口の上**を見ていたが、変異試験が **SURVIVED** で教えた ──
   *   掴む口は `host.prepend(svg)` の帰結で**そもそも層より前面**に居るので、
   *   `pointer-events` を外しても値が 1 ビットも動かない(CLAUDE.md §1「救い手が変わっただけ」)。
   * 🔑 層が本当に守っているのは**流れの中の中身**(本文の段落・リンク)である ──
   *   層は `inset: 0` で器いっぱいに広がり、位置を持たない中身は層より後ろに描かれる。
   *   だから見るのは「**板の無い所で、いちばん上に居るのは層ではない**」。
   */
  const hostBox = (await page.locator('[data-pkc-field="detail-body"]').boundingBox())!;
  const gapField = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el?.closest('[data-pkc-field]')?.getAttribute('data-pkc-field') ?? null;
    },
    // ⚠ 板が居るのは x=120..440 / x=460..660 の 2 本の帯(y=40..240 と y=300..420)。
    //   だから**その左**の空き地(x≒40)を、いちばん下の高さで採る ──
    //   ⚠ #530 で日本語の板を y=300 に足したので、「下が空き地」ではなくなった
    [hostBox.x + 40, hostBox.y + hostBox.height - 12],
  );
  expect(gapField, '板の無い所で線の層が最前面に来ている(本文が押せなくなる)').not.toBe(
    'place-lines',
  );
  // ⚠ 対照群: 掴む口の上では grip が採れる(この観測点そのものが死んでいない証拠)
  const gripBox = (await page.locator('#p1 [data-pkc-field="place-grip"]').boundingBox())!;
  const onGrip = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el?.closest('[data-pkc-field]')?.getAttribute('data-pkc-field') ?? null;
    },
    [gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2],
  );
  expect(onGrip, '掴む口が採れない(この検査が空振りしている)').toBe('place-grip');

  // 🔴 掴んで動かす ── grip を実マウスで掴み、+100 / +60 動かして離す
  const grip = page.locator('#p1 [data-pkc-field="place-grip"]');
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 100, g.y + g.height / 2 + 60, { steps: 5 });
  await page.mouse.up();

  /**
   * 🔴 観測点は**本文から描き直された属性** ── 保存 → 再読込 → 再描画の往復が
   * 通って初めてこの値になる(style だけなら掴んだ瞬間に変わってしまう)。
   */
  await expect(p1, '本文に書き戻されていない(見た目だけ動いた)').toHaveAttribute(
    'data-pkc-x',
    '220',
    { timeout: 5000 },
  );
  await expect(p1).toHaveAttribute('data-pkc-y', '100');

  // ⚠ 対照群: 掴んでいない塊は動いていない
  await expect(p2).toHaveAttribute('data-pkc-x', '460');

  // 🔴 **線は板に付いてくる**(座標を持たず、毎回引き直している証拠)
  await expect
    .poll(async () => Number(await line.getAttribute('x1')), {
      message: '板を動かしたのに線が置き去りになっている',
      timeout: 5000,
    })
    .not.toBe(x1Before);

  /**
   * 🔴 **形を変えても、掴む口は押せる**(#530 案 A。user 裁定 2026-09-14)。
   *
   * ⚠ **ここが実ブラウザでしか見られない所である。** 掴む口(右上)と大きさの
   *   持ち手(右下)は板の**子**なので、板そのものを切り抜く実装にすると
   *   **四隅ごと切り取られて押せなくなる**(無言の dead click)── unit の DOM では
   *   `clip-path` が効かないので、この壊れ方は 1 件も落ちない。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── この筋書きの続きで確かめる。
   *
   * 🔴 **相手は `#p2` である**(1 稿目は `#p1` でやって落ちた。2026-09-14 の実測)。
   * ⚠ 理由は形とは**何の関係も無い** ── 上で `#p1` を (220,100) へ動かすと
   *   幅 320 の `#p1` は `#p2`(x=460)と**画面上で重なる**。重なった所では
   *   **本文で後に書かれた `#p2` が前に来る**(`z-index: auto` の兄弟は DOM 順)ので、
   *   `#p1` の掴む口の上に居るのは `#p2` であり、掴めない。
   *   🔑 これは**製品の仕様**である(だから「前へ出す」が在る)── 形を変えずに
   *   同じ手順を踏んでも同じように掴めないことを、対照群で確かめてある。
   * ⚠ だから**動かしていない `#p2`**(いちばん前に居る)で見る。
   */
  await p2.click({ button: 'right' });
  const blockMenu = page.locator('[data-pkc-region="context-menu"]');
  await expect(blockMenu, '板の右クリックで一覧が出ない').toBeVisible();
  // ⚠ **いま四角なので「四角にする」は出ない**(押しても変わらない口を作らない)
  await expect(
    blockMenu.locator('[data-pkc-action="place-shape-rect"]'),
    'いまの形が一覧に出ている',
  ).toHaveCount(0);
  await blockMenu.locator('[data-pkc-action="place-shape-diamond"]').click();

  // 🔴 観測点は**本文から描き直された属性**(見た目だけ変えた実装では真にならない)
  await expect(p2, 'ひし形が本文に書き戻されていない').toHaveAttribute(
    'data-pkc-shape',
    'diamond',
    { timeout: 5000 },
  );
  // ⚠ 対照群: 隣の板は四角のまま(形が板をまたいで漏れていない)
  await expect(p1).not.toHaveAttribute('data-pkc-shape', 'diamond');

  /**
   * 🔴 **ひし形にした板を、掴んで動かす** ── これが本題である。
   * ⚠ `boundingBox()` は「見えているか」を見ない ── **実マウスで掴んで、
   *   本文の `x=` が動くこと**まで見て初めて「押せる」と言える。
   */
  const grip2 = page.locator('#p2 [data-pkc-field="place-grip"]');
  const g2 = (await grip2.boundingBox())!;
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await page.mouse.down();
  await page.mouse.move(g2.x + g2.width / 2 + 40, g2.y + g2.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(p2, 'ひし形にしたら掴む口が押せなくなった(切り取られている)').toHaveAttribute(
    'data-pkc-x',
    '500',
    { timeout: 5000 },
  );

  /**
   * 🔴 **残りの 3 形も、掴む口が生きていることまで見る**(#530 案 A)。
   *
   * ⚠ ひし形だけ見て「形を変えても掴める」と書くのは**測った範囲より広い主張**である。
   *   4 形は同じ仕掛け(`::before` / `::after` の層 + `pointer-events: none`)だが、
   *   ⚠ **同じはずだから測らない**は判断ではなく横着である。
   * 🔑 ここは**起動も往復も増やさない** ── 形を選び直して、
   *   掴む口の真ん中に**掴む口そのものが乗っているか**を 1 回ずつ見るだけ。
   */
  for (const shape of ['round', 'ellipse', 'arrow'] as const) {
    await p2.click({ button: 'right' });
    await blockMenu.locator(`[data-pkc-action="place-shape-${shape}"]`).click();
    await expect(p2, `${shape} が本文に書き戻されていない`).toHaveAttribute(
      'data-pkc-shape',
      shape,
      { timeout: 5000 },
    );
    const box = (await page.locator('#p2 [data-pkc-field="place-grip"]').boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x as number, y as number)?.getAttribute('data-pkc-field') ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit, `${shape} にしたら、掴む口の上に別の物が乗っている`).toBe('place-grip');
  }
  // ⚠ 最後は四角へ戻せる(片道の操作を作らない)
  await p2.click({ button: 'right' });
  await blockMenu.locator('[data-pkc-action="place-shape-rect"]').click();
  await expect(p2, '四角へ戻せない').toHaveAttribute('data-pkc-shape', 'rect', { timeout: 5000 });

  expect(errors, 'pageerror が出た').toEqual([]);
});

test('🔴 entry= の塊は題名の札になり、押すとそのノートを開く (#283 P4)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  // 相手のノートを先に作り、lid を一覧の行から読む
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '相手のノート');
  await page.fill('[data-pkc-field="editor-body"]', '中身\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const lid = await page
    .locator('[data-pkc-region="sidebar"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(lid, '前提が崩れている(相手の lid が読めない)').not.toBeNull();

  // 板のノートを作る(札 1 枚)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    `:::format{.pkc-place entry=${lid} x=60 y=30 w=240 h=100}\n:::\n`,
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 🔴 札に相手の題名が出る(展開ではない ── 中身は写らない)
  const card = page.locator('[data-pkc-field="place-card"]');
  await expect(card, '札に題名が出ていない').toHaveText('相手のノート');

  // 🔴 押すと相手のノートが開く
  await clickReal(page, '[data-pkc-field="place-card"]');
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-title"]'),
    '押しても相手が開かない',
  ).toHaveText('相手のノート');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **右クリックで板を置く**(#676)── 押した座標が本文の `x=` / `y=` になる。
 * ⚠ unit(happy-dom)では器の rect が 0 なので、「器の左上からの差」という座標変換は
 *   実ブラウザでしか見えない(padding / 枠線 / スクロール位置が効く当の所)。
 */
test('🔴 本文を右クリックして「ここに板を置く」と、押した位置に板が書かれる (#676)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板のノート');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const host = page.locator('[data-pkc-field="detail-body"]');
  /**
   * 🔴 **描き終わるまで待つ**(2026-09-05、CI で 2 回だけ落ちて実測した)。
   *
   * ⚠ 「編集」のボタンが出た時点では、本文はまだ worker 越しに描かれている途中で、
   *   **塊が差し替わる**。差し替わる瞬間に右クリックすると、押した節点がその場で
   *   消えるので `contextmenu` が**誰にも届かない** ── 症状は「メニューが出る回と
   *   出ない回がある」という間欠で、**製品ではなく台の書き方の問題**である
   *   (同じ罠を `split-frames.smoke.spec.ts` の `writeBody` が既に踏んで直してある)。
   * 🔑 `detail.ts` は描けたら `data-pkc-painted` にその lid を焼く ── それを待つ。
   */
  await expect(page.locator('[data-pkc-field="detail-body"][data-pkc-painted]').first()).toBeVisible();
  const hb = (await host.boundingBox())!;
  /**
   * 🔴 **押すのは整数の画面座標**(2026-09-05 に落ちて実測した)。
   *
   * ⚠ 1 稿目は `hb.y + 100` で押していたが、器の上端は **76.75px** のような半端な
   *   位置に来る(実測。上の面の高さは文字の寸法で決まる)。ブラウザは `MouseEvent.clientY`
   *   を**整数に切り捨てる**ので、176.75 で押しても製品が受けるのは **176** ──
   *   `176 − 76.75 = 99.25 → 99` になり、期待の 100 と 1px ずれた。
   * 🔑 器の枠(`clientTop`)とスクロール(`scrollTop`)は**どちらも 0 と実測**した ──
   *   製品の座標変換は正しい。ずれていたのは spec が**実マウスには無い半端な座標**で
   *   押していたこと。だから整数で押し、期待値は「押した画面座標 − 器の上端」の丸めで書く
   *   (器の半端に依らず、実マウスと同じ答えになる)。
   * ⚠ 既存の 2 枚(x=120 / x=460、y=40〜)に当たらない空き地を押す
   */
  const px = Math.floor(hb.x) + 60;
  const py = Math.floor(hb.y) + 100;
  const expectX = String(Math.round(px - hb.x));
  const expectY = String(Math.round(py - hb.y));
  await page.mouse.click(px, py, { button: 'right' });
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-pkc-action="add-place"]').click();

  /**
   * 🔴 観測点は**本文から描き直された属性**(保存 → 再描画の往復の後の値)。
   * ⚠ 器の枠線ぶん(`clientLeft`)が 0 でなければそのぶんずれる ── 実測して落ちたら、
   *   期待値ではなく `binder.ts` の座標変換を疑う(上の注のとおり、いまは 0)。
   */
  const added = page.locator(`[data-pkc-field="detail-body"] .pkc-place[data-pkc-x="${expectX}"]`);
  await expect(added, `押した位置の x=${expectX} で板が書かれていない`).toHaveCount(1, { timeout: 5000 });
  await expect(added, `押した位置の y=${expectY} で板が書かれていない`).toHaveAttribute('data-pkc-y', expectY);
  // 対照群: 元の 2 枚は動いていない
  await expect(page.locator('[data-pkc-region="detail"] #p1')).toHaveAttribute('data-pkc-x', '120');
  await expect(page.locator('[data-pkc-region="detail"] #p2')).toHaveAttribute('data-pkc-x', '460');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **右下の角を掴んで大きさを変える**(#676)── 離した大きさが本文の `w=` / `h=` に書き戻る。
 */
test('🔴 板の角を実マウスで掴むと、本文の w= / h= が書き替わる (#676)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板のノート');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const p1 = page.locator('[data-pkc-region="detail"] #p1');
  const handle = page.locator('#p1 [data-pkc-field="place-size"]');
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 80, h.y + h.height / 2 + 40, { steps: 5 });
  await page.mouse.up();

  await expect(p1, '本文に書き戻されていない(見た目だけ変わった)').toHaveAttribute('data-pkc-w', '400', {
    timeout: 5000,
  });
  await expect(p1).toHaveAttribute('data-pkc-h', '240');
  // 対照群: 位置は動いていない / 隣の塊は変わっていない
  await expect(p1).toHaveAttribute('data-pkc-x', '120');
  await expect(page.locator('[data-pkc-region="detail"] #p2')).toHaveAttribute('data-pkc-w', '200');

  expect(errors, 'pageerror が出た').toEqual([]);
});
