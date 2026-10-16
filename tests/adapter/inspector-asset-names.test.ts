/** @vitest-environment happy-dom */
/**
 * 右の列「本文で使う添付」の名前(説明文が空の添付の元の file 名)は、改名したら引き直す(I1)。
 * 憶えた名前(null を含む)を `entryMetas` の参照が替わっても捨てなかったので、
 * 添付を改名しても再読み込みまで古い名前が出ていた。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

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
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(resolver: (key: string) => Promise<string | null>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  inspector.setAssetNameResolver(resolver);
  d.onState((s) => inspector.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '![](asset:ast-a)' });
  return { root, d };
}

const label = (root: HTMLElement): string | undefined =>
  root.querySelector<HTMLElement>('[data-pkc-action="jump-to-asset-use"]')?.textContent ?? undefined;

describe('添付の名前の引き直し', () => {
  it('添付を改名して meta が替わったら、新しい名前を出す', async () => {
    let name: string | null = 'old.png';
    let asked = 0;
    const { root, d } = setup(async () => {
      asked++;
      return name;
    });
    await tick();
    expect(label(root)).toBe('old.png');
    expect(asked).toBe(1);

    name = 'new.png';
    // 改名 = 別の meta 参照(ENTRY_STAMPED は刻みが動けば meta を差し替える)
    d.dispatch({ type: 'ENTRY_STAMPED', lid: 'n1', createdAt: null, updatedAt: '2026-10-16T00:00:00Z' });
    await tick();
    expect(asked).toBe(2);
    expect(label(root)).toBe('new.png');
  });

  it('名前が無かった(null)添付も、meta が替われば引き直す', async () => {
    let name: string | null = null;
    const { root, d } = setup(async () => name);
    await tick();
    name = 'later.png';
    d.dispatch({ type: 'ENTRY_STAMPED', lid: 'n1', createdAt: null, updatedAt: '2026-10-16T00:00:00Z' });
    await tick();
    expect(label(root)).toBe('later.png');
  });

  it('meta が替わらない描き直しでは引き直さない(問いを増やさない)', async () => {
    let asked = 0;
    const { d } = setup(async () => {
      asked++;
      return 'a.png';
    });
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    expect(asked).toBe(1);
  });
});
