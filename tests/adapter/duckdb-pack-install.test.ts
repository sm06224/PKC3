/** @vitest-environment happy-dom */
/**
 * DuckDB 一式の**設置・削除**(#682 段③a)。
 *
 * 守りたい主張(Office `office-pack-install.test.ts` と同じ形):
 *  ① 🔴 **投げない** ── 失敗はそのまま画面に出せる文で返る(握り忘れで固まらない)
 *  ② 🔴 **二重起動しない**
 *  ③ 🔴 **失敗しても門は開く**(`finally`)
 *  ④ 🔴 **消えたことを確かめてから「削除しました」と言う**
 *  ⑤ 🔴 **書く前に**保存の永続化を頼む(順番が逆だと書いた分が対象にならない)
 *  ⑥ 進捗を必ず流す(パーセントにはしない ── 文字列 1 行)
 */
import { describe, expect, it } from 'vitest';
import { DuckDbPackInstaller } from '../../src/adapter/platform/duckdb/duckdb-pack-install';
import { DuckDbPackAcquireError } from '../../src/adapter/platform/duckdb/duckdb-pack-acquire';
import { DuckDbPackStoreError, type DuckDbPackMeta } from '../../src/adapter/platform/duckdb/duckdb-pack-store';

const META: DuckDbPackMeta = {
  version: '1.33.1-dev57.0',
  installedAt: 1,
  totalBytes: 2,
  files: [],
};

function make(over: {
  writeAll?: (files: ReadonlyMap<string, Blob>, opts: { version: string }) => Promise<DuckDbPackMeta>;
  remove?: () => Promise<void>;
  readMeta?: () => Promise<DuckDbPackMeta | null>;
  fetchFromBase?: (
    base: string,
    onProgress?: (phase: string, done: number, total: number) => void,
  ) => Promise<{ files: Map<string, Blob>; version: string }>;
  persist?: () => Promise<boolean>;
} = {}) {
  const order: string[] = [];
  let stored: DuckDbPackMeta | null = null;
  const installer = new DuckDbPackInstaller({
    persist: async () => {
      order.push('persist');
      return (await over.persist?.()) ?? true;
    },
    store: {
      writeAll: over.writeAll ?? (async (_f: ReadonlyMap<string, Blob>, o: { version: string }) => {
        order.push('writeAll');
        // ⚠ **本物と同じ意味論** ── 受け取った版をそのまま保存する。
        //    stub が捨てると、配線が切れていても test が緑のままになる
        stored = { ...META, version: o.version };
        return stored;
      }),
      remove: over.remove ?? (async () => { stored = null; }),
      readMeta: over.readMeta ?? (async () => stored),
    } as never,
    fetchFromBase: (over.fetchFromBase
      ?? (async () => ({ files: new Map([['duckdb-eh.wasm', new Blob(['x'])]]), version: '1.33.1-dev57.0' }))) as never,
  });
  const progress: string[] = [];
  return {
    installer,
    progress,
    order,
    setStored: (m: DuckDbPackMeta | null) => { stored = m; },
    onProgress: (t: string) => progress.push(t),
  };
}

describe('DuckDbPackInstaller', () => {
  it('配布元から入れると、版が記録される', async () => {
    const { installer, onProgress } = make();
    const r = await installer.install({ base: 'duckdb/', onProgress });
    expect(r.ok).toBe(true);
    expect(r.ok && r.meta?.version).toBe('1.33.1-dev57.0');
    expect(r.ok && r.message).toContain('入れました');
  });

  it('🔴 書く前に保存の永続化を頼む(順番が逆だと書いた分が対象にならない)', async () => {
    const { installer, order, onProgress } = make();
    await installer.install({ base: 'duckdb/', onProgress });
    expect(order, '永続化を頼む前に書いている').toEqual(['persist', 'writeAll']);
  });

  it('🔴 永続化を断られたら、そのことを言う(黙って消えうる状態にしない)', async () => {
    const { installer, onProgress } = make({ persist: async () => false });
    const r = await installer.install({ base: 'duckdb/', onProgress });
    expect(r.ok, '断られただけで設置ごと失敗にしない').toBe(true);
    expect(r.ok && r.message).toContain('自動で消されることがあります');
  });

  it('許可されたときは、余計なことを言わない', async () => {
    const { installer, onProgress } = make();
    const r = await installer.install({ base: 'duckdb/', onProgress });
    expect(r.ok && r.message).not.toContain('自動で消されることがあります');
  });

  it('base をそのまま取得層へ渡す(PKC3 側で組み替えない)', async () => {
    const seen: string[] = [];
    const { installer, onProgress } = make({
      fetchFromBase: async (base) => {
        seen.push(base);
        return { files: new Map([['duckdb-eh.wasm', new Blob(['x'])]]), version: 'v1' };
      },
    });
    await installer.install({ base: 'duckdb/', onProgress });
    expect(seen).toEqual(['duckdb/']);
  });

  it('🔴 投げない ── 取得の失敗はそのまま出せる文で返る', async () => {
    const { installer, onProgress } = make({
      fetchFromBase: async () => { throw new DuckDbPackAcquireError('取得元に一式がありません'); },
    });
    const r = await installer.install({ base: 'duckdb/', onProgress });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message, 'こちらが書いた文はそのまま出す').toBe('取得元に一式がありません');
  });

  it('🔴 投げない ── 保管の失敗もそのまま出せる文で返る', async () => {
    const { installer, onProgress } = make({
      writeAll: async () => { throw new DuckDbPackStoreError('DuckDB の一式が空です(書き込みを取り消しました)'); },
    });
    const r = await installer.install({ base: 'duckdb/', onProgress });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toBe('DuckDB の一式が空です(書き込みを取り消しました)');
  });

  it('🔴 容量不足は「次に何をすべきか」が分かる文にする', async () => {
    const { installer, onProgress } = make({
      writeAll: async () => { throw new Error('QuotaExceededError: quota'); },
    });
    const r = await installer.install({ base: 'duckdb/', onProgress });
    expect(!r.ok && r.message).toContain('空き容量');
    expect(!r.ok && r.message, '必要な量を言う').toContain('35MB');
  });

  it('🔴 二重起動しない', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { installer, onProgress } = make({
      fetchFromBase: async () => {
        await gate;
        return { files: new Map([['duckdb-eh.wasm', new Blob(['x'])]]), version: 'v1' };
      },
    });
    const first = installer.install({ base: 'duckdb/', onProgress });
    expect(installer.isRunning()).toBe(true);
    const second = await installer.install({ base: 'duckdb/', onProgress });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.message).toContain('すでに設置中');
    release();
    expect((await first).ok).toBe(true);
  });

  it('🔴 失敗しても門は開く(落ちたまま立つと以後全部断られる)', async () => {
    let fail = true;
    const { installer, onProgress } = make({
      fetchFromBase: async () => {
        if (fail) throw new DuckDbPackAcquireError('だめ');
        return { files: new Map([['duckdb-eh.wasm', new Blob(['x'])]]), version: 'v1' };
      },
    });
    expect((await installer.install({ base: 'duckdb/', onProgress })).ok).toBe(false);
    expect(installer.isRunning(), '走っていない状態に戻る').toBe(false);
    fail = false;
    expect((await installer.install({ base: 'duckdb/', onProgress })).ok, '次の試行が通る').toBe(true);
  });

  it('🔴 設置中は削除を断る(消しながら書かない)', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    let removed = false;
    const { installer, onProgress } = make({
      fetchFromBase: async () => {
        await gate;
        return { files: new Map([['duckdb-eh.wasm', new Blob(['x'])]]), version: 'v1' };
      },
      remove: async () => { removed = true; },
    });
    const running = installer.install({ base: 'duckdb/', onProgress });
    const r = await installer.remove();
    expect(r.ok).toBe(false);
    expect(removed, '実体に触れていない').toBe(false);
    release();
    await running;
  });

  it('🔴 消えたことを確かめてから「削除しました」と言う', async () => {
    const { installer } = make({ remove: async () => {}, readMeta: async () => META });
    const r = await installer.remove();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('まだ残っています');
  });

  it('削除できたら控えは空になる', async () => {
    const { installer, setStored } = make();
    setStored(META);
    const r = await installer.remove();
    expect(r).toEqual({ ok: true, meta: null, message: 'DuckDB 一式を削除しました' });
  });

  it('🔴 進捗を流す(パーセントにしない ── 文字列 1 行)', async () => {
    const { installer, progress, onProgress } = make();
    await installer.install({ base: 'duckdb/', onProgress });
    expect(progress.length, '1 行も出していない').toBeGreaterThan(2);
    expect(progress.some((p) => p.includes('配備'))).toBe(true);
    for (const p of progress) {
      expect(p, `パーセントで出している: ${p}`).not.toMatch(/%/);
    }
    expect(progress.at(-1), '終わったら進捗を消す').toBe('');
  });

  it('🔴 失敗しても進捗は消える(字が出たまま固まらない)', async () => {
    const { installer, progress, onProgress } = make({
      fetchFromBase: async () => { throw new DuckDbPackAcquireError('だめ'); },
    });
    await installer.install({ base: 'duckdb/', onProgress });
    expect(progress.at(-1)).toBe('');
  });

  it('読めない状態は「入っていない」側へ倒す', async () => {
    const { installer } = make({ readMeta: async () => { throw new Error('idb 死亡'); } });
    expect(await installer.readMeta()).toBeNull();
  });
});
