/** @vitest-environment node */
/**
 * 台帳 #1852 束 G1・G2 のうち、保存の仕組み(worker)側の約束。実物の worker を `:memory:` で動かす
 * (`storage-worker.test.ts` と同じ手法)。
 *
 * - 139: 履歴の各版の日時は「その本文を書いた時刻」(置き換えた時刻ではない)
 * - 301: ゴミ箱の 1 件だけを完全に消す(ほかのゴミ箱のノートの履歴・つながりは残る / 生きているノートは消さない)
 * - 106・300: ゴミ箱へ移すとき、並びの位置と更新日時を控え、戻すときに読み出せる
 * - 108: 編集の保存で、消えていた行を作り直したら名乗る(`recreated`)
 * - 227: 親を 2 本以上、同じ tx で張れる(輪・id のぶつかりは 1 本目と同じに断る)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';

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

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-g1g2' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

const relsOf = async (lid: string) =>
  (await request({ op: 'listRelations', cid: 'c1' })).filter((r) => r.from_lid === lid || r.to_lid === lid);
const trashLids = async (): Promise<string[]> =>
  (await request({ op: 'listTrash', cid: 'c1' })).map((r) => r.entry_lid).sort();

describe('139 履歴の版の日時は、その本文を書いた時刻', () => {
  it('🔴 月曜に書いた本文を金曜に直すと、月曜の版の日時は月曜のまま(置き換えた金曜にならない)', async () => {
    // 行を作った時刻を過去に置く(INSERT の側にだけ効く ── 取り込みと同じ口)
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('h1', '月曜の本文\n', { createdAt: '2026-01-05 09:00:00', updatedAt: '2026-01-05 09:00:00' }),
    });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('h1', '金曜の本文\n'), checkpoint: true });
    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'h1' });
    expect(metas, '前提: 版が 1 件積まれていない').toHaveLength(1);
    expect(metas[0]!.created_at, '版の日時が、置き換えた時刻(いま)になっている').toBe('2026-01-05 09:00:00');
  });

  it('対照群: 更新日時が分からない行(古い器)は、従来どおり置き換えた時刻になる(日時が空にならない)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('h2', '一稿\n') });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('h2', '二稿\n'), checkpoint: true });
    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'h2' });
    expect(metas).toHaveLength(1);
    expect(metas[0]!.created_at ?? '', '日時が空になった').toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });
});

describe('301 ゴミ箱の 1 件だけを完全に消す', () => {
  it('🔴 指した 1 件の履歴とつながりだけが消え、ほかのゴミ箱のノートは戻せるまま', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('pf', '', { archetype: 'folder' }) });
    for (const lid of ['pa', 'pb']) {
      await request({ op: 'upsertEntry', cid: 'c1', entry: entry(lid, lid + ' の本文\n') });
      await request({ op: 'setEntryParent', cid: 'c1', lid, parentLid: 'pf', relationId: 'rel-' + lid });
      await request({ op: 'deleteEntry', cid: 'c1', lid });
    }
    expect(await trashLids(), '前提: ゴミ箱に 2 件入っていない').toEqual(['pa', 'pb']);
    const r = await request({ op: 'purgeTrash', cid: 'c1', lid: 'pa' });
    expect(r.purged, '消した版の数が返らない').toBeGreaterThan(0);
    expect(await trashLids(), '指した 1 件だけが消えるはず').toEqual(['pb']);
    expect(await relsOf('pa'), '消した件のつながりが残っている').toHaveLength(0);
    expect(await relsOf('pb'), 'ほかのゴミ箱のノートの居場所まで消えた').toHaveLength(1);
  });

  it('⚠ 生きているノートの lid を渡されても、履歴を 1 つも消さない(画面が古くて戻した後に押された場合)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('live', '一稿\n') });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('live', '二稿\n'), checkpoint: true });
    const before = (await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'live' })).length;
    expect(before, '前提: 履歴が無い').toBeGreaterThan(0);
    const r = await request({ op: 'purgeTrash', cid: 'c1', lid: 'live' });
    expect(r.purged).toBe(0);
    expect((await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'live' })).length).toBe(before);
  });

  it('対照群: lid を渡さない従来の呼びは、残りのゴミ箱を全部空にする', async () => {
    expect(await trashLids(), '前提: まだ残りが在る').toEqual(['pb']);
    await request({ op: 'purgeTrash', cid: 'c1' });
    expect(await trashLids()).toEqual([]);
  });
});

describe('106・300 ゴミ箱へ移すとき、並びと更新日時を控える', () => {
  it('🔴 控えた並びの位置と更新日時が、戻す材料(getRevision)から読める', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('tr1', '本文\n', { entryOrder: 7, createdAt: '2026-01-02 03:04:05', updatedAt: '2026-02-03 04:05:06' }),
    });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'tr1' });
    const row = (await request({ op: 'listTrash', cid: 'c1' })).find((r) => r.entry_lid === 'tr1');
    expect(row, '前提: ゴミ箱に入っていない').toBeTruthy();
    const rev = await request({ op: 'getRevision', cid: 'c1', id: row!.id });
    expect(rev?.entryOrder, '並びの位置が戻る材料に無い').toBe(7);
    expect(rev?.entryUpdatedAt, '更新日時が戻る材料に無い').toBe('2026-02-03 04:05:06');
    expect(rev?.entryCreatedAt, '作成日(前から在る控え)が落ちた').toBe('2026-01-02 03:04:05');
  });

  it('🔴 その材料で書き戻すと、更新日時が「戻した時刻」にならない', async () => {
    const row = (await request({ op: 'listTrash', cid: 'c1' })).find((r) => r.entry_lid === 'tr1')!;
    const rev = (await request({ op: 'getRevision', cid: 'c1', id: row.id }))!;
    const stamps = await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('tr1', rev.body, {
        entryOrder: rev.entryOrder,
        createdAt: rev.entryCreatedAt,
        updatedAt: rev.entryUpdatedAt,
      }),
    });
    expect(stamps.updatedAt, '更新日時がいまになった').toBe('2026-02-03 04:05:06');
    const metas = await request({ op: 'listEntryMetas', cid: 'c1' });
    expect(metas.find((m) => m.lid === 'tr1')?.entry_order, '並びが末尾へ飛んだ').toBe(7);
  });

  it('対照群: 控えの無い版(通常の履歴)は、並びも更新日時も `null`(従来どおりの動きに落ちる)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tr2', '一稿\n') });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tr2', '二稿\n'), checkpoint: true });
    const [meta] = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'tr2' });
    const rev = await request({ op: 'getRevision', cid: 'c1', id: meta!.id });
    expect(rev?.entryOrder ?? null).toBeNull();
    expect(rev?.entryUpdatedAt ?? null).toBeNull();
  });
});

describe('108 編集の保存で、消えていた行を作り直したら名乗る', () => {
  it('🔴 行が無いのに keepMeta で保存すると recreated を名乗り、書いた字は残る', async () => {
    const stamps = await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('gone', '打った字\n'),
      keepMeta: true,
    });
    expect(stamps.recreated, '消えていた行の作り直しを名乗らない').toBe(true);
    expect((await request({ op: 'getBody', cid: 'c1', lid: 'gone' })), '打った字を失った').toBe('打った字\n');
  });

  it('対照群: 行が在る普通の保存は名乗らない(毎回の保存に知らせを出さない)', async () => {
    const stamps = await request({ op: 'upsertEntry', cid: 'c1', entry: entry('gone', '二度目\n'), keepMeta: true });
    expect(stamps.recreated, '在る行の保存で名乗った').toBeUndefined();
  });

  it('対照群: 新しいノートの最初の書込(keepMeta なし)も名乗らない', async () => {
    const stamps = await request({ op: 'upsertEntry', cid: 'c1', entry: entry('fresh', '最初\n') });
    expect(stamps.recreated).toBeUndefined();
  });
});

describe('227 親を 2 本以上、同じ tx で張る', () => {
  const parentsOf = async (lid: string): Promise<string[]> =>
    (await relsOf(lid)).filter((r) => r.to_lid === lid && r.kind === 'structural').map((r) => r.from_lid).sort();

  it('🔴 alsoIn で、1 本目と合わせて 2 つのフォルダに入る', async () => {
    for (const f of ['fa', 'fb', 'fc']) await request({ op: 'upsertEntry', cid: 'c1', entry: entry(f, '', { archetype: 'folder' }) });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('multi', '本文\n') });
    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'multi',
      parentLid: 'fa',
      relationId: 'm-1',
      alsoIn: [{ parentLid: 'fb', relationId: 'm-2' }],
    });
    expect(await parentsOf('multi')).toEqual(['fa', 'fb']);
    // 対照群: alsoIn なしの従来の呼びは、親を 1 本に張り替える
    await request({ op: 'setEntryParent', cid: 'c1', lid: 'multi', parentLid: 'fc', relationId: 'm-3' });
    expect(await parentsOf('multi')).toEqual(['fc']);
  });

  it('🔴 2 本目が輪になるなら、全部断る(1 本目も入らない)', async () => {
    // fa の中に fd、fd の中に fe。fa を fe の中へ入れる(輪)ことを 2 本目で頼む
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('fd', '', { archetype: 'folder' }) });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('fe', '', { archetype: 'folder' }) });
    await request({ op: 'setEntryParent', cid: 'c1', lid: 'fd', parentLid: 'fa', relationId: 'c-1' });
    await request({ op: 'setEntryParent', cid: 'c1', lid: 'fe', parentLid: 'fd', relationId: 'c-2' });
    await expect(
      request({
        op: 'setEntryParent',
        cid: 'c1',
        lid: 'fa',
        parentLid: 'fc',
        relationId: 'c-3',
        alsoIn: [{ parentLid: 'fe', relationId: 'c-4' }],
      }),
    ).rejects.toThrow();
    expect(await parentsOf('fa'), '輪を断ったのに 1 本目だけ入った').toEqual([]);
  });
});
