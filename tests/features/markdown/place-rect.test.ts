/**
 * 🔴 付箋の位置の負座標(v4.0 Phase 2 / PR-09、`src/features/markdown/place-rect.ts`)。
 *
 * - x / y は負も受ける(半角 `-120`・全角 `－１２０`・マイナス記号 `−120`)。範囲は ±100000
 * - 幅・高さの負は今までどおり断る(1 以上)
 * - `isPlacePosition` は本文へ書く側(`movePlace` / reducer)と同じ 1 本の門
 */
import { describe, expect, it } from 'vitest';
import {
  isPlacePosition,
  isPlaceRectNumber,
  parsePlaceRect,
  PLACE_RECT_MAX,
  type PlaceRectInput,
} from '../../../src/features/markdown/place-rect';

const input = (o: Partial<PlaceRectInput>): PlaceRectInput => ({ x: '', y: '', w: '', h: '', ...o });

describe('parsePlaceRect の負の位置', () => {
  it.each([
    ['半角', { x: '-120', y: '-40' }, { x: -120, y: -40 }],
    ['全角', { x: '－１２０', y: '－４０' }, { x: -120, y: -40 }],
    ['マイナス記号', { x: '−' + '7' }, { x: -7 }],
    ['空白つき', { y: '  -3 ' }, { y: -3 }],
    ['下限ちょうど', { x: String(-PLACE_RECT_MAX) }, { x: -PLACE_RECT_MAX }],
  ] as const)('🔴 x / y は負の整数として受ける: %s', (_n, o, rect) => {
    expect(parsePlaceRect(input(o))).toEqual({ ok: true, rect });
  });

  it.each([
    ['幅の負', { w: '-5' }, 'w', '1 以上'],
    ['高さの全角の負', { h: '－１' }, 'h', '1 以上'],
    ['x の下限超え', { x: String(-PLACE_RECT_MAX - 1) }, 'x', `${-PLACE_RECT_MAX} 以上`],
    ['y の上限超え', { y: String(PLACE_RECT_MAX + 1) }, 'y', `${PLACE_RECT_MAX} 以下`],
    ['負の小数', { x: '-1.5' }, 'x', '整数'],
    ['マイナスだけ', { y: '-' }, 'y', '整数'],
    ['マイナスが 2 つ', { x: '--5' }, 'x', '整数'],
  ] as const)('🔴 断る: %s', (_n, o, key, word) => {
    const r = parsePlaceRect(input(o));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.key).toBe(key);
    expect(r.error).toContain(word);
  });

  it('isPlacePosition と isPlaceRectNumber(x / y)は同じ範囲を受ける', () => {
    for (const n of [-PLACE_RECT_MAX, -1, 0, 1, PLACE_RECT_MAX]) {
      expect(isPlacePosition(n)).toBe(true);
      expect(isPlaceRectNumber('x', n)).toBe(true);
      expect(isPlaceRectNumber('y', n)).toBe(true);
    }
    for (const n of [-PLACE_RECT_MAX - 1, PLACE_RECT_MAX + 1, 0.5, Number.NaN]) {
      expect(isPlacePosition(n)).toBe(false);
      expect(isPlaceRectNumber('x', n)).toBe(false);
    }
    expect(isPlaceRectNumber('w', -1)).toBe(false);
    expect(isPlaceRectNumber('h', 0)).toBe(false);
    expect(isPlacePosition('-1')).toBe(false);
  });
});
