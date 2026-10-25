// @vitest-environment node
/**
 * 🔴 **話者分離**(#952 B4・#949)── 声の塊・特徴・まとめ方・全体(本物の RNNoise + 合成の話者)。
 *
 * ⚠ 合成の声での確認である。実際の人の声は測っていない(実機の確認項目)── 合成の話者は
 *   「男声 105Hz」「女声 200Hz(声道 1.17 倍)」「別の男声 140Hz(声道 1.05 倍)」。
 *   併合の距離 `MERGE_DISTANCE`(4.3)はこの 3 人の較正値:同じ話者どうし ≤ 3.7、別の話者どうし ≥ 4.8(男声どうし)/ ≥ 9(男女)。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  clusterSegments,
  decimate3,
  diarize,
  featureDistance,
  featureOf,
  fft,
  f0Of,
  MAX_PIECE_FRAMES,
  MAX_SPEAKERS,
  MERGE_DISTANCE,
  splitLong,
  voicedRuns,
  type SegmentFeature,
} from '../../src/features/audio/diarize';
import { runEngine, VOICE_RATE } from '../../src/features/audio/voice-lab';
import { concat, realEngine, scaleFormants, synthSpeech, VOWELS } from '../helpers/rnnoise-engine';

// 本物の RNNoise(wasm)を回す ── 全量を並列で回すと 5 秒の既定では足りない回がある
vi.setConfig({ testTimeout: 60_000 });

describe('声の塊(voicedRuns / splitLong)', () => {
  const vadOf = (spec: ReadonlyArray<readonly [number, number]>): Float32Array => {
    const out: number[] = [];
    for (const [v, n] of spec) for (let i = 0; i < n; i += 1) out.push(v);
    return Float32Array.from(out);
  };

  it('🔴 立ち上がりの高い値は無視し、ヒステリシスで塊を作り、短い隙間は埋め、短い塊は捨てる', () => {
    const vad = vadOf([
      [0.9, 5], // 立ち上がり(無視される。10 枠未満の高い値)
      [0.1, 20],
      [0.9, 100], // 塊 1: 30〜130
      [0.5, 10], // 0.4 以上は塊の中(ヒステリシス)
      [0.9, 20], // 続き(これも塊 1 に入る)
      [0.1, 20], // 隙間 20 枠 ≤ 30 → 埋める
      [0.9, 50], // 塊 1 の続き
      [0.1, 100],
      [0.9, 20], // 短い塊(20 < 30)── 捨てる
      [0.1, 100],
      [0.9, 60], // 塊 2
      [0.1, 10],
    ]);
    const runs = voicedRuns(vad);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.start).toBe(25);
    expect(runs[0]!.end).toBe(25 + 100 + 10 + 20 + 20 + 50);
    expect(runs[1]!.end - runs[1]!.start).toBe(60);
  });

  it('立ち上がりだけが高い vad は塊にしない。声が無ければ空', () => {
    expect(voicedRuns(vadOf([[0.99, 8], [0.0, 300]]))).toEqual([]);
    expect(voicedRuns(new Float32Array(0))).toEqual([]);
  });

  it('長い塊は等分する(各片が上限以下・隙間なく並ぶ)', () => {
    const parts = splitLong([{ start: 100, end: 100 + MAX_PIECE_FRAMES * 2 + 1 }, { start: 5000, end: 5100 }]);
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(p.end - p.start).toBeLessThanOrEqual(MAX_PIECE_FRAMES);
    expect(parts[0]!.end).toBe(parts[1]!.start);
    expect(parts[2]!.end).toBe(100 + MAX_PIECE_FRAMES * 2 + 1);
    expect(parts[3]).toEqual({ start: 5000, end: 5100 });
  });
});

describe('信号処理の部品', () => {
  it('FFT:素朴な DFT と一致し、純音は正しいビンに立つ', () => {
    const n = 64;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 12 * i) / n));
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    for (const k of [0, 5, 12, 20, 33]) {
      let dr = 0;
      let di = 0;
      for (let i = 0; i < n; i += 1) {
        dr += x[i]! * Math.cos((2 * Math.PI * k * i) / n);
        di -= x[i]! * Math.sin((2 * Math.PI * k * i) / n);
      }
      expect(re[k]!).toBeCloseTo(dr, 6);
      expect(im[k]!).toBeCloseTo(di, 6);
    }
    expect(Math.hypot(re[5]!, im[5]!)).toBeGreaterThan(30);
  });

  it('F0:パルス列の基本周波数を 3% 以内で当て、雑音と無音は声でないとする', () => {
    for (const f0 of [100, 150, 220, 300]) {
      const x = new Float32Array(400);
      for (let i = 0; i < 400; i += 1) x[i] = Math.sin((2 * Math.PI * f0 * i) / 16_000) + 0.5 * Math.sin((2 * Math.PI * 2 * f0 * i) / 16_000);
      const got = f0Of(x);
      expect(got, `${String(f0)}Hz`).not.toBeNull();
      expect(Math.abs(got! / f0 - 1)).toBeLessThan(0.03);
    }
    expect(f0Of(new Float32Array(400))).toBeNull();
    let s = 3;
    const noise = Float32Array.from({ length: 400 }, () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1);
    expect(f0Of(noise)).toBeNull();
  });

  it('3 つ平均して 1/3 の標本数にする', () => {
    expect(Array.from(decimate3(Float32Array.from([3, 3, 3, 6, 6, 6, 9]), 0, 7))).toEqual([3, 6]);
  });
});

describe('まとめ方(clusterSegments)', () => {
  const feat = (c1: number, lnF0: number): SegmentFeature => {
    const cep = new Float64Array(12);
    cep[0] = c1;
    return { cep, lnF0, frames: 100 };
  };
  const input = (c1: number, lnF0: number, ms = 5000) => ({ feature: feat(c1, lnF0), ms });

  it('🔴 離れた 3 つの声を、出てきた順の番号でまとめる', () => {
    const labels = clusterSegments([
      input(40, 4.7),
      input(41, 4.71),
      input(20, 5.4),
      input(40.5, 4.69),
      input(20.5, 5.41),
      input(60, 4.0),
      input(60.5, 4.0),
    ]);
    expect(labels).toEqual([0, 0, 1, 0, 1, 2, 2]);
  });

  it('近い声は 1 人にまとまり、距離は併合の境の前後で結果が変わる', () => {
    const a = feat(40, 4.7);
    const b = feat(40 + 4, 4.7);
    const d = featureDistance(a, b);
    expect(d).toBeGreaterThan(0);
    const tight = clusterSegments([input(40, 4.7), input(44, 4.7)], { mergeDistance: d - 0.01 });
    const loose = clusterSegments([input(40, 4.7), input(44, 4.7)], { mergeDistance: d + 0.01 });
    expect(tight).toEqual([0, 1]);
    expect(loose).toEqual([0, 0]);
  });

  it('話者は最大 MAX_SPEAKERS 人(離れすぎた声が多くても上限で止める)', () => {
    const many = Array.from({ length: 10 }, (_, i) => input(i * 40, 4 + i * 0.3));
    const labels = clusterSegments(many);
    expect(new Set(labels).size).toBe(MAX_SPEAKERS);
  });

  it('🔴 合計が短い話者(息継ぎや相づち)は、近い話者へ吸収する。全員が短いときは吸収しない', () => {
    const labels = clusterSegments([input(40, 4.7, 8000), input(20, 5.4, 8000), input(24, 5.3, 1000)]);
    expect(labels).toEqual([0, 1, 1]);
    const allShort = clusterSegments([input(40, 4.7, 1000), input(20, 5.4, 1000)]);
    expect(allShort).toEqual([0, 1]);
  });

  it('1 件・0 件でも落ちない', () => {
    expect(clusterSegments([input(1, 1)])).toEqual([0]);
    expect(clusterSegments([])).toEqual([]);
  });

  it('併合の距離の定数は 4.3(合成の話者での較正値)', () => {
    expect(MERGE_DISTANCE).toBe(4.3);
  });
});

describe('全体(diarize。本物の RNNoise + 合成の話者)', () => {
  const sec = VOICE_RATE;
  const M1 = (s: number, seed = 1) => synthSpeech(s, 105, VOWELS, sec, 200, seed);
  const F1 = (s: number, seed = 1) => synthSpeech(s, 200, scaleFormants(VOWELS, 1.17), sec, 230, seed);
  const gap = (s: number) => new Float32Array(Math.round(s * sec));

  it('🔴 男声と女声が交互に話す録音を、2 人・正しい時刻・交互の順に分ける', async () => {
    // M1 5s | 1.5s 無音 | F1 5s | 1.5s | M1 5s | 1.5s | F1 5s
    const pcm = concat(M1(5, 1), gap(1.5), F1(5, 2), gap(1.5), M1(5, 3), gap(1.5), F1(5, 4));
    const e = await realEngine();
    let result;
    try {
      const { clean, vad } = runEngine(pcm, e);
      result = diarize(clean, vad);
    } finally {
      e.destroy();
    }
    expect(result.speakers).toBe(2);
    expect(result.turns.map((t) => t.speaker)).toEqual([0, 1, 0, 1]);
    // 時刻:話している区間の頭と尻が実際の位置の 0.8 秒以内(合成の声は音節の強弱で出だしが小さく、声らしさの立ち上がりが遅れる)
    const truth = [
      [0, 5000],
      [6500, 11_500],
      [13_000, 18_000],
      [19_500, 24_500],
    ];
    result.turns.forEach((t, i) => {
      expect(Math.abs(t.startMs - truth[i]![0]!), `頭 ${String(i)}`).toBeLessThan(800);
      expect(Math.abs(t.endMs - truth[i]![1]!), `尻 ${String(i)}`).toBeLessThan(800);
    });
    // 塊の標本位置も turns と同じ時刻を指す
    for (const s of result.segments) expect(s.end).toBeGreaterThan(s.start);
  });

  it('同じ話者だけの録音は 1 人。声の無い録音は 0 人', async () => {
    const e = await realEngine();
    try {
      const one = runEngine(concat(M1(5, 1), gap(1.5), M1(5, 5)), e);
      expect(diarize(one.clean, one.vad).speakers).toBe(1);
      const none = runEngine(new Float32Array(3 * sec), e);
      expect(diarize(none.clean, none.vad)).toEqual({ segments: [], turns: [], speakers: 0 });
    } finally {
      e.destroy();
    }
  });

  it('特徴が取れない短すぎる塊は捨てる(落ちない)', () => {
    expect(featureOf(new Float32Array(300))).toBeNull();
  });
});

/**
 * 🔴 **まとめ方の計算量**(着地前レビュー ⚠4)。毎回すべての組を測り直す素朴な実装は O(n³): n=1000 で約 4 秒、n=3000 で約 2 分だった。
 * いまは各クラスタが「いちばん近い相手」を覚えて O(n²)。実測(node, 3 グループの合成特徴): n=300 → 21ms / 1000 → 86ms / 3000 → 859ms。
 * 🔑 速さそのものではなく**距離を測った回数**で守る(時計に頼らない)。素朴な実装との**結果の一致**も見る(速くしたことで答えが変わっていない)。
 */
describe('まとめ方の計算量と正しさ(clusterSegments)', () => {
  type Input = Parameters<typeof clusterSegments>[0][number];
  function make(n: number, groups: number, seed = 12345): Input[] {
    let s = seed;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    return Array.from({ length: n }, (_, i) => {
      const g = i % groups;
      const cep = new Float64Array(12);
      for (let k = 0; k < 12; k += 1) cep[k] = g * 6 + (k === 0 ? 3 : 0) * g + rnd();
      return { feature: { cep, lnF0: 4.6 + g * 0.3 + rnd() * 0.03, frames: 100 }, ms: 3000 + Math.abs(rnd()) * 3000 };
    });
  }

  /** 素朴な実装(毎回すべての組を測る)。重心の更新は同じ式を独立に書く。 */
  function naive(inputs: readonly Input[], tau: number, maxSp: number): number[] {
    interface C { m: number[]; cep: Float64Array; ln: number; w: number }
    let cs: C[] = inputs.map((p, i) => ({ m: [i], cep: p.feature.cep, ln: p.feature.lnF0, w: p.ms }));
    const d = (a: C, b: C): number => featureDistance({ cep: a.cep, lnF0: a.ln, frames: 1 }, { cep: b.cep, lnF0: b.ln, frames: 1 });
    while (cs.length > 1) {
      let bi = 0;
      let bj = 1;
      let bd = Number.POSITIVE_INFINITY;
      for (let i = 0; i < cs.length; i += 1)
        for (let j = i + 1; j < cs.length; j += 1) {
          const x = d(cs[i]!, cs[j]!);
          if (x < bd) {
            bd = x;
            bi = i;
            bj = j;
          }
        }
      if (bd >= tau && cs.length <= maxSp) break;
      const a = cs[bi]!;
      const b = cs[bj]!;
      const w = a.w + b.w;
      const cep = a.cep.map((v, k) => (v * a.w + b.cep[k]! * b.w) / w);
      const merged: C = { m: [...a.m, ...b.m], cep, ln: (a.ln * a.w + b.ln * b.w) / w, w };
      cs = [...cs.filter((_, k) => k !== bi && k !== bj), merged];
    }
    const label = new Array<number>(inputs.length).fill(-1);
    cs.forEach((c, k) => c.m.forEach((m) => (label[m] = k)));
    const order = new Map<number, number>();
    return label.map((l) => (order.has(l) ? order.get(l)! : (order.set(l, order.size), order.get(l)!)));
  }

  it('🔴 距離を測った回数が n の 2 乗で増える(3 乗ではない)── n を 2 倍にして 5 倍未満', () => {
    const count = (n: number): number => {
      const stats = { distances: 0 };
      clusterSegments(make(n, 3), { stats, minSpeakerMs: 0 });
      return stats.distances;
    };
    const a = count(300);
    const b = count(600);
    expect(a, '前提: 測っている').toBeGreaterThan(300 * 299 * 0.4);
    expect(b / a, `3 乗なら 8 倍近くになる(${String(a)} → ${String(b)})`).toBeLessThan(5);
    // 絶対値:n=1000 で実測 約 276 万回(最初の表が n²/2 = 50 万)。素朴な実装は約 1.7 億回
    const c = count(1000);
    expect(c).toBeLessThan(4_000_000);
  });

  it('🔴 素朴な実装と同じ結果(いくつかの種・グループ数で)', () => {
    for (const [n, groups, seed] of [[60, 3, 1], [90, 4, 2], [120, 7, 3], [80, 1, 4]] as const) {
      const inputs = make(n, groups, seed);
      expect(clusterSegments(inputs, { minSpeakerMs: 0 }), `n=${String(n)} groups=${String(groups)}`).toEqual(naive(inputs, MERGE_DISTANCE, MAX_SPEAKERS));
    }
  });

  it('🔴 n=3000 でも実用の時間で終わる(実測 約 0.9 秒。遅い環境でも 20 秒を超えない余裕で守る)', () => {
    const t = performance.now();
    const labels = clusterSegments(make(3000, 3));
    const took = performance.now() - t;
    expect(new Set(labels).size).toBe(3);
    expect(took, `${String(Math.round(took))}ms`).toBeLessThan(20_000);
  });
});
