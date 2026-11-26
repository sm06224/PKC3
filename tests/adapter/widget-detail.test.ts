/** @vitest-environment happy-dom */
/**
 * 🔴 **本体の読む面を通したウィジェットの保存先**(PR-07 レビュー 🔴1 / 🔴2)。
 *
 * `tests/adapter/widget-bridge.test.ts` は器の lid を手で付けて見る。ここは**実物の `DetailRenderer`**で:
 * 1. text ノート A を開くと、本文の器が A の lid を持ち、A のウィジェットは A の領域に書く
 * 2. 続けて添付ノート B を開くと、器の lid は B に付け替わる(A の lid を名乗り続けない)
 * 3. もう一度 A へ戻ると、器は A を持つ
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { installWidgetBridge, WIDGET_LID_ATTR } from '../../src/adapter/ui/render/widget-bridge';
import { readWidgetStorage } from '../../src/adapter/platform/widget-storage';
import { WIDGET_STORAGE_MESSAGE } from '../../src/features/markdown/widget-bridge';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

const tick = (ms = 30): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string, archetype: string): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  } as EntryMeta;
}

const lender: AssetLender = { lend: async () => ({ url: 'blob:x', dispose: () => {} }), getBlob: async () => null };

let off: (() => void) | null = null;
beforeEach(() => {
  document.body.textContent = '';
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', undefined);
  off = installWidgetBridge();
});
afterEach(() => {
  off?.();
  vi.unstubAllGlobals();
});

describe('本体の読む面の器の lid', () => {
  it('🔴 A を開くと A の領域に書き、添付 B へ移ると器は B を名乗り、A へ戻ると A を名乗る', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail, lender);
    const d = new Dispatcher();
    d.onState((s) => detail.render(s));
    const bodies: Record<string, string> = {
      A: '本文\n\n```html id="x"\n<p>A</p>\n```\n',
      B: ['---', 'attachment.name: memo.txt', 'attachment.mime: text/plain', '---', '説明', ''].join('\n'),
    };
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async (lid) => bodies[lid] ?? null,
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('A', 'A', 'text'), meta('B', 'B', 'attachment')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'A' });
    await tick(80);
    const body = (): HTMLElement => root.querySelector<HTMLElement>(`[${WIDGET_LID_ATTR}]`)!;
    expect(body(), '本文の器に lid が付いていない').not.toBeNull();
    expect(body().getAttribute(WIDGET_LID_ATTR)).toBe('A');
    const f = root.querySelector<HTMLIFrameElement>('iframe.pkc-widget-frame');
    expect(f, '読む面で保存つきの器が置かれていない').not.toBeNull();
    const w = { postMessage: () => undefined };
    Object.defineProperty(f!, 'contentWindow', { value: w, configurable: true });
    const ev = new MessageEvent('message', { data: { tag: WIDGET_STORAGE_MESSAGE, op: 'set', key: 'k', value: 'v', seq: 1 } });
    Object.defineProperty(ev, 'source', { value: w, configurable: true });
    window.dispatchEvent(ev);
    expect(readWidgetStorage('A', 'x')).toEqual({ k: 'v' });

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'B' });
    await tick(80);
    expect(body().getAttribute(WIDGET_LID_ATTR), '添付へ移っても前のノートの lid が残った').toBe('B');

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'A' });
    await tick(80);
    expect(body().getAttribute(WIDGET_LID_ATTR)).toBe('A');
  });
});
