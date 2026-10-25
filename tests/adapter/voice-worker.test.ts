// @vitest-environment node
/**
 * 🔴 **声の仕上げワーカーの配線**(`voice-worker.ts`。#952 着地前レビュー ⚠6)── 中身(`voice-run.ts`)ではなく、配線そのもの。
 *
 * 守りたい主張:
 *  ① `self.onmessage` が付き、`{ id, payload }` を受けて runner を走らせ、`{ id, ok: true, result }` を返す(id をそのまま返す)
 *  ② 返す bytes は **transfer** する(ゼロコピー)── 音の結果だけ。断り・話者の結果は transfer しない
 *  ③ RNNoise の wasm は **最初の依頼で 1 度だけ**読み込み(`loaded` のキャッシュ)、依頼ごとに `DenoiseState` を作って `destroy()` する
 *  ④ 読み込みに**失敗したら覚えない**(次の依頼で読み直せる)── 失敗が一生残ると、1 度の事故で以後ずっと使えない
 *  ⑤ runner が投げたら `{ id, ok: false, error }`(握り潰さない)
 *
 * 本物のワーカーは立てず、`self` を偽物に差し替えて同じモジュールを読み込む(本物の onmessage に両端を実物で繋ぐ)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const encode = vi.hoisted(() => ({ fn: vi.fn() }));
const rn = vi.hoisted(() => ({
  load: vi.fn(),
  created: 0,
  destroyed: 0,
}));

vi.mock('@shiguredo/rnnoise-wasm', () => ({
  Rnnoise: {
    load: (): Promise<unknown> => rn.load(),
  },
}));
vi.mock('../../src/adapter/platform/voice/audio-encode', () => ({
  nativeAudioApi: () => null,
  encodeOpusWebm: (...a: unknown[]) => encode.fn(...a),
}));

interface FakeCtx {
  onmessage: ((ev: { data: unknown }) => void) | null;
  posted: Array<{ msg: { id: number; ok: boolean; result?: { ok: boolean; kind?: string; files?: Array<{ bytes: ArrayBuffer }>; reason?: string }; error?: string }; transfer: Transferable[] }>;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

function engineModule() {
  const instance = {
    createDenoiseState: () => {
      rn.created += 1;
      return {
        processFrame: (): number => 0.9,
        destroy: (): void => {
          rn.destroyed += 1;
        },
      };
    },
  };
  return instance;
}

/** 声らしい(無音でない)PCM。 */
const pcm = (): Float32Array => Float32Array.from({ length: 48_000 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 200 * i) / 48_000));

let ctx: FakeCtx;

async function boot(): Promise<void> {
  vi.resetModules();
  ctx = {
    onmessage: null,
    posted: [],
    postMessage(msg: unknown, transfer: Transferable[] = []): void {
      this.posted.push({ msg: msg as FakeCtx['posted'][number]['msg'], transfer });
    },
  };
  (globalThis as { self?: unknown }).self = ctx;
  await import('../../src/adapter/platform/voice/voice-worker');
}

/** メッセージを 1 つ送り、返事が 1 つ増えるまで待つ。 */
async function send(id: number, payload: unknown): Promise<FakeCtx['posted'][number]> {
  const before = ctx.posted.length;
  ctx.onmessage!({ data: { id, payload } });
  for (let i = 0; i < 200 && ctx.posted.length === before; i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(ctx.posted.length, `${String(id)} の返事が来ない`).toBe(before + 1);
  return ctx.posted[before]!;
}

beforeEach(() => {
  rn.load.mockReset();
  rn.created = 0;
  rn.destroyed = 0;
  encode.fn.mockReset();
  rn.load.mockImplementation(async () => engineModule());
  encode.fn.mockImplementation(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]), durationMs: 1000 }));
});
afterEach(() => {
  delete (globalThis as { self?: unknown }).self;
});

describe('voice-worker の配線', () => {
  it('① onmessage が付き、id をそのまま返す。結果は { ok: true, result }', async () => {
    await boot();
    expect(typeof ctx.onmessage).toBe('function');
    const r = await send(41, { op: 'denoise', pcm: pcm() });
    expect(r.msg.id).toBe(41);
    expect(r.msg.ok).toBe(true);
    expect(r.msg.result).toMatchObject({ ok: true, kind: 'audio' });
    expect(r.msg.result!.files).toHaveLength(1);
  });

  it('🔴 ② 音の結果の bytes を transfer する(ゼロコピー)。2 本なら 2 本とも。断りは transfer しない', async () => {
    await boot();
    const one = await send(1, { op: 'denoise', pcm: pcm() });
    expect(one.transfer).toHaveLength(1);
    expect(one.transfer[0]).toBe(one.msg.result!.files![0]!.bytes);

    // 声が見つかれば 2 本(話し声 / 声以外)。偽のエンジンは常に声らしいと言う
    encode.fn.mockImplementation(async () => ({ ok: true, bytes: new Uint8Array(8), durationMs: 1000 }));
    const two = await send(2, { op: 'separate', pcm: pcm() });
    expect(two.msg.result).toMatchObject({ ok: true, kind: 'audio' });
    expect(two.transfer).toHaveLength(2);
    expect(two.transfer).toEqual(two.msg.result!.files!.map((f) => f.bytes));

    const refused = await send(3, { op: 'denoise', pcm: new Float32Array(10) }); // 無音
    expect(refused.msg.result).toEqual({ ok: false, reason: 'silent' });
    expect(refused.transfer).toEqual([]);
  });

  it('🔴 ③ wasm は 1 度だけ読み込み、依頼ごとに DenoiseState を作って壊す', async () => {
    await boot();
    for (const id of [1, 2, 3]) await send(id, { op: 'denoise', pcm: pcm() });
    expect(rn.load, '依頼のたびに wasm を読み直している').toHaveBeenCalledTimes(1);
    expect(rn.created).toBe(3);
    expect(rn.destroyed, 'DenoiseState を壊していない(wasm のメモリが依頼ごとに残る)').toBe(3);
  });

  it('🔴 ④ 読み込みに失敗した回は覚えない:no-engine で返し、次の依頼で読み直して成功する', async () => {
    rn.load.mockRejectedValueOnce(new Error('wasm が読めない'));
    await boot();
    const bad = await send(1, { op: 'denoise', pcm: pcm() });
    expect(bad.msg.result).toEqual({ ok: false, reason: 'no-engine' });
    expect(rn.created).toBe(0);
    const good = await send(2, { op: 'denoise', pcm: pcm() });
    expect(good.msg.result).toMatchObject({ ok: true });
    expect(rn.load, '失敗を覚えて読み直していない').toHaveBeenCalledTimes(2);
    expect(rn.destroyed).toBe(1);
  });

  it('🔴 ⑤ runner が投げたら { ok: false, error } で返す(握り潰さない・transfer しない)。エンジンは壊す', async () => {
    encode.fn.mockRejectedValueOnce(new Error('符号化器が落ちた'));
    await boot();
    const r = await send(9, { op: 'denoise', pcm: pcm() });
    expect(r.msg).toMatchObject({ id: 9, ok: false, error: '符号化器が落ちた' });
    expect(r.transfer).toEqual([]);
    expect(rn.destroyed, '落ちた回もエンジンを壊す').toBe(1);
    // 落ちた 1 件が次を巻き込まない
    const next = await send(10, { op: 'denoise', pcm: pcm() });
    expect(next.msg.ok).toBe(true);
  });

  it('モジュールを読み込んだだけでは何も走らない(依頼が来るまで wasm を読まない)', async () => {
    await boot();
    expect(rn.load).not.toHaveBeenCalled();
    expect(ctx.posted).toEqual([]);
  });
});
