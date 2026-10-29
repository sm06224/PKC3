/** @vitest-environment happy-dom */
/**
 * 歌声と楽器を分けるワーカーの口(#674 / #949)── 使い捨て(遅延起動 / アイドルで kill)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し…」
 *
 * 守りたい主張:
 *  ① 遅延起動 ── 作っただけでは worker は起きない
 *  ② 🔴 アイドルで terminate する(ORT の wasm と重みのメモリを返す)/ 飛んでいる間は kill しない
 *  ③ 🔴 左右の PCM は transfer(ゼロコピー)、重みは Blob の参照、進み具合の口(MessagePort)も transfer
 *  ④ 進み具合が口から出て、終わったら閉じる
 *  ⑤ ワーカーが無い環境では、メインで回さず理由を言って断る
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StemClient, STEM_WORKER_IDLE_MS } from '../../src/adapter/platform/stems/stem-client';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly seen: Array<{ id: number; payload: Record<string, unknown> }> = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; payload: Record<string, unknown> }, transfer: Transferable[] = []): void {
    this.seen.push(msg);
    this.transfers.push(transfer);
  }
  respond(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent<unknown>);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const req = () => ({
  model: new Blob(['onnx']),
  modelId: 'mdx-vocal',
  left: new Float32Array([0.1, 0.2]),
  right: new Float32Array([0.3, 0.4]),
});

const client = () => new StemClient({ spawn: () => new FakeWorker() as unknown as Worker, monitor: new JobMonitor() });

afterEach(() => {
  FakeWorker.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('StemClient', () => {
  it('① 遅延起動 ── 作っただけでは worker は起きない', () => {
    const c = client();
    expect(c.available).toBe(true);
    expect(c.alive).toBe(false);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('③ 左右は transfer、重みは Blob のまま、進み具合の口も transfer。依頼にも口が載る', async () => {
    const c = client();
    const r = req();
    const l = r.left.buffer;
    const rr = r.right.buffer;
    const p = c.run(r);
    const w = FakeWorker.all[0]!;
    const t = w.transfers[0]!;
    expect(t[0] === l && t[1] === rr, '左右を transfer していない').toBe(true);
    expect(t).toHaveLength(3);
    // 3 つ目は進み具合の口(依頼に載せた物と同じ)
    expect(t[2] === w.seen[0]!.payload['progress']).toBe(true);
    expect(typeof (t[2] as MessagePort).postMessage).toBe('function');
    expect(w.seen[0]!.payload['model']).toBeInstanceOf(Blob);
    w.respond(w.seen[0]!.id, { ok: true, files: [] });
    await expect(p).resolves.toEqual({ ok: true, files: [] });
  });

  it('④ 進み具合が口から出る(文字列だけ受ける)', async () => {
    const c = client();
    const seen: string[] = [];
    const p = c.run(req(), (t) => seen.push(t));
    const w = FakeWorker.all[0]!;
    // 実物の MessageChannel なので、依頼に載った口へ書けば受け側(port1)に届く
    const port = w.seen[0]!.payload['progress'] as MessagePort;
    port.postMessage('歌声と楽器を分けています… 1 / 3');
    port.postMessage({ not: 'text' });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['歌声と楽器を分けています… 1 / 3']);
    w.respond(w.seen[0]!.id, { ok: true, files: [] });
    await p;
  });

  it('② アイドルで terminate する。飛んでいる間は kill しない', async () => {
    vi.useFakeTimers();
    const c = client();
    const p = c.run(req());
    const w = FakeWorker.all[0]!;
    vi.advanceTimersByTime(STEM_WORKER_IDLE_MS * 3);
    expect(w.terminated, '飛んでいる 1 件を殺した').toBe(false);
    w.respond(w.seen[0]!.id, { ok: true, files: [] });
    await p;
    vi.advanceTimersByTime(STEM_WORKER_IDLE_MS + 100);
    expect(w.terminated, 'アイドルで畳まれていない').toBe(true);
    expect(c.alive).toBe(false);
  });

  it('アイドルの時間は短すぎず長すぎない(重みと ORT のメモリは長く置かない)', () => {
    expect(STEM_WORKER_IDLE_MS).toBeGreaterThan(1_000);
    expect(STEM_WORKER_IDLE_MS).toBeLessThanOrEqual(30_000);
  });

  it('⑤ ワーカーが無い環境では、メインで回さず理由を言って断る', async () => {
    vi.stubGlobal('Worker', undefined);
    const c = new StemClient({ monitor: new JobMonitor() });
    expect(c.available).toBe(false);
    await expect(c.run(req())).rejects.toThrow('重い処理を別に動かす仕組みが使えない');
  });

  it('dispose すると待っている依頼は reject される(永久に待たない)', async () => {
    const c = client();
    const p = c.run(req());
    c.dispose();
    await expect(p).rejects.toThrow();
  });
});
