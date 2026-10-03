/** @vitest-environment happy-dom */
/**
 * 音声認識の部品の置き場(#772 段②)。
 *
 * 守りたい主張:
 *  ① 🔴 **DB 名は `pkc3-asr-pack`**(Office / DuckDB の DB を巻き添えにしない)
 *  ② 🔴 **「入っている」は 1 か所で決まる** ── 重みの meta + **実行の部品の meta** が揃って初めて入っている
 *  ③ 🔴 **files と meta は同じ tx** ── abort したら「入っている」と名乗らない
 *  ④ 🔴 **大きさが目録と違えば 1 バイトも書かない** / 読むときも大きさを照合して**理由つきで投げる**
 *  ⑤ 消すとき、**最後の 1 つなら実行の部品も消す**(使い道の無い物を残さない)
 *
 * ⚠ happy-dom に `indexedDB` は無いので、`duckdb-pack-store.test.ts` と同じ流儀で
 *   **主張に必要な順序だけ**を再現する最小の偽物を差す(依存を増やさない)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsrPackStore } from '../../src/adapter/platform/asr/asr-pack-store';
import { AsrPackError } from '../../src/adapter/platform/asr/asr-pack-acquire';

type Handler = (() => void) | null;
interface FakeStore {
  data: Map<IDBValidKey, unknown>;
}

function installFakeIdb(outcome: 'commit' | 'abort'): {
  files: FakeStore;
  meta: FakeStore;
  txCount: () => number;
  /** 書き込み(readwrite)の tx の数。 */
  writeTxCount: () => number;
  openedName: () => string | undefined;
  setOutcome: (o: 'commit' | 'abort') => void;
} {
  const files: FakeStore = { data: new Map() };
  const meta: FakeStore = { data: new Map() };
  const state = { txCount: 0, writeTx: 0, openedName: undefined as string | undefined, outcome };
  const pick = (n: string): FakeStore => (n === 'files' ? files : meta);

  const makeStore = (name: string, staged: (() => void)[]): IDBObjectStore => {
    const s = pick(name);
    const req = (result?: unknown): IDBRequest => {
      const r = { onsuccess: null as Handler, onerror: null as Handler, result, error: null };
      queueMicrotask(() => r.onsuccess?.());
      return r as unknown as IDBRequest;
    };
    return {
      // 書きは **staged に積むだけ**。commit するときに初めて反映する(request success は commit の前)
      put: (v: unknown, k: IDBValidKey) => {
        staged.push(() => s.data.set(k, v));
        return req();
      },
      delete: (k: IDBValidKey) => {
        staged.push(() => s.data.delete(k));
        return req();
      },
      clear: () => {
        staged.push(() => s.data.clear());
        return req();
      },
      get: (k: IDBValidKey) => req(s.data.get(k)),
    } as unknown as IDBObjectStore;
  };

  const db = {
    transaction: (_names: string | string[], mode: IDBTransactionMode) => {
      state.txCount += 1;
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
        const outcomeNow = state.outcome;
        queueMicrotask(() => {
          if (outcomeNow === 'commit') {
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

  vi.stubGlobal('indexedDB', {
    open: (name: string) => {
      state.openedName = name;
      const r = { onsuccess: null as Handler, onerror: null as Handler, onupgradeneeded: null as Handler, result: db, error: null };
      queueMicrotask(() => r.onsuccess?.());
      return r;
    },
  });
  return {
    files,
    meta,
    txCount: () => state.txCount,
    writeTxCount: () => state.writeTx,
    openedName: () => state.openedName,
    setOutcome: (o) => {
      state.outcome = o;
    },
  };
}

const blob = (n: number): Blob => new Blob([new Uint8Array(n)]);
const expectOf = (m: Map<string, Blob>): Map<string, { bytes: number; sha256: string }> =>
  new Map([...m].map(([k, b]) => [k, { bytes: b.size, sha256: 'e'.repeat(64) }]));

const runtimeFiles = (): Map<string, Blob> =>
  new Map([
    ['runtime/transformers.mjs', blob(10)],
    ['runtime/ort-wasm.mjs', blob(11)],
    ['runtime/ort-wasm.wasm', blob(12)],
  ]);
const lightFiles = (): Map<string, Blob> =>
  new Map([
    ['models/openai/whisper-base/config.json', blob(5)],
    ['models/openai/whisper-base/onnx/m.onnx', blob(50)],
  ]);
const accurateFiles = (): Map<string, Blob> =>
  new Map([['models/openai/whisper-small/onnx/m.onnx', blob(80)]]);

describe('AsrPackStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('🔴 DB 名は `pkc3-asr-pack`(Office / DuckDB の DB ではない)', () => {
    const fake = installFakeIdb('commit');
    void new AsrPackStore().readInstalled();
    expect(fake.openedName()).toBe('pkc3-asr-pack');
    expect(fake.openedName()).not.toBe('pkc3-office-pack');
    expect(fake.openedName()).not.toBe('pkc3-duckdb-pack');
  });

  it('何も入れていなければ「入っていない」', async () => {
    installFakeIdb('commit');
    expect(await new AsrPackStore().readInstalled()).toEqual({ runtime: null, parts: {} });
    expect(await new AsrPackStore().readFilesFor('light')).toBeNull();
  });

  it('🔴 重みだけでは「入っている」と言わない(実行の部品の meta が要る)', async () => {
    installFakeIdb('commit');
    const store = new AsrPackStore();
    const l = lightFiles();
    await store.writePart('light', l, expectOf(l), 'v1');
    const inst = await store.readInstalled();
    expect(inst.runtime).toBeNull();
    expect(inst.parts.light, '実行の部品が無いのに入っていると言った').toBeUndefined();
    expect(await store.readFilesFor('light')).toBeNull();
  });

  it('実行の部品 + 重みを入れると、入っている物が読め、Blob のまま取り出せる', async () => {
    installFakeIdb('commit');
    const store = new AsrPackStore();
    const r = runtimeFiles();
    const l = lightFiles();
    await store.writeRuntime(r, expectOf(r), 'v1');
    const meta = await store.writePart('light', l, expectOf(l), 'v1');
    expect(meta.totalBytes).toBe(55);
    const inst = await store.readInstalled();
    expect(inst.runtime?.version).toBe('v1');
    expect(inst.parts.light?.version).toBe('v1');
    expect(inst.parts.accurate).toBeUndefined();
    const got = await store.readFilesFor('light');
    expect(got).not.toBeNull();
    expect([...got!.keys()].sort()).toEqual([...r.keys(), ...l.keys()].sort());
    // 🔑 Blob のまま(bytes を heap へ写していない)
    for (const b of got!.values()) expect(b).toBeInstanceOf(Blob);
  });

  it('🔴 files と meta は同じ tx(1 部品 = 1 tx)で、abort したら「入っている」と名乗らない', async () => {
    const fake = installFakeIdb('abort');
    const store = new AsrPackStore();
    const r = runtimeFiles();
    await expect(store.writeRuntime(r, expectOf(r), 'v1')).rejects.toThrow();
    expect(fake.meta.data.size, 'meta だけ書かれた').toBe(0);
    expect(fake.files.data.size, 'files だけ書かれた').toBe(0);
    fake.setOutcome('commit');
    const before = fake.writeTxCount();
    await store.writeRuntime(r, expectOf(r), 'v1');
    // 🔴 files と meta を**別の tx に割らない**(割ると、間で落ちたときに片方だけが残る)
    expect(fake.writeTxCount() - before, '書き込みの tx が 1 本でない').toBe(1);
    expect(fake.meta.data.size).toBe(1);
    expect(fake.files.data.size).toBe(3);
  });

  it('🔴 大きさが目録と違えば 1 バイトも書かない', async () => {
    const fake = installFakeIdb('commit');
    const store = new AsrPackStore();
    const l = lightFiles();
    const bad = expectOf(l);
    bad.set('models/openai/whisper-base/onnx/m.onnx', { bytes: 51, sha256: 'e'.repeat(64) });
    await expect(store.writePart('light', l, bad, 'v1')).rejects.toBeInstanceOf(AsrPackError);
    expect(fake.files.data.size).toBe(0);
    expect(fake.meta.data.size).toBe(0);
    // 目録に無い file が混ざっていても同じ
    const extra = lightFiles();
    extra.set('models/other/x.onnx', blob(1));
    await expect(store.writePart('light', extra, expectOf(lightFiles()), 'v1')).rejects.toBeInstanceOf(
      AsrPackError,
    );
    expect(fake.files.data.size).toBe(0);
    // 空
    await expect(store.writePart('light', new Map(), new Map(), 'v1')).rejects.toBeInstanceOf(AsrPackError);
  });

  it('🔴 読むとき、大きさが記録と違えば null ではなく理由つきで投げる(「入っていない」にしない)', async () => {
    const fake = installFakeIdb('commit');
    const store = new AsrPackStore();
    const r = runtimeFiles();
    const l = lightFiles();
    await store.writeRuntime(r, expectOf(r), 'v1');
    await store.writePart('light', l, expectOf(l), 'v1');
    fake.files.data.set('models/openai/whisper-base/onnx/m.onnx', blob(7));
    await expect(store.readFilesFor('light')).rejects.toThrow(/入れ直してください/);
    // ⚠ files が消えている場合も同じ(null にしない)
    fake.files.data.delete('models/openai/whisper-base/onnx/m.onnx');
    await expect(store.readFilesFor('light')).rejects.toBeInstanceOf(AsrPackError);
  });

  it('2 択の一方を消しても、もう一方と実行の部品は残る。最後の 1 つなら実行の部品も消える', async () => {
    const fake = installFakeIdb('commit');
    const store = new AsrPackStore();
    const r = runtimeFiles();
    const l = lightFiles();
    const a = accurateFiles();
    await store.writeRuntime(r, expectOf(r), 'v1');
    await store.writePart('light', l, expectOf(l), 'v1');
    await store.writePart('accurate', a, expectOf(a), 'v1');

    expect(await store.removePart('light')).toBe(false);
    let inst = await store.readInstalled();
    expect(inst.runtime).not.toBeNull();
    expect(inst.parts.light).toBeUndefined();
    expect(inst.parts.accurate).toBeDefined();
    expect([...fake.files.data.keys()].some((k) => String(k).includes('whisper-base')), '重みが残った').toBe(false);
    expect([...fake.files.data.keys()].some((k) => String(k).includes('whisper-small'))).toBe(true);

    expect(await store.removePart('accurate')).toBe(true);
    inst = await store.readInstalled();
    expect(inst).toEqual({ runtime: null, parts: {} });
    expect(fake.files.data.size, '実行の部品の file が残った').toBe(0);
    expect(fake.meta.data.size).toBe(0);
  });

  it('実行の部品を入れ直したとき、新しい構成に無い古い file は消える', async () => {
    const fake = installFakeIdb('commit');
    const store = new AsrPackStore();
    const r = runtimeFiles();
    await store.writeRuntime(r, expectOf(r), 'v1');
    const r2 = new Map(r);
    r2.delete('runtime/ort-wasm.mjs');
    await store.writeRuntime(r2, expectOf(r2), 'v2');
    expect(fake.files.data.has('runtime/ort-wasm.mjs'), '古い file が残った').toBe(false);
    expect((await store.readInstalled()).runtime?.version).toBe('v2');
  });

  it('取り込みの巻き戻し:重みが無いときだけ実行の部品を消す', async () => {
    const fake = installFakeIdb('commit');
    const store = new AsrPackStore();
    const r = runtimeFiles();
    const l = lightFiles();
    await store.writeRuntime(r, expectOf(r), 'v1');
    await store.writePart('light', l, expectOf(l), 'v1');
    await store.removeRuntimeIfAlone();
    expect((await store.readInstalled()).runtime, '重みが在るのに実行の部品を消した').not.toBeNull();
    await store.removePart('light');
    // 実行の部品はもう消えている(最後の 1 つ)── もう一度入れて、重み無しの状態を作る
    await store.writeRuntime(r, expectOf(r), 'v1');
    await store.removeRuntimeIfAlone();
    expect((await store.readInstalled()).runtime).toBeNull();
    expect(fake.files.data.size).toBe(0);
  });
});
