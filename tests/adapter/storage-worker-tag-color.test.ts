/**
 * 🔴 **worker の `listTagColors` / `putTagColor`**(#1457)。
 *
 * 守るもの:①付けた色が読み戻せる ②外す(`color: null`)と消え、他のタグは動かない
 * ③同じ鍵への付け直しは置き換え(1 行のまま)④`#rrggbb` でない色は書かない
 * ⑤器ごとに分かれる(別の cid に漏れない)。
 * 守っていないもの:多重タブでの同時書込(1 タグ 1 行の UPSERT であることをコードで確認しただけ)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];

const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(
  req: Extract<StorageRequest, { op: O }>,
): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-tagcolor';
const OTHER = 'c-other';

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-tag-color' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: CID, title: 'a' });
  await request({ op: 'openContainer', cid: OTHER, title: 'b' });
}, 30_000);

describe('タグの色(worker)', () => {
  it('付けた色が読み戻せ、付け直すと 1 行のまま置き換わる', async () => {
    await request({ op: 'putTagColor', cid: CID, key: '買い物', tag: '買い物', color: '#ff8800' });
    expect(await request({ op: 'listTagColors', cid: CID })).toEqual([
      { tag: '買い物', color: '#ff8800' },
    ]);
    await request({ op: 'putTagColor', cid: CID, key: '買い物', tag: '買い物', color: '#0044CC' });
    expect(await request({ op: 'listTagColors', cid: CID })).toEqual([
      { tag: '買い物', color: '#0044cc' }, // 小文字にそろう
    ]);
  });

  it('外すと消え、他のタグの色は動かない(外す対象が無くても落ちない)', async () => {
    await request({ op: 'putTagColor', cid: CID, key: 'work', tag: 'Work', color: '#112233' });
    await request({ op: 'putTagColor', cid: CID, key: '買い物', tag: '買い物', color: null });
    const left = await request({ op: 'listTagColors', cid: CID });
    expect(left).toEqual([{ tag: 'Work', color: '#112233' }]);
    await request({ op: 'putTagColor', cid: CID, key: 'ない', tag: 'ない', color: null });
    expect(await request({ op: 'listTagColors', cid: CID })).toEqual(left);
  });

  it('🔴 #rrggbb でない色は書かない(表に何も増えない)', async () => {
    const before = await request({ op: 'listTagColors', cid: CID });
    for (const bad of ['red', '#fff', 'rgb(0,0,0)', '#ff880']) {
      await expect(
        request({ op: 'putTagColor', cid: CID, key: 'x', tag: 'x', color: bad }),
      ).rejects.toThrow();
    }
    expect(await request({ op: 'listTagColors', cid: CID })).toEqual(before);
  });

  it('🔴 上限(500)を超える新しいタグは worker も断る。付いているタグの色変更・外すは通る', async () => {
    const CAP = 'c-cap';
    await request({ op: 'openContainer', cid: CAP, title: 'cap' });
    for (let i = 0; i < 500; i++) {
      await request({ op: 'putTagColor', cid: CAP, key: `k${i}`, tag: `k${i}`, color: '#123456' });
    }
    await expect(
      request({ op: 'putTagColor', cid: CAP, key: 'extra', tag: 'extra', color: '#ffffff' }),
    ).rejects.toThrow(/500/);
    expect(await request({ op: 'listTagColors', cid: CAP })).toHaveLength(500);
    // 付いているタグの色変更は上限いっぱいでも通る
    await request({ op: 'putTagColor', cid: CAP, key: 'k3', tag: 'k3', color: '#ffffff' });
    // 外せば、1 つぶん空いて新しいタグを付けられる
    await request({ op: 'putTagColor', cid: CAP, key: 'k4', tag: 'k4', color: null });
    await request({ op: 'putTagColor', cid: CAP, key: 'extra', tag: 'extra', color: '#ffffff' });
    expect(await request({ op: 'listTagColors', cid: CAP })).toHaveLength(500);
  }, 60_000);

  it('器ごとに分かれる', async () => {
    expect(await request({ op: 'listTagColors', cid: OTHER })).toEqual([]);
    await request({ op: 'putTagColor', cid: OTHER, key: 'z', tag: 'z', color: '#abcdef' });
    expect(await request({ op: 'listTagColors', cid: OTHER })).toEqual([
      { tag: 'z', color: '#abcdef' },
    ]);
    expect((await request({ op: 'listTagColors', cid: CID })).map((e) => e.tag)).not.toContain('z');
  });
});
