/**
 * 🔴 **smoke の「起動の数」に置いた予算を守る**(#820)。
 *
 * user 指摘 2026-09-09:「**改修一件で増えるテストが毎ターンの負荷に積み上がる /
 * o(n2)のテストケース広がりを回避するための方策を**」
 *
 * ⚠ **減らすための門ではない。** 問うのは 1 つだけ ──
 * **その 1 件は、本当にもう 1 回起動しないと書けないか**。
 * 起動 1 回は実測 **1.63 秒**で、以後すべての回に積まれる。assert を足すのは
 * ほぼ 0 秒である(理由と実測は `scripts/smoke-budget.mjs` の冒頭)。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 予算の規則は素の .mjs(ビルド対象外の CI script 群)
import { BOOT_BUDGET, BOOT_FLOOR, countSmoke, countSpec } from '../scripts/smoke-budget.mjs';

const budget = BOOT_BUDGET as number;
const floor = BOOT_FLOOR as number;
const count = countSmoke as (dir?: string) => {
  boots: number;
  tests: number;
  per: { spec: string; boots: number; tests: number }[];
};
const one = countSpec as (text: string) => { boots: number; tests: number };

describe('smoke の起動の数', () => {
  const r = count();

  it('🔴 予算の内側に在る(超えたら、新しい起動ではなく既存の道中へ assert を足す)', () => {
    expect(r.boots).toBeLessThanOrEqual(budget);
  });

  /**
   * 🔴 **下限**(CLAUDE.md §1「tripwire は上限だけでなく下限も置く」)。
   * ⚠ 数え方が壊れて 0 になると、この門は**永遠に緑**になる。
   */
  it('🔴 数え方が生きている(0 件に落ちたら予算は何も守らない)', () => {
    expect(r.boots).toBeGreaterThanOrEqual(floor);
    expect(r.per.length).toBeGreaterThan(50);
    expect(r.per.every((p) => p.tests > 0)).toBe(true);
    // ⚠ 下限を 0 に下げると、下限そのものが空振りする ── 実数の近くに置く
    expect(floor).toBeGreaterThanOrEqual(r.boots / 2);
  });

  /**
   * 🔴 **予算が実数から離れすぎていない。** 上げ放題にすると、名前だけ残って
   * 何も止めなくなる ── 上げるときは**理由を 1 行**書いて、必要な分だけ上げる。
   */
  it('🔴 予算は実数の近くに在る(遠すぎる予算は門ではない)', () => {
    expect(budget - r.boots).toBeLessThanOrEqual(60);
    expect(budget).toBeGreaterThanOrEqual(r.boots);
  });
});

describe('起動の数え方', () => {
  it('共通 helper も、自分で書いた goto も、両方数える', () => {
    expect(one('await gotoApp(page);\nawait page.goto("/x");').boots).toBe(2);
  });

  /**
   * ⚠ **注釈は数えない** ── 「在る」ことを数える検査なので、コメントで
   * 水増しできると予算が偽の理由で落ちる(CLAUDE.md §1)。
   */
  it('注釈の中の起動は数えない', () => {
    expect(one('// await gotoApp(page);\n/* await page.goto("/") */\nconst x = 1;').boots).toBe(0);
  });

  it('test の数は行頭の test( を数える(describe の中の字下げも拾う)', () => {
    expect(one('test("a", () => {});\n  test("b", () => {});').tests).toBe(2);
  });
});
