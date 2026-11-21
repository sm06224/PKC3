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
 * c1(使っているワークスペース)と別のワークスペースを持つ DB に、同期の行と対照の行を足して返す。
 * ⚠ 画像から開いた DB(memdb)は、確定させない transaction の中の状態が画像に出ない(既知: 本番の OPFS の経路ではない)。
 *   本番と同じ経路を通すため、素の DB に直に足す。
 */
async function seeded(): Promise<{ w: Worker; other: string }> {
  const w = await spawn();
  await w.request({ op: 'init', dbName: 'sy1', memory: true });
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  const { cid: other } = await w.request({ op: 'createWorkspace', title: '別' });
  const mod = (await import('../../src/adapter/platform/storage/storage-worker')) as unknown as {
    execSqlForTest: (sql: string, bind?: unknown[]) => void;
  };
  const put = (scope: string, k: string, v: string): void =>
    mod.execSqlForTest('INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)', [scope, k, v]);
  put('__sync__', 'device', '0123456789abcdef');
  put('__sync__', 'seq', '7');
  put('__sync__:c1', 'tomb:e1', '{}');
  put(`__sync__:${other}`, 'tomb:e2', '{}');
  put(`__sync__:${other}`, 'base:0123456789abcdef', '{}');
  put('keep-me', 'k', 'v');
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
});

describe('バックアップの書き出しは設定の表を読まない', () => {
  it('④ pkc3-archive の書き出し元は設定の行を扱わず、__sync__ の字も出てこない', () => {
    const src = readFileSync('src/features/export/pkc3-archive.ts', 'utf8');
    expect(src.includes('__sync__')).toBe(false);
    expect(/FROM settings|SELECT[^;]*\bsettings\b/i.test(src)).toBe(false);
    // 対照: 書き出しの入り口(`ArchiveSource`)が名指しで持つ設定由来の物は タグの色・色ラベル・ピン留めだけ
    expect(src.includes('listTagColors')).toBe(true);
    expect(src.includes('listNoteLabels')).toBe(true);
  });
});
