/** @vitest-environment happy-dom */
/**
 * 音声認識ワーカーの口(#772 段②)── 使い捨て(遅延起動 / アイドルで kill)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し…」
 *
 * 守りたい主張:
 *  ① 遅延起動 ── 作っただけでは worker は起きない
 *  ② 🔴 **アイドルで terminate する**(推論の常駐は 1.65〜3.6GB ── 返さないと残り続ける)
 *  ③ 🔴 **飛んでいる間は kill しない**(長い 1 件を殺さない)
 *  ④ 🔴 **音(PCM)は transfer で渡す**(ゼロコピー)/ 重みは Blob の参照で渡る
 *  ⑤ 🔴 **ワーカーが無い環境ではメインで回さない**(1.65GB をメインへ載せない)── 理由を言って断る
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsrClient } from '../../src/adapter/platform/asr/asr-client';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { ASR_WORKER_IDLE_MS } from '../../src/features/asr/asr-parts';
import type { AsrJob } from '../../src/adapter/platform/asr/asr-run';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly seen: Array<{ id: number; payload: AsrJob }> = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; payload: AsrJob }, transfer: Transferable[] = []): void {
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

const job = (): AsrJob => ({
  files: [['a', new Blob(['x'])]],
  modelId: 'Xenova/whisper-base',
  language: 'japanese',
  pcm: new Float32Array([0.1, 0.2, 0.3]),
});

const client = () =>
  new AsrClient({ spawn: () => new FakeWorker() as unknown as Worker, monitor: new JobMonitor() });

afterEach(() => {
  FakeWorker.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AsrClient', () => {
  it('① 遅延起動 ── 作っただけでは worker は起きない', () => {
    const c = client();
    expect(c.available).toBe(true);
    expect(c.alive).toBe(false);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('④ 音は transfer(ゼロコピー)で、重みと実行の部品は Blob のまま渡る', async () => {
    const c = client();
    const j = job();
    const pcmBuffer = j.pcm.buffer;
    const p = c.transcribe(j);
    const w = FakeWorker.all[0]!;
    expect(w.transfers[0], 'PCM を transfer していない').toEqual([pcmBuffer]);
    expect(w.seen[0]!.payload.files[0]![1]).toBeInstanceOf(Blob);
    w.respond(w.seen[0]!.id, { text: 'あ', loadMs: 1, runMs: 2 });
    await expect(p).resolves.toEqual({ text: 'あ', loadMs: 1, runMs: 2 });
  });

  it('🔴 ② アイドルになったら terminate して解放する(境目は定数どおり)', async () => {
    vi.useFakeTimers();
    const c = client();
    const p = c.transcribe(job());
    const w = FakeWorker.all[0]!;
    w.respond(w.seen[0]!.id, { text: 'あ', loadMs: 0, runMs: 0 });
    await p;
    expect(c.alive).toBe(true);
    vi.advanceTimersByTime(ASR_WORKER_IDLE_MS - 1);
    expect(w.terminated, 'アイドルになる前に kill した').toBe(false);
    vi.advanceTimersByTime(1);
    expect(w.terminated, '返し忘れ ── 推論の常駐が残る').toBe(true);
    expect(c.alive).toBe(false);
    // 次に頼めば黙って作り直す
    const p2 = c.transcribe(job());
    expect(FakeWorker.all).toHaveLength(2);
    const w2 = FakeWorker.all[1]!;
    w2.respond(w2.seen[0]!.id, { text: 'い', loadMs: 0, runMs: 0 });
    await p2;
  });

  it('🔴 ③ 飛んでいる間は、アイドルの時間を超えても kill しない', async () => {
    vi.useFakeTimers();
    const c = client();
    const p = c.transcribe(job());
    const w = FakeWorker.all[0]!;
    vi.advanceTimersByTime(ASR_WORKER_IDLE_MS * 10);
    expect(w.terminated, '長い 1 件を殺した').toBe(false);
    w.respond(w.seen[0]!.id, { text: 'あ', loadMs: 0, runMs: 0 });
    await p;
  });

  it('落ちた依頼は理由つきで reject される(永久に待たない)', async () => {
    const c = client();
    const p = c.transcribe(job());
    const w = FakeWorker.all[0]!;
    w.fail(w.seen[0]!.id, 'メモリが足りません');
    await expect(p).rejects.toThrow(/メモリが足りません/);
  });

  it('worker の名前が可視化(ジョブ表)に出る', async () => {
    const monitor = new JobMonitor();
    const spy = vi.spyOn(monitor, 'record');
    const c = new AsrClient({ spawn: () => new FakeWorker() as unknown as Worker, monitor });
    const p = c.transcribe(job());
    const w = FakeWorker.all[0]!;
    w.respond(w.seen[0]!.id, { text: 'あ', loadMs: 0, runMs: 0 });
    await p;
    expect(spy.mock.calls.every((call) => call[0] === 'asr')).toBe(true);
    expect(spy.mock.calls.map((c2) => c2[1])).toContain('spawn');
  });

  it('🔴 ⑤ ワーカーが無い環境では、メインで回さず理由を言って断る', async () => {
    vi.stubGlobal('Worker', undefined);
    const c = new AsrClient();
    expect(c.available).toBe(false);
    await expect(c.transcribe(job())).rejects.toThrow(/文字にできません/);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('dispose で待っている依頼を落とし、worker を畳む', async () => {
    const c = client();
    const p = c.transcribe(job());
    const w = FakeWorker.all[0]!;
    c.dispose();
    await expect(p).rejects.toThrow();
    expect(w.terminated).toBe(true);
  });
});
