/** @vitest-environment happy-dom */
/**
 * 🔴 **本文が使っている添付の走査を、本文の字が同じなら繰り返さない**(#1087)。
 *
 * 情報ペインは状態が動くたびに描き直す。「添付」の行は `listAssetUses(body)` を呼び、本文に
 * `asset:` が在ると本文全体を markdown として読む。タグの走査(`inspector-tag-memo.test.ts`)と同じく
 * 本文の字を鍵に 1 つ憶える。
 *
 * ## 🔴 守る主張
 * 1. 同じ本文で描き直しても、走査は 1 回
 * 2. 本文が変われば走査し直し、行も変わる(古い行が残らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const useSpy = vi.fn();
vi.mock('../../src/features/asset/asset-refs-in-body', async (orig) => {
  const real = await orig<typeof import('../../src/features/asset/asset-refs-in-body')>();
  return {
    ...real,
    listAssetUses: (...a: Parameters<typeof real.listAssetUses>) => {
      useSpy(...a);
      return real.listAssetUses(...a);
    },
  };
});

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

beforeEach(() => {
  document.body.textContent = '';
  useSpy.mockClear();
});

function setup(body: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  return { root, d, inspector };
}

const assetRow = (root: HTMLElement): string =>
  root.querySelector('[data-pkc-field="inspector-assets"]')?.textContent ?? '';

describe('添付の走査は本文の字が同じなら 1 回(#1087)', () => {
  it('🔴 同じ本文で何度描き直しても、走査は 1 回', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    expect(assetRow(s.root)).toContain('設計図');
    useSpy.mockClear();
    for (let i = 0; i < 5; i++) s.inspector.render(s.d.getState());
    expect(useSpy).toHaveBeenCalledTimes(0);
    expect(assetRow(s.root)).toContain('設計図');
  });

  it('🔴 本文が変われば走査し直し、行も変わる', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    useSpy.mockClear();
    const st = s.d.getState();
    s.inspector.render({ ...st, openBody: { ...st.openBody!, body: '[仕様書.pdf](asset:ast-b)\n' } });
    expect(useSpy).toHaveBeenCalledTimes(1);
    expect(assetRow(s.root)).toContain('仕様書');
    expect(assetRow(s.root)).not.toContain('設計図');
  });
});
