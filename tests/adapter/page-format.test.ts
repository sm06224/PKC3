/** @vitest-environment happy-dom */
/**
 * 紙面フォーマットの**保存と適用・配線**(2026-08-08。user 裁定)。
 *
 * ここで守るのは 5 つ:
 * ① 起動時の適用は**保存しない**(`theme.ts` の M-7 の再発を止める)
 * ② 壊れた保存値・保存できない環境でも**落ちない**(既定へ)
 * ③ 紙の指定(`@page`)は**載せ替わる** ── 画面用へ戻したら**消える**
 * ④ 設定画面の選択欄が**いまの値を映す**(組み立て直後と、組み済みの両方)
 * ⑤ 選択欄 → binder → 実体 の配線が繋がっている(無言の dead click を作らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyPageFormat,
  choosePageFormat,
  currentPageFormat,
  initialPageFormat,
} from '../../src/adapter/ui/render/page-format';
import { PAGE_FORMATS } from '../../src/features/page-format';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

const KEY = 'pkc3.page-format';
const ATTR = 'data-pkc-page-format';

const html = (): HTMLElement => document.documentElement;
const paperStyle = (): HTMLStyleElement | null =>
  document.querySelector("style[data-pkc-field='page-paper']");

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute(ATTR);
  paperStyle()?.remove();
});

describe('紙面フォーマット(保存と適用)', () => {
  it('🔴 起動時の適用は **保存しない**', () => {
    applyPageFormat(html(), 'a3-landscape');
    expect(html().getAttribute(ATTR)).toBe('a3-landscape');
    // ⚠ ここが保存されると、一度も選んでいないのに固定される(theme の M-7)
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('🔴 user が選んだときだけ保存し、次の起動で戻ってくる', () => {
    choosePageFormat(html(), 'fullhd');
    expect(html().getAttribute(ATTR)).toBe('fullhd');
    expect(localStorage.getItem(KEY)).toBe('fullhd');
    expect(initialPageFormat()).toBe('fullhd');
  });

  it('保存が無い / 壊れていれば既定(A4 縦)', () => {
    expect(initialPageFormat()).toBe('a4-portrait');
    localStorage.setItem(KEY, 'a4'); // 昔の綴り・打ち間違い
    expect(initialPageFormat()).toBe('a4-portrait');
  });

  it('保存できない環境でも落ちない(既定で動く)', () => {
    // ⚠ グローバルを丸ごと差し替えない ── 必要なメソッドだけ投げさせる
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('私的モード');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('私的モード');
    });
    try {
      expect(initialPageFormat()).toBe('a4-portrait');
      expect(() => choosePageFormat(html(), '43')).not.toThrow();
      // この session では効いている(= 画面は user の選択に従う)
      expect(currentPageFormat(html())).toBe('43');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('いま当たっている値は **DOM が正本**(保存を読み直さない)', () => {
    localStorage.setItem(KEY, 'a3-portrait');
    applyPageFormat(html(), 'fullhd');
    expect(currentPageFormat(html())).toBe('fullhd');
    html().setAttribute(ATTR, 'でたらめ');
    expect(currentPageFormat(html()), '知らない値で既定へ落ちない').toBe('a4-portrait');
  });

  /**
   * 🔴 **紙の指定は載せ替える**。`@page` はセレクタで絞れないので、属性の切替では
   * 出し分けられない ── 画面用へ戻したときに**消えない**と、前に選んでいた紙が
   * 効いたまま印刷される(user から見れば「A3 を選んだ覚えは無いのに A3 で出る」)。
   */
  it('🔴 @page が載り、画面用へ戻すと消える', () => {
    applyPageFormat(html(), 'a3-landscape');
    expect(paperStyle()?.textContent).toBe('@page{size:A3 landscape}');
    applyPageFormat(html(), 'a4-portrait');
    expect(paperStyle()?.textContent).toBe('@page{size:A4 portrait}');
    applyPageFormat(html(), 'fullhd');
    expect(paperStyle(), '画面用にしたのに紙の指定が残っている').toBeNull();
  });

  it('⚠ 何度当てても `<style>` は 1 個しか増えない', () => {
    for (const f of ['a4-portrait', 'a3-portrait', 'a4-landscape'] as const) {
      applyPageFormat(html(), f);
    }
    expect(document.querySelectorAll("style[data-pkc-field='page-paper']").length).toBe(1);
  });
});

describe('紙面フォーマット(設定画面と配線)', () => {
  function pane(): { region: HTMLElement; settings: SettingsRenderer } {
    const region = document.createElement('div');
    document.body.append(region);
    // ⚠ 監視器は自分で `new` して渡す(共有の 1 個を汚さない)
    const settings = new SettingsRenderer(region, new JobMonitor());
    return { region, settings };
  }

  it('選択肢が表と 1 対 1(選べない形式・在らない形式を作らない)', () => {
    const { region, settings } = pane();
    settings.render(initialState);
    const opts = [
      ...region.querySelectorAll<HTMLOptionElement>(
        '[data-pkc-field="page-format-select"] option',
      ),
    ];
    expect(opts.map((o) => o.value)).toEqual(PAGE_FORMATS.map((f) => f.id));
    expect(opts.map((o) => o.textContent)).toEqual(PAGE_FORMATS.map((f) => f.label));
  });

  /**
   * 🔴 **組み立てのときも映す。** 器は 1 度しか組まないので、起動時に保存から
   * 復元した値をここで映さないと、選択欄は既定のまま = **画面が嘘をつく**
   * (「設定したのに戻っている」と読まれる)。
   */
  it('🔴 組み立て直後の選択欄が、いま当たっている値を映す', () => {
    applyPageFormat(html(), 'a3-portrait');
    const { region, settings } = pane();
    settings.render(initialState);
    const select = region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="page-format-select"]',
    );
    expect(select?.value).toBe('a3-portrait');
  });

  /**
   * 🔴 **組み済みの分岐でも映す。** 別の面へ行って戻ってくる経路はこちらを通る
   * (CLAUDE.md「設定画面の値の同期」で実際に踏んだ穴)。
   */
  it('🔴 面を出し直したときも、いまの値に合わせ直す', () => {
    const { region, settings } = pane();
    settings.render(initialState);
    applyPageFormat(html(), '43-portrait'); // 画面を見ていない間に変わった
    settings.render(initialState);
    const select = region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="page-format-select"]',
    );
    expect(select?.value).toBe('43-portrait');
  });

  it('🔴 選択欄 → binder → 実体 が繋がっている(押して無言にならない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const setPageFormat = vi.fn();
    const dispatcher = { getState: () => initialState, dispatch: () => {} };
    bindActions(root, dispatcher as never, { setPageFormat });
    const select = document.createElement('select');
    select.setAttribute('data-pkc-action', 'set-page-format');
    const opt = document.createElement('option');
    opt.value = 'a4-landscape';
    select.append(opt);
    root.append(select);
    select.value = 'a4-landscape';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setPageFormat).toHaveBeenCalledWith('a4-landscape');
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(CLAUDE.md「どの test からも実行され
 * ない file に判断を書かない」)。ここが見るのは **3 本の配線**である ──
 * ① 起動時に当てる ② user が選んだら保存する ③ 書き出しへ**いまの値**を渡す。
 * ⚠ 弱い pin だと自覚して使う(綴りが合っていることしか見ていない)。
 */
describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf8');

  it('起動時に当てる(保存はしない)', () => {
    expect(MAIN).toContain('applyPageFormat(document.documentElement, initialPageFormat())');
    expect(MAIN, '起動時に保存している(theme の M-7 の再発)').not.toContain(
      'choosePageFormat(document.documentElement, initialPageFormat())',
    );
  });

  it('user が選んだら保存する経路が在る', () => {
    expect(MAIN).toContain('setPageFormat:');
    expect(MAIN).toContain('choosePageFormat(document.documentElement, format)');
  });

  it('🔴 書き出しへ **いま当たっている値**を渡す(保存を読み直さない)', () => {
    expect(MAIN).toContain('pageFormat: currentPageFormat(document.documentElement)');
    expect(MAIN, '書き出しが保存を読み直している(画面と食い違う)').not.toContain(
      'pageFormat: initialPageFormat()',
    );
  });
});
