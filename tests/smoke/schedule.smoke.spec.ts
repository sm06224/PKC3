import { test, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';
import { peek, withStateOnFail } from './state-dump';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **予定の面 ── 本物の drag で本文が書き替わる**(#292 段③)。
 *
 * > user 指示 2026-08-23:「**なんで双方向にする発想がでねぇんだよ!**」
 *
 * 🔴 unit(`tests/adapter/schedule-view.test.ts`)は繋がりを見ている。
 * **ここが見るのは「実際に掴めるか」**である ── unit の drag は event を手で
 * 撃つので、`draggable` が false でも通る(ブラウザの門を通らない)。
 * ⚠ つまり「掴めない札」は**実機でしか捕まらない**(CLAUDE.md §2)。
 *
 * 🔑 そして**本文が 1 度も消えない**ことも、ここでしか見られない ──
 * これが user 指示①(「もう一つ PKC が開いて混乱する」)への答えである。
 */
/**
 * 🔴 **固定の日を書かない**(2026-09-02、月をまたいだ初日に CI が赤くなった ── main も同じ)。
 *
 * ⚠ 2026-08 の日付を直書きしていたので、9 月に入った瞬間に**小さな月の升目**
 *   (`[data-pkc-drop-date]` は表示中の月にしか無い)が見つからず、3 件が落ちた。
 *   この file の下の方(繰り返しの test)には既に「固定の日を書くと理由の分からない
 *   赤になる」と書いてあった ── 同じ file の中で守られていなかった。
 * 🔑 **今月の中の日**で組む。基点は 22 日まで ── `BASE + 6 ≤ 28` なので、
 *   どの月(2 月も)でも升目が在り、月末に走っても月をまたがない。
 *   過ぎた日でも札は出る(`agenda.ts` は単発の予定を `overdue` として残す)。
 */
const AT = new Date();
const BASE_DAY = Math.min(AT.getDate(), 22);
/** 今月の `day` 日の鍵(`YYYY-MM-DD`)。 */
function inMonth(day: number): string {
  const d = new Date(AT.getFullYear(), AT.getMonth(), day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 札の「いつまでか」の字(`MM/DD`)。 */
function mmdd(key: string): string {
  return key.slice(5).replace('-', '/');
}
const D0 = inMonth(BASE_DAY); // 8/25 に当たる日
const D2 = inMonth(BASE_DAY + 2); // 8/27
const D3 = inMonth(BASE_DAY + 3); // 8/28
const D5 = inMonth(BASE_DAY + 5); // 8/30
const D6 = inMonth(BASE_DAY + 6); // 8/31

/**
 * 🔴 **指で掴んで動かす**(#855 決1。本物の touch)。
 *
 * ⚠ `page.touchscreen` は `tap` しか持たないので、CDP の `Input.dispatchTouchEvent`
 *   を使う(`phone.smoke.spec.ts` の長押し test と同じ道具)。
 * 🔑 `schedule-drag.ts` は**長押しで確定する**(スクロールと区別するため)ので、
 *   `touchStart` の後は**確定に要る時間より確実に長く**待ってから動かす。
 */
async function touchDragCard(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 0 }],
  });
  await page.waitForTimeout(600); // ⚠ `LONG_PRESS_MS`(500ms)を確実に越える
  // ⚠ **途中を経由する** ── 1 回の move では拾わないブラウザが在る(mouse の③と同じ配慮)
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 0 },
      ],
    });
    await page.waitForTimeout(30);
  }
}

/**
 * 🔴 **マウスの本物の drag**(#855 決4)。`page.mouse` で掴んで離すところまで ──
 * `data-pkc-dropping` の点検は呼び側でやる(場面ごとに見たい所が違うため)。
 */
async function mouseDragTo(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // ⚠ **途中を経由する** ── 1 回の move では `dragover` が出ないブラウザが在る
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
}

test('🔴 予定のタブで札を掴んで日へ落とすと、本文の日付が変わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill(`- [ ] 見積を送る @${D0}\n- [ ] 体裁のチェック`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 予定のタブへ(⚠ アプリの一覧ではない ── 左の列のタブである)
  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  await expect(pane, '予定の面が出ていない').toBeVisible();

  /**
   * 🔴 **本文は消えていない。** ①の実害はここだった ── 予定を見るために
   * 真ん中を明け渡す必要は無い。
   */
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '予定を開いたら本文が消えた(①の実害そのもの)',
  ).toBeVisible();

  // ② 日付を書いた行だけが札になっている
  const card = pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]');
  /**
   * 🔴 **落ちた回が理由を持ってくる形にする**(#410)。
   *
   * ⚠ フル走行で **1 回だけ**「札が 5 秒で 1 枚も出なかった」で落ちている ──
   *   そのとき `toHaveCount` が言うのは「**0 だった**」だけで、
   *   **本文が着いていないのか / 束が別の日に出ているのか / 面が違うのか**が
   *   1 つも残らない。⚠ **待ちは伸ばさない**(緩めずに、残る情報だけ増やす)。
   */
  await withStateOnFail(
    page,
    '札の枚数が違う(日付の無い行まで出ている / 1 枚も出ていない)',
    async () => ({
      cards: await peek(pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]')),
      groups: await peek(pane.locator('[data-pkc-region="schedule-cards"]')),
      pane: await peek(pane),
    }),
    async () => {
      await expect(card).toHaveCount(1);
    },
  );
  await expect(card, '記法が札の字に残っている').toContainText('見積を送る');

  // ③ 🔴 **本物の drag** ── D0 の札を掴んで 3 日後(D3)の升目へ落とす
  const target = pane.locator(`[data-pkc-drop-date="${D3}"]`);
  await expect(target, '落とし先の升目が無い').toBeVisible();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from, '札の位置が取れない').not.toBeNull();
  expect(to, '升目の位置が取れない').not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  // ⚠ **途中を経由する** ── 1 回の move では `dragover` が出ないブラウザが在る
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  /**
   * 🔴 **落とせる所は、落とす前に分かる**(掴んで通ったときだけ光る)。
   * ⚠ ここを見ないと「落とせたが、user には落とせるか分からなかった」が通る。
   */
  await expect(target, '落とし先が光っていない').toHaveAttribute('data-pkc-dropping', '');
  await page.mouse.up();

  // ④ 🔴 **本文が書き替わった**(画面だけ動いて本文は元のまま、を作らない)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '本文の日付が書き替わっていない').toHaveValue(
    `- [ ] 見積を送る @${D3}\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  // ⑤ 札も新しい日の束に居る(本文だけ直って画面が古い、を作らない)
  const d3Card = pane.locator(
    `[data-pkc-region="schedule-group"][data-pkc-drop-date="${D3}"] [data-pkc-entry]`,
  );
  await expect(d3Card, '札が新しい日へ移っていない').toHaveCount(1);

  /**
   * 🔴 ⑤.5 **指でも掴んで動かせる**(#855 決1)。
   *
   * > 実測(私が測った。信じてよい): マウスは掴んで通ると `data-pkc-dropping` が
   * > 光り、本文が書き替わる。**指(CDP の本物の touch)は 1 度も光らず、
   * > 本文も変わらなかった**(原因は `task-card.ts` の `card.draggable = true`
   * > ── HTML5 の drag は大半の携帯ブラウザで指の押下から始まらない)。
   * > 観測点はこの 2 つ(光る印 / 保存された本文)そのもの。
   *
   * 🔑 起動を増やさない ── この test の道中に足す(D3 の札を D6 へ、指で)。
   * ⚠ **グリッドの升目を明示的に選ぶ**(`[data-pkc-field="schedule-week"]` の
   *   直下)── `[data-pkc-drop-date]` だけだと、束の見出しが在る日は**升目と
   *   見出しの 2 件に当たって** strict mode で落ちる(升目の無い日は無関係)。
   */
  const cdp = await page.context().newCDPSession(page);
  const gridCell = (date: string) =>
    pane.locator(`[data-pkc-field="schedule-week"] > button[data-pkc-drop-date="${date}"]`);
  const centerOf = async (loc: ReturnType<typeof gridCell>): Promise<{ x: number; y: number }> => {
    const b = (await loc.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const d3Box = (await d3Card.boundingBox())!;
  await touchDragCard(
    page,
    cdp,
    { x: d3Box.x + d3Box.width / 2, y: d3Box.y + d3Box.height / 2 },
    await centerOf(gridCell(D6)),
  );
  await expect(gridCell(D6), '指で押さえ続けても落とし先が光らない').toHaveAttribute(
    'data-pkc-dropping',
    '',
  );
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '指で掴んでも本文の日付が変わらない').toHaveValue(
    `- [ ] 見積を送る @${D6}\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  // ⑤.6 指でもう一度 D3 へ戻す(⑥⑦ は D3 の札を前提にしているので元へ戻す)
  const d6Card = pane.locator(
    `[data-pkc-region="schedule-group"][data-pkc-drop-date="${D6}"] [data-pkc-entry]`,
  );
  await expect(d6Card, '指で D6 へ移った札が見当たらない').toHaveCount(1);
  const d6Box = (await d6Card.boundingBox())!;
  await touchDragCard(
    page,
    cdp,
    { x: d6Box.x + d6Box.width / 2, y: d6Box.y + d6Box.height / 2 },
    await centerOf(gridCell(D3)),
  );
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '指で D3 へ戻しても本文が変わらない').toHaveValue(
    `- [ ] 見積を送る @${D3}\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  await expect(d3Card, '指で戻した後、D3 の札が 1 枚でない').toHaveCount(1);

  /**
   * 🔴 ⑤.7 **指で縦になぞっても、掴みが始まらない**(#855 決1。
   * 「指で予定表をスクロールできなくなったら、直すより悪い」という要件そのもの)。
   *
   * ⚠ 観測点は「掴みが始まらないこと」── `data-pkc-dropping` が 1 件も立たず、
   *   本文も変わらない。実機の縦スクロールそのもの(headless では信頼できる
   *   観測点にならない)は測っていない ── 下の報告に正直に書く。
   */
  const swipeBox = (await d3Card.boundingBox())!;
  const sx = swipeBox.x + swipeBox.width / 2;
  const sy = swipeBox.y + swipeBox.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
  // ⚠ 確定(500ms)より前に、大きく縦へなぞる ── これはスクロールのつもりである
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: sx, y: sy - 120 }],
  });
  await page.waitForTimeout(50);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: sx, y: sy - 220 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(
    page.locator('[data-pkc-dropping]'),
    '縦になぞっただけなのに、どこかを掴んでしまった',
  ).toHaveCount(0);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '縦になぞっただけなのに本文が変わった').toHaveValue(
    `- [ ] 見積を送る @${D3}\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  /**
   * ⑥ 🔴 **繰り返していない札を右クリック →「繰り返す…」→ 刻みを選ぶと、
   *   札の字に出て、本文にも書かれる**(#855 段 0 の 3 つ目。着地前の動線
   *   レビュー、2026-09-13)。
   *
   * ⚠ 下の「毎週の予定」test は**最初から `毎週` を書いた本文**で組んでいる ──
   *   「繰り返していない札」から入る動線はここでしか見られない。
   * 🔑 起動を増やさない ── 既に開いている予定の面・既に在る札の道中に足す。
   * ⚠ **この段より前に足さない** ── 先に繰り返しにすると、上の③の「掴んで
   *   動かす drag」が繰り返しの札を相手にすることになり、掴めるかどうかが
   *   変わってしまう(繰り替えの回は掴むと断られる ── `task-card.ts` の docstring)。
   * ⚠ 右クリックは**字の上**を狙う ── 札の中には `input[type=checkbox]` が
   *   在り、そこで右クリックすると `binder.ts` の `onContextMenu` が
   *   `input` を見て**素通り**する(この面のメニューが出ない)。
   * ⚠ **`card`(全束を跨ぐ選手)ではなく、D3 の束に絞った `d3Card` を使う** ──
   *   「毎週」にした瞬間、agenda はこの窓(今日から数か月)に**何回も**展開する
   *   ので、絞らない選手は要素数が 1 → 9 に増えて strict mode で落ちる
   *   (実測。CLAUDE.md §2「fixture のゼロ件の次元」の逆 ── 増える次元を
   *   1 つに絞らないと壊れる)。
   */
  const cardText = d3Card.locator('[data-pkc-field="text"]');
  await cardText.click({ button: 'right' });
  const repeatMenu = page.locator('[data-pkc-region="context-menu"]');
  await expect(repeatMenu, '札を右クリックしてもメニューが出ない').toBeVisible();
  await expect(repeatMenu, '「予定を繰り返す…」が出ていない').toContainText('予定を繰り返す…');
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="open-repeat-menu"]');
  await expect(repeatMenu, '刻みの一覧に「毎週」が出ていない').toContainText('毎週');
  await clickReal(
    page,
    '[data-pkc-region="context-menu"] [data-pkc-action="set-task-repeat"][data-pkc-repeat="week"]',
  );
  await expect(repeatMenu, '刻みを選んでもメニューが閉じない').toHaveCount(0);
  await expect(d3Card, '刻みを選んでも札に「毎週」が出ない').toContainText('毎週');
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '繰り返しの刻みが本文に書かれていない').toHaveValue(
    `- [ ] 見積を送る @${D3} 毎週\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  /**
   * ⑦ 🔴 **もう一度「予定を繰り返す…」を開くと「この繰り返しをやめる」が出て、押すと消える**
   *   (片道の操作を作らない ── CLAUDE.md 2026-08-23)。
   */
  await expect(d3Card, '毎週にした直後、D3 の束の札が 1 枚でなくなった').toHaveCount(1);
  await cardText.click({ button: 'right' });
  await expect(repeatMenu, '2 度目の右クリックでメニューが出ない').toBeVisible();
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="open-repeat-menu"]');
  await expect(repeatMenu, '繰り返している行に「この繰り返しをやめる」が出ていない').toContainText('この繰り返しをやめる');
  await clickReal(
    page,
    '[data-pkc-region="context-menu"] [data-pkc-action="set-task-repeat"][data-pkc-repeat=""]',
  );
  await expect(repeatMenu, '「この繰り返しをやめる」を押してもメニューが閉じない').toHaveCount(0);
  await expect(d3Card, '「この繰り返しをやめる」を押しても札から「毎週」が消えない').not.toContainText('毎週');
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '「この繰り返しをやめる」を押しても本文の「毎週」が消えない').toHaveValue(
    `- [ ] 見積を送る @${D3}\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  /**
   * ⑧ 🔴 **繰り返しの札を掴んで動かすと、聞かれる**(#855 決4)。
   *
   * ⚠ **起動を増やさない** ── ⑥⑦ で付けて外した「毎週」を、ここでもう一度
   *   付け直して使う(`d3Card` / `cardText` / `repeatMenu` は既に在る道中)。
   */
  await cardText.click({ button: 'right' });
  await expect(repeatMenu, '付け直しの右クリックでメニューが出ない').toBeVisible();
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="open-repeat-menu"]');
  await clickReal(
    page,
    '[data-pkc-region="context-menu"] [data-pkc-action="set-task-repeat"][data-pkc-repeat="week"]',
  );
  await expect(repeatMenu, '刻みを選んでもメニューが閉じない').toHaveCount(0);
  await expect(d3Card, '付け直しても札に「毎週」が出ない').toContainText('毎週');

  const dlg = page.locator('[data-pkc-region="app-dialog"][open]');
  const dlgTitle = page.locator('[data-pkc-field="dialog-title"]');
  const moveRows = page.locator('[data-pkc-field="pick-repeat-move"]');

  /**
   * ⑨ 🔴 **「やめる」を押すと、本文は 1 バイトも変わらない(対照群①)**。
   *   ⚠ **落とし先は `gridCell`(升目そのもの)** ── 束の見出しの有無に関わらず
   *   1 件に定まる(既存の道具に揃えて衝突の心配そのものを消す)。
   */
  await mouseDragTo(page, d3Card, gridCell(D5));
  await page.mouse.up();
  await expect(dlg, '繰り返しの札を落としても小窓が出ない').toBeVisible();
  await expect(dlgTitle, '小窓の題名が違う').toHaveText('繰り返しの予定を動かします');
  await expect(moveRows, '選択肢が 2 つでない').toHaveCount(2);
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  await expect(dlg, '「やめる」を押しても小窓が閉じない').toHaveCount(0);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '「やめる」を押したのに本文が変わった').toHaveValue(
    `- [ ] 見積を送る @${D3} 毎週\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  await expect(
    pane.locator(`[data-pkc-region="schedule-group"][data-pkc-drop-date="${D5}"] [data-pkc-entry]`),
    '「やめる」を押したのに D5 へ札が来た',
  ).toHaveCount(0);

  /**
   * ⑩ 🔴 **「全部動かす」を押すと、規則の行の日付そのものが動く(対照群②)**。
   */
  await mouseDragTo(page, d3Card, gridCell(D5));
  await page.mouse.up();
  await expect(dlg, '2 度目の小窓が出ない').toBeVisible();
  await clickReal(page, '[data-pkc-field="pick-repeat-move"][data-pkc-repeat-move-index="1"]');
  await expect(dlg, '「全部動かす」を選んでも小窓が閉じない').toHaveCount(0);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '「全部動かす」を選んでも規則の日付が動かない').toHaveValue(
    `- [ ] 見積を送る @${D5} 毎週\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  const d5Card = pane.locator(
    `[data-pkc-region="schedule-group"][data-pkc-drop-date="${D5}"] [data-pkc-entry]`,
  );
  await expect(d5Card, '「全部動かす」のあと D5 に札が来ない').toHaveCount(1);
  await expect(
    pane.locator(`[data-pkc-region="schedule-group"][data-pkc-drop-date="${D3}"] [data-pkc-entry]`),
    '「全部動かす」のあとも D3 に札が残っている',
  ).toHaveCount(0);

  /**
   * ⑪ 🔴 **「この回だけ動かす」を押すと、本文に振替の行が 1 本増える**
   *   (依頼の本命。#855 決4)。
   */
  await mouseDragTo(page, d5Card, gridCell(D6));
  await page.mouse.up();
  await expect(dlg, '3 度目の小窓が出ない').toBeVisible();
  await clickReal(page, '[data-pkc-field="pick-repeat-move"][data-pkc-repeat-move-index="0"]');
  await expect(dlg, '「この回だけ動かす」を選んでも小窓が閉じない').toHaveCount(0);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '「この回だけ動かす」を選んでも振替の行が増えない').toHaveValue(
    `- [ ] 見積を送る @${D5} 毎週\n- [ ] 見積を送る @${D6} 振替${D5}\n- [ ] 体裁のチェック`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  /**
   * 🔴 **振替は「元の日」も塞ぐ**(`repeat.ts` の docstring どおり)── 塞がないと
   *   D5 と D6 の**両方**に同じ回の札が出て二重になる。ここで D5 が 0 件のまま
   *   なら、本文の `@${D5} 毎週` が消えていないことと合わせて
   *   「規則そのものは動いていない(D6 だけの例外)」が言える。
   */
  await expect(
    pane.locator(`[data-pkc-region="schedule-group"][data-pkc-drop-date="${D5}"] [data-pkc-entry]`),
    '「この回だけ動かす」のあと元の日にも札が残って二重になった',
  ).toHaveCount(0);
  await expect(
    pane.locator(`[data-pkc-region="schedule-group"][data-pkc-drop-date="${D6}"] [data-pkc-entry]`),
    '「この回だけ動かす」のあと落とした日に札が出ない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **点が付いても、升目の高さが動かない**(#303 から持ち越した唯一の主張)。
 *
 * ## なぜ持ち越すのか
 *
 * cowork 実機レポート #15「**同じ座標を 2 回押すと別の日に当たる**」── 旧カレンダーは
 * 予定を `td` の直下に積んでいたので、1 件入るごとにその週の内在高が増え、
 * **下の行が押し下がって**いた(実測で週の上端が最大 53px ずれた)。
 * ⚠ 小さな月では**升目が落とし先そのもの**なので、ずれると
 * **別の日へ落ちる = データが黙って動く**。#303 より悪い。
 *
 * ## ⚠ ここは「規則が在るか」ではなく「実寸が同じか」を見る
 *
 * 1 稿目は CSS を構文で読み、点の `::after` が `position: absolute` であることを
 * pin した。⚠ **測ったら、その規則は no-op だった** ── 点は 3px で、升目の
 * 行ボックス(11px × line-height 1.4)より小さいので、流れの中に置いても
 * 高さを押し広げない(実測: 絶対配置でも静的でも **26px / 26px**)。
 * 🔑 だから守るべきは規則の綴りではなく**高さが揃っていること**である
 * (CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
 * ⚠ この形なら、将来「件数の数字を出す」ような**本当に押し広げる変更**を捕まえる
 *   ── 旧カレンダーが実際にそれで壊れた。
 */
test('🔴 予定のある日とない日で、小さな月の升目の高さが同じ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(
      [`- [ ] 予定 A @${D0}`, `- [ ] 予定 B @${D0} 09:00`, `- [ ] 予定 C @${D0} 14:00`].join(
        '\n',
      ),
    );
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-browse="schedule"]');

  // ⚠ **前提** ── 点が付いた日が実在する(付いていなければ何も検めていない)
  const dotted = page.locator(`[data-pkc-drop-date="${D0}"][data-pkc-has]`);
  await expect(dotted, '予定のある日に点が付いていない(前提が崩れている)').toBeVisible({
    timeout: 20_000,
  });

  const heights = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-pkc-field="schedule-week"] > button')];
    const has = cells.filter((c) => c.hasAttribute('data-pkc-has'));
    const bare = cells.filter((c) => !c.hasAttribute('data-pkc-has'));
    const h = (el: Element): number => +el.getBoundingClientRect().height.toFixed(2);
    return { has: has.map(h), bare: bare.map(h) };
  });
  // ⚠ **空振り防止** ── 両側に升目が在ること(片側が 0 件だと下の比較は空回り)
  expect(heights.has.length, '点の付いた升目が 0 件').toBeGreaterThan(0);
  expect(heights.bare.length, '点の無い升目が 0 件').toBeGreaterThan(0);
  // 🔑 **全部が同じ高さ**(点の有無で分かれていないこと)
  const all = [...heights.has, ...heights.bare];
  expect(
    new Set(all).size,
    `升目の高さが揃っていない(落とし先がずれる): ${JSON.stringify(heights)}`,
  ).toBe(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **期間の札を、本物の drag でずらす**(#344 段①)。
 *
 * 🔴 unit(`tests/adapter/schedule-view.test.ts`)は「何枚出るか」「本文がどう変わるか」を
 * 見ている。**ここが見るのは実機でしか捕まらない 2 つ**である ──
 * ① 期間の札が**掴める**か(`draggable` の門は unit の合成 event を素通りする)
 * ② **どの日の札を掴んだか**が荷物に載るか(荷物は実際の `dragstart` でしか作られない)
 *
 * ⚠ 観測点は**保存された本文** ── 札が動いただけでは意味が無い。
 */
test('🔴 期間の札を掴んでずらすと、長さを保ったまま本文が書き替わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill(`- [ ] 大阪出張 @${D0}..${D3}`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  await expect(pane, '予定の面が出ていない').toBeVisible();

  /**
   * ① 4 日ぶんの札に展開されている(1 枚を日から日へ動かしていない)。
   *
   * ⚠ **フル走行で 1 回だけ「0 枚」で落ちている**(#410、2026-08-25)。
   *   そのとき残ったのは `Received: 0` だけで、**走査が届いていないのか /
   *   届いたが 0 件なのか**が 1 つも分からなかった。
   * 🔑 **状態の 1 行(`schedule-note`)を添える** ── 面はこの 4 つを
   *   書き分けているので(「集めています…」/「集められませんでした」/
   *   「まだありません」/「絞り込みに当てはまりません」)、
   *   **その字が落ちた回の答えになる**。
   * ⚠ **待ちは伸ばさない**(緩めずに、残る情報だけ増やす)。
   */
  await withStateOnFail(
    page,
    '期間が日数ぶんの札になっていない',
    async () => ({
      // 🔑 これが「集めています…」なら走査が遅れた、空なら届いて 0 件だった
      note: await peek(pane.locator('[data-pkc-field="schedule-note"]'), 1),
      cards: await peek(pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]')),
      groups: await peek(pane.locator('[data-pkc-region="schedule-group"]')),
      pageErrors: errors,
    }),
    async () => {
      await expect(
        pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]'),
      ).toHaveCount(4);
    },
  );
  // ⚠ 札は「いつまでか」を出す(束の見出しには終わりが出ないため)
  await expect(
    pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-task-range]').first(),
  ).toContainText(`〜${mmdd(D3)}`);

  // ② 🔴 3 日目(D2)の札を掴んで、D5 の升目へ落とす = +3 日
  const grabbed = pane.locator(
    `[data-pkc-region="schedule-group"][data-pkc-drop-date="${D2}"] [data-pkc-entry]`,
  );
  await expect(grabbed, '3 日目の札が無い').toHaveCount(1);
  const target = pane.locator(`[data-pkc-drop-date="${D5}"]`);
  const from = await grabbed.boundingBox();
  const to = await target.boundingBox();
  expect(from, '札の位置が取れない').not.toBeNull();
  expect(to, '升目の位置が取れない').not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  await expect(target, '落とし先が光っていない').toHaveAttribute('data-pkc-dropping', '');
  await page.mouse.up();

  // ③ 🔴 **長さは 4 日のまま**、掴んだ日が落とした日に来ている
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '期間が長さを保ったままずれていない').toHaveValue(
    `- [ ] 大阪出張 @${D3}..${D6}`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **繰り返し ── 1 行の記法が先の日にも札を出し、押すと本文が増える**(#344 段②)。
 *
 * 🔴 unit(`tests/adapter/schedule-view.test.ts`)は同じ繋がりを happy-dom で見ている。
 * **ここが見るのは実ブラウザの印**である ── `toggle-task` は `input[type=checkbox]` で、
 * ブラウザは押した瞬間に**自前で印を反転する**。⚠ その既定の動きと、こちらの
 * 「本文へ行を増やす」が噛み合わないと、**画面だけ済んで本文が変わらない**形になる
 * (合成 click では踏めない)。
 *
 * ⚠ 日付は**今日から数える** ── 固定の日を書くと、窓(今日から 2 か月)の外へ出た
 *   日に**理由の分からない赤**になる。
 */
test('🔴 毎週の予定が先の日にも出て、押すとその日ぶんの行が本文に増える', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const at = new Date();
  const key = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = key(at);
  const next = key(new Date(at.getFullYear(), at.getMonth(), at.getDate() + 7));

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill(`- [ ] ゴミ出し @${today} 毎週`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  const cardsOn = (date: string) =>
    pane.locator(
      `[data-pkc-region="schedule-group"][data-pkc-drop-date="${date}"] [data-pkc-region="schedule-cards"] > [data-pkc-entry]`,
    );

  // ① 1 行なのに、今日と 7 日後の**両方**に出る
  await expect(cardsOn(today), '今日の札が無い').toHaveCount(1);
  await expect(cardsOn(next), '7 日後の札が無い(繰り返しが展開されていない)').toHaveCount(1);
  await expect(cardsOn(next), '札に刻みが出ていない').toContainText('毎週');

  // ② 7 日後のぶんを済ませる
  const box = cardsOn(next).locator('[data-pkc-action="toggle-task"]');
  await box.click();

  // ③ 🔴 **本文にその日ぶんの行が増えた**(規則の行はそのまま)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '本文が増えていない(画面だけ済んだ形)').toHaveValue(
    `- [ ] ゴミ出し @${today} 毎週\n- [x] ゴミ出し @${next}`,
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  // ④ その日の札は畳まれ(済んだ扱い)、次の回は残っている
  await expect(cardsOn(next), '済ませた回が残っている').toHaveCount(0);
  await expect(cardsOn(today), '他の回まで消えた').toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
/**
 * 🔴 **予定から外す押し口**(#498)。
 *
 * > user 指摘 2026-08-27:「**予定表に出てくる消せない予定がキモい。普通に考えて
 * > 動線が直感的ではない。誰も使わないと思う**」
 *
 * 🔴 **unit では原理的に届かない層** ── 「マウスを乗せるまで見えない」も
 *   「隠れていても場所は空いている」も、happy-dom は採寸しないので測れない。
 */
test('🔴 札にマウスを乗せると × が出て、押すと予定から外れる (#498)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('- [ ] 見積を送る @2026-08-25\n- [ ] 消えない行\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  const card = pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]');
  await expect(card, '札が出ていない(前提が崩れている)').toHaveCount(1);

  const btn = card.locator('[data-pkc-field="task-unschedule"]');
  await expect(btn, '外す押し口が札に無い').toHaveCount(1);

  /**
   * 🔴 **乗せる前から見えている(薄く)/ 乗せると濃くなる**。
   * ⚠ **完全に隠さない**のが要点である ── #498 の訴えは「消せない」= **見つけ
   *   られない**なので、`opacity: 0` にすると**直したことにならない**。
   * ⚠ `toBeVisible()` では見分けられない(`opacity: 0` も「見えている」と判定される)
   *   ので、**計算値**で見る。
   */
  const alpha = async (): Promise<number> =>
    Number(await btn.evaluate((el) => getComputedStyle(el).opacity));
  const boxBefore = await card.boundingBox();
  const before = await alpha();
  expect(before, '乗せる前に × が完全に消えている(見つけられない)').toBeGreaterThan(0);
  expect(before, '乗せる前から濃い(対照群が無い)').toBeLessThan(1);
  await card.hover();
  await expect.poll(alpha, { message: '乗せても濃くならない', timeout: 3_000 }).toBe(1);

  /**
   * ⚠ **場所は空けたまま隠している**ことを実寸で見る(`display: none` にしない)。
   * 🔑 消すと、乗せた瞬間に**字が動く**(押そうとした物が逃げる)。
   */
  const boxAfter = await card.boundingBox();
  expect(boxAfter?.height, '乗せたら札の高さが変わった(字が動く)').toBe(boxBefore?.height);

  await btn.click();

  // ① 札がこの日の束から消える
  await expect(card, '押しても札が残っている').toHaveCount(0);

  // ② 🔴 **本文からも外れている**(画面だけ動いて本文は元のまま、を作らない)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '本文から日付が外れていない').toHaveValue(
    '- [ ] 見積を送る\n- [ ] 消えない行\n',
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **カレンダーを見ながら「足す」と、見ているところに出る**(#499)。
 *
 * > user 指摘 2026-08-27:「**カレンダー表示してるのに、「足す」のところにも
 * > カレンダーインプットがあったりで意味不明**」
 *
 * ⚠ 直す前は日付の欄が**空**で、そのまま押すと**日付なし**で足していた ──
 *   つまり**いま見ているカレンダーには 1 つも出てこない**。
 * 🔑 ここでしか見られないのは「**実際に今日の束へ出るか**」である
 *   (unit は欄の値と本文までを見る)。
 */
test('🔴 予定の面で「足す」を押すと、今日の束に出る (#499)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  await expect(pane, '予定の面が出ていない').toBeVisible();

  const date = pane.locator('[data-pkc-field="schedule-quick-date"]');
  const value = await date.inputValue();
  // ⚠ 空振り防止 ── 空なら以下は「日付なしで足した」を見ているだけになる
  expect(value, '日付の欄が空のまま(押しても見ている所に出ない)').toMatch(
    /^\d{4}-\d{2}-\d{2}$/,
  );

  await pane.locator('[data-pkc-field="schedule-quick-text"]').fill('きょうの用事');
  await clickReal(page, '[data-pkc-action="schedule-quick-add"]');

  /**
   * 🔴 **その日の束に出る**こと ── 「日付なし」ではない。
   * 🔑 束は `data-pkc-drop-date` に日を持つので、**欄の値と同じ束**を名指しできる。
   */
  await expect(
    pane.locator(
      `[data-pkc-region="schedule-group"][data-pkc-drop-date="${value}"] [data-pkc-entry]`,
    ),
    '足したのに、その日の束へ出ていない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **ずっと前から「毎日」と書いた行が、今日の予定に出る**(#855 段 0 の欠陥①)。
 *
 * ## 何が壊れていたか
 *
 * 展開は開始日から 1 回ずつ数え上げる形で、上限(`max * 8` = 1600)に当たると
 * **1 件も出さずに止まっていた**。⚠ `truncated` も立たないので、画面は
 * 「その日は何も無い」と**静かに**言う ── 4 年前から書いてある人には、
 * **毎日の予定が丸ごと消えている**ように見える。
 *
 * ## ⚠ なぜ既に在る道中に載せられないのか(`scripts/smoke-budget.mjs`)
 *
 * この面の既存の道中(上の「毎週」の test)は **1 本の規則しか置いていない**前提で
 * 数を数えている(`toHaveCount(1)` / `toHaveCount(0)`)。⚠ `毎日` を同じ本文へ足すと
 * **窓の全部の日に札が増える**ので、あちらの数の assert が 4 か所とも意味を変える
 * ── 別の主張を同じ test に混ぜることになる(1 test = 1 主張)。
 * 🔑 だから起動を 1 つ使う(488 → 489。予算 500 の内側なので上限は動かさない)。
 *
 * 🔴 **unit では届かない層**:`tests/features/repeat.test.ts` は展開の関数を直に
 * 呼ぶが、⚠ そこから**画面の升目に札が出る**までには `agenda.ts` の窓の切り方と
 * 描画が挟まる ── 「関数は返しているのに画面には出ない」を見るのはここだけである。
 */
test('🔴 4 年前から「毎日」と書いた行が、今日の予定に出る (#855)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const key = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const today = key(now);
  const tomorrow = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  /** ⚠ 4 年前の**同じ日**(2/29 を踏まないよう 1 日ずらす ── 日付の妥当性は別の test の主張)。 */
  const longAgo = key(new Date(now.getFullYear() - 4, now.getMonth(), Math.min(now.getDate(), 28)));

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill(`- [ ] 体操 @${longAgo} 毎日`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  const cardsOn = (date: string) =>
    pane.locator(
      `[data-pkc-region="schedule-group"][data-pkc-drop-date="${date}"] [data-pkc-region="schedule-cards"] > [data-pkc-entry]`,
    );

  // 🔴 直す前はここが **0** だった(開始日から数え上げて上限に当たり、1 件も出ない)
  await expect(cardsOn(today), '今日の札が無い(古い開始の毎日が展開されていない)').toHaveCount(1);
  await expect(cardsOn(today), '札に刻みが出ていない').toContainText('毎日');
  /**
   * 🔑 **明日も出る**(対照群)── 「たまたま今日 1 枚だけ出た」と区別する。
   * ⚠ これが無いと、窓の起点だけ特別扱いする実装でも緑になる。
   */
  await expect(cardsOn(tomorrow), '明日の札が無い(1 日ぶんしか展開していない)').toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
