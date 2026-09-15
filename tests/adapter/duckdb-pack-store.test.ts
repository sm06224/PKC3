/** @vitest-environment happy-dom */
/**
 * DuckDB wasm 一式の置き場(#682 段③a)。
 *
 * 守りたい主張は Office(`office-pack-store.test.ts`)と同じ形:
 *  ① **揃っていない一式は 1 バイトも書かない**(空の一式を拒む)
 *  ② **files と meta は同じ tx**。abort したら「入っている」と名乗らない
 *  ③ **照合材料(sha256)を落とさない**
 *  ④ **meta の有無だけで「入っている」を判定する**(files の残骸だけでは読まない)
 *  ⑤ 🔴 **DB 名は `pkc3-office-pack` ではない**(既存 user の Office 一式を巻き添えにしない)
 *
 * ⚠ happy-dom に `indexedDB` は無いので、`office-pack-store.test.ts` と同じ流儀で
 *   **主張に必要な順序だけ**を再現する最小の偽物を差す(依存を増やさない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuckDbPackStore } from '../../src/adapter/platform/duckdb/duckdb-pack-store';

type Handler = (() => void) | null;

interface FakeStore {
  data: Map<IDBValidKey, unknown>;
  cleared: number;
}

/** tx が commit するか abort するかを切り替えられる偽 IDB。 */
function installFakeIdb(outcome: 'commit' | 'abort'): {
  files: FakeStore;
  meta: FakeStore;
  txCount: number;
  openedName: string | undefined;
} {
  const files: FakeStore = { data: new Map(), cleared: 0 };
  const meta: FakeStore = { data: new Map(), cleared: 0 };
  const state = { txCount: 0, openedName: undefined as string | undefined };
  const pick = (n: string): FakeStore => (n === 'files' ? files : meta);

  const makeStore = (name: string, staged: (() => void)[]): IDBObjectStore => {
    const s = pick(name);
    const req = (result?: unknown): IDBRequest => {
      const r = { onsuccess: null as Handler, onerror: null as Handler, result, error: null };
      queueMicrotask(() => r.onsuccess?.());
      return r as unknown as IDBRequest;
    };
    return {
      // 書きは **staged に積むだけ**。commit するときに初めて反映する
      // ── これが「request success は commit の前」の再現である
      put: (v: unknown, k: IDBValidKey) => { staged.push(() => s.data.set(k, v)); return req(); },
      delete: (k: IDBValidKey) => { staged.push(() => s.data.delete(k)); return req(); },
      clear: () => { staged.push(() => { s.data.clear(); s.cleared += 1; }); return req(); },
      get: (k: IDBValidKey) => req(s.data.get(k)),
    } as unknown as IDBObjectStore;
  };

  const db = {
    transaction: (names: string | string[], mode: IDBTransactionMode) => {
      state.txCount += 1;
      const staged: (() => void)[] = [];
      const t = {
        oncomplete: null as Handler,
        onerror: null as Handler,
        onabort: null as Handler,
        error: outcome === 'abort' ? new Error('QuotaExceededError') : null,
        objectStore: (n: string) => makeStore(n, staged),
      };
      if (mode === 'readwrite') {
        queueMicrotask(() => {
          if (outcome === 'commit') {
            for (const f of staged) f();
            t.oncomplete?.();
          } else {
            // ⚠ **staged を反映せずに abort** ── 半端に書かれないことを再現する
            t.onabort?.();
          }
        });
      }
      return t as unknown as IDBTransaction;
    },
    close: () => {},
    objectStoreNames: { contains: () => true },
  };

  const open = (name: string) => {
    state.openedName = name;
    const r = {
      onsuccess: null as Handler,
      onerror: null as Handler,
      onupgradeneeded: null as Handler,
      result: db,
      error: null,
    };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  };
  vi.stubGlobal('indexedDB', { open });
  return {
    files,
    meta,
    get txCount() { return state.txCount; },
    get openedName() { return state.openedName; },
  };
}

/** 起動に要る 2 file の、最小で「揃っている」一式。 */
function completePack(): Map<string, Blob> {
  return new Map([
    ['duckdb-eh.wasm', new Blob(['wasm-bytes'])],
    ['duckdb-browser-eh.worker.js', new Blob(['worker-bytes'])],
  ]);
}

describe('DuckDbPackStore', () => {
  beforeEach(() => {
    // sha256 は node の webcrypto がそのまま使える
    if (!globalThis.crypto?.subtle) throw new Error('前提: crypto.subtle が要る');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('🔴 DB 名は `pkc3-duckdb-pack`(`pkc3-office-pack` ではない ── 既存 Office 一式を巻き添えにしない)', () => {
    const fake = installFakeIdb('commit');
    void new DuckDbPackStore().readMeta();
    // ⚠ open は非同期(queueMicrotask)なので、呼んだ直後に名前が刺さっている必要がある
    expect(fake.openedName).toBe('pkc3-duckdb-pack');
    expect(fake.openedName).not.toBe('pkc3-office-pack');
  });

  it('揃った一式を入れると、meta と files が commit される', async () => {
    const fake = installFakeIdb('commit');
    const store = new DuckDbPackStore();
    const meta = await store.writeAll(completePack(), { version: '1.33.1-dev57.0' });

    expect(meta.files.length).toBe(2);
    expect(fake.meta.data.size, 'meta が 1 件').toBe(1);
    expect(fake.files.data.size).toBe(2);
    // 🔴 **同じ tx で書いている**ことを直接 pin する ── 分けて書く変異は
    //    「どちらも abort する」偽物では見分けられない ── 数で押さえる
    expect(fake.txCount, 'writeAll が開く書き込み tx は 1 つだけ').toBe(1);
    expect(await store.readMeta()).not.toBeNull();
  });

  it('🔴 空の一式は 1 バイトも書かない', async () => {
    const fake = installFakeIdb('commit');
    await expect(new DuckDbPackStore().writeAll(new Map(), { version: 'v1' })).rejects.toThrow(/空です/);
    expect(fake.txCount, '書き込みの tx を 1 つも開いていない').toBe(0);
  });

  it('🔴 照合材料(sha256)を落とさない ── 全 file が 64 桁の hex を持つ', async () => {
    installFakeIdb('commit');
    const meta = await new DuckDbPackStore().writeAll(completePack(), { version: 'v1' });
    for (const f of meta.files) {
      expect(f.sha256, `${f.name} の sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes, `${f.name} の bytes`).toBeGreaterThan(0);
    }
    // ⚠ 同じ hash が並んでいたら「計算していない」に等しい ── 中身が違えば違う
    expect(new Set(meta.files.map((f) => f.sha256)).size).toBe(meta.files.length);
  });

  it('🔴 tx が abort したら writeAll は失敗し、「入っている」と名乗らない', async () => {
    const fake = installFakeIdb('abort');
    const store = new DuckDbPackStore();
    await expect(store.writeAll(completePack(), { version: 'v1' })).rejects.toThrow();
    expect(fake.meta.data.size, 'meta が書かれていない').toBe(0);
    expect(fake.files.data.size, 'files も書かれていない').toBe(0);
    expect(await store.readMeta(), '入っていないと答える').toBeNull();
  });

  it('meta が無ければ、files が残っていても「入っている」と読まない', async () => {
    const fake = installFakeIdb('commit');
    const store = new DuckDbPackStore();
    await store.writeAll(completePack(), { version: 'v1' });
    fake.meta.data.clear(); // 削除の途中で落ちた状態を作る
    expect(await store.readMeta()).toBeNull();
    expect(fake.files.data.size, '前提: files はまだ在る').toBeGreaterThan(0);
  });

  it('🔴 壊れた meta を「入っている」と読まない(形を検める)', async () => {
    const fake = installFakeIdb('commit');
    const store = new DuckDbPackStore();
    await store.writeAll(completePack(), { version: 'v1' });
    for (const broken of [
      { version: 'v1' }, // files が無い
      { version: 1, installedAt: 0, totalBytes: 0, files: [] }, // version が数値
      { version: 'v1', installedAt: 0, totalBytes: 0, files: [{ name: 'x' }] }, // file が sha256 を持たない
      'installed', // そもそも object ではない
      null,
    ]) {
      fake.meta.data.set('pack', broken);
      expect(await store.readMeta(), `壊れた meta: ${JSON.stringify(broken)}`).toBeNull();
    }
  });

  it('writeAll は旧版を clear してから入れる(file 構成が変わっても混ざらない)', async () => {
    const fake = installFakeIdb('commit');
    const store = new DuckDbPackStore();
    await store.writeAll(completePack(), { version: 'v1' });
    await store.writeAll(completePack(), { version: 'v2' });
    expect(fake.files.cleared, 'writeAll のたびに clear する').toBe(2);
    expect(fake.files.data.size).toBe(2);
  });

  it('remove すると入っていない状態に戻り、file も読めなくなる', async () => {
    const fake = installFakeIdb('commit');
    const store = new DuckDbPackStore();
    await store.writeAll(completePack(), { version: 'v1' });
    expect(await store.readFile('duckdb-eh.wasm')).not.toBeNull();

    await store.remove();
    expect(await store.readMeta()).toBeNull();
    expect(await store.readFile('duckdb-eh.wasm')).toBeNull();
    expect(fake.files.data.size).toBe(0);
  });

  it('readFile は無い名前に null を返す(例外にしない)', async () => {
    installFakeIdb('commit');
    const store = new DuckDbPackStore();
    await store.writeAll(completePack(), { version: 'v1' });
    expect(await store.readFile('no-such-file')).toBeNull();
  });

  it('進捗は file 単位で最後まで刻まれる', async () => {
    installFakeIdb('commit');
    const seen: number[] = [];
    await new DuckDbPackStore().writeAll(completePack(), {
      version: 'v1',
      onProgress: (done, total) => seen.push(done / total),
    });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1), '最後は 1 まで行く').toBe(1);
  });
});
