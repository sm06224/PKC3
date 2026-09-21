import { test, expect, type Page } from '@playwright/test';
import { clickReal, createEntry, collectPageErrors, gotoApp, useSplitEditor,
  gotoCollectionPane,
} from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **本文のコピー 3 系統**(2026-08-08。user 裁定「マークダウンのテキストとしての
 * コピーが欲しい場合と HTML 書式ありのコピーがしたい場合ととかもある」)。
 *
 * 🔴 **unit(happy-dom)では届かない層が 3 つある**。ここはその 3 つだけを見る:
 *  ① **本物のクリップボード** ── happy-dom の `navigator.clipboard` は差し替え物で、
 *     `ClipboardItem` に text/plain と text/html を**両方**載せられたかは分からない。
 *     Word へ貼れるかの実体は「text/html が実際に入っているか」である
 *  ② **本物の選択**(`window.getSelection` + `Range`)── 選択の端点から
 *     `[data-pkc-source-line]` を辿って原文へ逆引きする経路は、実 DOM の選択でしか通らない
 *  ③ **`selectionchange` による活性の同期** ── 選択は state に無いので render の
 *     指紋では動かない。実際にイベントが飛んで disabled が外れるか
 *
 * ⚠ 観測点は「ボタンが在るか」ではなく **押した結果クリップボードに何が入ったか**。
 *
 * 🔴 **押した直後に読まない**(2026-08-08 にこの spec 自身で踏んだ)。コピーは
 *   非同期なので、クリック直後に `readText()` すると**1 つ前の内容**が返り、
 *   「text/html が載っていない」という**アプリの濡れ衣**になる(実際に一度そう読んだ)。
 *   待つのは**アプリ自身の信号** ── 成功すると押したボタンに `data-pkc-flash` が
 *   700ms だけ付く。⚠ 短いので**押す前に**観測を仕掛ける(後から探すと取りこぼす)。
 */
async function copyAndWait(page: Page, action: string): Promise<void> {
  const sel = `[data-pkc-action="${action}"]`;
  /**
   * 🔴 **仕掛ける前に「押し所が在る」ことを確かめる**(#878 ②、2026-09-13)。
   *
   * ⚠ 直す前は次の行がいきなり `document.querySelector(sel)!` を読んでいたので、
   *   まだ無い回は **non-null の `!` に隠れて** `MutationObserver.observe` が
   *   `TypeError: parameter 1 is not of type 'Node'` で死んだ ── 画面に何が
   *   起きていたのかが、その字からは 1 つも読めない。
   *
   * 🔑 **これは閾値の緩和ではない**(#878 が戒めている「症状の隠蔽」ではない):
   *
   * | | |
   * |---|---|
   * | 面が**開かない**(製品の不具合) | 🔴 2 秒で落ちる ── **文言がそう言う** |
   * | 面が**開くのが 1 拍遅い**(台の都合) | 🟢 待って進む |
   *
   * ⚠ **原因はまだ確定していない。** 有力なのは「`page.evaluate` が、直前に投げた
   *   マウス入力を追い越す」── 入力は**ブラウザ処理**を経て描画側へ渡るのに対し、
   *   `evaluate` は描画側へ直に入るので、**順番が保証されない**(全量のときだけ
   *   出るのは、描画側が忙しいほど差が開くから、と読める)。
   * 🔑 ⚠ **これは仮説である** ── 確かめていないので、ここには**待ちしか置かない**
   *   (仮説を後条件に固めない。CLAUDE.md §1「後条件は確かめた事実の上にだけ書く」)。
   * ⚠ 待ちを**短く**切ってあるのは、「開くのが遅くなった」という別の壊れ方を
   *   この待ちで飲み込まないためである。
   */
  await expect(
    page.locator(sel),
    `${action}: 押し所が画面に無い(面が開いていないか、出し分けが壊れている)`,
  ).toBeAttached({ timeout: 2_000 });
  // 押す前に仕掛ける ── 700ms で消える属性を後から探すと落ちる
  await page.evaluate((s) => {
    const el = document.querySelector(s)!;
    const w = window as unknown as { __flashed: Record<string, boolean> };
    w.__flashed = w.__flashed ?? {};
    w.__flashed[s] = false;
    const mo = new MutationObserver(() => {
      if (el.getAttribute('data-pkc-flash') === 'true') {
        w.__flashed[s] = true;
        mo.disconnect();
      }
    });
    mo.observe(el, { attributes: true, attributeFilter: ['data-pkc-flash'] });
  }, sel);
  await clickReal(page, sel);
  await expect
    .poll(
      () =>
        page.evaluate(
          (s) => (window as unknown as { __flashed: Record<string, boolean> }).__flashed[s],
          sel,
        ),
      { message: `${action}: コピー成功の合図が出ない(黙って失敗している)`, timeout: 10_000 },
    )
    .toBe(true);
}

test('🔴 本文を Markdown でも書式付きでもコピーでき、選択範囲は原文で入る', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoApp(page);

  // frontmatter を持つ本文 ── 選択範囲の逆引きは fm.body 基準なので、
  // ⚠ **frontmatter が非ゼロでないとその補正を 1 度も通らない**(測っていない次元になる)
  const BODY = ['---', 'align: left', '---', '', '# 題', '', '**強い**段落', '', '次の段落'].join(
    '\n',
  );
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(`${BODY}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toHaveText('題', {
    timeout: 15_000,
  });

  // ① Markdown をコピー = 原文がそのまま入る(描画されたテキストではない)
  await copyAndWait(page, 'copy-note-md');
  const plain = await page.evaluate(() => navigator.clipboard.readText());
  expect(plain, '原文ではなく描画後のテキストが入っている').toContain('**強い**段落');
  expect(plain, 'frontmatter ごと原文が入っていない').toContain('align: left');

  // ② 書式付きでコピー = text/html が**実際に**載っている(Word へ貼れる形)
  await copyAndWait(page, 'copy-note-rich');
  const rich = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const types = items.flatMap((i) => i.types);
    const html = types.includes('text/html')
      ? await (await items[0]!.getType('text/html')).text()
      : '';
    return { types, html };
  });
  expect(rich.types, 'text/plain が載っていない(素のテキストで貼れない)').toContain('text/plain');
  expect(rich.types, 'text/html が載っていない(Word に貼っても素のテキストになる)').toContain(
    'text/html',
  );
  expect(rich.html, '書式が落ちている(強調が要素になっていない)').toMatch(/<(strong|b)\b/);

  // ③ 選択が無い間は押せない
  const sel = page.locator('[data-pkc-action="copy-selection-md"]');
  await expect(sel, '選択していないのに「選択範囲をコピー」が押せる').toBeDisabled();

  // ④ 本物の選択を作ると活性になり、押すと**原文**が入る(描画テキストではない)
  await page.evaluate(() => {
    const p = document.querySelector('[data-pkc-field="detail-body"] p');
    const r = document.createRange();
    r.selectNodeContents(p!);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await expect(sel, 'selectionchange で活性にならない(選択しても押せない)').toBeEnabled({
    timeout: 10_000,
  });
  await copyAndWait(page, 'copy-selection-md');
  const picked = await page.evaluate(() => navigator.clipboard.readText());
  // ⚠ **原文**であること ── 描画テキストなら「強い段落」になる。記号が残るのが正しい
  expect(picked, '選択範囲が原文ではなく描画テキストで入っている').toContain('**強い**');
  // ⚠ frontmatter の行ずれが無いこと ── 補正を落とすと 3 行ずれて別の行が入る
  expect(picked, 'frontmatter の行数だけずれた別の行が入っている').not.toContain('align: left');
  expect(picked, '選択していない次の段落まで入っている').not.toContain('次の段落');

  expect(errors).toEqual([]);
});

/**
 * 🔴 **ノートの参照をコピーする**(#427 段①)。
 *
 * 🔴 **unit では届かない層**:`navigator.clipboard` は happy-dom では差し替え物なので、
 *   「**本当にクリップボードへ入ったか**」は実ブラウザでしか見えない。
 *   そして**貼って押すと本当にそのノートが開くか**は、記法の読み手まで通す必要がある。
 */
test('🔴 参照をコピーして別のノートに貼ると、押してそのノートへ移れる (#427)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoApp(page);

  // ① リンク先のノートを作る
  await createEntry(page, 'text');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('先週の議事録');
  await page.locator('[data-pkc-field="editor-body"]').fill('先週の中身\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  // ② その参照をコピー(#427 段① で足した口)
  await copyAndWait(page, 'copy-entry-ref');
  const ref = await page.evaluate(() => navigator.clipboard.readText());
  expect(ref, '貼れる 1 行になっていない').toMatch(/^\[先週の議事録\]\(entry:.+\)$/);

  // ③ 別のノートに貼る
  await createEntry(page, 'text');
  const t2 = page.locator('[data-pkc-field="editor-title"]');
  if (await t2.count()) await t2.fill('今週の会議');
  await page.locator('[data-pkc-field="editor-body"]').fill(`続き: ${ref}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  /**
   * ④ 🔴 **押すとそのノートが開く** ── ここまで通して初めて
   *   「リンクを張れた」と言える(貼れる形になっただけでは足りない)。
   */
  const link = page.locator('[data-pkc-field="detail-body"] a', { hasText: '先週の議事録' });
  await expect(link, '貼ったものがリンクになっていない').toHaveCount(1);
  await link.click();
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '押しても相手のノートが開かない',
  ).toContainText('先週の中身', { timeout: 15_000 });

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **構成をコピー**(#429 段①)。
 *
 * 🔴 **unit では届かない層**:`navigator.clipboard` は happy-dom では差し替え物
 *   なので、「**本当にクリップボードへ入ったか**」は実ブラウザでしか見えない。
 */
test('🔴 構成をコピーすると、貼れる 1 枚が本当に入る (#429)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoApp(page);

  /**
   * 🔴 **押し口は「設定の面」ではなく「右の列」である**(2026-09-21 に直した)。
   *
   * ⚠ `export-structure` は **#1017 段④a(`b19e52f`)で右の列へ引っ越した**のに、
   *   この spec は**設定の面へ移って押す**古い動線のままだった ── つまり
   *   引っ越した日から **`export-structure: 押し所が画面に無い` で落ち続けていた**
   *   (CLAUDE.md「口を割ったら、その口の名前を書いている所を全部 grep する」)。
   *
   * 🔑 右の列は「**何も選んでいない = コレクションを選んでいる**」ときに出る。
   *   ⚠ ノートを作ると必ずそれが選ばれるので、**2 件作って両方に印を付け、
   *   「選択を解除」で外す**(それが画面に在る唯一の外し方である ── 印が
   *   2 件以上のときだけ出る帯)。
   */
  await page.setViewportSize({ width: 1280, height: 800 });
  // ① ノートを 2 件作る(空だと断られる ── それは別の検査)
  await createEntry(page, 'text');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('会議メモ');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  // ② 2 件に印を付けて「選択を解除」── これで右の列がコレクションの面になる
  await gotoCollectionPane(page);
  await copyAndWait(page, 'export-structure');

  // ③ 🔴 **貼れる 1 枚**が入っている ── 木 + コマンドの書き方の両方
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text, '題名が入っていない').toContain('会議メモ');
  expect(text, 'コマンドの書き方が入っていない').toContain('mv ');
  expect(text, 'mkdir の説明が入っていない').toContain('mkdir ');
  expect(text, 'rename の説明が入っていない').toContain('rename ');
  /**
   * ⚠ **lid の字種を決め打ちしない**(1 稿目はハイフンを許さず落ちた ──
   *   実物は `mta73ihn-0001` の形)。🔑 見たいのは
   *   「**題名の左に、空白 2 つで区切られた識別子が在る**」ことだけである。
   */
  expect(text, 'lid が入っていない(mv が書けない)').toMatch(/\n\S{6,}\s{2}会議メモ/);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
