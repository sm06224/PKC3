/** @vitest-environment happy-dom */
/**
 * 🔴 波形を焼く(#1232)── 縦だけ `devicePixelRatio` 倍で焼く / canvas は焼いたら画素を返す / 山 1 つ = 横 1 画素。
 * canvas を作れない環境(happy-dom)では `null`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakeWavePng, WAVE_HEIGHT } from '../../src/adapter/ui/render/wave-bake';

interface FakeCanvas {
  width: number;
  height: number;
  rects: Array<[number, number, number, number]>;
  getContext: () => { fillStyle: string; fillRect: (...a: [number, number, number, number]) => void };
  toBlob: (cb: (b: Blob | null) => void) => void;
}

function stubCanvas(): { made: FakeCanvas[]; sizeAtBlob: Array<[number, number]> } {
  const made: FakeCanvas[] = [];
  const sizeAtBlob: Array<[number, number]> = [];
  const real = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return real(tag);
    const c: FakeCanvas = {
      width: 0,
      height: 0,
      rects: [],
      getContext: () => ({ fillStyle: '', fillRect: (...a) => void c.rects.push(a) }),
      toBlob: (cb) => {
        sizeAtBlob.push([c.width, c.height]);
        cb(new Blob(['x']));
      },
    };
    made.push(c);
    return c as unknown as HTMLCanvasElement;
  }) as typeof document.createElement);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:baked');
  return { made, sizeAtBlob };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bakeWavePng', () => {
  it('横は山の数、縦は DPR 倍(上限 3 倍)で焼き、焼いたら画素を返す', async () => {
    const t = stubCanvas();
    const url = await bakeWavePng(new Float32Array([0.1, 0.9, 0]), '#000', 2);
    expect(url).toBe('blob:baked');
    expect(t.sizeAtBlob).toEqual([[3, WAVE_HEIGHT * 2]]);
    expect(t.made[0]!.rects).toHaveLength(3);
    // 山 0.9 の線は縦 72 画素(80 * 0.9)
    expect(t.made[0]!.rects[1]![3]).toBe(72);
    // 焼いた後は backing store を返す
    expect([t.made[0]!.width, t.made[0]!.height]).toEqual([0, 0]);
    await bakeWavePng(new Float32Array([0.5]), '#000', 10);
    expect(t.sizeAtBlob[1]).toEqual([1, WAVE_HEIGHT * 3]);
  });

  it('無音の山も 1 画素の線は引く / 空の山なら焼かない / canvas が無ければ null', async () => {
    const t = stubCanvas();
    await bakeWavePng(new Float32Array([0]), '#000', 1);
    expect(t.made[0]!.rects[0]![3]).toBe(1);
    expect(await bakeWavePng(new Float32Array(0), '#000', 1)).toBeNull();
    vi.restoreAllMocks();
    expect(await bakeWavePng(new Float32Array([0.5]), '#000', 1)).toBeNull();
  });
});
