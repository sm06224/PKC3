import { describe, expect, it } from 'vitest';
import {
  MAX_CLOSED,
  MAX_TABS,
  activate,
  close,
  createTabSet,
  enforceLimit,
  markExternal,
  move,
  next,
  onDeleted,
  openNew,
  openReplace,
  orderTabs,
  prev,
  reopenLast,
  visible,
  type TabSet,
} from '../../../src/features/nav/note-tabs';

const lids = (s: TabSet) => s.tabs.map((t) => t.lid);

/** a,b,c を開き、有効は最後に開いたもの。 */
function build(...ids: string[]): TabSet {
  let s = createTabSet();
  ids.forEach((id, i) => {
    s = openNew(s, id, i + 1);
  });
  return s;
}

const none = () => false;

describe('createTabSet / visible', () => {
  it('空から始まり、2 枚未満では出さない', () => {
    const s = createTabSet();
    expect(s).toEqual({ tabs: [], active: null, closed: [] });
    expect(visible(s)).toBe(false);
    expect(visible(build('a'))).toBe(false);
    expect(visible(build('a', 'b'))).toBe(true);
  });
});

describe('openReplace', () => {
  it('タブがなければ作る', () => {
    const s = openReplace(createTabSet(), 'a', 1);
    expect(lids(s)).toEqual(['a']);
    expect(s.active).toBe('a');
  });
  it('有効なタブの中身を同じ位置で差し替える', () => {
    let s = build('a', 'b', 'c');
    s = activate(s, 'b', 10);
    s = openReplace(s, 'x', 11);
    expect(lids(s)).toEqual(['a', 'x', 'c']);
    expect(s.active).toBe('x');
    expect(s.tabs[1].activatedAt).toBe(11);
  });
  it('差し替えで消えた lid は最近閉じたタブに入らない', () => {
    const s = openReplace(build('a', 'b'), 'x', 5);
    expect(s.closed).toEqual([]);
  });
  it('差し替えで external 印は引き継がない', () => {
    let s = build('a', 'b');
    s = markExternal(s, 'b', true);
    s = openReplace(s, 'x', 5);
    expect(s.tabs[1].external).toBe(false);
  });
  it('既に別タブにある lid は有効にするだけで重複しない', () => {
    const s = openReplace(build('a', 'b', 'c'), 'a', 9);
    expect(lids(s)).toEqual(['a', 'b', 'c']);
    expect(s.active).toBe('a');
    expect(s.tabs[0].activatedAt).toBe(9);
  });
  it('active が null でタブが残っていても新しく作る', () => {
    const s = openReplace({ ...build('a'), active: null }, 'x', 5);
    expect(lids(s)).toEqual(['a', 'x']);
    expect(s.active).toBe('x');
  });
  it('最近閉じたタブにある lid を開くとそこから除く', () => {
    let s = close(build('a', 'b'), 'a', 5);
    s = openReplace(s, 'a', 6);
    expect(s.closed).toEqual([]);
  });
});

describe('openNew', () => {
  it('末尾に追加して有効にする', () => {
    const s = openNew(build('a'), 'b', 5);
    expect(lids(s)).toEqual(['a', 'b']);
    expect(s.active).toBe('b');
  });
  it('activate:false は有効を動かさない（空のときだけ有効になる）', () => {
    const s = openNew(build('a'), 'b', 5, { activate: false });
    expect(lids(s)).toEqual(['a', 'b']);
    expect(s.active).toBe('a');
    expect(openNew(createTabSet(), 'z', 1, { activate: false }).active).toBe('z');
  });
  it('重複 lid は追加せず、activate 指定なら有効にして時刻を更新', () => {
    const s = openNew(build('a', 'b'), 'a', 7);
    expect(lids(s)).toEqual(['a', 'b']);
    expect(s.active).toBe('a');
    expect(s.tabs[0].activatedAt).toBe(7);
  });
  it('重複 lid で activate:false なら何も変わらない（同じ参照）', () => {
    const base = build('a', 'b');
    expect(openNew(base, 'a', 7, { activate: false })).toBe(base);
  });
});

describe('activate', () => {
  it('開いていない lid は同じ参照を返す', () => {
    const base = build('a');
    expect(activate(base, 'zz', 5)).toBe(base);
  });
  it('有効にして activatedAt を更新する', () => {
    const s = activate(build('a', 'b'), 'a', 9);
    expect(s.active).toBe('a');
    expect(s.tabs[0].activatedAt).toBe(9);
    expect(s.tabs[1].activatedAt).toBe(2);
  });
});

describe('close', () => {
  it('有効なタブを閉じると右隣が有効になる', () => {
    let s = build('a', 'b', 'c');
    s = activate(s, 'b', 9);
    s = close(s, 'b', 10);
    expect(lids(s)).toEqual(['a', 'c']);
    expect(s.active).toBe('c');
  });
  it('右隣がなければ左隣', () => {
    const s = close(build('a', 'b', 'c'), 'c', 10);
    expect(s.active).toBe('b');
  });
  it('有効でないタブを閉じても有効は変わらない', () => {
    const s = close(build('a', 'b', 'c'), 'a', 10);
    expect(s.active).toBe('c');
  });
  it('最後の 1 枚を閉じると空になり、active は null、closed に入る', () => {
    const s = close(build('a'), 'a', 10);
    expect(s.tabs).toEqual([]);
    expect(s.active).toBeNull();
    expect(s.closed).toEqual([{ lid: 'a', closedAt: 10 }]);
  });
  it('開いていない lid は同じ参照', () => {
    const base = build('a');
    expect(close(base, 'q', 3)).toBe(base);
  });
  it('closed は新しい順で、同じ lid は 1 件に畳む', () => {
    let s = build('a', 'b', 'c');
    s = close(s, 'a', 10);
    s = close(s, 'b', 11);
    expect(s.closed.map((c) => c.lid)).toEqual(['b', 'a']);
    s = openNew(s, 'a', 12);
    s = close(s, 'a', 13);
    expect(s.closed.map((c) => c.lid)).toEqual(['a', 'b']);
    expect(s.closed[0].closedAt).toBe(13);
  });
  it(`closed は ${MAX_CLOSED} 件で打ち切り古い方を捨てる`, () => {
    let s = createTabSet();
    for (let i = 0; i < MAX_CLOSED + 3; i++) {
      s = openNew(s, `n${i}`, i);
      s = close(s, `n${i}`, 100 + i);
    }
    expect(s.closed).toHaveLength(MAX_CLOSED);
    expect(s.closed[0].lid).toBe(`n${MAX_CLOSED + 2}`);
    expect(s.closed.some((c) => c.lid === 'n0')).toBe(false);
  });
  it('次の有効タブはピン留めを先頭にした表示順で選ぶ', () => {
    // 並び a,b,c。c をピン → 表示順 c,a,b。a を有効にして閉じると右隣は b。
    let s = build('a', 'b', 'c');
    s = activate(s, 'a', 9);
    expect(close(s, 'a', 10, new Set(['c'])).active).toBe('b');
    // 保持順なら右隣は b、表示順で c の右の a を閉じるケースと区別: b を有効にして閉じる
    s = activate(s, 'b', 11);
    expect(close(s, 'b', 12, new Set(['c'])).active).toBe('a');
  });
});

describe('reopenLast', () => {
  it('最後に閉じたものを新しいタブとして有効にして戻す', () => {
    let s = build('a', 'b', 'c');
    s = close(s, 'a', 10);
    s = close(s, 'b', 11);
    const r = reopenLast(s, 12, () => true);
    expect(r?.lid).toBe('b');
    expect(lids(r!.set)).toEqual(['c', 'b']);
    expect(r!.set.active).toBe('b');
    expect(r!.set.closed.map((c) => c.lid)).toEqual(['a']);
  });
  it('閉じたものがなければ null', () => {
    expect(reopenLast(build('a'), 5, () => true)).toBeNull();
  });
  it('存在しなくなったノートは読み飛ばし、すべてなければ null', () => {
    let s = build('a', 'b', 'c');
    s = close(s, 'a', 10);
    s = close(s, 'b', 11);
    const r = reopenLast(s, 12, (l) => l === 'a');
    expect(r?.lid).toBe('a');
    expect(r!.set.closed).toEqual([]);
    expect(reopenLast(s, 12, none)).toBeNull();
  });
  it('全部閉じた後でも戻せる', () => {
    const s = close(build('a'), 'a', 5);
    const r = reopenLast(s, 6, () => true);
    expect(lids(r!.set)).toEqual(['a']);
    expect(r!.set.active).toBe('a');
  });
});

describe('next / prev', () => {
  it('末尾の次は先頭、先頭の前は末尾（巻き戻し）', () => {
    const s = build('a', 'b', 'c'); // active c
    expect(next(s, 9).active).toBe('a');
    expect(prev(activate(s, 'a', 9), 10).active).toBe('c');
  });
  it('通常の前後移動と activatedAt 更新', () => {
    const s = activate(build('a', 'b', 'c'), 'b', 5);
    const n = next(s, 20);
    expect(n.active).toBe('c');
    expect(n.tabs[2].activatedAt).toBe(20);
    expect(prev(s, 21).active).toBe('a');
  });
  it('1 枚以下は同じ参照', () => {
    const one = build('a');
    expect(next(one, 5)).toBe(one);
    expect(prev(one, 5)).toBe(one);
    const empty = createTabSet();
    expect(next(empty, 5)).toBe(empty);
  });
  it('ピン留めを先頭にした表示順で巡る', () => {
    // 保持順 a,b,c / 表示順 c,a,b
    const pinned = new Set(['c']);
    const s = activate(build('a', 'b', 'c'), 'c', 5);
    expect(next(s, 6, pinned).active).toBe('a');
    expect(prev(s, 6, pinned).active).toBe('b');
  });
  it('active が null なら next は先頭、prev は末尾', () => {
    const s = { ...build('a', 'b', 'c'), active: null };
    expect(next(s, 5).active).toBe('a');
    expect(prev(s, 5).active).toBe('c');
  });
});

describe('move', () => {
  it('添字で並べ替える', () => {
    expect(lids(move(build('a', 'b', 'c'), 0, 2))).toEqual(['b', 'c', 'a']);
    expect(lids(move(build('a', 'b', 'c'), 2, 0))).toEqual(['c', 'a', 'b']);
  });
  it('範囲外・同位置・非整数は同じ参照', () => {
    const s = build('a', 'b');
    expect(move(s, 0, 0)).toBe(s);
    expect(move(s, -1, 1)).toBe(s);
    expect(move(s, 0, 2)).toBe(s);
    expect(move(s, 0.5, 1)).toBe(s);
  });
  it('有効なタブ・closed は変えない', () => {
    const s = move(build('a', 'b', 'c'), 0, 2);
    expect(s.active).toBe('c');
  });
});

describe('orderTabs', () => {
  it('ピン留めを先頭へ。各グループ内は元の並びのまま（安定）', () => {
    const s = build('a', 'b', 'c', 'd', 'e');
    const o = orderTabs(s.tabs, new Set(['e', 'b']));
    expect(o.map((t) => t.lid)).toEqual(['b', 'e', 'a', 'c', 'd']);
  });
  it('ピンがなければ同じ配列を返す', () => {
    const s = build('a', 'b');
    expect(orderTabs(s.tabs)).toBe(s.tabs);
    expect(orderTabs(s.tabs, new Set(['zz']))).toBe(s.tabs);
  });
  it('2 回適用しても結果は同じ（べき等）', () => {
    const s = build('a', 'b', 'c');
    const pinned = new Set(['c']);
    const once = orderTabs(s.tabs, pinned);
    expect(orderTabs(once, pinned)).toEqual(once);
  });
});

describe('enforceLimit', () => {
  const opts = (pinned: string[] = [], editing: string[] = [], max?: number) => ({
    max,
    isPinned: (l: string) => pinned.includes(l),
    isEditing: (l: string) => editing.includes(l),
  });
  const many = (n: number) => build(...Array.from({ length: n }, (_, i) => `n${i}`));

  it('既定の上限は 12 で、以下なら何もしない（同じ参照）', () => {
    expect(MAX_TABS).toBe(12);
    const s = many(12);
    const r = enforceLimit(s, 99, opts());
    expect(r.set).toBe(s);
    expect(r.evicted).toEqual([]);
    expect(r.overflow).toBe(false);
  });
  it('13 枚目で最も古い（activatedAt 最小）を閉じて closed に入れる', () => {
    let s = many(13);
    s = activate(s, 'n0', 50); // n0 は新しくなり、最古は n1
    s = activate(s, 'n12', 51);
    const r = enforceLimit(s, 60, opts());
    expect(r.evicted).toEqual(['n1']);
    expect(r.set.tabs).toHaveLength(12);
    expect(r.set.closed).toEqual([{ lid: 'n1', closedAt: 60 }]);
    expect(r.overflow).toBe(false);
  });
  it('ピン留め・編集中は追い出さない', () => {
    const s = activate(many(13), 'n12', 50);
    const r = enforceLimit(s, 60, opts(['n0'], ['n1']));
    expect(r.evicted).toEqual(['n2']);
  });
  it('有効なタブは最古でも追い出さない', () => {
    const s = activate(many(13), 'n0', 0); // 有効 n0、activatedAt 0 で最古
    const r = enforceLimit(s, 60, opts());
    expect(r.evicted).toEqual(['n1']);
    expect(lids(r.set)).toContain('n0');
  });
  it('activatedAt が同値なら並びの前を追い出す', () => {
    let s = createTabSet();
    for (const id of ['a', 'b', 'c']) s = openNew(s, id, 1);
    const r = enforceLimit(s, 5, opts([], [], 2));
    expect(r.evicted).toEqual(['a']);
  });
  it('複数枚超過なら古い順に必要な数だけ追い出す', () => {
    const s = activate(many(15), 'n14', 99);
    const r = enforceLimit(s, 60, opts());
    expect(r.evicted).toEqual(['n0', 'n1', 'n2']);
    expect(r.set.tabs).toHaveLength(12);
  });
  it('全部が守られているなら超過を許して overflow を返す', () => {
    const s = many(13);
    const all = s.tabs.map((t) => t.lid);
    const r = enforceLimit(s, 60, opts(all.slice(0, 6), all.slice(6)));
    expect(r.set).toBe(s);
    expect(r.set.tabs).toHaveLength(13);
    expect(r.evicted).toEqual([]);
    expect(r.overflow).toBe(true);
  });
  it('一部だけ追い出して、なお超過なら overflow', () => {
    const s = many(14);
    const all = s.tabs.map((t) => t.lid);
    // 有効 n13 + ピン 12 件 = 守る 13 件、追い出せるのは n12 のみ
    const r = enforceLimit(s, 60, opts(all.slice(0, 12)));
    expect(r.evicted).toEqual(['n12']);
    expect(r.set.tabs).toHaveLength(13);
    expect(r.overflow).toBe(true);
  });
  it('max を指定できる', () => {
    const r = enforceLimit(many(4), 9, opts([], [], 2));
    expect(r.set.tabs).toHaveLength(2);
  });
});

describe('onDeleted', () => {
  it('削除されたノートのタブを除き、closed には入れない', () => {
    const s = onDeleted(build('a', 'b', 'c'), ['a']);
    expect(lids(s)).toEqual(['b', 'c']);
    expect(s.closed).toEqual([]);
  });
  it('有効なタブが削除されたら右隣、なければ左隣が有効になる', () => {
    let s = activate(build('a', 'b', 'c'), 'b', 9);
    expect(onDeleted(s, ['b']).active).toBe('c');
    s = activate(s, 'c', 10);
    expect(onDeleted(s, ['c']).active).toBe('b');
  });
  it('隣も一緒に削除されるときは削除されないタブへ進む', () => {
    const s = activate(build('a', 'b', 'c', 'd'), 'b', 9);
    expect(onDeleted(s, ['b', 'c']).active).toBe('d');
    expect(onDeleted(activate(s, 'd', 10), ['c', 'd']).active).toBe('b');
  });
  it('全部消えたら active は null', () => {
    const s = onDeleted(build('a', 'b'), ['a', 'b']);
    expect(s.tabs).toEqual([]);
    expect(s.active).toBeNull();
  });
  it('既に最近閉じたタブにあるものも消す（復元できない）', () => {
    const s = onDeleted(close(build('a', 'b'), 'a', 5), ['a']);
    expect(s.closed).toEqual([]);
  });
  it('無関係な lid / 空は同じ参照', () => {
    const base = build('a', 'b');
    expect(onDeleted(base, ['zz'])).toBe(base);
    expect(onDeleted(base, [])).toBe(base);
  });
  it('Set など反復可能を受ける', () => {
    expect(lids(onDeleted(build('a', 'b'), new Set(['a'])))).toEqual(['b']);
  });
  it('有効なタブが削除されないときは有効を変えない', () => {
    expect(onDeleted(build('a', 'b', 'c'), ['a']).active).toBe('c');
  });
  it('ピン留めの表示順で隣を選ぶ', () => {
    // 保持順 a,b,c / ピン c → 表示順 c,a,b。a を有効にして削除すると右隣は b。
    const s = activate(build('a', 'b', 'c'), 'a', 9);
    expect(onDeleted(s, ['a'], new Set(['c'])).active).toBe('b');
  });
});

describe('markExternal', () => {
  it('印を付けて外せる', () => {
    let s = markExternal(build('a', 'b'), 'a', true);
    expect(s.tabs[0].external).toBe(true);
    expect(s.tabs[1].external).toBe(false);
    s = markExternal(s, 'a', false);
    expect(s.tabs[0].external).toBe(false);
  });
  it('開いていない lid・変化なしは同じ参照', () => {
    const base = build('a');
    expect(markExternal(base, 'zz', true)).toBe(base);
    expect(markExternal(base, 'a', false)).toBe(base);
  });
  it('他の操作で印は保たれる（有効化・移動）', () => {
    let s = markExternal(build('a', 'b'), 'a', true);
    s = activate(s, 'a', 9);
    s = move(s, 0, 1);
    expect(s.tabs.find((t) => t.lid === 'a')!.external).toBe(true);
  });
});

describe('不変性', () => {
  it('入力の TabSet を書き換えない', () => {
    const base = build('a', 'b', 'c');
    const snap = JSON.stringify(base);
    activate(base, 'a', 9);
    openReplace(base, 'x', 9);
    openNew(base, 'y', 9);
    close(base, 'b', 9);
    next(base, 9);
    move(base, 0, 2);
    onDeleted(base, ['a']);
    markExternal(base, 'a', true);
    enforceLimit(base, 9, { max: 1, isPinned: none, isEditing: none });
    expect(JSON.stringify(base)).toBe(snap);
  });
});
