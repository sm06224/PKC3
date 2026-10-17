/**
 * 🔴 **タグを「その場で打つ」**(#494)を、実ブラウザで見る。
 *
 * > user 指摘 2026-08-27:「**タグの設定が Apple のメモアプリと違い、直感的に
 * > ここにタグを打つ!って感じの動作じゃなくて yamlfrontmatter なのは問題だ。
 * > しかも設定動線がよくわからん**」
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 **打った字が本文に残る**(開き直しても) | 実 worker(sqlite)を通る |
 * | 🔴 **候補が実 worker の走査から出る** | unit の `queryScan` は fake |
 * | 実キーボードの Enter(IME を通らない素の確定) | 合成 event ではない |
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, writesLanded } from './helpers';

const INPUT = '[data-pkc-field="tag-add-input"]';
const CHIPS = '[data-pkc-region="inspector"] [data-pkc-field="inspector-tag"]';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/** ノートを 1 件作って保存する(タグを打てる状態 = `ready`)。 */
async function makeNote(page: import('@playwright/test').Page, title: string, body: string) {
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', title);
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

test('🔴 情報ペインでタグを打つと本文に入り、開き直しても残る (#494)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, '買い出しメモ', '牛乳と卵\n');

  // 🔴 **打つ欄がその場に在る**(user 指摘の中心)
  await expect(page.locator(INPUT), 'タグを打つ欄が情報ペインに無い').toBeVisible();
  await page.fill(INPUT, '買い物');
  await page.locator(INPUT).press('Enter');

  // 札になって出る
  await expect(page.locator(CHIPS)).toHaveCount(1);
  await expect(page.locator(CHIPS).first()).toContainText('買い物');
  // ⚠ 通ったら欄は空(次の 1 つを打てる)
  await expect(page.locator(INPUT)).toHaveValue('');

  /**
   * 🔴 **本文に入っていること**を、画面の札ではなく**本文そのもの**で見る ──
   * 札だけ見ると「画面には出たが disk に届いていない」を素通りする。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const body = await page.inputValue('[data-pkc-field="editor-body"]');
  expect(body, 'frontmatter に入っていない').toContain('tags:');
  expect(body, 'タグが入っていない').toContain('買い物');
  expect(body, '本文を踏み潰した').toContain('牛乳と卵');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 🔴 **読み直しても残る**(disk まで届いた証拠)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await clickReal(page, '[data-pkc-region="filer-table"] [data-pkc-entry], [data-pkc-entry]');
  await expect(page.locator(CHIPS).first(), '読み直したら消えた').toContainText('買い物');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **片道の操作を作らない**(裁定 2026-08-23)。
 * ⚠ 打てるのに外せないと、間違えたタグを消すために**本文を開いて frontmatter を
 *   直す**ことになる ── それは動線を 1 つ失うのと同じである。
 */
test('🔴 札の × で外れ、本文からも消える (#494)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, 'メモ', '---\ntags: [買い物, 家事]\n---\n本文\n');

  await expect(page.locator(CHIPS)).toHaveCount(2);
  // 🔴 束 H1: 絵文字を含む本文の「全体の字数」は見た目の字の数 / フォルダの「中身 N 件」(道中に足す。起動は増やさない)
  const insp = page.locator('[data-pkc-region="inspector"]');
  await expect(insp.locator('[data-pkc-field="inspector-stats"]'), '前提: 字数が出ない').toBeVisible();
  const before = await insp.locator('[data-pkc-field="inspector-stats"]').innerText();
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await page.fill('[data-pkc-field="editor-body"]', '---\ntags: [買い物, 家事]\n---\n👨\u200D👩\u200D👧\u200D👦👍🏽🇯🇵ab\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const total = (s: string): number => Number(/(\d[\d,]*)\s*文字/.exec(s)?.[1]?.replace(/,/g, '') ?? NaN);
  const afterTxt = await insp.locator('[data-pkc-field="inspector-stats"]').innerText();
  // 前書き(--- 〜 ---)の 31 字 + 家族 1 + 👍🏽 1 + 国旗 1 + ab 2 + 改行 = 見た目の字。絵文字を UTF-16 で数えると大きく超える
  const expectedChars = Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment('---\ntags: [買い物, 家事]\n---\n👨\u200D👩\u200D👧\u200D👦👍🏽🇯🇵ab\n')).length;
  expect(total(afterTxt), `全体の字数が見た目の字の数でない(前:${before} / 後:${afterTxt})`).toBe(expectedChars);
  await clickReal(
    page,
    '[data-pkc-region="inspector"] [data-pkc-field="inspector-tag-off"][data-pkc-tag="買い物"]',
  );
  await expect(page.locator(CHIPS), '外れていない').toHaveCount(1);
  await expect(page.locator(CHIPS).first()).toContainText('家事');

  await clickReal(page, '[data-pkc-action="start-edit"]');
  const body = await page.inputValue('[data-pkc-field="editor-body"]');
  expect(body, '本文から消えていない').not.toContain('買い物');
  expect(body, 'もう片方まで消えた').toContain('家事');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  /**
   * 🔴 **41 字以上のタグを持つノートへ別のタグを足しても、長いタグが消えない**(#1087)。
   * ⚠ 上の道中の続きに載せる(新しく起動しない)。
   */
  const LONG = 'あ'.repeat(45);
  await makeNote(page, '長いタグ', `---\ntags: [${LONG}]\n---\n本文\n`);
  await page.fill(INPUT, '追加');
  await page.locator(INPUT).press('Enter');
  await expect(page.locator(CHIPS).filter({ hasText: '追加' }), '足したタグが札に出ない').toHaveCount(1);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const body2 = await page.inputValue('[data-pkc-field="editor-body"]');
  expect(body2, '長いタグが本文から消えた').toContain(LONG);
  expect(body2, '足したタグが本文に無い').toContain('追加');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  /**
   * 🔴 束 H1: タグの前書きが読み違える形(複数行の `[ ]`)のとき、その場で言い、足し外しの欄を出さない。
   * ⚠ 対照群は上の普通のノート(欄が出ている)。
   */
  await expect(page.locator(INPUT), '前提: 普通のノートでは足す欄が出る').toBeVisible();
  await makeNote(page, '読み違える', '---\ntags: [a,\n b]\n---\n本文\n');
  await expect(
    insp.locator('[data-pkc-field="inspector-tags-problem"]'),
    '読み違える書き方なのに知らせが出ない',
  ).toContainText('文書の情報に読めない書き方があります');
  await expect(page.locator(INPUT), 'タグの足し外しの欄が止まっていない').toBeHidden();

  /** 🔴 束 H1: 「関連」は向きを区別しない ── A→B を作ったあと B→A を作ろうとすると断られる。 */
  const rel = page.locator('[data-pkc-field="relation-add"]');
  const relRows = insp.locator('[data-pkc-field="inspector-relation"]');
  const pick = (title: string) =>
    clickReal(page, `[data-pkc-region="filer-table"] [data-pkc-entry]:has-text("${title}")`);
  await pick('長いタグ');
  await expect(relRows, '前提: 関連がまだ無い').toHaveCount(0);
  await rel.locator('[data-pkc-field="relation-kind"]').selectOption('semantic');
  await rel.locator('[data-pkc-field="relation-target"]').fill('読み違える');
  await clickReal(page, '[data-pkc-action="add-relation"]');
  await expect(relRows, '前提: A→B の関連が付かない').toHaveCount(1);
  await pick('読み違える');
  await expect(relRows, '前提: 相手側にも出ている').toHaveCount(1);
  await rel.locator('[data-pkc-field="relation-kind"]').selectOption('semantic');
  await rel.locator('[data-pkc-field="relation-target"]').fill('長いタグ');
  await clickReal(page, '[data-pkc-action="add-relation"]');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '反対向きの「関連」が断られない',
  ).toContainText('向きを区別しません');
  await expect(relRows, '断られたのに関連が増えた').toHaveCount(1);

  /**
   * 🔴 束 G2(台帳 #1852 / 依頼 299): つながりの相手がゴミ箱の中に居ると、右のペインはゴミ箱の一覧を読む前は「ゴミ箱の中かもしれません」、読んだ後は「題名(ゴミ箱の中)」と言い、押しても開かない。
   * ⚠ 直す前は「(見つかりません)」で、壊れたつながりに見えた。起動は増やさない(上で作った 2 件の関連を使う)。
   */
  await pick('長いタグ');
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  await writesLanded(page);
  // つながり自体は disk に残る(相手を戻せるように)── 読み込み直すと、相手の居ないつながりとして読まれる
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await pick('読み違える');
  await expect(relRows, '相手をゴミ箱へ移して読み込み直したら、つながりが消えた(戻せる形で残るはず)').toHaveCount(1);
  const relTarget = relRows.locator('[data-pkc-field="relation-target-link"]');
  await expect(relTarget, 'ゴミ箱の中かもしれないと言っていない').toContainText('(見つかりません。ゴミ箱の中かもしれません)');
  expect(await relTarget.evaluate((el) => el.tagName), '押せる顔(button)になっている').toBe('SPAN');
  const titleBefore = await page.locator('[data-pkc-field="detail-title"]').allTextContents();
  await relTarget.click({ force: true });
  expect(
    await page.locator('[data-pkc-field="detail-title"]').allTextContents(),
    '押したら別のノートが開いた(ゴミ箱の中の相手は開かないはず)',
  ).toEqual(titleBefore);
  // ゴミ箱の一覧を開いていれば題名も言う
  await clickReal(page, '[data-pkc-action="show-trash"]');
  await expect(relTarget, 'ゴミ箱の一覧を開いても題名が出ない').toContainText('長いタグ(ゴミ箱の中)');

  /** 🔴 束 H1: フォルダを開くと「中身 N 件」が出る(同じ道中。起動は増やさない)。 */
  await createEntry(page, 'folder');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(
    insp.locator('[data-pkc-field="inspector-children"]'),
    'フォルダの「中身 N 件」が出ない',
  ).toHaveText(/^\d+ 件$/);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **既にあるタグから選べる**(#494 段②)。
 * ⚠ 観測点は**実 worker の走査から来た候補**(unit の fake ではない)。
 */
test('🔴 既に使っているタグが候補に出る (#494 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, '先のノート', '---\ntags: [請求済]\n---\n本文\n');
  await makeNote(page, '後のノート', '本文だけ\n');

  // ⚠ **焦点が当たるまでは集めない**(打たない人に払わせない)
  expect(
    await page.locator('#pkc-tag-candidates option').count(),
    '開いただけで候補が出ている',
  ).toBe(0);

  await page.locator(INPUT).focus();
  await expect
    .poll(async () => page.locator('#pkc-tag-candidates option').count(), { timeout: 5000 })
    .toBeGreaterThan(0);
  const opts = await page.locator('#pkc-tag-candidates option').allTextContents();
  const values = await page
    .locator('#pkc-tag-candidates option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(values, `候補に「請求済」が無い(${JSON.stringify(opts)})`).toContain('請求済');
  // ⚠ 「未設定」の組(空文字)が混ざっていない ── 押すと空の字がタグになる
  expect(values.includes(''), '空の候補が出ている').toBe(false);

  /**
   * 🔴 #1852 束 B1: 全角半角・末尾の読点が違うだけのタグは 1 つにまとまる(候補は集計と同じ口)。
   * ⚠ 起動を足さず、この道中へ載せた。新しく作った 3 件のうち、見た目が違う 3 通りが 1 つの候補になる。
   */
  await makeNote(page, '全角のタグ', '---\ntags: [ｔａｇ]\n---\n本文\n');
  await makeNote(page, '半角のタグ', '---\ntags: [tag]\n---\n本文\n');
  await makeNote(page, '読点つきのタグ', '---\ntags: [tag、]\n---\n本文\n');
  // ⚠ 開いているノートが「tag」を持っていると、その候補は自分のタグとして外れて数が合わなくなる(空振り)。
  //   タグを持たないノートを開いてから候補を見る
  await makeNote(page, 'ＡＢＣ会議', '本文\n');
  await page.locator(INPUT).focus();
  await expect
    .poll(async () => page.locator('#pkc-tag-candidates option').count(), { timeout: 5000 })
    .toBeGreaterThan(1);
  const values2 = await page
    .locator('#pkc-tag-candidates option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(
    values2.filter((v) => /^(ｔａｇ|tag)/u.test(v)),
    `全角 / 半角 / 読点つきの「tag」が 1 つにまとまっていない(${JSON.stringify(values2)})`,
  ).toHaveLength(1);
  expect(values2.some((v) => /[、。]$/u.test(v)), '末尾の読点つきの候補が残っている').toBe(false);
  expect(values2, '対照群:別のタグ「請求済」が消えた').toContain('請求済');

  /**
   * 🔴 #1852 束 B1: 題名の絞り込みは全角半角・半角カナを揃えて比べる(ひらがなとカタカナは別のまま)。
   * ⚠ 題名の字そのものは変わらない(行の題名は打った原文のまま)。
   */
  await makeNote(page, 'ｶﾞｲﾄﾞ', '本文\n');
  const filterBox = page.locator('[data-pkc-field="entry-filter"]');
  const sideTitles = page.locator('[data-pkc-region="sidebar"] [data-pkc-entry] [data-pkc-field="title"]');
  await expect(filterBox, '台の前提:探す欄が画面に無い').toBeVisible();
  await filterBox.fill('abc');
  await expect(sideTitles, '「abc」で全角の「ＡＢＣ会議」が出ない').toHaveText(['ＡＢＣ会議'], { timeout: 5000 });
  await filterBox.fill('ガイド');
  await expect(sideTitles, '「ガイド」で半角カナの「ｶﾞｲﾄﾞ」が出ない').toHaveText(['ｶﾞｲﾄﾞ'], { timeout: 5000 });
  await filterBox.fill('がいど');
  await expect(sideTitles, 'ひらがなでカタカナの題名が出ている(区別が消えた)').toHaveCount(0, { timeout: 5000 });
  await filterBox.fill('');

  expect(errors, 'pageerror が出た').toEqual([]);
});
