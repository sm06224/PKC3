/** @vitest-environment happy-dom */
/**
 * 🔴 **読む面だけが、本文の `@日付` を押せる字にする**(#1169)。
 *
 * 描画そのものは `tests/features/markdown-date-link.test.ts`、押した後は
 * `tests/adapter/date-link-actions.test.ts`。**ここが見るのは「どの面が旗を立てるか」**:
 * 受け手が居る読む面は立て(設定が切なら立てない)、受け手の居ない面
 * (章の別ウィンドウ)は立てない ── 押せるのに何も起きない字を作らない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, readingRenderOptions } from '../../src/adapter/ui/render/detail';
import { appDateLinks } from '../../src/adapter/ui/render/date-links';
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

afterEach(() => appDateLinks.setEnabled(true));

describe('読む面の旗(#1169)', () => {
  it('🔴 既定(入)では、本文の @日付が押せる字で出る', async () => {
    appDateLinks.setEnabled(true);
    const body = await paint('- [ ] 見積を送る @2026-10-15\n');
    const link = body.querySelector('[data-pkc-action="open-date-note"]');
    expect(link, '読む面に押せる日付が出ていない').not.toBeNull();
    expect(link!.getAttribute('data-pkc-date')).toBe('2026-10-15');
    expect(link!.textContent, '字が変わっている').toBe('@2026-10-15');
  });

  it('🔴 設定を切ると、ふつうの字のまま(押せる印が 1 つも出ない)', async () => {
    appDateLinks.setEnabled(false);
    const body = await paint('- [ ] 見積を送る @2026-10-15\n');
    expect(body.querySelector('[data-pkc-action="open-date-note"]'), '切ったのに押せる').toBeNull();
    expect(body.textContent, '字が消えている').toContain('@2026-10-15');
  });

  /**
   * 🔴 **受け手の居ない面は旗を立てない**。章の別ウィンドウは `readingRenderOptions` だけで
   * 描く(押せる形の旗 `interactive*` を渡さない)ので、**ここへ旗を足すと窓の中で
   * 押せるのに効かない字**ができる(窓には受け手が居ない)。
   */
  it('🔴 章の別ウィンドウが使う設定(readingRenderOptions)は旗を持たない', () => {
    appDateLinks.setEnabled(true);
    const opts = readingRenderOptions('@2026-10-15\n', {
      allowExternalImages: false,
      currentContainerId: 'c1',
    });
    expect('interactiveDates' in opts, '受け手の居ない面にも旗が渡る').toBe(false);
    expect(renderMarkdown('@2026-10-15\n', opts)).not.toContain('open-date-note');
  });
});
