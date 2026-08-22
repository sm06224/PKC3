/** @vitest-environment happy-dom */
/**
 * 編集の仕方(#104 第 2 弾。user 裁定 2026-08-08「既定でONかつ設定で
 * 2ペイン編集はできるようにする」)── 保存・既定・設定 UI・binder の配線。
 * 手本: tests/adapter/page-format.test.ts(同じ「正規設定」の型)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_EDITOR_MODE, EDITOR_MODES, isEditorMode } from '../../src/features/editor-mode';
import { EditorModeStore } from '../../src/adapter/ui/render/editor-mode';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

beforeEach(() => {
  document.body.textContent = '';
  localStorage.removeItem('pkc3.editor-mode');
});

describe('意味論(features/editor-mode)', () => {
  it('🔴 既定は live(user 裁定「既定でON」── 入れ替わると全 user に効く)', () => {
    expect(DEFAULT_EDITOR_MODE).toBe('live');
  });

  it('一覧は live と split の 2 つ(2 ペインは廃止されていない)', () => {
    expect(EDITOR_MODES.map((m) => m.id)).toEqual(['live', 'split']);
  });

  it('引き当てられない値を弾く', () => {
    expect(isEditorMode('live')).toBe(true);
    expect(isEditorMode('split')).toBe(true);
    expect(isEditorMode('editor.live')).toBe(false);
    expect(isEditorMode('')).toBe(false);
  });
});

describe('保存(EditorModeStore)', () => {
  it('保存が無ければ既定(live)', () => {
    expect(new EditorModeStore().getMode()).toBe('live');
  });

  it('set → get が往復し、localStorage に残る', () => {
    const s = new EditorModeStore();
    expect(s.setMode('split')).toBe(true);
    expect(s.getMode()).toBe('split');
    expect(localStorage.getItem('pkc3.editor-mode')).toBe('split');
    // 同じ値をもう一度 → 変わらない
    expect(s.setMode('split')).toBe(false);
  });

  it('⚠ 壊れた値は既定(live)へ落ちる(壊れた設定で編集不能にしない)', () => {
    localStorage.setItem('pkc3.editor-mode', 'kaboom');
    expect(new EditorModeStore().getMode()).toBe('live');
    // 壊れた値の保存も弾く
    expect(new EditorModeStore().setMode('kaboom')).toBe(false);
  });

  it('⚠ 保存が読めない環境でも落ちず、この session では効く(fallback)', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const s = new EditorModeStore(broken);
    expect(s.getMode()).toBe('live');
    expect(s.setMode('split')).toBe(true);
    expect(s.getMode()).toBe('split'); // fallback が持つ
  });

  it('🔑 読むたびに保存を見る(外からの書込が再読込なしで効く ── bench の腕切替)', () => {
    const s = new EditorModeStore();
    expect(s.getMode()).toBe('live');
    localStorage.setItem('pkc3.editor-mode', 'split'); // store を介さない書込
    expect(s.getMode()).toBe('split');
  });
});

describe('設定 UI(本物の SettingsRenderer)', () => {
  function pane() {
    const region = document.createElement('div');
    document.body.append(region);
    const settings = new SettingsRenderer(region, new JobMonitor());
    return { region, settings };
  }

  it('選択肢が EDITOR_MODES と一致する(id も label も)', () => {
    const { region, settings } = pane();
    settings.render(initialState);
    const opts = [
      ...region.querySelectorAll<HTMLOptionElement>('[data-pkc-field="editor-mode-select"] option'),
    ];
    expect(opts.map((o) => o.value)).toEqual(EDITOR_MODES.map((m) => m.id));
    expect(opts.map((o) => o.textContent)).toEqual(EDITOR_MODES.map((m) => m.label));
  });

  it('🔴 組み立て直後の選択欄が、いまの設定を映す', () => {
    localStorage.setItem('pkc3.editor-mode', 'split');
    const { region, settings } = pane();
    settings.render(initialState);
    const select = region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="editor-mode-select"]',
    );
    expect(select?.value).toBe('split');
  });

  it('🔴 面を出し直したときも、いまの値に合わせ直す(CLAUDE.md §7「設定画面の値の同期」)', () => {
    const { region, settings } = pane();
    settings.render(initialState);
    localStorage.setItem('pkc3.editor-mode', 'split'); // 画面を見ていない間に変わった
    settings.render(initialState);
    const select = region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="editor-mode-select"]',
    );
    expect(select?.value).toBe('split');
  });

  /**
   * ⚠ **合成した `<select>` を押さない**(page-format.test.ts と同じ理由)──
   * 本物の設定画面が action を付け忘れても緑になる形を作らない。
   */
  /**
   * 🔴 **2 ペインの原文欄に打った字は、文書の情報ごと state へ届く**(#304、2026-08-22)。
   *
   * #304 は「2 ペインには札が出ない = 動線が 1 つ消えている」と読んで、札を
   * split 側にも描く案を推薦していた。⚠ **その前提が実装と食い違っていた** ──
   * 原文欄には frontmatter がそのまま入っており、その場で書き替えられる。
   * ⇒ 札は足さず、マニュアルを両モードで正確に書く側へ倒した。
   *
   * 🔑 その判断が立つのは「**書き替えが保存まで届く**」が真である間だけである。
   *   ⚠ 画面に出ているだけでは足りない ── 届かなければ
   *   「見えているのに保存されない」という、いちばん気づけない形になる。
   * ⚠ この配線を見ている test は **1 件も無かった**。
   */
  it('🔴 2 ペインの原文欄の字は、文書の情報ごと state へ届く (#304)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const sent: unknown[] = [];
    const dispatcher = { getState: () => initialState, dispatch: (a: unknown) => sent.push(a) };
    bindActions(root, dispatcher as never);
    // 2 ペインの原文欄と同じ印を持つ欄を置く(binder は**欄の名前**で見る)
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    root.append(ta);
    ta.value = '---\ntags: [家事]\n---\n本文です\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent, '原文欄に打っても state へ届かない').toEqual([
      { type: 'UPDATE_OPEN_BODY', body: '---\ntags: [家事]\n---\n本文です\n' },
    ]);
  });

  it('🔴 選択欄 → binder → 実体 が繋がっている(押して無言にならない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const setEditorMode = vi.fn();
    const dispatcher = { getState: () => initialState, dispatch: () => {} };
    bindActions(root, dispatcher as never, { setEditorMode });
    const settings = new SettingsRenderer(root, new JobMonitor());
    settings.render(initialState);
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="editor-mode-select"]');
    expect(select, '設定画面に編集の仕方の選択欄が無い').not.toBeNull();
    select!.value = 'split';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setEditorMode).toHaveBeenCalledWith('split');
  });
});

/**
 * 🔴 **「開いたら編集に入る」**(user 裁定 2026-08-18
 * 「**Enter は閲覧を開始、インライン編集で常に開くは設定でトグル可能にすること**」)。
 * ⚠ 「編集の仕方」の隣に置いた設定なので、同じ file で守る。
 */
describe('開いたときの状態(user 裁定 2026-08-18)', () => {
  it('既定は入っていない(押しただけで編集に入らない)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    new SettingsRenderer(region, new JobMonitor()).render(initialState);
    const box = region.querySelector<HTMLInputElement>('[data-pkc-field="open-in-edit"]');
    expect(box, '設定画面にトグルが無い').not.toBeNull();
    expect(box!.checked, '既定で編集に入る側になっている').toBe(false);
  });

  it('🔴 面を出し直したときも、いまの値に合わせ直す(CLAUDE.md §7)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const settings = new SettingsRenderer(region, new JobMonitor());
    settings.render(initialState);
    localStorage.setItem('pkc3.open-in-edit', '1'); // 画面を見ていない間に変わった
    settings.render(initialState);
    expect(
      region.querySelector<HTMLInputElement>('[data-pkc-field="open-in-edit"]')?.checked,
      '古い値のまま見えている',
    ).toBe(true);
  });

  it('🔴 組み立て直後の値も、いまの設定を映す', () => {
    // ⚠ 上と**別の経路**である(器を組んだ直後 / 組み済みの分岐)── 実際に
    //   組み直後だけ呼び忘れて、1 稿目は「設定したのに戻っている」状態だった
    localStorage.setItem('pkc3.open-in-edit', '1');
    const region = document.createElement('div');
    document.body.append(region);
    new SettingsRenderer(region, new JobMonitor()).render(initialState);
    expect(
      region.querySelector<HTMLInputElement>('[data-pkc-field="open-in-edit"]')?.checked,
    ).toBe(true);
  });

  it('🔴 トグル → binder → 実体 が繋がっている(押して無言にならない)', () => {
    // ⚠ **合成した checkbox を押さない** ── 本物の設定画面が action を付け忘れても
    //   緑になる形を作らない(上の編集の仕方と同じ理由)
    localStorage.removeItem('pkc3.open-in-edit');
    const root = document.createElement('div');
    document.body.append(root);
    const setOpenInEdit = vi.fn();
    const dispatcher = { getState: () => initialState, dispatch: () => {} };
    bindActions(root, dispatcher as never, { setOpenInEdit });
    new SettingsRenderer(root, new JobMonitor()).render(initialState);
    const box = root.querySelector<HTMLInputElement>('[data-pkc-field="open-in-edit"]');
    expect(box, '設定画面にトグルが無い').not.toBeNull();
    /**
     * ⚠ checkbox の action は **`onClick` が拾う**(`<select>` の `change` とは
     * 別経路 ── 合成 `change` では 1 度も通らない)。
     * ⚠ **押す前の値を確かめてから押す** ── この file の別の test が
     *   `localStorage` に `'1'` を残すので、前提を書かないと**反転した値**が
     *   渡ったのを「届いていない」と読み違える(1 稿目で実際にやった)。
     */
    expect(box!.checked, '押す前から入っている(前提が崩れている)').toBe(false);
    box!.click(); // click が `checked` を反転させる → true
    expect(setOpenInEdit).toHaveBeenCalledWith(true);
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(弱いと自覚して使う)。
 * user が選んだら保存へ渡す配線が居ることだけを見る。
 */
describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf8');

  it('設定の変更が appEditorMode.setMode へ届く', () => {
    expect(MAIN).toContain('appEditorMode.setMode(mode)');
  });

  it('「開いたら編集に入る」の変更が appOpenInEdit.setEnabled へ届く', () => {
    expect(MAIN).toContain('appOpenInEdit.setEnabled(on)');
  });
});
