/**
 * 多重タブの storage proxy(#177)。
 *
 * fake の channel hub は BroadcastChannel の意味論に合わせる:
 * **自分の instance には配られない**(store-proxy はこの性質に依存している ──
 * 'changed' の「発信者以外」の半分はここで守られる)。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  Broadcaster,
  StoreClientLike,
} from '@adapter/platform/storage/store-proxy';
import {
  ProxyStoreClient,
  StoreProxyHost,
} from '@adapter/platform/storage/store-proxy';
import type { InitResult, StorageRequest } from '@adapter/platform/storage/protocol';

/** BroadcastChannel の fake(同名 channel 全 instance へ配る。送信元は除く)。 */
function makeHub() {
  const members = new Set<FakeChannel>();
  class FakeChannel implements Broadcaster {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    closed = false;
    constructor() {
      members.add(this);
    }
    postMessage(data: unknown): void {
      if (this.closed) return;
      for (const m of members) {
        if (m === this || m.closed) continue;
        // 実物と同じく非同期配送(microtask)── 同期で呼ぶと「送信の中で応答が
        // 返ってくる」という実在しない順序を test が固定してしまう
        queueMicrotask(() => {
          if (!m.closed) m.onmessage?.({ data } as MessageEvent);
        });
      }
    }
    close(): void {
      this.closed = true;
      members.delete(this);
    }
  }
  return { make: (): Broadcaster => new FakeChannel(), members };
}

const INIT: InitResult = {
  vfs: 'opfs-sahpool',
  libVersion: 'test',
  crossOriginIsolated: true,
  journalMode: 'wal',
};

/** 実 worker の fake。要求を記録して canned 結果を返す。 */
function makeFakeReal(results: Record<string, unknown> = {}) {
  const calls: StorageRequest[] = [];
  const client: StoreClientLike = {
    request: vi.fn(async (req: StorageRequest) => {
      calls.push(req);
      if (req.op in results) return results[req.op] as never;
      return null as never;
    }) as StoreClientLike['request'],
    terminate: vi.fn(),
  };
  return { client, calls };
}

/** microtask 配送を全部吐かせる。 */
const drain = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

async function connectPair() {
  const hub = makeHub();
  const real = makeFakeReal({ listEntryMetas: [{ lid: 'a' }] });
  const host = new StoreProxyHost({
    client: real.client,
    init: INIT,
    makeChannel: hub.make,
    tabId: 'holder',
  });
  const follower = await ProxyStoreClient.connect({
    makeChannel: hub.make,
    tabId: 'f1',
  });
  if (!follower) throw new Error('handshake failed');
  return { hub, real, host, follower };
}

describe('handshake', () => {
  it('holder が居れば init が渡って成立する', async () => {
    const { follower } = await connectPair();
    expect(follower.initResult).toEqual(INIT);
    expect(follower.role()).toBe('follower');
  });

  it('holder が居なければ null(従来の待機へ落とす口)', async () => {
    vi.useFakeTimers();
    try {
      const hub = makeHub();
      const p = ProxyStoreClient.connect({ makeChannel: hub.make });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBeNull();
      // ⚠ channel を閉じて帰ること ── 開きっぱなしの 1 本を残さない
      expect(hub.members.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('要求の往復', () => {
  it('read op が holder の実 worker へ届き、結果が返る', async () => {
    const { follower, real } = await connectPair();
    const rows = await follower.request({ op: 'listEntryMetas', cid: 'c1' });
    expect(rows).toEqual([{ lid: 'a' }]);
    expect(real.calls).toContainEqual({ op: 'listEntryMetas', cid: 'c1' });
  });

  it('実 worker の失敗は error として返る(黙って null にしない)', async () => {
    const { follower, real } = await connectPair();
    (real.client.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db is angry'),
    );
    await expect(follower.request({ op: 'getBody', cid: 'c1', lid: 'x' })).rejects.toThrow(
      'db is angry',
    );
  });

  it("follower の 'close' は実 worker に届かない(holder の DB を巻き添えにしない)", async () => {
    const { follower, real } = await connectPair();
    await follower.request({ op: 'close' });
    expect(real.calls.map((r) => r.op)).not.toContain('close');
  });

  it('応答が無ければ時間切れで reject(永久 hang を作らない)', async () => {
    vi.useFakeTimers();
    try {
      const hub = makeHub();
      const real = makeFakeReal();
      const host = new StoreProxyHost({
        client: real.client,
        init: INIT,
        makeChannel: hub.make,
        tabId: 'holder',
      });
      const p = ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' });
      await vi.advanceTimersByTimeAsync(10);
      const follower = await p;
      if (!follower) throw new Error('handshake failed');
      host.close(); // holder が黙る
      const req = follower.request({ op: 'counts', cid: 'c1' });
      const guard = expect(req).rejects.toThrow('本体タブと通信できません');
      await vi.advanceTimersByTimeAsync(11_000);
      await guard;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("'changed' の放送", () => {
  it('follower の書込 → 他の follower と holder 自身に届く。発信者には届かない', async () => {
    const { hub, host, follower } = await connectPair();
    const f2 = await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f2' });
    if (!f2) throw new Error('f2 handshake failed');
    const seenByF2: Array<string[] | null> = [];
    const seenByHost: Array<string[] | null> = [];
    const seenBySender: Array<string[] | null> = [];
    f2.onChanged((_cid, lids) => seenByF2.push(lids));
    host.onChanged((_cid, lids) => seenByHost.push(lids));
    follower.onChanged((_cid, lids) => seenBySender.push(lids));

    await follower.request({
      op: 'deleteEntry',
      cid: 'c1',
      lid: 'x',
    });
    await drain();
    expect(seenByF2).toEqual([['x']]);
    // 🔑 follower の書込は holder の dispatcher を通らない ── host の listener で補う
    expect(seenByHost).toEqual([['x']]);
    expect(seenBySender).toEqual([]);
  });

  it('holder 自身の書込(localClient 経由)→ follower に届く', async () => {
    const { host, follower, real } = await connectPair();
    const seen: Array<string[] | null> = [];
    follower.onChanged((_cid, lids) => seen.push(lids));
    const local = host.localClient();
    await local.request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: { lid: 'y' } as never,
      checkpoint: false,
      keepLatest: 1,
    });
    await drain();
    expect(seen).toEqual([['y']]);
    expect(real.calls.map((r) => r.op)).toContain('upsertEntry');
  });

  it('read op は放送しない', async () => {
    const { host, follower } = await connectPair();
    const seen: unknown[] = [];
    follower.onChanged((cid) => seen.push(cid));
    await host.localClient().request({ op: 'listEntryMetas', cid: 'c1' });
    await drain();
    expect(seen).toEqual([]);
  });
});

describe('編集ロック', () => {
  it('同じ lid は 2 枚目に渡さない。解放で渡るようになる', async () => {
    const { host, follower } = await connectPair();
    expect(await follower.acquireEdit('c1', 'n1')).toBe('granted');
    expect(await host.acquireEdit('c1', 'n1')).toBe('denied');
    expect(await host.acquireEdit('c1', 'n2')).toBe('granted'); // 別ノートは並行編集できる
    follower.releaseEdit('c1', 'n1');
    await drain();
    expect(await host.acquireEdit('c1', 'n1')).toBe('granted');
  });

  it("follower の 'close'(タブ終了)でそのタブのロックが返る", async () => {
    const { host, follower } = await connectPair();
    expect(await follower.acquireEdit('c1', 'n1')).toBe('granted');
    await follower.request({ op: 'close' });
    await drain();
    expect(await host.acquireEdit('c1', 'n1')).toBe('granted');
  });

  it('生存確認が途絶えたロックは奪える(タブの crash で永久ロックにしない)', async () => {
    const hub = makeHub();
    const real = makeFakeReal();
    let nowMs = 0;
    const host = new StoreProxyHost({
      client: real.client,
      init: INIT,
      makeChannel: hub.make,
      tabId: 'holder',
      now: () => nowMs,
    });
    const follower = await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' });
    if (!follower) throw new Error('handshake failed');
    expect(await follower.acquireEdit('c1', 'n1')).toBe('granted');
    nowMs = 301_000; // EDIT_LOCK_TTL_MS(5 分)超え・ping 無し
    expect(await host.acquireEdit('c1', 'n1')).toBe('granted');
  });
});

describe('昇格(holder の死 → follower が実 worker へ乗り換える)', () => {
  it('乗り換え中の要求はバッファされ、実 client に流れる。以後の書込は放送に乗る', async () => {
    const { host, follower, hub } = await connectPair();
    host.close(); // 旧 holder の死

    const newReal = makeFakeReal({ counts: { entries: 1, relations: 0, revisions: 0, assets: 0 } });
    let heldAtPromotion: Array<{ cid: string; lid: string }> = [];
    const promoted = follower.promote(async () => {
      // makeReal の中で新 host を建てる(main.ts と同じ形)── flush が
      // localClient(放送する包み)へ流れることを確かめる
      heldAtPromotion = follower.heldEditLocks();
      const h = new StoreProxyHost({
        client: newReal.client,
        init: INIT,
        makeChannel: hub.make,
        tabId: 'holder2',
        heldLocks: heldAtPromotion,
      });
      return { client: h.localClient(), init: INIT };
    });
    // 乗り換え中に投げた要求(promoting バッファ経由)
    const inFlight = follower.request({ op: 'counts', cid: 'c1' });
    await promoted;
    expect(await inFlight).toEqual({ entries: 1, relations: 0, revisions: 0, assets: 0 });
    expect(follower.role()).toBe('holder');
    // 以後の書込が新実 client に届く
    await follower.request({ op: 'deleteEntry', cid: 'c1', lid: 'z' });
    expect(newReal.calls.map((r) => r.op)).toContain('deleteEntry');
  });

  it('新 holder の名乗りで、残った follower の編集ロックが再主張される', async () => {
    const hub = makeHub();
    const real = makeFakeReal();
    const host = new StoreProxyHost({
      client: real.client,
      init: INIT,
      makeChannel: hub.make,
      tabId: 'holder',
    });
    const f1 = await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' });
    if (!f1) throw new Error('f1 handshake failed');
    expect(await f1.acquireEdit('c1', 'n1')).toBe('granted');
    host.close(); // 旧 holder の死(ロック台帳ごと消える)

    const host2 = new StoreProxyHost({
      client: makeFakeReal().client,
      init: INIT,
      makeChannel: hub.make,
      tabId: 'holder2',
    });
    await drain(16); // holder-here → f1 の edit-acquire → host2 の edit-res
    // 再主張が新台帳に入っている ── holder2 は同じ lid を取れない
    expect(await host2.acquireEdit('c1', 'n1')).toBe('denied');
  });
});

describe('レビュー指摘の回帰(H-1 / H-2 / M-7)', () => {
  it('🔴 H-1: holder 自身のロックは時間が経っても盗まれない(逆向きの TTL test)', async () => {
    const hub = makeHub();
    let nowMs = 0;
    const host = new StoreProxyHost({
      client: makeFakeReal().client,
      init: INIT,
      makeChannel: hub.make,
      tabId: 'holder',
      now: () => nowMs,
    });
    const follower = await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' });
    if (!follower) throw new Error('handshake failed');
    expect(await host.acquireEdit('c1', 'n1')).toBe('granted');
    nowMs = 10_000_000; // TTL(5 分)をはるかに超える ── 本体の編集は分単位が普通
    expect(
      await follower.acquireEdit('c1', 'n1'),
      '本体タブが長く編集しただけで別タブに同じノートを取られた',
    ).toBe('denied');
  });

  it('🔴 H-2: 昇格失敗はバッファを全部断り、以後の要求も即断る(静かな永久 hang にしない)', async () => {
    const { host, follower } = await connectPair();
    host.close(); // 旧 holder の死
    const promoted = follower.promote(async () => {
      throw new Error('SAH が返ってこない');
    });
    const inFlight = follower.request({ op: 'counts', cid: 'c1' }); // promoting バッファへ
    await expect(promoted).rejects.toThrow('SAH が返ってこない');
    await expect(inFlight).rejects.toThrow('本体への切り替えに失敗しました');
    // 以後の要求も**待たずに**断られる(積まれない)
    await expect(follower.request({ op: 'counts', cid: 'c1' })).rejects.toThrow(
      '本体への切り替えに失敗しています',
    );
    expect(await follower.acquireEdit('c1', 'n1')).toBe('unreachable');
  });

  it('M-7: holder 不在の acquire は「denied」ではなく「unreachable」で返る', async () => {
    vi.useFakeTimers();
    try {
      const { host, follower } = await connectPair();
      host.close(); // holder が黙る
      const p = follower.acquireEdit('c1', 'n1');
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await p).toBe('unreachable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('M-7: 待っている acquire は新 holder の名乗りで再送され、満了を待たずに返る', async () => {
    vi.useFakeTimers();
    try {
      const { hub, host, follower } = await connectPair();
      host.close(); // holder の死
      const p = follower.acquireEdit('c1', 'n1'); // 返事の来ない acquire
      await vi.advanceTimersByTimeAsync(1_000); // 満了(10 秒)よりずっと手前
      const host2 = new StoreProxyHost({
        client: makeFakeReal().client,
        init: INIT,
        makeChannel: hub.make,
        tabId: 'holder2',
      });
      await vi.advanceTimersByTimeAsync(100); // holder-here → 再送 → edit-res
      expect(await p).toBe('granted');
      host2.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
