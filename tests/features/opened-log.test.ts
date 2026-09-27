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
  recentNavLids,
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

describe('最近開いたノートの一覧規則(#1107)', () => {
  it('openedAt の新しい順を優先し、現在地を除外して返す', () => {
    const openedAt = new Map([
      ['n3', 300],
      ['n2', 200],
      ['n1', 100],
    ]);
    const res = recentNavLids(openedAt, [], [], 'n3', () => true);
    expect(res).toEqual(['n2', 'n1']);
  });

  it('excludeCurrent: false の場合は現在地も含める', () => {
    const openedAt = new Map([
      ['n3', 300],
      ['n2', 200],
    ]);
    const res = recentNavLids(openedAt, [], [], 'n3', () => true, { excludeCurrent: false });
    expect(res).toEqual(['n3', 'n2']);
  });

  it('openedAt に無いノートは selectionPast と future から補完する', () => {
    const openedAt = new Map([['n3', 300]]);
    const past = ['n0', 'n1', 'n2'];
    const future = ['n4'];
    const res = recentNavLids(openedAt, past, future, 'n3', () => true);
    // n3 は current なので除外。openedAt からは空。
    // past は末尾から順に n2, n1, n0。future は n4。
    expect(res).toEqual(['n2', 'n1', 'n0', 'n4']);
  });

  it('消えたノート(alive が false)や重複は取り除く', () => {
    const openedAt = new Map([
      ['n3', 300],
      ['dead', 250],
      ['n2', 200],
    ]);
    const past = ['n2', 'dead2', 'n1'];
    const alive = (lid: string) => !lid.startsWith('dead');
    const res = recentNavLids(openedAt, past, [], 'n3', alive);
    expect(res).toEqual(['n2', 'n1']);
  });

  it('limit で件数を制限できる', () => {
    const openedAt = new Map([
      ['n5', 500],
      ['n4', 400],
      ['n3', 300],
      ['n2', 200],
      ['n1', 100],
    ]);
    const res = recentNavLids(openedAt, [], [], null, () => true, { limit: 3 });
    expect(res).toEqual(['n5', 'n4', 'n3']);
  });
});

