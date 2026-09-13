/**
 * 🔴 **グループ自体の並べ替え**(#857 段③)── 意味論の側。
 *
 * 🔴 守る主張:
 * 1. 並ぶ規則は「**番号のある群が先(番号順)、無い群は名前順で後ろ**」
 * 2. 🔴 **部分的に番号は付けられない** ── 動かした先より上の群にも番号が要る
 * 3. ⚠ **変わらない群は書かない**(無駄な書込を出さない)
 * 4. 端では動かない(押せて何も起きない、を呼び側が作れるようにする)
 */
import { describe, expect, it } from 'vitest';
import { sortGroupNames, type AppGroupOrders } from '../../src/features/launcher/app-group-spec';
import { groupsNeedingNote, planGroupMove } from '../../src/features/launcher/group-order';

/** 計画を当てた後の並び(呼び側がやることを test 側で再現する)。 */
const after = (
  names: readonly string[],
  orders: AppGroupOrders,
  name: string,
  by: -1 | 1,
): readonly string[] => {
  const next: Record<string, number> = { ...orders };
  for (const w of planGroupMove(names, orders, name, by)) next[w.name] = w.order;
  return sortGroupNames(names, next);
};

describe('群の並べ方(#857 段③)', () => {
  it('番号が無ければ名前順', () => {
    expect(sortGroupNames(['資料', '道具', '仕事'], {})).toEqual(['仕事', '資料', '道具']);
  });

  it('🔴 番号のある群が先、無い群は名前順で後ろ', () => {
    expect(sortGroupNames(['資料', '道具', '仕事'], { 道具: 0 })).toEqual([
      '道具',
      '仕事',
      '資料',
    ]);
  });

  it('⚠ 名前の無い群は必ず先頭(番号を持てない)', () => {
    expect(sortGroupNames(['資料', ''], { 資料: 0 })).toEqual(['', '資料']);
  });
});

describe('1 つ動かす(#857 段③)', () => {
  const names = ['仕事', '資料', '道具']; // 名前順 = いまの見た目

  it('🔴 いちばん下を 1 つ上へ ── 見た目が 1 つだけ入れ替わる', () => {
    expect(after(names, {}, '道具', -1)).toEqual(['仕事', '道具', '資料']);
  });

  it('🔴 上から 2 番目を上へ ── 書くのは 2 群だけ', () => {
    const w = planGroupMove(names, {}, '資料', -1);
    expect(w.map((x) => x.name), '「動かした先より上」より多く書いている').toEqual([
      '資料',
      '仕事',
    ]);
    expect(after(names, {}, '資料', -1)).toEqual(['資料', '仕事', '道具']);
  });

  it('🔴 下へも同じ(片道の操作にしない)', () => {
    expect(after(names, {}, '仕事', 1)).toEqual(['資料', '仕事', '道具']);
  });

  it('⚠ 端では動かさない(呼び側が「押せて何も起きない」を作れるように)', () => {
    expect(planGroupMove(names, {}, '仕事', -1), '先頭をさらに上へ動かした').toEqual([]);
    expect(planGroupMove(names, {}, '道具', 1), '末尾をさらに下へ動かした').toEqual([]);
    expect(planGroupMove(names, {}, '居ない群', -1), '居ない群を動かした').toEqual([]);
  });

  it('⚠ 2 回目以降は 2 群だけ書く(もう番号が付いている)', () => {
    const orders: AppGroupOrders = { 仕事: 0, 資料: 1, 道具: 2 };
    const w = planGroupMove(names, orders, '道具', -1);
    expect(w.map((x) => x.name).sort(), '番号が付いているのに全部書き直している').toEqual([
      '資料',
      '道具',
    ]);
    expect(after(names, orders, '道具', -1)).toEqual(['仕事', '道具', '資料']);
  });

  /**
   * 🔴 **下に番号付きが居るなら、そこまで書く。**
   * ⚠ 番号付きは必ず先に来るので、間に挟まれた無番号の群が**飛び越される**。
   */
  it('🔴 下に番号付きが居る形でも、見た目が壊れない', () => {
    const ns = ['あ', 'い', 'う', 'え'];
    const orders: AppGroupOrders = { え: 0 }; // 見た目は え / あ / い / う
    expect(sortGroupNames(ns, orders), '前提が崩れている').toEqual(['え', 'あ', 'い', 'う']);
    expect(after(ns, orders, 'う', -1), '無番号の群が飛び越された').toEqual([
      'え',
      'あ',
      'う',
      'い',
    ]);
  });
});

describe('何枚のノートが要るか(#857 段③)', () => {
  it('🔴 まだノートが無い群のぶんだけ数える', () => {
    const w = planGroupMove(['あ', 'い', 'う'], {}, 'う', -1);
    expect(groupsNeedingNote(w, (n) => n === 'あ').length, '既に在るノートまで数えている').toBe(
      w.length - 1,
    );
  });

  it('⚠ 全部に在れば 0 枚(2 回目以降は聞かない)', () => {
    const w = planGroupMove(['あ', 'い', 'う'], { あ: 0, い: 1, う: 2 }, 'う', -1);
    expect(groupsNeedingNote(w, () => true)).toEqual([]);
  });
});
