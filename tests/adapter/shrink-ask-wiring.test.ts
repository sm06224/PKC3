/** @vitest-environment happy-dom */
/**
 * 🔴 **「縮めますか」の窓まわり**(#1652 3 / 5)── 窓のチェック欄と、貼付が同じ聞き方を通ること。
 *
 * ⚠ 窓は実物(`<dialog>`)を押す。`main.ts` は原文を読む test しか持てないので、
 *   貼付の配線(5)は**原文の形**で pin する(弱い pin だと自覚して、見る範囲を `pasteImages` の本体に絞る)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  confirmCheckInApp,
  resetAppDialogForTest,
} from '../../src/adapter/ui/render/app-dialog';
import { SHRINK_REMEMBER_LABEL } from '../../src/features/asset/image-shrink';
import { answerDialog, dialogMessage, openDialog } from './dialog-helper';

describe('窓のチェック欄「残りも同じにする」(#1652 3)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    host = document.createElement('div');
    document.body.append(host);
  });

  const check = (): HTMLInputElement =>
    openDialog()!.querySelector<HTMLInputElement>('[data-pkc-field="dialog-check"]')!;

  it('🔴 チェックを入れて「縮める」を押すと、答えとチェックの両方が返る', async () => {
    const p = confirmCheckInApp(host, '「a.jpg」(3 枚中 1 枚目)', {
      okLabel: '画像を縮める',
      cancelLabel: 'そのまま',
      checkLabel: SHRINK_REMEMBER_LABEL,
    });
    expect(dialogMessage()).toContain('3 枚中 1 枚目');
    expect(openDialog()!.textContent).toContain('残りも同じにする');
    check().checked = true;
    await answerDialog('ok');
    expect(await p).toEqual({ answer: 'ok', checked: true });
  });

  it('🔑 対照群 ── 入れずに「そのまま」を押すと、チェックは偽', async () => {
    const p = confirmCheckInApp(host, '本文', { checkLabel: SHRINK_REMEMBER_LABEL });
    await answerDialog('cancel');
    expect(await p).toEqual({ answer: 'cancel', checked: false });
  });

  it('🔴 前の窓のチェックを次の窓へ持ち越さない', async () => {
    const first = confirmCheckInApp(host, '1 枚目', { checkLabel: SHRINK_REMEMBER_LABEL });
    check().checked = true;
    await answerDialog('ok');
    await first;
    const second = confirmCheckInApp(host, '2 枚目', { checkLabel: SHRINK_REMEMBER_LABEL });
    expect(check().checked, '前の窓のチェックが残っている').toBe(false);
    await answerDialog('ok');
    expect((await second).checked).toBe(false);
  });
});

describe('貼付も、添付と同じ「縮めますか」を通る(#1652 5)', () => {
  const main = readFileSync(join(__dirname, '../../src/main.ts'), 'utf8');
  const start = main.indexOf('pasteImages: async (files) => {');
  const body = main.slice(start, main.indexOf('adoptUrls: (urls, namePrefix)', start));

  it('🔴 pasteImages の本体が、縮める確認(maybeShrink)を通してから置く', () => {
    expect(start, '前提:pasteImages が見つからない').toBeGreaterThan(0);
    expect(body.length, '前提:本体を切り出せていない').toBeGreaterThan(200);
    const shrink = body.indexOf('maybeShrink(attachDeps');
    const store = body.indexOf('storeAsset(attachDeps');
    expect(shrink, '貼付が縮める確認を通っていない').toBeGreaterThan(-1);
    expect(store, '前提:置く呼び出しが見つからない').toBeGreaterThan(-1);
    expect(shrink, '確認より先に置いている').toBeLessThan(store);
  });

  it('🔴 窓には「残りも同じにする」を出せる口(askShrink の 2 つ目の引数)を渡している', () => {
    const m = /askShrink: async \(question, opts\)[\s\S]{0,700}?confirmCheckInApp\(root, question,/.exec(main);
    expect(m, 'askShrink が残りの写真のチェック欄を付けていない').not.toBeNull();
  });
});
