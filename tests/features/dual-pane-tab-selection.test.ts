/** @vitest-environment node */
/**
 * 2 ペインのタブごとの選び(台帳 #1852 束 N1 / 依頼 97-1 B。Gemini 回答 = 推薦どおり)。
 *
 * 直す前: 同じペインで行を 3 件選んでタブを切り替え、元のタブに戻ると、選びが全部外れていた
 *   (マニュアルは「選んでいたものも、そのタブのものに戻ります」と書いていた)。開いていない別のタブを閉じたときも、いまの選びが外れた。
 *
 * 守る主張:
 *  1. タブを切り替えて戻ると、選び・起点・カーソルが戻る
 *  2. 開いていないタブを閉じても、いまの選びは外れない
 *  3. 開いているタブを閉じたら、次に開くタブの選びへ替わる
 *  4. 消えた lid は、裏のタブが憶えている選びからも落ちる(戻ったときに実在しない物を数えない)
 *  5. 選びを持たないタブの形は変わらない(欄を足さない)
 */
import { describe, expect, it } from 'vitest';
import {
  initialDual,
  pruneDual,
  withScope,
  withSelection,
  withTabActive,
  withTabAdded,
  withTabClosed,
  type DualPaneState,
} from '../../src/features/relation/dual-pane';

/** 3 枚のタブ: 0 = ルート(a, b を選んでいる)/ 1 = f1 / 2 = f2。いま開いているのは 0。 */
function threeTabs(): DualPaneState {
  let p = withTabAdded(withTabAdded(initialDual.left));
  p = withTabActive(p, 1);
  p = withScope(p, 'f1');
  p = withTabActive(p, 2);
  p = withScope(p, 'f2');
  p = withTabActive(p, 0);
  return withSelection(p, ['a', 'b'], 'b', 'b');
}

describe('1. タブを切り替えて戻ると、選びが戻る', () => {
  it('🔴 選び・起点・カーソルが、そのタブのものとして戻る。切り替え先には持ち込まない', () => {
    const p0 = threeTabs();
    const away = withTabActive(p0, 1);
    expect(away.selection, '別のタブへ選びを持ち込んだ').toEqual([]);
    expect(away.anchor).toBeNull();
    expect(away.cursor).toBeNull();
    const back = withTabActive(away, 0);
    expect(back.selection, '戻ったのに選びが外れたまま').toEqual(['a', 'b']);
    expect(back.anchor).toBe('b');
    expect(back.cursor).toBe('b');
  });

  it('🔴 タブごとに別の選びを持てる(行って、選んで、戻る ── それぞれの選びが戻る)', () => {
    let p = threeTabs();
    p = withTabActive(p, 1);
    p = withSelection(p, ['x'], 'x', 'x');
    p = withTabActive(p, 2);
    expect(p.selection).toEqual([]);
    p = withTabActive(p, 0);
    expect(p.selection, '0 番のタブの選び').toEqual(['a', 'b']);
    p = withTabActive(p, 1);
    expect(p.selection, '1 番のタブの選び').toEqual(['x']);
  });

  it('🔴 戻した後は、裏のタブに同じ選びを二重に持たない(開いているタブは欄を持たない)', () => {
    const back = withTabActive(withTabActive(threeTabs(), 1), 0);
    const active = back.tabs[back.active]!;
    expect('selection' in active, '開いているタブに選びの控えが残っている').toBe(false);
    expect('anchor' in active).toBe(false);
    expect('cursor' in active).toBe(false);
  });

  it('同じ場所で「+」を押したときも、離れるタブの選びを憶える(新しいタブは空)', () => {
    const p = withTabAdded(threeTabs());
    expect(p.selection, '新しいタブに選びを持ち込んだ').toEqual([]);
    expect(withTabActive(p, 0).selection, '足す前のタブの選びが消えた').toEqual(['a', 'b']);
  });

  it('場所を変えたら、そのタブの選びは外れる(戻っても居ない行を選んだままにしない)', () => {
    const away = withTabActive(threeTabs(), 1);
    const moved = withScope(away, 'f2');
    expect(moved.selection).toEqual([]);
    // 0 番のタブの控えには触らない
    expect(withTabActive(moved, 0).selection).toEqual(['a', 'b']);
  });
});

describe('2〜3. タブを閉じるとき', () => {
  it('🔴 開いていないタブを閉じても、いまの選びは外れない', () => {
    const p = threeTabs();
    const closedOther = withTabClosed(p, 2);
    expect(closedOther.selection, '開いていないタブを閉じて、いまの選びが外れた').toEqual(['a', 'b']);
    expect(closedOther.cursor).toBe('b');
    expect(closedOther.active).toBe(0);
    // 開いているタブより手前のタブを閉じると、開いているタブの添字は 1 つ詰まるが選びは同じ
    const onTab1 = withTabActive(p, 1);
    const sel1 = withSelection(onTab1, ['x'], 'x', 'x');
    const closedBefore = withTabClosed(sel1, 0);
    expect(closedBefore.active).toBe(0);
    expect(closedBefore.selection, '手前のタブを閉じて、いまの選びが外れた').toEqual(['x']);
  });

  it('🔴 開いているタブを閉じたら、次に開くタブが憶えていた選びになる', () => {
    let p = threeTabs();
    p = withTabActive(p, 1);
    p = withSelection(p, ['x'], 'x', 'x');
    p = withTabActive(p, 0); // 1 番のタブは ['x'] を憶えて裏へ
    const closed = withTabClosed(p, 0); // 0 を閉じる → 次に開くのは(添字 0 に詰まった)元の 1 番
    expect(closed.active).toBe(0);
    expect(closed.selection, '閉じたタブの選びが残った / 次のタブの選びが戻らない').toEqual(['x']);
    expect('selection' in closed.tabs[0]!, '開いたタブに控えが残っている').toBe(false);
  });
});

describe('4. 消えた lid は、裏のタブの選びからも落ちる', () => {
  it('🔴 戻ったときに、実在しない物を選んだままにしない', () => {
    const away = withTabActive(threeTabs(), 1); // 0 番は a, b を憶えて裏へ
    const pruned = pruneDual({ ...initialDual, left: away }, (lid) => lid !== 'a', undefined);
    const back = withTabActive(pruned.left, 0);
    expect(back.selection, '消えた a が戻った').toEqual(['b']);
  });

  it('カーソルが消えた物なら外れる / 場所が消えたタブの選びは捨てる', () => {
    let p = threeTabs(); // 開いているのは 0(a, b)
    p = withTabActive(p, 2); // 0 番は裏へ。2 番(f2)が開く
    // f1 が消える ── 1 番のタブは場所を失う。0 番の控えは影響を受けない(場所はルート)
    const pruned = pruneDual({ ...initialDual, left: p }, (lid) => lid !== 'f1', undefined);
    expect(withTabActive(pruned.left, 0).selection).toEqual(['a', 'b']);
    // b がカーソルのまま消えたら、カーソルだけが外れる
    const cursorGone = pruneDual({ ...initialDual, left: p }, (lid) => lid !== 'b', undefined);
    const back = withTabActive(cursorGone.left, 0);
    expect(back.selection).toEqual(['a']);
    expect(back.cursor, '消えた行をカーソルが指している').toBeNull();
  });
});

describe('5. 選びを持たないタブの形は変わらない', () => {
  it('🔴 何も選んでいないタブを切り替えても、タブの形に欄が増えない', () => {
    let p = withTabAdded(initialDual.left);
    p = withTabActive(p, 0);
    p = withTabActive(p, 1);
    for (const t of p.tabs) expect(Object.keys(t).sort(), '選びが無いのに欄を足した').toEqual(['future', 'past', 'scopeLid']);
  });
});
