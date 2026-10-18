/** @vitest-environment happy-dom */
/**
 * 🔴 **波形のワーカー**(#1232)── 不可侵指示 2026-08-03 の 3 規律(遅延起動 / バッファ / アイドル kill と
 * terminate 時の reject)と、ゼロコピー(PCM は転送)。復号の分担と、山だけを残すこと。
 */
import { describe, expect, it, vi } from 'vitest';
import { WaveClient } from '../../src/adapter/platform/audio/wave-client';
import { WaveSource, WAVE_CACHE_MAX, WAVE_MAX_BLOB_BYTES } from '../../src/adapter/platform/audio/wave-source';
import { wavePeaks } from '../../src/adapter/platform/audio/wave-codec';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly seen: Array<{ id: number; payload: { channels: Float32Array[]; points: number } }> = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; payload: { channels: Float32Array[]; points: number } }, transfer: Transferable[] = []): void {
    this.seen.push(msg);
    this.transfers.push(transfer);
  }
  /** 本物の中身(wavePeaks)で返す ── 山の計算は本物。 */
  respond(): void {
    for (const m of this.seen.splice(0)) {
      this.onmessage?.({ data: { id: m.id, ok: true, result: wavePeaks(m.payload) } } as MessageEvent<unknown>);
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

function client(idleMs = 5): { c: WaveClient; timers: Array<() => void> } {
  FakeWorker.all = [];
  const c = new WaveClient({ spawn: () => new FakeWorker() as unknown as Worker, idleMs });
  return { c, timers: [] };
}

describe('WaveClient ── ワーカーの寿命(#1232)', () => {
  it('遅延起動: 作っただけでは worker が居ない / 1 件目で起きる', () => {
    const { c } = client();
    expect(FakeWorker.all.length).toBe(0);
    expect(c.alive).toBe(false);
    void c.peaks([new Float32Array(10)], 4);
    expect(FakeWorker.all.length).toBe(1);
    expect(c.alive).toBe(true);
  });

  it('PCM は転送で渡す(ゼロコピー): 転送一覧に各チャンネルの buffer が載る', () => {
    const { c } = client();
    const l = new Float32Array(8);
    const r = new Float32Array(8);
    void c.peaks([l, r], 4);
    const w = FakeWorker.all[0]!;
    expect(w.transfers[0]).toEqual([l.buffer, r.buffer]);
  });

  it('返る山は本物の計算(known PCM)', async () => {
    const { c } = client();
    const p = c.peaks([new Float32Array([0, 0.5, 0, -0.25])], 2);
    FakeWorker.all[0]!.respond();
    expect([...(await p)]).toEqual([0.5, 0.25]);
  });

  it('terminate(dispose)で待っている依頼を reject する(永久に待たない)', async () => {
    const { c } = client();
    const p = c.peaks([new Float32Array(10)], 4);
    const caught = p.then(
      () => 'resolved',
      (e: unknown) => (e as Error).message,
    );
    c.dispose();
    expect(await caught).toContain('disposed');
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });

  it('飛んでいる間は kill しない / 全部返ったあとアイドルで kill する', async () => {
    vi.useFakeTimers();
    try {
      const { c } = client(50);
      const p = c.peaks([new Float32Array(10)], 4);
      vi.advanceTimersByTime(500);
      expect(FakeWorker.all[0]!.terminated).toBe(false);
      FakeWorker.all[0]!.respond();
      await p;
      vi.advanceTimersByTime(60);
      expect(FakeWorker.all[0]!.terminated).toBe(true);
      expect(c.alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WaveSource ── 復号は呼び側・山だけを残す(#1232)', () => {
  function ctxOf(samples: Float32Array[], duration: number): { create: () => never; closed: () => number; decoded: () => number } {
    let closed = 0;
    let decoded = 0;
    return {
      create: (() => ({
        decodeAudioData: async () => {
          decoded += 1;
          return { numberOfChannels: samples.length, duration, getChannelData: (i: number) => samples[i]! };
        },
        close: async () => {
          closed += 1;
        },
      })) as never,
      closed: () => closed,
      decoded: () => decoded,
    };
  }

  it('山と長さが出る / コンテキストは必ず閉じる / 元の AudioBuffer の配列は譲らない(写して転送)', async () => {
    const pcm = new Float32Array([0.1, 0.9, 0.2, 0.3]);
    const k = ctxOf([pcm], 2.5);
    const src = new WaveSource({ client: new WaveClient({ spawn: null }), create: k.create });
    const r = await src.load('a', new Blob([new Uint8Array(4)]), 2);
    expect(r!.durationMs).toBe(2500);
    expect([...r!.peaks]).toEqual([Math.fround(0.9), Math.fround(0.3)]);
    expect(k.closed()).toBe(1);
    // 元の配列は detach されていない
    expect(pcm.length).toBe(4);
  });

  it('🔴 転送しても、AudioBuffer の持ち物は譲らない(写してから渡す)', async () => {
    // 本物の worker と同じく、転送した buffer は呼び側で detach される(structuredClone の transfer)
    FakeWorker.all = [];
    class TransferringWorker extends FakeWorker {
      override postMessage(
        msg: { id: number; payload: { channels: Float32Array[]; points: number } },
        transfer: Transferable[] = [],
      ): void {
        const moved = structuredClone(msg.payload.channels, { transfer });
        super.postMessage({ id: msg.id, payload: { channels: moved, points: msg.payload.points } }, transfer);
        this.respond();
      }
    }
    const pcm = new Float32Array([0.1, 0.9, 0.2, 0.3]);
    const k = ctxOf([pcm], 1);
    const src = new WaveSource({
      client: new WaveClient({ spawn: () => new TransferringWorker() as unknown as Worker }),
      create: k.create,
    });
    const r = await src.load('a', new Blob([new Uint8Array(2)]), 2);
    expect(r).not.toBeNull();
    expect(pcm.length, 'AudioBuffer の配列を転送して手放させている').toBe(4);
  });

  it('🔴 大きすぎる添付は復号せず null(手違いの検出)/ 上限ちょうどは復号する', async () => {
    const k = ctxOf([new Float32Array([0.5, 0.5])], 1);
    const src = new WaveSource({ client: new WaveClient({ spawn: null }), create: k.create });
    // 🔴 上限は 250MB に上がった(依頼 356 A)── 大きさだけを偽る(実際に 250MB を確保しない)
    const sized = (size: number): Blob => ({ size, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob;
    expect(await src.load('big', sized(WAVE_MAX_BLOB_BYTES + 1), 2)).toBeNull();
    expect(k.decoded(), '大きすぎるのに復号を始めた').toBe(0);
    expect(await src.load('ok', sized(WAVE_MAX_BLOB_BYTES), 2)).not.toBeNull();
    expect(k.decoded()).toBe(1);
  });

  it('🔴 ステレオは 1 本に平均してから渡す(写しを溜めない)', async () => {
    const seen: number[][] = [];
    const client = {
      peaks: async (chs: Float32Array[]) => {
        seen.push(chs.map((c) => c.length));
        return new Float32Array([...chs[0]!]);
      },
    } as unknown as WaveClient;
    const l = new Float32Array([0.8, 0, 0.4]);
    const r = new Float32Array([0, 0.6, 0.4]);
    const k = ctxOf([l, r], 1);
    const src = new WaveSource({ client, create: k.create });
    const out = await src.load('st', new Blob([new Uint8Array(2)]), 3);
    expect(seen).toEqual([[3]]);
    expect([...out!.peaks].map((v) => Math.round(v * 10) / 10)).toEqual([0.4, 0.3, 0.4]);
    // 元の AudioBuffer の配列は書き換えない
    expect([...l]).toEqual([Math.fround(0.8), 0, Math.fround(0.4)]);
  });

  it('同じ録音は復号しない(山の配列だけをキャッシュ)/ 同時の二重要求も 1 回', async () => {
    const k = ctxOf([new Float32Array([0.5, 0.5])], 1);
    const src = new WaveSource({ client: new WaveClient({ spawn: null }), create: k.create });
    const b = new Blob([new Uint8Array(2)]);
    const [x, y] = await Promise.all([src.load('a', b, 2), src.load('a', b, 2)]);
    expect(x).toBe(y);
    await src.load('a', b, 2);
    expect(k.decoded()).toBe(1);
  });

  it('キャッシュは上限で古い順に捨てる', async () => {
    const k = ctxOf([new Float32Array([0.5])], 1);
    const src = new WaveSource({ client: new WaveClient({ spawn: null }), create: k.create });
    const b = new Blob([new Uint8Array(1)]);
    for (let i = 0; i < WAVE_CACHE_MAX + 5; i++) await src.load(`k${String(i)}`, b, 2);
    expect(src.cached).toBe(WAVE_CACHE_MAX);
    await src.load('k0', b, 2); // 捨てられていたので復号し直す
    expect(k.decoded()).toBe(WAVE_CACHE_MAX + 6);
  });

  it('読めない音・AudioContext が無い環境は null(例外にしない)', async () => {
    const bad = new WaveSource({
      client: new WaveClient({ spawn: null }),
      create: (() => ({
        decodeAudioData: async () => {
          throw new Error('bad');
        },
        close: async () => undefined,
      })) as never,
    });
    expect(await bad.load('a', new Blob([]), 4)).toBeNull();
    const none = new WaveSource({ client: new WaveClient({ spawn: null }), create: () => null });
    expect(await none.load('a', new Blob([]), 4)).toBeNull();
  });
});
