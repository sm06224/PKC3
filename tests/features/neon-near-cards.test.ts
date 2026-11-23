/**
 * 🔴 輪郭の近接発光(B2)の「どのカードが近いか」(pure)。
 * 守る主張: ① 半径の境界(ちょうど半径は近い・1px 外は遠い)② 局所座標 = ポインタ - 左上
 * ③ 複数のカードの並びで近いものだけ・index が渡した並びと一致 ④ 矩形の入れ物は汚れの印が立つまで測り直さない
 * ⑤ 光らせてよいかは「環境の問い = 真」かつ「スマホ用画面でない」の 1 か所。
 */
import { describe, expect, it, vi } from 'vitest';
import { createRectCache, distanceSqToRect, mayGlow, NEON_RADIUS, nearCards } from '../../src/features/neon/near-cards';

const box = (left: number, top: number, w = 100, h = 50) => ({ left, top, right: left + w, bottom: top + h });

describe('nearCards', () => {
  it('🔴 境界: ちょうど半径は近い側、1px 外は遠い側(矩形の左へ測る)', () => {
    const r = [box(200, 100)];
    expect(nearCards(r, 200 - 160, 120, 160).map((n) => n.index), 'ちょうど半径が外れた').toEqual([0]);
    expect(nearCards(r, 200 - 161, 120, 160), '半径の 1px 外が近い扱い').toEqual([]);
  });

  it('矩形の中は距離 0(半径が 0 でも近い)・角は斜めの距離で測る', () => {
    expect(distanceSqToRect(box(0, 0), 50, 25)).toBe(0);
    expect(nearCards([box(0, 0)], 50, 25, 0)).toHaveLength(1);
    // 右下の角から (3, 4) = 距離 5
    expect(distanceSqToRect(box(0, 0, 100, 50), 103, 54)).toBe(25);
    expect(nearCards([box(0, 0, 100, 50)], 103, 54, 5)).toHaveLength(1);
    expect(nearCards([box(0, 0, 100, 50)], 103, 54, 4.9)).toHaveLength(0);
  });

  it('🔴 局所座標はカードの左上が原点(丸める)', () => {
    const [n] = nearCards([box(200.4, 100.2)], 230.7, 90.1, 160);
    expect(n).toEqual({ index: 0, gx: 30, gy: -10 });
  });

  it('🔴 複数のカード: 近いものだけが、渡した並びの index で返る', () => {
    const rects = [box(0, 0), box(0, 60), box(0, 200), box(0, 400), box(0, 800)];
    const got = nearCards(rects, 50, 70, 160);
    expect(got.map((n) => n.index)).toEqual([0, 1, 2]);
    expect(got.find((n) => n.index >= 3)).toBeUndefined();
    // 空の並び
    expect(nearCards([], 0, 0, 160)).toEqual([]);
  });

  it('ゾーンごとの半径は正の数で、バーは本文より小さい', () => {
    for (const v of Object.values(NEON_RADIUS)) expect(v).toBeGreaterThan(0);
    expect(NEON_RADIUS.rail).toBeLessThan(NEON_RADIUS.log);
  });
});

describe('mayGlow(判定の 1 か所)', () => {
  it.each([
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ])('問い=%s スマホ=%s → %s', (q, phone, want) => {
    expect(mayGlow(q, phone)).toBe(want);
  });
});

describe('createRectCache(汚れの印)', () => {
  it('🔴 汚れの印が立つまで測り直さない・立ったら次の get で 1 回だけ測る', () => {
    const measure = vi.fn(() => [box(0, 0)]);
    const c = createRectCache(measure);
    expect(measure).not.toHaveBeenCalled(); // 作っただけでは測らない
    c.get();
    c.get();
    c.get();
    expect(measure, '毎回測っている').toHaveBeenCalledTimes(1);
    c.markDirty();
    c.markDirty();
    expect(measure, '汚した瞬間に同期で測った').toHaveBeenCalledTimes(1);
    c.get();
    c.get();
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('reset で捨てる(次の get は測り直す・値は空から)', () => {
    let n = 0;
    const c = createRectCache(() => [box(n++, 0)]);
    expect(c.get()[0]!.left).toBe(0);
    c.reset();
    expect(c.get()[0]!.left).toBe(1);
  });
});
