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
import { test, expect, type Locator } from '@playwright/test';
import { PLACE_SQL_NOTE } from '../../src/features/markdown/place-embed';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  useSplitEditor,
  expectImageRendered,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

// 1x1 PNG(67 bytes)── 添付(画像)の台。絵の中身ではなく「出る / 枠に収まる / 返る」を見る
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
  /**
   * 🔴 **同じ 2 枚の間にもう 2 本**(#530 段③b、user 裁定 2026-09-15)。
   * ⚠ ここが**実ブラウザでしか見られない所**である ── 散らす割合は
   *   `offsetWidth` で測った実寸に当たるので、happy-dom(0 を返す)では
   *   「散らした結果どこに出るか」が 1 度も走らない。
   * 🔑 3 本目は**辺の中点の中点**(`今日:top@1/4`)を手で書く ──
   *   散らしと手書きが同じ束の中で両立することを、同じ筋書きで見る。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── 既に在る道中に足す。
   */
  '',
  ':::format{.pkc-line from=今日 to=明日}',
  ':::',
  '',
  // 🔑 3 本目は**曲がる線**にする(#530 段③c)── 実ブラウザでしか見られないのは
  //    `fill` である(`<path>` の既定の塗りは黒。まっすぐな線は面積 0 なので
  //    **見た目が 1px も変わらず**、曲がった線でだけ真っ黒な塊になる)。
  ':::format{.pkc-line from=今日:top@1/4 to=明日 route=curve bend=v:420}',
  ':::',
  /** ⚠ 使えない名前は今までどおり断る ── 広げたのは**字の種類だけ**である。 */
  '',
  ':::format{.pkc-line from=a.b to=今日}',
  ':::',
  /**
   * 🔴 **接続点の綴りが読めないときの断り**(#530 段③b)。
   * ⚠ 上の `a.b` とは**別の分岐**である ── あちらは「その名前の付箋が無い」
   *   (`lineTrouble`)、こちらは「つなぎ目の字が読めない」(`anchorTrouble`)で、
   *   `lineTrouble` が先に判定されるので**名前が正しいときだけ**ここへ来る。
   * 🔑 だから**名前は実在する物**(`今日` / `明日`)を書く ── 名前を間違えると
   *   あちらの断りに救われて、この分岐を 1 度も通らない(CLAUDE.md §2)。
   */
  '',
  ':::format{.pkc-line from=今日:righ to=明日}',
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
  const lines = page.locator('[data-pkc-field="place-lines"] path');
  /**
   * ⚠ **4 本である** ── ASCII の `p1 → p2` と、日本語の `今日 → 明日` **3 本**
   *   (#530 段③b)。🔑 最後の 1 本(`from=a.b`)は**引けてはいけない** ──
   *   等値で見るので、使えない名前を黙って通した日にここが落ちる。
   */
  await expect(lines, '線の本数が違う(日本語の名前が引けていないか、断るはずの線を引いた)')
    .toHaveCount(4);
  /**
   * 🔴 **4 本が 4 か所から出る**(user 裁定 2026-09-15)。
   * ⚠ 散らさないと 2 本目以降が**1 本目の真下に完全に重なって消える** ──
   *   引いた本人には「1 本しか引けない」としか見えない。
   * 🔑 見るのは**出口の座標そのもの**である(辺の名前ではない)── 同じ辺の
   *   上で散らすので、辺の名前を数えると 3 本が同じに見えてしまう。
   */
  // 🔑 端点は `d` の頭(`M x y`)から読む ── 器が `<path>` なので `x1` はもう無い
  const starts = await lines.evaluateAll((els) =>
    els.map((el) => (el.getAttribute('d') ?? '').split(' ').slice(0, 3).join(' ')),
  );
  expect(new Set(starts).size, `線が同じ所から出ている(重なって消える): ${starts.join(' / ')}`)
    .toBe(4);
  /**
   * 🔴 **手で書いた「辺の中点の中点」が、実寸の 1/4 の所に出る**(#530 段③b)。
   * ⚠ ここは実寸に当たる ── `w=200` と書いてあっても、実ブラウザでは
   *   枠線や余白で測った幅が違いうるので、**測った箱から出す**。
   */
  const pinned = page.locator(
    '[data-pkc-field="place-lines"] path[data-pkc-line-from="top@1/4"]',
  );
  await expect(pinned, '手で書いた接続点(top@1/4)が焼かれていない').toHaveCount(1);
  const svgBox = (await page.locator('[data-pkc-field="place-lines"]').boundingBox())!;
  const kyouBox = (await page.locator('[data-pkc-region="detail"] [id="今日"]').boundingBox())!;
  const pinnedD = (await pinned.getAttribute('d')) ?? '';
  const pinnedX1 = Number(pinnedD.split(' ')[1]);
  expect(
    Math.abs(pinnedX1 - (kyouBox.x - svgBox.x + kyouBox.width / 4)),
    `上辺の 1/4 から出ていない(x1=${pinnedX1})`,
  ).toBeLessThan(2);
  /**
   * 🔴 **曲がる線が「塗り潰された塊」になっていない**(#530 段③c)。
   * ⚠ ここは**実ブラウザでしか見られない** ── `<path>` の既定の塗りは黒なので、
   *   規則が 1 行外れると**曲がった線だけ**真っ黒になる。まっすぐな線は面積 0 で
   *   見た目が 1px も変わらないため、この 1 本が無いと誰も気づけない。
   * 🔑 だから 3 本目を曲がる線にしてある(`route=curve`)。
   */
  expect(pinnedD, '曲がる線になっていない(前提が崩れている)').toContain(' C ');
  expect(
    await pinned.evaluate((el) => getComputedStyle(el).fill),
    '曲がる線が塗り潰されている(fill: none が効いていない)',
  ).toBe('none');
  /**
   * ⚠ **器を `<path>` へ替えたので `x1` はもう無い**(#530 段③c)── `d` の頭から読む。
   * 🔴 1 稿目はここと下の `.poll` の **2 か所で `x1` を読み残していた** ──
   *   `getAttribute('x1')` は `null` を返し、`Number(null)` は **0** になるので、
   *   下の「線が付いてくる」は**永久に 0 のまま**になる(CLAUDE.md §10「器を替えると、
   *   読み取れる値が変わる」)。⚠ unit も型検査も 1 件も鳴らない ── 対象範囲の
   *   実ブラウザ smoke だけが拾った。
   * 🔑 読み方は 1 か所に寄せる(`startOf`)── 2 つ目を足す人が同じ罠を踏まない。
   */
  const startOf = async (l: Locator): Promise<string> =>
    ((await l.getAttribute('d')) ?? '').split(' ').slice(0, 3).join(' ');
  const line = lines.first();
  const startBefore = await startOf(line);
  expect(startBefore, `線の座標が読めない(d の頭=${startBefore})`).toMatch(/^M \d/);
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
  const notes = page.locator('[data-pkc-field="place-line-note"]');
  await expect(notes, '断りの数が違う(要らない断りが出ているか、出るべき断りが出ていない)')
    .toHaveCount(2);
  /**
   * 🔑 **2 つの断りを字で見分ける**(#530 段③b)── 数だけ見ると、
   *   片方の分岐が死んでいて**もう片方が 2 回出た**日に緑のままになる
   *   (CLAUDE.md §1「門を N 個置いたら、N 個目だけが鳴る場面を N 通り作る」)。
   */
  const noteTexts = (await notes.allTextContents()).join(' / ');
  expect(noteTexts, `名前の断りが出ていない: ${noteTexts}`).toContain('名前に「a.b」は使えません');
  expect(noteTexts, `つなぎ目の断りが出ていない: ${noteTexts}`)
    .toContain('つなぎ目に「righ」は使えません');

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
    /**
     * ⚠ 板が居るのは **x=120..440 と x=460..660 の 2 本の縦帯**(y=40..240 と y=300..420)。
     * 🔑 だから空き地を **x で稼ぐ** ── `x≒40` は**いちばん左の板より 80px 左**で、
     *   どの高さでも板に当たらない(実ブラウザで実測: 器 x=270 / 板の左端 x=390)。
     * ⚠ **y に賭けない** ── #530 で日本語の板を y=300 に足した時点で「板の下が空き地」
     *   ではなくなった。y を頼りにすると、板を 1 枚足した日に静かに裏返る
     *   (CLAUDE.md §2「差は桁で稼ぐ」)。
     * ⚠ 板を足す変更が来たら、**この式をもう一度読む**(左の帯に板を置いたら破れる)。
     */
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
    .poll(async () => startOf(line), {
      message: '板を動かしたのに線が置き去りになっている',
      timeout: 5000,
    })
    .not.toBe(startBefore);

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

  /**
   * 🔴 **付箋に色を付けて、外す**(#530 段④。Gemini 裁定 A)。
   *
   * ⚠ **計算後の色を見る**(属性だけ見ると「変数は置いたが、受け皿の規則が無く画面は 1 ドットも変わらない」を
   *   素通りする ── #1038 段 J で踏んだ形)。⚠ 形のある付箋は塗りが `::after`(層)に在る ── 要素の背景は透明のまま
   *   なので、**層の色**を見る(unit の DOM は擬似要素を持たない)。
   * 🔑 色を選ぶ窓は OS の窓で実ブラウザからは操作できない ── 窓の入力へ `change` を**合成して撃つ**
   *   (本物の窓を閉じたときと同じ出来事。`body-links.smoke.spec.ts` の色の見本と同じ作法)。
   * 🔑 **新しい起動は増やさない**(#820)── この筋書きの続きで確かめる。
   */
  const pickColor = async (label: string, value: string): Promise<void> => {
    await p2.click({ button: 'right' });
    await blockMenu.locator('button', { hasText: new RegExp(`^${label}$`) }).click();
    await expect(page.locator('input[data-pkc-field="color-pick"]'), `「${label}」を押しても色の窓が出ない`).toHaveCount(1);
    await page.evaluate((v) => {
      const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]')!;
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  const paintOf = (loc: Locator): Promise<{ bg: string; border: string; ink: string }> =>
    loc.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, border: cs.borderTopColor, ink: cs.color };
    });
  const before = await paintOf(p2);
  const p1Before = await paintOf(p1);
  await pickColor('色…', '#ff0000');
  await expect(p2, '塗りが本文に書き戻されていない').toHaveAttribute('data-pkc-fill', '#ff0000', { timeout: 5000 });
  await pickColor('枠の色…', '#0000ff');
  await expect(p2, '枠の色が本文に書き戻されていない').toHaveAttribute('data-pkc-stroke', '#0000ff', { timeout: 5000 });
  const colored = await paintOf(p2);
  expect(colored.bg, '塗りが画面の色に出ていない(受け皿の規則が効いていない)').toBe('rgb(255, 0, 0)');
  expect(colored.border, '枠の色が画面の色に出ていない').toBe('rgb(0, 0, 255)');
  // 🔴 暗い塗りの上の字は白(暗いテーマの明るい字が明るい塗りの上で消える逆の形を防ぐ)
  expect(colored.ink, '赤い塗りの上の字の色が塗りに合っていない').toBe('rgb(255, 255, 255)');
  // ⚠ 対照群: 隣の付箋は色なしのまま(色が板をまたいで漏れていない)
  expect(await paintOf(p1), '色が隣の付箋へ漏れた').toEqual(p1Before);
  await expect(p1).not.toHaveAttribute('data-pkc-fill', /.+/);
  // 🔴 形のある付箋は**層**に色が乗る(ひし形: 外 = 枠 / 内 = 塗り)
  await p2.click({ button: 'right' });
  await blockMenu.locator('[data-pkc-action="place-shape-diamond"]').click();
  await expect(p2).toHaveAttribute('data-pkc-shape', 'diamond', { timeout: 5000 });
  const layers = await p2.evaluate((el) => ({
    outer: getComputedStyle(el, '::before').backgroundColor,
    inner: getComputedStyle(el, '::after').backgroundColor,
  }));
  expect(layers.inner, 'ひし形の塗り(内の層)が色に出ていない').toBe('rgb(255, 0, 0)');
  expect(layers.outer, 'ひし形の枠(外の層)が色に出ていない').toBe('rgb(0, 0, 255)');
  // 🔴 外せる(片道にしない)── 色を外すと本文の札が消え、画面は元の色へ戻る
  await p2.click({ button: 'right' });
  await blockMenu.locator('[data-pkc-action="place-color-clear"]').click();
  await expect(p2, '色を外しても fill= が残っている').not.toHaveAttribute('data-pkc-fill', /.+/, { timeout: 5000 });
  await expect(p2).not.toHaveAttribute('data-pkc-stroke', /.+/);
  await p2.click({ button: 'right' });
  await blockMenu.locator('[data-pkc-action="place-shape-rect"]').click();
  await expect(p2).toHaveAttribute('data-pkc-shape', 'rect', { timeout: 5000 });
  expect(await paintOf(p2), '色を外したのに元の見た目へ戻らない').toEqual(before);
  // 色が無いときは「色を外す」は出ない(押しても何も起きない口を作らない)
  await p2.click({ button: 'right' });
  await expect(blockMenu.locator('[data-pkc-action="place-color-clear"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/** 🔴 #529 Q3 ── 折り返せない長い数式(項を 80 並べる)。読む面(1,000px 前後)より広く描かれる。 */
const LONG_MATH = '$$\n' + Array.from({ length: 80 }, (_, i) => `x_{${String(i)}}`).join(' + ') + '\n$$';

test('🔴 entry= の塊は題名の帯 + 中身(読み取り専用)になり、押すとそのノートを開く (#283 P4 / #529 W3-①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  /**
   * 🔴 **置いたノートの中身**(#529 W3-①)。表・チェック・見出しと、**切る量(4,000 字)を超える長さ**を持つ。
   * ⚠ 空振り防止:この本文が実際に表とチェックを持ち、量を超えていることを下で assert する。
   * 🔑 **新しい起動は増やさない**(#820)── 既にこの test が通る道中に足す。
   */
  const longBody =
    '# 相手の見出し\n\n中身\n\n| 品 | 数 |\n|---|---|\n| 牛乳 | 2 |\n\n- [ ] 牛乳\n\n' +
    Array.from({ length: 400 }, (_, i) => `続きの行 ${String(i)} です。`).join('\n\n');
  expect(longBody.length, '台の前提:切る量を超えていない').toBeGreaterThan(4000);

  // 相手のノートを先に作り、lid を一覧の行から読む
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '相手のノート');
  await page.fill('[data-pkc-field="editor-body"]', longBody);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const lid = await page
    .locator('[data-pkc-region="sidebar"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(lid, '前提が崩れている(相手の lid が読めない)').not.toBeNull();

  // 短いほうのノート(w= h= を省いた塊の相手 ── 既定の大きさの対照)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '短いノート');
  await page.fill('[data-pkc-field="editor-body"]', 'みじかい本文\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  // ⚠ 一覧の先頭は新しい順とは限らない ── 題名で引く
  const shortLid = await page
    .locator('[data-pkc-region="sidebar"] [data-pkc-entry]', { hasText: '短いノート' })
    .first()
    .getAttribute('data-pkc-entry');
  expect(shortLid, '前提が崩れている(短いノートの lid が読めない)').not.toBeNull();
  expect(shortLid).not.toBe(lid);

  // 板のノートを作る(w= h= を書いた塊 1 枚 + 省いた塊 1 枚)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    `:::format{#big .pkc-place entry=${lid} x=60 y=30 w=240 h=100}\n:::\n\n` +
      // 🔴 暗い塗りを付けた `entry=` の付箋(題名の帯の字が塗りに追従するかを下で見る)
      `:::format{#dflt .pkc-place entry=${shortLid} x=60 y=200 fill=#1e3a8a}\n:::\n`,
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const big = page.locator('[data-pkc-region="detail"] #big');
  const dflt = page.locator('[data-pkc-region="detail"] #dflt');
  const bigCard = big.locator(':scope > [data-pkc-field="place-card"]');
  const bigBody = big.locator(':scope > [data-pkc-field="place-body"]');

  // 🔴 帯に相手の題名が出る(今までどおり)
  await expect(bigCard, '帯に題名が出ていない').toHaveText('相手のノート');
  // 🔴 帯の下に、相手の本文(見出し・表・チェック)が読み取り専用で出る
  await expect(bigBody, '置いたノートの中身が出ていない').toContainText('中身');
  await expect(bigBody.locator('table')).toHaveCount(1);
  const cb = bigBody.locator('input[type="checkbox"]');
  await expect(cb, '台の前提:チェックが出ていない').toHaveCount(1);
  await expect(cb, 'チェックが押せる形で出ている').toBeDisabled();
  await expect(dflt.locator(':scope > [data-pkc-field="place-body"]')).toContainText('みじかい本文');

  /**
   * 🔴 **塗りを付けた `entry=` の付箋は、題名の帯の字も塗りの上の字になる**(#1304 の着地後レビュー)。
   * ⚠ 直す前は帯が `color: var(--fg)` 固定で、暗い塗りの上に**地の字(暗いテーマでは明るい字)がそのまま載った**。
   * 🔑 計算後の色を見る(属性・変数だけでは「受け皿が無い」を素通りする)。対照群:色の無い付箋の帯は
   *   `--fg` のまま(= 今までの色を 1 ドットも変えていない)。
   */
  const cardInk = (loc: Locator): Promise<{ card: string; own: string }> =>
    loc.evaluate((el) => {
      const card = el.querySelector(':scope > [data-pkc-field="place-card"]')!;
      return { card: getComputedStyle(card).color, own: getComputedStyle(el).color };
    });
  const filled = await cardInk(dflt);
  expect(filled.own, '台の前提:暗い塗りの上の字が白になっていない').toBe('rgb(255, 255, 255)');
  expect(filled.card, '塗りを付けた付箋の題名の字が、塗りの上の字に追従していない').toBe(filled.own);
  const plainCard = await big.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--fg)';
    el.append(probe);
    const fg = getComputedStyle(probe).color;
    probe.remove();
    return { fg, card: getComputedStyle(el.querySelector(':scope > [data-pkc-field="place-card"]')!).color };
  });
  expect(plainCard.card, '色の無い付箋の題名の字の色が変わった(対照群)').toBe(plainCard.fg);

  // 🔴 大きさ:w= h= は固定、省略は既定(320 × 240)── 中身(長い本文)で伸びない
  const bb = (await big.boundingBox())!;
  expect([Math.round(bb.width), Math.round(bb.height)], 'w= h= で固定されていない').toEqual([240, 100]);
  const db = (await dflt.boundingBox())!;
  expect([Math.round(db.width), Math.round(db.height)], '省略時の既定の大きさでない').toEqual([320, 240]);

  /**
   * 🔴 **本文を送っても、掴む口と大きさの持ち手は塊の中に居続ける**。
   * ⚠ 塊そのものが送ると、絶対配置の子(口)が一緒に流れて消える ── CSS の
   *   `.pkc-place[data-pkc-place-embedded] { overflow: hidden }` と本文の器だけが送る作りが守る。
   */
  const scrolled = await bigBody.evaluate((el) => {
    el.scrollTop = 80;
    return { body: el.scrollTop, block: (el.parentElement as HTMLElement).scrollTop };
  });
  expect(scrolled.body, '本文の器が送れていない(収まらない分が切れて見えない)').toBeGreaterThan(0);
  expect(scrolled.block, '塊そのものが送られている(掴む口が流れる)').toBe(0);
  const bBox = (await big.boundingBox())!;
  for (const field of ['place-grip', 'place-size']) {
    const gb = (await big.locator(`:scope > [data-pkc-field="${field}"]`).boundingBox())!;
    const inside =
      gb.x >= bBox.x - 1 &&
      gb.y >= bBox.y - 1 &&
      gb.x + gb.width <= bBox.x + bBox.width + 1 &&
      gb.y + gb.height <= bBox.y + bBox.height + 1;
    expect(inside, `本文を送ったら ${field} が塊の外へ出た`).toBe(true);
  }

  // 🔴 量を超えた本文は、末尾に「続きは元のノートで」(切った。全部は出ていない)
  const more = bigBody.locator('[data-pkc-field="place-body-more"]');
  await expect(more).toHaveText('続きは元のノートで');
  await expect(bigBody).not.toContainText('続きの行 399 です');
  // 対照群 ── 短いノートには出ない
  await expect(dflt.locator('[data-pkc-field="place-body-more"]')).toHaveCount(0);

  // 🔴 見出しは見出しでない(板のノートの目次に混ざらない)/ id は枠の接頭辞つき(素の id は無い)
  await expect(bigBody.locator('h1, h2, h3')).toHaveCount(0);
  const bigIds = await bigBody.locator('[id]').evaluateAll((els) => els.map((e) => e.id));
  expect(bigIds.length, '台の前提:見出しの id が出ていない').toBeGreaterThan(0);
  for (const id of bigIds) expect(id, `素の id が残っている: ${id}`).toMatch(/^place-\d+-/);

  // 🔴 中身の上で右クリックしても、出るのは**板のメニュー**(置いたノートの行メニューではない)
  //    ── 中身に行番号を焼いていないので、押した所が板のノートの別の行に化けない
  await bigBody.evaluate((el) => {
    el.scrollTop = 0;
  });
  await bigBody.locator('[data-pkc-embedded-heading]').first().click({ button: 'right' });
  await expect(
    page.locator('[data-pkc-region="context-menu"]').getByText('この板をコピー'),
    '中身の上の右クリックで板のメニューが出ない',
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // 🔴 チェックの枠を押しても、何も書かれない(開き直した相手のチェックは空のまま)
  await cb.click({ force: true });
  await clickReal(page, '#big [data-pkc-field="place-card"]');
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-title"]'),
    '帯を押しても相手が開かない',
  ).toHaveText('相手のノート');
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-body"] input.pkc-task-checkbox'),
    '板から押したチェックが相手に書かれた',
  ).not.toBeChecked();

  /**
   * ── 🔴 **図・画像・添付ノート・同じノート 2 枚**(#529 W3-②)。
   *
   * ⚠ **実ブラウザでしか見られない所**:①図は枠(320px)の中で**見えたときに実際に焼かれて PNG の
   *   `<img>` になる**(IntersectionObserver・IDB・mermaid の読み込みの本物)②画像の添付ノートが
   *   **枠いっぱい**(`object-fit: contain` の CSS が効く)③同じノートを 2 枚置いた**実 DOM の
   *   `id` が重複しない**。
   * 🔑 **新しい起動は増やさない**(#820)── この test の続きで通す。
   */
  const lidOfTitle = async (title: string): Promise<string> => {
    const lid = await page
      .locator('[data-pkc-region="sidebar"] [data-pkc-entry]', { hasText: title })
      .first()
      .getAttribute('data-pkc-entry');
    expect(lid, `前提が崩れている(${title} の lid が読めない)`).not.toBeNull();
    return lid!;
  };
  // 図と見出しと脚注を持つノート(同じノートを 2 枚置く相手)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '図のノート');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ':::toc\n:::\n\n# 図の見出し\n\n```mermaid\ngraph TD\n  A["始め"] --> B["終わり"]\n```\n\n注があります[^1]\n\n[^1]: 脚注の本文\n',
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  // 画像を本文に貼るノート(添付も 1 件できる)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '写真のノート');
  await page.fill('[data-pkc-field="editor-body"]', '写真の前の文');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'ねこ.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await expectImageRendered(page, '[data-pkc-region="detail"] img[data-pkc-asset-key]');
  // 🔴 PDF の添付も 1 件(板の「PDF は元のノートで」の帯が押せることを見る ── #1264 §1)
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '書類.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  });
  // 🔴 #529 A-1 ── 図だけのノート / 図 4 種(chart・html・svg・csv)のノート。枠の中で**原文が見えない**ことを見る
  //    (新しい起動は増やさない。同じ道中の板 2 に置く)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '図だけのノート');
  await page.fill('[data-pkc-field="editor-body"]', '```mermaid\ngraph TD\n  A["始め"] --> B["終わり"]\n```\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '図の四種のノート');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    '```chart\n{"type":"bar","labels":["a","b"],"datasets":[{"data":[1,2]}]}\n```\n\n' +
      '```html\n<p>こんにちは</p>\n```\n\n' +
      '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>\n```\n\n' +
      '```csv\n品,数\n牛乳,2\n```\n',
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  // 🔴 #529 Q2 ── SQL の囲み(` ```sql embed `)を持つノート。枠の中では答えを引かず、案内の 1 行が出る
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'SQLのノート');
  await page.fill('[data-pkc-field="editor-body"]', '前置き\n\n```sql embed\nSELECT 1\n```\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const figLid = await lidOfTitle('図のノート');
  const onlyLid = await lidOfTitle('図だけのノート');
  const sqlLid = await lidOfTitle('SQLのノート');
  const fourLid = await lidOfTitle('図の四種のノート');
  const photoLid = await lidOfTitle('写真のノート');
  const attLid = await lidOfTitle('ねこ.png');
  const pdfLid = await lidOfTitle('書類.pdf');

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板2');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    `:::format{#f1 .pkc-place entry=${figLid} x=10 y=10}\n:::\n\n` +
      `:::format{#f2 .pkc-place entry=${figLid} x=350 y=10}\n:::\n\n` +
      `:::format{#ph .pkc-place entry=${photoLid} x=10 y=270}\n:::\n\n` +
      `:::format{#at .pkc-place entry=${attLid} x=350 y=270}\n:::\n\n` +
      `:::format{#pd .pkc-place entry=${pdfLid} x=700 y=270}\n:::\n\n` +
      `:::format{#mm .pkc-place entry=${onlyLid} x=10 y=540}\n:::\n\n` +
      `:::format{#fx .pkc-place entry=${fourLid} x=350 y=540}\n:::\n\n` +
      `:::format{#sq .pkc-place entry=${sqlLid} x=700 y=540}\n:::\n\n` +
      // 🔴 #529 Q3 ── 長い数式を持つ塊。`w=` 無し(auto)は読む面の幅で頭打ち / `w=` 付きは書いた幅のまま
      `:::format{#lm .pkc-place x=10 y=820}\n${LONG_MATH}\n:::\n\n` +
      `:::format{#lw .pkc-place x=10 y=1100 w=1500}\n${LONG_MATH}\n:::\n\n` +
      // 🔴 遠い枠(画面から 2,000px 以上下)── 近づくまで中身を作らない(W3-③)
      `:::format{#far .pkc-place entry=${figLid} x=10 y=2600}\n:::\n`,
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const body2 = page.locator('[data-pkc-region="detail"]');
  const slotIn = (id: string): Locator =>
    body2.locator(`#${id} > [data-pkc-field="place-body"]`);

  // 🔴 ① 図:枠の中で実際に焼かれて PNG の <img> になる(2 枚とも)。枠の幅に収まる
  for (const id of ['f1', 'f2']) {
    const png = slotIn(id).locator('img[data-pkc-field="mermaid-image"]');
    await expect(png, `${id}:枠の中の図が PNG で出ていない`).toHaveCount(1, { timeout: 30_000 });
    await expect(png).toHaveAttribute('src', /^blob:/);
    const m = await png.evaluate((el) => {
      const img = el as HTMLImageElement;
      const slot = img.closest('[data-pkc-field="place-body"]') as HTMLElement;
      return {
        decoded: img.complete && img.naturalWidth > 0,
        imgW: img.getBoundingClientRect().width,
        slotW: slot.clientWidth,
        // 原文の囲みが 1 行へ降ろされていない(= 図の器が器のまま残っている)
        skipNote: slot.querySelector('[data-pkc-field="place-body-skip"]') !== null,
      };
    });
    expect(m.decoded, `${id}:PNG が decode されていない`).toBe(true);
    expect(m.imgW, `${id}:図が枠からはみ出している`).toBeLessThanOrEqual(m.slotW + 1);
    expect(m.skipNote, `${id}:図が 1 行に降ろされている`).toBe(false);
  }
  // 🔴 板のノート自身は図を持たない ── 焼かれた PNG は置いた 3 枚ぶんだけ(f1 / f2 / 図だけの mm)
  await expect(body2.locator('img[data-pkc-field="mermaid-image"]')).toHaveCount(3);

  /**
   * 🔴 ①-b **枠に差し込んだ図の下に原文が出ない**(#529 A-1)。
   *
   * ⚠ 直す前は、掃除が切替の `<input>` を外して**原文を隠す CSS の条件が崩れ**、図の下に原文
   *   (`<pre class="pkc-render-source">`)が見えていた(mermaid 52 px / chart・html・svg 35 px / csv 69 px)。
   *   mermaid と chart は**原文のせいだけで枠にスクロールバーが付いた**(原文を隠すと枠に収まる)。
   * 🔑 観測点は 2 つ:DOM に原文の面が無いこと / **図だけのノートの枠が溢れていない**こと
   *   (`scrollHeight <= clientHeight`)── 後者は「見えているか」を実寸で見る。
   */
  await expect(slotIn('mm').locator('img[data-pkc-field="mermaid-image"]'), '台の前提:図だけの枠の図が焼けていない').toHaveCount(1, { timeout: 30_000 });
  await expect(slotIn('fx').locator('.pkc-render-slot'), '台の前提:図 4 種の枠が描けていない').toHaveCount(4);
  await expect(body2.locator('.pkc-render-source'), '枠の中に原文の面が残っている').toHaveCount(0);
  const overflow = await slotIn('mm').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(overflow.ch, '台の前提:枠の高さが読めていない').toBeGreaterThan(100);
  expect(overflow.sh, `図だけの枠が溢れている(scrollHeight ${String(overflow.sh)} > clientHeight ${String(overflow.ch)}。原文が見えていないか)`).toBeLessThanOrEqual(overflow.ch + 1);

  /**
   * 🔴 ①-c **枠の中の SQL は答えを引かず、案内の 1 行が出る**(#529 Q2 = B)。
   *
   * ⚠ 直す前は、SQL の字だけが出て答えの表は 0 行・高さ 0(画面に理由も出ない)だった。
   * 🔑 観測点は 3 つ:案内の字 / 表と器の印が枠に無い / 案内が説明の字の見た目(地の字より小さく、色が違う)。
   */
  const sqlSlot = slotIn('sq');
  await expect(sqlSlot.locator('[data-pkc-field="place-sql-note"]'), '枠の中の SQL に案内の 1 行が出ていない').toHaveText(
    PLACE_SQL_NOTE,
    { timeout: 30_000 },
  );
  await expect(sqlSlot.locator('table, [data-pkc-sql-embed]'), '枠の中で答えを引いている').toHaveCount(0);
  await expect(sqlSlot, '枠の中に SQL の字が出ていない').toContainText('SELECT 1');
  const sqlLook = await sqlSlot.evaluate((slot) => {
    const note = slot.querySelector('[data-pkc-field="place-sql-note"]') as HTMLElement;
    const card = slot.parentElement!.querySelector('[data-pkc-field="place-card"]') as HTMLElement;
    return {
      noteColor: getComputedStyle(note).color,
      cardColor: getComputedStyle(card).color,
      noteFs: parseFloat(getComputedStyle(note).fontSize),
      slotFs: parseFloat(getComputedStyle(slot).fontSize),
    };
  });
  expect(sqlLook.noteColor, '案内が地の字と同じ色(説明の字の規則が当たっていない)').not.toBe(sqlLook.cardColor);
  expect(sqlLook.noteFs, '案内が地の字より小さくない').toBeLessThan(sqlLook.slotFs);

  /**
   * 🔴 ①-d **`w=` 無しの長い数式の塊は、読む面の幅で頭打ち**(#529 Q3 = A)。
   *
   * ⚠ 直す前は塊が 1,614px に広がり、読む面全体が横に 734px 溢れた(板の上は `max-width: none`)。
   * 🔑 観測点:塊の右端が読む面の右端を超えない / **式は塊の中で横に送れる**(実際に送って動くか)/
   *   対照群:`w=` を書いた塊は**書いた幅のまま**(読む面より広くても頭打ちにしない)。
   */
  await expect(body2.locator('#lm .pkc-math[data-pkc-math-state="done"]'), '台の前提:数式が描けていない').toHaveCount(1, { timeout: 30_000 });
  await expect(body2.locator('#lw .pkc-math[data-pkc-math-state="done"]'), '台の前提:対照の数式が描けていない').toHaveCount(1, { timeout: 30_000 });
  const wide = await body2.evaluate(() => {
    const host = document.querySelector('[data-pkc-region="detail"] .pkc-board-host') as HTMLElement;
    const hostR = host.getBoundingClientRect();
    const auto = document.querySelector('[data-pkc-region="detail"] #lm') as HTMLElement;
    const sized = document.querySelector('[data-pkc-region="detail"] #lw') as HTMLElement;
    const a = auto.getBoundingClientRect();
    const math = auto.querySelector('.pkc-math') as HTMLElement;
    return {
      hostW: hostR.width,
      autoRight: a.right - hostR.left,
      autoW: a.width,
      // 🔑 式は**頭打ちにされた幅の中**で横に送れる ── ⚠ `scrollWidth > clientWidth` は `overflow: visible` でも成り立つので
      //   見ない。**実際に送ってみて**動いたかを見る(式の器 `.pkc-math-display` か塊の `overflow: auto` のどちらかが担う)
      mathW: math.scrollWidth,
      mathClient: math.clientWidth,
      canScroll: ((): boolean => {
        math.scrollLeft = 40;
        auto.scrollLeft = 40;
        return math.scrollLeft > 0 || auto.scrollLeft > 0;
      })(),
      sizedW: sized.getBoundingClientRect().width,
    };
  });
  expect(wide.mathW, `台の前提:式が読む面(${String(Math.round(wide.hostW))}px)より狭い。頭打ちを見分けられない`).toBeGreaterThan(wide.hostW);
  expect(wide.autoRight, `w= 無しの塊が読む面の右端を超えている(右端 ${String(Math.round(wide.autoRight))}px / 面 ${String(Math.round(wide.hostW))}px)`).toBeLessThanOrEqual(wide.hostW + 1);
  expect(wide.canScroll, '式が塊の中で横に送れない(送っても動かない = overflow が掛かっていない)').toBe(true);
  expect(wide.mathClient, '式の器が塊の幅より広い(頭打ちの外へ出ている)').toBeLessThanOrEqual(wide.autoW + 1);
  expect(wide.sizedW, 'w= を書いた塊が書いた幅でない(頭打ちが掛かっている)').toBe(1500);

  // 🔴 ② 同じノート 2 枚:実 DOM の id が重複せず、脚注・目次の押しが同じ枠の中を指す
  const idReport = await body2.evaluate((root) => {
    const ids = [...root.querySelectorAll('[id]')].map((e) => e.id);
    const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
    const links = (sel: string): { ok: number; bad: string[] } => {
      const out = { ok: 0, bad: [] as string[] };
      for (const a of root.querySelectorAll<HTMLAnchorElement>(`${sel} a[href^="#"]`)) {
        const target = (a.getAttribute('href') ?? '').slice(1);
        const hits = [...root.querySelectorAll('[id]')].filter((e) => e.id === target);
        const box = a.closest('[data-pkc-field="place-body"]');
        if (hits.length === 1 && box !== null && box.contains(hits[0]!)) out.ok += 1;
        else out.bad.push(target);
      }
      return out;
    };
    return { dup, f1: links('#f1'), f2: links('#f2') };
  });
  expect(idReport.dup, `id が重複している: ${idReport.dup.join(' / ')}`).toEqual([]);
  for (const k of ['f1', 'f2'] as const) {
    expect(idReport[k].bad, `${k}:枠の外を指すリンクがある`).toEqual([]);
    // 空振り防止:目次(1 件)と脚注(参照 + 戻り)が実際に在る
    expect(idReport[k].ok, `${k}:台の前提 ― 文書内リンクが無い`).toBeGreaterThanOrEqual(3);
  }

  // 🔴 ③ 本文に貼った画像:枠の中に絵が出る(借りて src が差さる)
  await expectImageRendered(page, '#ph > [data-pkc-field="place-body"] img[data-pkc-asset-key]');

  // 🔴 ④ 添付ノート(画像)は絵そのものが枠いっぱいに出る(縦横比を保って収める = contain)
  const att = slotIn('at').locator('img[data-pkc-field="place-attachment-image"]');
  await expect(att, '画像の添付ノートが絵で出ていない').toHaveCount(1);
  await expectImageRendered(page, '#at > [data-pkc-field="place-body"] img[data-pkc-field="place-attachment-image"]');
  const fit = await att.evaluate((el) => {
    const slot = el.closest('[data-pkc-field="place-body"]') as HTMLElement;
    const sb = slot.getBoundingClientRect();
    const ib = el.getBoundingClientRect();
    return {
      objectFit: getComputedStyle(el).objectFit,
      fillW: ib.width / sb.width,
      fillH: ib.height / sb.height,
      block: [
        Math.round((slot.parentElement as HTMLElement).getBoundingClientRect().width),
        Math.round((slot.parentElement as HTMLElement).getBoundingClientRect().height),
      ],
    };
  });
  expect(fit.objectFit, '縦横比を保って収める規則が効いていない').toBe('contain');
  expect(fit.fillW, '画像が枠の幅いっぱいに出ていない').toBeGreaterThan(0.95);
  expect(fit.fillH, '画像が枠の高さいっぱいに出ていない').toBeGreaterThan(0.6);
  expect(fit.block, '画像の添付に既定の大きさが当たっていない').toEqual([320, 240]);

  /**
   * 🔴 ⑤ **近づいた枠から中身を出す**(W3-③)。
   *
   * ⚠ ここは**実ブラウザでしか見られない所**である ── IntersectionObserver が実際の座標と
   *   スクロールの器(余白つき)で答える。unit は答えを偽物が返す。
   * 🔑 筋書き:遠い枠は帯だけ → 下へ送って近づくと中身が出て図が焼かれる → **上の枠は離れても捨てない**
   *   (捨てる版は画像を読み直して控えが積もった ── 測った結果。doc 参照)→ 上へ戻っても描き直さずそのまま。
   */
  const far = body2.locator('#far');
  await expect(far.locator(':scope > [data-pkc-field="place-card"]'), '遠い枠の帯が出ていない').toHaveText('図のノート');
  await expect(far.locator(':scope > [data-pkc-field="place-body"]'), '離れた枠に最初から中身がある').toHaveCount(0);
  const scroller = page.locator('[data-pkc-region="detail"]');
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(
    far.locator('img[data-pkc-field="mermaid-image"]'),
    '近づいた枠の図が PNG で出ていない',
  ).toHaveCount(1, { timeout: 30_000 });
  // 🔑 上の枠は離れても捨てない:器も図の PNG も、そのまま残っている(猶予ぶん待ってから見る)
  const f1Slot = body2.locator('#f1 > [data-pkc-field="place-body"]');
  const f1Node = await f1Slot.elementHandle();
  await page.waitForTimeout(2_000);
  await expect(f1Slot, '離れた枠の中身を捨てている').toHaveCount(1);
  await expect(body2.locator('#f1 img[data-pkc-field="mermaid-image"]'), '離れた枠の図が消えた').toHaveCount(1);
  // 上へ戻っても描き直されない(同じ要素のまま)
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  expect(
    await f1Slot.evaluate((el, prev) => el === prev, f1Node),
    '戻ってきたら中身を作り直している',
  ).toBe(true);
  await expectImageRendered(page, '#at > [data-pkc-field="place-body"] img[data-pkc-field="place-attachment-image"]');

  // 🔴 ⑥-b PDF の枠の「PDF は元のノートで」も押せる(#1264 §1)── 字だけの行ではなく、帯と同じ口で元のノートを開く
  const pdfSkip = slotIn('pd').locator('[data-pkc-field="place-body-skip"]');
  await expect(pdfSkip, 'PDF の枠に「元のノートで」の押し所が無い').toHaveText('PDF は元のノートで');
  await expect(pdfSkip).toHaveAttribute('data-pkc-action', 'select-entry');
  await clickReal(page, '#pd [data-pkc-field="place-body-skip"]');
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-title"]'),
    'PDF の「元のノートで」を押しても開かない',
  ).toHaveText('書類.pdf');

  // 板へ戻る(次の確かめが板の帯を押すため)
  await clickReal(page, page.locator('[data-pkc-region="sidebar"] [data-pkc-entry]', { hasText: '板2' }).first());
  await expect(body2.locator('#at > [data-pkc-field="place-card"]')).toHaveText('ねこ.png');

  /**
   * 🔴 ⑦ **同じ板を、主の枠と横に留めた枠の 2 つに出す**(#1266)。
   *
   * ⚠ 主の枠と留めた枠は**別の描画器**(= 別の `PlaceEmbeds`)で、同じ document に居る。枠の `id` の
   *   接頭辞(`place-<n>-`)の連番を描画器ごとに数えると、**2 つの板で `place-1-…` が重複**し、
   *   脚注・目次の押しが document 順で最初の相手(別の板)へ飛ぶ。上の ② は 1 つの板の中の話。
   * 🔑 **新しい起動は増やさない**(#820)── この道中の続きで通す。
   * ⚠ 留めると同じ `#at` などが 2 つになるので、下の ⑥ は主の枠(`[data-pkc-region="detail"]`)へ絞ってある。
   */
  // ⚠ 横に並べる機能は窓が狭いと自動で畳む(`split-frames.smoke.spec.ts` と同じ作法で広げる)
  await page.setViewportSize({ width: 1600, height: 900 });
  const blank = await body2.evaluate(() => {
    const host = document.querySelector('[data-pkc-region="detail"] [data-pkc-field="detail-body"]') as HTMLElement;
    const r = host.getBoundingClientRect();
    for (let y = Math.max(r.top, 0) + 20; y < Math.min(r.bottom, innerHeight) - 20; y += 20)
      for (let x = r.left + 20; x < Math.min(r.right, innerWidth) - 20; x += 20)
        if (document.elementFromPoint(x, y) === host) return { x: Math.floor(x), y: Math.floor(y) };
    return null;
  });
  expect(blank, '台の前提:板の空き地(右クリックで押せる場所)が見つからない').not.toBeNull();
  await page.mouse.click(blank!.x, blank!.y, { button: 'right' });
  const pinMenu = page.locator('[data-pkc-region="context-menu"]');
  await expect(pinMenu, '板の空き地を右クリックしてもメニューが出ない').toBeVisible();
  await pinMenu.locator('button[data-pkc-action="pin-split"]').click();
  await expect(page.locator('[data-pkc-split-lid]'), '板が横に留まっていない').toHaveCount(1);
  await expect
    .poll(() => page.locator('[data-pkc-split-lid] [data-pkc-field="place-body"]').count(), {
      message: '留めた枠の板に置いたノートの中身が出ていない',
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const twoBoards = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-pkc-field="place-body"] [id]')].map((e) => e.id);
    // 🔑 枠の接頭辞そのもの(`place-<n>-`)も数える ── id を持つ枠の番号が**たまたま**重ならなかった回でも、
    //   描画器ごとに 0 から数え直している実装は、番号が重なる枠(id を持たない枠も含む)で見つかる
    const nss = [...document.querySelectorAll('[data-pkc-field="place-body"]')].map(
      (e) => e.getAttribute('data-pkc-place-ns') ?? '',
    );
    return {
      ids: ids.length,
      nsDup: nss.filter((v, i) => nss.indexOf(v) !== i),
      dup: ids.filter((v, i) => ids.indexOf(v) !== i),
      inPinned: [...document.querySelectorAll('[data-pkc-split-lid] [data-pkc-field="place-body"] [id]')].length,
      inMain: [...document.querySelectorAll('[data-pkc-region="detail"] [data-pkc-field="place-body"] [id]')].length,
    };
  });
  // ⚠ 空振り防止:id が 2 つの板の両方に在る(片方の板が 0 件なら「重複 0」は何も言っていない)
  expect(twoBoards.inPinned, '台の前提:留めた枠の板に id が出ていない').toBeGreaterThan(0);
  expect(twoBoards.inMain, '台の前提:主の枠の板に id が出ていない').toBeGreaterThan(0);
  expect(twoBoards.dup, `主の枠と留めた枠で id が重複している: ${twoBoards.dup.join(' / ')}`).toEqual([]);
  expect(twoBoards.nsDup, `主の枠と留めた枠で枠の接頭辞が重なっている: ${twoBoards.nsDup.join(' / ')}`).toEqual([]);

  // 🔴 ⑥ 押すと元のノートが開く(帯)── 添付ノート側も今までどおり
  await clickReal(page, '[data-pkc-region="detail"] #at > [data-pkc-field="place-card"]');
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-title"]'),
    '添付ノートの帯を押しても開かない',
  ).toHaveText('ねこ.png');

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

  /**
   * 🔴 **掴んで繋ぐ**(#530 段③d。🟣 Gemini 裁定 A / A)── 置いたばかりの**名前の無い板**から、
   * 名前の在る `#今日` へ、実マウスで線を引く。
   *
   * ⚠ ここが**実ブラウザでしか見られない所**である ── 乗せて印が出る(hover)/ 掴んだ ● が
   *   印の層(`pointer-events: none` の中の `auto`)から実際に掴める / 仮の線が最前面に描かれる /
   *   実寸で測った辺の位置 ── どれも happy-dom(layout を持たない)では 1 度も走らない。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── 板を置いたこの筋書きの続きで見る。
   * 🔑 相手は**名前の在る `#今日`**(対照群: 名前の在る板は 1 byte も書き換わらない)。
   */
  const mine = page.locator(`[data-pkc-field="detail-body"] .pkc-place[data-pkc-x="${expectX}"]`);
  const mb = (await mine.boundingBox())!;
  const handleLoc = page.locator('[data-pkc-field="place-handle"]');
  await expect(handleLoc, '乗せていないのに印が出ている').toHaveCount(0);
  /**
   * 🔴 左の辺のすぐ内側へ乗せる → 左の辺にだけ ● 1 つと ⊕ 2 つ。
   * ⚠ **左の辺を使う理由**:置いた板(x=60..300)の下の辺は `#p1`(x=120..440、y=40..240)と重なる
   *   ので、そこへ乗せると**板の手前に居る別の板**へ当たりうる。左の辺(x=60)は `#p1`(x=120〜)の
   *   外で、どの高さでも他の板に当たらない(空き地を x で稼ぐ ── 上の「y に賭けない」と同じ作法)。
   */
  await page.mouse.move(mb.x + 8, mb.y + mb.height / 2, { steps: 3 });
  await expect(handleLoc, '乗せた辺に ● と ⊕ の 3 つが出ていない').toHaveCount(3);
  const spells = await handleLoc.evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-pkc-handle')}:${e.getAttribute('data-pkc-anchor')}`).sort(),
  );
  expect(spells, '左の辺の ● 1 つ・⊕ 2 つ(他の辺には出ない)').toEqual([
    'dot:left',
    'plus:left@1/4',
    'plus:left@3/4',
  ]);
  /**
   * 🔴 **● と ⊕ は、実ブラウザの計算後の色 / 形で見分けられる**(CLAUDE.md「押されている / 選ばれている」を
   *   足したら、見た目の規則に受け皿が在るかを計算後の色で見る)。⚠ 属性(`data-pkc-handle`)の
   *   検査は「付けた」しか言わない ── CSS に受け皿が無ければ 3 つとも同じ見た目になる。
   */
  const looks = await handleLoc.evaluateAll((els) =>
    els.map((e) => {
      const cs = getComputedStyle(e);
      return {
        kind: e.getAttribute('data-pkc-handle'),
        bg: cs.backgroundColor,
        bc: cs.borderTopColor,
        img: cs.backgroundImage !== 'none',
        w: e.getBoundingClientRect().width,
        h: e.getBoundingClientRect().height,
        cx: e.getBoundingClientRect().x + e.getBoundingClientRect().width / 2,
        cy: e.getBoundingClientRect().y + e.getBoundingClientRect().height / 2,
      };
    }),
  );
  const dotLook = looks.find((l) => l.kind === 'dot')!;
  const plusLook = looks.find((l) => l.kind === 'plus')!;
  expect(dotLook.bg, '● が塗られていない(透明)').not.toBe('rgba(0, 0, 0, 0)');
  expect(plusLook.bg, '⊕ の地が ● と同じ色(塗りつぶしと白抜きが見分けられない)').not.toBe(dotLook.bg);
  expect(plusLook.img, '⊕ に十字が描かれていない').toBe(true);
  expect(dotLook.img, '● に十字が描かれている').toBe(false);
  expect(dotLook.w, '印が小さすぎて狙えない').toBeGreaterThanOrEqual(12);
  /**
   * 🔴 **丸く、辺の真上に中心が来る**。⚠ 汎用の `button`(高さを `--row-h` に固定)に負けると
   *   14 × 26 の縦長の楕円になり、中心が辺から 6px 下へずれる ── 1 稿目は幅しか見ておらず、
   *   この崩れを素通りした(実ブラウザで ⊕ に乗せようとして外れて初めて分かった)。
   */
  expect(Math.abs(dotLook.w - dotLook.h), `印が丸くない(${dotLook.w} × ${dotLook.h})`).toBeLessThan(1);
  expect(Math.abs(dotLook.cx - mb.x), '● の中心が左の辺の上に無い').toBeLessThan(1.5);
  expect(Math.abs(dotLook.cy - (mb.y + mb.height / 2)), '● の中心が辺の真ん中に無い').toBeLessThan(1.5);
  // 🔴 ⊕ に乗せると、そこが ● になる(さらに細かく選べる)
  const plusBox = (await page.locator('[data-pkc-handle="plus"][data-pkc-anchor="left@1/4"]').boundingBox())!;
  await page.mouse.move(plusBox.x + plusBox.width / 2, plusBox.y + plusBox.height / 2, { steps: 3 });
  await expect(
    page.locator('[data-pkc-handle="dot"]'),
    '⊕ に乗せたのに ● が動いていない',
  ).toHaveAttribute('data-pkc-anchor', 'left@1/4');
  /**
   * 🔴 **乗せている最中も ● は塗られたまま・枠も同じ色**(いま ● の上にマウスが在る)。⚠ 汎用の
   *   `button:hover` は枠の色を `--muted` へ替える(詳細度が勝つ)── 印の hover 規則が外れると、乗せた瞬間に
   *   ● の縁が灰色になる(変異試験 C2)。
   */
  expect(
    await page.locator('[data-pkc-handle="dot"]').evaluate((el) => getComputedStyle(el).backgroundColor),
    '乗せた ● の塗りが hover で変わった(汎用の button:hover に負けている)',
  ).toBe(dotLook.bg);
  expect(
    await page.locator('[data-pkc-handle="dot"]').evaluate((el) => getComputedStyle(el).borderTopColor),
    '乗せた ● の枠の色が hover で変わった(汎用の button:hover に負けている)',
  ).toBe(dotLook.bc);
  // 🔴 ● を実マウスで掴み、`#今日` の左の辺の近くで離す
  const dotBox = (await page.locator('[data-pkc-handle="dot"]').boundingBox())!;
  const kyou = page.locator('[data-pkc-region="detail"] [id="今日"]');
  const kb = (await kyou.boundingBox())!;
  const kyouBefore = await kyou.evaluate((el) => el.outerHTML.length);
  await page.mouse.move(dotBox.x + dotBox.width / 2, dotBox.y + dotBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(kb.x + 6, kb.y + kb.height / 2, { steps: 6 });
  // 🔴 掴んでいる間は仮の線が出て、乗せた付箋に予告が付く(本文はまだ書かれていない)
  await expect(page.locator('[data-pkc-field="place-connect-ghost"] path'), '仮の線が出ていない').toHaveCount(1);
  await expect(kyou, '乗せた付箋に予告が付いていない').toHaveAttribute('data-pkc-connect-target', '');
  // ⚠ 属性が付いただけでは画面は変わらない ── 予告の枠が実際に描かれている(計算後の値)
  expect(
    await kyou.evaluate((el) => getComputedStyle(el).outlineStyle),
    '乗せた付箋に予告の枠が描かれていない(規則が無い)',
  ).toBe('solid');
  expect(
    await page.locator('[data-pkc-field="place-connect-ghost"] path').evaluate((el) => getComputedStyle(el).fill),
    '仮の線が塗り潰されている',
  ).toBe('none');
  await expect(mine, '掴んでいる間に本文へ名前が書かれた').not.toHaveAttribute('id', /.+/);
  await page.mouse.up();
  // 🔴 観測点は**本文から描き直された物**: 名前の無かった板に `板1` が付き、左の辺の 1/4 から相手の左の辺へ線が引かれる
  await expect(mine, '名前の無い付箋に名前が足されていない').toHaveAttribute('id', '板1', { timeout: 5000 });
  const made = page.locator(
    '[data-pkc-field="place-lines"] path[data-pkc-line-from="left@1/4"][data-pkc-line-to="left"]',
  );
  await expect(made, '繋いだ線が 1 本、画面に描かれていない').toHaveCount(1, { timeout: 5000 });
  await expect(page.locator('[data-pkc-field="place-lines"] path'), '線は 5 本(元の 4 + 新しい 1)').toHaveCount(5);
  // ⚠ 離したら仮の線も印も残らない / 名前が在った付箋は書き換わっていない
  await expect(page.locator('[data-pkc-field="place-connect-ghost"]'), '仮の線が残っている').toHaveCount(0);
  expect(await kyou.evaluate((el) => el.outerHTML.length), '名前の在る付箋が書き換わった').toBe(kyouBefore);
  await expect(kyou).not.toHaveAttribute('data-pkc-connect-target', '');
  // 🔴 付箋の外で離したら何も書かない(線は 5 本のまま)
  await page.mouse.move(mb.x + 8, mb.y + mb.height / 2, { steps: 3 });
  const dot2 = (await page.locator('[data-pkc-handle="dot"]').boundingBox())!;
  await page.mouse.move(dot2.x + dot2.width / 2, dot2.y + dot2.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width + 600, mb.y + 400, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('[data-pkc-field="place-lines"] path'), '付箋の外で離したのに線が増えた').toHaveCount(5);
  // 🔴 引いた線は右クリックで消せる(片道にしない)── 線の道の真ん中を押す
  const mid = await made.evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const pt = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
  await page.mouse.click(mid.x, mid.y, { button: 'right' });
  const lineMenu = page.locator('[data-pkc-region="context-menu"]');
  await expect(lineMenu.locator('[data-pkc-action="remove-place-line"]'), '線の上で「この線を消す」が出ていない').toBeVisible();
  /**
   * 🔴 **線の色と太さ**(#530 段④)── 消す前に、同じ線へ色と太さを付ける(**新しい起動は増やさない**)。
   * ⚠ 計算後の `stroke` / `stroke-width` を見る(変数を置いても、受け皿の規則が無ければ 1 ドットも変わらない)。
   */
  const strokeOf = (): Promise<{ stroke: string; width: string }> =>
    made.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { stroke: cs.stroke, width: cs.strokeWidth };
    });
  const was = await strokeOf();
  expect(was.width, '前提: 色も太さも無い線は 2px').toBe('2px');
  await lineMenu.locator('button', { hasText: /^色…$/ }).click();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]')!;
    input.value = '#2563eb';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(async () => (await strokeOf()).stroke, { message: '線の色が画面に出ていない', timeout: 5000 }).toBe('rgb(37, 99, 235)');
  const mid2 = await made.evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const pt = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
  await page.mouse.click(mid2.x, mid2.y, { button: 'right' });
  await expect(lineMenu.locator('button', { hasText: /^色を外す$/ }), '色が付いたのに「色を外す」が出ない').toBeVisible();
  await lineMenu.locator('button', { hasText: /^線を太くする$/ }).click();
  await expect.poll(async () => (await strokeOf()).width, { message: '線の太さが画面に出ていない', timeout: 5000 }).toBe('4px');
  await page.mouse.click(mid2.x, mid2.y, { button: 'right' });
  await expect(lineMenu.locator('button', { hasText: /^線を太くする$/ }), 'いまの太さと同じ口が出ている').toHaveCount(0);
  await lineMenu.locator('button', { hasText: /^線の太さを標準に戻す$/ }).click();
  await expect.poll(async () => (await strokeOf()).width, { message: '太さを標準へ戻せない', timeout: 5000 }).toBe('2px');
  await page.mouse.click(mid2.x, mid2.y, { button: 'right' });
  await lineMenu.locator('button', { hasText: /^色を外す$/ }).click();
  await expect.poll(async () => strokeOf(), { message: '色を外しても元の見た目へ戻らない', timeout: 5000 }).toEqual(was);
  await page.mouse.click(mid2.x, mid2.y, { button: 'right' });
  await lineMenu.locator('[data-pkc-action="remove-place-line"]').click();
  await expect(page.locator('[data-pkc-field="place-lines"] path'), '線が消えていない').toHaveCount(4, { timeout: 5000 });
  await expect(made, '消したのは繋いだ線だけでなければならない').toHaveCount(0);
  await expect(mine, '線を消したら付箋まで消えた').toHaveAttribute('id', '板1');

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
