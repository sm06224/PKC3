/** @vitest-environment happy-dom */
/**
 * 右クリックメニューが出ているかの問い(`contextMenuOpen` / `closeContextMenu`)は、押すたび・スクロールのたびに呼ばれる。
 * 🔴 root の直下だけを見る(#1467)── 長いノートで文書全体を探すと重い。
 */
import { describe, expect, it, vi } from 'vitest';
import { closeContextMenu, contextMenuOpen, openContextMenu } from '../../src/adapter/ui/render/context-menu';

describe('右クリックメニューの在りかの問い(#1467)', () => {
  it('🔴 開いたメニューを見つけて閉じる ── root.querySelector を呼ばない', () => {
    const root = document.createElement('div');
    document.body.append(root);
    for (let i = 0; i < 50; i++) root.append(document.createElement('p'));
    openContextMenu(root, { x: 10, y: 10 }, [{ action: 'copy-link', label: 'リンクをコピー' }], null);
    const qs = vi.spyOn(root, 'querySelector');
    expect(contextMenuOpen(root)).toBe(true);
    closeContextMenu(root);
    expect(contextMenuOpen(root)).toBe(false);
    expect(qs, '文書全体を探した(長いノートで重い)').not.toHaveBeenCalled();
    qs.mockRestore();
    root.remove();
  });
});
