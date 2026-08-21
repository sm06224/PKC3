/**
 * 🔴 **OS から md を開く → その場で見えて、元ファイルへ戻せる**(2026-08-05、
 * user 報告「マークダウンファイルに紐付けれるけど、取り込みもスポットの編集
 * プレビュー導線も存在しない」/「開いたら何も起きずに終わる」)。
 *
 * ⚠ **unit では main.ts の配線に届かない**。`launchQueue` の受け口・取込・紐づけ・
 * 情報ペインの導線・書き戻しは、それぞれ unit で守っているが、**それらを繋いでいる
 * のは `main.ts` の closure だけ**である ── 既存の launch test は「受け口が
 * 張られたか」しか見ておらず、繋ぎ目が外れていても緑だった(調査 doc §5)。
 *
 * ここでは `window.launchQueue` を**アプリが読む前に**差して、実ブラウザで
 * 端から端まで通す。⚠ handle の fake は**本物の意味論**を真似る
 * (`isSameEntry` は同じファイルにだけ true / `createWritable` は書いた文字を貯める)。
 */
import { test, expect } from '@playwright/test';
import { answerAppDialog, gotoApp, clickReal, collectPageErrors, useSplitEditor, useListBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

/** アプリが `armLaunchQueue` を呼ぶ前に `launchQueue` を用意する。 */
async function stubLaunch(
  page: import('@playwright/test').Page,
  files: { name: string; text: string; id: string }[],
): Promise<void> {
  await page.addInitScript((specs: { name: string; text: string; id: string }[]) => {
    const w = window as unknown as {
      __written?: Record<string, string>;
      __fire?: (which: number[]) => void;
    };
    w.__written = {};
    const handles = specs.map((spec) => ({
      id: spec.id,
      kind: 'file',
      getFile: () =>
        Promise.resolve(new File([spec.text], spec.name, { type: 'text/markdown' })),
      // ⚠ 本物は「同じファイルを指すか」を答える(名前ではなく実体)
      isSameEntry: (other: { id?: string }) => Promise.resolve(other.id === spec.id),
      queryPermission: () => Promise.resolve('granted'),
      createWritable: () =>
        Promise.resolve({
          write: (data: string) => {
            w.__written![spec.name] = data;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        }),
    }));
    let consumer: ((p: unknown) => void) | null = null;
    /**
     * ⚠ **代入では差せない**(2026-08-05 に踏んだ)。`window.launchQueue` は
     * 読み取り専用の platform 属性なので、`window.launchQueue = …` は
     * **黙って無視される** ── アプリは本物(空)の queue を読み、ファイルが
     * 一度も届かないまま test は「何も起きない」を見る(= 空振り)。
     * `defineProperty` で置き換える。
     */
    Object.defineProperty(w, 'launchQueue', {
      configurable: true,
      value: {
        setConsumer: (fn: (p: unknown) => void) => {
          consumer = fn;
          // 仕様どおり「登録前に溜まっていた分が即座に流れる」を再現
          fn({ files: [handles[0]] });
        },
      },
    });
    // 2 通目以降(起動中に別の md を開く / 同じ md をもう一度開く)
    w.__fire = (which) => consumer?.({ files: which.map((i) => handles[i]) });
  }, files);
}

test('🔴 OS から開いた md が画面に出て、直して元ファイルへ戻せる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await stubLaunch(page, [
    { id: 'inbox/議事録.md', name: '議事録.md', text: '# 議事録\n\n本文です。\n' },
    { id: 'archive/議事録.md', name: '議事録.md', text: '# 別の議事録\n' },
  ]);
  await gotoApp(page);

  // ① **開いたら画面に出る**(直す前は末尾に足すだけで、何も起きないように見えた)
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('本文です。');
  // ② **どのファイルから来たか**が情報ペインに出る
  await expect(page.locator('[data-pkc-field="inspector-linked-file"]')).toHaveText(
    '議事録.md',
  );

  // ③ 中身を直す(実際の編集導線 ── 本文欄は 1 打鍵ごとに state へ写る)
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await page.fill('[data-pkc-field="editor-body"]', '# 議事録\n\n直しました。\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  // ④ **元ファイルへ書き戻す**(確認は出る ── user のファイルを上書きするので)
  await clickReal(page, '[data-pkc-action="write-back-file"]');
  await answerAppDialog(page, 'ok');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __written: Record<string, string> }).__written['議事録.md']))
    .toBe('# 議事録\n\n直しました。\n');

  // ⑤ 🔴 **同じファイルをもう一度開いても増えない**(前のノートを出す)
  const count = () => page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').count();
  const before = await count();
  await page.evaluate(() => (window as unknown as { __fire: (w: number[]) => void }).__fire([0]));
  // ⚠ 「増えなかった」だけでは**何も起きなくても通る** ── 経路が走った証拠を見る
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '重複を弾いたことを言っていない(黙って終えている)',
  ).toContainText('すでに開いている');
  await expect.poll(count, { message: '同じ md で増えた' }).toBe(before);

  // ⑥ 🔴 **同名の別ファイル**は別のノートになる(名前で照合していない証拠)
  await page.evaluate(() => (window as unknown as { __fire: (w: number[]) => void }).__fire([1]));
  await expect.poll(count, { message: '同名の別ファイルが同じ物と見なされた' }).toBe(before + 1);
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('別の議事録');

  expect(errors).toEqual([]);
});
