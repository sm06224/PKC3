/**
 * 🔴 **2 ペインの「行った先」と「絞り込み」**(#273 残件。user 指示 2026-08-19
 * 「往年の FD などを見習ってください / OS のファイラと同じことができないといけません」)。
 *
 * 守る主張:
 * 1. **履歴はタブが持つ** ── タブを切り替えてから「戻る」を押しても、別のタブで
 *    見ていた場所へは飛ばない
 * 2. **戻るが履歴に積まれない** ── 積むと枝が伸びて二度と抜けられない
 * 3. **別の所へ入ったら「進む」は捨てる**(ブラウザと同じ意味論)
 * 4. **消えた場所は履歴からも落ちる** ── 残すと「押しても何も起きない」になる
 * 5. **絞り込みの規則は 1 本**(`paneFilterOptions`)
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY,
  PREVIEW_CHARS,
  canGoBack,
  canGoForward,
  clipPreview,
  initialDual,
  paneFilterOptions,
  paneScope,
  pruneDual,
  withBack,
  withFilter,
  withForward,
  withScope,
  withTabActive,
  withTabAdded,
  type DualPaneState,
} from '../../src/features/relation/dual-pane';

const pane = (): DualPaneState => initialDual.left;

describe('行った先の履歴(#273 残件)', () => {
  it('🔴 入った先から 1 つ前へ戻れる / 戻ったら進める', () => {
    // 前提 ── まだどこへも行っていないので、どちらも押せない
    expect(canGoBack(pane()), 'まだ行っていないのに戻れる').toBe(false);
    expect(canGoForward(pane()), 'まだ戻っていないのに進める').toBe(false);

    const inF1 = withScope(pane(), 'f1');
    expect(canGoBack(inF1)).toBe(true);
    const back = withBack(inF1);
    expect(paneScope(back), 'ルートへ戻っていない').toBeNull();
    expect(canGoForward(back), '戻ったのに進めない').toBe(true);
    expect(paneScope(withForward(back)), '進んだ先が違う').toBe('f1');
  });

  /**
   * 🔴 **「戻る」自体を履歴に積まない**(実装の `withStep` が `withScope` を
   * 通さない理由)。⚠ 積むと、戻るたびに `past` が伸びて**永遠に戻り続けられる**。
   */
  it('🔴 戻るを繰り返しても、行った回数より多くは戻れない', () => {
    let p = withScope(withScope(pane(), 'f1'), 'f2');
    // 前提 ── 2 回入ったので 2 回戻れる
    expect(canGoBack(p)).toBe(true);
    p = withBack(p);
    expect(paneScope(p)).toBe('f1');
    p = withBack(p);
    expect(paneScope(p)).toBeNull();
    expect(canGoBack(p), '行った回数より多く戻れている(戻るを積んでいる)').toBe(false);
  });

  it('🔴 戻ってから別の所へ入ると、「進む」は捨てられる', () => {
    const p = withBack(withScope(pane(), 'f1'));
    expect(canGoForward(p), '前提が崩れた(戻れていない)').toBe(true);
    const other = withScope(p, 'f2');
    expect(canGoForward(other), '退けた枝が残っている(ブラウザと違う)').toBe(false);
  });

  /**
   * 🔴 **履歴はタブが持つ**(ペインではない)── ペインに持たせると、タブを
   * 切り替えてから戻ったときに**別のタブで見ていた場所**へ飛ぶ。
   */
  it('🔴 タブを切り替えたら、そのタブの履歴になる', () => {
    const first = withScope(pane(), 'f1'); // 1 枚目: root → f1
    const two = withTabAdded(first); // 2 枚目(f1 から複製。履歴は持たない)
    expect(canGoBack(two), '新しいタブが履歴を引き継いでいる').toBe(false);
    // 1 枚目へ戻ると、1 枚目の履歴が生きている
    const back1 = withTabActive(two, 0);
    expect(canGoBack(back1), 'タブを戻したら履歴も消えている').toBe(true);
    expect(paneScope(withBack(back1)), '別のタブの履歴を辿っている').toBeNull();
  });

  it('⚠ 上限を超えて憶えない(往復し続けても配列が伸びない)', () => {
    let p = pane();
    for (let i = 0; i < MAX_HISTORY + 20; i += 1) p = withScope(p, i % 2 === 0 ? 'f1' : 'f2');
    expect(p.tabs[p.active]!.past.length, '上限を超えて憶えている').toBe(MAX_HISTORY);
  });

  /**
   * 🔴 **消えた場所は履歴からも落ちる** ── 残すと `DUAL_SET_SCOPE` が弾くので、
   * 「戻るを押しても何も起きない」という無言の dead click になる。
   */
  it('🔴 消えたフォルダは履歴から落ちる', () => {
    const p = withScope(withScope(pane(), 'f1'), 'f2');
    // 前提 ── f1 が履歴に積まれている
    expect(p.tabs[p.active]!.past, '前提が崩れた').toContain('f1');
    const pruned = pruneDual({ ...initialDual, left: p }, (lid) => lid !== 'f1');
    expect(pruned.left.tabs[0]!.past, '消えた場所が履歴に残っている').not.toContain('f1');
    // ⚠ 生きているルート(null)は残る ── 落とすと「戻る」がどこへも行けなくなる
    expect(pruned.left.tabs[0]!.past, 'ルートまで落としている').toContain(null);
  });
});

describe('ペインごとの絞り込み(#273 残件)', () => {
  it('🔴 打ってある側は、その語だけで絞る(器の語は使わない)', () => {
    const p = withFilter(pane(), 'あ');
    const o = paneFilterOptions(p, 'い', new Set(['zzz']));
    expect(o.filterQuery, 'ペインの語が効いていない').toBe('あ');
    /**
     * 🔴 **本文の検索結果は付けない** ── `searchHits` は**器の語で引いた結果**で、
     * 別の語に付けると「打った語に当たっていないものが出る」ことになる。
     */
    expect(o.searchHits, '別の語の検索結果が混ざっている').toBeNull();
  });

  it('空のペインは、これまでどおり器の絞り込みに従う', () => {
    const hits = new Set(['zzz']);
    const o = paneFilterOptions(pane(), 'い', hits);
    expect(o.filterQuery).toBe('い');
    expect(o.searchHits, '器の検索結果が捨てられている').toBe(hits);
  });

  it('⚠ 絞りを変えたら印は外す(見えていないものが選ばれたままにならない)', () => {
    const marked: DualPaneState = { ...pane(), selection: ['a'], anchor: 'a', cursor: 'a' };
    const p = withFilter(marked, 'あ');
    expect(p.selection, '見えていない印が残っている').toEqual([]);
    expect(p.cursor).toBeNull();
  });
});

describe('下見に載せる分だけ切る(#273 残件)', () => {
  it('🔴 上限を超えたぶんは切って、切ったと分かる形にする', () => {
    const long = 'あ'.repeat(PREVIEW_CHARS + 100);
    const out = clipPreview(long);
    expect(out.length, '切っていない(長い本文がそのまま常駐する)').toBe(PREVIEW_CHARS + 1);
    expect(out.endsWith('…'), '切ったことが分からない').toBe(true);
  });

  it('短い本文はそのまま(印を足さない)', () => {
    expect(clipPreview('みじかい')).toBe('みじかい');
  });
});
