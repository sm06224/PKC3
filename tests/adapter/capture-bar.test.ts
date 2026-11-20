/** @vitest-environment happy-dom */
/**
 * 🔴 **収録中の帯は小さな 1 行**(#1985 項目 1。user 裁定 案 A)。
 * 見るのは描いた DOM: `● 録音中 0:07  [止める] [残さずにやめる]` の 4 部品、量・残りと途中保存の理由は title、
 * 1 秒ごとの描き直しで**部品を作り直さない**(押している最中の「止める」が消えない)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildShell, paintCaptureBar } from '../../src/adapter/ui/render/shell';

beforeEach(() => {
  document.body.textContent = '';
});

function shell(): { root: HTMLElement; bar: HTMLElement } {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  return { root, bar: root.querySelector<HTMLElement>('[data-pkc-region="capture-bar"]')! };
}

describe('収録中の帯(小さな 1 行)', () => {
  it('● + 字 + 止める + 残さずにやめる の 4 部品だけ(2 行目を作らない)', () => {
    const { root, bar } = shell();
    expect(bar.hidden, '収録していないのに出ている').toBe(true);
    paintCaptureBar(root, '録音中 0:07', '録音中 0:07(約 12 KB・残り 11:59:53)');
    expect(bar.hidden).toBe(false);
    expect([...bar.children].map((c) => c.getAttribute('data-pkc-field'))).toEqual([
      'capture-dot',
      'capture-status',
      'stop-capture',
      'discard-capture',
    ]);
    expect(bar.querySelector('[data-pkc-field="capture-dot"]')!.textContent).toBe('●');
    expect(bar.querySelector('[data-pkc-field="stop-capture"] [data-pkc-field="label"]')!.textContent).toBe('止める');
    expect(bar.querySelector('[data-pkc-field="discard-capture"] [data-pkc-field="label"]')!.textContent).toBe('残さずにやめる');
    // 片道にしない: 捨てる口は残っていて、全文は title が言う(画面の字は短い)
    expect(bar.querySelector('[data-pkc-field="discard-capture"]')!.getAttribute('title')).toContain('残さずにやめます');
    expect(bar.querySelector('[data-pkc-field="discard-capture"]')!.getAttribute('data-pkc-variant')).toBe('ghost');
  });

  it('状態(収録中 → 途中保存なし → 畳む)は部品を作り直さずに書き替わる / 量・残りは title', () => {
    const { root, bar } = shell();
    paintCaptureBar(root, '録音中 0:07', '録音中 0:07(約 12 KB・残り 11:59:53)');
    const status = bar.querySelector<HTMLElement>('[data-pkc-field="capture-status"]')!;
    const stop = bar.querySelector('[data-pkc-field="stop-capture"]');
    expect(status.title).toContain('残り 11:59:53');
    expect(status.textContent, '量・残りが 1 行に出ている').not.toContain('残り');
    paintCaptureBar(root, '録音中 0:08・途中保存できていません', '録音中 0:08(約 13 KB・残り 11:59:52)・途中保存できていません');
    expect(status.textContent).toContain('途中保存できていません');
    expect(status.title).toContain('途中保存できていません');
    expect(bar.querySelector('[data-pkc-field="stop-capture"]'), '止めるを作り直した').toBe(stop);
    expect(bar.querySelector('[data-pkc-field="capture-status"]'), '字を作り直した').toBe(status);
    paintCaptureBar(root, null);
    expect(bar.hidden).toBe(true);
    expect(status.hasAttribute('title'), '畳んだ後に古い title が残る').toBe(false);
  });
});
