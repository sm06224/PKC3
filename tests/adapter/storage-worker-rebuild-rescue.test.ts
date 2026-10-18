/**
 * 🔴 **索引だけが壊れた DB を、本物の worker で「作り直す」**（#1087）。
 *
 * ## 何を確かめるか
 *
 * 1. 🔑 **実測**（2026-10-14）: `relations` / `revisions` / `entries` の索引の root page を潰した DB で、
 *    索引を使う形は rc 11、`NOT INDEXED` の表走査は**全行読める**（`db-rescue.ts` の実測表の続き）
 * 2. 🔴 作り直しの後、**つながり・履歴・添付の登録行・タグの色**が戻る。
 *    （直す前は `entries` だけを書き戻していて、残りは黙って消えていた）
 * 3. 🔴 作り直した後の書き出しに、**添付が入る**（登録行から一覧を取るので、登録行が無いと 0 件になる）
 *
 * ⚠ 新しい DB へ移る部分（`wipeStorage` / `reopenStorage`）だけ node では本物にできない
 *   （OPFS が無い）ので、`close` → 新しい `init` で代える。残りは実物の SQL と実物の鎖ロジックである。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { readArchive, writeArchive, type ArchiveSource } from '../../src/features/export/pkc3-archive';
import { rebuildContainer } from '../../src/features/storage/container-rebuild';
import { tagColorKey } from '../../src/features/tag-color';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;

type Req = <O extends Op>(req: Extract<StorageRequest, { op: O }>) => Promise<ResultMap[O]>;

/**
 * 🔑 **worker を 1 本ずつ別の module として立てる**。
 *
 * ⚠ 壊れの旗（`dbCorrupt`）は worker の module の変数で、一度立つと下ろさない。
 *   本物の作り直しは**新しい worker** で開き直す（`main.ts` の `reopenStorage`）ので、
 *   test も新しい module で代える ── 同じ module を使い回すと、新しい DB への書き込みまで
 *   「壊れているので書けません」と断られる（1 稿目で踏んだ）。
 */
async function spawnWorker(): Promise<Req> {
  const mySelf: {
    onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
  } = { onmessage: null };
  (globalThis as unknown as Record<string, unknown>).self = mySelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  vi.resetModules();
  await import('../../src/adapter/platform/storage/storage-worker');
  return ((req: StorageRequest) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) =>
        resp.ok ? resolve(resp.result as never) : reject(new Error(resp.error)),
      );
      mySelf.onmessage!({ data: { id, req } });
    })) as Req;
}

const CID = 'c1';
const entry = (lid: string, body: string, order: number) => ({
  lid,
  title: `題 ${lid}`,
  archetype: 'text',
  body,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
});

/** IndexedDB の代わり。 */
const blobs = new Map<string, Blob>([
  ['k1', new Blob(['PNGBYTES'], { type: 'image/png' })],
  ['k2', new Blob(['hello'], { type: 'text/plain' })],
]);

type RawDb = {
  exec: (o: { sql: string; callback?: (r: unknown[]) => void; rowMode?: 'array' }) => void;
  selectValue: (sql: string) => unknown;
  close: () => void;
};
type Sqlite = {
  oo1: { DB: new () => RawDb & { pointer: number } };
  capi: Record<string, (...a: never[]) => unknown> & Record<string, number>;
  wasm: { allocFromTypedArray: (a: Uint8Array) => number };
};

async function openRaw(image: Uint8Array): Promise<RawDb> {
  const api = (await sqlite3InitModule()) as unknown as Sqlite;
  const p = api.wasm.allocFromTypedArray(image);
  const d = new api.oo1.DB();
  const rc = (api.capi.sqlite3_deserialize as unknown as (...a: unknown[]) => number)(
    d.pointer,
    'main',
    p,
    image.length,
    image.length,
    (api.capi.SQLITE_DESERIALIZE_FREEONCLOSE as number) |
      (api.capi.SQLITE_DESERIALIZE_RESIZEABLE as number),
  );
  expect(rc).toBe(0);
  return d;
}

/** 全部の索引（entries / relations / revisions）の root page を潰す。表の本体には触らない。 */
async function breakIndexes(image: Uint8Array): Promise<{ image: Uint8Array; broken: number }> {
  const raw = await openRaw(image.slice());
  const roots: number[] = [];
  raw.exec({
    sql: `SELECT rootpage FROM sqlite_schema
           WHERE type='index' AND tbl_name IN ('entries','relations','revisions') AND rootpage > 1`,
    rowMode: 'array',
    callback: (r) => roots.push(Number(r[0])),
  });
  const pageSize = Number(raw.selectValue('PRAGMA page_size'));
  raw.close();
  const out = image.slice();
  for (const root of roots) {
    // ⚠ 1 稿目は先頭 12 バイトの後ろ 400 バイトだけ潰したが、行が少ない索引は
    //   セルが page の末尾に在るので**壊れなかった**（前提の test が教えた）── page 全体を潰す
    const off = (root - 1) * pageSize;
    for (let i = 0; i < pageSize; i += 1) out[off + i] = 0x5a;
  }
  return { image: out, broken: roots.length };
}

let brokenImage: Uint8Array;
let originalRevisionBodies: string[] = [];

beforeAll(async () => {
  const request = await spawnWorker();

  // ── 健全な DB を作る（実物の op だけで。手で SQL を打たない）
  await request({ op: 'init', dbName: 'rb-seed', memory: true });
  await request({ op: 'openContainer', cid: CID, title: 'わたしの PKC' });
  await request({
    op: 'bulkUpsertEntries',
    cid: CID,
    entries: [
      entry('a1', '# A\n', 30),
      entry('b2', '# B 版1\n', 10),
      entry('c3', '# C\n', 20),
      // 🔴 あとでゴミ箱へ移すノート(台帳 #1852 束 F2 / 依頼 119-1 A)
      entry('d4', '# D 版1\n', 40),
    ],
  });
  await request({
    op: 'bulkUpsertRelations',
    cid: CID,
    relations: [
      { id: 'r-parent', fromLid: 'a1', toLid: 'b2', kind: 'structural' },
      { id: 'r-link', fromLid: 'b2', toLid: 'c3', kind: 'semantic' },
      // ゴミ箱のノートへのつながり(ゴミ箱の間も残る)
      { id: 'r-trash', fromLid: 'a1', toLid: 'd4', kind: 'semantic' },
    ],
  });
  for (const body of ['# D 版2\n足した\n', '# D 版3\nさらに足した\n']) {
    await request({ op: 'upsertEntry', cid: CID, entry: entry('d4', body, 40), checkpoint: true });
  }
  await request({ op: 'deleteEntry', cid: CID, lid: 'd4' });
  // 🔴 システムのメッセージ(作り直しの後も戻る)
  await request({ op: 'appendMessage', cid: CID, lid: 'sys-messages', title: 'メッセージ', section: '## 知らせ\n', cap: 100000 });
  // 履歴: b2 を 2 回書き換える（checkpoint で版が積まれる）
  for (const body of ['# B 版2\n本文を足した\n', '# B 版3\nさらに足した\n']) {
    await request({
      op: 'upsertEntry',
      cid: CID,
      entry: entry('b2', body, 10),
      checkpoint: true,
    });
  }
  await request({ op: 'putAssetMeta', cid: CID, meta: { key: 'k1', mime: 'image/png', size: 8 } });
  await request({ op: 'putAssetMeta', cid: CID, meta: { key: 'k2', mime: 'text/plain', size: 5 } });
  await request({
    op: 'putTagColor',
    cid: CID,
    key: tagColorKey('仕事')!,
    tag: '仕事',
    color: '#ff0000',
  });

  const metas = await request({ op: 'listRevisionMetas', cid: CID, entryLid: 'b2' });
  originalRevisionBodies = [];
  for (const m of metas) {
    originalRevisionBodies.push((await request({ op: 'getRevision', cid: CID, id: m.id }))!.body);
  }

  const { image } = await request({ op: 'exportImage' });
  const b = await breakIndexes(image);
  expect(b.broken, '壊す索引を 1 つも見つけられていない（壊し方が効いていない）').toBeGreaterThan(3);
  brokenImage = b.image;
}, 60_000);

describe('🔴 索引だけ壊れた DB を作り直す（#1087）', () => {
  it('🔴 前提（実測）: 索引を使う形は rc 11、NOT INDEXED の表走査は全行読める', async () => {
    const raw = await openRaw(brokenImage);
    // 壊れていること（対照群）
    expect(() =>
      raw.selectValue("SELECT count(*) FROM relations WHERE cid='c1' AND from_lid='a1'"),
    ).toThrow(/malformed|corrupt|11/i);
    // 読めること
    expect(raw.selectValue('SELECT count(*) FROM relations NOT INDEXED')).toBe(3); // 2 + ゴミ箱のノートへの 1
    expect(Number(raw.selectValue('SELECT count(*) FROM revisions NOT INDEXED'))).toBeGreaterThan(1);
    // 3 件のノート + システムのメッセージ 1 件(d4 はゴミ箱へ移して entries から消えている)
    expect(raw.selectValue('SELECT count(*) FROM entries NOT INDEXED')).toBe(4);
    raw.close();
  });

  it('🔴 つながり・履歴・添付の登録行・色が戻り、書き出しに添付が入る', async () => {
    // ── 壊れた DB を開く（専用の worker）
    const request = await spawnWorker();
    await request({ op: 'init', dbName: 'rb-broken', memory: true, image: brokenImage });
    /** 開き直した後の worker（`reopenStorage` が立てる）。 */
    let after: Req | null = null;
    const reopened = (): Req => {
      if (after === null) throw new Error('開き直す前に書こうとした');
      return after;
    };

    // 🔑 拾い出しの新しい 2 つの口が、壊れた DB から実際に読めている（作り直しの前に単体で見る）
    const rels = await request({ op: 'rescueRelations', afterRowid: 0, chunks: 2 });
    expect(rels.rows.map((r) => r.id).sort(), 'つながりを拾えていない').toEqual(['r-link', 'r-parent', 'r-trash']);
    const revs = await request({ op: 'rescueRevisions', afterRowid: 0, chunks: 2 });
    expect(revs.rows.length, '履歴を拾えていない').toBeGreaterThan(1);
    // 🔴 ノートの並びと時刻も拾えている(#1087)。⚠ 並びは 30/10/20 ── 拾った順(1/2/3)と別の値にしてある
    const ents = await request({ op: 'rescueEntries', afterRowid: 0, chunks: 2 });
    expect(
      Object.fromEntries(ents.rows.map((r) => [r.lid, r.entryOrder])),
      '並びを拾えていない',
    ).toEqual({ a1: 30, b2: 10, c3: 20 });
    for (const r of ents.rows) {
      expect(r.createdAt, `${r.lid}: 作成時刻を拾えていない`).toMatch(/^\d{4}-\d{2}-\d{2} /);
      expect(r.updatedAt, `${r.lid}: 更新時刻を拾えていない`).toMatch(/^\d{4}-\d{2}-\d{2} /);
    }

    let archive: Blob | null = null;
    let fresh: ResultMap['init'] | null = null;
    const report = await rebuildContainer(CID, 'わたしの PKC', {
      holdsWriterLease: () => true,
      pick: (afterRowid, chunks) => request({ op: 'rescueEntries', afterRowid, chunks }),
      pickSystem: (afterRowid, chunks) => request({ op: 'rescueEntries', afterRowid, chunks, realm: 'system' }),
      pickRelations: (afterRowid, chunks) => request({ op: 'rescueRelations', afterRowid, chunks }),
      pickRevisions: (afterRowid, chunks) => request({ op: 'rescueRevisions', afterRowid, chunks }),
      writeTrash: async (cid, notes) => {
        const out = await reopened()({
          op: 'restoreTrashNotes',
          cid,
          notes: notes.map((n) => ({
            entryLid: n.lid,
            title: n.title,
            archetype: n.archetype,
            body: n.body,
            trashedAt: n.trashedAt,
            entryCreatedAt: n.createdAt,
            entryUpdatedAt: n.updatedAt,
            entryOrder: n.entryOrder,
            rows: n.rows.map((r) => ({ ...r })),
          })),
        });
        return { restored: notes.length - out.skippedEntries.length };
      },
      readTagColors: () => request({ op: 'listTagColors', cid: CID }),
      assets: {
        listKeys: async () => [...blobs.keys()],
        get: async (_c, key) => blobs.get(key) ?? null,
      },
      saveArchive: async (source) => {
        archive = (await writeArchive(source, '2026-10-14T00:00:00.000Z')).blob;
      },
      // node には OPFS が無い ── 「捨てて開き直す」は close → 新しい init で代える
      wipeStorage: async () => {
        await request({ op: 'close' });
        return { wiped: true, note: null };
      },
      reopenStorage: async () => {
        after = await spawnWorker();
        fresh = await after({ op: 'init', dbName: 'rb-fresh', memory: true });
        return { fallbackReason: fresh.fallbackReason };
      },
      openContainer: async (cid, title) => {
        await reopened()({ op: 'openContainer', cid, title });
      },
      writeEntries: async (cid, entries) => {
        await reopened()({ op: 'bulkUpsertEntries', cid, entries: [...entries] });
      },
      writeRelations: async (cid, relations) => {
        await reopened()({
          op: 'bulkUpsertRelations',
          cid,
          relations: relations.map((r) => ({
            id: r.id,
            fromLid: r.fromLid,
            toLid: r.toLid,
            kind: r.kind,
          })),
        });
      },
      writeRevisions: async (cid, chains) => {
        const out = await reopened()({
          op: 'restoreRevisionChains',
          cid,
          chains: [...chains].map(([entryLid, rows]) => ({
            entryLid,
            rows: rows.map((r) => ({
              revOrder: r.revOrder,
              createdAt: r.createdAt,
              title: r.title,
              archetype: r.archetype,
              kind: r.kind,
              snapshot: r.snapshot,
              contentHash: r.contentHash,
            })),
          })),
        });
        return { added: out.added, broken: out.brokenChains.length };
      },
      writeAssetMetas: async (cid, metas) => {
        for (const meta of metas) await reopened()({ op: 'putAssetMeta', cid, meta });
      },
      writeTagColors: async (cid, colors) => {
        for (const e of colors) {
          await reopened()({
            op: 'putTagColor',
            cid,
            key: tagColorKey(e.tag)!,
            tag: e.tag,
            color: e.color,
          });
        }
      },
      forgetLocal: () => {},
      announceWiped: () => {},
    });

    expect(fresh, '開き直していない').not.toBeNull();
    expect(report.outcome, `建て直せていない: ${report.error ?? ''}`).toBe('rebuilt');
    expect(report.restored).toBe(3);
    expect(report.extrasPartial, '読めたのに「読めなかった」と言っている').toBe(false);

    const q = reopened();
    // ── ① 添付の登録行（バックアップに添付が 0 件で出ていた）
    const metas = await q({ op: 'listAssetMetas', cid: CID });
    expect(metas.map((m) => m.key), '添付の登録行が戻っていない').toEqual(['k1', 'k2']);
    expect(metas.find((m) => m.key === 'k1')).toMatchObject({ mime: 'image/png', size: 8, hash: null });

    // ── ② 色
    expect(await q({ op: 'listTagColors', cid: CID }), 'タグの色が消えている').toEqual([
      { tag: '仕事', color: '#ff0000' },
    ]);

    // ── ③ つながり（フォルダの居場所を含む）
    const relations = await q({ op: 'listRelations', cid: CID });
    expect(relations.map((r) => `${r.id}:${r.kind}:${r.from_lid}>${r.to_lid}`).sort()).toEqual([
      'r-link:semantic:b2>c3',
      'r-parent:structural:a1>b2',
      // 🔴 ゴミ箱のノートへのつながりも戻る(台帳 #1852 束 F2)
      'r-trash:semantic:a1>d4',
    ]);

    // ── ④ 履歴（各版の本文が元と同じ）
    const metasAfter = await q({ op: 'listRevisionMetas', cid: CID, entryLid: 'b2' });
    const bodies: string[] = [];
    for (const m of metasAfter) {
      bodies.push((await q({ op: 'getRevision', cid: CID, id: m.id }))!.body);
    }
    expect(originalRevisionBodies.length, '前提: 元の履歴が 2 版以上ある').toBeGreaterThan(1);
    expect(bodies, '履歴の各版が元と違う').toEqual(originalRevisionBodies);
    expect(report.revisionsRestored).toBe(originalRevisionBodies.length);

    // ── ④' 🔴 ゴミ箱のノート(台帳 #1852 束 F2 / 依頼 119-1 A)── 一覧には出ず、ゴミ箱の中へ戻る。版の中身も元と同じ
    expect(report.trashRestored, 'ゴミ箱のノートが戻っていない').toBe(1);
    expect((await q({ op: 'listEntryMetas', cid: CID })).map((m) => m.lid).sort(), 'ゴミ箱のノートが一覧に出た').toEqual([
      'a1',
      'b2',
      'c3',
    ]);
    const trash = (await q({ op: 'listTrash', cid: CID })).filter((t) => t.entry_lid === 'd4');
    expect(trash).toHaveLength(1);
    const head = (await q({ op: 'getRevision', cid: CID, id: trash[0]!.id }))!;
    expect(head.body).toBe('# D 版3\nさらに足した\n');
    expect(head.entryOrder, 'ゴミ箱へ移す前の並びの位置が残っていない').toBe(40);
    expect(head.entryCreatedAt, '作成日の控えが残っていない').toMatch(/^\d{4}-\d{2}-\d{2} /);
    const trashMetas = await q({ op: 'listRevisionMetas', cid: CID, entryLid: 'd4' });
    const trashBodies: string[] = [];
    for (const m of trashMetas) trashBodies.push((await q({ op: 'getRevision', cid: CID, id: m.id }))!.body);
    expect(trashBodies, 'ゴミ箱のノートの履歴が元と違う').toEqual(['# D 版3\nさらに足した\n', '# D 版2\n足した\n', '# D 版1\n']);

    // ── ④'' 🔴 システムのメッセージも戻る(同じ領域へ。一覧の件数には数えない)
    expect(report.systemRestored).toBe(1);
    const sysAfter = await q({ op: 'listSystemEntries', cid: CID });
    expect(sysAfter.map((e) => e.lid)).toEqual(['sys-messages']);
    expect(await q({ op: 'getBody', cid: CID, lid: 'sys-messages' })).toBe('## 知らせ\n');

    // ── ⑤ 作り直した後の書き出し（全体）に添付が入る
    const source: ArchiveSource = {
      cid: CID,
      title: 't',
      listEntryMetas: async () =>
        (await q({ op: 'listEntryMetas', cid: CID })).map((m) => ({
          lid: m.lid,
          title: m.title,
          archetype: m.archetype,
          created_at: null,
          updated_at: null,
          entry_order: m.entry_order,
          status: null,
          date: null,
          archived: 0,
        })),
      listBodies: async () => {
        const rows: Array<{ lid: string; body: string }> = [];
        for (const m of await q({ op: 'listEntryMetas', cid: CID })) {
          rows.push({ lid: m.lid, body: (await q({ op: 'getBody', cid: CID, lid: m.lid })) ?? '' });
        }
        return { rows, done: true };
      },
      listRelations: async () => q({ op: 'listRelations', cid: CID }),
      listAssetMetas: () => q({ op: 'listAssetMetas', cid: CID }),
      getAssetBlob: async (key) => blobs.get(key) ?? null,
      listRevisionLids: () => q({ op: 'listRevisionLids', cid: CID }),
      getRevisionChain: async (lid) =>
        (await q({ op: 'exportRevisionChain', cid: CID, entryLid: lid })).map((r) => ({
          revOrder: r.revOrder,
          createdAt: r.createdAt,
          title: r.title,
          archetype: r.archetype,
          kind: r.kind,
          snapshot: r.snapshot,
          contentHash: r.contentHash,
        })),
    };
    const exported = await readArchive((await writeArchive(source, '2026-10-14T00:00:00.000Z')).blob);
    expect([...exported.assetSources.keys()].sort(), '作り直しの後のバックアップに添付が入らない').toEqual([
      'k1',
      'k2',
    ]);
    expect(exported.relations.length).toBe(2); // 生きた同士(ゴミ箱に触る物は trashRelations)

    // ── ⑥ 保険の zip（捨てる前に落としたもの）にも、つながりと履歴と添付が入っている
    expect(archive, 'zip が落とされていない').not.toBeNull();
    const rescuedZip = await readArchive(archive!);
    expect(rescuedZip.relations.map((r) => r.id).sort()).toEqual(['r-link', 'r-parent']);
    // 🔴 保険の zip にもゴミ箱のノートが入る(落ちたときに zip から戻せる)。メッセージは入らない
    expect(rescuedZip.trash.map((t) => t.lid)).toEqual(['d4']);
    expect(rescuedZip.trashRelations.map((r) => r.id)).toEqual(['r-trash']);
    expect(rescuedZip.entries.map((e) => e.lid).sort()).toEqual(['a1', 'b2', 'c3']);
    expect(rescuedZip.revisions?.length ?? 0, 'zip に履歴が入っていない').toBeGreaterThan(0);
    expect([...rescuedZip.assetSources.keys()].sort()).toEqual(['k1', 'k2']);
  }, 60_000);
});
