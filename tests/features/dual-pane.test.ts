/** @vitest-environment node */
/**
 * 2 ペインタブファイラの持ち物(#241 段⑥)。
 *
 * 🔴 守る主張:
 * 1. **左右は別の場所を持てる**(これが無いと 2 ペインの意味が無い)
 * 2. **タブは 1 枚以上**(場所が無いペインは描けない)
 * 3. **場所が変わったら印は外れる**(見えていないものを数えない)
 * 4. **添字は常に範囲内**(外れると「勝手に一番上へ戻った」ように見える)
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TABS,
  initialDual,
  otherSide,
  paneOf,
  paneScope,
  pruneDual,
  withPane,
  withScope,
  withSelection,
  withTabActive,
  withTabAdded,
  withTabClosed,
} from '../../src/features/relation/dual-pane';

describe('2 ペインの持ち物(#241 段⑥)', () => {
  it('🔴 左右は別の場所を持てる(片方を動かしても、もう片方は動かない)', () => {
    const s = withPane(initialDual, 'left', withScope(initialDual.left, 'f1'));
    expect(paneScope(paneOf(s, 'left'))).toBe('f1');
    expect(paneScope(paneOf(s, 'right')), '片方を動かしたら両方動いた').toBeNull();
  });

  it('otherSide は行き来する(移す向きの唯一の規則)', () => {
    expect(otherSide('left')).toBe('right');
    expect(otherSide(otherSide('left'))).toBe('left');
  });

  it('🔴 場所が変わったら印も起点も外れる', () => {
    const marked = withSelection(initialDual.left, ['a', 'b'], 'b');
    expect(marked.selection, '前提が崩れている').toHaveLength(2);
    const moved = withScope(marked, 'f1');
    expect(moved.selection, '見えていないものが選ばれたまま').toEqual([]);
    expect(moved.anchor, '起点が別の場所に残っている').toBeNull();
  });

  it('同じ場所へ動かしても、何も起きない(印を無駄に捨てない)', () => {
    const marked = withSelection(initialDual.left, ['a'], 'a');
    expect(withScope(marked, null), '同じ場所で印が捨てられた').toBe(marked);
  });

  it('🔴 タブは足せて、いまの場所を引き継ぐ', () => {
    const one = withScope(initialDual.left, 'f1');
    const two = withTabAdded(one);
    expect(two.tabs).toHaveLength(2);
    expect(two.active, '足したタブが開いていない').toBe(1);
    expect(paneScope(two), '足したタブが別の場所を向いている').toBe('f1');
  });

  it('🔴 上限を超えては足せない(帯が版面を食い尽くさない)', () => {
    let p = initialDual.left;
    for (let i = 0; i < MAX_TABS + 5; i += 1) p = withTabAdded(p);
    expect(p.tabs.length, '上限が効いていない').toBe(MAX_TABS);
  });

  it('🔴 最後の 1 枚は閉じられない(場所の無いペインを作らない)', () => {
    expect(withTabClosed(initialDual.left, 0).tabs, '最後の 1 枚が閉じた').toHaveLength(1);
  });

  it('🔴 閉じたあとも添字は範囲内(「勝手に一番上へ戻る」を作らない)', () => {
    // 3 枚(ルート / f1 / f2)を作り、いちばん右を開いた状態で**左端**を閉じる
    let p = withScope(initialDual.left, 'r');
    p = withScope(withTabAdded(p), 'f1');
    p = withScope(withTabAdded(p), 'f2');
    expect(p.tabs.map((t) => t.scopeLid), '前提が崩れている').toEqual(['r', 'f1', 'f2']);
    expect(p.active).toBe(2);
    const closed = withTabClosed(p, 0);
    expect(closed.tabs.map((t) => t.scopeLid)).toEqual(['f1', 'f2']);
    expect(closed.active, '開いていたタブが別の場所へすり替わった').toBe(1);
    expect(paneScope(closed), '見ていた場所が変わった').toBe('f2');
  });

  it('開いているタブを閉じたら、範囲内へ丸める', () => {
    let p = withScope(initialDual.left, 'r');
    p = withScope(withTabAdded(p), 'f1');
    const closed = withTabClosed(p, 1); // 開いている方(添字 1)を閉じる
    expect(closed.tabs).toHaveLength(1);
    expect(closed.active, '範囲外の添字が残った').toBe(0);
    expect(paneScope(closed)).toBe('r');
  });

  it('範囲外の操作は state を壊さない', () => {
    const p = initialDual.left;
    expect(withTabClosed(p, 99)).toBe(p);
    expect(withTabActive(p, 99)).toBe(p);
    expect(withTabActive(p, -1)).toBe(p);
    expect(withTabActive(p, 0), '同じタブへ移って作り直した').toBe(p);
  });

  it('🔴 消えた lid は印から落ちる(実在しないものを数えない)', () => {
    let s = withPane(initialDual, 'left', withSelection(initialDual.left, ['a', 'b'], 'b'));
    s = withPane(s, 'right', withSelection(initialDual.right, ['c'], 'c'));
    const pruned = pruneDual(s, (lid) => lid === 'a');
    expect(pruned.left.selection, '消えたものが左に残った').toEqual(['a']);
    expect(pruned.left.anchor, '消えたものが起点に残った').toBeNull();
    expect(pruned.right.selection, '消えたものが右に残った').toEqual([]);
  });

  /**
   * 🔴 **印だけ落として現在地を素通りさせない**(片側だけ直すと、消えたフォルダの
   * 中身として空の表が出続け、そこで作ると消えた親の子が生まれる)。
   */
  it('🔴 消えたフォルダを見ていたタブはルートへ戻る', () => {
    const left = withScope(initialDual.left, 'gone');
    const right = withScope(withTabAdded(withScope(initialDual.right, 'alive')), 'gone');
    let s = withPane(initialDual, 'left', left);
    s = withPane(s, 'right', right);
    expect(paneScope(s.left), '前提が崩れている').toBe('gone');
    const pruned = pruneDual(s, (lid) => lid === 'alive');
    expect(paneScope(pruned.left), '消えたフォルダを見たままになっている').toBeNull();
    expect(
      pruned.right.tabs.map((t) => t.scopeLid),
      '開いていないタブの現在地が検められていない',
    ).toEqual(['alive', null]);
  });

  /**
   * 🔴 **場所が変わったら印も外れる**(`withScope` と同じ規則)。
   * ⚠ 裏のタブが死んだだけでは外さない ── いま見えているものは変わっていない。
   */
  it('🔴 開いているタブの場所が死んだら、印も外れる', () => {
    const left = withSelection(withScope(initialDual.left, 'gone'), ['m'], 'm');
    const right = withSelection(withTabAdded(withScope(initialDual.right, 'gone')), ['m'], 'm');
    // 右は 2 枚目(生きているルート)を開いたまま、1 枚目の行き先だけが死ぬ
    const rightBack = withTabActive(withScope(right, null), 1);
    let s = withPane(initialDual, 'left', left);
    s = withPane(s, 'right', withSelection(rightBack, ['m'], 'm'));
    expect(s.right.tabs[0]?.scopeLid, '前提が崩れている').toBe('gone');
    const pruned = pruneDual(s, (lid) => lid === 'm');
    expect(pruned.left.selection, '見ている場所が変わったのに印が残った').toEqual([]);
    expect(pruned.left.anchor).toBeNull();
    expect(pruned.right.selection, '裏のタブの都合で、見えている印まで外れた').toEqual(['m']);
  });

  it('落ちるものが無ければ、同じ object を返す(無駄な再描画を作らない)', () => {
    const s = withPane(initialDual, 'left', withSelection(initialDual.left, ['a'], 'a'));
    expect(pruneDual(s, () => true), '何も消えていないのに作り直した').toBe(s);
  });
});
