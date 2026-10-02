/** @vitest-environment happy-dom */
/**
 * 🔴 **読む面だけが、本文の色コードの左に見本を出す**(#1224)。
 *
 * 描画そのものは `tests/features/markdown-color-swatch.test.ts`。**ここが見るのは「どの面が旗を立てるか」**:
 * 読む面は立て(設定が切なら立てない)、章の別ウィンドウ・書き出しは立てない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, readingRenderOptions } from '../../src/adapter/ui/render/detail';
import { appColorSwatch } from '../../src/adapter/ui/render/color-swatch';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function stateWithBody(body: string) {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  return s;
}

async function paint(body: string): Promise<HTMLElement> {
  const root = document.createElement('div');
  const detail = new DetailRenderer(buildShell(root).detail);
  detail.render(stateWithBody(body));
  await settle();
  return root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
}

afterEach(() => appColorSwatch.setEnabled(true));

describe('読む面の旗(#1224)', () => {
  it('🔴 既定(入)では、本文の色コードの左に見本が出る(字は変わらない)', async () => {
    appColorSwatch.setEnabled(true);
    const body = await paint('主色は `#3b82f6` です\n');
    const sw = body.querySelector<HTMLElement>('[data-pkc-color-swatch]');
    expect(sw, '読む面に見本が出ていない').not.toBeNull();
    expect(sw!.getAttribute('style')).toBe('--pkc-swatch: #3b82f6');
    expect(body.textContent, '字が変わっている').toContain('主色は #3b82f6 です');
  });

  it('🔴 設定を切ると、見本が 1 つも出ない', async () => {
    appColorSwatch.setEnabled(false);
    const body = await paint('主色は `#3b82f6` です\n');
    expect(body.querySelector('[data-pkc-color-swatch]'), '切ったのに出ている').toBeNull();
    expect(body.textContent, '字が消えている').toContain('#3b82f6');
  });

  it('🔴 章の別ウィンドウが使う設定(readingRenderOptions)は旗を持たない', () => {
    appColorSwatch.setEnabled(true);
    const opts = readingRenderOptions('`#3b82f6`\n', {
      allowExternalImages: false,
      currentContainerId: 'c1',
    });
    expect('colorSwatches' in opts, '受け手の居ない面にも旗が渡る').toBe(false);
    expect(renderMarkdown('`#3b82f6`\n', opts)).not.toContain('color-swatch');
  });
});
