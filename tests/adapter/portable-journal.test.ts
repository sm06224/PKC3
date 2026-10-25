/** @vitest-environment happy-dom */
/**
 * 🔴 #1589 の根治 ── 「変更分だけ先に書く」日誌。
 * 守るのは「閉じる直前の変更が、画像の保存を待たずに残る」ことと「画像に入った分を二重に流さない」こと。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  baseSeqOf,
  createJournal,
  estimateBytes,
  entriesAfter,
  remapCid,
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
  const failedRows: JournalEntry[] = [];
  const backend: JournalBackend = {
    put: async (e) => {
      if (opts.failPut) throw new Error('quota');
      rows.set(e.seq, e);
    },
    readAll: async () => [...rows.values()],
    keepFailed: async (es) => {
      failedRows.push(...es);
    },
    deleteUpTo: async (n) => {
      for (const k of [...rows.keys()]) if (k <= n) rows.delete(k);
    },
  };
  return { backend, rows, failedRows };
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
    j.begin({ op: 'upsertEntry', n: 2 }).abort(); // 失敗した想定 ── 日誌に入れない
    ok.commit();
    expect(j.pending()).toBe(1);
    await j.settled();
    expect(j.pending()).toBe(0);
    expect([...rows.values()].map((e) => (e.req as { n: number }).n)).toEqual([1]);
  });

  it('日誌へ足せなかったら broken になり、その番号を含む画像が書けたら解ける', async () => {
    const { backend } = memoryBackend({ failPut: true });
    const onError = vi.fn();
    const j = createJournal({ backend, now: () => 5, onError });
    j.begin({ op: 'x' }).commit();
    await j.settled();
    expect(j.broken()).toBe(true);
    expect(onError).toHaveBeenCalledWith('quota');
    j.trim(j.snapshotSeq());
    expect(j.broken()).toBe(false);
  });

  it('trim は控えた番号以下だけ捨てる(画像より後の分は残る)', async () => {
    const { backend, rows } = memoryBackend();
    const j = createJournal({ backend, now: () => 1 });
    j.begin({ n: 1 }).commit();
    await j.settled(); // 控えの書込が終わってから画像を書き出す
    const snap = j.snapshotSeq();
    j.begin({ n: 2 }).commit();
    await j.settled();
    j.trim(snap);
    await flushMicro();
    expect([...rows.values()].map((e) => (e.req as { n: number }).n)).toEqual([2]);
  });
});

describe('🔴 snapshotSeq は飛行中の op を追い越さない(worker は到着順に処理しない)', () => {
  it('op A を begin(未完)→ 画像の番号を控える → A が commit → 再生の選別で A が流される', async () => {
    const { backend } = memoryBackend();
    const j = createJournal({ backend, now: () => 1000 });
    const a = j.begin({ op: 'upsertEntry', n: 'A' });
    const snap = j.snapshotSeq(); // exportImage が A を追い越した
    a.commit();
    await j.settled();
    const rows = await backend.readAll();
    expect(rows).toHaveLength(1);
    // 画像の番号 = snap。A の番号はそれより後 → 流される
    expect(entriesAfter(rows, snap).map((e) => (e.req as { n: string }).n)).toEqual(['A']);
    // trim(snap) でも A は捨てられない
    j.trim(snap);
    await flushMicro();
    expect(await backend.readAll()).toHaveLength(1);
  });

  it('飛行中の op が無いときは「次の番号」まで画像に入っている', async () => {
    const { backend } = memoryBackend();
    const j = createJournal({ backend, now: () => 1000 });
    j.begin({ n: 1 }).commit();
    await j.settled();
    const snap = j.snapshotSeq();
    expect(entriesAfter(await backend.readAll(), snap)).toEqual([]);
  });

  it('失敗した op(abort)は飛行中に残らず、以後の番号を縛らない', () => {
    const { backend } = memoryBackend();
    const j = createJournal({ backend, now: () => 1000 });
    const a = j.begin({ n: 1 });
    a.abort();
    expect(j.pending()).toBe(0);
    expect(j.snapshotSeq()).toBeGreaterThan(1000 * SEQ_PER_MS);
  });
});

describe('番号は時計に頼らず単調(initialSeq)', () => {
  it('時計が戻っても、起動時の最大の番号より後を振る', () => {
    const { backend } = memoryBackend();
    const floor = 5000 * SEQ_PER_MS;
    const j = createJournal({ backend, now: () => 10, initialSeq: floor });
    const a = j.snapshotSeq();
    const b = j.snapshotSeq();
    expect(a).toBeGreaterThan(floor);
    expect(b).toBeGreaterThan(a);
  });
});

describe('大きい op は日誌に複製しない', () => {
  it('estimateBytes: 文字列・型付き配列・入れ子を数え、上限で打ち切る', () => {
    expect(estimateBytes('abc', 1e9)).toBe(6);
    expect(estimateBytes({ a: new Uint8Array(100) }, 1e9)).toBeGreaterThanOrEqual(100);
    expect(estimateBytes([['x'.repeat(1000)]], 100)).toBeGreaterThan(100);
  });

  it('上限超えは日誌に書かず broken にして onError(= 画像の保存を急ぐ)/ その番号を含む画像が書けたら解ける', async () => {
    const { backend, rows } = memoryBackend();
    const onError = vi.fn();
    const j = createJournal({ backend, now: () => 1, onError, maxBytes: 100 });
    j.begin({ op: 'bulkUpsertEntries', body: 'x'.repeat(1000) }).commit();
    expect(rows.size).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(j.broken()).toBe(true);
    expect(j.pending()).toBe(0);
    j.trim(j.snapshotSeq());
    expect(j.broken()).toBe(false);
  });

  it('上限内は書く(対照群)', async () => {
    const { backend, rows } = memoryBackend();
    const j = createJournal({ backend, now: () => 1, maxBytes: 100 });
    j.begin({ op: 'x', body: 'ok' }).commit();
    await j.settled();
    expect(rows.size).toBe(1);
  });
});

describe('baseSeqOf / entriesAfter / replayEntries', () => {
  it('空から始めた回は流し直さない(前提の中身が無い)', () => {
    expect(baseSeqOf({ use: 'fresh', exportedAt: 1 })).toBeNull();
  });
  it('空から始めても、器に 1 度も画像が書かれていない回は全部流す(空の DB を土台に書かれた日誌)', () => {
    expect(baseSeqOf({ use: 'fresh', exportedAt: 1, neverSaved: true })).toBe(0);
    expect(baseSeqOf({ use: 'fresh', exportedAt: 1, neverSaved: false })).toBeNull();
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
    expect(r).toEqual({ applied: 2, failed: 1, firstError: 'boom', failedEntries: [{ seq: 2, req: 2 }] });
  });
});

describe('remapCid', () => {
  it('別の cid は入れ物の cid に読み替える / 同じ・cid 無しはそのまま(同一参照)', () => {
    expect(remapCid({ op: 'upsertEntry', cid: 'old', n: 1 }, 'new')).toEqual({ op: 'upsertEntry', cid: 'new', n: 1 });
    const same = { op: 'x', cid: 'new' };
    expect(remapCid(same, 'new')).toBe(same);
    const none = { op: 'x' };
    expect(remapCid(none, 'new')).toBe(none);
    expect(remapCid(null, 'new')).toBeNull();
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
        return {
          commit: () => events.push(`commit:${req.op}`),
          abort: () => events.push(`abort:${req.op}`),
        };
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

  it('失敗した書込は commit せず abort する', async () => {
    const { h, events } = host(async () => {
      throw new Error('x');
    });
    await expect(h.localClient().request({ op: 'deleteEntry', cid: 'c', lid: 'a' } as never)).rejects.toThrow();
    // 失敗は abort(飛行中から外す)── 呼ばないと日誌が「終わっていない op」を数え続ける
    expect(events).toEqual(['begin:deleteEntry', 'run:deleteEntry', 'abort:deleteEntry']);
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

  it('器が空・画像が無い回(1 度も保存していない)でも、日誌は流し直す対象になる', async () => {
    document.head.innerHTML = tag();
    document.body.innerHTML = '';
    const { backend } = memoryBackend();
    await backend.put({ seq: 7, req: { op: 'upsertEntry' } });
    const start = (await resolvePortableStart(document, () => storeOf(null), () => backend))!;
    expect(start.choice.use).toBe('fresh');
    expect(start.neverSaved).toBe(true);
    expect(start.replay.map((e) => e.seq)).toEqual([7]);
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
