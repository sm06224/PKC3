/** @vitest-environment happy-dom */
/**
 * 本文 markdown の `asset:` 参照の hydrate(P4b)pin:
 * - 同一 key の複数参照は **1 lend / 1 URL** を共有
 * - URL は選択遷移(表示の寿命終端)で必ず dispose(即破棄規律)
 * - 不在 key は data-pkc-asset-missing(黙って空にしない)
 * - 解決前に選択が移ったら結果を捨てて即 dispose(stale 注入なし)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 1,
    status: null,
    date: null,
    archived: false,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(bodies: Record<string, string>, lender: AssetLender) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, lender);
  d.onState((s) => detail.render(s));
  connectStoreEffects(d, {
    getBody: async (lid) => bodies[lid] ?? null,
    persistEntry: async () => {},
    deleteEntry: async () => {},
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('e1'), meta('e2')],
    relations: [],
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { d, q, qa };
}

const BODY_WITH_REFS = [
  '![一枚目](asset:k1)',
  '',
  '![二枚目(同じ asset)](asset:k1)',
  '',
  '![消えた](asset:k404)',
  '',
  '[添付をDL](asset:k1)',
].join('\n');

describe('asset ref hydrate (P4b)', () => {
  it('同一 key は 1 lend を共有し、選択遷移で 1 回だけ dispose される', async () => {
    let lends = 0;
    let disposed = 0;
    const lender: AssetLender = {
      lend: async (key) => {
        if (key === 'k404') return null;
        lends++;
        return { url: `blob:${key}`, dispose: () => disposed++ };
      },
      getBlob: async () => null,
    };
    const { d, q, qa } = setup({ e1: BODY_WITH_REFS, e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick(20);

    const imgs = qa('img[data-pkc-asset-key="k1"]');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute('src')).toBe('blob:k1');
    expect(imgs[1]!.getAttribute('src')).toBe('blob:k1'); // URL 共有
    expect(lends).toBe(1); // 同一 key は 1 回だけ借りる

    // 不在 key は missing 印(alt が可視 fallback)
    const gone = q('img[data-pkc-asset-key="k404"]')!;
    expect(gone.hasAttribute('data-pkc-asset-missing')).toBe(true);
    expect(gone.hasAttribute('src')).toBe(false);

    // DL link は binder の download-asset に載る形
    const a = q('a[data-pkc-action="download-asset"]')!;
    expect(a.getAttribute('data-pkc-asset-key')).toBe('k1');
    expect(a.getAttribute('data-pkc-asset-name')).toBe('添付をDL');

    expect(disposed).toBe(0); // 表示中は生きている
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    await tick(20);
    expect(disposed).toBe(1); // 表示の寿命終端で dispose(URL は 1 本なので 1 回)
  });

  it('stale hydrate: 解決前に選択が移ったら借りた瞬間に返す(注入なし)', async () => {
    let disposed = 0;
    let release: (v: { url: string; dispose: () => void } | null) => void = () => {};
    const lender: AssetLender = {
      lend: () =>
        new Promise((r) => {
          release = r;
        }),
      getBlob: async () => null,
    };
    const { d, qa } = setup({ e1: '![x](asset:k1)', e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' }); // 解決前に離脱
    await tick();
    release({ url: 'blob:late', dispose: () => disposed++ });
    await tick();
    expect(disposed).toBe(1); // 即返却
    expect(qa('img[src]')).toHaveLength(0); // stale 注入なし
  });

  it('lend が throw しても missing 印で終える(unhandled rejection にしない)', async () => {
    const lender: AssetLender = {
      lend: async () => {
        throw new Error('idb down');
      },
      getBlob: async () => null,
    };
    const { d, q } = setup({ e1: '![x](asset:k1)' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick(20);
    expect(q('img[data-pkc-asset-key="k1"]')!.hasAttribute('data-pkc-asset-missing')).toBe(
      true,
    );
  });
});
