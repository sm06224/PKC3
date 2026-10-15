import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireWriterLease, promoteOrReleaseLease } from '../../src/adapter/platform/storage/writer-lease';

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
