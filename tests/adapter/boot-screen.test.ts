/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_PROGRESS_SLOW_MS,
  BOOT_PROGRESS_SLOW_TEXT,
  BOOT_PROGRESS_TEXT,
  BOOT_BACKUP_LABEL,
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

describe('起動に失敗した画面の「バックアップ」(#1163 依頼 208)', () => {
  it('🔴 「読み込み直す」と並んで「バックアップ」が出て、押すと集めている字 → 結果の 1 行が出る', async () => {
    let finish!: (s: string) => void;
    const backup = vi.fn(() => new Promise<string>((r) => (finish = r)));
    showBootFailure(root, bootFailureText('x'), '', vi.fn(), backup, '集めています…');
    expect(root.querySelector('[data-pkc-boot-reload]'), '再読み込みが消えた').not.toBeNull();
    const b = root.querySelector<HTMLButtonElement>('[data-pkc-boot-backup]');
    expect(b, 'バックアップのボタンが無い').not.toBeNull();
    expect(b!.textContent).toBe(BOOT_BACKUP_LABEL);
    const status = root.querySelector<HTMLElement>('[data-pkc-boot-backup-status]')!;
    expect(status.hidden, '押す前から結果の行が見えている').toBe(true);
    b!.click();
    expect(backup).toHaveBeenCalledTimes(1);
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('集めています…');
    // ⚠ 集めている間に 2 回目を押させない(同じ保存領域を 2 本で開き直さない)
    b!.click();
    expect(backup, '集めている間にもう一度開き直した').toHaveBeenCalledTimes(1);
    finish('「PKC3-20261115.pkc3-part.zip」を保存しました');
    await vi.runAllTimersAsync();
    expect(status.textContent).toBe('「PKC3-20261115.pkc3-part.zip」を保存しました');
    expect(b!.disabled, '終わっても押せないまま').toBe(false);
  });

  it('⚠ 失敗しても黙らない(投げても 1 行出す)', async () => {
    showBootFailure(root, bootFailureText('x'), '', vi.fn(), () => Promise.reject(new Error('x')));
    root.querySelector<HTMLButtonElement>('[data-pkc-boot-backup]')!.click();
    await vi.runAllTimersAsync();
    expect(root.querySelector('[data-pkc-boot-backup-status]')!.textContent).toBe('読めた分を書き出せませんでした');
  });

  it('⚠ 口を渡さなければ出さない(持ち歩ける 1 枚の HTML)', () => {
    showBootFailure(root, bootFailureText('x'), '', vi.fn());
    expect(root.querySelector('[data-pkc-boot-backup]')).toBeNull();
  });
});
