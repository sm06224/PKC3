/** @vitest-environment happy-dom */
/**
 * 本文の置き場所の**保存と適用・配線**(#722、2026-09-08)。
 *
 * ここで守るのは 5 つ(`page-format.test.ts` と同じ形):
 * ① 起動時の適用は**保存しない**(`theme.ts` の M-7 の再発を止める)
 * ② 壊れた保存値・保存できない環境でも**落ちない**(既定へ)
 * ③ 設定画面の選択欄が**いまの値を映す**(組み立て直後と、組み済みの両方)
 * ④ 選択欄 → binder → 実体 の配線が繋がっている(無言の dead click を作らない)
 * ⑤ `main.ts` の 3 本の配線(起動時に当てる / 選んだら保存 / 書き出しへ渡す)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyProseAlign,
  chooseProseAlign,
  currentProseAlign,
  initialProseAlign,
} from '../../src/adapter/ui/render/prose-align';
import { PROSE_ALIGNS } from '../../src/features/prose-align';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

const KEY = 'pkc3.prose-align';
const ATTR = 'data-pkc-prose-align';

const html = (): HTMLElement => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute(ATTR);
});

describe('本文の置き場所(保存と適用)', () => {
  it('🔴 起動時の適用は **保存しない**', () => {
    applyProseAlign(html(), 'start');
    expect(html().getAttribute(ATTR)).toBe('start');
    // ⚠ ここが保存されると、一度も選んでいないのに固定される(theme の M-7)
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('🔴 user が選んだときだけ保存し、次の起動で戻ってくる', () => {
    chooseProseAlign(html(), 'start');
    expect(html().getAttribute(ATTR)).toBe('start');
    expect(localStorage.getItem(KEY)).toBe('start');
    expect(initialProseAlign()).toBe('start');
  });

  it('保存が無い / 壊れていれば既定(中央)', () => {
    expect(initialProseAlign()).toBe('center');
    localStorage.setItem(KEY, 'right'); // 打ち間違い・昔の綴り
    expect(initialProseAlign()).toBe('center');
  });

  it('保存できない環境でも落ちない(既定で動く)', () => {
    // ⚠ グローバルを丸ごと差し替えない ── 必要なメソッドだけ投げさせる
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('私的モード');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('私的モード');
    });
    expect(initialProseAlign()).toBe('center');
    expect(() => chooseProseAlign(html(), 'start')).not.toThrow();
    // 🔑 保存できなくても、この session では効いている
    expect(html().getAttribute(ATTR)).toBe('start');
    get.mockRestore();
    set.mockRestore();
  });

  it('🔴 いまの値は **DOM が正本**(保存を読み直さない)', () => {
    localStorage.setItem(KEY, 'start');
    applyProseAlign(html(), 'center');
    // ⚠ 保存を読むと「画面は中央なのに設定欄は左」になる
    expect(currentProseAlign(html())).toBe('center');
  });

  it('⚠ 印が無い / 知らない値なら既定として読む', () => {
    expect(currentProseAlign(html())).toBe('center');
    html().setAttribute(ATTR, 'right');
    expect(currentProseAlign(html())).toBe('center');
  });
});

describe('設定画面との配線(#722)', () => {
  it('🔴 選択欄が **いまの値を映す**(組み済みの器でも)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    applyProseAlign(html(), 'start');
    const settings = new SettingsRenderer(root, new JobMonitor());
    // ① 組み立て直後
    settings.render(initialState);
    const select = (): HTMLSelectElement | null =>
      root.querySelector<HTMLSelectElement>('[data-pkc-field="prose-align-select"]');
    expect(select(), '設定画面に置き場所の選択欄が無い').not.toBeNull();
    expect(select()!.value, '組み立て直後に古い値が出ている').toBe('start');
    // ② 器は 1 度しか組まない ── 2 回目の render でも映す
    applyProseAlign(html(), 'center');
    settings.render(initialState);
    expect(select()!.value, '組み済みの器へ映していない(古い値が見える)').toBe('center');
    root.remove();
  });

  it('🔴 選べる値が表と 1 対 1(選べるのに効かない / 効くのに選べないを作らない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    new SettingsRenderer(root, new JobMonitor()).render(initialState);
    const opts = [
      ...root.querySelectorAll<HTMLOptionElement>(
        '[data-pkc-field="prose-align-select"] option',
      ),
    ].map((o) => o.value);
    expect(opts).toEqual(PROSE_ALIGNS.map((a) => a.id));
    root.remove();
  });

  it('🔴 選択欄 → binder → 実体 が繋がっている(押して無言にならない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const setProseAlign = vi.fn();
    const dispatcher = { getState: () => initialState, dispatch: () => {} };
    bindActions(root, dispatcher as never, { setProseAlign });
    // 本物の設定画面を binder の配下に組む(合成しない)
    const settings = new SettingsRenderer(root, new JobMonitor());
    settings.render(initialState);
    const select = root.querySelector<HTMLSelectElement>(
      '[data-pkc-field="prose-align-select"]',
    );
    expect(select, '設定画面に置き場所の選択欄が無い').not.toBeNull();
    select!.value = 'start';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setProseAlign).toHaveBeenCalledWith('start');
    root.remove();
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(CLAUDE.md「どの test からも実行され
 * ない file に判断を書かない」)。⚠ 弱い pin だと自覚して使う。
 */
describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf8');

  it('起動時に当てる(保存はしない)', () => {
    expect(MAIN).toContain('applyProseAlign(document.documentElement, initialProseAlign())');
    expect(MAIN, '起動時に保存している(theme の M-7 の再発)').not.toContain(
      'chooseProseAlign(document.documentElement, initialProseAlign())',
    );
  });

  it('user が選んだら保存する', () => {
    expect(MAIN).toContain('chooseProseAlign(document.documentElement, align)');
  });

  it('🔴 書き出しへ **いまの値** を渡す(保存を読み直さない)', () => {
    expect(MAIN).toContain('proseAlign: currentProseAlign(document.documentElement)');
    expect(MAIN, '書き出しが保存を読み直している').not.toContain(
      'proseAlign: initialProseAlign()',
    );
  });
});
