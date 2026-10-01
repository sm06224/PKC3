/**
 * 🔴 **掴んで繋ぐ(#530 段③d)の計算** ── どの辺か / ● ⊕ の位置 / 離した先の板。
 *
 * 守る主張:
 * 1. 乗せた点にいちばん近い辺が選ばれる(同じ距離は並び順 = 上・右・下・左)
 * 2. ● は辺の真ん中、⊕ はその両隣(1/4 と 3/4)。⊕ に乗せると、そこが ● になり、さらに細かい ⊕ が出る
 * 3. 記法が受けない細かさ(分母 64 超)の ⊕ は出さない(押せるのに書けない、を作らない)
 * 4. 離した点を含む板のうち、いちばん手前の 1 枚。無ければ null(= 書かない)
 */
import { describe, expect, it } from 'vitest';
import {
  connectHandles,
  nearestEdge,
  topPlaceAt,
  type PlaceDrop,
} from '../../src/features/markdown/place-handles';
import {
  ANCHOR_DEN_MAX,
  anchorOf,
  anchorSpell,
  parseAnchorSpell,
  type PlaceRect,
} from '../../src/features/markdown/place-line';

const R: PlaceRect = { x: 100, y: 50, w: 200, h: 100 };

describe('nearestEdge(乗せた辺)', () => {
  it('🔴 4 つの辺それぞれの近くで、その辺が返る(対照群 4 つ)', () => {
    expect(nearestEdge(R, 200, 52)).toBe('top');
    expect(nearestEdge(R, 298, 100)).toBe('right');
    expect(nearestEdge(R, 200, 148)).toBe('bottom');
    expect(nearestEdge(R, 102, 100)).toBe('left');
  });

  it('🔑 幅と高さが違う板では、辺までの距離で決める(中心を外れた点)', () => {
    // 200×100 の板の中心から右へ 30px:右まで 70 / 上下まで 50 → 上が近い
    expect(nearestEdge(R, 230, 100)).toBe('top');
    // 右へ 60px:右まで 40 / 上下まで 50 → 右が近い
    expect(nearestEdge(R, 260, 100)).toBe('right');
  });

  it('⚠ 同じ距離なら上・右・下・左の順(描き直すたびに辺が変わらない)', () => {
    // 正方形の中心 ── 4 辺とも同じ距離
    expect(nearestEdge({ x: 0, y: 0, w: 100, h: 100 }, 50, 50)).toBe('top');
    // 右下の角から等距離 ── 右が先(下より前)
    expect(nearestEdge({ x: 0, y: 0, w: 100, h: 100 }, 90, 90)).toBe('right');
  });
});

describe('connectHandles(● と ⊕)', () => {
  it('🔴 既定は ● が辺の真ん中、⊕ がその両隣(1/4 と 3/4)', () => {
    const h = connectHandles('right');
    expect(anchorSpell(h.dot)).toBe('right');
    expect(h.plus.map(anchorSpell)).toEqual(['right@1/4', 'right@3/4']);
  });

  it('🔴 ⊕ に乗せると、そこが ● になり、その両隣に新しい ⊕ が出る(さらに細かく)', () => {
    const a = parseAnchorSpell('top@1/4')!;
    const h = connectHandles('top', a);
    expect(anchorSpell(h.dot)).toBe('top@1/4');
    expect(h.plus.map(anchorSpell)).toEqual(['top@1/8', 'top@3/8']);
    // さらに 1 段
    const h2 = connectHandles('top', parseAnchorSpell('top@3/8')!);
    expect(anchorSpell(h2.dot)).toBe('top@3/8');
    expect(h2.plus.map(anchorSpell)).toEqual(['top@5/16', 'top@7/16']);
  });

  it('🔑 右半分も同じ規則(3/4 の両隣は 5/8 と 7/8)', () => {
    const h = connectHandles('bottom', parseAnchorSpell('bottom@3/4')!);
    expect(h.plus.map(anchorSpell)).toEqual(['bottom@5/8', 'bottom@7/8']);
  });

  it('⚠ 分母が 64 を超える ⊕ は出さない(記法が受けない点を見せない)', () => {
    // ● が 1/32 なら ⊕ は 1/64 と 3/64(分母 64 ── ちょうど受けられる)
    const fine = connectHandles('left', anchorOf('left', 1, 32));
    expect(fine.plus.map(anchorSpell)).toEqual(['left@1/64', 'left@3/64']);
    // ● が 1/64 なら ⊕ は分母 128 になる ── 出さない
    const edge = connectHandles('left', anchorOf('left', 1, ANCHOR_DEN_MAX));
    expect(edge.plus).toEqual([]);
    expect(anchorSpell(edge.dot)).toBe('left@1/64');
  });

  it('🔴 出す ⊕ は全部、記法が読める綴りである(出した点を押せば必ず書ける)', () => {
    let a = connectHandles('top');
    let seen = 0;
    for (let depth = 0; depth < 8 && a.plus.length > 0; depth += 1) {
      for (const p of a.plus) {
        expect(parseAnchorSpell(anchorSpell(p)), anchorSpell(p)).not.toBeNull();
        seen += 1;
      }
      a = connectHandles('top', a.plus[0]);
    }
    // ⚠ 空振り防止 ── 6 段(1/2 → … → 1/64)ぶんを実際に通った
    expect(seen).toBeGreaterThanOrEqual(10);
  });

  it('⚠ 別の辺の点 / 分母が 2 の冪でない点を渡されたら、真ん中へ倒す(必ず 1 組を返す)', () => {
    expect(anchorSpell(connectHandles('right', anchorOf('top', 1, 4)).dot)).toBe('right');
    expect(anchorSpell(connectHandles('right', anchorOf('right', 1, 3)).dot)).toBe('right');
  });
});

describe('topPlaceAt(離した先)', () => {
  const at = (id: string, x: number, y: number, z = 0): PlaceDrop<string> => ({
    item: id,
    rect: { x, y, w: 100, h: 60 },
    z,
  });

  it('🔴 点を含む板が返る。どの板にも含まれない点は null(板の外で離した = 書かない)', () => {
    const cands = [at('a', 0, 0), at('b', 300, 0)];
    expect(topPlaceAt(cands, 320, 30)?.item).toBe('b');
    expect(topPlaceAt(cands, 150, 30)).toBeNull();
  });

  it('🔑 重なっていれば z の大きいほう。同じ z なら後ろに書いた板', () => {
    expect(topPlaceAt([at('a', 0, 0, 5), at('b', 50, 0, 1)], 60, 30)?.item).toBe('a');
    expect(topPlaceAt([at('a', 0, 0), at('b', 50, 0)], 60, 30)?.item).toBe('b');
  });

  it('⚠ 辺の上(境界)も板の内として数える(辺に落とすのが本来の使い方)', () => {
    expect(topPlaceAt([at('a', 0, 0)], 100, 30)?.item).toBe('a');
    expect(topPlaceAt([at('a', 0, 0)], 101, 30)).toBeNull();
  });
});
