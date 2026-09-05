import { test, expect, type Page } from '@playwright/test';
import { answerAppDialog, gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 整理の面(#240 段①〜⑤。user 指示 2026-08-17
 * 「フォルダ表示メインに / ダブルクリックで開く / 複数選択・範囲選択・D&D /
 * まとめて消せない」)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **実マウスの 2 クリック** ── happy-dom の合成 `dblclick` は「本当に 2 回押した」
 *    ことを保証しない(1 クリック目の副作用と順序が実機と違いうる)
 * 2. **実 HTML5 ドラッグ&ドロップ** ── happy-dom に `DataTransfer` が無いので、
 *    unit は掴む・落とすを 1 度も通れない
 * 3. **最初に出る面**(既定がフォルダになったこと)を、実際の起動で見る
 */

/** 実マウスで 2 回押す(⚠ `dispatchEvent` ではなく本物の click 列)。 */
async function doubleClickReal(page: Page, selector: string): Promise<void> {
  /**
   * ⚠ **`locator.dblclick()` を使う**(`page.mouse.dblclick` ではなく)。
   * 座標を先に採る書き方は、**採ってから押すまでの間に表が組み直されると**
   * 2 回のクリックが別のノードに落ちて `dblclick` が出ない
   * (再描画で node が差し替わるのは正常 ── `helpers.ts` の `withRerenderRetry` と同じ話)。
   * locator 側は「安定するまで待ってから押す」ので、その窓が消える。
   */
  await page.locator(selector).first().dblclick();
}

async function makeFolder(page: Page, title: string): Promise<void> {
  await createEntry(page, 'folder');
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('🔴 最初はフォルダの面で開き、2 クリックで中へ入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① 既定はフォルダ(user 指示 2026-08-17)── タブと中身が一致していること
  await expect(page.locator('[data-pkc-browse="filer"][data-pkc-active]')).toHaveCount(1);
  await expect(page.locator('[data-pkc-region="filer-table"]')).toBeVisible();

  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(2);

  // ② 🔴 1 クリックでは**入らない**(選ぶだけ)── 逆向きだけ見ると、
  //    「1 クリックでも入る」実装が素通りする(doc §5 の注意)
  const folderRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]';
  const noteRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="text"]';
  await clickReal(page, folderRow);
  await expect(rows, '1 クリックで入ってしまった').toHaveCount(2);

  /**
   * ③ 2 クリックで入る。
   * ⚠ **間に別の行を押して「連続」を切る** ── 押さないと、②の 1 クリックと
   *   ③の 1 打目が**続けて押した 2 回**に数えられる(閾値 500ms)。実 user も
   *   同じで、それは仕様どおりだが、ここで見たいのは「2 打で入る」ことである。
   */
  await clickReal(page, noteRow);
  await doubleClickReal(page, folderRow);
  await expect(page.locator('[data-pkc-region="filer-breadcrumb"]')).toContainText('はこ');
  await expect(rows, 'フォルダに入れていない').toHaveCount(0);

  // ④ パンくずのルートで戻る(⚠ 開いているノートは閉じない)
  await clickReal(page, '[data-pkc-region="filer-breadcrumb"] button');
  await expect(rows).toHaveCount(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 まとめて選んで、まとめてゴミ箱へ入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  for (let i = 0; i < 3; i += 1) {
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(3);

  // ① 実キーの修飾つきクリックで印が増える
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-marked]')).toHaveCount(
    2,
  );
  // ② 2 件以上で帯が出る
  const bulk = page.locator('[data-pkc-field="filer-bulk"]');
  await expect(bulk).toBeVisible();
  await expect(bulk).toContainText('2 件');

  /**
   * ③ 範囲選択(Shift)は**見えている並び**で採る ── 起点は最後に押した行。
   * ⚠ **どの行に印が付いたか**で見る(件数だけ見ると、範囲選択が完全な no-op でも
   *   前後とも 2 件のまま通る ── 着地前レビューの指摘)。
   */
  await rows.nth(1).click({ modifiers: ['Shift'] });
  const marked = page.locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-marked]');
  await expect(marked).toHaveCount(2);
  // 起点 = 3 行目(直前に Ctrl で押した)→ 2 行目まで = 2 件目と 3 件目
  await expect(marked.first()).toHaveAttribute('data-pkc-archetype', 'text');
  await expect(
    rows.nth(0),
    '範囲の外(1 行目)にまで印が残っている',
  ).not.toHaveAttribute('data-pkc-marked', '');

  /**
   * ④ まとめてゴミ箱へ。
   * 🔴 **確認は「アプリの中の要素」になった**(#299 段②)── `page.on('dialog')` は
   *   もう 1 度も発火しない。⚠ native のモーダルはレンダラを止めるので、
   *   CDP から見ると「画面が固まった」と区別が付かなかった(それが差し替えの理由)。
   */
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await clickReal(page, '[data-pkc-action="delete-selected"]');
  // ⚠ 件数を**確認の文言でも**見る(1 件ずつ n 回聞く実装に戻ったら落ちる)
  expect(await answerAppDialog(page, 'ok'), '確認が件数で聞いていない').toContain('2 件');
  await expect(rows, 'まとめて消えていない').toHaveCount(1);

  // ⑤ 🔴 **戻せる**(ゴミ箱へ入っただけ)
  await clickReal(page, '[data-pkc-action="show-trash"]');
  await expect(page.locator('[data-pkc-region="filer-trash"]')).toContainText('件');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 掴んでフォルダに落とすと入り、パンくずに落とすと出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(2);
  const folderRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]';
  const noteRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="text"]';

  // ① 掴んでフォルダへ落とす ── **実 HTML5 D&D**(unit は DataTransfer を持てない)
  await page.dragAndDrop(noteRow, folderRow);
  /**
   * 🔴 **落とした先へは付いていかない**(user 裁定 2026-08-18「OS のファイラ動作に
   * 似せる」)── いまの場所から**消える**のが標準の見え方。⚠ ただし行き先は名乗る。
   */
  /**
   * ⚠ **アプリ自身の信号を先に待つ**(2026-08-18)。全量(負荷のかかった回)で
   * 1 度だけ「ルートから消えていない」で落ちた ── 実際に起きていたのは
   * **掴み損ね**(合成 D&D は負荷で落ちることがある)で、行数を先に見ると
   * 「移動が壊れた」と読み違える。行き先を名乗る 1 行は**移動が済んだ証拠**なので、
   * これを先に待つと、落ちたときの意味が「掴めなかった」に定まる。
   */
  await expect(page.locator('[data-pkc-region="status"]'), '掴んで落とせていない').toContainText(
    '「はこ」へ入れました',
  );
  await expect(page.locator('[data-pkc-region="filer-breadcrumb"]')).not.toContainText('はこ');
  await expect(rows, 'ルートから消えていない').toHaveCount(1);

  // ② 中に入れば居る(2 クリック)
  await page.locator(folderRow).dblclick();
  await expect(rows, 'フォルダへ入っていない').toHaveCount(1);
  await expect(page.locator('[data-pkc-region="filer-breadcrumb"]')).toContainText('はこ');

  // ③ パンくず(ルート)へ落として出す ── 出したものはこの場から消える
  await page.dragAndDrop(noteRow, '[data-pkc-region="filer-breadcrumb"] button');
  await expect(rows, 'ルートへ出せていない').toHaveCount(0);
  await clickReal(page, '[data-pkc-region="filer-breadcrumb"] button');
  await expect(rows, 'ルートに戻っていない').toHaveCount(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **OS のファイラと同じ鍵**(user 裁定 2026-08-18「平仄も合わせて」)。
 *
 * 🔴 **unit では届かない層**をここで見る:
 * ① **実キーの既定動作**(`Backspace` はブラウザの「戻る」だった時代の名残を持つ /
 *    `Delete` は行によっては何も起きない)── 止め損ねると**画面ごと戻る**
 * ② **クリックで行に焦点が入るか**(happy-dom は焦点の移動を実装しきっていない)
 */
test('🔴 Enter で入り、Backspace で戻り、Delete でゴミ箱へ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(2);
  const folderRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]';

  // ① 行を押すと**その行に焦点が入る**(鍵の効く場所が決まる)
  // ⚠ `closest(...) !== null` で書くと、`activeElement` が `null` の回に
  //   `undefined !== null` = true で**通ってしまう**。しかも表そのものでも
  //   満たされるので、**`TR` であること**まで見る(代替物で満たせる条件にしない)
  await clickReal(page, folderRow);
  expect(
    await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return 'なし';
      return el.closest('[data-pkc-region="filer-table"]') ? el.tagName : '表の外';
    }),
    '行を押しても焦点が行に入らない(鍵が効く場所が決まらない)',
  ).toBe('TR');

  // ② Enter で中へ
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-pkc-region="filer-breadcrumb"]')).toContainText('はこ');
  await expect(rows, 'フォルダの中に入れていない').toHaveCount(0);

  // ③ Backspace で親へ ── ⚠ **画面ごと戻っていない**ことも見る
  const url = page.url();
  await page.keyboard.press('Backspace');
  await expect(rows, '親へ戻れない').toHaveCount(2);
  expect(page.url(), 'ブラウザの「戻る」が起きた').toBe(url);

  // ④ Delete でゴミ箱へ(確認は**アプリの中**の口を押す ── #299 段②)
  await clickReal(page, '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="text"]');
  await page.keyboard.press('Delete');
  expect(await answerAppDialog(page, 'ok'), '確認が出ていない').toContain('削除');
  await expect(rows, 'ゴミ箱へ入っていない').toHaveCount(1);

  /**
   * ⑤ 🔴 **消したあとも鍵が生きている**。表は `entryMetas` が変わると丸ごと
   * 組み直されるので、押した行と一緒に**焦点が body へ落ちる** ── 直す前は
   * 1 回消したらそこで `Backspace` も `Delete` も `Ctrl+A` も死んでいた。
   * ⚠ ここは**時間ではなく続きの操作**で見る(焦点の有無だけ見ると、次の鍵が
   *   本当に届くかは分からない)。
   */
  await expect(rows).toHaveCount(1);
  await page.keyboard.press('Backspace'); // ルートに居るので何も起きない = 安全な一手
  expect(
    await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement &&
        el.closest('[data-pkc-region="filer-table"]') !== null
        ? 'ある'
        : 'ない';
    }),
    '消したら焦点が表の外へ落ちた(次の鍵が届かない)',
  ).toBe('ある');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **中身のあるフォルダ**でしか通らない枝を、実ブラウザで通す。
 *
 * ⚠ これまでの smoke はフォルダが**空**だったので、「入った先の 1 行目へ焦点を
 * 置く」という本命の枝は **unit でも smoke でも 1 度も実行されていなかった**
 * (CLAUDE.md §2「経路が一度も通っていない ── 弱いのではなく走っていない」)。
 * ⚠ あわせて **`Space` が鍵になっていないこと**も見る ── 行に `tabindex` を
 * 足した副作用で、登録も設定も説明も無い「印を 1 件へ潰す」鍵が開いていた。
 */
test('🔴 中へ入ると 1 行目に焦点が乗り、Space は印を潰さない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(3);
  const folderRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]';
  const noteSel = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="text"]';
  const marked = page.locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-marked]');

  // ① 1 件をフォルダへ入れる(= 入った先が空でなくなる)
  await page.dragAndDrop(noteSel, folderRow);
  await expect(rows, 'フォルダへ入っていない').toHaveCount(2);

  // ② 印を 2 件付けて、Space を押しても潰れないことを見る
  await clickReal(page, folderRow);
  await page.locator(noteSel).first().click({ modifiers: ['ControlOrMeta'] });
  await expect(marked, '印が 2 件になっていない(空振り)').toHaveCount(2);
  await page.keyboard.press('Space');
  await expect(marked, 'Space が印を潰した').toHaveCount(2);

  // ③ フォルダへ Enter ── 入った先の**行**に焦点が乗る(表そのものではない)
  /**
   * ⚠ **焦点の足跡を採る**。落ちたときに「行に乗らなかった」だけでは、
   * *置けなかった*のか *後から誰かに奪われた*のかが区別できない
   * (1 稿目で実際に 2 回読み違えた)。`focusin` を記録して**名前で**出す。
   */
  await page.evaluate(() => {
    const w = window as unknown as { __focusTrail__?: string[] };
    w.__focusTrail__ = [];
    const name = (t: unknown): string =>
      t instanceof HTMLElement
        ? `${t.tagName}${t.getAttribute('data-pkc-entry') ? '#' + t.getAttribute('data-pkc-entry') : ''}${t.getAttribute('data-pkc-region') ? '@' + t.getAttribute('data-pkc-region') : ''}`
        : String(t);
    document.addEventListener('focusin', (e) => w.__focusTrail__?.push('in:' + name(e.target)), true);
    document.addEventListener('keydown', (e) => w.__focusTrail__?.push('key:' + e.key), true);
  });
  /**
   * ⚠ **連打を切る** ── 直前に同じ行を押していると、この 1 打が「2 クリック」に
   * 数えられて**キーを押す前に入ってしまう**(1 稿目で実際に踏み、Enter が
   * 中のノートに当たって `detail` へ飛んだ)。既存 test と同じ作法。
   */
  await clickReal(page, noteSel);
  await clickReal(page, folderRow);
  // 空振り防止 ── **押す前はまだルートに居る**(入っていたら以降は別の主張になる)
  await expect(
    page.locator('[data-pkc-region="filer-breadcrumb"]'),
    'Enter を押す前に入ってしまっている',
  ).not.toContainText('はこ');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-pkc-region="filer-breadcrumb"]')).toContainText('はこ');
  await expect(rows, 'フォルダの中身が 1 件でない(空振り)').toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return 'なし';
      if (!el.closest('[data-pkc-region="filer-table"]')) return '表の外';
      return el.tagName === 'TR' ? '行' : el.tagName;
    }),
    `入った先で焦点が行に乗らない。焦点の足跡: ${JSON.stringify(
      await page.evaluate(
        () => (window as unknown as { __focusTrail__?: string[] }).__focusTrail__ ?? [],
      ),
    )}`,
  ).toBe('行');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **上下キーの行送りと、Enter の「読む」**(user 裁定 2026-08-18)。
 *
 * 🔴 **unit では届かない層**をここで見る:
 * ① **実キーの ↑↓ が既定(画面のスクロール)を奪えているか** ── 奪い損ねると
 *    行は動かず版面だけ動く
 * ② **焦点が本当に行へ移るか**(happy-dom は焦点の移動を実装しきっていない)
 * ③ **設定 → 開く → 編集**が実ブラウザで繋がるか
 */
test('🔴 ↑↓ で行を送れて、Enter は読むところから始まる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  for (let i = 0; i < 3; i += 1) {
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(3);
  const marked = page.locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-marked]');
  const focusedLid = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement
        ? (el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? 'なし')
        : 'なし';
    });

  // ① 1 行目を押してから ↓ ── 焦点も印も動く
  await rows.nth(0).click();
  const first = await focusedLid();
  expect(first, 'クリックで行に焦点が入らない(空振り)').not.toBe('なし');
  await page.keyboard.press('ArrowDown');
  const second = await focusedLid();
  expect(second, '↓ で焦点が動かない').not.toBe(first);
  await expect(marked, '送った先が選ばれていない').toHaveCount(1);
  await expect(marked.first()).toHaveAttribute('data-pkc-entry', second);

  // ② Shift+↓ で積み上がる
  await page.keyboard.press('Shift+ArrowDown');
  await expect(marked, 'Shift+↓ で積み上がらない').toHaveCount(2);

  // ③ Enter は**読む**ところから(編集の欄は出ない)
  await page.keyboard.press('ArrowUp'); // 印を 1 件へ戻す
  await page.keyboard.press('Enter');
  /**
   * ⚠ 観測点は**本文の面の中の**保存の導線にする。2 度外した:
   * ① `editor-body` / `row-source` を数えた ── 既定の live 面では**編集中でも
   *    出ない**(原文の箱は押した行にだけ出る)ので否定側が**常に真**だった
   * ② 面へスコープせず `commit-edit` を数えた ── **追記欄にも同じ action の
   *    ボタンが在る**(`append-box.ts`)ので、編集していなくても 1 件あった
   * 🔑 CLAUDE.md §1「面(region)へスコープする」。
   */
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]'),
    'Enter で編集に入ってしまった(既定は読む)',
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.activeElement?.closest('[data-pkc-region="detail"]') !== null,
    ),
    'Enter で本文の面へ焦点が移っていない',
  ).toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **行の上半分に落とすと、その行の前へ並べ替わる**(#215)。
 * ⚠ unit は行の**中の座標**(上半分 / 下半分)を持てない ── 実 HTML5 D&D の
 *   `clientY` と `getBoundingClientRect` が本物で一致するかは、ここでしか見えない。
 * ⚠ 題名ではなく **lid の並び**で見る(既定の編集の道具では題名を打てない回がある)。
 */
test('🔴 行を別の行の上半分に落とすと、その行の前へ並べ替わる (#215)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  for (let i = 0; i < 3; i += 1) {
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(3);
  const before = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-pkc-entry')));
  const box = await rows.nth(0).boundingBox();
  expect(box, '1 行目に大きさが無い').not.toBeNull();
  // 3 行目を掴んで、1 行目の**上端から 2px** へ落とす(= 上半分)
  await page.dragAndDrop(
    '[data-pkc-region="filer-table"] tbody tr:nth-child(3)',
    '[data-pkc-region="filer-table"] tbody tr:nth-child(1)',
    { targetPosition: { x: Math.round(box!.width / 2), y: 2 } },
  );
  // ① アプリ自身の合図を先に待つ(掴み損ねと並べ替えの不具合を見分ける)
  await expect(page.locator('[data-pkc-region="status"]'), '並べ替えの合図が出ない').toContainText(
    '1 件を並べ替えました',
  );
  // ② 並びが「3 行目 → 1 行目 → 2 行目」になっている
  const after = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-pkc-entry')));
  expect(after, '前へ動いていない').toEqual([before[2], before[0], before[1]]);
  // ③ 中へ入っていない(行数は 3 のまま)
  await expect(rows).toHaveCount(3);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 設定を入れると、Enter がそのまま編集に入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // ⚠ **goto の前に**仕込む(設定は面を組む前に読まれる)
  await page.addInitScript(() => {
    try {
      globalThis.localStorage.setItem('pkc3.open-in-edit', '1');
    } catch {
      /* sandbox の frame ── アプリの設定とは無関係 */
    }
  });
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(1);

  await rows.nth(0).click();
  await page.keyboard.press('Enter');
  // ⚠ **本文が届いてから**編集に入る(その場では入らない)ので、待って見る
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]'),
    '設定を入れても編集に入らない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
