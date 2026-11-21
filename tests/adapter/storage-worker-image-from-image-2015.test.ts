/** @vitest-environment node */
/**
 * 🔴 **画像から開いた DB でも、人に渡す画像に「除いた行」が入らない**(#2015)。
 *
 * 可搬 HTML は DB 画像を流し込んだ memdb で動く。memdb への `SQLITE_SERIALIZE_NOCOPY` は **DB が持つバッファそのもの**を返し、
 * 確定していない transaction の変更(pager の中の dirty ページ)は含まれない。直す前は、`withMessagesRemoved` が
 * 消した行(別のワークスペース / メッセージ / `__sync__`)が、画像から開いた DB でだけ画像に残った。
 *
 * 対照群: 素の `:memory:` から始めた DB / 除かない `exportImage` / `subsetImage`(どれも画像から開いた DB で同じに検査する)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';
import { formatMessageSection, SYSTEM_JOB_LID, SYSTEM_MESSAGE_LID } from '../../src/features/message/message-log';

type Op = StorageRequest['op'];
interface Worker {
  request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  close(): Promise<void>;
}
type RawDb = {
  close: () => void;
  pointer: number;
  selectValue: (sql: string, bind?: unknown[]) => unknown;
};
type Sqlite = {
  oo1: { DB: new (f: string, m?: string) => RawDb };
  capi: Record<string, (...a: never[]) => unknown>;
  wasm: Record<string, (...a: never[]) => unknown>;
};

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

async function openRaw(image: Uint8Array): Promise<RawDb> {
  api ??= (await sqlite3InitModule()) as unknown as Sqlite;
  const raw = new api.oo1.DB(':memory:', 'c');
  const p = (api.wasm.allocFromTypedArray as unknown as (x: Uint8Array) => number)(image);
  (api.capi.sqlite3_deserialize as unknown as (...x: unknown[]) => number)(raw.pointer, 'main', p, BigInt(image.byteLength), BigInt(image.byteLength), 1 | 2);
  return raw;
}

interface Counts {
  containers: number;
  otherEntries: number;
  sysMessages: number;
  sync: number;
  keep: number;
  keepEntry: number;
}
async function count(image: Uint8Array, other: string): Promise<Counts> {
  const raw = await openRaw(image);
  try {
    const n = (sql: string, bind?: unknown[]): number => Number(raw.selectValue(sql, bind));
    return {
      containers: n('SELECT count(*) FROM containers'),
      otherEntries: n('SELECT count(*) FROM entries WHERE cid = ?', [other]),
      sysMessages: n(`SELECT count(*) FROM entries WHERE realm = 'system' AND lid IN (?, ?)`, [SYSTEM_MESSAGE_LID, SYSTEM_JOB_LID]),
      sync: n(`SELECT count(*) FROM settings WHERE scope = '__sync__' OR substr(scope, 1, 9) = '__sync__:'`),
      keep: n(`SELECT count(*) FROM settings WHERE scope = 'keep-me'`),
      keepEntry: n(`SELECT count(*) FROM entries WHERE cid = 'c1' AND lid = 'e1'`),
    };
  } finally {
    raw.close();
  }
}

const entry = (lid: string) => ({ lid, title: '題', archetype: 'text' as const, body: `本文 ${lid}\n`, entryOrder: 1, status: null, date: null, archived: false });

/** 2 ワークスペース + メッセージ + `__sync__` を持つ DB。`fromImage` なら、いったん画像にして別の worker で開き直した DB(可搬 HTML と同じ) */
async function seeded(fromImage: boolean): Promise<{ w: Worker; other: string }> {
  let w = await spawn();
  await w.request({ op: 'init', dbName: 'i2015', memory: true });
  if (fromImage) {
    // 空の DB の画像 → 別の worker に流し込む(本番の可搬 HTML の読み込みと同じ道)
    const { image } = await w.request({ op: 'exportImage' });
    w = await spawn();
    await w.request({ op: 'init', dbName: 'i2015', memory: true, image });
  }
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  await w.request({ op: 'upsertEntry', cid: 'c1', entry: entry('e1'), checkpoint: false });
  const other = (await w.request({ op: 'createWorkspace', title: '別' })).cid;
  await w.request({ op: 'upsertEntry', cid: other, entry: entry('o1'), checkpoint: false });
  const sec = (kind: 'problem' | 'job', i: number) =>
    formatMessageSection({ at: new Date(Date.UTC(2026, 9, 2, 12, 0, i)).toISOString(), kind, source: 'status', text: '知らせ' });
  await w.request({ op: 'appendMessage', cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: sec('problem', 1), cap: 500 });
  await w.request({ op: 'appendMessage', cid: 'c1', lid: SYSTEM_JOB_LID, title: '処理の記録', section: sec('job', 2), cap: 500 });
  const mod = (await import('../../src/adapter/platform/storage/storage-worker')) as unknown as {
    execSqlForTest: (sql: string, bind?: unknown[]) => void;
  };
  for (const [s, k] of [['__sync__', 'device'], ['__sync__', 'seq'], ['__sync__:c1', 'tomb:e1'], [`__sync__:${other}`, 'tomb:o1'], ['keep-me', 'k']]) {
    mod.execSqlForTest('INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)', [s, k, 'v']);
  }
  // 現在の(開いている)ワークスペースは c1
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  return { w, other };
}

describe.each([
  ['素の :memory:', false],
  ['画像から開いた DB(可搬 HTML の経路)', true],
])('人に渡す画像: %s', (_name, fromImage) => {
  it('🔴 withoutMessages の画像に、除いた行(他のワークスペース / メッセージ / __sync__)が入らない。対照: ふつうの画像には全部ある', async () => {
    const { w, other } = await seeded(fromImage);
    const full = await count((await w.request({ op: 'exportImage' })).image, other);
    // 対照群が空振りでないこと
    expect(full.containers).toBeGreaterThanOrEqual(2);
    expect(full.otherEntries).toBeGreaterThan(0);
    expect(full.sysMessages).toBe(2);
    expect(full.sync).toBe(4);

    const lean = await count((await w.request({ op: 'exportImage', withoutMessages: true })).image, other);
    expect(lean.containers, '他のワークスペースが入っている').toBe(1);
    expect(lean.otherEntries, '他のワークスペースのノートが入っている').toBe(0);
    expect(lean.sysMessages, 'メッセージが入っている').toBe(0);
    expect(lean.sync, '__sync__ が入っている').toBe(0);
    expect(lean.keep, '他の設定が欠けた').toBe(1);
    expect(lean.keepEntry, 'ノートが欠けた').toBe(1);

    // 元の DB は動かない(元を触らない保証)
    const after = await count((await w.request({ op: 'exportImage' })).image, other);
    expect(after).toEqual(full);
  }, 60_000);

  it('🔴 subsetImage(only)は選んだノートだけ(他のワークスペース・メッセージ・__sync__ は無い)で、元は動かない', async () => {
    const { w, other } = await seeded(fromImage);
    const before = await count((await w.request({ op: 'exportImage' })).image, other);
    const sub = await count(
      (await w.request({ op: 'exportImage', only: { cid: 'c1', lids: ['e1'], assetKeys: [] } })).image,
      other,
    );
    expect(sub.containers).toBe(1);
    expect(sub.otherEntries).toBe(0);
    expect(sub.sysMessages).toBe(0);
    expect(sub.sync).toBe(0);
    expect(sub.keepEntry).toBe(1);
    expect(await count((await w.request({ op: 'exportImage' })).image, other)).toEqual(before);
  }, 60_000);
});

/**
 * 🔴 **除いた行の字が、画像の生のバイト列に残らない**(#2015 レビュー ⚠1 / ⚠2)。
 * 行を数えるだけでは、空きページ・全文検索の索引の区画(trigram の断片)に残った字を見逃す。
 * 目印は 3KB 超(overflow ページに載る大きさ)の繰り返し。小文字の 3 字の断片(索引はこちらで持つ)も探す。
 */
const MARK = 'ZZQXMARKER';
const FRAGMENTS = ['zzq', 'zqx', 'qxm', 'xma'];
const BIG = MARK.repeat(400);

function scan(image: Uint8Array): { full: number; frags: Record<string, number> } {
  const text = Buffer.from(image).toString('latin1');
  const n = (needle: string): number => text.split(needle).length - 1;
  const frags: Record<string, number> = {};
  for (const f of FRAGMENTS) frags[f] = n(f);
  return { full: n(MARK), frags };
}

interface Hooks {
  setCopyOpenedHookForTest: (h: ((c: { close: () => void }) => void) | null) => void;
}

async function seededMarked(fromImage: boolean): Promise<{ w: Worker; other: string }> {
  const { w, other } = await seeded(fromImage);
  await w.request({ op: 'upsertEntry', cid: other, entry: { ...entry('o2'), body: BIG }, checkpoint: false });
  await w.request({
    op: 'appendMessage',
    cid: 'c1',
    lid: SYSTEM_MESSAGE_LID,
    title: 'メッセージ',
    section: formatMessageSection({ at: new Date(Date.UTC(2026, 9, 2, 12, 0, 9)).toISOString(), kind: 'problem', source: 'status', text: BIG }),
    cap: 500,
  });
  return { w, other };
}

describe.each([
  ['素の :memory:', false],
  ['画像から開いた DB', true],
])('生のバイト列: %s', (_n, fromImage) => {
  it('🔴 withoutMessages の画像に目印も 3 字の断片も無い。対照: ふつうの画像にはある', async () => {
    const { w } = await seededMarked(fromImage);
    const full = scan((await w.request({ op: 'exportImage' })).image);
    expect(full.full, '対照群に目印が無い(空振り)').toBeGreaterThanOrEqual(2);
    for (const f of FRAGMENTS) expect(full.frags[f], `対照群に断片 ${f} が無い`).toBeGreaterThan(0);

    const lean = scan((await w.request({ op: 'exportImage', withoutMessages: true })).image);
    expect(lean.full, '目印が残った').toBe(0);
    for (const f of FRAGMENTS) expect(lean.frags[f], `断片 ${f} が残った`).toBe(0);
  }, 60_000);

  it('🔴 写しは成功でも失敗でも閉じる / 確保の失敗は言い直す / 元は動かない', async () => {
    const { w, other } = await seededMarked(fromImage);
    const hooks = (await import('../../src/adapter/platform/storage/storage-worker')) as unknown as Hooks;
    const before = await count((await w.request({ op: 'exportImage' })).image, other);
    let closed = 0;
    let opened = 0;
    const spy = (c: { close: () => void }): void => {
      opened += 1;
      const orig = c.close.bind(c);
      c.close = () => {
        closed += 1;
        orig();
      };
    };
    try {
      hooks.setCopyOpenedHookForTest(spy);
      await w.request({ op: 'exportImage', withoutMessages: true });
      expect([opened, closed], '成功で閉じていない').toEqual([1, 1]);

      hooks.setCopyOpenedHookForTest((c) => {
        spy(c);
        throw new Error('注入した失敗');
      });
      await expect(w.request({ op: 'exportImage', withoutMessages: true })).rejects.toThrow('注入した失敗');
      expect([opened, closed], '失敗で閉じていない').toEqual([2, 2]);

      hooks.setCopyOpenedHookForTest((c) => {
        spy(c);
        throw new Error('WasmAllocError: out of memory');
      });
      await expect(w.request({ op: 'exportImage', withoutMessages: true })).rejects.toThrow('大きすぎ');
      expect([opened, closed]).toEqual([3, 3]);
    } finally {
      hooks.setCopyOpenedHookForTest(null);
    }
    expect(await count((await w.request({ op: 'exportImage' })).image, other)).toEqual(before);
  }, 60_000);
});

describe('除く物が無い画像から開いた DB(早期の戻りの経路)', () => {
  it('写しを作らず(閉じる対象が無い)、そのまま画像になる', async () => {
    let w = await spawn();
    await w.request({ op: 'init', dbName: 'i2015', memory: true });
    const { image } = await w.request({ op: 'exportImage' });
    w = await spawn();
    await w.request({ op: 'init', dbName: 'i2015', memory: true, image });
    await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
    await w.request({ op: 'upsertEntry', cid: 'c1', entry: { ...entry('e1'), body: BIG }, checkpoint: false });
    const hooks = (await import('../../src/adapter/platform/storage/storage-worker')) as unknown as Hooks;
    let opened = 0;
    hooks.setCopyOpenedHookForTest(() => void (opened += 1));
    try {
      const lean = (await w.request({ op: 'exportImage', withoutMessages: true })).image;
      expect(opened, '除く物が無いのに写しを作った').toBe(0);
      expect(scan(lean).full, '残す側のノートが欠けた').toBeGreaterThanOrEqual(1);
      expect((await count(lean, 'none')).keepEntry).toBe(1);
    } finally {
      hooks.setCopyOpenedHookForTest(null);
    }
  }, 60_000);
});
