/** @vitest-environment happy-dom */
/**
 * 🔴 **検索と設定の手数 4 点**(#1650。Gemini 裁定 = #1163 の依頼 42 の 1A / 2A / 3B / 4A)。
 *
 * 1. 「アプリ」「予定」で絞りが 0 件の原因のとき、「絞りを外す」を出す(フォルダの一覧と同じ)
 * 2. 左の検索欄の Esc は、打った字を消す(吹き出しどおり。ブラウザの標準の動きに頼らない)
 * 3. 読み幅・本文の置き場所・段組みを変えたら、効いたことを画面の下に言う
 * 4. 配色・ページ設定・文字の大きさなど 7 項目は、最初の値の選択肢に「(既定)」を付ける
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { initialState } from '../../src/adapter/state/app-state';
import { choiceRowValues } from '../helpers/choice-row';
import { markDefault, plainChoiceLabel } from '../../src/adapter/ui/render/settings/default-mark';

const unbinds: Array<() => void> = [];
afterEach(() => {
  document.body.innerHTML = '';
  for (const off of unbinds) off();
  unbinds.length = 0;
});

const field = (root: ParentNode, f: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-pkc-field="${f}"]`);

describe('① 「アプリ」「予定」の 0 件に「絞りを外す」', () => {
  function mountLauncher() {
    const root = document.createElement('div');
    document.body.append(root);
    const region = document.createElement('div');
    root.append(region);
    const r = new LauncherRenderer(region);
    const d = new Dispatcher();
    unbinds.push(bindActions(root, d));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: [] });
    return { region, d, r };
  }

  it('アプリ: 語で 0 件になると、ボタンが出て、押すと語が空になる', () => {
    const { region, d, r } = mountLauncher();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zzzz-no-such' });
    r.render(d.getState());
    expect(field(region, 'launcher-empty'), '前提: 0 件の字が出ていない').toBeTruthy();
    const btn = field(region, 'launcher-clear-filter') as HTMLButtonElement | null;
    expect(btn?.textContent).toBe('絞りを外す');
    btn!.click();
    expect(d.getState().filterQuery).toBe('');
    r.render(d.getState());
    // 対照群: 絞りを外した後はボタンも 0 件の字も出ない
    expect(field(region, 'launcher-clear-filter')).toBeNull();
    expect(field(region, 'launcher-empty')).toBeNull();
  });

  function mountSchedule() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const host = document.createElement('div');
    host.setAttribute('data-pkc-browse-pane', 'schedule');
    regions.browseHost.append(host);
    const view = new ScheduleRenderer(host, () => new Date(2026, 7, 23));
    d.onState((s) => view.render(s));
    unbinds.push(bindActions(root, d));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    return { host, d };
  }

  it('予定: 語で何も出ないときだけボタンが出て、押すと語が空になる', () => {
    const { host, d } = mountSchedule();
    const btn = () => field(host, 'schedule-clear-filter') as HTMLButtonElement;
    expect(btn(), '前提: ボタンの器が無い').toBeTruthy();
    // 対照群: 絞りが無いときは、予定が 0 件でも出さない(押しても何も起きない dead click を作らない)
    expect(btn().hidden, '絞りが無いのに出ている').toBe(true);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zzzz-no-such' });
    expect(btn().hidden, '語で 0 件なのにボタンが出ていない').toBe(false);
    expect(btn().textContent).toBe('絞りを外す');
    btn().click();
    expect(d.getState().filterQuery).toBe('');
    expect(btn().hidden, '外した後もボタンが残っている').toBe(true);
  });

  it('予定: 種類の札だけで 0 件のときも出て、押すと札が外れる', () => {
    const { host, d } = mountSchedule();
    d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'todo' });
    expect(d.getState().kindFilter.size, '前提: 札が立っていない').toBeGreaterThan(0);
    const btn = field(host, 'schedule-clear-filter') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(d.getState().kindFilter.size).toBe(0);
  });
});

describe('② 左の検索欄の Esc', () => {
  function mountShell() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    unbinds.push(bindActions(root, d));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    return { d, input };
  }
  const esc = (el: HTMLElement): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

  it('字があるとき: 欄も state も空になる(標準の動きに頼らない)', () => {
    const { d, input } = mountShell();
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(d.getState().filterQuery, '前提: 打った字が state に届いていない').toBe('abc');
    const ev = esc(input);
    expect(input.value).toBe('');
    expect(d.getState().filterQuery).toBe('');
    // 標準の動きと二重に走らせない
    expect(ev.defaultPrevented).toBe(true);
  });

  it('「>」で操作を探しているときも消える', () => {
    const { d, input } = mountShell();
    input.value = '>書き出';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    esc(input);
    expect(input.value).toBe('');
    expect(d.getState().filterQuery).toBe('');
  });

  it('変換中の Esc は握らない(変換の取り消しに譲る)', () => {
    const { d, input } = mountShell();
    input.value = 'あ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }),
    );
    expect(input.value).toBe('あ');
    expect(d.getState().filterQuery).toBe('あ');
  });
});

describe('③ 読み幅・置き場所・段組みを変えたら、効いたことを言う', () => {
  function mountSettings() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const said: string[] = [];
    const set: string[] = [];
    const services: BinderServices = {
      showStatus: (t) => {
        said.push(t);
      },
      setPageFormat: (f) => {
        set.push(f);
      },
      setProseAlign: (a) => {
        set.push(a);
      },
    };
    unbinds.push(bindActions(root, d, services));
    new SettingsRenderer(root).render(initialState);
    return { root, said, set };
  }

  it('ページ設定(読み幅)', () => {
    const { root, said, set } = mountSettings();
    const sel = field(root, 'page-format-select') as HTMLSelectElement;
    sel.value = 'a4-landscape';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(set).toEqual(['a4-landscape']);
    expect(said).toEqual(['読み幅を「A4 横」にしました']);
  });

  it('本文の置き場所(「(既定)」は知らせに持ち込まない)', () => {
    const { root, said } = mountSettings();
    const btn = root.querySelector<HTMLElement>('[data-pkc-prose-align-value="center"]')!;
    btn.click();
    expect(said).toEqual(['本文の置き場所を「中央」にしました']);
  });

  it('本文の段組み', () => {
    const { root, said } = mountSettings();
    root.querySelector<HTMLElement>('[data-pkc-read-columns-value="2"]')!.click();
    expect(said).toEqual(['本文の段組みを「2 段」にしました']);
    root.querySelector<HTMLElement>('[data-pkc-read-columns-value="1"]')!.click();
    expect(said[1]).toBe('本文の段組みを「1 段」にしました');
  });
});

describe('④ 最初の値の選択肢に「(既定)」', () => {
  const host = (): HTMLElement => {
    const h = document.createElement('div');
    new SettingsRenderer(h).render(initialState);
    return h;
  };
  const optionLabels = (h: HTMLElement, f: string): string[] =>
    Array.from((field(h, f) as HTMLSelectElement).options).map((o) => o.textContent ?? '');

  it('ボタンの列の 3 項目(文字の大きさ・保管件数・外部の画像)', () => {
    const h = host();
    const marked = (f: string, attr: string): string[] =>
      choiceRowValues(h, f, attr).filter((c) => c.label.includes('(既定)')).map((c) => c.label);
    expect(marked('text-scale-select', 'data-pkc-text-scale-value')).toEqual(['標準(既定)']);
    expect(marked('messages-cap-select', 'data-pkc-message-cap-value')).toEqual(['500 件(既定)']);
    expect(marked('external-images-select', 'data-pkc-external-images-value')).toEqual(['常に確認(既定)']);
  });

  it('プルダウンの 4 項目(配色・ページ設定・編集の仕方・貼り付け)', () => {
    const h = host();
    const one = (f: string): string[] => optionLabels(h, f).filter((l) => l.includes('(既定)'));
    expect(one('theme-select')).toEqual(['OS に合わせる(既定)']);
    expect(one('page-format-select')).toEqual(['A4 縦(既定)']);
    expect(one('editor-mode-select')).toEqual(['1 画面で編集(ライブ)(既定)']);
    expect(one('paste-source-select')).toEqual(['自動(既定)']);
  });

  it('すでに「(既定)」と名乗っている項目には重ねない', () => {
    const out = markDefault([{ id: 'a', label: '中央(既定)' }, { id: 'b', label: '左' }], 'a');
    expect(out.map((c) => c.label)).toEqual(['中央(既定)', '左']);
    expect(plainChoiceLabel('バッジ(既定・薄い灰色の下地)')).toBe('バッジ');
    expect(plainChoiceLabel('A4 縦(既定)')).toBe('A4 縦');
    expect(plainChoiceLabel('A4 横')).toBe('A4 横');
  });
});
