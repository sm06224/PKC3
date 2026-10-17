/**
 * 🔴 **改名のとき、ほかのノートのリンクの字を書き換える worker の口**(#1163 依頼 177、#1648)。
 *
 * 守る主張:
 * 1. 複数のノートを 1 回で書き換え、書き換えたノートと字を直したリンクの数を返す
 * 2. 旧い題名と違う字のリンクだけのノートは書かない(対照群)
 * 3. `skipLids`(編集中)のノートは書かない
 * 4. system 領域のノートには触れない
 * 5. 書き換えるのはラベルだけ(それ以外の byte は同じ)。題名・並びは保つ。履歴に 1 版積む
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-link-text';

const put = (lid: string, body: string, over: Partial<EntryUpsert> = {}) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title: `t-${lid}`,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      ...over,
    },
    checkpoint: false,
  });

const bodyOf = async (lid: string): Promise<string | null> => request({ op: 'getBody', cid: CID, lid });

const A = '前\n[旧い題名](entry:target#章) 後\n';
const B = '[旧い題名](entry:target) と [旧い題名](entry:target)\n';
const C = '[自分で付けた字](entry:target)\n';
const EDITING = '[旧い題名](entry:target)\n';
const SYS = '[旧い題名](entry:target)\n';

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-test-link-text' });
  await request({ op: 'openContainer', cid: CID, title: 'link-text' });
  await put('target', '的\n', { title: '旧い題名', entryOrder: 1 });
  await put('a', A, { entryOrder: 2 });
  await put('b', B, { entryOrder: 3 });
  await put('c', C, { entryOrder: 4 });
  await put('editing', EDITING, { entryOrder: 5 });
  await put('sys', SYS, { entryOrder: 6, realm: 'system' });
}, 30_000);

describe('renameLinkTexts(worker の 1 tx)', () => {
  it('複数のノートを書き換え、ノート数とリンク数を返す。編集中・system・別の字だけのノートは書かない', async () => {
    const r = await request({
      op: 'renameLinkTexts',
      cid: CID,
      lid: 'target',
      oldTitle: '旧い題名',
      newTitle: '新しい題名',
      skipLids: ['editing'],
    });
    expect(r.wrote.map((w) => w.lid).sort()).toEqual(['a', 'b']);
    expect(r.links).toBe(3);

    expect(await bodyOf('a')).toBe('前\n[新しい題名](entry:target#章) 後\n');
    expect(await bodyOf('b')).toBe('[新しい題名](entry:target) と [新しい題名](entry:target)\n');
    // 書かないもの(1 byte も動かない)
    expect(await bodyOf('c')).toBe(C);
    expect(await bodyOf('editing')).toBe(EDITING);
    expect(await bodyOf('sys')).toBe(SYS);
  });

  it('題名・並びは保たれ、履歴に書き換え前の版が 1 つ積まれる', async () => {
    const metas = await request({ op: 'listEntryMetas', cid: CID });
    const a = metas.find((m) => m.lid === 'a')!;
    expect(a.title).toBe('t-a');
    expect(a.entry_order).toBe(2);
    const revs = await request({ op: 'listRevisionMetas', cid: CID, entryLid: 'a' });
    expect(revs.length, '書き換え前の版が履歴に積まれていない').toBeGreaterThanOrEqual(1);
  });

  it('もう一度同じ依頼を出しても、何も書かない(0 件)', async () => {
    const r = await request({
      op: 'renameLinkTexts',
      cid: CID,
      lid: 'target',
      oldTitle: '旧い題名',
      newTitle: '新しい題名',
      skipLids: ['editing'],
    });
    expect(r.wrote).toEqual([]);
    expect(r.links).toBe(0);
  });
});
