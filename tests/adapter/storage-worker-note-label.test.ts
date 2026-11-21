/**
 * 🔴 **worker の `listNoteLabels` / `putNoteLabel`**(#1982 段 4)。
 *
 * 守るもの:①付けた色が読み戻せ、付け直しで上書き、`null` で外れる ②範囲外の色は断る
 * ③上限(`MAX_NOTE_LABELS`。ここでは 3 に差し替え)で新しい lid だけ断り、既存の付け直し・外すのは通る
 * ④消えたノート(entries にもゴミ箱にも無い)の行は付け外しの tx で掃除され、ゴミ箱のノートの色は残る
 * ⑤器ごとに分かれ、ワークスペースの削除(`deleteContainerRows`)で色も消える。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';

vi.mock('../../src/features/note-label', async (orig) => {
  const real = await orig<typeof import('../../src/features/note-label')>();
  return { ...real, MAX_NOTE_LABELS: 3 };
});

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

const CID = 'c-label';
const OTHER = 'c-label-other';
const DOOMED = 'c-label-doomed';

const upsert = (cid: string, lid: string) =>
  request({
    op: 'upsertEntry',
    cid,
    entry: { lid, title: lid, archetype: 'text', body: 'x', entryOrder: 1, status: null, date: null, archived: false },
    checkpoint: false,
  });
const put = (cid: string, lid: string, color: number | null) => request({ op: 'putNoteLabel', cid, lid, color });
const list = (cid: string) => request({ op: 'listNoteLabels', cid });

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-note-label' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: DOOMED, title: 'd' });
  await request({ op: 'openContainer', cid: OTHER, title: 'b' });
  await request({ op: 'openContainer', cid: CID, title: 'a' });
}, 30_000);

describe('ノートの色ラベル(worker)', () => {
  it('付けた色が読め、付け直しで上書きされ、null で外れる。範囲外の色は断る', async () => {
    await upsert(CID, 'a');
    await upsert(CID, 'b');
    await put(CID, 'a', 2);
    await put(CID, 'b', 5);
    expect(await list(CID)).toEqual([
      { lid: 'a', color: 2 },
      { lid: 'b', color: 5 },
    ]);
    await put(CID, 'a', 7);
    expect((await list(CID)).find((e) => e.lid === 'a')?.color).toBe(7);
    await expect(put(CID, 'a', 9)).rejects.toThrow();
    await expect(put(CID, 'a', 0)).rejects.toThrow();
    await put(CID, 'a', null);
    expect(await list(CID)).toEqual([{ lid: 'b', color: 5 }]);
    await put(CID, 'b', null);
    expect(await list(CID)).toEqual([]);
  });

  it('🔴 上限(ここでは 3)で新しい lid だけ断り、付け直しと外すのは通る', async () => {
    for (const l of ['p1', 'p2', 'p3', 'p4']) await upsert(CID, l);
    for (const l of ['p1', 'p2', 'p3']) await put(CID, l, 1);
    await expect(put(CID, 'p4', 1)).rejects.toThrow();
    expect((await list(CID)).map((e) => e.lid)).toEqual(['p1', 'p2', 'p3']);
    await put(CID, 'p1', 4); // 付け直しは通る
    await put(CID, 'p2', null); // 外すのは通る
    await put(CID, 'p4', 1); // 空いたので入る
    expect((await list(CID)).map((e) => e.lid)).toEqual(['p1', 'p3', 'p4']);
    for (const l of ['p1', 'p3', 'p4']) await put(CID, l, null);
  });

  it('🔴 永久削除・存在しない lid の行だけ掃除し、ゴミ箱のノートの色は残って戻すと戻る', async () => {
    await upsert(CID, 'live');
    await upsert(CID, 'goner');
    await upsert(CID, 'bin');
    await put(CID, 'live', 1);
    await put(CID, 'goner', 2);
    await put(CID, 'bin', 3);
    await request({ op: 'deleteEntry', cid: CID, lid: 'goner' });
    await request({ op: 'purgeTrash', cid: CID, lid: 'goner' }); // 永久削除
    await request({ op: 'deleteEntry', cid: CID, lid: 'bin' }); // ゴミ箱のまま
    await put(CID, 'ghost', 4); // 存在しない lid(この付け外しの後の次で掃除される)
    await put(CID, 'live', 1); // 掃除のきっかけ
    expect(await list(CID), 'ghost / 永久削除の行が残った、またはゴミ箱の行を掃除した').toEqual([
      { lid: 'bin', color: 3 },
      { lid: 'live', color: 1 },
    ]);
    await upsert(CID, 'bin'); // ゴミ箱から戻す
    expect((await list(CID)).find((e) => e.lid === 'bin')?.color).toBe(3);
    for (const l of ['live', 'bin']) await put(CID, l, null);
  });

  it('器ごとに分かれ、ワークスペースを削除するとその器の色も消える', async () => {
    await upsert(DOOMED, 'd1');
    await upsert(OTHER, 'o1');
    await put(DOOMED, 'd1', 6);
    await put(OTHER, 'o1', 8);
    expect(await list(DOOMED)).toEqual([{ lid: 'd1', color: 6 }]);
    expect(await list(OTHER)).toEqual([{ lid: 'o1', color: 8 }]);
    expect(await list(CID)).toEqual([]);
    await request({ op: 'deleteWorkspace', cid: DOOMED });
    expect(await list(DOOMED), 'deleteContainerRows が色の行を消していない').toEqual([]);
    expect(await list(OTHER)).toEqual([{ lid: 'o1', color: 8 }]);
    await put(OTHER, 'o1', null);
  });
});

describe('スマートフォルダの色の条件(smartScan.label。#1982 残り 1)', () => {
  const scanLabel = (cid: string, label: number | null) =>
    request({
      op: 'smartScan',
      cid,
      lid: 'self',
      tags: [],
      kind: null,
      updatedFrom: null,
      createdFrom: null,
      dated: null,
      text: null,
      tasks: null,
      openTasks: null,
      label,
    });

  it('その色が付いたノートだけが返る。外すと外れる。別の器の同じ lid の色は混ざらない', async () => {
    await upsert(CID, 's1');
    await upsert(CID, 's2');
    await upsert(CID, 's3');
    await upsert(OTHER, 's1');
    await put(CID, 's1', 3);
    await put(CID, 's2', 3);
    await put(CID, 's3', 5);
    await put(OTHER, 's1', 5);
    expect((await scanLabel(CID, 3)).lids.sort()).toEqual(['s1', 's2']);
    expect((await scanLabel(CID, 5)).lids).toEqual(['s3']);
    expect((await scanLabel(CID, 7)).lids, '付いていない色で何か返った').toEqual([]);
    // 対照群: 色を指定しなければ(他に条件が無いので)何も集めない = 空は「何も」
    expect((await scanLabel(CID, null)).lids).toEqual([]);
    await put(CID, 's1', null);
    expect((await scanLabel(CID, 3)).lids).toEqual(['s2']);
    for (const l of ['s2', 's3']) await put(CID, l, null);
    await put(OTHER, 's1', null);
  });
});

