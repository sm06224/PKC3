// @vitest-environment node
/**
 * 🔴 **声の仕上げの実行**(#952 B1・#674・B5)── opus への書き出し(`audio-encode.ts`)とワーカーの中身(`voice-run.ts`)。
 *
 * 本物の RNNoise(wasm)+ 偽の opus 符号化器(本物の意味論を真似る:1 秒ずつ受け、20ms の packet を返す。受けた `AudioData` は
 * 呼び側が `close()` するまで開いたまま)。出力の WebM は**実装のほどき(`demuxWebmOpus`)にかけ直して**往復を確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeOpusWebm, ENCODE_RATE, type AudioApi, type AudioDataLike } from '../../src/adapter/platform/voice/audio-encode';
import { VoiceRunner, type EngineHandle } from '../../src/adapter/platform/voice/voice-run';
import { demuxWebmOpus, muxOpusWebm, opusHead, preSkipOf } from '../../src/features/audio/webm-opus';
import { VOICE_RATE } from '../../src/features/audio/voice-lab';
import { concat, mix, realEngine, scaleFormants, synthSpeech, synthVoice, VOWELS, whiteNoise } from '../helpers/rnnoise-engine';
import { readFileSync } from 'node:fs';
import { peakOf, rmsOf } from '../../src/features/audio/voice-lab';

/** 偽の AudioEncoder。入力 1 秒 → 50 個の 20ms packet(packet の中身は通し番号)。 */
function fakeAudio(over: { preSkip?: number | null; supported?: boolean; failAt?: number } = {}) {
  const log = { opened: 0, closed: 0, encodedSamples: 0, chunks: [] as number[], closedEncoder: 0, packets: 0, copies: [] as Float32Array[], stamps: [] as number[] };
  const api: AudioApi = {
    supported: async () => over.supported ?? true,
    makeData: (samples, rate, ts) => {
      log.opened += 1;
      log.chunks.push(samples.length);
      log.copies.push(samples.slice()); // 符号化器に渡った PCM(あとで中身を確かめる)
      expect(rate).toBe(ENCODE_RATE);
      log.stamps.push(ts);
      log.encodedSamples += samples.length;
      const d: AudioDataLike & { n: number } = {
        n: samples.length,
        close: () => {
          log.closed += 1;
        },
      };
      return d;
    },
    createEncoder: (init) => {
      let produced = 0;
      let first = true;
      return {
        encodeQueueSize: 0,
        configure: () => {},
        encode: (data) => {
          const n = (data as unknown as { n: number }).n;
          const packets = Math.ceil(n / 960);
          for (let i = 0; i < packets; i += 1) {
            if (over.failAt !== undefined && produced === over.failAt) {
              init.error(new Error('符号化に失敗'));
              return;
            }
            const description = first && over.preSkip !== null ? opusHead(1, over.preSkip ?? 312) : null;
            first = false;
            log.packets += 1;
            init.output({ timestamp: produced * 20_000, duration: 20_000, data: Uint8Array.of(produced & 0xff, 1, 2), description });
            produced += 1;
          }
        },
        flush: async () => {},
        close: () => {
          log.closedEncoder += 1;
        },
      };
    },
  };
  return { api, log };
}

// 本物の RNNoise(wasm)を回す ── 全量を並列で回すと 5 秒の既定では足りない回がある
vi.setConfig({ testTimeout: 60_000 });

describe('opus の WebM へ(encodeOpusWebm)', () => {
  it('🔴 1 秒ずつ渡して、渡した AudioData は全部 close し、出力は demux し直せる(packet・pre-skip・長さが往復する)', async () => {
    const f = fakeAudio({ preSkip: 312 });
    const pcm = new Float32Array(ENCODE_RATE * 2 + 4800).fill(0.1); // 2.1 秒
    const r = await encodeOpusWebm(pcm, f.api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(f.log.chunks).toEqual([48_000, 48_000, 4_800]);
    expect(f.log.stamps, '時刻(マイクロ秒)が 1 秒ずつ進んでいない').toEqual([0, 1_000_000, 2_000_000]);
    expect(f.log.closed, '渡した AudioData を閉じていない').toBe(f.log.opened);
    expect(f.log.closedEncoder).toBe(1);
    const d = demuxWebmOpus(r.bytes);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.source.packets).toHaveLength(f.log.packets);
    expect(d.source.packets[3]!.data[0]).toBe(3); // 中身が往復する
    expect(d.source.packets[3]!.ms).toBeCloseTo(60, 0);
    expect(preSkipOf(d.source.codecPrivate)).toBe(312);
    expect(d.source.codecDelayMs).toBeCloseTo(6.5, 1);
    expect(d.source.channels).toBe(1);
    expect(r.durationMs).toBeGreaterThan(2000);
    expect(r.durationMs).toBeLessThan(2200);
  });

  it('pre-skip が description に無ければ 312(opus の既定)を書く', async () => {
    const r = await encodeOpusWebm(new Float32Array(ENCODE_RATE).fill(0.1), fakeAudio({ preSkip: null }).api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = demuxWebmOpus(r.bytes);
    if (d.ok) expect(preSkipOf(d.source.codecPrivate)).toBe(312);
  });

  it('🔴 符号化できない環境・空・途中で落ちた回は、理由を返して部分的な file を作らない(符号化器は閉じる)', async () => {
    expect(await encodeOpusWebm(new Float32Array(10), null)).toEqual({ ok: false, reason: 'no-encoder' });
    expect(await encodeOpusWebm(new Float32Array(10), fakeAudio({ supported: false }).api)).toEqual({ ok: false, reason: 'no-encoder' });
    expect(await encodeOpusWebm(new Float32Array(0), fakeAudio().api)).toEqual({ ok: false, reason: 'empty' });
    const f = fakeAudio({ failAt: 30 });
    expect(await encodeOpusWebm(new Float32Array(ENCODE_RATE * 2).fill(0.1), f.api)).toEqual({ ok: false, reason: 'encode-failed' });
    expect(f.log.closedEncoder).toBe(1);
    expect(f.log.closed).toBe(f.log.opened);
  });
});

describe('muxOpusWebm', () => {
  it('空の packet 列は断る。OpusHead は 19 バイトで読み戻せる', () => {
    expect(muxOpusWebm({ packets: [], channels: 1, preSkip: 312, packetMs: 20 })).toEqual({ ok: false, reason: 'empty-range' });
    const h = opusHead(2, 400);
    expect(h).toHaveLength(19);
    expect(preSkipOf(h)).toBe(400);
    expect(preSkipOf(new Uint8Array(19))).toBeNull();
  });
});

describe('ワーカーの中身(VoiceRunner。本物の RNNoise)', () => {
  const sec = VOICE_RATE;
  const noisyTalk = (): Float32Array => mix(concat(synthVoice(2), new Float32Array(2 * sec)), whiteNoise(4 * sec, 0.03));

  function runner(audio: ReturnType<typeof fakeAudio>, track?: { created: number; destroyed: number }) {
    return new VoiceRunner({
      createEngine: async () => {
        const e = await realEngine();
        if (track) track.created += 1;
        const h: EngineHandle = {
          process: (f) => e.process(f),
          destroy: () => {
            e.destroy();
            if (track) track.destroyed += 1;
          },
        };
        return h;
      },
      audioApi: audio.api,
    });
  }

  it('🔴 雑音を減らした音を 1 件返す(長さは元と同じ)。エンジンは 1 依頼ごとに作って壊す', async () => {
    const audio = fakeAudio();
    const track = { created: 0, destroyed: 0 };
    const r = await runner(audio, track).run({ op: 'denoise', pcm: noisyTalk() });
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'audio') return;
    expect(r.files.map((f) => f.tag)).toEqual(['雑音を減らした']);
    expect(r.files[0]!.bytes.byteLength).toBeGreaterThan(100);
    expect(r.files[0]!.durationMs).toBeGreaterThan(3900);
    expect(r.files[0]!.durationMs).toBeLessThan(4100);
    expect(track).toEqual({ created: 1, destroyed: 1 });
    // 符号化器に渡った PCM が「雑音を減らした物」であること:渡した総量は入力と同じ長さ
    expect(audio.log.encodedSamples).toBe(4 * sec);
  });

  it('🔴 断る:無音・空・エンジンが作れない・符号化できない。どの回もエンジンは壊す(作れた回)', async () => {
    const track = { created: 0, destroyed: 0 };
    const r1 = await runner(fakeAudio(), track).run({ op: 'denoise', pcm: new Float32Array(sec) });
    expect(r1).toEqual({ ok: false, reason: 'silent' });
    expect(await runner(fakeAudio(), track).run({ op: 'denoise', pcm: new Float32Array(0) })).toEqual({ ok: false, reason: 'empty' });
    expect(track).toEqual({ created: 0, destroyed: 0 }); // 前段で断ったので、重い部品は起こしていない
    const broken = new VoiceRunner({
      createEngine: async () => {
        throw new Error('wasm が読めない');
      },
      audioApi: fakeAudio().api,
    });
    expect(await broken.run({ op: 'denoise', pcm: noisyTalk() })).toEqual({ ok: false, reason: 'no-engine' });
    const t2 = { created: 0, destroyed: 0 };
    const r4 = await runner(fakeAudio({ supported: false }), t2).run({ op: 'denoise', pcm: noisyTalk() });
    expect(r4).toEqual({ ok: false, reason: 'no-encoder' });
    expect(t2).toEqual({ created: 1, destroyed: 1 });
  });
});

describe('話し声とそれ以外に分ける(separate)', () => {
  const sec = VOICE_RATE;
  /** 伴奏の代わり:一定の和音(300Hz + 500Hz。RMS 約 0.1)。 */
  const bed = (n: number): Float32Array => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = 0.1 * Math.sin((2 * Math.PI * 300 * i) / sec) + 0.1 * Math.sin((2 * Math.PI * 500 * i) / sec);
    return out;
  };
  const engineFactory = async (): Promise<EngineHandle> => {
    const e = await realEngine();
    return { process: (f) => e.process(f), destroy: () => e.destroy() };
  };

  it('🔴 話し声と声以外の 2 つの音になり、足すと元に戻り、声の無い区間の伴奏は「声以外」の側に残る', async () => {
    const audio = fakeAudio();
    const input = mix(concat(synthVoice(2), new Float32Array(2 * sec)), bed(4 * sec));
    const r = await new VoiceRunner({ createEngine: engineFactory, audioApi: audio.api }).run({ op: 'separate', pcm: Float32Array.from(input) });
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'audio') return;
    expect(r.files.map((f) => f.tag)).toEqual(['話し声', '声以外']);
    // 符号化器に渡った PCM を 1 秒の塊から繋ぎ直す(声 → 声以外の順)
    const joined = Float32Array.from(audio.log.copies.flatMap((c) => Array.from(c)));
    const n = input.length;
    expect(joined.length).toBe(n * 2);
    const voice = joined.subarray(0, n);
    const rest = joined.subarray(n);
    // 前提:入力の無音区間(声なし)には伴奏が鳴っている
    expect(rmsOf(input, 3 * sec, 4 * sec)).toBeGreaterThan(0.09);
    // 声の側:声の無い区間の伴奏は 10dB 以上小さい。声の区間は残る
    expect(20 * Math.log10(rmsOf(input, 3 * sec, 4 * sec) / rmsOf(voice, 3 * sec, 4 * sec))).toBeGreaterThan(10);
    expect(rmsOf(voice, sec * 0.5, 2 * sec)).toBeGreaterThan(0.05);
    // 声以外の側:声の無い区間の伴奏がほぼそのまま残る(7 割以上)
    expect(rmsOf(rest, 3 * sec, 4 * sec) / rmsOf(input, 3 * sec, 4 * sec)).toBeGreaterThan(0.7);
    // 足せば元に戻る(符号化前の PCM で)
    let maxDiff = 0;
    for (let i = 0; i < n; i += 1) maxDiff = Math.max(maxDiff, Math.abs(voice[i]! + rest[i]! - input[i]!));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it('🔴 声が見つからない音(伴奏だけ)は 2 つ作らず、理由を返す', async () => {
    const audio = fakeAudio();
    const r = await new VoiceRunner({ createEngine: engineFactory, audioApi: audio.api }).run({
      op: 'separate',
      pcm: bed(3 * sec),
    });
    expect(r).toEqual({ ok: false, reason: 'no-voice' });
    expect(audio.log.opened, '断ったのに符号化した').toBe(0);
  });
});

describe('話者を分ける(diarize)', () => {
  const sec = VOICE_RATE;
  const engineFactory = async (): Promise<EngineHandle> => {
    const e = await realEngine();
    return { process: (f) => e.process(f), destroy: () => e.destroy() };
  };

  it('🔴 男声と女声が交互の録音から、2 人・交互の区間を返す(符号化はしない)', async () => {
    const audio = fakeAudio();
    const gap = new Float32Array(Math.round(1.5 * sec));
    const pcm = concat(
      synthSpeech(5, 105, VOWELS, sec, 200, 1),
      gap,
      synthSpeech(5, 200, scaleFormants(VOWELS, 1.17), sec, 230, 2),
      gap,
      synthSpeech(5, 105, VOWELS, sec, 200, 3),
    );
    const r = await new VoiceRunner({ createEngine: engineFactory, audioApi: audio.api }).run({ op: 'diarize', pcm });
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'turns') return;
    expect(r.speakers).toBe(2);
    expect(r.turns.map((t) => t.speaker)).toEqual([0, 1, 0]);
    expect(r.durationMs).toBe(Math.round((pcm.length * 1e3) / sec));
    expect(audio.log.opened, '話者分離で符号化している').toBe(0);
  });

  it('声が見つからない音は理由を返す', async () => {
    const bedOnly = new Float32Array(3 * sec);
    for (let i = 0; i < bedOnly.length; i += 1) bedOnly[i] = 0.1 * Math.sin((2 * Math.PI * 300 * i) / sec);
    const r = await new VoiceRunner({ createEngine: engineFactory, audioApi: fakeAudio().api }).run({ op: 'diarize', pcm: bedOnly });
    expect(r).toEqual({ ok: false, reason: 'no-voice' });
  });
});

describe('声の大きさをそろえる(level)', () => {
  const sec = VOICE_RATE;
  const engineFactory = async (): Promise<EngineHandle> => {
    const e = await realEngine();
    return { process: (f) => e.process(f), destroy: () => e.destroy() };
  };

  it('🔴 遠い人(小さい)と近い人(大きい)の差が縮まる。長さは変わらない', async () => {
    const audio = fakeAudio();
    const far = synthSpeech(5, 105, VOWELS, sec, 200, 1).map((v) => v * 0.15);
    const near = synthSpeech(5, 200, scaleFormants(VOWELS, 1.17), sec, 230, 2);
    const gap = new Float32Array(Math.round(1.5 * sec));
    const pcm = concat(far, gap, near);
    const farRange = { from: Math.round(0.5 * sec), to: 5 * sec };
    const nearRange = { from: Math.round(7 * sec), to: 11 * sec };
    const ratioIn = rmsOf(pcm, nearRange.from, nearRange.to) / rmsOf(pcm, farRange.from, farRange.to);
    expect(ratioIn, '前提: 入力は 5 倍以上離れている').toBeGreaterThan(5);
    const r = await new VoiceRunner({ createEngine: engineFactory, audioApi: audio.api }).run({ op: 'level', pcm: Float32Array.from(pcm) });
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'audio') return;
    expect(r.files.map((f) => f.tag)).toEqual(['声の大きさをそろえた']);
    const out = Float32Array.from(audio.log.copies.flatMap((c) => Array.from(c)));
    expect(out.length).toBe(pcm.length);
    const ratioOut = rmsOf(out, nearRange.from, nearRange.to) / rmsOf(out, farRange.from, farRange.to);
    expect(ratioOut, '差が縮まっていない').toBeLessThan(2);
    expect(ratioOut).toBeGreaterThan(0.5);
    expect(rmsOf(out, farRange.from, farRange.to), '遠い人が持ち上がっていない').toBeGreaterThan(rmsOf(pcm, farRange.from, farRange.to) * 3);
    expect(peakOf(out), '割れている').toBeLessThanOrEqual(1);
  });

  it('🔴 長く話し続ける 2 人(それぞれ 14 秒 = 6 秒の塊 3 つ)でも、塊を全部見て、どの塊も大きさが寄る', async () => {
    const audio = fakeAudio();
    const far = synthSpeech(14, 105, VOWELS, sec, 200, 1).map((v) => v * 0.3);
    const near = synthSpeech(14, 200, scaleFormants(VOWELS, 1.17), sec, 230, 2);
    const gap = new Float32Array(Math.round(1.5 * sec));
    const pcm = concat(far, gap, near, gap, synthSpeech(7, 105, VOWELS, sec, 200, 3).map((v) => v * 0.3));
    const r = await new VoiceRunner({ createEngine: engineFactory, audioApi: audio.api }).run({ op: 'level', pcm: Float32Array.from(pcm) });
    expect(r.ok).toBe(true);
    const out = Float32Array.from(audio.log.copies.flatMap((c) => Array.from(c)));
    // 声のある 2 秒窓(声の端 0.7 秒は避ける)の大きさを全部集める
    const windows: Array<[number, number]> = [];
    for (const [from, to] of [[0.7, 13.3], [15.5 + 0.7, 15.5 + 13.3], [31 + 0.7, 31 + 6.3]] as const) {
      for (let t = from; t + 2 <= to; t += 2) windows.push([Math.round(t * sec), Math.round((t + 2) * sec)]);
    }
    expect(windows.length, '前提: 窓が足りない').toBeGreaterThanOrEqual(10);
    const rmsIn = windows.map(([a, b]) => rmsOf(pcm, a, b));
    const rmsOut = windows.map(([a, b]) => rmsOf(out, a, b));
    expect(Math.max(...rmsIn) / Math.min(...rmsIn), '前提: 入力は 3 倍以上ばらつく').toBeGreaterThan(3);
    expect(Math.max(...rmsOut) / Math.min(...rmsOut), '長い塊の後ろの方が寄っていない').toBeLessThan(2.2);
  });

  it('🔴 level はクラスタリング(話者の特徴・距離)を走らせない ── 声の塊の切り出しだけを使う(source 読み)', () => {
    const src = readFileSync('src/adapter/platform/voice/voice-run.ts', 'utf8');
    const from = src.indexOf("job.op === 'level'");
    const to = src.indexOf('// separate:', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const branch = src.slice(from, to);
    expect(branch).toContain('splitLong(voicedRuns(vad))');
    expect(branch).not.toMatch(/diarize\(|clusterSegments|featureOf/);
  });

  it('🔴 使い終わった PCM を手放す:依頼の pcm は受け取った瞬間に空になる(所有を取る)', async () => {
    const audio = fakeAudio();
    const job = { op: 'level' as const, pcm: Float32Array.from(concat(synthSpeech(3, 105, VOWELS, sec, 200, 1), new Float32Array(sec))) };
    const keep = job.pcm;
    await new VoiceRunner({ createEngine: engineFactory, audioApi: audio.api }).run(job);
    expect(job.pcm.length, '依頼が PCM を持ち続けている').toBe(0);
    expect(keep.length, '前提: 渡した配列そのものは壊していない').toBeGreaterThan(0);
  });

  it('声が無い音は理由を返す(符号化しない)', async () => {
    const audio = fakeAudio();
    const bed = new Float32Array(3 * sec);
    for (let i = 0; i < bed.length; i += 1) bed[i] = 0.1 * Math.sin((2 * Math.PI * 300 * i) / sec);
    expect(await new VoiceRunner({ createEngine: engineFactory, audioApi: audio.api }).run({ op: 'level', pcm: bed })).toEqual({ ok: false, reason: 'no-voice' });
    expect(audio.log.opened).toBe(0);
  });
});
