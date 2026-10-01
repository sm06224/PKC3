/** @vitest-environment happy-dom */
/**
 * 🔴 **探した語を候補に出す配線**(#1172)。
 *
 * ⚠ 規則(`search-log`)と置き場(`search-history-store`)は別の test が見る ──
 *   ここで見るのは**その間**:欄で確定したら憶えるか / 候補の `<datalist>` に載るか /
 *   設定の口で消えるか(CLAUDE.md §7「A と B が合意していることは…」)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { appSearchHistory } from '../../src/adapter/platform/search-history-store';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { initialState } from '../../src/adapter/state/app-state';

function setup(): { root: HTMLElement; input: HTMLInputElement; options: () => string[] } {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  bindActions(root, new Dispatcher());
  const input = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
  const options = () =>
    [...root.querySelectorAll<HTMLOptionElement>('datalist#pkc-search-history option')].map(
      (o) => o.value,
    );
  return { root, input, options };
}

describe('探した語の候補(#1172)', () => {
  beforeEach(() => {
    appSearchHistory.clear();
    document.body.textContent = '';
  });

  it('🔴 欄は候補の `<datalist>` に繋がっている', () => {
    const { input, root } = setup();
    const id = input.getAttribute('list');
    expect(id).toBe('pkc-search-history');
    expect(root.querySelector(`datalist#${id}`), 'list の指す先が無い').not.toBeNull();
  });

  it('🔴 確定(change)すると憶え、候補に載る', () => {
    const { input, options } = setup();
    expect(options()).toEqual([]);
    input.value = '会議メモ';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(appSearchHistory.list()).toEqual(['会議メモ']);
    expect(options(), '候補が入れ直されていない').toEqual(['会議メモ']);
  });

  /** ⚠ 1 字ごとに憶えない ── 打っている途中の語が全部並ぶ。 */
  it('🔴 打っている途中(input)では憶えない', () => {
    const { input, options } = setup();
    for (const v of ['会議', '会議メ', '会議メモ']) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(appSearchHistory.list(), '打鍵ごとに憶えている').toEqual([]);
    expect(options()).toEqual([]);
  });

  it('🔴 1 字・空では憶えない', () => {
    const { input, options } = setup();
    for (const v of ['', 'a']) {
      input.value = v;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(options()).toEqual([]);
  });

  it('組み直した殻は、憶えている語を最初から候補に出す(再起動後)', () => {
    appSearchHistory.push('前の日');
    const { options } = setup();
    expect(options()).toEqual(['前の日']);
  });

  it('🔴 設定の「検索した語の記録を消す」で、保存も候補も空になり、字で言う', () => {
    const { root, input, options } = setup();
    input.value = '会議メモ';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(options()).toHaveLength(1);

    const said: string[] = [];
    bindActions(root, new Dispatcher(), { showStatus: (t) => said.push(t) });
    // ⚠ 設定は**別の器**へ描く ── 同じ root へ描くと殻ごと消え、候補の検査が空振りする
    //   (`options()` が殻の消えた後の 0 件で満たされる。変異試験 f が教えた)
    const host = document.createElement('div');
    root.append(host);
    new SettingsRenderer(host, new JobMonitor()).render(initialState);
    expect(options(), '前提が崩れている(設定を描いたら候補が見えなくなった)').toEqual(['会議メモ']);
    const btn = root.querySelector<HTMLButtonElement>('[data-pkc-action="clear-search-history"]');
    expect(btn, '設定に「検索した語の記録を消す」が無い').not.toBeNull();
    expect(btn!.textContent).toBe('検索した語の記録を消す');
    btn!.click();

    expect(appSearchHistory.list(), '押したのに保存が残っている').toEqual([]);
    expect(options(), '候補にまだ古い語が載っている').toEqual([]);
    expect(said.join('')).toContain('消しました');
  });
});
