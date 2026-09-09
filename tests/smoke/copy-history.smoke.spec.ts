import { expect, test } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
  useSplitEditor,
} from './helpers';

/**
 * #678: **前にコピーした物を取り出せる**。
 *
 * 🔴 **ここでしか見えない層が 3 つある**:
 * ① **本物のクリップボードへ写る**か ── unit は `navigator.clipboard` を差した
 *    偽物で見ているので、実際の write は 1 度も走らない。
 * ② **メニューが本当に出て、押せるか** ── 出す場所・重なり・押し所は
 *    happy-dom では読めない。
 * ③ 🔴 **読み直しても残るか** ── localStorage の往復は実ブラウザにしかない。
 */
test('🔴 コピーした物が残り、選ぶともう一度コピーされる (#678)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  // ⚠ 実ブラウザは許可を聞く ── 聞かれる形だと押し所の検査ができないので先に許す
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1280, height: 900 });
  // ⚠ `addInitScript` なので **`gotoApp` より前**に呼ぶ(原文の欄を出すため)
  await useSplitEditor(page);
  await gotoApp(page);
  await dismissAnnounce(page);

  // ── ① まだ何も無いときは、メニューではなく**帯で言う**(押しても何も起きない行を出さない)
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('まだ何もコピーして');
  expect(
    await page.locator('[data-pkc-region="context-menu"]').count(),
    '0 件なのにメニューを出している(押しても何も起きない行になる)',
  ).toBe(0);

  // ── ② 2 つコピーする(本文の「この章をコピー」ではなく、確実な口を使う)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('コピー元のノート');
  await page.locator('[data-pkc-field="editor-body"]').fill('ひとつめの中身\n\nふたつめの中身');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="copy-note-md"]');

  /**
   * 🔴 **積まれたことを、置き場そのもので待つ**(2026-09-09。フル smoke で 1 度落ちた)。
   *
   * ⚠ 直す前は「帯に『コピー』と出た」で次へ進んでいた ── これは**代理の観測点**で、
   *   ①別の知らせでも満たされうる ②写しは非同期なので、帯が出てから積まれるまでに
   *   間が空く。⚠ 実際、単独では 5/5 通るのにフル(498 本)の中でだけ落ちた
   *   (**再現は取れていない** ── 隣の spec と 2 本で回しても通る)。
   * 🔑 だから待つ相手を**置き場**にする。⚠ そして**落ちたら理由が読める**ようにする
   *   ── 「メニューが出ない」だけでは、写せなかったのか出せなかったのかが分からない。
   */
  await page
    .waitForFunction(
      () => (localStorage.getItem('pkc3.copy.history') ?? '').includes('ひとつめの中身'),
      undefined,
      { timeout: 15_000 },
    )
    .catch(async (e: unknown) => {
      const why = await page.evaluate(() => ({
        stored: (localStorage.getItem('pkc3.copy.history') ?? '(空)').slice(0, 200),
        status: document.querySelector('[data-pkc-region="status"]')?.textContent ?? '(無し)',
      }));
      throw new Error(
        `コピーが履歴に積まれない ── 置き場: ${why.stored} / 帯: ${why.status}`,
        { cause: e },
      );
    });

  // ── ③ 履歴に出る
  await page.keyboard.press('Control+Shift+V');
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu, '履歴のメニューが出ない').toBeVisible();
  await expect(menu).toContainText('ひとつめの中身');
  await expect(menu, '消す口が無い(消したい物を持ち続けることになる)').toContainText(
    'コピーした物を消す',
  );

  // ── ④ 🔴 選ぶと**もう一度コピーされる**(本物のクリップボードで確かめる)
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-copied="0"]');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('コピーしました');
  const pasted = await page.evaluate(() => navigator.clipboard.readText());
  expect(pasted, 'クリップボードに戻っていない(貼っても前の物が出る)').toContain('ひとつめの中身');

  /**
   * ── ④-b 🔴 **溜めてから貼る**(#679)── 選んで、並べて、追記の欄へまとめて入れる。
   *
   * ⚠ **新しい起動を足さない**(#820 の規律)── 起動 1 回は実測 1.63 秒で、
   *   以後すべての回に積まれる。同じ物語の続きとして測れるものは、続きで測る。
   * 🔴 ここでしか見えないのは 2 つ:①**器が本当に出て押せるか**
   *   ②**追記の欄に、押した順で・空行区切りで入るか**(欄は実 DOM の textarea)。
   */
  await page.keyboard.press('Escape');
  // ⚠ 2 件目を作る ── 同じ口(`copy-note-md`)を使う。別の口を足すと、
  //    そちらが押せるかどうかまで巻き込んで落ちる(この段が見たいのはそこではない)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('べつのノート');
  await page.locator('[data-pkc-field="editor-body"]').fill('べつのノートの中身');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="copy-note-md"]');
  await page.waitForFunction(
    () => (localStorage.getItem('pkc3.copy.history') ?? '').includes('べつのノートの中身'),
    undefined,
    { timeout: 15_000 },
  );
  // ⚠ **打ちかけの字を先に置く** ── まとめて入れたときに消えないことを見る
  //    (消えると、user が打っていた物が黙って失われる)
  await page.locator('[data-pkc-field="append-input"]').fill('打ちかけの字');
  // ⚠ 欄から焦点を外す ── **打っている最中は近道が効かない**(仕様)ので、
  //    外さないと次の Ctrl+Shift+V が無視される
  await page.locator('[data-pkc-field="append-input"]').blur();
  await page.keyboard.press('Control+Shift+V');
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="paste-many-copied"]');
  await expect(
    page.locator('[data-pkc-region="app-dialog"]'),
    'まとめて貼るの器が出ない',
  ).toBeVisible();
  // ⚠ 2 番目(古いほう)を先に押す ── **押した順**で入ることを見るため
  await clickReal(page, '[data-pkc-scrap-index="1"]');
  await clickReal(page, '[data-pkc-scrap-index="0"]');
  await expect(
    page.locator('[data-pkc-field="dialog-ok"]'),
    '何件入るかが字に出ていない',
  ).toHaveText('選んだ 2 件を入れる');
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  const appendInput = page.locator('[data-pkc-field="append-input"]');
  await expect(appendInput, '追記の欄へ入っていない').toHaveValue(/ひとつめの中身/);
  const many = await appendInput.inputValue();
  expect(
    many.indexOf('ひとつめの中身'),
    '押した順で入っていない(後で押した物が先に来ている)',
  ).toBeLessThan(many.indexOf('べつのノートの中身'));
  /**
   * 🔴 **繋ぎ目そのものを見る**(2026-09-09、変異試験 S1 が生き延びて判明)。
   *
   * ⚠ 1 稿目は「どこかに空行が在る」(`toContain('\n\n')`)で見ていたが、
   *   **打ちかけの字と貼った物の間**にも空行が入るので、`joinCopied` の繋ぎを
   *   `\n` に変えても**満たされてしまった**(CLAUDE.md §1「救い手が変わっただけ」)。
   * 🔑 だから **1 つ目の物の末尾**(`ふたつめの中身`)の直後を見る ──
   *   ここは繋ぎ目にしか現れない。
   */
  expect(many, '2 つの物の間が空行で区切られていない').toContain('ふたつめの中身\n\n');
  expect(many, '打ちかけの字が消えた(黙って捨てている)').toContain('打ちかけの字');
  expect(
    many.indexOf('打ちかけの字'),
    '打ちかけの字の前に入れている(後ろへ継ぐ)',
  ).toBeLessThan(many.indexOf('ひとつめの中身'));
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('追記の欄に入れました');
  // ── ⑤ 🔴 読み直しても残る(この端末に残る、が本当か)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  // ⚠ お知らせは 1 度閉じたら出ない(既読は端末に残る)── ここで待つと時間切れになる
  await page.keyboard.press('Control+Shift+V');
  await expect(
    page.locator('[data-pkc-region="context-menu"]'),
    '読み直したら消えた',
  ).toContainText('ひとつめの中身');

  // ── ⑥ 消せる(片道の操作を作らない)
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="clear-copy-history"]');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('全部消しました');
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('まだ何もコピーして');

  expect(errors, errors.join('\n')).toEqual([]);
});
