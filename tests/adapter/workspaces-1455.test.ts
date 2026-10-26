/**
 * 🔴 **ワークスペース(= 器)の切り替え**(#1455)── 保存側(storage worker)の主張。
 *
 * 1. 切り替えの印が無い間は、今までどおり**いちばん古い器**を開く(既存の端末は何も変わらない)
 * 2. 切り替えると、次の `resolveContainer` がその器を返す / 実在しない器へは切り替えられない
 * 3. 器ごとにノートが分かれる(一覧に別の器のノートが混ざらない)
 * 4. 削除は**使っていない器だけ** / 最後の 1 つは残す / 削除した器の行は 1 行も残らない(別の器は無傷)
 * 5. 人に渡すファイルの画像(`withoutMessages`)には、使っているワークスペースしか入らない
 * 6. 複数のワークスペースがあるとき、DB を丸ごと捨てる操作は断る(ほかのワークスペースを巻き込まない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];
type Request = <O extends Op>(req: Extract<StorageRequest, { op: O }>) => Promise<ResultMap[O]>;

let dbSeq = 0;

async function freshWorker(): Promise<Request> {
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: {
    onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
  } = { onmessage: null };
  const g = globalThis as unknown as Record<string, unknown>;
  g['self'] = workerSelf;
  g['postMessage'] = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  const request: Request = (req) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) =>
        resp.ok ? resolve(resp.result as never) : reject(new Error(resp.error)),
      );
      workerSelf.onmessage!({ data: { id, req } });
    });
  vi.resetModules();
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: `unit-ws-${++dbSeq}` });
  return request;
}

let request: Request;
beforeEach(async () => {
  request = await freshWorker();
}, 30_000);

async function addNote(cid: string, lid: string, title: string): Promise<void> {
  await request({
    op: 'upsertEntry',
    cid,
    entry: { lid, title, archetype: 'text', body: `本文 ${title}`, entryOrder: 1, status: null, date: null, archived: false },
    checkpoint: false,
  });
}

describe('ワークスペース(保存側) #1455', () => {
  it('印が無い間はいちばん古い器を開く / 一覧には使用中が出る', async () => {
    const first = await request({ op: 'resolveContainer', title: 'PKC3' });
    const { cid: second } = await request({ op: 'createWorkspace', title: '個人用' });
    // 足しただけでは使う器は動かない
    expect((await request({ op: 'resolveContainer', title: 'PKC3' })).cid).toBe(first.cid);
    const list = await request({ op: 'listWorkspaces' });
    expect(list.activeCid).toBe(first.cid);
    expect(list.workspaces.map((w) => w.cid).sort()).toEqual([first.cid, second].sort());
    expect(list.workspaces.find((w) => w.cid === second)?.title).toBe('個人用');
  });

  it('切り替えると次の resolveContainer がその器を返し、ノートは器ごとに分かれる(双方向)', async () => {
    const a = (await request({ op: 'resolveContainer', title: 'PKC3' })).cid;
    await addNote(a, 'e1', '仕事のノート');
    const { cid: b } = await request({ op: 'createWorkspace', title: '個人用' });
    await request({ op: 'switchWorkspace', cid: b });
    expect((await request({ op: 'resolveContainer', title: 'PKC3' })).cid).toBe(b);
    expect(await request({ op: 'listEntryMetas', cid: b })).toEqual([]);
    await addNote(b, 'p1', '個人のノート');
    expect((await request({ op: 'listEntryMetas', cid: a })).map((m) => m.lid)).toEqual(['e1']);
    expect((await request({ op: 'listEntryMetas', cid: b })).map((m) => m.lid)).toEqual(['p1']);
    const counts = new Map((await request({ op: 'listWorkspaces' })).workspaces.map((w) => [w.cid, w.notes]));
    expect([counts.get(a), counts.get(b)]).toEqual([1, 1]);
    // 戻せる
    await request({ op: 'switchWorkspace', cid: a });
    expect((await request({ op: 'resolveContainer', title: 'PKC3' })).cid).toBe(a);
  });

  it('実在しない器へは切り替えられない / 空の名前の作成・改名は断る / 改名は反映される', async () => {
    await request({ op: 'resolveContainer', title: 'PKC3' });
    await expect(request({ op: 'switchWorkspace', cid: 'nope' })).rejects.toThrow('見つかりません');
    await expect(request({ op: 'createWorkspace', title: '   ' })).rejects.toThrow('名前');
    const { cid } = await request({ op: 'createWorkspace', title: 'x' });
    await request({ op: 'renameWorkspace', cid, title: '  仕事   用 ' });
    expect((await request({ op: 'listWorkspaces' })).workspaces.find((w) => w.cid === cid)?.title).toBe('仕事 用');
    await expect(request({ op: 'renameWorkspace', cid, title: '' })).rejects.toThrow('名前');
  });

  it('削除: 使っている器・最後の 1 つは断る / 削除した器の行は残らず、別の器は無傷', async () => {
    const a = (await request({ op: 'resolveContainer', title: 'PKC3' })).cid;
    await expect(request({ op: 'deleteWorkspace', cid: a })).rejects.toThrow('最後');
    await addNote(a, 'e1', '残るノート');
    const { cid: b } = await request({ op: 'createWorkspace', title: '消す方' });
    await addNote(b, 'x1', '消えるノート');
    await request({ op: 'putTagColor', cid: b, key: '赤', tag: '赤', color: '#ff0000' });
    // 使っている器は消せない
    await expect(request({ op: 'deleteWorkspace', cid: a })).rejects.toThrow('使っている');
    const r = await request({ op: 'deleteWorkspace', cid: b });
    expect(r.removedNotes).toBe(1);
    const list = await request({ op: 'listWorkspaces' });
    expect(list.workspaces.map((w) => w.cid)).toEqual([a]);
    expect(await request({ op: 'listEntryMetas', cid: b }), '削除した器のノートが残っている').toEqual([]);
    expect(await request({ op: 'listTagColors', cid: b }), '削除した器のタグの色が残っている').toEqual([]);
    expect((await request({ op: 'listEntryMetas', cid: a })).map((m) => m.lid), '別の器が巻き込まれた').toEqual(['e1']);
    // 切り替えの印が削除された器を指していても、開く器は決まる(いちばん古い器)
    await expect(request({ op: 'deleteWorkspace', cid: b })).rejects.toThrow();
  });

  it('切り替え先を削除した後は、実在する器を開く(印が宙に浮かない)', async () => {
    const a = (await request({ op: 'resolveContainer', title: 'PKC3' })).cid;
    const { cid: b } = await request({ op: 'createWorkspace', title: 'b' });
    await request({ op: 'switchWorkspace', cid: b });
    await request({ op: 'switchWorkspace', cid: a });
    await request({ op: 'deleteWorkspace', cid: b });
    expect((await request({ op: 'resolveContainer', title: 'PKC3' })).cid).toBe(a);
  });

  it('人に渡す画像には、使っているワークスペースだけが入る(ほかの器のノートを 1 件も入れない)', async () => {
    const a = (await request({ op: 'resolveContainer', title: 'PKC3' })).cid;
    await addNote(a, 'e1', '渡すノート');
    const { cid: b } = await request({ op: 'createWorkspace', title: '内緒' });
    await addNote(b, 'secret', '内緒のノート');
    const shared = await request({ op: 'exportImage', withoutMessages: true });
    const archive = await request({ op: 'readImageArchive', image: shared.image });
    expect(archive.cid).toBe(a);
    const all = await request({ op: 'exportImage' });
    // 対照群: 画像を作った後も、本体の内緒の器は無傷(ROLLBACK で確定していない)
    expect((await request({ op: 'listEntryMetas', cid: b })).map((m) => m.lid), '本体から内緒の器が消えた').toEqual(['secret']);
    // 画像の中身: 内緒のノートの字が入っていない / 全部入りの画像には入っている(対照群)
    const text = (img: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(img);
    expect(text(shared.image).includes('内緒のノート'), '人に渡す画像に内緒の器が入っている').toBe(false);
    expect(text(all.image).includes('内緒のノート'), '対照群: 全部入りの画像に内緒の器が無い(検査が空振り)').toBe(true);
  });

  it('複数のワークスペースが居るとき、DB を丸ごと捨てる操作は断る', async () => {
    await request({ op: 'resolveContainer', title: 'PKC3' });
    await request({ op: 'createWorkspace', title: '2 つ目' });
    await expect(request({ op: 'wipeStorage' })).rejects.toThrow('複数のワークスペース');
  });

  it('ワークスペースが 1 つなら、捨てる操作は今までどおり通る', async () => {
    await request({ op: 'resolveContainer', title: 'PKC3' });
    const r = await request({ op: 'wipeStorage' });
    expect(r.wiped).toBe(false); // node にディスクは無い(メモリ上)── 断られていない
  });
});
