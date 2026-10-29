/** @vitest-environment node */
/**
 * 歌声と楽器を分ける手順(#674 / #949)の純粋な部分。
 *
 * 重みは使わず、**差し替えたモデル**(恒等 / 全部 0 / 左だけ通す)で手順そのものを確かめる:
 *  ① 🔴 塊をまたいでも継ぎ目が出ない(長さが塊の整数倍でなくても、全標本が元と一致する)
 *  ② 🔴 楽器 = 元 − 歌声(足すと元に戻る)/ 歌声が 0 なら楽器は元そのもの
 *  ③ 左右を取り違えない(左だけ通すモデルなら、歌声の右は 0)
 *  ④ 形の違う出力・注入した中断は握り潰さず投げる
 *  ⑤ 目録: 取得元は https の公開ホスト、STFT の窓長は FFT が扱える長さ
 */
import { describe, expect, it } from 'vitest';
import {
  STEM_MODELS,
  separateStems,
  stemChunkCount,
  stemHost,
  stemTags,
  toEncoderPcm,
  type StemModel,
} from '../../src/features/audio/stem-model';
import { chunkSamples } from '../../src/features/audio/stem-dsp';
import { smoothFactors } from '../../src/features/audio/stem-dsp';

const SMALL: StemModel = {
  id: 'test',
  label: 't',
  urls: ['https://example.test/m.onnx'],
  approxBytes: 1,
  minBytes: 1,
  sha256: null,
  stft: { nFft: 96, hop: 16, dimF: 49, dimT: 33 },
  zeroBins: 0,
  primary: 'vocals',
};

function signal(n: number, seed: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.4 * Math.sin(i * 0.05 * seed) + 0.2 * Math.sin(i * 0.31 + seed);
  return a;
}

describe('separateStems', () => {
  const chunk = chunkSamples(SMALL.stft); // 512
  const gen = chunk - SMALL.stft.nFft; // 416
  const n = gen * 3 + 123; // 塊の整数倍ではない

  it('🔴 恒等のモデルなら、歌声 = 元(継ぎ目も端も一致)、楽器 ≈ 0', async () => {
    const l = signal(n, 1);
    const r = signal(n, 2);
    const keepL = l.slice();
    const keepR = r.slice();
    let calls = 0;
    const out = await separateStems(l, r, {
      model: SMALL,
      infer: async (x) => {
        calls++;
        return x.slice();
      },
    });
    expect(calls, '塊の数が違う').toBe(stemChunkCount(n, SMALL.stft));
    expect(calls).toBeGreaterThan(3); // 空振り防止: 複数の塊を通っている
    let maxP = 0;
    let maxRest = 0;
    for (let i = 0; i < n; i++) {
      maxP = Math.max(maxP, Math.abs(out.primary[0][i]! - keepL[i]!), Math.abs(out.primary[1][i]! - keepR[i]!));
      maxRest = Math.max(maxRest, Math.abs(out.rest[0][i]!), Math.abs(out.rest[1][i]!));
    }
    expect(maxP).toBeLessThan(2e-4);
    expect(maxRest).toBeLessThan(2e-4);
    expect(out.primary[0].length).toBe(n);
    expect(out.rest[0].length).toBe(n);
  });

  it('🔴 全部 0 のモデルなら、歌声 = 無音、楽器 = 元そのもの(足すと元に戻る)', async () => {
    const l = signal(n, 3);
    const r = signal(n, 4);
    const keepL = l.slice();
    const keepR = r.slice();
    const out = await separateStems(l, r, { model: SMALL, infer: async (x) => new Float32Array(x.length) });
    for (let i = 0; i < n; i++) {
      expect(out.primary[0][i]).toBe(0);
      expect(out.rest[0][i]! + out.primary[0][i]!).toBeCloseTo(keepL[i]!, 6);
      expect(out.rest[1][i]! + out.primary[1][i]!).toBeCloseTo(keepR[i]!, 6);
    }
  });

  it('左右を取り違えない(左だけ通すモデル → 歌声の右は 0、楽器の左は ≈ 0)', async () => {
    const l = signal(n, 5);
    const r = signal(n, 6);
    const dims = SMALL.stft.dimF * SMALL.stft.dimT;
    const out = await separateStems(l, r, {
      model: SMALL,
      infer: async (x) => {
        const y = x.slice();
        y.fill(0, 2 * dims); // 右の実部・虚部を 0 に
        return y;
      },
    });
    expect(Math.max(...out.primary[1].map(Math.abs))).toBeLessThan(1e-6);
    expect(Math.max(...out.primary[0].map(Math.abs))).toBeGreaterThan(0.2);
    expect(Math.max(...out.rest[0].map(Math.abs))).toBeLessThan(2e-4);
    expect(Math.max(...out.rest[1].map(Math.abs))).toBeGreaterThan(0.2);
  });

  it('進み具合が塊の数まで進み、中断(checkpoint が投げる)は握り潰さない', async () => {
    const seen: Array<[number, number]> = [];
    const l = signal(n, 7);
    const r = signal(n, 8);
    await separateStems(l, r, {
      model: SMALL,
      infer: async (x) => x.slice(),
      onProgress: (d, t) => seen.push([d, t]),
    });
    const total = stemChunkCount(n, SMALL.stft);
    expect(seen.at(-1)).toEqual([total, total]);
    expect(seen).toHaveLength(total);

    let k = 0;
    await expect(
      separateStems(signal(n, 9), signal(n, 10), {
        model: SMALL,
        infer: async (x) => x.slice(),
        checkpoint: async () => {
          if (++k === 2) throw new Error('中断');
        },
      }),
    ).rejects.toThrow('中断');
  });

  it('出力の長さが入力と違えば、別のモデルとして断る', async () => {
    await expect(
      separateStems(signal(n, 1), signal(n, 2), { model: SMALL, infer: async () => new Float32Array(3) }),
    ).rejects.toThrow('形が想定と違います');
  });
});

describe('塊の数', () => {
  it('実際の設定(窓 7680 / hop 1024 / frame 256): 3 分の曲は 33 塊前後、1 標本でも 1 塊以上', () => {
    const spec = STEM_MODELS[0]!.stft;
    const samples = 3 * 60 * 44_100;
    const c = stemChunkCount(samples, spec);
    expect(c).toBeGreaterThan(30);
    expect(c).toBeLessThan(36);
    expect(stemChunkCount(1, spec)).toBe(1);
    // 塊の窓がちょうど曲の終わりまで届く
    const gen = chunkSamples(spec) - spec.nFft;
    expect(c * gen + spec.nFft).toBeGreaterThanOrEqual(samples + spec.nFft);
  });
});

describe('目録', () => {
  it('取得元は https の公開ホストで、窓長は FFT が扱える長さ', () => {
    expect(STEM_MODELS.length).toBeGreaterThan(0);
    for (const m of STEM_MODELS) {
      expect(m.urls.length).toBeGreaterThan(0);
      for (const u of m.urls) expect(new URL(u).protocol).toBe('https:');
      expect(smoothFactors(m.stft.nFft), `${m.id} の窓長`).not.toBeNull();
      expect(m.stft.dimF).toBeLessThanOrEqual(m.stft.nFft / 2 + 1);
      expect(m.minBytes).toBeLessThan(m.approxBytes);
    }
    expect(new Set(STEM_MODELS.map((m) => m.id)).size).toBe(STEM_MODELS.length);
  });
  it('名前に入れる語・ホスト名', () => {
    expect(stemTags(SMALL)).toEqual({ primary: '歌声', rest: '楽器' });
    expect(stemTags({ ...SMALL, primary: 'instrumental' })).toEqual({ primary: '楽器', rest: '歌声' });
    expect(stemHost('https://huggingface.co/a/b')).toBe('huggingface.co');
  });
});

describe('符号化器へ渡す形', () => {
  it('48kHz に直した左右が交互に並び、範囲 ±1 に収まる', () => {
    const l = new Float32Array(44_100).fill(0.5);
    const r = new Float32Array(44_100).fill(-2); // 範囲外 → 切る
    const pcm = toEncoderPcm(l, r);
    expect(pcm.length).toBe(48_000 * 2);
    expect(pcm[2 * 20_000]).toBeCloseTo(0.5, 2);
    expect(pcm[2 * 20_000 + 1]).toBe(-1);
  });
});
