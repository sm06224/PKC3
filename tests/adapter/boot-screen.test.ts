/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_PROGRESS_SLOW_MS,
  BOOT_PROGRESS_SLOW_TEXT,
  BOOT_PROGRESS_TEXT,
  showBootFailure,
  showBootProgress,
} from '../../src/adapter/ui/render/boot-screen';
import { bootFailureText } from '../../src/features/boot-failure-text';

let root: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  root.setAttribute('data-pkc-shell', '');
  document.body.append(root);
});
afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

describe('起動中の画面(依頼 73-1)', () => {
  it('最初から 1 行出る。理由は 2 秒までは出ない', () => {
    showBootProgress(root);
    expect(root.textContent).toBe(BOOT_PROGRESS_TEXT);
    expect(root.hasAttribute('data-pkc-shell')).toBe(false);
    vi.advanceTimersByTime(BOOT_PROGRESS_SLOW_MS - 1);
    expect(root.textContent).not.toContain(BOOT_PROGRESS_SLOW_TEXT);
  });
  it('2 秒を超えてまだこの画面なら、理由が足される', () => {
    showBootProgress(root);
    vi.advanceTimersByTime(BOOT_PROGRESS_SLOW_MS + 1);
    expect(root.textContent).toContain(BOOT_PROGRESS_SLOW_TEXT);
  });
  it('2 秒より前に別の画面へ替わっていたら、理由を足さない', () => {
    showBootProgress(root);
    root.textContent = '本体';
    vi.advanceTimersByTime(BOOT_PROGRESS_SLOW_MS + 1);
    expect(root.textContent).toBe('本体');
  });
});

describe('起動に失敗した画面(依頼 73-2)', () => {
  it('説明・詳細を表示・読み込み直す が出て、詳細は <details> の中に分かれる', () => {
    const t = bootFailureText('db user_version 5 is newer than supported 4');
    showBootFailure(root, t);
    const lead = root.querySelector('[data-pkc-boot-failure] > p')!.textContent!;
    expect(lead).toContain('データは変えていません');
    expect(lead).not.toContain('user_version');
    const d = root.querySelector('details')!;
    expect(d.querySelector('summary')!.textContent).toBe('詳細を表示');
    expect(d.querySelector('[data-pkc-boot-failure-detail]')!.textContent).toContain('user_version 5');
  });
  it('「読み込み直す」を押すと reload が 1 回呼ばれる', () => {
    const reload = vi.fn();
    showBootFailure(root, bootFailureText('x'), '', reload);
    const b = root.querySelector<HTMLButtonElement>('[data-pkc-boot-reload]')!;
    expect(b.textContent).toBe('読み込み直す');
    b.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('詳細の括弧が無い失敗は説明の全文のまま(詳細欄は作らない)。ファイル案内は説明の後ろに残る', () => {
    showBootFailure(root, '起動に失敗しました: x', '\n(ファイルは未送です)');
    expect(root.querySelector('details')).toBeNull();
    expect(root.textContent).toContain('起動に失敗しました: x');
    expect(root.textContent).toContain('(ファイルは未送です)');
  });
});
