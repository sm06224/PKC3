/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const META = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'e1',
  title: 'ノート',
  archetype: 'text',
  entryOrder: 0,
  createdAt: '2026-08-04 23:30:00',
  updatedAt: '2026-08-04 23:30:00',
  status: null,
  date: null,
  archived: false,
  bodyChars: 1200,
  ...over,
});

function stateOf(meta: EntryMeta, openBody?: string): AppState {
  return {
    ...initialState,
    phase: 'ready',
    selectedLid: meta.lid,
    entryMetas: new Map([[meta.lid, meta]]),
    openBody: openBody !== undefined ? { lid: meta.lid, body: openBody } : null,
  } as AppState;
}

function paint(meta: EntryMeta, openBody?: string): HTMLElement {
  document.body.innerHTML = '';
  const region = document.createElement('div');
  document.body.append(region);
  new InspectorRenderer(region).render(stateOf(meta, openBody));
  return region;
}

const cell = (region: HTMLElement, field: string): HTMLElement => {
  const el = region.querySelector<HTMLElement>(`[data-pkc-field="${field}"]`);
  if (!el) throw new Error(`field ${field} が見つからない`);
  return el;
};

describe('情報ペインでの文字数・読了目安の表示 #1112', () => {
  it('🔴 ノートの文字数と読了目安が表示される', () => {
    const region = paint(META({ bodyChars: 1200 }));
    const stats = cell(region, 'inspector-stats');
    expect(stats.hidden).toBe(false);
    expect(stats.textContent).toBe('1,200 文字 (読了 約 3 分)');
  });

  it('🔴 開いている本文の文字数が優先して反映される', () => {
    const body = 'あ'.repeat(450);
    const region = paint(META({ bodyChars: 100 }), body);
    const stats = cell(region, 'inspector-stats');
    expect(stats.hidden).toBe(false);
    expect(stats.textContent).toBe('450 文字 (読了 約 1 分)');
  });

  it('🔴 フォルダでは文字数行が隠れる', () => {
    const region = paint(META({ archetype: 'folder', bodyChars: null }));
    const stats = cell(region, 'inspector-stats');
    expect(stats.hidden).toBe(true);
    const dt = stats.previousElementSibling;
    expect(dt instanceof HTMLElement && dt.hidden).toBe(true);
  });
});
