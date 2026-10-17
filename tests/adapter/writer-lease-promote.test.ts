import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireWriterLease, isPromotionMemoryFallback, promoteOrReleaseLease } from '../../src/adapter/platform/storage/writer-lease';

/** Web Locks の最小の模型(ifAvailable / 待ち行列 / 返却で次へ)。判定は本物と同じ向き。 */
function installFakeLocks(): void {
  const queue: Array<{ cb: (l: unknown) => Promise<void> | void; resolve: () => void }> = [];
  let held = false;
  const pump = (): void => {
    if (held) return;
    const next = queue.shift();
    if (!next) return;
    held = true;
    void Promise.resolve(next.cb({})).then(() => {
      held = false;
      next.resolve();
      pump();
    });
  };
  const request = (_n: string, a: unknown, b?: unknown): Promise<void> => {
    const opts = typeof a === 'function' ? {} : (a as { ifAvailable?: boolean });
    const cb = (typeof a === 'function' ? a : b) as (l: unknown) => Promise<void> | void;
    return new Promise<void>((resolve) => {
      if (opts.ifAvailable && held) {
        void Promise.resolve(cb(null)).then(resolve);
        return;
      }
      queue.push({ cb, resolve });
      pump();
    });
  };
  vi.stubGlobal('navigator', { locks: { request } });
}

afterEach(() => vi.unstubAllGlobals());

describe('promoteOrReleaseLease (#1087)', () => {
  it('昇格に失敗したら lock を手放し、待っていた別のタブが書き手になれる', async () => {
    installFakeLocks();
    const a = acquireWriterLease('t');
    expect(await a.immediate).toBe(true);
    const b = acquireWriterLease('t');
    expect(await b.immediate).toBe(false);
    await expect(
      promoteOrReleaseLease(a, () => Promise.reject(new Error('chunk 404'))),
    ).rejects.toThrow('chunk 404');
    expect(a.state()).toBe('released');
    await b.whenHeld;
    expect(b.state()).toBe('held');
  });

  it('成功したら手放さない(書き手のまま)', async () => {
    installFakeLocks();
    const a = acquireWriterLease('t');
    await a.immediate;
    await expect(promoteOrReleaseLease(a, async () => 7)).resolves.toBe(7);
    expect(a.state()).toBe('held');
  });
});

describe('isPromotionMemoryFallback(多重タブ T2)', () => {
  it('素の PKC3 で昇格先が memory → 失敗にする / OPFS は通す', () => {
    expect(isPromotionMemoryFallback({ portable: false, vfs: 'memory' })).toBe(true);
    expect(isPromotionMemoryFallback({ portable: false, vfs: 'opfs-sahpool' })).toBe(false);
  });

  it('可搬単一 HTML は選んで memory なので失敗にしない', () => {
    expect(isPromotionMemoryFallback({ portable: true, vfs: 'memory' })).toBe(false);
  });

  it('失敗にすれば lock が手放され、待っていた別のタブが書き手になれる', async () => {
    installFakeLocks();
    const a = acquireWriterLease('t2');
    expect(await a.immediate).toBe(true);
    const b = acquireWriterLease('t2');
    expect(await b.immediate).toBe(false);
    a.release();
    await b.whenHeld;
    const c = acquireWriterLease('t2');
    expect(await c.immediate).toBe(false);
    await expect(
      promoteOrReleaseLease(b, async () => {
        if (isPromotionMemoryFallback({ portable: false, vfs: 'memory' })) throw new Error('memory');
      }),
    ).rejects.toThrow('memory');
    await c.whenHeld;
    expect(c.state()).toBe('held');
  });
});
