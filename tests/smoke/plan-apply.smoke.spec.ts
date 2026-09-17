import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp } from './helpers';

/**
 * 🔴 **整理案を貼って、下見してから当てる**(#429 段③④)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **本物の貼り付け**(`input` が実際に飛ぶか)── unit は手で event を撃っている
 * 2. **`disabled` が本当に押せないか** ── happy-dom は `click()` を素通しさせうる
 * 3. **設定の面を開いてから**辿り着けるか(畳まれていない / 隠れていない)
 *
 * ⚠ **同じ設定の面に来た道中**で「入れ物ごと捨てる」導線(#986 段③)も見る
 * (smoke-budget: 新しい起動を足さず、既に在る道中に assert を足す)。
 * ⚠ **実際に消すところまでは回さない**(後続の assert が使う状態を壊す)──
 * 「まだ消えない」「元に戻せません」等の字・「やめる」で戻る・
 * 合言葉を打ち間違えたら消えない、までを見る。
 */
test('🔴 案を貼ると下見が出て、当てると本当に移る (#429)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 相手(フォルダ)と、動かすノートを作る
  await createEntry(page, 'folder');
  await page.locator('[data-pkc-field="editor-title"]').fill('資料');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('議事録');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * lid は画面から取れる ── 行が `data-pkc-entry` に持っている
   * (情報ペインの「参照をコピー」が出すのと同じ lid)。
   * ⚠ 既定はフォルダの面なので、**そちらの表**から拾う。
   */
  const lids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pkc-entry]')].map((el) => ({
      lid: el.getAttribute('data-pkc-entry') ?? '',
      title: el.textContent ?? '',
    })),
  );
  const note = lids.find((l) => l.title.includes('議事録'));
  const box = lids.find((l) => l.title.includes('資料'));
  expect(note?.lid, '前提が崩れている ── 一覧から lid が取れない').toBeTruthy();
  expect(box?.lid).toBeTruthy();

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
  const resetEntryRows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(resetEntryRows, '前提が崩れている ── フォルダの面に行が出ていない').toHaveCount(2);

  const resetHeading = page.locator('[data-pkc-region="container-reset"] h4');
  await expect(resetHeading, '見出しが設定の面に出ていない').toHaveText('中身を捨てて、まっさらにする');
  const resetRun = page.locator('[data-pkc-field="container-reset-run"]');
  await expect(resetRun, '「中身を捨てる」ボタンが見えない').toBeVisible();
  await expect(resetRun, '「中身を捨てる」ボタンが押せない(dead click)').toBeEnabled();

  // ③ 押しても、この時点では 1 バイトも消えない
  await clickReal(page, '[data-pkc-field="container-reset-run"]');
  const resetDialog = page.locator('[data-pkc-region="app-dialog"]');
  const resetDialogBody = page.locator('[data-pkc-field="dialog-body"]');
  await expect(resetDialog, '説明の窓が出ない').toBeVisible();
  await expect(resetEntryRows, '説明の窓を出しただけでノートが消えた').toHaveCount(2);

  // ④ 「消えるもの」「残るもの」「元に戻せません」が書いてある
  await expect(resetDialogBody, '「消えるもの」が出ていない').toContainText('消えるもの');
  await expect(resetDialogBody, '「残るもの」が出ていない').toContainText('残るもの');
  await expect(resetDialogBody, '「元に戻せません」が出ていない').toContainText('元に戻せません');

  // ⑤ 「やめる」→ 窓が閉じて、一覧は元のまま
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  await expect(resetDialog, 'やめたのに窓が閉じない').toBeHidden();
  await expect(resetEntryRows, 'やめたのにノートが変わった').toHaveCount(2);

  // ⑥ もう一度押して「次へ(まだ消えません)」→ 合言葉を打つ欄が出る
  await clickReal(page, '[data-pkc-field="container-reset-run"]');
  await expect(resetDialog, '2 度目に押しても説明の窓が出ない').toBeVisible();
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

  // ⑦ 違う字を打って「捨てる」→ 消えない(断りの字が画面に出る)
  await resetPassInput.fill('ちがう合言葉');
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect(resetDialog, '合言葉が違うのに窓が残っている').toBeHidden();
  await expect(resetEntryRows, '合言葉を打ち間違えたのにノートが消えた').toHaveCount(2);
  await expect(
    page.locator('[data-pkc-field="status-text"]'),
    '断りの字が画面に出ていない',
  ).toContainText('何も消していません');

  const ta = page.locator('[data-pkc-field="plan-input"]');
  await expect(ta, '整理案の欄が設定の面に出ていない(畳まれている?)').toBeVisible();

  const apply = page.locator('[data-pkc-field="plan-apply"]');
  await expect(apply, '貼る前から押せる(dead click)').toBeDisabled();

  // ① 🔴 **誤りが在ると押せない**(行番号つきで理由が出る)
  await ta.fill('mv zzz root');
  await expect(page.locator('[data-pkc-field="plan-errors"] li')).toHaveCount(1);
  await expect(page.locator('[data-pkc-field="plan-errors"] li').first()).toContainText('1 行目');
  await expect(apply, '誤りが在るのに押せる ── 半分だけ当たる').toBeDisabled();

  // ② 正しい案 ── 下見が**題名で**出る
  await ta.fill(`mv ${note!.lid} ${box!.lid}`);
  const prev = page.locator('[data-pkc-field="plan-preview"] li');
  await expect(prev).toHaveCount(1);
  await expect(prev.first(), '下見が題名で書かれていない').toContainText('議事録');
  await expect(prev.first()).toContainText('資料');
  await expect(apply).toBeEnabled();

  // ③ 🔴 **当てると本当に移る**(フォルダ面で中に入って確かめる)
  await clickReal(page, '[data-pkc-field="plan-apply"]');
  await expect(ta, '当てた後も案が残っている ── 二重に当ててしまう').toHaveValue('');
  await expect(apply).toBeDisabled();

  await clickReal(page, '[data-pkc-browse="filer"]');
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  // root には「資料」だけが残る(議事録はその中へ入った)
  await expect(rows, 'root の行数が変わっていない ── 移っていない').toHaveCount(1);
  await expect(rows.first()).toContainText('資料');

  expect(errors, `page error: ${errors.join(' / ')}`).toHaveLength(0);
});
