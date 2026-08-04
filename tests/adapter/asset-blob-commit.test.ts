/** @vitest-environment happy-dom */
/**
 * P8 段㉔: 🔴 **書けたと言うのは commit のあと**。
 *
 * 🔴 直す前の `tx()` は `req.onsuccess` で resolve するだけで、
 * `transaction.oncomplete` / `onabort` / `onerror` を一切見ていなかった。
 * IDB の **request success は commit の前**に起きるので、
 * 「書けた」と言った直後に tx が abort しうる ── quota で実際に起きる。
 *
 * 壊れ方: 空きが少ない状態で大きな `.pkc2.zip` を取り込むと、`putBlob` が
 * 次々 resolve して meta 行と entry 行が sqlite に確定し、IDB 側だけが commit 時に
 * `QuotaExceededError` で abort する。取込は「取込完了: N 件」と成功を名乗り、
 * 一覧には添付ノートが並ぶ。開くと「asset が見つかりません」しか出ず、
 * 参照は生きているので整理でも回収されない ── **中身の無い添付ノートが恒久的に残る**。
 * ⚠ 取込側は「bytes を先に、参照を後に」と書いている ── その順序が買うはずの
 * 保証が、ここで成立していなかった。
 *
 * ⚠ happy-dom に `indexedDB` は無いので、**request success の後に abort する**
 * という当の順序だけを再現する最小の偽物を差す(依存を増やさない)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetBlobStore } from '../../src/adapter/platform/storage/asset-blob-store';

type Handler = (() => void) | null;

interface FakeReq {
  onsuccess: Handler;
  onerror: Handler;
  result: unknown;
  error: unknown;
}

/**
 * `outcome` で「request のあと何が起きるか」を決める偽 IDB。
 * - `commit`  : success → oncomplete(正常)
 * - `abort`   : success → **onabort**(quota で実際に起きる順序)
 * - `txerror` : success → **onerror**
 */
function installFakeIdb(outcome: 'commit' | 'abort' | 'txerror'): { requests: number } {
  const stats = { requests: 0 };
  const makeTx = (): Record<string, unknown> => {
    const t: Record<string, unknown> = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: new Error('quota'),
      objectStore: () => ({
        put: (): FakeReq => {
          stats.requests += 1;
          const req: FakeReq = { onsuccess: null, onerror: null, result: undefined, error: null };
          // ⚠ **request が先、tx の決着が後** ── この順序が本件の核心
          queueMicrotask(() => {
            req.onsuccess?.();
            queueMicrotask(() => {
              if (outcome === 'commit') (t['oncomplete'] as Handler)?.();
              else if (outcome === 'abort') (t['onabort'] as Handler)?.();
              else (t['onerror'] as Handler)?.();
            });
          });
          return req;
        },
        get: (): FakeReq => {
          stats.requests += 1;
          const req: FakeReq = { onsuccess: null, onerror: null, result: null, error: null };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
      }),
    };
    return t;
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: Record<string, unknown> = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        result: {
          objectStoreNames: { contains: () => true },
          transaction: () => makeTx(),
        },
      };
      queueMicrotask(() => (req['onsuccess'] as Handler)?.());
      return req;
    },
  });
  return stats;
}

afterEach(() => vi.unstubAllGlobals());

describe('添付 bytes の書込', () => {
  it('⚠ commit したら成功(空振り防止 ── 常に失敗する実装でも下は通る)', async () => {
    installFakeIdb('commit');
    const store = new AssetBlobStore();
    await expect(store.put('c1', 'k1', new Blob(['x']))).resolves.toBeUndefined();
  });

  it('🔴 request が成功しても tx が abort したら**失敗として返す**', async () => {
    const stats = installFakeIdb('abort');
    const store = new AssetBlobStore();
    await expect(
      store.put('c1', 'k1', new Blob(['x'])),
      'commit を待たずに「書けた」と言っている',
    ).rejects.toThrow();
    // 前提: request 自体は成功していた(= 早すぎる resolve の状況を再現できている)
    expect(stats.requests, 'request が 1 度も走っていない').toBeGreaterThan(0);
  });

  it('🔴 tx が error でも**失敗として返す**', async () => {
    installFakeIdb('txerror');
    const store = new AssetBlobStore();
    await expect(store.put('c1', 'k1', new Blob(['x']))).rejects.toThrow();
  });

  /**
   * ⚠ **読みは commit を待たない**(値は request の時点で確定していて、
   * 待つと 1 往復ぶん遅くなるだけ)。ここを一緒に `oncomplete` にすると
   * 「読めているのに返ってこない」になる。
   */
  it('⚠ 読みは request success で返る(commit を待たない)', async () => {
    installFakeIdb('abort'); // 読みでは tx の決着を待たないので影響しない
    const store = new AssetBlobStore();
    await expect(store.get('c1', 'k1')).resolves.toBeNull();
  });
});
