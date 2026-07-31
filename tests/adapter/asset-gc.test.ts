/** @vitest-environment happy-dom */
/**
 * asset GC(P4b)の orchestration pin。実 sqlite の substring 走査は
 * store probe(nightly)が検定する ── ここは候補の和集合 / orphan 判定 /
 * 削除順(blob → meta)/ 部分失敗の隔離を固定する。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  findOrphanAssets,
  purgeAssets,
  type AssetGcPorts,
} from '../../src/adapter/platform/storage/asset-gc';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function fakePorts(over: Partial<AssetGcPorts> = {}) {
  const calls: string[] = [];
  const ports: AssetGcPorts = {
    listMetas: async () => [
      { key: 'k-ref', size: 10 },
      { key: 'k-orphan-meta', size: 20 },
    ],
    // k-orphan-meta は blob 側に無い(meta だけの dangling)、
    // k-orphan-blob は meta 側に無い(bytes だけの dangling)
    listBlobKeys: async () => ['k-ref', 'k-orphan-blob'],
    scanReferenced: async (candidates) => {
      calls.push(`scan:${[...candidates].sort().join(',')}`);
      return ['k-ref'];
    },
    deleteBlob: async (key) => {
      calls.push(`blob:${key}`);
    },
    deleteMeta: async (key) => {
      calls.push(`meta:${key}`);
    },
    ...over,
  };
  return { ports, calls };
}

describe('asset GC (P4b)', () => {
  it('候補 = meta ∪ blob の和集合。参照されない側だけが orphan(dangling 両型を含む)', async () => {
    const { ports, calls } = fakePorts();
    const found = await findOrphanAssets(ports);
    // 和集合 3 key が走査に渡る
    expect(calls[0]).toBe('scan:k-orphan-blob,k-orphan-meta,k-ref');
    expect([...found.keys].sort()).toEqual(['k-orphan-blob', 'k-orphan-meta']);
    // bytes だけの dangling は size 不明 = 0 扱い(過大報告しない)
    expect(found.knownBytes).toBe(20);
  });

  it('候補ゼロなら走査自体を呼ばない', async () => {
    const scan = vi.fn(async () => []);
    const { ports } = fakePorts({
      listMetas: async () => [],
      listBlobKeys: async () => [],
      scanReferenced: scan,
    });
    const found = await findOrphanAssets(ports);
    expect(found).toEqual({ keys: [], knownBytes: 0 });
    expect(scan).not.toHaveBeenCalled();
  });

  it('purge は key ごとに blob → meta の順。1 key の失敗は他を止めない', async () => {
    const { ports, calls } = fakePorts({
      deleteBlob: async (key) => {
        calls.push(`blob:${key}`);
        if (key === 'k-bad') throw new Error('idb fail');
      },
    });
    const r = await purgeAssets(ports, ['k-a', 'k-bad', 'k-b']);
    expect(r).toEqual({ deleted: 2, failed: 1 });
    // 失敗 key は meta を消さない(候補和集合に残り、次回 purge が回収する)
    expect(calls).toEqual([
      'blob:k-a',
      'meta:k-a',
      'blob:k-bad',
      'blob:k-b',
      'meta:k-b',
    ]);
  });

  it('topbar の「添付の整理」click が services.purgeOrphanAssets に届く', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const purge = vi.fn();
    bindActions(root, new Dispatcher(), { purgeOrphanAssets: purge });
    root
      .querySelector<HTMLElement>('[data-pkc-action="purge-orphan-assets"]')!
      .click();
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
