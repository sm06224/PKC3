/** @vitest-environment happy-dom */
/**
 * O1: Office wasm 一式の置き場(#88)。
 *
 * 守りたい主張は 4 つ:
 *  ① **揃っていない一式は 1 バイトも書かない**(metadata 404 の再発防止)
 *  ② **CJK フォントが 0 件の一式を受け付けない**(「日本語は絶対」)
 *  ③ **files と meta は同じ tx**。abort したら「入っている」と名乗らない
 *  ④ **照合材料(sha256)を落とさない**
 *
 * ⚠ happy-dom に `indexedDB` は無いので、`asset-blob-commit.test.ts` と同じ流儀で
 *   **主張に必要な順序だけ**を再現する最小の偽物を差す(依存を増やさない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficePackStore } from '../../src/adapter/platform/office/office-pack-store';
import { REQUIRED_PACK_FILES } from '../../src/adapter/platform/office/office-pack';

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
} {
  const files: FakeStore = { data: new Map(), cleared: 0 };
  const meta: FakeStore = { data: new Map(), cleared: 0 };
  const state = { txCount: 0 };
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

  const open = () => {
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
  return { files, meta, get txCount() { return state.txCount; } };
}

/** 起動に要る 5 つ + フォント 1 つの、最小で「揃っている」一式。 */
function completePack(): Map<string, Blob> {
  const m = new Map<string, Blob>();
  for (const f of REQUIRED_PACK_FILES) m.set(f, new Blob([`${f}-bytes`]));
  m.set('fonts/BIZUDGothic-Regular.ttf', new Blob(['ttf']));
  return m;
}

describe('OfficePackStore', () => {
  beforeEach(() => {
    // sha256 は node の webcrypto がそのまま使える
    if (!globalThis.crypto?.subtle) throw new Error('前提: crypto.subtle が要る');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('揃った一式を入れると、meta と files が commit される', async () => {
    const fake = installFakeIdb('commit');
    const store = new OfficePackStore();
    const meta = await store.install(completePack(), { version: 'v1', source: 'file' });

    expect(meta.files.length, '5 つの必須 + フォント 1 つ').toBe(REQUIRED_PACK_FILES.length + 1);
    expect(fake.meta.data.size, 'meta が 1 件').toBe(1);
    expect(fake.files.data.size).toBe(REQUIRED_PACK_FILES.length + 1);
    // 🔴 **同じ tx で書いている**ことを直接 pin する。分けて書く変異は
    //    「どちらも abort する」偽物では見分けられない ── 数で押さえる
    expect(fake.txCount, 'install が開く書き込み tx は 1 つだけ').toBe(1);
    expect(await store.isInstalled()).toBe(true);
  });

  it('🔴 どのビルドかを保存する(#155 ── 版の文字列は使い回されることがある)', async () => {
    /**
     * ⚠ **保存側で落ちても画面は成立して見える**(「不明」と出るだけ)ので、
     * ここを見ていないと配線が切れたことに誰も気づかない ── 実際、変異試験で
     * 「保存時に build を捨てる」が生き延びた。
     */
    installFakeIdb('commit');
    const store = new OfficePackStore();
    const build = {
      loSha: 'fb02e9d1fc6277a4',
      builtAt: '2026-08-15T18:39:00Z',
      runId: '31890208793',
      qtRef: '6.9',
      emsdk: '4.0.10',
      pkc3Commit: '1c1866b',
    };
    const meta = await store.install(completePack(), { version: 'v1', source: 'url', build });
    expect(meta.build, '保存した meta に素性が載っていない').toEqual(build);
    expect((await store.readMeta())?.build, '読み直すと素性が消えている').toEqual(build);
  });

  it('🔴 前に入れた一式(素性を持たない)を読んでも壊れない ── null に正規化する', async () => {
    installFakeIdb('commit');
    const store = new OfficePackStore();
    await store.install(completePack(), { version: 'v1', source: 'url' });
    const meta = await store.readMeta();
    // ⚠ `undefined` を画面まで流さない(「持っていない」は `null` で表す)
    expect(meta?.build).toBeNull();
    expect(meta !== null && 'build' in meta, 'field ごと欠けている').toBe(true);
  });

  it('🔴 照合材料(sha256)を落とさない ── 全 file が 64 桁の hex を持つ', async () => {
    installFakeIdb('commit');
    const meta = await new OfficePackStore().install(completePack(), { version: 'v1', source: 'url' });
    for (const f of meta.files) {
      expect(f.sha256, `${f.name} の sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes, `${f.name} の bytes`).toBeGreaterThan(0);
    }
    // ⚠ 同じ hash が並んでいたら「計算していない」に等しい ── 中身が違えば違う
    expect(new Set(meta.files.map((f) => f.sha256)).size).toBe(meta.files.length);
  });

  it('🔴 metadata が欠けた一式は 1 バイトも書かない(実際に踏んだ壊れ方)', async () => {
    const fake = installFakeIdb('commit');
    const files = completePack();
    files.delete('soffice.data.js.metadata');
    await expect(new OfficePackStore().install(files, { version: 'v1', source: 'file' }))
      .rejects.toThrow(/soffice\.data\.js\.metadata/);
    expect(fake.txCount, '書き込みの tx を 1 つも開いていない').toBe(0);
  });

  it('🔴 CJK フォントが 0 件の一式は受け付けない(日本語は絶対)', async () => {
    const fake = installFakeIdb('commit');
    const files = completePack();
    files.delete('fonts/BIZUDGothic-Regular.ttf');
    await expect(new OfficePackStore().install(files, { version: 'v1', source: 'file' }))
      .rejects.toThrow(/フォント/);
    expect(fake.txCount).toBe(0);
  });

  it('🔴 tx が abort したら install は失敗し、「入っている」と名乗らない', async () => {
    const fake = installFakeIdb('abort');
    const store = new OfficePackStore();
    await expect(store.install(completePack(), { version: 'v1', source: 'file' })).rejects.toThrow();
    expect(fake.meta.data.size, 'meta が書かれていない').toBe(0);
    expect(fake.files.data.size, 'files も書かれていない').toBe(0);
    expect(await store.isInstalled(), '入っていないと答える').toBe(false);
  });

  it('meta が無ければ、files が残っていても「入っている」と読まない', async () => {
    const fake = installFakeIdb('commit');
    const store = new OfficePackStore();
    await store.install(completePack(), { version: 'v1', source: 'file' });
    fake.meta.data.clear(); // 削除の途中で落ちた状態を作る
    expect(await store.isInstalled()).toBe(false);
    expect(fake.files.data.size, '前提: files はまだ在る').toBeGreaterThan(0);
  });

  it('🔴 壊れた meta を「入っている」と読まない(形を検める)', async () => {
    // 変異試験で見つけた穴 ── 形の検査を消しても既存 test は全部通っていた。
    // ⚠ 旧版の meta / 途中で壊れた値は **実際に起こりうる**(schema を変えた後の残骸)。
    //    ここで false を返せないと、files が揃っていない状態で起動しに行く。
    const fake = installFakeIdb('commit');
    const store = new OfficePackStore();
    await store.install(completePack(), { version: 'v1', source: 'file' });
    for (const broken of [
      { version: 'v1' },                                   // files が無い
      { version: 1, installedAt: 0, source: 'file', files: [] }, // version が数値
      { version: 'v1', installedAt: 0, source: 'ftp', files: [] }, // source が知らない値
      'installed',                                          // そもそも object ではない
      null,
    ]) {
      fake.meta.data.set('pack', broken);
      expect(await store.isInstalled(), `壊れた meta: ${JSON.stringify(broken)}`).toBe(false);
    }
  });

  it('install は旧版を clear してから入れる(file 構成が変わっても混ざらない)', async () => {
    const fake = installFakeIdb('commit');
    const store = new OfficePackStore();
    await store.install(completePack(), { version: 'v1', source: 'file' });
    const files = completePack();
    files.set('fonts/BIZUDMincho-Regular.ttf', new Blob(['m']));
    await store.install(files, { version: 'v2', source: 'file' });
    expect(fake.files.cleared, 'install のたびに clear する').toBe(2);
    expect(fake.files.data.size).toBe(REQUIRED_PACK_FILES.length + 2);
  });

  it('remove すると入っていない状態に戻る', async () => {
    const fake = installFakeIdb('commit');
    const store = new OfficePackStore();
    await store.install(completePack(), { version: 'v1', source: 'file' });
    await store.remove();
    expect(await store.isInstalled()).toBe(false);
    expect(fake.files.data.size).toBe(0);
  });

  it('進捗は file 単位で最後まで刻まれる', async () => {
    installFakeIdb('commit');
    const seen: number[] = [];
    await new OfficePackStore().install(completePack(), {
      version: 'v1',
      source: 'file',
      onProgress: (done, total) => seen.push(done / total),
    });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1), '最後は 1 まで行く').toBe(1);
  });
});
