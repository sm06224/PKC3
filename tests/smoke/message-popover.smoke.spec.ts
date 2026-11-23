/**
 * 🔴 **画面いちばん下の常設のステータスバーを廃止し、メッセージの入口 + 簡易履歴 + 消せる浮き札へ移した**(2026-11-23。
 * user 指示「最下段のステータスメッセージが表示されると非常に見にくい上に消すことも叶わないため邪魔。どの画面からもホバー/クリックで
 * 開ける簡易メッセージ履歴(ポップオーバー)と、詳細メッセージ画面(既存の system メッセージ集積地)で良いはず」)。
 *
 * happy-dom の unit(`message-popover.test.ts`)は DOM の契約を見るだけで、**実ブラウザでしか分からない層**がここにある:
 * ① 帯が grid の行を取らない・浮き札が出ても配置が 1px も動かない・文書が画面より高くならない(`scrollHeight`)
 * ② 本物のホバー(`mouse.move`)の遅延と離脱 / クリック / Esc / 外を押す / 焦点の戻り(`document.activeElement`)
 * ③ top layer のポップオーバーが画面内に収まる(PC とスマホ幅)
 * ④ 知らせの浮き札から「元に戻す」が押せる(片道にしない)/ × で閉じる / 結果は数秒で消える
 */
import { test, expect, type Page } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
  openMessagePopover,
  useSplitEditor,
} from './helpers';

const ENTRY = '[data-pkc-region="rail"] [data-pkc-field="message-entry"]';
const POP = '[data-pkc-region="message-popover"]';
const TOAST = '[data-pkc-region="status"]';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});
test.setTimeout(90_000);

async function notes(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await createEntry(page, 'text');
    await page.locator('[data-pkc-field="editor-title"]').fill(`ノート${String(i + 1)}`);
    await page.locator('[data-pkc-field="editor-body"]').fill(`本文${String(i + 1)}\n`);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
}

/** 読めない Office 一式を入れて「問題」を 1 件起こす(未読が 1 件増え、浮き札にエラーが出る)。 */
async function causeProblem(page: Page): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const chooser = page.waitForEvent('filechooser');
  await clickReal(page, '[data-pkc-view-pane="settings"] [data-pkc-field="office-pack-file"]');
  await (await chooser).setFiles({ name: 'broken-pack.zip', mimeType: 'application/zip', buffer: Buffer.from('not a pack') });
}

test('🔴 常設の帯が無い ── 浮き札が出ても配置が動かず、消せ、元に戻すが押せ、結果は数秒で消える', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await notes(page, 2);

  // ① 帯が行を取らない(shell の grid に status の行が無い)・入れ物は流れの外
  const geo = await page.evaluate(() => {
    const stack = document.querySelector('[data-pkc-region="status-stack"]') as HTMLElement;
    const shell = document.querySelector('[data-pkc-region="shell"]') as HTMLElement;
    const cs = getComputedStyle(stack);
    return { area: cs.gridArea, tracks: getComputedStyle(shell).gridTemplateRows.split(' ').length, sh: document.documentElement.scrollHeight, ih: window.innerHeight };
  });
  expect(geo.area, '入れ物が本文のマスに重なっていない(専用の行を取っている)').toContain('detail');
  expect(geo.tracks, 'grid の行に status が残っている').toBeLessThanOrEqual(8);
  expect(geo.sh, '文書が画面より高い').toBeLessThanOrEqual(geo.ih);
  await expect(page.locator(TOAST), '言うことが無いのに浮き札が出ている').toBeHidden();
  const rect = async (sel: string) => page.locator(sel).first().boundingBox();
  const centerBefore = await rect('[data-pkc-region="center"]');
  const sidebarBefore = await rect('[data-pkc-region="sidebar"]');

  // ② まとめて消す → 浮き札が出る。🔴 出ても本文・一覧の配置は 1px も動かない / 文書は画面より高くならない / 画面の内側に収まる
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await clickReal(page, '[data-pkc-action="delete-selected"]');
  await expect(rows, 'まとめて消えていない').toHaveCount(0);
  const toast = page.locator(TOAST);
  await expect(toast, '浮き札が出ない').toBeVisible();
  await expect(toast).toContainText('ゴミ箱へ移しました');
  expect(await rect('[data-pkc-region="center"]'), '浮き札が出て本文の配置が動いた').toEqual(centerBefore);
  expect(await rect('[data-pkc-region="sidebar"]'), '浮き札が出て一覧の配置が動いた').toEqual(sidebarBefore);
  const during = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: window.innerHeight }));
  expect(during.sh, '浮き札が出て文書が画面より高くなった').toBeLessThanOrEqual(during.ih);
  const tb = (await toast.boundingBox())!;
  expect(tb.x, '浮き札が左の縦のバーに重なる').toBeGreaterThanOrEqual(40);
  // 🔴 入口のボタンを覆わない(入口は縦のバーの中・浮き札は右の情報ペインの中)
  const entryBox = (await page.locator('[data-pkc-region="rail"] [data-pkc-field="message-entry"]').boundingBox())!;
  expect(tb.x, '浮き札が入口の右に収まっていない').toBeGreaterThanOrEqual(entryBox.x + entryBox.width);
  // 🔴 長い知らせでも高さを抑える(一覧を覆い尽くさない)
  const origText = await page.locator('[data-pkc-field="status-text"]').textContent();
  await page.evaluate(() => {
    (document.querySelector('[data-pkc-field="status-text"]') as HTMLElement).textContent = '長い知らせ。'.repeat(200);
  });
  const longBox = (await toast.boundingBox())!;
  expect(longBox.height, '長い知らせが一覧を覆い尽くす').toBeLessThanOrEqual(900 * 0.27);
  // 🔴 左の一覧・縦のバーの上に置かない / 追記欄の真上(札の字は中で送れるよう触れる。小さく、操作から離れた右下)
  const sideB = (await page.locator('[data-pkc-region="sidebar"]').boundingBox())!;
  const appendB = await page.locator('[data-pkc-region="append"]').boundingBox();
  expect(longBox.x, '浮き札が左の一覧に重なる').toBeGreaterThanOrEqual(sideB.x + sideB.width - 1);
  // ⚠ 追記欄はノートを開いているときだけ出る(出ていなければ測らない)
  if (appendB !== null) expect(longBox.y + longBox.height, '浮き札が追記欄を覆う').toBeLessThanOrEqual(appendB.y + 1);
  await page.evaluate((t) => {
    (document.querySelector('[data-pkc-field="status-text"]') as HTMLElement).textContent = t;
  }, origText ?? '');
  expect(tb.y + tb.height, '浮き札が画面の外').toBeLessThanOrEqual(during.ih);
  // 🔴 浮き札が実クリックを受ける(最前面)
  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-pkc-region="status"] [data-pkc-field="status-close"]') as HTMLElement;
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.getAttribute('data-pkc-field') ?? null;
  });
  expect(hit, '浮き札の × が覆われている').toBe('status-close');

  // 🔴 本文の縦のスクロールバー・ノート内の検索欄に被らない
  const overlap = await page.evaluate(() => {
    const t = (document.querySelector('[data-pkc-region="status"]') as HTMLElement).getBoundingClientRect();
    const d = document.querySelector('[data-pkc-region="detail"]') as HTMLElement;
    const dr = d.getBoundingClientRect();
    const bar = d.offsetWidth - d.clientWidth;
    const find = document.querySelector('.pkc-note-find') as HTMLElement | null;
    const fr = find !== null && find.getBoundingClientRect().width > 0 ? find.getBoundingClientRect() : null;
    const hit = fr !== null && !(t.bottom <= fr.top || t.top >= fr.bottom || t.right <= fr.left || t.left >= fr.right);
    return { overScrollbar: t.right > dr.right - bar + 0.5, hit };
  });
  expect(overlap.overScrollbar, '浮き札が本文のスクロールバーに被る').toBe(false);
  expect(overlap.hit, '浮き札がノート内の検索欄に被る').toBe(false);

  // ③ 🔴 浮き札から「元に戻す」が押せる(片道にしない)
  const undo = page.locator('[data-pkc-field="status-undo"]');
  await expect(undo, '浮き札に「元に戻す」が出ていない').toBeVisible();
  await clickReal(page, undo);
  await expect(rows, '元に戻しても 2 件に戻らない').toHaveCount(2);

  // ④ 🔴 × で閉じられる(消せない知らせを作らない)── もう一度消して、× で閉じる
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await clickReal(page, '[data-pkc-action="delete-selected"]');
  await expect(toast).toBeVisible();
  await expect(undo, '「元に戻す」が出ていない(閉じる前の前提)').toBeVisible();
  await clickReal(page, '[data-pkc-region="status"] [data-pkc-field="status-close"]');
  await expect(toast, '× を押しても浮き札が残っている').toBeHidden();
  await expect(undo, '閉じたのに「元に戻す」が残っている').toBeHidden();
  await expect(rows, '閉じただけなのに戻ってしまった(× は知らせを消すだけ)').toHaveCount(0);
  // 閉じても、同じ知らせはメッセージに残っている(簡易履歴に出る)
  const pop = await openMessagePopover(page);
  await expect(pop.locator('[data-pkc-field="popover-list"]'), '閉じた知らせが履歴に残っていない').toContainText('ゴミ箱へ移しました');
  // 🔴 閉じても操作は片道にならない: 簡易履歴の「直前の操作」に「元に戻す」が残り、押すと戻る
  await expect(pop.locator('[data-pkc-field="popover-kept"] [data-pkc-action]'), '閉じた知らせの「元に戻す」が簡易履歴に残っていない').toHaveText('元に戻す');
  await clickReal(page, pop.locator('[data-pkc-field="popover-kept"] [data-pkc-action]'));
  await expect(rows, '簡易履歴の「元に戻す」で戻らない').toHaveCount(2);
  await openMessagePopover(page);
  await page.keyboard.press('Escape');

  expect(errors, 'pageerror').toEqual([]);
});

test('🔴 結果の知らせは数秒で自動で消える', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await notes(page, 1);
  await clickReal(page, '[data-pkc-action="copy-entry-link"]');
  const toast = page.locator(TOAST);
  await expect(toast, 'コピーの知らせが出ない').toBeVisible();
  await expect(toast).toContainText('コピーしました');
  await expect(toast, '結果の知らせが居座っている').toBeHidden({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('🔴 入口のバッジ・ホバー / クリック / Esc / 外 / 焦点の戻り・既読にする・詳細を 1 度だけ開く(PC 幅)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  const hashAtBoot = await page.evaluate(() => location.hash);
  const entry = page.locator(ENTRY);
  const badge = entry.locator('[data-pkc-field="message-badge"]');
  const pop = page.locator(POP);
  await expect(entry, '左のバーにメッセージの入口が無い').toBeVisible();
  // 縦のバーの下の群(画面の下半分)
  const eb = (await entry.boundingBox())!;
  expect(eb.y, '入口が縦のバーの下のほうに無い').toBeGreaterThan(450);
  await expect(badge, '前提: 起動直後から未読が出ている').toBeHidden();

  // 問題を起こす → バッジ(未読の数)と警告色 / 浮き札にエラー
  await causeProblem(page);
  await expect(badge, '問題を起こしてもバッジが出ない').toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveText(/^[1-9]\d*$/);
  const look = await badge.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--warn)';
    document.body.append(probe);
    const warn = getComputedStyle(probe).color;
    probe.remove();
    return { bg: getComputedStyle(el).backgroundColor, warn };
  });
  expect(look.bg, 'バッジが警告色になっていない').toBe(look.warn);
  await expect(entry).toHaveAttribute('aria-label', /未読 \d+ 件/);
  await expect(page.locator(TOAST), '問題の知らせが浮き札に出ていない').toBeVisible();

  // ① 🔴 ホバー: 載せた直後は開かず(遅延)、しばらくすると開く。離れると閉じる
  await page.mouse.move(700, 400);
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await expect(pop, '遅延なしで開いた').toBeHidden();
  await expect(pop, 'ホバーで開かない').toBeVisible({ timeout: 3000 });
  await expect(entry).toHaveAttribute('aria-expanded', 'true');
  // 画面内に収まり、入口の右に出る
  const pb = (await pop.boundingBox())!;
  expect(pb.x, 'ポップオーバーが入口の右に出ていない').toBeGreaterThanOrEqual(eb.x + eb.width);
  expect(pb.y + pb.height, 'ポップオーバーが画面の下へはみ出す').toBeLessThanOrEqual(900);
  expect(pb.y, 'ポップオーバーが画面の上へはみ出す').toBeGreaterThanOrEqual(0);
  await expect(pop.locator('[data-pkc-field="popover-list"] [data-pkc-kind="problem"]').first(), '最近のメッセージに問題が出ていない').toBeVisible();
  await page.mouse.move(900, 300);
  await expect(pop, '離れても閉じない').toBeHidden({ timeout: 3000 });
  await expect(entry).toHaveAttribute('aria-expanded', 'false');

  // ② 🔴 クリックで開き(固定)、Esc で閉じて、焦点が入口へ戻る
  await clickReal(page, entry);
  await expect(pop).toBeVisible();
  await page.mouse.move(900, 300);
  await page.waitForTimeout(600);
  await expect(pop, 'クリックで開いたのに離れて閉じた(固定されていない)').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-pkc-field')), 'Esc で閉じても焦点が入口へ戻らない').toBe('message-entry');

  // ③ 外を押すと閉じる(クリックで開き直す → 本文の領域を押す)
  await clickReal(page, entry);
  await expect(pop).toBeVisible();
  await clickReal(page, '[data-pkc-region="center"]');
  await expect(pop, '外を押しても閉じない').toBeHidden();
  // ④ × で閉じて焦点が戻る
  await clickReal(page, entry);
  await expect(pop).toBeVisible();
  await clickReal(page, pop.locator('[data-pkc-action="close-message-popover"]'));
  await expect(pop).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-pkc-field'))).toBe('message-entry');

  // ⑤ 🔴 既読にする: 開かずにバッジが消える(中央は動かない)/ ポップオーバーは開いたまま
  const detailTitle = (): Promise<string | null> => page.evaluate(() => document.querySelector('[data-pkc-field="detail-title"]')?.textContent ?? null);
  const centerTitleBefore = await detailTitle();
  await clickReal(page, entry);
  await expect(pop).toBeVisible();
  await clickReal(page, pop.locator('[data-pkc-action="mark-messages-read"]'));
  await expect(badge, '既読にしてもバッジが消えない').toBeHidden();
  await expect(entry).not.toHaveAttribute('aria-label', /未読/);
  await expect(pop, '既読にするでポップオーバーが閉じた').toBeVisible();
  expect(await detailTitle(), '既読にするで中央が動いた(メッセージのノートが開いた)').toBe(centerTitleBefore);

  // ⑥ 🔴 詳細メッセージ画面を開く: 既存のメッセージのノートが 1 度だけ開き、ポップオーバーは閉じる
  await clickReal(page, pop.locator('[data-pkc-action="open-messages"]'));
  await expect(pop).toBeHidden();
  const title = page.locator('[data-pkc-view-pane="detail"] [data-pkc-field="detail-title"]');
  await expect(title, '詳細メッセージ画面が開かない').toHaveText('メッセージ');
  await expect(page.locator('[data-pkc-view-pane="detail"] [data-pkc-field="detail-title"]')).toHaveCount(1);
  expect(await page.evaluate(() => location.hash), 'hash が動いた(ディープリンク専用)').toBe(hashAtBoot);
  expect(errors, 'pageerror').toEqual([]);
});

test('🔴 スマホ幅(390×844)── 一覧でも本文でも入口が在り、簡易履歴が画面に収まり、浮き札は左下で × が効く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await expect(page.locator('[data-pkc-region="rail"]'), '前提: スマホ幅では縦のバーが無い').toBeHidden();
  const pop = page.locator(POP);
  const fits = async (label: string): Promise<void> => {
    const pb = (await pop.boundingBox())!;
    expect(pb.x, `${label}: 左へはみ出す`).toBeGreaterThanOrEqual(0);
    expect(pb.x + pb.width, `${label}: 右へはみ出す`).toBeLessThanOrEqual(390);
    expect(pb.y, `${label}: 上へはみ出す`).toBeGreaterThanOrEqual(0);
    expect(pb.y + pb.height, `${label}: 下へはみ出す`).toBeLessThanOrEqual(844);
    await expect(pop.locator('[data-pkc-action="open-messages"]'), `${label}: 詳細メッセージ画面を開くが押せない`).toBeVisible();
  };
  // ① 一覧のページ(上のバーは出ない ── 「作る」の行の末尾に同じ入口が移っている。コレクションの列の 8 個は 1 行のまま)
  const listEntry = page.locator('[data-pkc-region="create-bar"] [data-pkc-field="message-entry"]');
  await expect(listEntry, 'スマホの一覧に入口が無い').toBeVisible();
  await clickReal(page, listEntry);
  await expect(pop, '一覧で簡易履歴が開かない').toBeVisible();
  await fits('一覧');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  const docH = (): Promise<number> => page.evaluate(() => document.documentElement.scrollHeight);
  // ② 本文のページ(上のバー: 「⋯」の隣)
  await createEntry(page, 'text');
  // 追記欄は編集を確定してから出る(浮き札が追記欄を覆わないことを測るため)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-region="append"]'), '前提: 追記欄が出ていない').toBeVisible();
  const bar = page.locator('[data-pkc-region="phone-bar"]');
  await expect(bar, '前提: 本文のページで上のバーが出ていない').toBeVisible();
  const entry = bar.locator('[data-pkc-field="message-entry"]');
  await expect(entry, 'スマホの上のバーにメッセージの入口が無い').toBeVisible();
  const menuBox = (await bar.locator('[data-pkc-field="phone-menu"]').boundingBox())!;
  const entryBox = (await entry.boundingBox())!;
  expect(entryBox.x + entryBox.width, '入口が「⋯」の隣(左)に無い').toBeLessThanOrEqual(menuBox.x + 1);
  await clickReal(page, entry);
  await expect(pop, 'スマホの本文で簡易履歴が開かない').toBeVisible();
  await fits('本文');
  await expect(entry).toHaveAttribute('aria-expanded', 'true');
  await clickReal(page, pop.locator('[data-pkc-action="close-message-popover"]'));
  await expect(pop).toBeHidden();
  // ③ 浮き札: 左端から。× が効く
  const docBefore = await docH();
  await page.evaluate(() => {
    const t = document.querySelector('[data-pkc-field="status-text"]') as HTMLElement;
    t.textContent = '試験の知らせ';
    (document.querySelector('[data-pkc-region="status"]') as HTMLElement).hidden = false;
  });
  const toast = page.locator(TOAST);
  await expect(toast).toBeVisible();
  const tb = (await toast.boundingBox())!;
  expect(tb.x, '浮き札が画面の左へはみ出す').toBeGreaterThanOrEqual(0);
  // 🔴 スマホ: 追記欄(打つ欄)の上に出る ── 追記欄と上のバーを覆わない
  const barBox = (await bar.boundingBox())!;
  const appendBox = (await page.locator('[data-pkc-region="append"]').boundingBox())!;
  expect(tb.y, '浮き札が上のバーに重なる').toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
  expect(tb.y + tb.height, '浮き札が追記欄を覆う').toBeLessThanOrEqual(appendBox.y + 1);
  // 🔴 下の全幅の帯(収録・タイマー…)を覆わない: 札の下端は本文の行の下端より上
  const mainBottom = (await page.locator('[data-pkc-region="detail"]').boundingBox())!;
  expect(tb.y + tb.height, '浮き札が本文の下の帯の行に被る').toBeLessThanOrEqual(mainBottom.y + mainBottom.height + 1);
  expect(tb.x + tb.width, '浮き札が画面の右へはみ出す').toBeLessThanOrEqual(390);
  expect(tb.y + tb.height, '浮き札が画面の下へはみ出す').toBeLessThanOrEqual(844);
  await clickReal(page, '[data-pkc-region="status"] [data-pkc-field="status-close"]');
  await expect(toast, 'スマホで × が効かない').toBeHidden();
  // 🔴 浮き札を出しても、閉じても、文書の高さは変わらない(帯が行を取らない)。⚠ 絶対値でなく前後の等値 ── スマホ幅の文書の高さはこの変更と別の事情を持つ
  expect(await docH(), 'スマホで浮き札を出し入れして文書の高さが変わった').toBe(docBefore);
  expect(errors).toEqual([]);
});

test('🔴 警告・状態は帯が無くても読める ── 編集中は入口の説明と簡易履歴の「いまの状態」に出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await notes(page, 1);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator(ENTRY)).toHaveAttribute('aria-label', /編集中/);
  const pop = await openMessagePopover(page);
  await expect(pop.locator('[data-pkc-field="popover-state-list"] > li').first()).toHaveText('編集中');
  // 🔴 読み上げの領域(aria-live)は常設で、hidden でなく、1 つだけ
  const live = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-pkc-region="status-stack"] [aria-live]')];
    const e = els[0] as HTMLElement | undefined;
    return { n: els.length, hidden: e?.closest('[hidden]') !== null, w: e?.getBoundingClientRect().width ?? -1, polite: e?.getAttribute('aria-live') };
  });
  expect(live.n, '読み上げの領域が 1 つでない').toBe(1);
  expect(live.hidden, '読み上げの領域が hidden の中にある').toBe(false);
  expect(live.polite).toBe('polite');
  expect(errors).toEqual([]);
});
