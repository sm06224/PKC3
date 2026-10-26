/** @vitest-environment happy-dom */
/**
 * 🔴 **時間を切って流す**(`WorkerLease.runWithin`。テキスト整形の置換のレビュー ⚠1)。
 *
 * 守る主張:
 * 1. 時間内に返れば、そのまま結果を返し、**ワーカーは殺さない**(時間切れの予約も残らない)
 * 2. 時間を超えたら、**ワーカーごと `terminate()`** して `WorkerTimeoutError` で reject する
 * 3. 同じワーカーに積んであった他の依頼も **reject される**(永久に待たせない)
 * 4. 切ったあとの次の依頼は、黙ってワーカーを作り直して動く
 */
import { describe, expect, it } from 'vitest';
import { WorkerLease, WorkerTimeoutError } from '../../src/adapter/platform/worker-lease';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly seen: Array<{ id: number; payload: unknown }> = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; payload: unknown }): void {
    this.seen.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent<unknown>);
  }
}

/** 手で進める時計。⚠ 実時間を待たない。 */
function clock() {
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown): void => void timers.delete(h as number),
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: (): number => timers.size,
  };
}

function lease() {
  FakeWorker.all = [];
  const c = clock();
  const l = new WorkerLease({
    spawn: () => new FakeWorker() as unknown as Worker,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    name: 'lab',
    idleMs: 10_000,
  });
  return { l, c };
}

describe('WorkerLease.runWithin', () => {
  it('🔴 時間内に返れば結果を返し、ワーカーは殺さない。時間切れの予約も残さない', async () => {
    const { l, c } = lease();
    const p = l.runWithin<string>({ text: 'x' }, 1500);
    const w = FakeWorker.all[0]!;
    w.reply(w.seen[0]!.id, 'ok');
    await expect(p).resolves.toBe('ok');
    c.advance(1500);
    expect(w.terminated, '返ったのに時間切れで殺した').toBe(false);
    expect(l.alive).toBe(true);
    // 残るのはアイドル kill の予約 1 本だけ(時間切れの予約は消えている)
    expect(c.pending()).toBe(1);
  });

  it('🔴 時間を超えたら terminate して WorkerTimeoutError で reject する', async () => {
    const { l, c } = lease();
    const p = l.runWithin<string>({ text: 'x' }, 1500);
    const settled = p.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    c.advance(1499);
    expect(FakeWorker.all[0]!.terminated, '時間の手前で殺した').toBe(false);
    c.advance(1);
    const err = await settled;
    expect(err).toBeInstanceOf(WorkerTimeoutError);
    expect((err as WorkerTimeoutError).timeoutMs).toBe(1500);
    expect(FakeWorker.all[0]!.terminated, '時間を超えたのに生かしている').toBe(true);
    expect(l.alive).toBe(false);
    expect(l.busy, '待ちが残っている').toBe(0);
  });

  it('🔴 同じワーカーに積んでいた他の依頼も reject される(永久に待たせない)', async () => {
    const { l, c } = lease();
    const slow = l.runWithin<string>({ text: 'slow' }, 1500);
    const other = l.run<string>({ text: 'other' });
    const a = slow.catch((e: unknown) => e);
    const b = other.catch((e: unknown) => e);
    c.advance(1500);
    expect(await a).toBeInstanceOf(WorkerTimeoutError);
    expect(await b, '巻き込まれた依頼が永久に待っている').toBeInstanceOf(Error);
  });

  it('🔴 切ったあとの次の依頼は、ワーカーを作り直して動く', async () => {
    const { l, c } = lease();
    const first = l.runWithin<string>({ text: 'x' }, 1500).catch((e: unknown) => e);
    c.advance(1500);
    await first;
    const second = l.runWithin<string>({ text: 'y' }, 1500);
    expect(FakeWorker.all, '作り直していない').toHaveLength(2);
    const w2 = FakeWorker.all[1]!;
    w2.reply(w2.seen[0]!.id, 'again');
    await expect(second).resolves.toBe('again');
    expect(w2.terminated).toBe(false);
  });
});
