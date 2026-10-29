/** @vitest-environment happy-dom */
/**
 * 音源分離モデルの置き場(#674 / #949。レビュー裁定: 端末へ取り込んで残す)。
 *
 * 守りたい主張:
 *  ① 🔴 DB 名は `pkc3-stem-model`(ASR・Office・DuckDB の DB を巻き添えにしない)
 *  ② 🔴 Blob と meta は**同じ tx**(abort したら「入っている」と名乗らない)
 *  ③ 🔴 「入っている」は meta **と** Blob が揃って初めて(片方だけは入っていない)
 *  ④ 消すと両方消える(消えたことを読み直して言える)
 *
 * ⚠ happy-dom に `indexedDB` は無いので、`asr-pack-store.test.ts` と同じ流儀で最小の偽物を差す。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StemModelStore } from '../../src/adapter/platform/stems/stem-model-store';

type Handler = (() => void) | null;

function installFakeIdb(outcome: 'commit' | 'abort') {
  const stores: Record<string, Map<IDBValidKey, unknown>> = { files: new Map(), meta: new Map() };
  const state = { outcome, opened: undefined as string | undefined, writeTx: 0 };
  const makeStore = (name: string, staged: (() => void)[]): IDBObjectStore => {
    const s = stores[name]!;
    const req = (result?: unknown): IDBRequest => {
      const r = { onsuccess: null as Handler, onerror: null as Handler, result, error: null };
      queueMicrotask(() => r.onsuccess?.());
      return r as unknown as IDBRequest;
    };
    return {
      put: (v: unknown, k: IDBValidKey) => {
        staged.push(() => s.set(k, v));
        return req();
      },
      delete: (k: IDBValidKey) => {
        staged.push(() => s.delete(k));
        return req();
      },
      get: (k: IDBValidKey) => req(s.get(k)),
      getKey: (k: IDBValidKey) => req(s.has(k) ? k : undefined),
    } as unknown as IDBObjectStore;
  };
  const db = {
    transaction: (_n: string | string[], mode: IDBTransactionMode) => {
      const staged: (() => void)[] = [];
      const t = {
        oncomplete: null as Handler,
        onerror: null as Handler,
        onabort: null as Handler,
        error: state.outcome === 'abort' ? new Error('QuotaExceededError') : null,
        objectStore: (n: string) => makeStore(n, staged),
      };
      if (mode === 'readwrite') {
        state.writeTx += 1;
        const now = state.outcome;
        queueMicrotask(() => {
          if (now === 'commit') {
            for (const f of staged) f();
            t.oncomplete?.();
          } else t.onabort?.();
        });
      }
      return t as unknown as IDBTransaction;
    },
    objectStoreNames: { contains: () => true },
  };
  vi.stubGlobal('indexedDB', {
    open: (name: string) => {
      state.opened = name;
      const r = { onsuccess: null as Handler, onerror: null as Handler, onupgradeneeded: null as Handler, result: db, error: null };
      queueMicrotask(() => r.onsuccess?.());
      return r;
    },
  });
  return { stores, state };
}

afterEach(() => vi.unstubAllGlobals());

const META = { bytes: 5, url: 'https://huggingface.co/x/m.onnx', installedAt: 1 };

describe('StemModelStore', () => {
  it('① DB 名は pkc3-stem-model。書いて読める(Blob は Blob のまま返る)', async () => {
    const fake = installFakeIdb('commit');
    const store = new StemModelStore();
    await store.put('m', new Blob([new Uint8Array(5)]), META);
    expect(fake.state.opened).toBe('pkc3-stem-model');
    expect(await store.readMeta('m')).toEqual(META);
    const b = await store.readBlob('m');
    expect(b).toBeInstanceOf(Blob);
    expect(b!.size).toBe(5);
    expect(fake.state.writeTx, 'Blob と meta を別々の tx で書いた').toBe(1);
  });

  it('② tx が abort したら、Blob も meta も書かれず、入っているとは読まれない', async () => {
    const fake = installFakeIdb('abort');
    const store = new StemModelStore();
    await expect(store.put('m', new Blob([new Uint8Array(5)]), META)).rejects.toThrow();
    expect(fake.stores['files']!.size).toBe(0);
    expect(fake.stores['meta']!.size).toBe(0);
    expect(await store.readMeta('m')).toBeNull();
  });

  it('③ meta だけ・Blob だけは「入っていない」(片方だけを入っていると言わない)', async () => {
    const fake = installFakeIdb('commit');
    const store = new StemModelStore();
    fake.stores['meta']!.set('a', META);
    expect(await store.readMeta('a'), 'Blob が無いのに入っていると言った').toBeNull();
    fake.stores['files']!.set('b', new Blob(['x']));
    expect(await store.readMeta('b')).toBeNull();
    expect(await store.readBlob('a')).toBeNull();
    // 壊れた meta も入っていない
    fake.stores['meta']!.set('c', { bytes: 'x' });
    fake.stores['files']!.set('c', new Blob(['x']));
    expect(await store.readMeta('c')).toBeNull();
  });

  it('④ 消すと Blob も meta も消え、読み直しても入っていない', async () => {
    installFakeIdb('commit');
    const store = new StemModelStore();
    await store.put('m', new Blob([new Uint8Array(5)]), META);
    expect(await store.readMeta('m')).not.toBeNull();
    await store.remove('m');
    expect(await store.readMeta('m')).toBeNull();
    expect(await store.readBlob('m')).toBeNull();
  });
});
