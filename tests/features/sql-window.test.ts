/**
 * 🔴 **答えの表を「見えている分だけ」描く計算**(#918 段③)。
 *
 * ⚠ ここで守るのは 2 つ:
 *   ① **測れない回・少ない回は、全部描く**(窓にすると 1 行も出ない / 代償だけ払う)
 *   ② **上下に空ける高さの合計が、窓を外したときの高さと一致する**
 *      ── ずれると転がす棒の長さが嘘になり、下端で行が足りなくなる
 */
import { describe, expect, it } from 'vitest';
import {
  SQL_WINDOW_MIN,
  SQL_WINDOW_OVERSCAN,
  sqlWindowOf,
} from '../../src/features/query/sql-window';

const ROW_H = 20;
const VIEW_H = 400;

describe('答えの表の窓(#918 段③)', () => {
  /**
   * 🔴 **測れない回は全部描く。**
   * ⚠ happy-dom も、まだ画面に出ていない面も **0 を返す** ── ここで窓にすると
   *   `above`/`below` が 0 のまま `from === to` になり、**1 行も描けない**。
   */
  it('🔴 高さが測れない回は、全部描く(1 行も欠かさない)', () => {
    const many = SQL_WINDOW_MIN + 5000;
    for (const [rowH, viewH] of [
      [0, VIEW_H],
      [VIEW_H, 0],
      [0, 0],
      [-1, VIEW_H],
    ] as const) {
      const w = sqlWindowOf(many, rowH, 0, viewH);
      expect(w, `rowH=${String(rowH)} viewH=${String(viewH)} で窓に入れている`).toEqual({
        from: 0,
        to: many,
        above: 0,
        below: 0,
      });
    }
  });

  /**
   * 🔴 **`SQL_WINDOW_MIN` 以下は、いまと 1 ドットも同じ。**
   * ⚠ ここが窓に入ると、`Ctrl+F` と「全部を選んでコピー」と列幅の代償を
   *   **払う理由が無いのに払う**ことになる(CLAUDE.md §10)。
   */
  it('🔴 境目までは窓に入らない / 1 行超えると入る', () => {
    const at = sqlWindowOf(SQL_WINDOW_MIN, ROW_H, 99999, VIEW_H);
    expect(at, '境目ちょうどで窓に入れている').toEqual({
      from: 0,
      to: SQL_WINDOW_MIN,
      above: 0,
      below: 0,
    });
    // 🔑 空振り防止 ── 1 行足したら**必ず**窓に入る(入らなければ境目が効いていない)
    const over = sqlWindowOf(SQL_WINDOW_MIN + 1, ROW_H, 99999, VIEW_H);
    expect(over.to - over.from, '1 行超えても全部描いている').toBeLessThan(SQL_WINDOW_MIN + 1);
  });

  /**
   * 🔴 **上下に空ける高さの合計は、窓を外したときの高さと一致する。**
   * ⚠ ずれると転がす棒の長さが嘘になり、下端まで行っても行が足りない
   *   (あるいは空白が残る)。
   * ⚠ **端を 3 つとも見る**(上端 / 途中 / 下端)── 途中だけ見ると、
   *   `Math.min` / `Math.max` を外した変異が生き延びる。
   */
  it('🔴 どこへ転がしても、上 + 描いた分 + 下 = 全体の高さ', () => {
    const total = 100_000;
    const full = total * ROW_H;
    const spots = [0, 1, ROW_H - 1, 12_345, full / 2, full - VIEW_H, full * 2];
    for (const at of spots) {
      const w = sqlWindowOf(total, ROW_H, at, VIEW_H);
      const drawn = (w.to - w.from) * ROW_H;
      expect(w.above + drawn + w.below, `scrollTop=${String(at)} で高さが合わない`).toBe(full);
      expect(w.from, `scrollTop=${String(at)} で from が負`).toBeGreaterThanOrEqual(0);
      expect(w.to, `scrollTop=${String(at)} で to が行数を超えた`).toBeLessThanOrEqual(total);
    }
  });

  /**
   * ⚠ **見えている行は必ず窓の中に在る。**
   * 🔑 これが「窓が正しい」の本体である(高さが合っていても、
   *   描く範囲がずれていれば画面は白い)。
   */
  it('🔴 器に見えている行は、1 行残らず窓の中に在る', () => {
    const total = 50_000;
    for (const at of [0, 7_000, 40_000, (total - 1) * ROW_H]) {
      const w = sqlWindowOf(total, ROW_H, at, VIEW_H);
      const firstSeen = Math.floor(at / ROW_H);
      const lastSeen = Math.min(total - 1, Math.floor((at + VIEW_H) / ROW_H));
      expect(w.from, `scrollTop=${String(at)} で上が足りない`).toBeLessThanOrEqual(firstSeen);
      expect(w.to - 1, `scrollTop=${String(at)} で下が足りない`).toBeGreaterThanOrEqual(lastSeen);
    }
  });

  /**
   * ⚠ **余分に描く分(overscan)が実際に効いている。**
   * 🔑 0 だと転がした瞬間に白い帯が出るので、**0 でないこと**を test 自身に見させる
   *   (CLAUDE.md「N 通りに散らしたと書いたら、実際に N 出ることを assert させる」)。
   */
  it('⚠ 見えている外側にも描いている(白い帯を作らない)', () => {
    expect(SQL_WINDOW_OVERSCAN, '余分が 0 だと転がした瞬間に白い帯が出る').toBeGreaterThan(0);
    const w = sqlWindowOf(50_000, ROW_H, 10_000, VIEW_H);
    const firstSeen = Math.floor(10_000 / ROW_H);
    expect(firstSeen - w.from, '上に余分を描いていない').toBe(SQL_WINDOW_OVERSCAN);
  });

  /** ⚠ 上端では**上に余分を描けない** ── 負の行を描こうとしない。 */
  it('⚠ 上端では above が 0(負の行を描かない)', () => {
    const w = sqlWindowOf(50_000, ROW_H, 0, VIEW_H);
    expect(w.from).toBe(0);
    expect(w.above).toBe(0);
  });
});
