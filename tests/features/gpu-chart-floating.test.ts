/**
 * 🔴 上端に固定したグラフの「実描画」と「見た目」の分離(v4.2 Phase 0 / PR-1)── 純関数。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPACT_HEIGHT_DEFAULT,
  compactLayoutOf,
  parseCompactHeight,
  parseCompactScale,
} from '../../src/features/chart/gpu-chart-floating';
import { parseChartBind } from '../../src/features/chart/gpu-chart-spec';

describe('compactLayoutOf', () => {
  it('既定: 見た目の高さ 140px に合わせて縦横比を保ったまま縮める', () => {
    const l = compactLayoutOf(800, 320);
    expect(COMPACT_HEIGHT_DEFAULT).toBe(140);
    expect(l.scale).toBeCloseTo(140 / 320, 2);
    expect(l.visualH).toBe(140);
    expect(l.visualW).toBe(350);
    // 縦横比が保たれている
    expect(l.visualW / l.visualH).toBeCloseTo(800 / 320, 2);
  });

  it('見た目の高さ・倍率の指定(倍率が優先)と範囲', () => {
    expect(compactLayoutOf(1000, 400, { compactHeight: 200 }).visualH).toBe(200);
    expect(compactLayoutOf(1000, 200, { compactHeight: 10 }).visualH).toBe(80); // 下限 80
    expect(compactLayoutOf(1000, 400, { compactHeight: 80 }).scale).toBe(0.25); // 倍率の下限 0.25
    expect(compactLayoutOf(1000, 400, { compactHeight: 9999 }).visualH).toBe(280); // 上限 280
    const s = compactLayoutOf(1000, 400, { compactHeight: 200, compactScale: 0.3 });
    expect(s.scale).toBe(0.3);
    expect(s.visualW).toBe(300);
    expect(compactLayoutOf(1000, 400, { compactScale: 0.01 }).scale).toBe(0.25);
    expect(compactLayoutOf(1000, 400, { compactScale: 2 }).scale).toBe(0.85);
  });

  it('実描画が見た目の高さより低ければ拡大しない(倍率 1)・壊れた値は既定', () => {
    expect(compactLayoutOf(600, 100).scale).toBe(1);
    expect(compactLayoutOf(600, 400, { compactHeight: Number.NaN }).visualH).toBe(140);
    expect(parseCompactHeight('140')).toBeUndefined();
    expect(parseCompactScale(-1)).toBeUndefined();
    expect(compactLayoutOf(0, 0).scale).toBe(1);
  });

  it('"bind" の compactHeight / compactScale を読む(書いたときだけ持つ)', () => {
    expect(parseChartBind('heading')).toEqual({ mode: 'heading', level: 2, sticky: true, windowDays: 7 });
    expect(parseChartBind({ mode: 'page', compactHeight: 160, compactScale: 0.5 })).toEqual({
      mode: 'page',
      level: 2,
      sticky: true,
      windowDays: 7,
      compactHeight: 160,
      compactScale: 0.5,
    });
    expect(parseChartBind({ mode: 'page', compactHeight: 'x' })).toEqual({ mode: 'page', level: 2, sticky: true, windowDays: 7 });
  });
});
