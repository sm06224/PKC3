/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_STEPS_TO_MOVE,
  NO_BOUNDARY_STEP,
  stepAtBoundary,
  type BoundaryStep,
} from '../../src/features/boundary-step';

/** 何回か押す。⚠ 途中で移ったら、そこで止めて回数を返す。 */
function pressUntilMove(
  presses: readonly { dir: 'up' | 'down'; atBoundary: boolean }[],
): { moves: number; state: BoundaryStep } {
  let state = NO_BOUNDARY_STEP;
  let moves = 0;
  for (const p of presses) {
    const r = stepAtBoundary(state, p.dir, p.atBoundary);
    state = r.state;
    if (r.move) moves += 1;
  }
  return { moves, state };
}

describe('境界で同じ向きに 2 回(#524)', () => {
  it('🔴 端で同じ向きに 2 回で移る ── 1 回では移らない', () => {
    expect(pressUntilMove([{ dir: 'down', atBoundary: true }]).moves, '1 回で移った').toBe(0);
    expect(
      pressUntilMove([
        { dir: 'down', atBoundary: true },
        { dir: 'down', atBoundary: true },
      ]).moves,
    ).toBe(1);
  });

  /**
   * 🔴 **起点で回数が変わらない**(この規則を選んだ理由そのもの)。
   *
   * ⚠ もう 1 つの案(「端へ着いた押下は数えない」)だと、中ほどから始めると
   *   **3 回**、端から始めると **2 回**になり、user は数えられない。
   */
  it('🔴 どこから押し始めても、端に居るあいだの 2 回で移る', () => {
    // 中ほど(端でない)から:1 回目は捨てられ、端に着いてからの 2 回で移る
    const fromMiddle = pressUntilMove([
      { dir: 'down', atBoundary: false },
      { dir: 'down', atBoundary: true },
      { dir: 'down', atBoundary: true },
    ]);
    // 端から:同じく 2 回
    const fromEdge = pressUntilMove([
      { dir: 'down', atBoundary: true },
      { dir: 'down', atBoundary: true },
    ]);
    expect(fromMiddle.moves).toBe(1);
    expect(fromEdge.moves).toBe(1);
    // ⚠ 「端に居るあいだの押下数」が同じ = 数えられる規則である
    expect(BOUNDARY_STEPS_TO_MOVE).toBe(2);
  });

  it('🔴 端から離れたら数えを捨てる(端 → 途中 → 端 で 1 回では移らない)', () => {
    expect(
      pressUntilMove([
        { dir: 'down', atBoundary: true },
        { dir: 'down', atBoundary: false },
        { dir: 'down', atBoundary: true },
      ]).moves,
      '離れたのに数えが残った',
    ).toBe(0);
  });

  it('🔴 向きが変わったら数え直す(↓ のあと ↑ 1 回では移らない)', () => {
    expect(
      pressUntilMove([
        { dir: 'down', atBoundary: true },
        { dir: 'up', atBoundary: true },
      ]).moves,
      '向きが変わったのに数えを引き継いだ',
    ).toBe(0);
    // ⚠ 引き継がないだけで、**新しい向きの 1 回目としては数える**
    expect(
      pressUntilMove([
        { dir: 'down', atBoundary: true },
        { dir: 'up', atBoundary: true },
        { dir: 'up', atBoundary: true },
      ]).moves,
    ).toBe(1);
  });

  it('🔴 移ったら数えは 0 に戻る(移った先で 1 回押しただけでさらに飛ばない)', () => {
    const r = pressUntilMove([
      { dir: 'down', atBoundary: true },
      { dir: 'down', atBoundary: true }, // ここで移る
      { dir: 'down', atBoundary: true }, // 移った先の 1 回目
    ]);
    expect(r.moves, '移った先で 2 回目に飛んだ').toBe(1);
    expect(r.state).toEqual({ dir: 'down', count: 1 });
  });

  it('⚠ 押しっぱなしでも、端に居る限り 2 回ごとに 1 つずつ進む(いっぺんに飛ばない)', () => {
    const many = Array.from({ length: 8 }, () => ({ dir: 'down' as const, atBoundary: true }));
    expect(pressUntilMove(many).moves, '8 回で 4 つ進んでいない').toBe(4);
  });
});
