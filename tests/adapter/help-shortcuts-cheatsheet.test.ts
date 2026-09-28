/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpRenderer } from '../../src/adapter/ui/render/help';
import { CONTEXT_LABELS, CONTEXT_ORDER } from '../../src/features/keymap';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe('ヘルプ面のキーボードショートカット一覧（チートシート）(#1145)', () => {
  let region: HTMLElement;
  let store: KeymapStore;

  beforeEach(() => {
    document.body.innerHTML = '';
    region = document.createElement('div');
    region.setAttribute('data-pkc-region', 'help');
    document.body.append(region);
    store = new KeymapStore(fakeStorage());
  });

  it('🔴 文脈(カテゴリ)ごとにグループ化された見出しが出力される', () => {
    const renderer = new HelpRenderer(region, undefined, undefined, store);
    renderer.render();

    const keymapRegion = region.querySelector('[data-pkc-region="help-keymap"]');
    expect(keymapRegion, 'help-keymap が存在しない').not.toBeNull();

    const groups = [...keymapRegion!.querySelectorAll('[data-pkc-field="help-key-group"]')];
    expect(groups.length, 'グループ見出しが複数存在する').toBeGreaterThanOrEqual(5);

    // グループ見出しのテキストが CONTEXT_LABELS の値を含んでいる
    const groupTexts = groups.map((g) => g.textContent);
    expect(groupTexts).toContain(CONTEXT_LABELS.global);
    expect(groupTexts).toContain(CONTEXT_LABELS.editor);
    expect(groupTexts).toContain(CONTEXT_LABELS.filer);

    // 並び順が CONTEXT_ORDER に従っている
    const firstGroupText = groups[0]!.textContent;
    expect(firstGroupText).toBe(CONTEXT_LABELS[CONTEXT_ORDER[0]!]);
  });

  it('🔴 ショートカット一覧へのジャンプボタンとマニュアル戻りボタンが存在し動作する', () => {
    const renderer = new HelpRenderer(region, undefined, undefined, store);
    renderer.render();

    const jumpKeysBtn = region.querySelector<HTMLButtonElement>(
      '[data-pkc-field="help-jump-keys"]',
    );
    expect(jumpKeysBtn, 'help-jump-keys ボタンが存在する').not.toBeNull();

    const scrollKeysSpy = vi.spyOn(renderer, 'scrollToKeys');
    jumpKeysBtn!.click();
    expect(scrollKeysSpy).toHaveBeenCalledTimes(1);

    const jumpTopBtn = region.querySelector<HTMLButtonElement>(
      '[data-pkc-field="help-jump-top"]',
    );
    expect(jumpTopBtn, 'help-jump-top ボタンが存在する').not.toBeNull();

    const scrollTopSpy = vi.spyOn(renderer, 'scrollToTop');
    jumpTopBtn!.click();
    expect(scrollTopSpy).toHaveBeenCalledTimes(1);
  });

  it('🔴 各コマンドと割当が正しい属性を持って描画される', () => {
    const renderer = new HelpRenderer(region, undefined, undefined, store);
    renderer.render();

    // 代表的なコマンドのセレクタが正しく取得できる
    const openHelpCommand = region.querySelector(
      '[data-pkc-field="help-key-command"][data-pkc-command="open-help"]',
    );
    expect(openHelpCommand, 'open-help コマンド名が存在する').not.toBeNull();

    const openHelpChords = region.querySelector(
      '[data-pkc-field="help-key-chords"][data-pkc-command="open-help"]',
    );
    expect(openHelpChords, 'open-help 割当が存在する').not.toBeNull();
    expect(openHelpChords!.textContent).toContain('F1');
  });
});
