/**
 * 🔴 途中保存の書き手(#1985 項目 2)。置き場は in-memory(`MemoryJournalStore`)── 実 IndexedDB は smoke。
 */
import { describe, expect, it } from 'vitest';
import { createJournalWriter } from '../../src/features/capture/capture-journal-writer';
import type { JournalMeta } from '../../src/features/capture/capture-journal';
import { MemoryJournalStore } from '../../src/adapter/platform/capture-journal-store';

const meta: JournalMeta = { id: 'r1', kind: 'audio', startedLid: 'n1', startedAt: 1 };
const blob = (n: number): Blob => new Blob(['x'.repeat(n)]);

describe('書く順と「最初の断片を待つ」', () => {
  it('断片は受け取った順に書く(身元が先)', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta);
    w.chunk(0, 0, 1000, blob(5));
    w.chunk(0, 1, 2000, blob(5));
    w.chunk(0, 2, 3000, blob(5));
    await w.settled();
    expect(store.log).toEqual(['meta:r1', 'put:0/0', 'put:0/1', 'put:0/2']);
    expect([...store.chunks.values()].map((c) => c.idx)).toEqual([0, 1, 2]);
  });

  it('🔴 最初の断片の書き込みが終わるまで、2 つ目は書き始めない', async () => {
    const store = new MemoryJournalStore();
    let open!: () => void;
    store.gate = new Promise<void>((r) => {
      open = r;
    });
    const w = createJournalWriter(store, meta);
    w.chunk(0, 0, 1000, blob(5));
    w.chunk(0, 1, 2000, blob(5));
    await new Promise((r) => setTimeout(r, 5));
    // 身元の書き込みが保留のまま ── 後ろの断片は始まってもいない
    expect(store.log).toEqual(['meta:r1']);
    store.gate = null;
    open();
    await w.settled();
    expect(store.log).toEqual(['meta:r1', 'put:0/0', 'put:0/1']);
  });

  it('🔴 最初の断片が書けなかった区間は、後ろの断片を書かず、守られていないと言う(録るのは止めない)', async () => {
    const store = new MemoryJournalStore();
    store.failChunk = new Error('QuotaExceededError');
    const states: string[] = [];
    const w = createJournalWriter(store, meta, { onState: (s) => states.push(s) });
    w.chunk(0, 0, 1000, blob(5));
    w.chunk(0, 1, 2000, blob(5));
    await w.settled();
    expect(w.state()).toBe('off-error');
    expect(states).toEqual(['off-error']); // 1 度だけ言う
    expect(store.chunks.size).toBe(0);
    // 以後の断片も受け付けない(投げない)
    w.chunk(0, 2, 3000, blob(5));
    await w.settled();
    expect(store.log.filter((l) => l.startsWith('put:'))).toEqual(['put:0/0']);
  });
});

describe('上限と空き', () => {
  it('合計が上限を超えたら、途中保存だけやめる(超える断片は書かない)', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta, { capBytes: 12 });
    w.chunk(0, 0, 1000, blob(5));
    w.chunk(0, 1, 2000, blob(5));
    w.chunk(0, 2, 3000, blob(5)); // 15 > 12
    await w.settled();
    expect(w.state()).toBe('off-cap');
    expect(store.chunks.size).toBe(2);
  });

  it('区間を添付にして控えを消せば、そのぶん上限に空きが戻る', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta, { capBytes: 12 });
    w.chunk(0, 0, 1000, blob(10));
    w.segmentDone(0);
    w.chunk(1, 0, 1000, blob(10));
    await w.settled();
    expect(w.state()).toBe('active');
  });

  it('空きが床を割っていたら、区間の最初の断片から書かない', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta, { freeBytes: async () => 10, freeFloorBytes: 100 });
    w.chunk(0, 0, 1000, blob(5));
    await w.settled();
    expect(w.state()).toBe('off-space');
    expect(store.chunks.size).toBe(0);
  });

  it('🔴 区間の途中で空きが床を割ったら、以後は書かない(収録は続く = off-space)', async () => {
    const store = new MemoryJournalStore();
    let free = 1000;
    const w = createJournalWriter(store, meta, { freeBytes: async () => free, freeFloorBytes: 100, freeRecheckBytes: 10 });
    w.chunk(0, 0, 1000, blob(6));
    w.chunk(0, 1, 2000, blob(6));
    await w.settled();
    expect(w.state()).toBe('active');
    free = 10;
    w.chunk(0, 2, 3000, blob(6)); // 12 bytes 書いた後 → 聞き直す
    w.chunk(0, 3, 4000, blob(6));
    await w.settled();
    expect(w.state()).toBe('off-space');
    expect([...store.chunks.values()].map((c) => c.idx)).toEqual([0, 1]);
  });

  it('空きが分からなければ(null)止めない', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta, { freeBytes: async () => null, freeFloorBytes: 100 });
    w.chunk(0, 0, 1000, blob(5));
    await w.settled();
    expect(w.state()).toBe('active');
    expect(store.chunks.size).toBe(1);
  });
});

describe('控えの片付け', () => {
  it('🔴 区間が添付になったら、その区間の控えだけ消える(別の区間は残る)', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta);
    w.chunk(0, 0, 1000, blob(5));
    w.chunk(1, 0, 1000, blob(5));
    w.segmentDone(0);
    await w.settled();
    expect([...store.chunks.values()].map((c) => c.seg)).toEqual([1]);
    expect(store.metas.has('r1')).toBe(true);
  });

  it('消すのは書きかけの断片の後ろに並ぶ(消した後に同じ区間の断片が残らない)', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta);
    w.chunk(0, 0, 1000, blob(5));
    w.chunk(0, 1, 2000, blob(5));
    w.segmentDone(0);
    await w.settled();
    expect(store.chunks.size).toBe(0);
    expect(store.log.at(-1)).toBe('dropSeg:0');
  });

  it('収録が終わり、全部の区間が添付になったら、身元ごと消え、手放しの合図が出る', async () => {
    const store = new MemoryJournalStore();
    let closed = 0;
    const w = createJournalWriter(store, meta, { onClosed: () => closed++ });
    w.chunk(0, 0, 1000, blob(5));
    w.end();
    await w.settled();
    // まだ添付になっていない ── 残っている
    expect(store.metas.has('r1')).toBe(true);
    expect(closed).toBe(0);
    w.segmentDone(0);
    await w.settled();
    expect(store.metas.size).toBe(0);
    expect(store.chunks.size).toBe(0);
    expect(closed).toBe(1);
  });

  it('添付にできなかった区間は残る(次の起動で復元できる)', async () => {
    const store = new MemoryJournalStore();
    const w = createJournalWriter(store, meta);
    w.chunk(0, 0, 1000, blob(5));
    w.end(); // segmentDone を呼ばない
    await w.settled();
    expect(store.chunks.size).toBe(1);
    expect(store.metas.size).toBe(1);
  });

  it('捨てたら全部消える', async () => {
    const store = new MemoryJournalStore();
    let closed = 0;
    const w = createJournalWriter(store, meta, { onClosed: () => closed++ });
    w.chunk(0, 0, 1000, blob(5));
    w.chunk(1, 0, 1000, blob(5));
    w.discard();
    await w.settled();
    expect(store.chunks.size).toBe(0);
    expect(store.metas.size).toBe(0);
    expect(closed).toBe(1);
  });

  it('1 つも書いていなくても、終わって区間が無ければ閉じる', async () => {
    const store = new MemoryJournalStore();
    let closed = 0;
    const w = createJournalWriter(store, meta, { onClosed: () => closed++ });
    w.end();
    await w.settled();
    expect(closed).toBe(1);
  });
});
