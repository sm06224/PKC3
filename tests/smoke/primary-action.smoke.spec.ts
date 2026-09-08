import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

// ⚠ 既定は live ── この test は**読む面**の主(「編集」)を見るので、
//    保存して読む面へ戻れる split で組む(live の顔は unit と別の spec が守る)。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **その面の「主の操作」だけ、地と字が反転して見える**(#722 P2-10。
 * user 裁定 2026-09-06 = 案 A)。
 *
 * ⚠ **unit では原理的に届かない** ── happy-dom は CSS を組まないので、印
 * (`data-pkc-primary`)が付いているかしか見られない。**本当に濃く見えるか**は
 * ここでしか分からない。⚠ しかも規則は**詳細度で外れやすい**
 * (`button:hover:not(:disabled)` は `button[data-pkc-primary]` より強い)ので、
 * **乗せたときも濃いまま**を見る。
 *
 * 観測点は 3 つ:
 * ① 主のボタンの地が、**普通のボタンの字の色**と同じ(= 対を入れ替えている)
 * ② 主のボタンの字が、**普通のボタンの地の色**と同じ
 * ③ 🔴 **乗せても濃いまま**(詳細度の罠を落とす)
 * ⚠ 空振り防止:同じ面の普通のボタンの地と**違う**ことを見る(同じなら反転していない)。
 */
test('🔴 主の操作だけ地と字が反転して見える (#722 P2-10)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('本文です。\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  /**
   * 🔴 **鼠を退かしてから測る**(変異試験 M5 が SURVIVED で教えた)。
   * ⚠ `clickReal` の直後は**押した場所に鼠が残る**ので、帯が描き直されると
   *   新しい「編集」が**乗せられた状態**で出る ── そこで測ると、
   *   `:hover` の規則が当たった値を「素の見え方」として読んでしまう。
   *   実際、素の規則から `color` を消す変異が**smoke を素通りした**
   *   (hover 側の `color` に救われていた ── CLAUDE.md §1「救い手が変わっただけ」)。
   */
  await page.mouse.move(0, 0);

  const paint = async (sel: string): Promise<{ bg: string; fg: string }> =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el === null) throw new Error(`前提が崩れている: ${s} が無い`);
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    }, sel);

  // 読む面の主 =「編集」
  const primary = await paint('[data-pkc-region="detail"] button[data-pkc-primary]');
  // 同じ面の普通のボタン(コピーの帯)
  const plain = await paint(
    '[data-pkc-region="detail"] button[data-pkc-action="copy-note-md"]',
  );

  // ⚠ 空振り防止 ── 反転していなければ、以下の 2 つは自明に成り立つ
  expect(primary.bg, `主のボタンの地が普通のボタンと同じ(${primary.bg})── 濃くなっていない`).not.toBe(
    plain.bg,
  );
  // ① 主の地 = 普通の字 / ② 主の字 = 普通の地
  expect(primary.bg, `地が入れ替わっていない(主 ${primary.bg} / 普通の字 ${plain.fg})`).toBe(plain.fg);
  expect(primary.fg, `字が入れ替わっていない(主 ${primary.fg} / 普通の地 ${plain.bg})`).toBe(plain.bg);

  /**
   * ③ 🔴 **一覧の主も濃い**(着地前レビュー・実装 3)。
   * ⚠ 印の**個数**だけ数えていると、規則を `[data-pkc-field='detail-toolbar']` で
   *   包む変異(詳細度の喧嘩に確実に勝つ、ありそうな直し方)で
   *   **「+ ノート」だけ黙って死ぬ**のに全部緑になる ── 面ごとに**色を測る**。
   */
  const sideP = await paint('[data-pkc-region="sidebar"] button[data-pkc-primary]');
  const sidePlain = await paint('[data-pkc-field="open-today"]');
  expect(sideP.bg, `一覧の主が濃くなっていない(${sideP.bg} / 普通の字 ${sidePlain.fg})`).toBe(
    sidePlain.fg,
  );
  expect(sideP.fg, `一覧の主の字が反転していない(${sideP.fg} / 普通の地 ${sidePlain.bg})`).toBe(
    sidePlain.bg,
  );

  // ④ 🔴 乗せても濃いまま(`button:hover` のほうが詳細度が高い ── 書き足さないと外れる)
  await page.locator('[data-pkc-region="detail"] button[data-pkc-primary]').hover();
  const hovered = await paint('[data-pkc-region="detail"] button[data-pkc-primary]');
  expect(hovered.bg, `乗せたら地が普通のボタンへ戻った(${hovered.bg})`).toBe(primary.bg);
  // ⚠ **字も見る**(着地前レビュー・実装 2)── 地だけ見ていると、帯の hover が当てる
  //    `--accent-dim-fg` が残って**濃い地に濃い字**になる変異が生き延びる
  expect(hovered.fg, `乗せたら字の色が変わった(${hovered.fg})── 濃い地に濃い字になる`).toBe(
    primary.fg,
  );

  /**
   * ⑤ 🔴 **マウスで押したら、乗せているときと違う濃さになる**(着地前レビュー・動線 6)。
   * ⚠ 押している間は `:hover` も同時に当たるので、`:active` の詳細度が低いと
   *   **`:hover` の値が出続ける** ── 主のボタンだけ「押した手応え」が返らない
   *   (普通のボタンは `--accent-dim` に変わるのに)。
   * 🔑 観測点は `opacity`(この 2 状態はそこだけが違う)。
   */
  const opacityNow = async (): Promise<string> =>
    page.evaluate(() => {
      const el = document.querySelector('[data-pkc-region="detail"] button[data-pkc-primary]');
      if (el === null) throw new Error('前提が崩れている: 主のボタンが無い');
      return getComputedStyle(el).opacity;
    });
  const primBox = (await page
    .locator('[data-pkc-region="detail"] button[data-pkc-primary]')
    .boundingBox())!;
  await page.mouse.move(primBox.x + primBox.width / 2, primBox.y + primBox.height / 2);
  const onHover = await opacityNow();
  await page.mouse.down();
  const onPress = await opacityNow();
  // ⚠ **押した場所から離してから放す** ── 同じ所で放すと「押した」ことになり、
  //    編集へ入ってしまう(1 稿目でそう外して、次の段の前提が崩れた)
  await page.mouse.move(0, 0);
  await page.mouse.up();
  // ⚠ 空振り防止 ── 乗せた状態が素(1)のままなら、この比較は何も見ていない
  expect(onHover, `乗せても何も変わっていない(opacity ${onHover})`).not.toBe('1');
  expect(onPress, `押しても乗せているときと同じ(opacity ${onPress})── 手応えが返らない`).not.toBe(
    onHover,
  );

  /**
   * ⑥ 🔴 **焦点を当てても濃いまま**(着地前レビュー・実装 7)。
   * ⚠ 帯の `:focus-visible` は(0,3,1)なので、印つきの規則を書かないと
   *   **`Tab` で触った瞬間に段が消える** ── 鍵で操作する人が主の操作を見失う。
   */
  await page.mouse.move(0, 0);
  /**
   * ⚠ **鍵で移る**(変異試験 N3 が SURVIVED で教えた)── `.focus()` を呼んだだけでは
   *   `:focus-visible` に当たらない(ブラウザは「鍵で移ったか」で決める)。
   *   🔑 隣のボタンへ焦点を置いて **`Shift+Tab`** で戻る = 本物の鍵の移動にする。
   */
  await page.locator('[data-pkc-region="detail"] button[data-pkc-action="copy-note-md"]').focus();
  await page.keyboard.press('Shift+Tab');
  /**
   * ⚠ **空振り防止**(変異試験 N3 が SURVIVED で教えた)── `.focus()` を呼んだだけでは
   *   `:focus-visible` に**当たらないことがある**(ブラウザは「鍵で移ったか」で決める)。
   *   当たっていなければ、この段は**素の見え方をもう一度測っているだけ**である。
   */
  const focusVisible = await page.evaluate(() => {
    const el = document.querySelector('[data-pkc-region="detail"] button[data-pkc-primary]');
    return el !== null && el.matches(':focus-visible');
  });
  expect(focusVisible, '焦点の輪が出ていない ── :focus-visible を 1 度も見ていない').toBe(true);
  const focused = await paint('[data-pkc-region="detail"] button[data-pkc-primary]');
  expect(focused.bg, `焦点を当てたら地が変わった(${focused.bg})`).toBe(primary.bg);
  expect(focused.fg, `焦点を当てたら字の色が変わった(${focused.fg})`).toBe(primary.fg);

  /**
   * 🔴 **1 面に 1 つだけ**。⚠ 左の列の「+ ノート」と中央で **2 つ**が上限
   * (面が別なら別々に 1 つずつ)。
   */
  const counts = await page.evaluate(() =>
    ['sidebar', 'detail', 'append', 'inspector'].map((r) => ({
      r,
      n: document.querySelectorAll(`[data-pkc-region="${r}"] button[data-pkc-primary]`).length,
    })),
  );
  for (const { r, n } of counts) {
    expect(n, `面 ${r} に主の操作が ${n} 個ある(1 つを超えると段が消える)`).toBeLessThanOrEqual(1);
  }
  expect(
    counts.filter((c) => c.n === 1).map((c) => c.r).sort(),
    '主の操作が出ている面が想定と違う',
  ).toEqual(['detail', 'sidebar']);

  /**
   * ⑦ 🔴 **編集中は「+ ノート」が濃くなくなる**(着地前レビュー・動線 1)。
   * ⚠ `CREATE_ENTRY` は編集中を**黙って捨てる**ので、押しても 1 ドットも動かない
   *   ── そこを画面でいちばん濃くすると、「濃い = 次に押す物」が嘘になる。
   */
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]'),
    '編集の帯が出ていない(前提が崩れている)',
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        page.locator('[data-pkc-region="sidebar"] button[data-pkc-primary]').count(),
      { timeout: 5000 },
    )
    .toBe(0);
  // ⚠ 対照群 ── 中央の「保存」は濃い(そちらまで消えていたら判定になっていない)
  expect(
    await page.locator('[data-pkc-region="detail"] button[data-pkc-primary]').count(),
    '編集中に中央の主まで消えた',
  ).toBe(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **編集中の「+ ノート」は薄くなり、鍵で撃つと理由が出る**(#761)。
 *
 * ⚠ **unit では届かない 2 つ**をここで見る:
 * ① **`disabled` に CSS が本当に効くか** ── happy-dom は CSS を組まないので、
 *    属性が付いていることしか見られない。薄さの出どころは `app.css` の
 *    `button:disabled { opacity: .45 }` **1 本だけ**である。
 *    ⚠ 🔴 **註記を直した**(2026-09-08、着地前レビュー)── 直す前ここには
 *    「主の印(`button[data-pkc-primary]`)を外し忘れると濃いままになる /
 *    その対が効いているかはここでしか分からない」と書いてあったが、**嘘だった**:
 *    `[data-pkc-primary]` は `background` / `color` / `border-color` しか書かず、
 *    `opacity` を書く 2 本は `:hover:not(:disabled)` と `:active:not(:disabled)` で
 *    **`:disabled` には当たらない**。つまり `setPrimary` を落としても薄さは 0.45 の
 *    まま = この検査は通る。**対が効いていることは unit が見ている**
 *    (`primary-action.test.ts`「編集中は、左の列の『+ ノート』が濃くなくなる」)。
 *    🔑 CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」。
 *    ⚠ そのうえで**印そのものも 1 行見る**(下)── 薄さとは別の主張である
 * ② **本物の鍵**で撃ったときに、画面へ理由の 1 行が出るか
 *
 * ⚠ 空振り防止:**読んでいる間は薄くない**ことを先に測る(いつも薄いなら何も見ていない)。
 */
test('🔴 編集中は「+ ノート」が薄くなり、鍵で撃つと理由が出る (#761)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('本文です。\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.mouse.move(0, 0);

  const create = page.locator('[data-pkc-field="create-run"]');
  const look = async (): Promise<{ opacity: number; disabled: boolean }> =>
    create.evaluate((el) => ({
      opacity: Number(getComputedStyle(el).opacity),
      disabled: (el as HTMLButtonElement).disabled,
    }));

  // ── ⚠ 前提(空振り防止)── 読んでいる間は押せて、薄くない
  const before = await look();
  expect(before.disabled, '読んでいるのに押せない').toBe(false);
  expect(before.opacity, '読んでいるのに薄い(いつも薄いなら何も見ていない)').toBeGreaterThan(0.9);

  // ── ① 編集に入ると薄くなる
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => (await look()).disabled, { timeout: 10_000 })
    .toBe(true);
  const editing = await look();
  expect(editing.opacity, '編集中なのに薄くなっていない(disabled に CSS が効いていない)').toBeLessThan(
    0.6,
  );
  // ⚠ 薄さとは**別の主張** ── 印を外し忘れても薄さは変わらないので、ここで直に見る
  expect(
    await create.getAttribute('data-pkc-primary'),
    '編集中なのに主の印が残っている(地が反転したままになる)',
  ).toBeNull();

  /*
   * 🔴 **隣の「今日」も薄い**(#791 ①。user 裁定 2026-09-08)。
   * ⚠ ここでしか見えない ── happy-dom は CSS を組まないので `disabled` しか分からない。
   * 🔑 **対照群を同じ息で見る**:同じ帯の「添付」は**編集中でも使える**ので薄くない
   *   ── これが無いと「帯ごと薄くする」実装でも通る。
   */
  const opacityOf = async (field: string): Promise<number> =>
    page
      .locator(`[data-pkc-field="${field}"]`)
      .evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacityOf('open-today'), '編集中なのに「今日」が薄くなっていない').toBeLessThan(0.6);
  expect(
    await opacityOf('attach-file'),
    '編集中でも使える「添付」まで薄くなった(帯ごと薄くしている?)',
  ).toBeGreaterThan(0.9);

  /**
   * ── ② 🔴 **本物の鍵**で撃つと、画面の下に理由が 1 行出る。
   *
   * ⚠ **先に焦点を打つ欄から外す** ── 本文を打っている最中は、**その手前に
   *   もっと古い門が在る**(`typing` の判定:文字を打つ欄に焦点があるときは
   *   全域の鍵を通さない)。⚠ そこは「打っている途中に別のノートへ飛ばない」
   *   ための意図的な門で、#761 が直す所ではない。
   * 🔑 だからこの検査が見るのは「**鍵がボタンまで届いたとき**、黙って無反応に
   *   ならないこと」である ── 焦点が欄の外(左の列を触った後など)なら届く。
   */
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press('Control+n');
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status, '鍵で撃ったのに理由が出ない').toContainText('編集中は使えません', {
    timeout: 10_000,
  });
  // 🔑 出口も画面に出ている(「使えません」だけだと、どこを押せばよいか分からない)
  await expect(status, '出口(保存 / キャンセル)を言っていない').toContainText('保存');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
