/** @vitest-environment node */
/**
 * 台帳 #1852 束 F2 / 依頼 105-2・297 A: バックアップの中のゴミ箱のノートを、**ゴミ箱の中へ**戻す(`restoreTrashNotes`)。
 * 実物の worker を `:memory:` で動かす(`storage-worker.test.ts` と同じ手法)。
 *
 * 見るのは: ① 書き出し側(`listTrashHeads` + `exportRevisionChain`)の材料 ② 戻すと一覧(entries)には出ず、ゴミ箱に居る
 * ③ 古い版が同じ内容で戻る ④ 作成日・更新日時・並びの位置が頭の行に残る(ゴミ箱から戻すと元の日時で戻る)
 * ⑤ 付け替え(添付の key・`entry:` の lid)が本文と各版に当たる ⑥ 生きているノート・既に履歴がある lid には積まない。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse, TrashNoteInput } from '../../src/adapter/platform/storage/protocol';

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

const entry = (lid: string, body: string, over: Record<string, unknown> = {}) => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  body,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  ...over,
});

/** パッチが選ばれる大きさの本文(小さいと全文になって、鎖の検査が素通りする)。 */
const doc = (mark: string, lines = 120): string =>
  Array.from({ length: lines }, (_, i) => (i === 5 ? `行 ${i} ${mark}\n` : `行 ${i}\n`)).join('');

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-trash-restore' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

type Src = { head: ResultMap['listTrashHeads'][number]; chain: ResultMap['exportRevisionChain'] };

/** ノートを作り、版を 2 つ積んで、ゴミ箱へ移す ── 書き出しの材料(頭 + 鎖)を返す。 */
async function trashOne(lid: string): Promise<Src> {
  await request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: entry(lid, doc('初稿'), { entryOrder: 7, createdAt: '2026-01-05 09:00:00', updatedAt: '2026-01-05 09:00:00' }),
  });
  await request({ op: 'upsertEntry', cid: 'c1', entry: entry(lid, doc('二稿'), { entryOrder: 7 }), checkpoint: true });
  await request({ op: 'upsertEntry', cid: 'c1', entry: entry(lid, doc('三稿'), { entryOrder: 7 }), checkpoint: true });
  await request({ op: 'deleteEntry', cid: 'c1', lid });
  const head = (await request({ op: 'listTrashHeads', cid: 'c1' })).find((h) => h.lid === lid)!;
  const chain = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: lid });
  return { head, chain };
}

const inputOf = (lid: string, src: Src, over: Partial<TrashNoteInput> = {}): TrashNoteInput => ({
  entryLid: lid,
  title: src.head.title ?? 't',
  archetype: src.head.archetype ?? 'text',
  body: src.chain[0]!.snapshot,
  trashedAt: src.head.trashed_at,
  entryCreatedAt: src.head.created_at,
  entryUpdatedAt: src.head.updated_at,
  entryOrder: src.head.entry_order,
  rows: src.chain.slice(1),
  ...over,
});

describe('ゴミ箱のノートの書き出しの材料(listTrashHeads)', () => {
  it('ゴミ箱へ移した時点の 作成日・並びの位置・題名 を頭が持つ。生きているノートは出ない', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('alive-1', 'x') });
    const { head, chain } = await trashOne('src-1');
    expect(head).toMatchObject({
      lid: 'src-1',
      title: 't-src-1',
      archetype: 'text',
      created_at: '2026-01-05 09:00:00',
      entry_order: 7,
    });
    expect(head.updated_at, '更新日時の控えが無い').not.toBeNull();
    expect(head.trashed_at).not.toBeNull();
    expect(chain[0]!.kind, '頭は全文').toBe('full');
    expect(chain[0]!.snapshot).toBe(doc('三稿'));
    expect(chain.length, '前提: 古い版が 2 つ積まれている').toBe(3);
    const lids = (await request({ op: 'listTrashHeads', cid: 'c1' })).map((h) => h.lid);
    expect(lids).toContain('src-1');
    expect(lids, '生きているノートが混ざった').not.toContain('alive-1');
  });
});

describe('ゴミ箱の中へ戻す(restoreTrashNotes)', () => {
  it('🔴 一覧(entries)には出ず、ゴミ箱に居る。作成日・並びの位置・更新日時が頭に残り、古い版も同じ内容で戻る', async () => {
    const src = await trashOne('src-2');
    // 持ち出した材料を戻す(元のゴミ箱は完全に消してから = 別のコレクションへ戻すのと同じ)
    await request({ op: 'purgeTrash', cid: 'c1', lid: 'src-2' });
    expect((await request({ op: 'listTrash', cid: 'c1' })).some((r) => r.entry_lid === 'src-2')).toBe(false);

    const out = await request({ op: 'restoreTrashNotes', cid: 'c1', notes: [inputOf('src-2', src)] });
    expect(out.skippedEntries).toEqual([]);
    expect(out.brokenChains).toEqual([]);

    // 生きたノートの一覧には出ない
    const metas = await request({ op: 'listEntryMetas', cid: 'c1' });
    expect(
      metas.some((m) => m.lid === 'src-2'),
      'ゴミ箱のノートが一覧に出た',
    ).toBe(false);
    // ゴミ箱に居る(頭の行)
    const trash = (await request({ op: 'listTrash', cid: 'c1' })).filter((r) => r.entry_lid === 'src-2');
    expect(trash).toHaveLength(1);
    expect(trash[0]!.kind).toBe('full');
    // 頭の行を出発点にした「戻す」の材料: 本文・題名・作成日・更新日時・並びの位置
    const back = (await request({ op: 'getRevision', cid: 'c1', id: trash[0]!.id }))!;
    expect(back.body).toBe(doc('三稿'));
    expect(back.title).toBe('t-src-2');
    expect(back.entryCreatedAt).toBe('2026-01-05 09:00:00');
    expect(back.entryOrder).toBe(7);
    expect(back.entryUpdatedAt).toBe(src.head.updated_at);
    // 古い版が、元と同じ内容で戻っている(鎖が噛み合う)
    const metasAfter = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'src-2' });
    expect(metasAfter, '版の数が違う').toHaveLength(3);
    const bodies: string[] = [];
    for (const m of metasAfter) bodies.push((await request({ op: 'getRevision', cid: 'c1', id: m.id }))!.body);
    expect(bodies).toEqual([doc('三稿'), doc('二稿'), doc('初稿')]);
  });

  it('🔴 戻した物を「ゴミ箱から戻す」と同じ書き込みで生きたノートにすると、元の作成日・位置のまま戻る', async () => {
    const src = await trashOne('src-3');
    await request({ op: 'purgeTrash', cid: 'c1', lid: 'src-3' });
    await request({ op: 'restoreTrashNotes', cid: 'c1', notes: [inputOf('src-3', src)] });
    const trash = (await request({ op: 'listTrash', cid: 'c1' })).find((r) => r.entry_lid === 'src-3')!;
    const rev = (await request({ op: 'getRevision', cid: 'c1', id: trash.id }))!;
    // store-effects の「戻す」が呼ぶ書込と同じ形(本文・並び・作成日・更新日時を控えから渡す)
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('src-3', rev.body, {
        entryOrder: rev.entryOrder ?? 1,
        createdAt: rev.entryCreatedAt,
        updatedAt: rev.entryUpdatedAt,
      }),
    });
    const m = (await request({ op: 'listEntryMetas', cid: 'c1' })).find((x) => x.lid === 'src-3')!;
    expect(m.created_at).toBe('2026-01-05 09:00:00');
    expect(m.entry_order).toBe(7);
    expect(m.title).toBe('t-src-3');
  });

  it('🔴 付け替え(添付の key・entry: の lid)が、頭の本文にも古い版にも当たる', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('src-4', `${doc('A')}asset:ast-old entry:old-target\n`),
    });
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('src-4', `${doc('B')}asset:ast-old entry:old-target\n`),
      checkpoint: true,
    });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'src-4' });
    const head = (await request({ op: 'listTrashHeads', cid: 'c1' })).find((h) => h.lid === 'src-4')!;
    const chain = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'src-4' });
    await request({ op: 'purgeTrash', cid: 'c1', lid: 'src-4' });

    const out = await request({
      op: 'restoreTrashNotes',
      cid: 'c1',
      notes: [
        inputOf(
          'src-4',
          { head, chain },
          { remap: { assetKeys: [['ast-old', 'ast-new']], lids: [['old-target', 'new-target']] } },
        ),
      ],
    });
    expect(out.brokenChains, JSON.stringify(out)).toEqual([]);
    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'src-4' });
    const bodies: string[] = [];
    for (const m of metas) bodies.push((await request({ op: 'getRevision', cid: 'c1', id: m.id }))!.body);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b).toContain('asset:ast-new');
      expect(b).toContain('entry:new-target');
      expect(b, '旧い ID が残った').not.toContain('ast-old');
      expect(b).not.toContain('old-target');
    }
    expect(bodies[0]).toContain('行 5 B');
    expect(bodies[1]).toContain('行 5 A');
  });

  it('生きているノートの lid・既に履歴がある lid には積まない(既存の鎖に割り込まない)。1 件の失敗が他を止めない', async () => {
    const src = await trashOne('src-5');
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('live-x', 'x') });
    const out = await request({
      op: 'restoreTrashNotes',
      cid: 'c1',
      notes: [
        inputOf('src-5', src), // 既にゴミ箱に居る
        inputOf('live-x', src), // 生きている
        inputOf('src-6', src), // 空いている lid
      ],
    });
    expect(out.skippedEntries.sort()).toEqual(['live-x', 'src-5']);
    const lids = (await request({ op: 'listTrash', cid: 'c1' })).map((r) => r.entry_lid);
    expect(lids).toContain('src-6');
    // 生きているノートの履歴に他人の版が並んでいない
    expect(await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'live-x' })).toHaveLength(0);
  });

  it('噛み合わない鎖(壊れた版)は、そのノートだけ戻さず名指しする。半端に積まない', async () => {
    const src = await trashOne('src-7');
    await request({ op: 'purgeTrash', cid: 'c1', lid: 'src-7' });
    const broken = inputOf('src-7', src, {
      rows: src.chain.slice(1).map((r) => ({ ...r, contentHash: 'でたらめ' })),
    });
    const out = await request({ op: 'restoreTrashNotes', cid: 'c1', notes: [broken] });
    expect(out.skippedEntries).toEqual(['src-7']);
    expect(out.brokenChains.join('\n')).toContain('src-7');
    // 半端に積まれていない(SAVEPOINT で巻き戻る)
    expect((await request({ op: 'listTrash', cid: 'c1' })).some((r) => r.entry_lid === 'src-7')).toBe(false);
  });
});
