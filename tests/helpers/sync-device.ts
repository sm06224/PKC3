/**
 * 端末間の同期(#2000 段 2)の test 用: **実物の storage worker(`:memory:` の sqlite)を端末 1 台ぶん起こす**。
 * 2 台(A / B)を同時に起こせる(`vi.resetModules()` で worker の module を別々に読む。`postMessage` は共有の表で id から返す)。
 * `deps()` は `src/adapter/ui/actions/sync-diff.ts` の `SyncDeps` を、この端末の worker に直結して作る。
 */
import { vi } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';
import type { SyncDeps } from '../../src/adapter/ui/actions/sync-diff';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

type Op = StorageRequest['op'];

const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
let installed = false;

export interface SyncDevice {
  name: string;
  cid: string;
  request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  execSql(sql: string, bind?: unknown[]): void;
  blobs: Map<string, Blob>;
  /** 直近に書き出した差分ファイル。 */
  lastDiff: { name: string; blob: Blob } | null;
  reports: string[][];
  failures: string[];
  messages: Array<{ kind: string; text: string }>;
  /** 結果の面に「競合のノートを一覧する」ボタンを出す指示が付いた回数。 */
  conflictButtons: number;
  confirms: string[];
  /** 確認に渡されたボタンの名前(`confirms` と同じ順)。 */
  confirmOpts: Array<{ okLabel?: string; cancelLabel?: string } | undefined>;
  undo: { count: number; run: () => Promise<{ restored: number; skipped: number }>; token: unknown } | null;
  /** 直近の取り消しの控え(本文を持たないことを test が見る)。 */
  undoToken: unknown;
  setEnabled(on: boolean): Promise<void>;
  enabled: boolean;
  /** 親フォルダつきでノートを書く。 */
  put(lid: string, title: string, body: string, opts?: { archetype?: string; parent?: string | null }): Promise<void>;
  del(lid: string): Promise<void>;
  deps(over?: Partial<SyncDeps>): SyncDeps;
  close(): Promise<void>;
}

export async function spawnDevice(name: string, cid = `c-${name}`): Promise<SyncDevice> {
  vi.resetModules();
  const workerSelf: { onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null } = { onmessage: null };
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  if (!installed) {
    installed = true;
    (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb?.(msg);
    };
  }
  const mod = (await import('../../src/adapter/platform/storage/storage-worker')) as { execSqlForTest(sql: string, bind?: unknown[]): void };
  const send = <O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
      workerSelf.onmessage!({ data: { id, req } });
    });
  await send({ op: 'init', dbName: `sync-${name}-${Math.random().toString(36).slice(2)}` });
  await send({ op: 'openContainer', cid, title: `ワークスペース${name}` });
  let n = 0;
  let order = 0;
  const dev: SyncDevice = {
    name,
    cid,
    request: send,
    execSql: (sql, bind) => mod.execSqlForTest(sql, bind),
    blobs: new Map(),
    lastDiff: null,
    reports: [],
    failures: [],
    messages: [],
    conflictButtons: 0,
    confirms: [],
    confirmOpts: [],
    undo: null,
    undoToken: null,
    enabled: false,
    async setEnabled(on) {
      dev.enabled = on;
      await send({ op: 'syncConfigure', enabled: on });
    },
    async put(lid, title, body, opts = {}) {
      const entry: EntryUpsert = {
        lid,
        title,
        archetype: opts.archetype ?? 'text',
        body,
        entryOrder: ++order,
        status: null,
        date: null,
        archived: false,
      };
      await send({
        op: 'upsertEntry',
        cid,
        entry,
        checkpoint: true,
        ...(opts.parent === undefined ? {} : { parent: { parentLid: opts.parent, relationId: `p-${name}-${lid}-${++n}` } }),
      });
    },
    async del(lid) {
      await send({ op: 'deleteEntry', cid, lid });
    },
    deps(over = {}) {
      return {
        cid,
        title: () => `ワークスペース${name}`,
        enabled: () => dev.enabled,
        request: send as SyncDeps['request'],
        settle: async () => {},
        getAssetBlob: async (k) => dev.blobs.get(k) ?? null,
        listStoredBlobKeys: async () => new Set(dev.blobs.keys()),
        putBlob: async (k, b) => void dev.blobs.set(k, b),
        putAssetMeta: async (m) => {
          await send({ op: 'putAssetMeta', cid, meta: m });
        },
        download: (nm, blob) => {
          dev.lastDiff = { name: nm, blob };
        },
        report: (notes, o) => {
          dev.reports.push([...notes]);
          if (o?.conflicts === true) dev.conflictButtons++;
        },
        reportProblem: (m) => void dev.failures.push(m),
        reload: async () => {},
        confirmAction: async (m, opts) => {
          dev.confirms.push(m);
          dev.confirmOpts.push(opts);
          return true;
        },
        genLid: () => `n-${name}-${++n}`,
        now: () => new Date('2026-11-21T09:00:00'),
        rememberUndo: (info) => {
          dev.undo = info;
          dev.undoToken = info.token;
        },
        postMessage: (m) => void dev.messages.push({ kind: m.kind, text: m.text }),
        ...over,
      };
    },
    close: async () => void (await send({ op: 'close' })),
  };
  return dev;
}
