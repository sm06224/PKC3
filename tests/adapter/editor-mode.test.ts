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
 * 🔴 **`main.ts` は原文でしか pin できない**(弱いと自覚して使う)。
 * user が選んだら保存へ渡す配線が居ることだけを見る。
 */
describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf8');

  it('設定の変更が appEditorMode.setMode へ届く', () => {
    expect(MAIN).toContain('appEditorMode.setMode(mode)');
  });
});
