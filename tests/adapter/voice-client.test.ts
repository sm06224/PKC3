/** @vitest-environment happy-dom */
/**
 * 声の仕上げワーカーの口(#952 B1・#674・B4・B5)── 使い捨て(遅延起動 / アイドルで kill)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください / ワーカーはしばらくつかわれないなら、キルと解放し、
 * > ワーカーへのジョブ発行をバッファして、ワーカーにディスパッチします」
 *
 * 守りたい主張:
 *  ① 遅延起動 ② 🔴 アイドルで terminate ③ 🔴 飛んでいる間は kill しない ④ 🔴 PCM は transfer(ゼロコピー)
 *  ⑤ 🔴 ワーカーが無い環境ではメインで回さず理由を言って断る ⑥ 待ちのジョブは terminate(dispose)で reject される
 *  (起動待ちのバッファの順序は `WorkerLease` の test が持つ)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceClient, VOICE_WORKER_IDLE_MS } from '../../src/adapter/platform/voice/voice-client';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import type { VoiceJob } from '../../src/adapter/platform/voice/voice-run';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly seen: Array<{ id: number; payload: VoiceJob }> = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; payload: VoiceJob }, transfer: Transferable[] = []): void {
    this.seen.push(msg);
    this.transfers.push(transfer);
  }
  respond(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent<unknown>);
  }
  fail(id: number, error: string): void {
    this.onmessage?.({ data: { id, ok: false, error } } as MessageEvent<unknown>);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const job = (): VoiceJob => ({ op: 'denoise', pcm: new Float32Array([0.1, 0.2, 0.3]) });
const OK = { ok: true, kind: 'audio', files: [] };

const client = () => new VoiceClient({ spawn: () => new FakeWorker() as unknown as Worker, monitor: new JobMonitor() });

afterEach(() => {
  FakeWorker.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('VoiceClient', () => {
  it('① 遅延起動 ── 作っただけでは worker は起きない', () => {
    const c = client();
    expect(c.available).toBe(true);
    expect(c.alive).toBe(false);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('④ 🔴 PCM は transfer(ゼロコピー)で渡る', async () => {
    const c = client();
    const j = job();
    const buf = j.pcm.buffer;
    const p = c.run(j);
    const w = FakeWorker.all[0]!;
    expect(w.transfers[0], 'PCM を transfer していない').toEqual([buf]);
    w.respond(w.seen[0]!.id, OK);
    await expect(p).resolves.toEqual(OK);
  });

  it('🔴 ② アイドルになったら terminate して解放する(境目は定数どおり)。次の依頼は黙って作り直す', async () => {
    vi.useFakeTimers();
    const c = client();
    const p = c.run(job());
    const w = FakeWorker.all[0]!;
    w.respond(w.seen[0]!.id, OK);
    await p;
    expect(c.alive).toBe(true);
    vi.advanceTimersByTime(VOICE_WORKER_IDLE_MS - 1);
    expect(w.terminated, 'アイドルになる前に kill した').toBe(false);
    vi.advanceTimersByTime(1);
    expect(w.terminated, '返し忘れ ── wasm のメモリが残る').toBe(true);
    expect(c.alive).toBe(false);
    const p2 = c.run(job());
    expect(FakeWorker.all).toHaveLength(2);
    const w2 = FakeWorker.all[1]!;
    w2.respond(w2.seen[0]!.id, OK);
    await p2;
  });

  it('🔴 ③ 飛んでいる間は、アイドルの時間を超えても kill しない', async () => {
    vi.useFakeTimers();
    const c = client();
    const p = c.run(job());
    const w = FakeWorker.all[0]!;
    vi.advanceTimersByTime(VOICE_WORKER_IDLE_MS * 10);
    expect(w.terminated, '長い 1 件を殺した').toBe(false);
    w.respond(w.seen[0]!.id, OK);
    await p;
  });

  it('落ちた依頼は理由つきで reject される(永久に待たない)', async () => {
    const c = client();
    const p = c.run(job());
    const w = FakeWorker.all[0]!;
    w.fail(w.seen[0]!.id, 'メモリが足りません');
    await expect(p).rejects.toThrow(/メモリが足りません/);
  });

  it('🔴 ⑤ ワーカーが無い環境では、メインで回さず理由を言って断る', async () => {
    vi.stubGlobal('Worker', undefined);
    const c = new VoiceClient();
    expect(c.available).toBe(false);
    await expect(c.run(job())).rejects.toThrow(/実行できません/);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('🔴 ⑥ dispose で待っている依頼を reject し、worker を畳む', async () => {
    const c = client();
    const p = c.run(job());
    const w = FakeWorker.all[0]!;
    c.dispose();
    await expect(p).rejects.toThrow();
    expect(w.terminated).toBe(true);
  });

  it('worker の名前が可視化(ジョブ表)に出る', async () => {
    const monitor = new JobMonitor();
    const spy = vi.spyOn(monitor, 'record');
    const c = new VoiceClient({ spawn: () => new FakeWorker() as unknown as Worker, monitor });
    const p = c.run(job());
    const w = FakeWorker.all[0]!;
    w.respond(w.seen[0]!.id, OK);
    await p;
    expect(spy.mock.calls.every((call) => call[0] === 'voice')).toBe(true);
    expect(spy.mock.calls.map((x) => x[1])).toContain('spawn');
  });
});
