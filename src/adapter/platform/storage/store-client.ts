/**
 * main thread 側の storage client(設計 doc §4.4)。
 * worker への request を promise に対応づけるだけの薄い層。sqlite の知識を持たない。
 * worker のロード失敗・落下では応答 message が来ないため、error 系イベントで
 * pending を全 reject する(永久 hang の防止 ── review #3)。
 */
import type { RequestFor, ResultMap, StorageRequest, StorageResponse } from './protocol';

export class StoreClient {
  private readonly worker: Worker;
  private nextId = 1;
  private terminated = false;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(worker?: Worker) {
    this.worker =
      worker ??
      new Worker(new URL('./storage-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<StorageResponse>) => {
      const waiter = this.pending.get(ev.data.id);
      if (!waiter) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) waiter.resolve(ev.data.result);
      else waiter.reject(new Error(ev.data.error));
    };
    this.worker.onerror = (ev: ErrorEvent) => {
      this.failAll(new Error(`storage worker error: ${ev.message || 'load failed'}`));
    };
    this.worker.onmessageerror = () => {
      this.failAll(new Error('storage worker message deserialization failed'));
    };
  }

  request<Op extends StorageRequest['op']>(
    req: RequestFor<Op>,
  ): Promise<ResultMap[Op]> {
    if (this.terminated)
      return Promise.reject(new Error('store client terminated'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, req });
    });
  }

  terminate(): void {
    this.terminated = true;
    this.worker.terminate();
    this.failAll(new Error('store client terminated'));
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
