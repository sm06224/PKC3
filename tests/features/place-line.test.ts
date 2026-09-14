/**
 * 🔴 **板どうしを繋ぐ線の計算**(#530 段③a)。
 *
 * ⚠ ここで守るのは 2 つ:
 *   ① **いちばん近い辺から出て、いちばん近い辺へ入る**(板の上を横切らない)
 *   ② **同じ入力なら必ず同じ答え**(描くたびに違う辺から出ない)
 */
import { describe, expect, it } from 'vitest';
import {
  anchorPoint,
  PLACE_ANCHORS,
  placeLineOf,
  placeLineTargetId,
  type PlaceRect,
} from '../../src/features/markdown/place-line';

const box = (x: number, y: number, w = 100, h = 60): PlaceRect => ({ x, y, w, h });

describe('板どうしを繋ぐ線(#530 段③a)', () => {
  /**
   * 🔴 **横に並べたら「右 → 左」**。
   * ⚠ ここを外すと線が**板の上を横切る** ── 設計 doc §8.1 が
   *   「アンカーが無いときの実害」として名指しした形そのもの。
   */
  it('🔴 横に並ぶと 右 → 左 / 縦に並ぶと 下 → 上', () => {
    const right = placeLineOf(box(0, 0), box(300, 0));
    expect([right.from, right.to], '横に並んだのに横の辺から出ていない').toEqual([
      'right',
      'left',
    ]);
    // 🔑 座標も見る(辺の真ん中から出ている)
    expect([right.x1, right.y1], '出る所が右辺の真ん中でない').toEqual([100, 30]);
    expect([right.x2, right.y2], '入る所が左辺の真ん中でない').toEqual([300, 30]);

    const down = placeLineOf(box(0, 0), box(0, 300));
    expect([down.from, down.to], '縦に並んだのに縦の辺から出ていない').toEqual(['bottom', 'top']);

    // 🔑 逆向きも見る(左右・上下を取り違えていないこと)
    expect(placeLineOf(box(300, 0), box(0, 0)).from).toBe('left');
    expect(placeLineOf(box(0, 300), box(0, 0)).from).toBe('top');
  });

  /**
   * ⚠ **斜めに置いても、板を横切らない側から出る。**
   * 🔑 総当たり(4 × 4)が効いていることを、決め打ちでは出ない配置で見る。
   */
  it('⚠ 斜めでも、近いほうの辺どうしを結ぶ', () => {
    // 右下へ大きく離す ── 横の距離が縦より大きいので横の辺が近い
    const a = placeLineOf(box(0, 0), box(400, 80));
    expect([a.from, a.to]).toEqual(['right', 'left']);
    // 下へ大きく離す ── 縦の距離が勝つ
    const b = placeLineOf(box(0, 0), box(80, 400));
    expect([b.from, b.to]).toEqual(['bottom', 'top']);
  });

  /**
   * 🔴 **同じ入力なら必ず同じ答え**(描くたびに違う辺から出ない)。
   * ⚠ 重なった板は 16 通りのうち**同じ距離が何本も**出るので、
   *   tie-break が無いと答えがぶれる。
   */
  it('🔴 重なっていても答えがぶれない / 数が壊れない', () => {
    const same = box(10, 10);
    const first = placeLineOf(same, same);
    for (let i = 0; i < 5; i += 1) expect(placeLineOf(same, same)).toEqual(first);
    for (const v of [first.x1, first.y1, first.x2, first.y2]) {
      expect(Number.isFinite(v), '座標が数でない(NaN / Infinity)').toBe(true);
    }
    // ⚠ 大きさ 0 の板でも壊れない(w= に 0 と書ける)
    const zero = placeLineOf(box(0, 0, 0, 0), box(50, 50, 0, 0));
    for (const v of [zero.x1, zero.y1, zero.x2, zero.y2]) {
      expect(Number.isFinite(v), '大きさ 0 の板で座標が壊れた').toBe(true);
    }
  });

  /** 接続点の座標そのもの(4 つとも辺の真ん中)。 */
  it('⚠ 接続点は 4 つとも辺の真ん中に在る', () => {
    const r = box(10, 20, 100, 60);
    expect(anchorPoint(r, 'top')).toEqual({ x: 60, y: 20 });
    expect(anchorPoint(r, 'bottom')).toEqual({ x: 60, y: 80 });
    expect(anchorPoint(r, 'left')).toEqual({ x: 10, y: 50 });
    expect(anchorPoint(r, 'right')).toEqual({ x: 110, y: 50 });
    // 🔑 空振り防止 ── 一覧が空なら上の総当たりは 1 度も回らない
    expect(PLACE_ANCHORS.length, '接続点の一覧が空').toBe(4);
  });

  /**
   * 🔑 **`a:right` の綴りを受ける**(接続点は段③b まで効かないが、**捨てない**)。
   * ⚠ 受けないと「設計どおり書いたのに線が 1 本も出ない」になり、
   *   書いた人は**綴りを間違えたと読む**(いちばん気づけない外し方)。
   */
  it('🔑 from=a:right の「どの板か」だけを取り出す / 空は捨てる', () => {
    expect(placeLineTargetId('a')).toBe('a');
    expect(placeLineTargetId('a:right'), '接続点付きの綴りを捨てている').toBe('a');
    expect(placeLineTargetId(' a : left ')).toBe('a');
    expect(placeLineTargetId(''), '空の名前を板として扱っている').toBeNull();
    expect(placeLineTargetId(':right'), '名前の無い綴りを受けている').toBeNull();
    expect(placeLineTargetId(null)).toBeNull();
  });
});
