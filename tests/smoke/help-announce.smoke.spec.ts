import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **ヘルプの面とお知らせの帯**(P11 段④⑤。user 指示 2026-08-07)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は**生成の正しさ**しか示さない。ここで見るのは
 * unit では観測できないことだけ:
 *
 * - **押せる**こと(帯のボタンが実際に最前面に居て、クリックが届く)
 * - **マニュアルが本当に描かれる**こと(worker 経路 ── unit は口を差し替えている)
 * - 🔴 **マニュアルの見出しが、本文の `#リンク` を横取りしない**こと ──
 *   面は `hidden` で同一 document に常駐するので **id はぶつかりうる**
 *   (ぶつからないことは要求できない ── user が同じ見出しを書けば必ず起きる)。
 *   守るのは「`#slug` が本文の面に当たる」ほうである
 */
test('🔴 ヘルプの面が開き、マニュアルが描かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');

  // ① 版が**文字で**出る(hover の title ではない ── タッチ端末にも届く)
  const ver = page.locator('[data-pkc-field="help-version"]');
  await expect(ver).toBeVisible();
  expect((await ver.textContent()) ?? '', '版が出ていない').toMatch(/^pkc3 v\d/);

  // ② 過去のお知らせが出る
  await expect(page.locator('[data-pkc-help-notice]').first()).toBeVisible();

  /**
   * ③ 🔴 **マニュアルが描かれている**(worker 経路)。
   * ⚠ 器が在るだけでは足りない ── 「読み込んでいます…」のまま止まる形が
   *   まさにこの経路の失敗である。**中身の見出しが出たこと**を見る。
   */
  const manual = page.locator('[data-pkc-region="help-manual"]');
  await expect(manual).toBeVisible();
  await expect(manual.locator('h2', { hasText: '画面のならび' })).toBeVisible({
    timeout: 10_000,
  });

  expect(errors).toEqual([]);
});

/**
 * 🔴 **マニュアルの見出しが、本文の `#リンク` を横取りしない**(2026-08-08 に
 * 書き直した)。
 *
 * 面は `hidden` で**同一 document に常駐**するので、マニュアルの見出しが焼く
 * `id` は本文の見出しと**必ずぶつかりうる**(実測: 本文に `## 4. 画面のならび`
 * と書くと、`4-画面のならび` が detail と help の 2 面に出る)。
 *
 * ⚠ **1 巡目の検査は「重複が 0 件」を要求していたが、主張そのものが間違っていた** ──
 * user が同じ見出しを書けば必ず重複するので、守れない条件である。しかも
 * **ノートを 1 件も作っていなかった**ので、重複しうる材料がゼロ = 空振りでもあった
 * (CLAUDE.md「fixture のゼロ件の次元は測っていない次元」)。
 *
 * 🔑 **実害の形で書く**: 重複してよい。守るべきは
 *  ① `#slug` が**本文の面**に当たること(document 順で detail が先に在る)
 *  ② マニュアル側が**文書内アンカーを 1 つも持たない**こと(unit が pin 済み)
 * ── この 2 つが成り立つ限り、user の `#リンク` は自分の本文へ着く。
 */
test('🔴 マニュアルを開いても、本文の #リンクは本文へ着く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  // ⚠ **マニュアルと同じ見出し**を本文に書く(ぶつかる材料を作る)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('## 4. 画面のならび\n\n本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // マニュアルを描かせる(ここで初めて help 側の id が生える)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  await expect(
    page.locator('[data-pkc-region="help-manual"] h2', { hasText: '画面のならび' }),
  ).toBeVisible({ timeout: 10_000 });

  const r = await page.evaluate(() => {
    const paneOf = (el: Element | null): string | null =>
      el?.closest('[data-pkc-view-pane]')?.getAttribute('data-pkc-view-pane') ?? null;
    const id = '4-画面のならび';
    const all = [...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)];
    return { count: all.length, winner: paneOf(document.getElementById(id)) };
  });

  // ⚠ 前提: **本当にぶつかっている**(ぶつかっていなければ何も見ていない)
  expect(r.count, '同じ id が 2 面に出ていない(fixture の空振り)').toBeGreaterThan(1);
  // 🔴 それでも `#slug` は**本文の面**に当たる
  expect(r.winner, 'マニュアルの見出しが本文の #リンクを横取りした').toBe('detail');

  expect(errors).toEqual([]);
});

/**
 * 🔴 **起動したときのお知らせ**。⚠ かぶせる窓ではないので、**帯が出たまま
 * 作業できる**ことも観測点である(本文の面が押せる)。
 */
test('🔴 お知らせの帯が出て、閉じると次から出ない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  const band = page.locator('[data-pkc-region="announce"]');
  await expect(band, '起動時にお知らせが出ていない').toBeVisible({ timeout: 10_000 });
  // ⚠ 閉じたら二度と読めない、と思わせない
  await expect(band.locator('[data-pkc-field="announce-where"]')).toContainText('ヘルプ');

  /**
   * ⚠ **帯が出たまま作業できる**(かぶせる窓にしていない)。
   * `clickReal` はその座標で実際に最前面に居ることを確かめてから押すので、
   * 帯が本文を覆っていればここで落ちる。
   */
  await clickReal(page, '[data-pkc-field="create-pick"]');
  await page.keyboard.press('Escape');

  await clickReal(page, '[data-pkc-action="dismiss-announce"]');
  await expect(band, '閉じても残っている').toBeHidden();

  // 🔴 読んだものは**次の起動でも出ない**(既読が保存されている)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(band, '読んだお知らせが出直している').toBeHidden();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **お知らせは 1 件ずつ出て、「次へ」で送れる**(#475、実機検証レポート #16)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit は「1 件だけ描いた / 送ると id が変わった」までしか言えない。⚠ #475 の実害は
 * **帯が場所を取るのに読めない**ことだったので、見るべきは
 * ①**中でスクロールせずに 1 件が丸ごと見えるか** ②**送る手が押せるか**の 2 つで、
 * どちらも高さと重なりの話 ── 描いてみないと分からない。
 *
 * ⚠ **空振り防止を 2 つ置く** ── 未読が 2 件以上あること(1 件なら「次へ」は
 * 出ない = 何も測っていない)と、**送る前と後で id が変わる**こと。
 */
test('🔴 お知らせは 1 件ずつ出て、「次へ」で送れる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  const band = page.locator('[data-pkc-region="announce"]');
  await expect(band, '起動時にお知らせが出ていない').toBeVisible({ timeout: 10_000 });

  const shown = (): Promise<string[]> =>
    page.$$eval('[data-pkc-announce]', (els) =>
      els.map((e) => e.getAttribute('data-pkc-announce') ?? ''),
    );

  // 🔴 **積んでいない** ── 出ているのは 1 件だけ
  const first = await shown();
  expect(first, '1 件ずつではない(積んでいる)').toHaveLength(1);

  /**
   * 🔴 **その 1 件が、中でスクロールせずに丸ごと見える**(#475 の主張そのもの)。
   * ⚠ 直す前は 55 項目(10 件ぶん)が 144px の箱で流れていた ── 箱が大きいのに
   *   一度に 1 件しか読めない形だった。
   */
  const fit = await page
    .locator('[data-pkc-field="announce-body"]')
    .evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(
    fit.scroll,
    `1 件が箱に収まっていない(${fit.scroll} > ${fit.client})── 中を繰らせている`,
  ).toBeLessThanOrEqual(fit.client + 1);

  /**
   * 🔴 **帯そのものも、逃げ場を要らなくなっている。** ⚠ 直す前は 30vh の上限に
   *   当たっていた(実測 270px = 上限ぴったり)── 上限に当たる = **切り詰めている**
   *   ということなので、`scrollHeight === clientHeight` を見れば
   *   「収まっている」を版面の高さに依らず言える(px の閾値を置かない)。
   */
  const band0 = await band.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
  }));
  expect(
    band0.scroll,
    `帯が上限に当たっている(${band0.scroll} > ${band0.client})── 中を繰らせている`,
  ).toBeLessThanOrEqual(band0.client + 1);

  /**
   * 🔴 **帯の幅を使う**(#475)。⚠ 項目が 1 列だと、1280px の帯で 1 行 90 字ほどに
   *   なり、**読みにくいうえ縦を食う**。段に割ってあることを、
   *   **項目の x が揃っていない**ことで見る(`column-width` は器の幅で決まるので、
   *   閾値ではなく「2 列以上になっているか」で採るのが正しい)。
   * ⚠ 空振り防止 ── 項目が 2 つ以上あること。
   */
  const cols = await page.$$eval('[data-pkc-announce] li', (els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().left)),
  );
  expect(cols.length, '項目が 1 つしかない(段の検査にならない)').toBeGreaterThan(1);
  expect(new Set(cols).size, '項目が 1 列に並んでいる(帯の幅を使っていない)').toBeGreaterThan(1);

  /**
   * 🔴 **案内文と「今後は出さない」は 1 行**(#475)。⚠ 縦に積むと、読むもの
   *   から縦を奪う(実測で 26px + 余白)。**同じ行に在る**ことを中心の y で見る。
   */
  const footRow = await page.evaluate(() => {
    const w = document.querySelector('[data-pkc-field="announce-where"]');
    const m = document.querySelector('[data-pkc-action="mute-announce"]');
    if (!w || !m) return null;
    const a = w.getBoundingClientRect();
    const b = m.getBoundingClientRect();
    return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
  });
  expect(footRow, '案内文か「今後は出さない」が無い').not.toBeNull();
  expect(footRow!, '案内文と「今後は出さない」が別の行に在る(読むものから縦を奪う)')
    .toBeLessThanOrEqual(2);

  // ⚠ 空振り防止 ── 2 件以上なければ「次へ」は出ない = 以下を測っていない
  const next = page.locator('[data-pkc-action="next-announce"]');
  await expect(next, '未読が 1 件しか無い(「次へ」の検査になっていない)').toBeVisible();

  await clickReal(page, '[data-pkc-action="next-announce"]');
  const second = await shown();
  expect(second, '送ったのに次が出ない').toHaveLength(1);
  expect(second[0], '送っても同じお知らせが出ている').not.toBe(first[0]);
  // 🔑 **送っただけでは畳まない**(畳むのは「閉じる」と、残り 0 件のときだけ)
  await expect(band, '送っただけで帯が消えた').toBeVisible();

  /**
   * 🔴 **送った 1 件だけが既読になる。** ⚠ 読み込み直して、送った分が出直さず、
   *   まだ読んでいない分は残っていることを見る ── 「送る = 全部既読」の
   *   すり替えは、画面だけ見ていると分からない。
   */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(band, '読み込み直したら未読が消えた').toBeVisible({ timeout: 10_000 });
  const after = await shown();
  expect(after[0], '送ったお知らせが出直している').not.toBe(first[0]);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **お知らせが溢れていても、「閉じる」はその場で押せる**(#151)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit は「閉じるが流れる箱の外に在る」までしか言えない ── **実際に見えているか**は
 * 高さ・重なり・スクロール位置の話なので、描いてみないと分からない。
 *
 * ## ⚠ ここで `clickReal` / `expectReachable` を使ってはいけない
 *
 * あれらは `scrollIntoViewIfNeeded()` を挟む(`helpers.ts:150`。fold 下の要素を
 * 「覆われている」と誤診しないための正しい配慮である)。ところが #151 の欠陥は
 * **まさに「スクロールしないと届かない」**ことだったので、**検査が user の代わりに
 * スクロールして**しまい、壊れたまま CI が緑だった。
 * 🔑 だから**スクロールさせずに** `elementFromPoint` で当てる。
 *
 * ⚠ 空振り防止 ── 本文が実際に溢れていることを先に確かめる。溢れていない画面では
 * 「見えている」は自明で、この test は何も守らない。
 */
test('🔴 お知らせが溢れていても、閉じるはスクロールせずに押せる', async ({ page }) => {
  const errors = collectPageErrors(page);
  /**
   * ⚠ **低い版面で見る**(#475、2026-08-27)。帯は**1 件ずつ**出すようになったので、
   *   1280x900 では 1 件が丸ごと収まり(実測 band 199 / body 123 = client 123)、
   *   **溢れが起きない** ── そこで測ると下の空振り防止で止まる。
   * 🔑 溢れは**器の高さ**で起こす(30vh)。実測の分かれ目は 620px で、
   *   520px なら body 123 に対し器は 80 ── 確実に溢れる。
   * ⚠ **溢れ得ない版面で測らない**のが要点であって、値そのものは目的ではない。
   */
  await page.setViewportSize({ width: 1280, height: 520 });
  await gotoApp(page);

  const band = page.locator('[data-pkc-region="announce"]');
  await expect(band, '起動時にお知らせが出ていない').toBeVisible({ timeout: 10_000 });

  // ⚠ **溢れているか**を先に見る(この次元がゼロなら、以下は測っていないのと同じ)
  const box = await page.evaluate(() => {
    const b = document.querySelector('[data-pkc-field="announce-body"]');
    return b instanceof HTMLElement ? { scroll: b.scrollHeight, client: b.clientHeight } : null;
  });
  expect(box, '流れる本文の箱が無い').not.toBeNull();
  expect(
    box!.scroll,
    `本文が溢れていない(${box!.scroll} ≤ ${box!.client})── 見切れ得ないので検査にならない`,
  ).toBeGreaterThan(box!.client + 1);

  // 🔴 **スクロールさせずに**、その場で当たるか
  const hit = await page.evaluate(() => {
    const btn = document.querySelector('[data-pkc-action="dismiss-announce"]');
    if (!btn) return { ok: false, why: 'ボタンが無い' };
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { ok: false, why: '面積が無い' };
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok: !!(at && (at === btn || btn.contains(at))),
      why: at ? `${at.tagName}${at.getAttribute('data-pkc-region') ?? ''}` : '画面の外',
    };
  });
  expect(hit.ok, `閉じるがその場で押せない(当たったのは ${hit.why})`).toBe(true);

  /**
   * ⚠ **「見出しの右端にあります」は user への約束である**
   * (`notice-log.ts` のお知らせ / `docs/manual.md` §8)。⚠ 右へ寄せているのは
   * CSS 1 行(`margin-inline-start: auto`)だけなので、消えても上の当たり判定は
   * 通ってしまう ── **約束のほうを見る**。
   */
  const geo = await page.evaluate(() => {
    const btn = document.querySelector('[data-pkc-action="dismiss-announce"]');
    const head = document.querySelector('[data-pkc-field="announce-title"]');
    if (!btn || !head) return null;
    const body = document.querySelector('[data-pkc-field="announce-body"]');
    const b = btn.getBoundingClientRect();
    const h = head.getBoundingClientRect();
    const bd = body?.getBoundingClientRect();
    return {
      btnRight: b.right,
      headRight: h.right,
      headBottom: h.bottom,
      bodyTop: bd ? bd.top : null,
    };
  });
  expect(geo, '見出しか閉じるが無い').not.toBeNull();
  /**
   * ⚠ **「右の 7 割より右」では緩い**(レビュー 2026-08-14)。`margin-inline-start: auto`
   * は余白を**手前の要素の前**に吸うので、`head.append(close, label)` と書くと
   * 並びは「余白 → 閉じる → 題名」になり、**題名が右端**でもしきい値は通る。
   * 🔑 **右辺にぴったり**を見る。
   */
  expect(
    geo!.headRight - geo!.btnRight,
    '閉じるが見出しの右端に無い(お知らせとマニュアルの「右端」が嘘になる)',
  ).toBeLessThanOrEqual(2);

  /**
   * ⚠ **見出しが場所を取っていること**も見る ── `position: absolute` 等で
   * 流れから外すと、**見出しが本文に重なった**まま右端 assert も当たり判定も通る
   * (レビュー 2026-08-14 の指摘)。重なっていないことを見れば、その型は死ぬ。
   */
  expect(geo!.bodyTop, '流れる本文の箱が無い').not.toBeNull();
  expect(geo!.headBottom, '見出しが本文に重なっている(流れから外れている)').toBeLessThanOrEqual(
    geo!.bodyTop! + 1,
  );

  expect(errors).toEqual([]);
});

/**
 * 🔴 **中を送っても、閉じるはそこから動かない**(#151)。
 *
 * これは user への約束そのものである ── お知らせ本文と `docs/manual.md` §8 が
 * 「中の文をどれだけ送っても、そこから動きません」と書いている。
 *
 * ⚠ **`overflow: auto` を `hidden` に変えても、上の 2 つの test は通る**
 * (溢れているかは `scrollHeight > clientHeight` で真のまま、閉じるも見えている)。
 * その状態は **3 件目以降のお知らせが二度と読めない**という実害である。
 * 🔑 だから**実際にホイールを回して、送れたこと**を見る。
 * ⚠ `el.scrollTop = n` の代入では殺せない ── `overflow: hidden` でも代入は通る。
 */
test('🔴 お知らせの中を送っても、閉じるはそこから動かない', async ({ page }) => {
  const errors = collectPageErrors(page);
  // ⚠ 上と同じ理由で低い版面(1 件ずつになったので 900px では溢れない)
  await page.setViewportSize({ width: 1280, height: 520 });
  await gotoApp(page);

  const band = page.locator('[data-pkc-region="announce"]');
  await expect(band, '起動時にお知らせが出ていない').toBeVisible({ timeout: 10_000 });
  const body = page.locator('[data-pkc-field="announce-body"]');
  const box = await body.boundingBox();
  expect(box, '流れる本文の箱が無い').not.toBeNull();
  /**
   * ⚠ **空振り防止**(レビュー 2026-08-14)。本文が溢れていない画面では
   * `scrollTop` は 0 のままなので、「ホイールで送れない」という**原因を
   * 取り違えたメッセージ**で落ちる ── 登記表が減っただけのときに、
   * CSS の欠陥だと読んでしまう。
   */
  const fit = await body.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(fit.scroll, `本文が溢れていない(${fit.scroll} ≤ ${fit.client})`).toBeGreaterThan(
    fit.client + 1,
  );

  const before = await page.locator('[data-pkc-action="dismiss-announce"]').boundingBox();
  expect(before, '閉じるが画面に出ていない').not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 400);
  // 🔴 **送れたことを確かめる**(hidden ならここで止まる)
  await expect
    .poll(() => body.evaluate((el) => el.scrollTop), {
      message: 'ホイールで送れない ── 読めないお知らせが残る',
    })
    .toBeGreaterThan(0);

  // 🔑 送ったあとも**同じ場所に**在る(= 見出しごと流れていない)
  const after = await page.locator('[data-pkc-action="dismiss-announce"]').boundingBox();
  expect(after, '送ったら閉じるが消えた').not.toBeNull();
  expect(Math.abs(after!.y - before!.y), '送ったら閉じるが動いた').toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **低い画面でも、帯が版面を押し出さない**(#151 のレビューで判明)。
 *
 * 面ごと流すのをやめた副作用として、**本文を 0 まで縮めても入りきらない高さ**
 * では中身が帯の外へこぼれる。実測(直す前): H=260 で「今後は出さない」が
 * **画面の外**、`documentElement.scrollHeight` が 284 > 260 ──
 * **1 画面で完結する**(不可侵の「業務画面」)が崩れていた。
 * ⚠ 拡大表示で普通に届く高さである(900px の画面を 300% にすると 300px)。
 */
test('🔴 低い画面でも、お知らせの帯が画面ごとスクロールさせない', async ({ page }) => {
  const errors = collectPageErrors(page);
  /**
   * ⚠ **入りきらなくなる高さは 260 → 240 へ下がった**(#475、2026-08-27)。
   *   案内文と「今後は出さない」を 1 行に畳んだぶん、帯が要る最小の高さが
   *   26px 減ったためである(実測: H=260 では `scrollH 78 = clientH 78` で
   *   **溢れない** ── そこで測ると下の空振り防止が正しく止める)。
   * 🔑 分かれ目のすぐ隣(240、溢れ 4px)は脆いので **220** で見る
   *   (実測 `scrollH 76 > clientH 66`、かつ「今後は出さない」は
   *   帯の下端より下 = 逃げ場が無いと**到達できない**)。
   */
  await page.setViewportSize({ width: 1280, height: 220 });
  await gotoApp(page);
  await expect(page.locator('[data-pkc-region="announce"]')).toBeVisible({ timeout: 10_000 });

  const m = await page.evaluate(() => {
    const band = document.querySelector('[data-pkc-region="announce"]');
    const bandBox = band?.getBoundingClientRect();
    return {
      doc: document.documentElement.scrollHeight,
      view: window.innerHeight,
      bandBottom: bandBox ? bandBox.bottom : Number.POSITIVE_INFINITY,
      // ⚠ 空振り防止 ── 帯の中身が実際に入りきっていないこと(入るなら検査にならない)
      bandOverflows: band instanceof HTMLElement ? band.scrollHeight > band.clientHeight : false,
    };
  });
  expect(m.bandOverflows, '帯の中身が入りきっている ── この高さでは検査にならない').toBe(true);
  // 🔑 **帯の外形が画面に収まっている**(落ちたとき原因が名前で分かる側)
  expect(m.bandBottom, `帯が画面からはみ出している(${m.bandBottom} > ${m.view})`)
    .toBeLessThanOrEqual(m.view + 1);
  // ⚠ 版面全体 ── 帯以外の回帰でも鳴りうるので、上の 1 行と対で読む
  expect(m.doc, `版面が画面を押し出している(${m.doc} > ${m.view})`).toBeLessThanOrEqual(m.view + 1);

  /**
   * 🔴 **逃げ場が「効く」ことを見る**(レビュー 2026-08-14)。
   * ⚠ `overflow` が `visible` でないことだけ見ていたが、それは **`hidden` でも真** ──
   * その状態では「今後は出さない」へ**永久に到達できない**のに緑だった。
   * 🔑 実際にホイールを回し、送れたうえで**閉じるが画面に残る**ことまで見る
   * (`docs/manual.md` §8 の「どれだけ送っても画面から出ません」の実体)。
   */
  const band = page.locator('[data-pkc-region="announce"]');
  const bb = await band.boundingBox();
  expect(bb, '帯が画面に出ていない').not.toBeNull();
  await page.mouse.move(bb!.x + bb!.width / 2, bb!.y + bb!.height / 2);
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => band.evaluate((el) => el.scrollTop), {
      message: '帯に逃げ場が無い ── 「今後は出さない」へ到達できない',
    })
    .toBeGreaterThan(0);
  const closeBox = await page.locator('[data-pkc-action="dismiss-announce"]').boundingBox();
  expect(closeBox, '送ったら閉じるが消えた').not.toBeNull();
  expect(closeBox!.y, '送ったら閉じるが画面の外へ出た').toBeGreaterThanOrEqual(0);

  expect(errors).toEqual([]);
});
