import { test, expect, type Page } from '@playwright/test';
import { clickReal, createEntry, collectPageErrors, gotoApp } from './helpers';

/**
 * 🔴 **掴んだまま、別の面へ持っていく**(#402 ③)。
 *
 * > user の物語: フォルダタブで行を掴んだ。予定タブの日付へ落としたい。
 * > いまは**タブを押すのに一度手を離すしかない** ── 離すと掴んだ状態が消える。
 *
 * 🔴 **unit では原理的に届かない層**をここで見る:
 * ① **本物の HTML5 D&D が始まるか**(`DataTransfer` は happy-dom に無い)
 * ② 🔴 **面が切り替わった後も drag が生きているか** ── PKC3 の左の列は
 *    同じホストの中で `hidden` を入れ替える排他 pane なので、切り替えた瞬間に
 *    **掴んでいた元の要素が `hidden` になる**。ここが死んでいたら、機構ごと
 *    別の形(掴んだ物を state に載せる)が要る。
 * ③ **タブに面積が在るか**(止める的が無ければ狙えない)
 *
 * ⚠ unit(`drag-tab-switch.test.ts`)が見ているのは**時間の規律**だけである
 *   ── 合成 event と偽タイマーなので、①②③ はどれも 1 度も走らない。
 *
 * ## ⚠ 1 稿目は**製品の仕様と食い違う**ことを見ていた(記録として)
 *
 * 「フォルダの行を掴んで、予定の日へ落とす」を書いたが、予定の日の落とし先は
 * **予定の札(`application/x-pkc-task`)しか受けない**(`binder.ts` の
 * `onDragOver` の 1 本目の枝)。ノートの行は別の荷物なので、そこは
 * **もともと落ちない** ── 落ちないのは正しく、⚠ こちらの test が
 * 「在るはずのない動き」を測っていた。
 *
 * 🔑 だから見るのは **drag が生きていること**そのものにした:
 * 面を **2 回**切り替え(2 回目が起きるなら、1 回目のあとも `dragover` が
 * 届いている)、戻った先で**実際に落とす**。
 */
async function makeFolder(page: Page, title: string): Promise<void> {
  await createEntry(page, 'folder');
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

/** タブの上で**止める**(実機と同じく、止まっていても `dragover` は飛ぶ)。 */
async function hoverTab(page: Page, mode: string): Promise<void> {
  const box = await page.locator(`[data-pkc-browse="${mode}"]`).boundingBox();
  expect(box, `タブ(${mode})に面積が無い ── 止める的が無い`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 6 });
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(box!.x + box!.width / 2 + (i % 2), box!.y + box!.height / 2);
    await page.waitForTimeout(100);
  }
}

test('🔴 掴んだままタブの上で止めると面が変わり、drag は生きている (#402 ③)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-browse="filer"]');

  const note = page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry][data-pkc-archetype="text"]')
    .first();
  await expect(note, '掴む行が無い(前提が崩れた)').toBeVisible();
  const from = await note.boundingBox();

  // 🔑 Playwright が HTML5 の drag を回す(mouse.down → move)
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 20, from!.y + 20, { steps: 4 });

  // ① 🔴 予定タブの上で止める → 面が変わる
  await hoverTab(page, 'schedule');
  await expect(
    page.locator('[data-pkc-browse-pane="schedule"]'),
    '止めたのに面が変わらない',
  ).toBeVisible({ timeout: 5000 });
  /**
   * ⚠ **空振り防止** ── 元の面が本当に畳まれたことを見る。畳まれていなければ
   *   「掴んだまま面を変えた」を 1 度も試していないことになる(§1)。
   */
  await expect(
    page.locator('[data-pkc-browse-pane="filer"]'),
    '元の面が畳まれていない(前提が崩れた)',
  ).toBeHidden();

  /**
   * ② 🔴 **drag がまだ生きている** ── もう一度タブの上で止めて、面が戻る。
   * ⚠ これが起きるのは `dragover` が届いているときだけである
   *   (離してしまっていたら、ただのマウス移動なので何も起きない)。
   */
  await hoverTab(page, 'filer');
  await expect(
    page.locator('[data-pkc-browse-pane="filer"]'),
    '面を変えたあとで drag が死んでいる(2 度目の切替が起きない)',
  ).toBeVisible({ timeout: 5000 });

  // ③ 🔴 戻った先で**実際に落ちる**(掴んだ荷物が生きたまま運ばれている)
  const folder = page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry][data-pkc-archetype="folder"]')
    .first();
  const to = await folder.boundingBox();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '面をまたいで運んだ物が落ちていない',
  ).toContainText('「はこ」へ入れました', { timeout: 5000 });

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
