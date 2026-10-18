/**
 * 🔴 **メッセージ**(設計 doc §7、段②a)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は「system 領域のノートを開いたときに、普通のノートと同じ
 * 中央の面に出て、しかし編集・追記の口が出ない」を、実際の DOM ツリー越しに
 * 確かめられない(`renderBar` の system 判定 / `appendModeOf` の `entryMetas` 不在は
 * unit で見ているが、**左の一覧に絶対出ない**ことと**帯の見た目**は実ブラウザで見る)。
 *
 * 🔑 観測点は 1 起動にまとめる(CLAUDE.md「起動を 1 つ足すと以後すべての回に 1.6 秒」):
 *  ① 起動直後、左の一覧に「メッセージ」が無い(system 領域は user の一覧に混ざらない)
 *  ② システム → メッセージ の「開く」で、中央に題名「メッセージ」+ 起動の要約の節が出る
 *  ③ 本文の帯に「編集」が無い(system のノートは読むだけ)
 *  ④ ここまでの一連の操作で `location.hash` は 1 度も変わらない(ディープリンク専用)
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, dismissAnnounce, collectPageErrors } from './helpers';

test('🔴 メッセージ: 一覧に出ない / 開くと中央に出る / 編集は出ない / hash は不変', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  const hashAtBoot = await page.evaluate(() => location.hash);
  await dismissAnnounce(page);
  // 🔴 タブの題名(台帳 #1852 束 L2): 開発版の build は「PKC3(開発版)」、公開版・検証版は「PKC3」のまま
  //    ⚠ どちらの build で回しているかは spec から分からないので両方を受ける(記録に残す)。
  const tabTitle = await page.title();
  test.info().annotations.push({ type: 'tab-title', description: tabTitle });
  expect(tabTitle, 'タブの題名が「PKC3」「PKC3(開発版)」のどちらでもない').toMatch(/^PKC3(\(開発版\))?$/);

  // ① 🔴 左の一覧に「メッセージ」という行は無い(system 領域は user の一覧に混ざらない)
  const sidebarRows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  const sidebarTexts = await sidebarRows.allTextContents();
  expect(
    sidebarTexts.some((t) => t.includes('メッセージ')),
    '「メッセージ」が左の一覧(user のノート)に混ざった',
  ).toBe(false);

  // 「システム」を開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const pane = page.locator('[data-pkc-view-pane="settings"]');
  await expect(pane, 'システムの面が開かない').toBeVisible();

  // ② 🔴 メッセージの節の「開く」が出ている
  const openBtn = pane.locator('[data-pkc-action="open-messages"]').first();
  await expect(openBtn, '「メッセージ」を開くボタンが無い').toBeVisible();

  /**
   * 🔴 **ノートを選ばないまま、画面下の「未読のメッセージ N 件」を押して開く**(台帳 #1852 束 L1)。
   * 未読は、読めない Office 一式のファイルを入れて「問題」を 1 件起こして作る(起動直後は未読 0 件で、入口が出ていない)。
   * ⚠ 入口が出ない場合は assert で落とす(押せる場面を作れていない = 確かめていない)。
   */
  const unread = page.locator('[data-pkc-region="status"] [data-pkc-field="status-messages"]');
  await expect(unread, '前提が崩れている(起動直後から未読が出ている)').toBeHidden();
  const chooser = page.waitForEvent('filechooser');
  await clickReal(page, pane.locator('[data-pkc-field="office-pack-file"]'));
  await (await chooser).setFiles({
    name: 'broken-pack.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('not a pack'),
  });
  await expect(unread, '問題を起こしても「未読のメッセージ」の入口が出ない').toBeVisible({ timeout: 15_000 });
  await expect(unread).toContainText('未読のメッセージ');
  await clickReal(page, unread);

  // 中央に題名「メッセージ」が出る(detail 面)
  const detailPane = page.locator('[data-pkc-view-pane="detail"]');
  const title = detailPane.locator('[data-pkc-field="detail-title"]');
  await expect(title, 'メッセージのノートが中央に開かない').toHaveText('メッセージ');

  /**
   * 起動の要約の節が本文に出る(§7「起動しました:版…」)。
   * ⚠ **面全体を見る** ── 本文の器の `data-pkc-field` は読み込み中は
   *   `detail-body-host`、md 描画後は `detail-body` に切り替わる
   *   (`detail.ts` の `bodyHost` 再利用)。どちらの瞬間を掴むかに依らせない。
   */
  await expect(detailPane, '本文が読み込まれない').toContainText('起動しました', {
    timeout: 10_000,
  });

  // ③ 🔴 帯に「編集」が無い(system のノートは読むだけ)
  const editBtn = detailPane.locator('[data-pkc-action="start-edit"]');
  await expect(editBtn, '「編集」が system のノートにも出てしまった').toHaveCount(0);

  /**
   * ③b 🔴 **本文の上の帯**(台帳 #1852 束 L1。依頼 80-3 / 266)── 種類で絞るボタンと「メッセージを書き出す」。
   * ⚠ 「押されている」の印(`aria-pressed`)に**見た目の規則が在るか**を、実ブラウザの計算後の色で見る
   *   (属性だけ見ると、CSS に受け皿が無くても緑になる)。
   * 起動の要約は「結果」。「注意」に絞ると消え、「すべて」で戻る。
   */
  const bar = detailPane.locator('[data-pkc-field="detail-toolbar"]');
  const chips = bar.locator('[data-pkc-action="set-message-filter"]');
  await expect(chips, '種類のボタンが 5 つ(すべて / 問題 / 注意 / 結果 / 配信)出ていない').toHaveText([
    'すべて',
    '問題',
    '注意',
    '結果',
    '配信',
  ]);
  await expect(bar.locator('[data-pkc-action="export-messages"]'), '帯に「メッセージを書き出す」が無い').toHaveText(
    'メッセージを書き出す',
  );
  const chip = (label: string) => bar.locator('[data-pkc-action="set-message-filter"]', { hasText: new RegExp(`^${label}$`) });
  const bg = (label: string) => chip(label).evaluate((e) => getComputedStyle(e).backgroundColor);
  await expect(chip('すべて')).toHaveAttribute('aria-pressed', 'true');
  const pressedBg = await bg('すべて');
  const idleBg = await bg('注意');
  expect(pressedBg, '押されているボタンが、そうでないボタンと見分けられない(CSS に受け皿が無い)').not.toBe(idleBg);

  await clickReal(page, chip('注意'));
  await expect(chip('注意')).toHaveAttribute('aria-pressed', 'true');
  expect(await bg('注意'), '「注意」を押したのに見た目が変わらない').toBe(pressedBg);
  await expect(detailPane, '「注意」に絞ったのに、結果(起動の要約)が残っている').not.toContainText('起動しました');
  await clickReal(page, chip('すべて'));
  await expect(detailPane, '「すべて」に戻っても本文が戻らない').toContainText('起動しました');

  // ④ 🔴 一連の操作で hash は 1 度も変わっていない(ディープリンク専用)
  const hashAfter = await page.evaluate(() => location.hash);
  expect(hashAfter, `メッセージを開く操作で hash が動いた(${hashAtBoot} → ${hashAfter})`).toBe(
    hashAtBoot,
  );

  expect(errors, 'pageerror が出た').toEqual([]);
});
