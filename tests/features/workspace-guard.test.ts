/**
 * 🔴 **ワークスペースが 2 つ以上のとき、全部を消す操作は添付を消す前に断る**(#1455 レビュー 🔴1)。
 *
 * 直す前は worker の `wipeStorage` だけが断っており、そこへ着く前に「初期化」は**添付の実体(IndexedDB)を先に消していた**
 * (添付 → DB の順)。断られたのに添付だけ失っている ── その形を再現して潰す。
 */
import { describe, expect, it } from 'vitest';
import { resetContainer, type ContainerResetPorts } from '../../src/features/storage/container-reset';
import { rebuildContainer, type RebuildPorts } from '../../src/features/storage/container-rebuild';
import {
  refuseWhenWorkspacesRemain,
  WORKSPACES_REMAIN_MESSAGE,
} from '../../src/features/storage/workspace-guard';

describe('入口の門', () => {
  it('2 つ以上なら断る / 1 つなら通す / 数えられなければ通す(壊れを直す道を塞がない)', async () => {
    await expect(refuseWhenWorkspacesRemain(async () => 2)).rejects.toThrow(WORKSPACES_REMAIN_MESSAGE);
    await expect(refuseWhenWorkspacesRemain(async () => 1)).resolves.toBeUndefined();
    await expect(
      refuseWhenWorkspacesRemain(async () => {
        throw new Error('壊れている');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('初期化(resetContainer)', () => {
  function bench(count: () => Promise<number>) {
    const log: string[] = [];
    const ports: ContainerResetPorts = {
      countWorkspaces: count,
      listAssetKeys: async () => {
        log.push('list');
        return ['a', 'b'];
      },
      deleteAsset: async (_c, k) => {
        log.push(`del:${k}`);
      },
      wipeStorage: async () => {
        log.push('wipe');
        return { wiped: true, note: null };
      },
      forgetLocal: () => log.push('forget') as unknown as void,
      announceWiped: () => log.push('announce') as unknown as void,
    };
    return { ports, log };
  }

  it('🔴 2 つ目の器があると、断りの文が出て、添付も DB も 1 つも触らない', async () => {
    const { ports, log } = bench(async () => 2);
    await expect(resetContainer('c1', ports)).rejects.toThrow(WORKSPACES_REMAIN_MESSAGE);
    expect(log, '断ったのに添付を消した / 一覧を引いた / 捨てた').toEqual([]);
  });

  it('対照群: 1 つなら今までどおり 添付 → DB の順で消す', async () => {
    const { ports, log } = bench(async () => 1);
    await resetContainer('c1', ports);
    expect(log).toEqual(['list', 'del:a', 'del:b', 'wipe', 'forget', 'announce']);
  });
});

describe('作り直し(rebuildContainer)', () => {
  it('🔴 2 つ目の器があると、何も拾わず・zip も書かず・捨てずに断る', async () => {
    const touched: string[] = [];
    // 門の口(書込担当か / 数)以外に触ったら記録する
    const ports = new Proxy(
      { holdsWriterLease: () => true, countWorkspaces: async () => 2 } as unknown as RebuildPorts,
      {
        get(target, prop) {
          if (prop in target) return (target as unknown as Record<string, unknown>)[prop as string];
          touched.push(String(prop));
          return () => Promise.resolve(undefined);
        },
      },
    );
    await expect(rebuildContainer('c1', 'PKC3', ports)).rejects.toThrow(WORKSPACES_REMAIN_MESSAGE);
    expect(touched, '断る前に他の口へ触った').toEqual([]);
  });
});
