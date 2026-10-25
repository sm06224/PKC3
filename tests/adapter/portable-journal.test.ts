/** @vitest-environment happy-dom */
/**
 * 🔴 #1589 の根治 ── 「変更分だけ先に書く」日誌。
 * 守るのは「閉じる直前の変更が、画像の保存を待たずに残る」ことと「画像に入った分を二重に流さない」こと。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  baseSeqOf,
  createJournal,
  entriesAfter,
  replayEntries,
  SEQ_PER_MS,
  type JournalBackend,
  type JournalEntry,
} from '../../src/adapter/platform/storage/portable-journal';
import { decodeStoredImage, type DbImageStore } from '../../src/adapter/platform/storage/db-image-store';
import {
  latestPortableStart,
  resolvePortableStart,
} from '../../src/adapter/platform/portable-boot';
import { StoreProxyHost } from '../../src/adapter/platform/storage/store-proxy';
import type { StorageRequest } from '../../src/adapter/platform/storage/protocol';

function memoryBackend(opts: { failPut?: boolean } = {}) {
  const rows = new Map<number, JournalEntry>();
  const backend: JournalBackend = {
    put: async (e) => {
      if (opts.failPut) throw new Error('quota');
      rows.set(e.seq, e);
    },
    readAll: async () => [...rows.values()],
    deleteUpTo: async (n) => {
      for (const k of [...rows.keys()]) if (k <= n) rows.delete(k);
    },
  };
  return { backend, rows };
}

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('createJournal', () => {
  it('同じ ms に出した要求も番号は厳密に増える', () => {
    const { backend } = memoryBackend();
    const j = createJournal({ backend, now: () => 1000 });
    const a = j.snapshotSeq();
    const b = j.snapshotSeq();
    expect(b).toBeGreaterThan(a);
    expect(a).toBe(1000 * SEQ_PER_MS);
  });

  it('成功の合図(commit)を呼んだ要求だけが日誌に入る(失敗した要求は入れない)', async () => {
    const { backend, rows } = memoryBackend();
    const j = createJournal({ backend, now: () => 1 });
    const ok = j.begin({ op: 'upsertEntry', n: 1 });
    j.begin({ op: 'upsertEntry', n: 2 }); // 失敗した想定 ── commit しない
    ok();
    expect(j.pending()).toBe(1);
    await j.settled();
    expect(j.pending()).toBe(0);
    expect([...rows.values()].map((e) => (e.req as { n: number }).n)).toEqual([1]);
  });

  it('日誌へ足せなかったら broken になり、その番号を含む画像が書けたら解ける', async () => {
    const { backend } = memoryBackend({ failPut: true });
    const onError = vi.fn();
    const j = createJournal({ backend, now: () => 5, onError });
    j.begin({ op: 'x' })();
    await j.settled();
    expect(j.broken()).toBe(true);
    expect(onError).toHaveBeenCalledWith('quota');
    j.trim(j.snapshotSeq());
    expect(j.broken()).toBe(false);
  });

  it('trim は控えた番号以下だけ捨てる(画像より後の分は残る)', async () => {
    const { backend, rows } = memoryBackend();
    const j = createJournal({ backend, now: () => 1 });
    j.begin({ n: 1 })();
    const snap = j.snapshotSeq();
    j.begin({ n: 2 })();
    await j.settled();
    j.trim(snap);
    await flushMicro();
    expect([...rows.values()].map((e) => (e.req as { n: number }).n)).toEqual([2]);
  });
});

describe('baseSeqOf / entriesAfter / replayEntries', () => {
  it('空から始めた回は流し直さない(前提の中身が無い)', () => {
    expect(baseSeqOf({ use: 'fresh', exportedAt: 1 })).toBeNull();
  });
  it('番号の無い旧い記録は書いた時刻で代える / 埋め込みは exportedAt', () => {
    expect(baseSeqOf({ use: 'stored', savedAt: 7, exportedAt: 1 })).toBe(7 * SEQ_PER_MS);
    expect(baseSeqOf({ use: 'stored', snapshotSeq: 99, savedAt: 7, exportedAt: 1 })).toBe(99);
    expect(baseSeqOf({ use: 'embedded', exportedAt: 3 })).toBe(3 * SEQ_PER_MS);
  });
  it('画像より後だけを番号順で選ぶ', () => {
    const e = [3, 1, 2, 4].map((seq) => ({ seq, req: seq }));
    expect(entriesAfter(e, 2).map((x) => x.seq)).toEqual([3, 4]);
  });
  it('1 件失敗しても後ろを流し、失敗を数えて返す', async () => {
    const seen: unknown[] = [];
    const r = await replayEntries(
      [1, 2, 3].map((seq) => ({ seq, req: seq })),
      async (req) => {
        if (req === 2) throw new Error('boom');
        seen.push(req);
      },
    );
    expect(seen).toEqual([1, 3]);
    expect(r).toEqual({ applied: 2, failed: 1, firstError: 'boom' });
  });
});

describe('画像の記録の snapshotSeq(旧ビルドとの互換)', () => {
  const base = { bundleId: 'b', exportedAt: 1, savedAt: 2, image: new Uint8Array([1]) };
  it('あれば読む / 無い記録(旧ビルドが書いた)も同じように読める', () => {
    expect(decodeStoredImage({ ...base, snapshotSeq: 9 })?.snapshotSeq).toBe(9);
    expect(decodeStoredImage(base)).not.toHaveProperty('snapshotSeq');
  });
});

describe('StoreProxyHost ── 書込 op を worker へ出す直前に番号を振り、成功したときだけ日誌へ足す', () => {
  function host(real: (req: StorageRequest) => Promise<unknown>) {
    const events: string[] = [];
    const journal = {
      begin: (req: StorageRequest) => {
        events.push(`begin:${req.op}`);
        return () => events.push(`commit:${req.op}`);
      },
    };
    const h = new StoreProxyHost({
      client: {
        request: (async (req: StorageRequest) => {
          events.push(`run:${req.op}`);
          return real(req);
        }) as never,
        terminate: () => undefined,
      },
      init: { vfs: 'memory' } as never,
      journal,
    } as never);
    return { h, events };
  }

  it('書込: begin → run → commit の順 / 読みは日誌に触れない', async () => {
    const { h, events } = host(async () => null);
    const c = h.localClient();
    await c.request({ op: 'deleteEntry', cid: 'c', lid: 'a' } as never);
    await c.request({ op: 'listEntryMetas', cid: 'c' } as never);
    expect(events).toEqual([
      'begin:deleteEntry',
      'run:deleteEntry',
      'commit:deleteEntry',
      'run:listEntryMetas',
    ]);
  });

  it('失敗した書込は commit しない', async () => {
    const { h, events } = host(async () => {
      throw new Error('x');
    });
    await expect(h.localClient().request({ op: 'deleteEntry', cid: 'c', lid: 'a' } as never)).rejects.toThrow();
    expect(events).toEqual(['begin:deleteEntry', 'run:deleteEntry']);
  });
});

describe('起動: 画像のあとに流し直す分だけを選ぶ', () => {
  const ID = 'pkcb-2b1f9c04d7';
  const mk = (savedAt: number, snapshotSeq?: number) =>
    ({
      bundleId: ID,
      exportedAt: 5,
      savedAt,
      image: new Uint8Array([1, 2]),
      ...(snapshotSeq === undefined ? {} : { snapshotSeq }),
    }) as const;
  const storeOf = (rec: ReturnType<typeof mk> | null) =>
    ({ read: async () => (rec === null ? null : { ...rec, bytes: rec.image.byteLength }) }) as unknown as DbImageStore;
  const tag = () =>
    `<script type="application/json" data-pkc-bundle>${JSON.stringify({ id: ID, exportedAt: 5 })}</script>`;

  it('画像に入った番号以下は流さず、より後だけ流す / 控えを読めなければ why に載せる', async () => {
    document.head.innerHTML = tag();
    const { backend } = memoryBackend();
    for (const seq of [10, 20, 30]) await backend.put({ seq, req: { n: seq } });
    const start = (await resolvePortableStart(document, () => storeOf(mk(100, 20)), () => backend))!;
    expect(start.replay.map((e) => e.seq)).toEqual([30]);

    const bad: JournalBackend = { ...backend, readAll: async () => Promise.reject(new Error('壊れ')) };
    const s2 = (await resolvePortableStart(document, () => storeOf(mk(100, 20)), () => bad))!;
    expect(s2.replay).toEqual([]);
    expect(s2.choice.why).toContain('直前の変更の控えを読めませんでした');
  });

  it('昇格: 画像と日誌を組で読み直す(先のタブが画像を書いて日誌を畳んだ後は、起動時の日誌を流さない)', async () => {
    document.head.innerHTML = tag();
    const { backend } = memoryBackend();
    await backend.put({ seq: 30, req: 'a' });
    let cur = mk(100, 20);
    const store = { read: async () => ({ ...cur, bytes: 2 }) } as unknown as DbImageStore;
    const start = (await resolvePortableStart(document, () => store, () => backend))!;
    expect(start.replay.map((e) => e.seq)).toEqual([30]);
    cur = mk(200, 40); // 先のタブが seq 30 を含む新しい画像を書いた
    const again = await latestPortableStart(start);
    expect(again.replay).toEqual([]);
  });
});
