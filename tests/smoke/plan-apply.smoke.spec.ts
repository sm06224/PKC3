import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp } from './helpers';

/**
 * 🔴 **壊れたときに調べる口 + 壊れて直らないときの、最後の手**(#971 段③ / #1006)。
 *
 * ⚠ **2026-09-21(#1017 段④b)に、貼り付けの検証をここから外した**。
 *   「整理案を適用」は「構成をコピー」の隣(右の列。何も選んでいないとき)へ
 *   移った ── ここ(「システム」の面)では届かないので、
 *   `tests/smoke/collection-pane.smoke.spec.ts` が見る(あちらは起動直後の
 *   「何も選んでいない」状態を既に持っているので、新しい `gotoApp` を足さずに
 *   検められる)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **`disabled` が本当に押せないか** ── happy-dom は `click()` を素通しさせうる
 * 2. **設定の面を開いてから**辿り着けるか(畳まれていない / 隠れていない)
 *
 * ⚠ **同じ設定の面に来た道中**で「入れ物ごと捨てる」導線(#986 段③)も見る
 * (smoke-budget: 新しい起動を足さず、既に在る道中に assert を足す)。
 * ⚠ **実際に消すところまでは回さない**(後続の assert が使う状態を壊す)──
 * 「まだ消えない」「元に戻せません」等の字・「やめる」で戻る・
 * 合言葉を打ち間違えたら消えない、までを見る。
 */
test('🔴 壊れの調べと、作り直す/捨てるの 2 段が押せる (#971 / #1006)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 🔑 root に 2 件あることだけが要る(下の `resetEntryRows` の前提)
  await createEntry(page, 'folder');
  await page.locator('[data-pkc-field="editor-title"]').fill('資料');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('議事録');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  /**
   * 🔴 **入れ物ごと捨てる導線**(#986 段③)。同じ設定の面へ来た道中に足す
   * (smoke-budget: 新しい `gotoApp` を足さない ── CLAUDE.md「既に在る道中に
   * assert を足す」)。⚠ **消すところまでは回さない**(後続の assert が使う
   * 状態を壊す)── ①「まだ消えない」②「元に戻せない」等の字が出る
   * ③「やめる」で戻る ④ 合言葉を打ち間違えたら消えない、までを見る。
   * 左の一覧(フォルダの面。既定 = `filer` browse mode)は `filer-table` の
   * 行数で見る ── `data-pkc-entry` は他の面(inspector の「行き先」等)にも
   * 付くので、面をスコープしないと別の物に満たされる(CLAUDE.md §1)。
   */
  /**
   * 🔴 **壊れたときに調べる口**(#1004 / #971 段③)。
   *
   * 🔑 **新しい起動は足さない** ── 設定の面へ来た道中に assert を足す
   *   (smoke-budget。CLAUDE.md「既に在る道中に assert を足す」)。
   *
   * ⚠ **2026-09-21(#1017 段④b)に、専用の取り出しボタン 2 つを退役させた**
   *   (`db-rescue-archive-run` / `db-rescue-run`)。保存領域に問題があるときは、
   *   いつもの「バックアップ」/「Markdown」が自動で読める分だけを集める ──
   *   その自動フォールバックは `tests/smoke/archive-kind.smoke.spec.ts` が見る
   *   (壊れた DB を実ブラウザで作るのはコストが高いので、あちらは unit で
   *   `looksCorrupt` の分岐そのものを決定的に確かめる)。
   */
  const rescueBox = page.locator('[data-pkc-region="db-rescue"]');
  await expect(rescueBox, '壊れたときの欄が設定の面に出ていない').toBeVisible();
  {
    const btn = page.locator('[data-pkc-field="db-check-run"]');
    await expect(btn, 'db-check-run が見えない').toBeVisible();
    await expect(btn, 'db-check-run が押せない(dead click)').toBeEnabled();
    // 🔴 説明の 1 行は**見えている**こと(#1004。title だけだと指では読めない)
    const note = page.locator('[data-pkc-field="db-check-run-note"]');
    await expect(note, 'db-check-run の説明の 1 行が見えていない').toBeVisible();
    await expect(note, 'db-check-run の説明が空').not.toHaveText('');
  }


  const resetEntryRows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(resetEntryRows, '前提が崩れている ── フォルダの面に行が出ていない').toHaveCount(2);

  /**
   * 🔴 **見出し「壊れて直らないときの、最後の手」は廃止し、押し口 1 つで
   *   開閉する箱にした**(2026-09-21、#1017 段③-1。評価語「最後の手」を含むため
   *   `docs/development/ui-total-design-2026-09.md` §6.1 に抵触する)。
   * ⚠ 箱は既定で `hidden` ── 開くまで**作り直す / 初期化する は 1 つも見えない**。
   */
  const repairToggle = page.locator('[data-pkc-action="toggle-container-repair"]');
  await expect(repairToggle, '開閉ボタンが設定の面に出ていない').toBeVisible();
  await expect(repairToggle, '開く前から aria-expanded が true').toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const repairBox = page.locator('[data-pkc-region="container-repair"]');
  await expect(repairBox, '開く前から箱が見えている').toBeHidden();
  await clickReal(page, '[data-pkc-action="toggle-container-repair"]');
  await expect(repairBox, '押しても箱が開かない').toBeVisible();
  await expect(repairToggle, '開いたのに aria-expanded が false のまま').toHaveAttribute(
    'aria-expanded',
    'true',
  );
  /**
   * 🔴 **2 段になっている**(#1006。user 裁定 2026-09-18)── 上が
   *   「作り直す」、下が「初期化する」。
   * ⚠ **並びも見る** ── 逆に並ぶと、壊れた人が**先に取り消せないほう**を読む。
   */
  const repairButtons = page.locator('[data-pkc-region="container-repair"] button[data-pkc-action]');
  await expect(repairButtons, '2 段になっていない').toHaveCount(2);
  /**
   * 🔴 **件数ではなく「どちらが上か」を見る**(着地前の smoke が指摘した)。
   *
   * ⚠ 直す前ここは **2 つ在ること**しか見ておらず、すぐ上の注記だけが
   *   「並びも見る」と言っていた ── **並べ替えても落ちない**検査だった
   *   (CLAUDE.md「『これが無いと壊れる』と書いたら、外して壊れることを 1 度は見る」)。
   * 🔑 画面の**字**で見る(`data-pkc-action` ではなく `textContent`)── user が
   *   読むのは字であって、こちらの名前ではない。
   * 🔴 **2026-09-21(#1017 段③-1)に「中身を残して、作り直す」「中身を捨てる」から改名した**
   *   (`ui-total-design-2026-09.md` §6.1)。
   */
  await expect(repairButtons.nth(0), '上に在るのが「作り直す」ではない').toHaveText('作り直す');
  await expect(repairButtons.nth(1), '下に在るのが「初期化する」ではない').toHaveText('初期化する');
  /**
   * ⚠ **DOM の順は、画面の上下ではない**(CSS で入れ替わりうる)── 実際に
   *   置かれた位置(`boundingBox`)で、**作り直すほうが上**であることを見る。
   * ⚠ **この 2 行は、変異では 1 度も通っていない**(2026-09-18 に検算した ──
   *   append の順を入れ替えると、**すぐ上の字の比較が先に落ちる**)。
   *   🔑 ここが覆うのは「**DOM はそのままで、CSS だけ並びが裏返る**」形であり、
   *   それを当てる変異はまだ作っていない ── **弱いと自覚して置いている**。
   */
  const rebuildBox = await repairButtons.nth(0).boundingBox();
  const resetBox = await repairButtons.nth(1).boundingBox();
  expect(rebuildBox, '作り直すボタンが画面に置かれていない').not.toBeNull();
  expect(resetBox, '捨てるボタンが画面に置かれていない').not.toBeNull();
  expect(
    rebuildBox!.y,
    `画面では「捨てる」のほうが上に在る(作り直す y=${rebuildBox!.y} / 捨てる y=${resetBox!.y})`,
  ).toBeLessThan(resetBox!.y);
  const rebuildRun = page.locator('[data-pkc-field="container-rebuild-run"]');
  await expect(rebuildRun, '「作り直す」ボタンが見えない').toBeVisible();
  await expect(rebuildRun, '「作り直す」ボタンが押せない(dead click)').toBeEnabled();
  // 🔴 説明の 1 行は**見えている**こと(title だけだと指では読めない)
  const rebuildNote = page.locator('[data-pkc-field="container-rebuild-note"]');
  await expect(rebuildNote, '作り直しの説明が見えていない').toBeVisible();
  await expect(rebuildNote, '作り直しの説明が空').not.toHaveText('');
  const resetRun = page.locator('[data-pkc-field="container-reset-run"]');
  await expect(resetRun, '「初期化する」ボタンが見えない').toBeVisible();
  await expect(resetRun, '「初期化する」ボタンが押せない(dead click)').toBeEnabled();

  /**
   * ③ 🔴 **上のボタンも「押して」みる**(#1006。着地前の smoke が非対称だと指摘した)。
   *
   * ⚠ 直す前ここは「**見えている / 押せる**」までしか見ておらず、
   *   下の「初期化する」だけが最後まで押されていた ── つまり
   *   **新しく作った動線に、実ブラウザの検査が 1 つも無かった**
   *   (CLAUDE.md「UI 導線のテストを、全量 smoke で誤魔化すな」)。
   * ⚠ unit(happy-dom)は `showModal()` の実 dialog を通らないので、
   *   **ここでしか見られない**。
   * 🔴 **「始める」は押さない** ── 押すと本当に入れ物を作り直してしまう。
   *   ここで確かめたいのは「**押しただけでは何も起きない**」ことである。
   */
  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  const dialogBody = page.locator('[data-pkc-field="dialog-body"]');
  await clickReal(page, '[data-pkc-field="container-rebuild-run"]');
  await expect(dialog, '作り直しの説明の窓が出ない').toBeVisible();
  await expect(resetEntryRows, '窓を出しただけでノートが消えた').toHaveCount(2);
  await expect(dialogBody, '何をするのかが書いていない').toContainText('入れ物を作り直します');
  // 🔴 戻らない物を、押す前に言い切っている(窓の字が features の一覧と揃っていること)
  await expect(dialogBody, '戻らない物を言っていない').toContainText('戻らないもの');
  await expect(dialogBody, '履歴が戻らないことを言っていない').toContainText('履歴');
  // 🔑 落とせなかったときに止まる、といういちばん怖い所を潰す 1 行
  await expect(dialogBody, '落とせなかったときに止まることを言っていない').toContainText(
    '何も消さずに止まります',
  );
  // ⚠ 「やめる」→ 窓が閉じて、一覧は元のまま(1 件も消えていない)
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  await expect(dialog, 'やめたのに窓が閉じない').toBeHidden();
  await expect(resetEntryRows, 'やめたのにノートが変わった').toHaveCount(2);

  // ④ 捨てる側も、押した時点では 1 バイトも消えない
  await clickReal(page, '[data-pkc-field="container-reset-run"]');
  await expect(dialog, '説明の窓が出ない').toBeVisible();
  await expect(resetEntryRows, '説明の窓を出しただけでノートが消えた').toHaveCount(2);

  // ⑤ 「消えるもの」「残るもの」「元に戻せません」が書いてある
  await expect(dialogBody, '「消えるもの」が出ていない').toContainText('消えるもの');
  await expect(dialogBody, '「残るもの」が出ていない').toContainText('残るもの');
  await expect(dialogBody, '「元に戻せません」が出ていない').toContainText('元に戻せません');

  // ⑥ 「やめる」→ 窓が閉じて、一覧は元のまま
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  await expect(dialog, 'やめたのに窓が閉じない').toBeHidden();
  await expect(resetEntryRows, 'やめたのにノートが変わった').toHaveCount(2);

  // ⑦ もう一度押して「次へ(まだ消えません)」→ 合言葉を打つ欄が出る
  await clickReal(page, '[data-pkc-field="container-reset-run"]');
  await expect(dialog, '2 度目に押しても説明の窓が出ない').toBeVisible();
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  const resetPassInput = page.locator('[data-pkc-field="prompt-input"]');
  await expect(resetPassInput, '合言葉を打つ欄が出ない').toBeVisible();
  await expect(resetEntryRows, '合言葉の窓を出しただけでノートが消えた').toHaveCount(2);

  /**
   * ⑥.5 🔴 **いちばん重い 1 押しに危険色が付いているか**(#986 段③)。
   * ⚠ 新しい `gotoApp` / `page.goto` は足さない(smoke-budget: 起動は増やさず、
   * 既に在る道中に assert を足す)── 合言葉の窓が出ている今がその道中である。
   */
  await expect(
    page.locator('[data-pkc-field="dialog-ok"]'),
    '「捨てる」ボタンに危険色が付いていない',
  ).toHaveAttribute('data-pkc-danger', '');

  // ⑧ 違う字を打って「捨てる」→ 消えない(断りの字が画面に出る)
  await resetPassInput.fill('ちがう合言葉');
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect(dialog, '合言葉が違うのに窓が残っている').toBeHidden();
  await expect(resetEntryRows, '合言葉を打ち間違えたのにノートが消えた').toHaveCount(2);
  await expect(
    page.locator('[data-pkc-field="status-text"]'),
    '断りの字が画面に出ていない',
  ).toContainText('何も消していません');

  expect(errors, `page error: ${errors.join(' / ')}`).toHaveLength(0);
});
