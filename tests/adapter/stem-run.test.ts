// @vitest-environment node
/**
 * 🔴 **歌声と楽器を分ける「中身」**(#674 / #949)── ワーカーの中で動く `StemRunner`。
 *
 * 守りたい主張:
 *  ① 🔴 **本物の ONNX Runtime(wasm)で動く** ── 重みは手で組んだ恒等写像(`tests/helpers/identity-onnx.ts`)。
 *     読み込み → 入出力の形の検査 → 推論 → 前後の STFT → 左右 2ch の opus、が実物の ORT を通ってつながる。
 *     恒等写像なので「歌声 = 元」「楽器 ≈ 0」(式の誤りがあれば崩れる)
 *  ② 出力は 48kHz・ステレオで、符号化器へ渡る(左右が交互、1 秒ずつ、渡したら close)
 *  ③ 🔴 セッションは依頼の終わりに必ず `release()`(成功・失敗・形の不一致のどれでも)
 *  ④ 断る理由が値で返る(無音 / 空 / 長すぎる / ORT が読めない / 重みが読めない / 形が違う / 推論が落ちた / 符号化器が無い)
 *  ⑤ PCM の所有を取り、進み具合が口(MessagePort)へ流れる
 */
import { describe, expect, it, vi } from 'vitest';
import { StemRunner, inputShapeProblem, type OrtLike, type OrtSession, type StemJob } from '../../src/adapter/platform/stems/stem-run';
import { ENCODE_RATE, type AudioApi, type AudioDataLike } from '../../src/adapter/platform/voice/audio-encode';
import { demuxWebmOpus, opusHead } from '../../src/features/audio/webm-opus';
import { STEM_MODELS, STEM_RATE } from '../../src/features/audio/stem-model';
import { buildIdentityOnnx } from '../helpers/identity-onnx';

vi.setConfig({ testTimeout: 120_000 });

const spec = STEM_MODELS[0]!.stft;
const DIMS = [1, 4, spec.dimF, spec.dimT];

/** 偽の AudioEncoder(ステレオ対応)。渡った PCM の写しと open/close の数を記録する。 */
function fakeAudio(over: { supported?: boolean } = {}) {
  const log = { opened: 0, closed: 0, channels: [] as number[], copies: [] as Float32Array[], encoders: 0 };
  const api: AudioApi = {
    supported: async () => over.supported ?? true,
    makeData: (samples, rate, _ts, channels = 1) => {
      log.opened += 1;
      expect(rate).toBe(ENCODE_RATE);
      log.channels.push(channels);
      log.copies.push(samples.slice());
      const d: AudioDataLike & { frames: number } = {
        frames: samples.length / channels,
        close: () => {
          log.closed += 1;
        },
      };
      return d;
    },
    createEncoder: (init) => {
      let produced = 0;
      let first = true;
      log.encoders += 1;
      return {
        encodeQueueSize: 0,
        configure: () => {},
        encode: (data) => {
          const frames = (data as unknown as { frames: number }).frames;
          for (let i = 0; i < Math.ceil(frames / 960); i += 1) {
            const description = first ? opusHead(2, 312) : null;
            first = false;
            init.output({ timestamp: produced * 20_000, duration: 20_000, data: Uint8Array.of(produced & 0xff, 1, 2), description });
            produced += 1;
          }
        },
        flush: async () => {},
        close: () => {},
      };
    },
  };
  return { api, log };
}

/** 3 秒の左右(44.1kHz)。左 440Hz・右 880Hz の正弦波。 */
function tones(sec = 3): { left: Float32Array; right: Float32Array } {
  const n = Math.round(sec * STEM_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / STEM_RATE);
    right[i] = 0.3 * Math.sin((2 * Math.PI * 880 * i) / STEM_RATE);
  }
  return { left, right };
}

const onnx = (dims: readonly number[] = DIMS): Blob => new Blob([buildIdentityOnnx(dims) as BlobPart]);
const job = (over: Partial<StemJob> = {}): StemJob => ({ model: onnx(), modelId: 'mdx-vocal', ...tones(), ...over });

/** 本物の ORT(node 版 = onnxruntime-web の wasm)。 */
async function realOrt(): Promise<OrtLike> {
  const m = (await import('onnxruntime-web')) as unknown as OrtLike & { env: { logLevel?: string } };
  return m;
}

describe('本物の ORT で動く(恒等写像の重み)', () => {
  it('🔴 歌声 = 元(ステレオで 2ch 符号化)、楽器 ≈ 0。名前に入れる語は 歌声 / 楽器', async () => {
    const f = fakeAudio();
    const runner = new StemRunner({ loadOrt: realOrt, audioApi: f.api });
    const input = tones();
    const r = await runner.run(job({ left: input.left.slice(), right: input.right.slice() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((x) => x.tag)).toEqual(['歌声', '楽器']);
    // 符号化器へ渡ったのは左右交互のステレオ ×2 本(歌声・楽器)。AudioData は全部 close
    expect(new Set(f.log.channels)).toEqual(new Set([2]));
    expect(f.log.encoders).toBe(2);
    expect(f.log.opened).toBe(f.log.closed);
    // 歌声(最初の符号化)は元の 440 / 880Hz の正弦波、楽器(2 番目)は無音に近い
    const perStem = f.log.copies.length / 2;
    const vocal = f.log.copies.slice(0, perStem);
    const rest = f.log.copies.slice(perStem);
    const peak = (parts: Float32Array[], offset: number): number => {
      let m = 0;
      for (const p of parts) for (let i = offset; i < p.length; i += 2) m = Math.max(m, Math.abs(p[i]!));
      return m;
    };
    expect(peak(vocal, 0), '歌声の左が元の振幅(0.5)').toBeGreaterThan(0.45);
    expect(peak(vocal, 0)).toBeLessThan(0.55);
    expect(peak(vocal, 1), '歌声の右が元の振幅(0.3)').toBeGreaterThan(0.27);
    expect(peak(vocal, 1)).toBeLessThan(0.33);
    expect(peak(rest, 0), '楽器の左がほぼ無音(元 − 歌声)').toBeLessThan(0.01);
    expect(peak(rest, 1)).toBeLessThan(0.01);
    // 出力の WebM は 2ch の opus として読み直せる
    for (const file of r.files) {
      const d = demuxWebmOpus(new Uint8Array(file.bytes));
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.source.channels).toBe(2);
      expect(file.durationMs).toBeGreaterThan(2_500);
    }
  });

  it('モデルの入力の形が想定と違えば(本物の ORT が読んだ形で)断る。対照群: 合う形は通る', async () => {
    const f = fakeAudio();
    const runner = new StemRunner({ loadOrt: realOrt, audioApi: f.api });
    const bad = await runner.run(job({ model: onnx([1, 2, 64, 64]) }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toBe('bad-model');
      expect(bad.detail).toContain('入力の形が想定');
    }
    expect(f.log.opened, '形が違うのに符号化まで進んだ').toBe(0);
  });

  it('🔴 test D: 別の形の ONNX は、推論を 1 度も呼ばずに(実行前に inputMetadata で)断る', async () => {
    const calls: string[] = [];
    const { ort, log } = fakeOrt({
      shape: [1, 2, 64, 64],
      run: async () => {
        calls.push('run');
        return { y: { data: new Float32Array(1), dims: [1] } };
      },
    });
    const r = await new StemRunner({ loadOrt: async () => ort, audioApi: fakeAudio().api }).run(job());
    expect(r).toMatchObject({ ok: false, reason: 'bad-model' });
    expect(calls, '形が違うのに推論を呼んだ').toEqual([]);
    expect(log.tensors.length).toBe(0);
    expect(log.released, 'セッションは手放す').toBe(1);
  });

  it('ONNX ではない bytes は bad-model(ORT の読み込みの失敗を値で返す)', async () => {
    const runner = new StemRunner({ loadOrt: realOrt, audioApi: fakeAudio().api });
    const r = await runner.run(job({ model: new Blob([new Uint8Array(64).fill(7)]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-model');
  });
});

/** 偽の ORT: セッションの release の数・推論の中身を差し替えられる。 */
function fakeOrt(over: { run?: OrtSession['run']; create?: () => Promise<void>; shape?: unknown[] } = {}) {
  const log = { released: 0, created: 0, tensors: [] as Array<{ dims: readonly number[]; len: number }> };
  const ort: OrtLike = {
    InferenceSession: {
      create: async () => {
        log.created += 1;
        await over.create?.();
        return {
          inputNames: ['x'],
          outputNames: ['y'],
          inputMetadata: [{ name: 'x', isTensor: true, type: 'float32', shape: over.shape ?? [1, 4, spec.dimF, spec.dimT] }],
          run: over.run ?? (async (feeds) => ({ y: { data: (feeds['x'] as { data: Float32Array }).data.slice(), dims: DIMS } })),
          release: async () => {
            log.released += 1;
          },
        };
      },
    },
    Tensor: class {
      constructor(
        public type: string,
        public data: Float32Array,
        public dims: readonly number[],
      ) {
        log.tensors.push({ dims, len: data.length });
      }
    },
  };
  return { ort, log };
}

describe('セッションは依頼の終わりに必ず手放す', () => {
  it.each([
    ['成功', {}, true],
    ['推論が落ちた', { run: async () => Promise.reject(new Error('OOM')) }, false],
    ['出力が Float32Array ではない', { run: async () => ({ y: { data: [1, 2], dims: [2] } }) }, false],
    ['入力の形が違う', { shape: [1, 2, 3, 4] }, false],
  ] as const)('%s', async (_label, over, ok) => {
    const { ort, log } = fakeOrt(over as Parameters<typeof fakeOrt>[0]);
    const runner = new StemRunner({ loadOrt: async () => ort, audioApi: fakeAudio().api });
    const r = await runner.run(job());
    expect(r.ok).toBe(ok);
    expect(log.created).toBe(1);
    expect(log.released, 'セッションを手放していない').toBe(1);
  });

  it('推論には [1, 4, dimF, dimT] のテンソルを渡す(塊の数だけ)', async () => {
    const { ort, log } = fakeOrt();
    await new StemRunner({ loadOrt: async () => ort, audioApi: fakeAudio().api }).run(job());
    expect(log.tensors.length).toBeGreaterThan(0);
    for (const t of log.tensors) {
      expect(t.dims).toEqual(DIMS);
      expect(t.len).toBe(4 * spec.dimF * spec.dimT);
    }
  });
});

describe('断る理由', () => {
  const runner = (over: Partial<ConstructorParameters<typeof StemRunner>[0]> = {}) =>
    new StemRunner({ loadOrt: async () => fakeOrt().ort, audioApi: fakeAudio().api, ...over });

  it('空 / 無音 / 長すぎる / 知らないモデル', async () => {
    expect(await runner().run(job({ left: new Float32Array(0), right: new Float32Array(0) }))).toEqual({ ok: false, reason: 'empty' });
    expect(await runner().run(job({ left: new Float32Array(44_100), right: new Float32Array(44_100) }))).toEqual({ ok: false, reason: 'silent' });
    const long = new Float32Array(STEM_RATE * 60 * 11).fill(0.1);
    expect(await runner().run(job({ left: long, right: long }))).toEqual({ ok: false, reason: 'too-long' });
    expect(await runner().run(job({ modelId: 'nope' }))).toEqual({ ok: false, reason: 'unknown-model' });
  });

  it('ORT を読めない → no-runtime(理由つき)。重みが ORT に読めない → bad-model。符号化器が無い → no-encoder', async () => {
    const a = await runner({ loadOrt: async () => Promise.reject(new Error('wasm 404')) }).run(job());
    expect(a).toMatchObject({ ok: false, reason: 'no-runtime', detail: 'wasm 404' });
    const { ort } = fakeOrt({ create: async () => Promise.reject(new Error('Invalid model')) });
    const b = await runner({ loadOrt: async () => ort }).run(job());
    expect(b).toMatchObject({ ok: false, reason: 'bad-model', detail: 'Invalid model' });
    // ORT の起動の失敗(wasm が取れない)は、重みの不良ではなく no-runtime
    const { ort: ortBackend } = fakeOrt({ create: async () => Promise.reject(new Error('no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module')) });
    const d = await runner({ loadOrt: async () => ortBackend }).run(job());
    expect(d).toMatchObject({ ok: false, reason: 'no-runtime' });
    const c = await runner({ audioApi: null }).run(job());
    expect(c).toEqual({ ok: false, reason: 'no-encoder' });
  });

  it('推論の失敗は infer-failed(例外にしない)', async () => {
    const { ort } = fakeOrt({ run: async () => Promise.reject(new Error('OOM')) });
    const r = await runner({ loadOrt: async () => ort }).run(job());
    expect(r).toMatchObject({ ok: false, reason: 'infer-failed', detail: 'OOM' });
  });
});

describe('🔴 分けた結果の安全弁(設定違い・別のモデルを、聞かせる前に止める)', () => {
  const scaled = (k: number): OrtSession['run'] => async (feeds) => {
    const d = (feeds['x'] as { data: Float32Array }).data;
    return { y: { data: d.map((v) => v * k), dims: DIMS } };
  };
  const run = (over: Parameters<typeof fakeOrt>[0]) =>
    new StemRunner({ loadOrt: async () => fakeOrt(over).ort, audioApi: fakeAudio().api }).run(job());

  it('対照群: 恒等(compensate 込み)は通る', async () => {
    expect((await run({})).ok).toBe(true);
  });

  it('NaN を含む出力は bad-model(逆変換で全体に広がる前に止める)', async () => {
    const r = await run({ run: async (feeds) => {
      const d = (feeds['x'] as { data: Float32Array }).data.slice();
      d[5] = Number.NaN;
      return { y: { data: d, dims: DIMS } };
    } });
    expect(r).toMatchObject({ ok: false, reason: 'bad-model' });
    if (!r.ok) expect(r.detail).toContain('数でない値');
  });

  it('歌声が元の 1.5 倍を超えれば bad-model', async () => {
    const r = await run({ run: scaled(3) });
    expect(r).toMatchObject({ ok: false, reason: 'bad-model' });
    if (!r.ok) expect(r.detail).toContain('元より大きすぎます');
  });

  it('残りのエネルギーが元より大きければ bad-model(符号が反転した出力)', async () => {
    const r = await run({ run: scaled(-1) });
    expect(r).toMatchObject({ ok: false, reason: 'bad-model' });
    if (!r.ok) expect(r.detail).toContain('残りの音が元より大きく');
  });

  it('メモリ不足は(読み込みでも推論でも)infer-failed ── 重みの不良ではなくメモリの案内へ', async () => {
    const a = await run({ create: async () => Promise.reject(new Error('Aborted(OOM). Build with -sASSERTIONS')) });
    expect(a).toMatchObject({ ok: false, reason: 'infer-failed' });
    const b = await run({ run: async () => Promise.reject(new RangeError('Array buffer allocation failed')) });
    expect(b).toMatchObject({ ok: false, reason: 'infer-failed' });
    // 対照群: 普通の読み込み失敗は bad-model のまま
    const c = await run({ create: async () => Promise.reject(new Error('Invalid model')) });
    expect(c).toMatchObject({ ok: false, reason: 'bad-model' });
  });

  it('🔴 起動の失敗の判定は狭い: 重みの不良の文に wasm / backend / Failed to fetch の語が入っていても bad-model のまま', async () => {
    for (const msg of [
      "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
      'Unsupported model IR version: 12, max supported IR version: 10',
      "Failed to fetch external data file 'weights.wasm.data' for the model",
      'model.onnx: backend-specific op "FooBar" is not supported',
    ]) {
      const r = await run({ create: async () => Promise.reject(new Error(msg)) });
      expect(r, msg).toMatchObject({ ok: false, reason: 'bad-model' });
    }
    // 対照群: 実物の起動失敗の文は no-runtime
    for (const msg of [
      'no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module: blob:x',
      'WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f',
      'both async and sync fetching of the wasm failed',
    ]) {
      const r = await run({ create: async () => Promise.reject(new Error(msg)) });
      expect(r, msg).toMatchObject({ ok: false, reason: 'no-runtime' });
    }
  });
});

describe('🔴 分離をやめる(口の反対向きの合図)', () => {
  it('塊の合間で「やめる」を受けると cancelled で返り、セッションは手放す。符号化には進まない', async () => {
    const fa = fakeAudio();
    let port!: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (t: string) => void; close: () => void };
    port = { onmessage: null, postMessage: () => {}, close: () => {} };
    let runs = 0;
    const { ort, log } = fakeOrt({
      run: async (feeds) => {
        runs += 1;
        // 1 塊目の推論のあと、利用者が「やめる」を押した
        if (runs === 1) port.onmessage?.({ data: 'cancel' });
        return { y: { data: (feeds['x'] as { data: Float32Array }).data.slice(), dims: DIMS } };
      },
    });
    // 塊が 2 つ以上になる長さ(1 塊 = 261120 標本)
    const n = 261_120 * 2;
    const left = new Float32Array(n).fill(0.1);
    const r = await new StemRunner({ loadOrt: async () => ort, audioApi: fa.api }).run(
      job({ left, right: left.slice(), progress: port as unknown as MessagePort }),
    );
    expect(r).toEqual({ ok: false, reason: 'cancelled' });
    expect(runs, 'やめたあとも推論を続けた').toBe(1);
    expect(log.released).toBe(1);
    expect(fa.log.opened, '符号化まで進んだ').toBe(0);
  });

  it('対照群: 別の合図(cancel 以外)では止まらない', async () => {
    const port = { onmessage: null as ((ev: { data: unknown }) => void) | null, postMessage: () => {}, close: () => {} };
    const { ort } = fakeOrt({
      run: async (feeds) => {
        port.onmessage?.({ data: 'ping' });
        return { y: { data: (feeds['x'] as { data: Float32Array }).data.slice(), dims: DIMS } };
      },
    });
    const r = await new StemRunner({ loadOrt: async () => ort, audioApi: fakeAudio().api }).run(job({ progress: port as unknown as MessagePort }));
    expect(r.ok).toBe(true);
  });
});

describe('所有と進み具合', () => {
  it('🔴 依頼の PCM は受けた瞬間に空へ差し替える(使い終わった物を持ち続けない)', async () => {
    const j = job();
    expect(j.left.length).toBeGreaterThan(0);
    await new StemRunner({ loadOrt: async () => fakeOrt().ort, audioApi: fakeAudio().api }).run(j);
    expect(j.left.length).toBe(0);
    expect(j.right.length).toBe(0);
  });

  it('進み具合が口へ流れ、終わったら口を閉じる', async () => {
    const posted: string[] = [];
    let closed = 0;
    const port = { postMessage: (t: string) => posted.push(t), close: () => (closed += 1) } as unknown as MessagePort;
    await new StemRunner({ loadOrt: async () => fakeOrt().ort, audioApi: fakeAudio().api }).run(job({ progress: port }));
    expect(posted[0]).toContain('モデルを読み込んでいます');
    expect(posted.some((t) => /歌声と楽器を分けています… 1 \/ 1/.test(t))).toBe(true);
    expect(posted.some((t) => t.includes('「歌声」を書き出しています'))).toBe(true);
    expect(posted.some((t) => t.includes('「楽器」を書き出しています'))).toBe(true);
    expect(closed).toBe(1);
  });

  it('inputShapeProblem: 形が読めなければ断る・可変の次元は通す', () => {
    const m = STEM_MODELS[0]!;
    const s = (inputMetadata: unknown): OrtSession => ({ inputNames: ['x'], outputNames: ['y'], inputMetadata, run: async () => ({}), release: async () => {} });
    // 🔴 形が読めないときは素通りさせない(ORT 1.31 は inputMetadata を返す)
    expect(inputShapeProblem(s(undefined), m)).toContain('読み取れませんでした');
    expect(inputShapeProblem(s([{ name: 'x' }]), m)).toContain('読み取れませんでした');
    expect(inputShapeProblem(s([{ shape: ['batch', 4, spec.dimF, spec.dimT] }]), m)).toBeNull();
    expect(inputShapeProblem(s([{ shape: [1, 4, 100, spec.dimT] }]), m)).not.toBeNull();
  });
});
