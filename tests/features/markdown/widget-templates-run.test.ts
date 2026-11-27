/** @vitest-environment happy-dom */
/**
 * 🔴 v4.0 仕上げ PR-D ── 追加した HTML ツール 2 種(表の検索・作業タイマー)を、台本ごと実際に動かして確かめる。
 * 箱の中と同じく `window.localStorage` と `window.pkcWidget.readTables()` だけに頼る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIDGET_TEMPLATES } from '../../../src/features/markdown/widget-templates';

function mount(baseId: string, tables?: unknown[]): void {
  const t = WIDGET_TEMPLATES.find((x) => x.baseId === baseId)!;
  const markup = t.html.replace(/<script>[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = markup;
  (window as unknown as { pkcWidget?: unknown }).pkcWidget =
    tables === undefined ? undefined : { readTables: () => Promise.resolve(tables) };
  for (const m of t.html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]!)();
}
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('表の検索・絞り込み', () => {
  const TABLES = [
    { index: 0, kind: 'markdown', headers: ['案件', '担当'], rows: [['受付の改修', '佐藤'], ['帳票の自動化', '高橋'], ['受付の案内', '田中']], truncated: false },
    { index: 1, kind: 'csv', headers: ['a'], rows: [['x']], truncated: false },
  ];

  it('🔴 語で行を絞り、件数を出し、語を保存する(空白区切りは全部を含む行)', async () => {
    mount('table-filter', TABLES);
    await flush();
    expect($('count').textContent).toBe('3 / 3 行');
    const q = $('q') as HTMLInputElement;
    q.value = '受付';
    q.dispatchEvent(new Event('input'));
    expect($('count').textContent).toBe('2 / 3 行');
    expect($('out').querySelectorAll('mark')).toHaveLength(2);
    q.value = '受付 田中';
    q.dispatchEvent(new Event('input'));
    expect($('count').textContent).toBe('1 / 3 行');
    expect(window.localStorage.getItem('query')).toBe('受付 田中');
  });

  it('表を切り替えられ、表が無いときは書き方を案内する', async () => {
    mount('table-filter', TABLES);
    await flush();
    const pick = $('pick') as HTMLSelectElement;
    expect(pick.options).toHaveLength(2);
    pick.value = '1';
    pick.dispatchEvent(new Event('change'));
    expect($('count').textContent).toBe('1 / 1 行');
    mount('table-filter', []);
    await flush();
    expect($('out').textContent).toContain('このノートに表がありません');
  });
});

describe('作業タイマー', () => {
  it('🔴 開始で減り、一時停止で setInterval を解く(止まっている間は何も動かない)', () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(window, 'clearInterval');
    mount('pomodoro');
    expect($('clock').textContent).toBe('25:00');
    $('start').click();
    expect($('start').textContent).toBe('一時停止');
    vi.advanceTimersByTime(61_000);
    expect($('clock').textContent).toBe('23:59');
    $('start').click();
    expect(clear).toHaveBeenCalled();
    expect(vi.getTimerCount(), '止めたのにタイマーが残っている').toBe(0);
    vi.advanceTimersByTime(120_000);
    expect($('clock').textContent).toBe('23:59');
  });

  it('🔴 作業が終わると回数が 1 増えて保存され、休憩に切り替わる', () => {
    vi.useFakeTimers();
    mount('pomodoro');
    const w = $('work') as HTMLInputElement;
    w.value = '1';
    w.dispatchEvent(new Event('change'));
    $('start').click();
    vi.advanceTimersByTime(61_000);
    expect($('mode').textContent).toBe('休憩');
    expect($('sets').textContent).toBe('完了 1 回');
    expect(window.localStorage.getItem('sets')).toBe('1');
    expect(vi.getTimerCount()).toBe(0);
    expect($('clock').textContent).toBe('05:00');
  });
});
