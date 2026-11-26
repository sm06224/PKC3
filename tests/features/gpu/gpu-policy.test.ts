import { describe, expect, it } from 'vitest';
import {
  GPU_IDLE_MS,
  GPU_MAX_ACTIVE_CONTEXTS,
  GPU_MAX_PIXEL_RATIO,
  effectivePixelRatio,
  nextFallbackBackend,
  pickLruEviction,
  selectGpuBackend,
  shouldRunGpuFrame,
} from '../../../src/features/gpu/gpu-policy';

describe('定数', () => {
  it('アイドル 30 秒・倍率の上限 2・同時コンテキスト 4', () => {
    expect(GPU_IDLE_MS).toBe(30_000);
    expect(GPU_MAX_PIXEL_RATIO).toBe(2);
    expect(GPU_MAX_ACTIVE_CONTEXTS).toBe(4);
  });
});

describe('selectGpuBackend — 全 8 組合せ', () => {
  const cases: Array<[boolean, boolean, boolean, string]> = [
    [true, true, true, '2d'],
    [true, true, false, '2d'],
    [true, false, true, '2d'],
    [true, false, false, '2d'],
    [false, true, true, 'webgpu'],
    [false, true, false, 'webgpu'],
    [false, false, true, 'webgl2'],
    [false, false, false, '2d'],
  ];
  for (const [portable, webgpu, webgl2, want] of cases) {
    it(`portable=${portable} webgpu=${webgpu} webgl2=${webgl2} → ${want}`, () => {
      expect(selectGpuBackend({ portable, webgpu, webgl2 })).toBe(want);
    });
  }
});

describe('nextFallbackBackend — WebGPU → WebGL2 → 2D', () => {
  it('WebGPU の下は、WebGL2 が使えれば WebGL2', () => {
    expect(nextFallbackBackend('webgpu', { portable: false, webgpu: true, webgl2: true })).toBe('webgl2');
  });
  it('WebGPU の下は、WebGL2 が使えなければ 2D', () => {
    expect(nextFallbackBackend('webgpu', { portable: false, webgpu: true, webgl2: false })).toBe('2d');
  });
  it('WebGL2 の下は 2D、2D の下は無い', () => {
    const caps = { portable: false, webgpu: true, webgl2: true };
    expect(nextFallbackBackend('webgl2', caps)).toBe('2d');
    expect(nextFallbackBackend('2d', caps)).toBeNull();
  });
});

describe('effectivePixelRatio', () => {
  it('通常の値はそのまま', () => {
    expect(effectivePixelRatio(1)).toBe(1);
    expect(effectivePixelRatio(1.5)).toBe(1.5);
    expect(effectivePixelRatio(2)).toBe(2);
  });
  it('上限 2 で止める(DPR 3 の端末)', () => {
    expect(effectivePixelRatio(3)).toBe(2);
    expect(effectivePixelRatio(3, 2.5)).toBe(2.5);
  });
  it('1 未満は 1 に上げる(0.5 で描くと粗くなるだけで VRAM はほぼ減らない)', () => {
    expect(effectivePixelRatio(0.5)).toBe(1);
  });
  it('異常値(0 / 負 / NaN / Infinity)は 1', () => {
    expect(effectivePixelRatio(0)).toBe(1);
    expect(effectivePixelRatio(-2)).toBe(1);
    expect(effectivePixelRatio(Number.NaN)).toBe(1);
    expect(effectivePixelRatio(Number.POSITIVE_INFINITY)).toBe(1);
  });
  it('上限そのものが壊れていても 1 を超えない', () => {
    expect(effectivePixelRatio(3, Number.NaN)).toBe(1);
    expect(effectivePixelRatio(3, 0)).toBe(1);
  });
});

describe('shouldRunGpuFrame', () => {
  it('画面内・タブが見えている・畳まれていない、の 3 つが揃ったときだけ描く', () => {
    for (const visible of [true, false]) {
      for (const pageVisible of [true, false]) {
        for (const disposed of [true, false]) {
          expect(shouldRunGpuFrame({ visible, pageVisible, disposed })).toBe(visible && pageVisible && !disposed);
        }
      }
    }
  });
});

describe('pickLruEviction', () => {
  const mk = (id: string, lastUsedAt: number, pinned?: boolean) => ({ id, lastUsedAt, pinned });

  it('上限以内なら何も畳まない', () => {
    expect(pickLruEviction([mk('a', 1), mk('b', 2)], 4)).toEqual([]);
    expect(pickLruEviction([mk('a', 1), mk('b', 2), mk('c', 3), mk('d', 4)], 4)).toEqual([]);
  });
  it('上限を 1 つ超えたら、最後に使ったのが最も古い 1 つ', () => {
    const got = pickLruEviction([mk('a', 50), mk('b', 10), mk('c', 30), mk('d', 40), mk('e', 60)], 4);
    expect(got.map((x) => x.id)).toEqual(['b']);
  });
  it('2 つ超えたら古い順に 2 つ', () => {
    const got = pickLruEviction([mk('a', 50), mk('b', 10), mk('c', 30), mk('d', 40), mk('e', 60), mk('f', 5)], 4);
    expect(got.map((x) => x.id)).toEqual(['f', 'b']);
  });
  it('🔴 ピン留めは最古でも畳まない(次に古い物を選ぶ)', () => {
    const got = pickLruEviction([mk('a', 1, true), mk('b', 2), mk('c', 3), mk('d', 4), mk('e', 5)], 4);
    expect(got.map((x) => x.id)).toEqual(['b']);
  });
  it('ピン留めだけで上限を超えているときは、ピン留めに触れない(件数が足りなくてもよい)', () => {
    const got = pickLruEviction([mk('a', 1, true), mk('b', 2, true), mk('c', 3)], 1);
    expect(got.map((x) => x.id)).toEqual(['c']);
  });
  it('同じ時刻なら並びの先から(安定)・入力の配列を変えない', () => {
    const input = [mk('a', 1), mk('b', 1), mk('c', 1)];
    const copy = input.map((x) => ({ ...x }));
    expect(pickLruEviction(input, 1).map((x) => x.id)).toEqual(['a', 'b']);
    expect(input).toEqual(copy);
  });
});
