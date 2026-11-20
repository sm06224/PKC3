/** @vitest-environment happy-dom */
/**
 * 🔴 2 ペインの行も、色ラベルを色だけの手がかりにしない(#1982 段 4)── 題名のセルの `title` に「色ラベル: 緑」。
 * 左の列の行は `note-label.test.ts` が見る。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';

const meta = (lid: string, order: number): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

describe('2 ペインの行の色ラベル', () => {
  it('色が付いた行の題名のセルだけが色の名前を持つ', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const dual = new DualFilerRenderer(regions.center);
    d.onState((s) => dual.render(s));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2)], relations: [] });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    d.dispatch({ type: 'SET_NOTE_LABELS', labels: new Map([['a', 3]]) });
    const cell = (lid: string): HTMLElement =>
      regions.center.querySelector<HTMLElement>(
        `[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-entry="${lid}"] td`,
      )!;
    expect(cell('a').title).toContain('色ラベル: 緑');
    expect(cell('b').title).not.toContain('色ラベル');
    // 付け外しで行が描き直る(両方向)
    expect(cell('a').parentElement!.getAttribute('data-pkc-note-label')).toBe('3');
    d.dispatch({ type: 'SET_NOTE_LABELS', labels: new Map() });
    expect(cell('a').title).not.toContain('色ラベル');
    expect(cell('a').parentElement!.hasAttribute('data-pkc-note-label')).toBe(false);
  });
});
