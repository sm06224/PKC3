/**
 * 🔴 **最近開いたノートの記録**(#215 残り①)── 規則そのもの。
 *
 * ⚠ 置き場(localStorage)と配線(state へ載せる)は別の test が見る ──
 *   ここは**純関数だけ**で、混ぜると「保存が壊れたのか規則が壊れたのか」が読めなくなる。
 */
import { describe, expect, it } from 'vitest';
import {
  OPENED_MAX,
  openedMap,
  pruneOpened,
  pushOpened,
  type OpenedAt,
} from '../../src/features/history/opened-log';

describe('最近開いた記録(#215 残り①)', () => {
  it('新しい順に積む', () => {
    const a = pushOpened([], 'n1', 100);
    const b = pushOpened(a, 'n2', 200);
    expect(b.map((o) => o.lid)).toEqual(['n2', 'n1']);
  });

  /**
   * 🔴 **同じノートを 2 行にしない**。⚠ 2 行になると `openedMap` が
   *   どちらを採るかで答えが変わる = 並びが実行のたびに揺れる。
   */
  it('🔴 同じノートを開き直すと、行は増えず先頭へ動く', () => {
    let list: readonly OpenedAt[] = pushOpened([], 'n1', 100);
    list = pushOpened(list, 'n2', 200);
    list = pushOpened(list, 'n1', 300);
    expect(list.map((o) => o.lid), '行が増えた(同じノートが 2 行)').toEqual(['n1', 'n2']);
    expect(openedMap(list).get('n1'), '時刻が新しくなっていない').toBe(300);
  });

  it('元の配列を壊さない(state の参照でもありうる)', () => {
    const first = pushOpened([], 'n1', 1);
    const second = pushOpened(first, 'n2', 2);
    expect(first.map((o) => o.lid), '呼び側の配列が書き換わった').toEqual(['n1']);
    expect(second).toHaveLength(2);
  });

  it('上限で古いものから落ちる', () => {
    let list: readonly OpenedAt[] = [];
    for (let i = 0; i < OPENED_MAX + 5; i++) list = pushOpened(list, `n${i}`, i);
    expect(list).toHaveLength(OPENED_MAX);
    expect(list[0]!.lid, '新しいほうが落ちている').toBe(`n${OPENED_MAX + 4}`);
    expect(list.some((o) => o.lid === 'n0'), '古いのが残っている').toBe(false);
  });

  /**
   * 🔴 **記録が墓場にならない** ── 消した lid を持ち続けると、いつか上限が
   *   「もう無いノート」で埋まり、並べ替えても何も上がってこなくなる。
   */
  it('🔴 消えたノートの行は落とせる(対照群: 生きている行は残る)', () => {
    const list = [
      { lid: 'alive', at: 2 },
      { lid: 'gone', at: 1 },
    ];
    expect(pruneOpened(list, (lid) => lid === 'alive').map((o) => o.lid)).toEqual(['alive']);
  });

  it('空の lid は積まない(作りかけの行を憶えない)', () => {
    expect(pushOpened([], '', 1)).toEqual([]);
  });
});
