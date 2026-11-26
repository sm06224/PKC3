/** @vitest-environment node */
/**
 * 🔴 **端末間の同期(#2000 段 1)の記録(`settings` の `__sync__` / `__sync__:<cid>`)の扱い**。
 *
 * 守るもの(実物の sqlite で見る):
 *   ① 人に渡す画像(`exportImage` の `withoutMessages`)に `__sync__` 系の行が 1 本も入らない
 *      (端末 id が渡ると、受け取った人の端末が同じ端末と見なされて変更が消える)。対照:ふつうの画像には入っている・他の設定は残る
 *   ② 画像に除く処理は確定させない(書き出し後も元の DB の行は減らない)
 *   ③ ワークスペースの削除で、そのワークスペースの `__sync__:<cid>` だけが消える(端末の行・他のワークスペースの行は残る)
 *   ④ バックアップ(`.pkc3-*.zip`)の書き出しは `settings` の表を読まない
 *      (`pkc3-archive.ts` の `ArchiveSource` に設定の行を返す口が無い ── 型で固定される。ここでは書き出し元のソースに `__sync__` の字が無いことを見る)
 */
import { readFileSync } from 'node:fs';
import { writeArchive, type ArchiveSource } from '../../src/features/export/pkc3-archive';
import { folderSource } from '../../src/features/export/folder-source';
import { singleEntrySource } from '../../src/features/export/single-entry-source';
import { writeMarkdownZip } from '../../src/features/export/pkc3-markdown-zip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];
interface Worker {
  request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  close(): Promise<void>;
}
type RawDb = {
  pointer: number;
  close: () => void;
  exec: (o: string | { sql: string; bind?: unknown[] }) => void;
  selectValue: (sql: string, bind?: unknown[]) => unknown;
  selectObjects: (sql: string, bind?: unknown[]) => Array<Record<string, unknown>>;
};
type Sqlite = { oo1: { DB: new (f: string, m?: string) => RawDb }; capi: Record<string, (...a: never[]) => unknown>; wasm: Record<string, (...a: never[]) => unknown> };

let live: Worker | null = null;
let api: Sqlite | null = null;

async function spawn(): Promise<Worker> {
  if (live) {
    await live.close().catch(() => undefined);
    live = null;
  }
  vi.resetModules();
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: { onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null } = { onmessage: null };
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const send = <O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
      workerSelf.onmessage!({ data: { id, req } });
    });
  const w: Worker = { request: send, close: async () => void (await send({ op: 'close' })) };
  live = w;
  return w;
}

afterEach(async () => {
  if (live) await live.close().catch(() => undefined);
  live = null;
});

async function sqlite(): Promise<Sqlite> {
  api ??= (await sqlite3InitModule()) as unknown as Sqlite;
  return api;
}

/** 画像を生の sqlite で開く(読むだけ)。 */
async function openRaw(image: Uint8Array): Promise<RawDb> {
  const a = await sqlite();
  const raw = new a.oo1.DB(':memory:', 'c');
  const p = (a.wasm.allocFromTypedArray as unknown as (x: Uint8Array) => number)(image);
  (a.capi.sqlite3_deserialize as unknown as (...x: unknown[]) => number)(raw.pointer, 'main', p, BigInt(image.byteLength), BigInt(image.byteLength), 1 | 2);
  return raw;
}

async function syncScopesIn(image: Uint8Array): Promise<string[]> {
  const raw = await openRaw(image);
  try {
    return raw
      .selectObjects(`SELECT scope FROM settings WHERE scope = '__sync__' OR substr(scope, 1, 9) = '__sync__:' ORDER BY scope, k`)
      .map((r) => String(r.scope));
  } finally {
    raw.close();
  }
}

async function otherSettingCount(image: Uint8Array): Promise<number> {
  const raw = await openRaw(image);
  try {
    return Number(raw.selectValue(`SELECT count(*) FROM settings WHERE scope = 'keep-me'`));
  } finally {
    raw.close();
  }
}

/**
 * c1(使っているワークスペース)と別のワークスペースを持つ DB に、同期の行と対照の行を追加して返す。
 * 画像から開いた DB(memdb)の経路は `storage-worker-image-from-image-2015.test.ts`(#2015)が見る。ここは素の DB に直に足す。
 */
async function seeded(opts: { single?: boolean } = {}): Promise<{ w: Worker; other: string }> {
  const w = await spawn();
  await w.request({ op: 'init', dbName: 'sy1', memory: true });
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  const other = opts.single === true ? 'c1' : (await w.request({ op: 'createWorkspace', title: '別' })).cid;
  const mod = (await import('../../src/adapter/platform/storage/storage-worker')) as unknown as {
    execSqlForTest: (sql: string, bind?: unknown[]) => void;
  };
  const put = (scope: string, k: string, v: string): void =>
    mod.execSqlForTest('INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)', [scope, k, v]);
  put('__sync__', 'device', '0123456789abcdef');
  put('__sync__', 'seq', '7');
  put('__sync__:c1', 'tomb:e1', '{}');
  if (opts.single !== true) {
    put(`__sync__:${other}`, 'tomb:e2', '{}');
    put(`__sync__:${other}`, 'base:0123456789abcdef', '{}');
  }
  put('keep-me', 'k', 'v');
  // 🔴 境界の対照: `__sync__` に似ているだけの区画(LIKE の `_` が何にでも当たる書き方だと、これらも消える)
  put('__sync__x', 'k', 'v');
  put('xxsyncxx:c', 'k', 'v');
  return { w, other };
}

describe('同期の記録は人に渡す画像に入らない', () => {
  it('🔴 ①② メッセージ抜きの画像に __sync__ 系の行は 0 本。対照: ふつうの画像には全部ある・他の設定は残る・書き出し後も元は減らない', async () => {
    const { w: b } = await seeded();

    const full = (await b.request({ op: 'exportImage' })).image;
    expect(await syncScopesIn(full), '対照: ふつうの画像に同期の行が無い(検査が空振り)').toHaveLength(5);

    const lean = (await b.request({ op: 'exportImage', withoutMessages: true })).image;
    expect(await syncScopesIn(lean), '同期の行が人に渡る画像に入っている').toEqual([]);
    expect(await otherSettingCount(lean), '他の設定まで消えた').toBe(1);

    const after = (await b.request({ op: 'exportImage' })).image;
    expect(await syncScopesIn(after), '除く処理が確定してしまった').toHaveLength(5);
  }, 60_000);

  it('🔴 ③ ワークスペースの削除で、そのワークスペースの区画だけが消える', async () => {
    const { w: b, other } = await seeded();
    await b.request({ op: 'deleteWorkspace', cid: other });
    const out = (await b.request({ op: 'exportImage' })).image;
    const scopes = await syncScopesIn(out);
    expect(scopes.includes(`__sync__:${other}`), '消したワークスペースの記録が残った').toBe(false);
    expect(scopes.filter((s) => s === '__sync__')).toHaveLength(2); // 端末の行(device / seq)は残る
    expect(scopes.filter((s) => s === '__sync__:c1')).toHaveLength(1); // 別のワークスペースは残る
  }, 60_000);

  it('🔴 ① 早期 return の門: ワークスペース 1 つ・メッセージ 0・同期の行だけでも、人に渡す画像から同期の行が消える', async () => {
    const { w: b } = await seeded({ single: true });
    const full = (await b.request({ op: 'exportImage' })).image;
    // 種の検算: 門の他の 2 項(メッセージ・他のワークスペース)が両方 0 であること(でないと同期の項が空振りする)
    const raw = await openRaw(full);
    try {
      expect(Number(raw.selectValue(`SELECT count(*) FROM entries WHERE realm = 'system'`)), '種: メッセージが在る').toBe(0);
      expect(Number(raw.selectValue(`SELECT count(*) FROM containers`)), '種: ワークスペースが 2 つ以上ある').toBe(1);
    } finally {
      raw.close();
    }
    expect(await syncScopesIn(full), '対照: ふつうの画像に同期の行が無い').toHaveLength(3);
    const lean = (await b.request({ op: 'exportImage', withoutMessages: true })).image;
    expect(await syncScopesIn(lean), '同期の行だけの DB で、門が素通りして人に渡る画像に入った').toEqual([]);
    expect(await otherSettingCount(lean)).toBe(1);
    expect(await syncScopesIn((await b.request({ op: 'exportImage' })).image), '除く処理が確定してしまった').toHaveLength(3);
  }, 60_000);

  it('🔴 境界の対照: `__sync__x` / `xxsyncxx:c` は、画像にも元の DB にも残る(区画の名前は前方一致で厳密に)', async () => {
    const { w: b } = await seeded();
    const decoys = async (image: Uint8Array): Promise<string[]> => {
      const raw = await openRaw(image);
      try {
        return raw
          .selectObjects(`SELECT scope FROM settings WHERE scope IN ('__sync__x', 'xxsyncxx:c') ORDER BY scope`)
          .map((r) => String(r.scope));
      } finally {
        raw.close();
      }
    };
    const lean = (await b.request({ op: 'exportImage', withoutMessages: true })).image;
    expect(await decoys(lean), '似た名前の区画まで画像から消えた').toEqual(['__sync__x', 'xxsyncxx:c']);
    expect(await syncScopesIn(lean)).toEqual([]);
    const after = (await b.request({ op: 'exportImage' })).image;
    expect(await decoys(after), '似た名前の区画が元の DB から消えた').toEqual(['__sync__x', 'xxsyncxx:c']);
  }, 60_000);
});

describe('バックアップの書き出しは設定の表を読まない', () => {
  /** main.ts の書き出し元と同じ配線(worker の読み口をそのまま ArchiveSource に嵌める)。 */
  function workerSource(w: Worker, cid: string): ArchiveSource {
    return {
      cid,
      title: 'unit',
      listEntryMetas: () => w.request({ op: 'listEntryMetas', cid }),
      getBody: async (lid) => (await w.request({ op: 'getBody', cid, lid })) ?? null,
      listBodies: (after, maxBytes) => w.request({ op: 'listBodies', cid, maxBytes, ...(after ? { after } : {}) }),
      listRelations: () => w.request({ op: 'listRelations', cid }),
      listAssetMetas: () => w.request({ op: 'listAssetMetas', cid }),
      getAssetBlob: async () => null,
      listTagColors: () => w.request({ op: 'listTagColors', cid }),
      listNotePins: () => w.request({ op: 'listNotePins', cid }),
      listNoteLabels: () => w.request({ op: 'listNoteLabels', cid }),
      listRevisionLids: () => w.request({ op: 'listRevisionLids', cid }),
      listTrashHeads: () => w.request({ op: 'listTrashHeads', cid }),
      getRevisionChain: (entryLid) => w.request({ op: 'exportRevisionChain', cid, entryLid }),
    };
  }

  it('🔴 ④ 実物の DB に __sync__ の行がある状態で full / part / notes / Markdown の zip を書き出しても、どの byte にも __sync__ と端末 id が出ない', async () => {
    const { w } = await seeded({ single: true });
    const cid = 'c1';
    const put = (lid: string, title: string, archetype: string, body: string, entryOrder: number): Promise<unknown> =>
      w.request({
        op: 'upsertEntry',
        cid,
        entry: { lid, title, archetype, body, entryOrder, status: null, date: null, archived: false },
      } as never);
    await put('f1', 'フォルダ', 'folder', '', 1);
    await put('n1', '記事', 'text', '本文', 2);
    const metas = await w.request({ op: 'listEntryMetas', cid });
    expect(metas.length, '種: ノートが無い(書き出しが空振り)').toBeGreaterThan(0);
    const lid = metas.find((m) => m.archetype !== 'folder')!.lid;
    const folder = metas.find((m) => m.archetype === 'folder')!.lid;
    const base = workerSource(w, cid);

    const blobs: Array<[string, Blob]> = [];
    blobs.push(['full', (await writeArchive(base, '2026-11-21T00:00:00.000Z')).blob]);
    blobs.push(['full+readable', (await writeArchive({ ...base, readableNotes: true }, '2026-11-21T00:00:00.000Z')).blob]);
    blobs.push(['part', (await writeArchive((await folderSource(base, folder)).source, '2026-11-21T00:00:00.000Z')).blob]);
    blobs.push(['notes', (await writeArchive((await singleEntrySource(base, lid)).source, '2026-11-21T00:00:00.000Z')).blob]);
    blobs.push(['markdown', (await writeMarkdownZip(base, '2026-11-21T00:00:00.000Z')).blob]);

    // 対照: 検査の道具が効くこと(本物の zip で、ノートの本文が byte に出る)
    const dec = new TextDecoder('latin1');
    for (const [kind, blob] of blobs) {
      const text = dec.decode(new Uint8Array(await blob.arrayBuffer()));
      expect(text.length, `${kind}: zip が空`).toBeGreaterThan(100);
      expect(text.startsWith('PK'), `${kind}: zip ではない`).toBe(true);
      expect(text.includes('__sync__'), `${kind}: 同期の区画名が書き出された`).toBe(false);
      expect(text.includes('0123456789abcdef'), `${kind}: 端末 id が書き出された`).toBe(false);
      expect(text.includes('tomb:e1'), `${kind}: 墓標の行が書き出された`).toBe(false);
    }
    const full = dec.decode(new Uint8Array(await blobs[0]![1].arrayBuffer()));
    expect(full.includes('container.json'), '対照: full の zip に container.json が無い(検査が空振り)').toBe(true);
    expect(full.includes('n1'), '対照: ノートが zip に入っていない').toBe(true);
  }, 60_000);

  it('④ 静的な補助: pkc3-archive の書き出しの入り口(ArchiveSource)は設定の表を名指しで持たない', () => {
    const src = readFileSync('src/features/export/pkc3-archive.ts', 'utf8');
    expect(src.includes('__sync__')).toBe(false);
    expect(/FROM settings|SELECT[^;]*\bsettings\b/i.test(src)).toBe(false);
  });
});

describe('🔴 選択同期(#2066 段 5-A)の設定の行', () => {
  const entry = (lid: string) => ({ lid, title: lid, archetype: 'text', body: 'b', entryOrder: 1, status: null, date: null, archived: false });

  it('同期が切の間は 1 行も書かない(設定の op は断る・消しても削除の記録を書かない)/ 入なら書く / 人に渡す画像には入らない', async () => {
    const w = await spawn();
    await w.request({ op: 'init', dbName: 'sel1', memory: true });
    await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
    await w.request({ op: 'syncConfigure', enabled: false });
    await w.request({ op: 'upsertEntry', cid: 'c1', entry: entry('a'), checkpoint: true });
    await w.request({ op: 'upsertEntry', cid: 'c1', entry: entry('b'), checkpoint: true });
    await expect(w.request({ op: 'syncSetSelectiveScope', cid: 'c1', mode: 'selective', add: ['a'] })).rejects.toThrow('端末間の同期がオフ');
    await w.request({ op: 'deleteEntry', cid: 'c1', lid: 'b' });
    expect(await syncScopesIn((await w.request({ op: 'exportImage' })).image), '同期が切なのに同期の行が書かれた').toEqual([]);

    await w.request({ op: 'syncConfigure', enabled: true });
    await w.request({ op: 'syncSetSelectiveScope', cid: 'c1', mode: 'selective', related: 'recursive', add: ['a'] });
    const full = await openRaw((await w.request({ op: 'exportImage' })).image);
    try {
      const ks = full.selectObjects(`SELECT k FROM settings WHERE scope = '__sync__:c1' ORDER BY k`).map((r) => String(r.k));
      expect(ks, '対照: 入なら選択の行が在る').toEqual(['scope:mode', 'scope:related', 'sel:a']);
    } finally {
      full.close();
    }
    expect(await syncScopesIn((await w.request({ op: 'exportImage', withoutMessages: true })).image), '選択の行が人に渡る画像に入った').toEqual([]);
    // 既定に戻すと行そのものが消える(読みの既定値の補完で同じ値に見えても、行が残っていれば落ちる)
    await w.request({ op: 'syncSetSelectiveScope', cid: 'c1', mode: 'all', related: '1hop', remove: ['a'] });
    const back = await openRaw((await w.request({ op: 'exportImage' })).image);
    try {
      expect(back.selectObjects(`SELECT k FROM settings WHERE scope = '__sync__:c1'`).map((r) => String(r.k)), '既定値の行が残った').toEqual([]);
    } finally {
      back.close();
    }
  }, 60_000);

  it('🔴 画面の写しの材料(syncSelectiveView。#2066 段 5-B)は読むだけ: 切でも入(全体)でも同期の行を 1 本も作らない', async () => {
    const w = await spawn();
    await w.request({ op: 'init', dbName: 'sel-view', memory: true });
    await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
    await w.request({ op: 'upsertEntry', cid: 'c1', entry: entry('a'), checkpoint: true });
    await w.request({ op: 'syncConfigure', enabled: false });
    expect(await w.request({ op: 'syncSelectiveView', cid: 'c1' }), '切なのに断った / 既定でない').toEqual({
      selective: { mode: 'all', related: '1hop', directLids: [] },
      notes: [],
      relations: [],
      bodyRefs: {},
    });
    await w.request({ op: 'syncConfigure', enabled: true });
    const all = await w.request({ op: 'syncSelectiveView', cid: 'c1' });
    expect(all.notes, 'ワークスペース全体なのにノートを読んだ').toEqual([]);
    expect(await syncScopesIn((await w.request({ op: 'exportImage' })).image), '読むだけの op が同期の行を作った').toEqual([]);
  }, 60_000);

  it('ワークスペースの削除で、そのワークスペースの選択の行も消える(他のワークスペースは残る)', async () => {
    const w = await spawn();
    await w.request({ op: 'init', dbName: 'sel2', memory: true });
    await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
    const other = (await w.request({ op: 'createWorkspace', title: '別' })).cid;
    await w.request({ op: 'syncConfigure', enabled: true });
    await w.request({ op: 'syncSetSelectiveScope', cid: 'c1', mode: 'selective', add: ['a'] });
    await w.request({ op: 'syncSetSelectiveScope', cid: other, mode: 'selective', add: ['z'] });
    await w.request({ op: 'deleteWorkspace', cid: other });
    const scopes = await syncScopesIn((await w.request({ op: 'exportImage' })).image);
    expect(scopes.includes(`__sync__:${other}`), '消したワークスペースの選択の行が残った').toBe(false);
    expect(scopes.filter((s) => s === '__sync__:c1')).toHaveLength(2);
  }, 60_000);

  it('同期の記録を全部消す(syncForget)と、選択の行も消える', async () => {
    const w = await spawn();
    await w.request({ op: 'init', dbName: 'sel3', memory: true });
    await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
    await w.request({ op: 'syncConfigure', enabled: true });
    await w.request({ op: 'syncSetSelectiveScope', cid: 'c1', mode: 'selective', add: ['a'] });
    await w.request({ op: 'syncForget' });
    expect(await syncScopesIn((await w.request({ op: 'exportImage' })).image)).toEqual([]);
  }, 60_000);
});
