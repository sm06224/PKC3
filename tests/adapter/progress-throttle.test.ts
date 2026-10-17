/** @vitest-environment node */
/** 進み具合の間引き: 20 件ごと、または 250ms ごと。最後の 1 件は出さない。 */
import { describe, expect, it } from 'vitest';
import { createProgressThrottle } from '../../src/adapter/ui/actions/progress-throttle';

describe('createProgressThrottle', () => {
  it('時間が進まなければ 20 件ごと', () => {
    const got: number[] = [];
    const tick = createProgressThrottle((n) => got.push(n), () => 0);
    for (let i = 1; i <= 59; i++) tick(i, 60);
    expect(got).toEqual([20, 40]);
  });

  it('件数が少なくても、250ms たてば出る(1 件が重い添付)', () => {
    const got: number[] = [];
    let t = 0;
    const tick = createProgressThrottle((n) => got.push(n), () => t);
    tick(1, 5);
    t = 249;
    tick(2, 5);
    t = 250;
    tick(3, 5);
    expect(got).toEqual([3]);
  });

  it('最後の 1 件(done === total)は出さない', () => {
    const got: number[] = [];
    let t = 0;
    const tick = createProgressThrottle((n) => got.push(n), () => t);
    t = 1000;
    tick(5, 5);
    expect(got).toEqual([]);
  });
});
