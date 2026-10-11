/** @vitest-environment happy-dom */
/**
 * 🔴 **動画の切り出しのワーカー口**(#683 段②b-1。user 指示 2026-08-03「重い処理はワーカー」)。
 *
 * ⚠ 見るのは 5 つ ──
 *   ①**遅延起動**(作っただけでは worker が居ない)②**`Blob` が参照で渡る**(写さない)
 *   ③**kill されたら待っている依頼は reject**(永久 hang しない)
 *   ④**飛んでいる最中はアイドルで kill しない** ⑤**ワーカーが無い環境は同じ関数をその場で回す**
 *   ⑥音のワーカーとは**別**(動画の長い仕事で音を待たせない)。
 * 🔑 本物の結果(走査 → 切り出し)は **node で実物の `video-codec` を通す**(worker の中身は node で動く)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoClient, VIDEO_WORKER_IDLE_MS } from '../../src/adapter/platform/video/video-client';
import { AudioClient } from '../../src/adapter/platform/audio/audio-client';
import { cutVideo, runVideoJob, scanVideo } from '../../src/adapter/platform/video/video-codec';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { buildVideoWebm, parseWebm } from '../helpers/webm-video-fixture';

class FakeWorker {
  static live: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly seen: Array<{ id: number; payload: { op: string; blob: Blob } }> = [];
  terminated = false;
  constructor() {
    FakeWorker.live.push(this);
  }
  postMessage(msg: { id: number; payload: { op: string; blob: Blob } }): void {
    this.seen.push(msg);
  }
  respond(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent<unknown>);
  }
  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  FakeWorker.live = [];
  vi.unstubAllGlobals();
});

/** 捨てる依頼(dispose で reject される)が未処理の拒否にならないようにする。 */
const drop = (p: Promise<unknown>): void => void p.catch(() => {});

const mk = (idleMs?: number): VideoClient =>
  new VideoClient({
    spawn: () => new FakeWorker() as unknown as Worker,
    monitor: new JobMonitor(),
    ...(idleMs === undefined ? {} : { idleMs }),
  });

describe('動画のワーカー口(VideoClient)', () => {
  it('🔴 作っただけでは worker は居ない(遅延起動)/ 最初の依頼で 1 つだけ起きる', () => {
    const c = mk();
    expect(c.offloaded).toBe(true);
    expect(c.alive).toBe(false);
    expect(FakeWorker.live).toHaveLength(0);
    drop(c.scan(new Blob(['x']), 0, 1000));
    expect(FakeWorker.live).toHaveLength(1);
    drop(c.scan(new Blob(['y']), 0, 1000));
    expect(FakeWorker.live, '2 本目を作っている').toHaveLength(1);
    c.dispose();
  });

  it('🔴 Blob は参照のまま渡る(bytes を写さない)/ 依頼の型が走査と切り出しで分かれる', async () => {
    const c = mk();
    const blob = new Blob([new Uint8Array(1024)]);
    const p = c.scan(blob, 100, 900);
    const w = FakeWorker.live[0]!;
    expect(w.seen[0]!.payload.op).toBe('scan');
    expect(w.seen[0]!.payload.blob, 'Blob を写している').toBe(blob);
    w.respond(w.seen[0]!.id, { ok: false, reason: 'broken' });
    expect(await p).toEqual({ ok: false, reason: 'broken' });
    drop(c.cut(blob, { videoTrack: 1 } as never, 100, 900));
    expect(w.seen[1]!.payload.op).toBe('cut');
    c.dispose();
  });

  it('🔴 kill(dispose)されたら、待っている依頼は reject される(永久に待たない)', async () => {
    const c = mk();
    const p = c.scan(new Blob(['x']), 0, 1000);
    const q = c.cut(new Blob(['x']), { videoTrack: 1 } as never, 0, 1000);
    c.dispose();
    await expect(p).rejects.toThrow(/video/);
    await expect(q).rejects.toThrow(/video/);
    expect(FakeWorker.live[0]!.terminated, 'worker を畳んでいない').toBe(true);
  });

  it('🔴 飛んでいる依頼が在る間はアイドルで kill しない / 返ったら畳む', async () => {
    vi.useFakeTimers();
    try {
      const c = new VideoClient({
        spawn: () => new FakeWorker() as unknown as Worker,
        monitor: new JobMonitor(),
      });
      const p = c.scan(new Blob(['x']), 0, 1000);
      const w = FakeWorker.live[0]!;
      vi.advanceTimersByTime(VIDEO_WORKER_IDLE_MS * 4);
      expect(w.terminated, '飛んでいる最中に殺している').toBe(false);
      w.respond(w.seen[0]!.id, { ok: false, reason: 'broken' });
      await p;
      expect(w.terminated, '返った直後に殺している(続けて押せない)').toBe(false);
      vi.advanceTimersByTime(VIDEO_WORKER_IDLE_MS + 1);
      expect(w.terminated, 'アイドルで畳まれていない(常駐メモリが戻らない)').toBe(true);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 ワーカーが無い環境では、同じ関数をその場で回す(結果は同じ)', async () => {
    vi.stubGlobal('Worker', undefined);
    const c = new VideoClient({ monitor: new JobMonitor() });
    expect(c.offloaded).toBe(false);
    const built = buildVideoWebm({ frames: 40 });
    const blob = new Blob([built.bytes], { type: 'video/webm' });
    const r = await c.scan(blob, 1550, 3050);
    expect(r.ok && r.snappedStartMs).toBe(1000);
    expect(r).toEqual(await scanVideo({ blob, startMs: 1550, endMs: 3050 }));
  });

  it('🔴 音とは別のワーカー(動画の長い仕事で音の切り出しを待たせない)', () => {
    const spawned: string[] = [];
    const v = new VideoClient({
      spawn: () => {
        spawned.push('video');
        return new FakeWorker() as unknown as Worker;
      },
      monitor: new JobMonitor(),
    });
    const a = new AudioClient({
      spawn: () => {
        spawned.push('audio');
        return new FakeWorker() as unknown as Worker;
      },
      monitor: new JobMonitor(),
    });
    drop(v.scan(new Blob(['x']), 0, 1000));
    expect(spawned).toEqual(['video']);
    drop(a.trim(new Blob(['x']), 0, 1000));
    expect(spawned).toEqual(['video', 'audio']);
    v.dispose();
    a.dispose();
  });
});

describe('動画の切り出しの中身(video-codec)── 実物を node で通す', () => {
  it('🔴 走査 → 切り出し:出力の Blob は元の Blob の部品でできていて、別の書き方でほどいて合う', async () => {
    const built = buildVideoWebm({ frames: 40, frameMs: 100, padBytes: 64 });
    const blob = new Blob([built.bytes], { type: 'video/webm' });
    const scanned = await scanVideo({ blob, startMs: 1550, endMs: 3050 });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.snapBackMs).toBe(550);
    const cut = await cutVideo({ blob, scan: scanned.scan, startMs: 1550, endMs: 3050 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.blob.type).toBe('video/webm');
    // 出力の大きさは元より小さい(丸ごと写していない)
    expect(cut.blob.size).toBeLessThan(built.bytes.length);
    const out = new Uint8Array(await cut.blob.arrayBuffer());
    const parsed = parseWebm(out);
    expect(parsed.duration).toBe(2050);
    const video = parsed.blocks.filter((b) => b.track === 1);
    expect(video[0]!.ms).toBe(0);
    expect(video).toHaveLength(21);
    // 1 本の入口(ワーカーもその場も通る `runVideoJob`)でも同じ大きさになる
    const again = await runVideoJob({ op: 'cut', blob, scan: scanned.scan, startMs: 1550, endMs: 3050 });
    expect(again.ok && 'blob' in again && again.blob.size).toBe(cut.blob.size);
  });

  it('断る理由は例外でなく値で返る', async () => {
    const blob = new Blob([new Uint8Array(32)]);
    expect(await scanVideo({ blob, startMs: 0, endMs: 1000 })).toEqual({ ok: false, reason: 'not-webm' });
  });
});
