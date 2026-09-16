/**
 * 🔴 **空きを測る側が遅くても、保存は止まらない**(#971 段②)。
 *
 * ## なぜ file を分けたか
 *
 * 空きの見張りは worker の **module の変数**(最後に測った値・測った時刻)に載るので、
 * 同じ file の中では「1 度も測っていない状態」を作り直せない。
 *
 * ## 🔑 ここで見たいのは「**待たされないこと**」1 つである
 *
 * ⚠ `estimate()` を待つのは**書き込みの直前**なので、戻らなければ
 *   **その保存ごと止まる** ── 別のタブからの依頼は **10 秒**で打ち切られるから、
 *   測っている間にその期限を使い切ると「**保存できなかった**」になる。
 * 🔑 だから測る側には**打ち切り**が要る(`QUOTA_ESTIMATE_TIMEOUT_MS`)。
 *   打ち切った回は**断らない側へ倒す** ── 門の目的は「一杯のときに壊さない」で
 *   あって、測ることそのものではない。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { QUOTA_ESTIMATE_TIMEOUT_MS } from '../../src/features/storage/write-quota';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

/** ⚠ 何度呼ばれたか ── 0 のままなら、この test は何も見ていない(空振り)。 */
let estimateCalls = 0;
/** 🔑 **返ってこない計器** ── 実機の「一杯の OPFS を数え上げて固まる」を模す。 */
const NEVER_MS = 60_000;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        estimate: () => {
          estimateCalls += 1;
          return new Promise<{ usage: number; quota: number }>((resolve) => {
            const t = setTimeout(() => resolve({ usage: 0, quota: 1 }), NEVER_MS);
            // ⚠ 箱を掴んだままにしない(test が終わらなくなる)
            (t as unknown as { unref?: () => void }).unref?.();
          });
        },
      },
    },
  });
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-quota-slow' });
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

describe('空きを測る側が遅いとき(#971 段②)', () => {
  it('🔴 測れなくても保存は通り、打ち切りの時間しか待たない', async () => {
    const t0 = Date.now();
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: {
        lid: 'slow-1',
        title: 't',
        archetype: 'text',
        body: '本文 slow-1',
        entryOrder: 1,
        status: null,
        date: null,
        archived: false,
      },
    });
    const elapsed = Date.now() - t0;

    // ⚠ 前提 ── 呼ばれていなければ、この test は打ち切りを 1 度も通っていない
    expect(estimateCalls, '測る口を 1 度も呼んでいない(門がそもそも走っていない)').toBeGreaterThan(
      0,
    );
    // 🔑 打ち切りを**通った**こと(すぐ返っていたら、別の理由で素通りしている)
    expect(elapsed, '打ち切りを通っていない').toBeGreaterThanOrEqual(QUOTA_ESTIMATE_TIMEOUT_MS - 50);
    // 🔴 **本題** ── 計器が返らなくても、保存は打ち切りの直後に通る
    expect(elapsed, '測る側に引きずられて保存が待たされた').toBeLessThan(
      QUOTA_ESTIMATE_TIMEOUT_MS * 3,
    );
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'slow-1' })).toContain('本文 slow-1');
  }, 30_000);
});
