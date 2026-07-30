/**
 * main thread 側の storage client(設計 doc §4.4)。
 * worker への request を promise に対応づけるだけの薄い層。sqlite の知識を持たない。
 */
import type { RequestFor, ResultMap, StorageRequest, StorageResponse } from './protocol';

export class StoreClient {
  private readonly worker: Worker;
  private nextId = 1;
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
  }

  request<Op extends StorageRequest['op']>(
    req: RequestFor<Op>,
  ): Promise<ResultMap[Op]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, req });
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const { reject } of this.pending.values())
      reject(new Error('store client terminated'));
    this.pending.clear();
  }
}
