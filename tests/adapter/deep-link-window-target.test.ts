/** @vitest-environment happy-dom */
/**
 * 🔴 **本物のアドレスを触る側**(`windowDeepLinkTarget`)を、実際に走らせる。
 *
 * ⚠ **ここまで 1 度も走っていなかった**(CLAUDE.md §2)── `deep-link.test.ts` は
 *   すべて差し替えた `DeepLinkTarget` で回っており、`tests/smoke/deep-link.smoke.spec.ts`
 *   の冒頭にも「`location.hash` を実際に読む配線は 1 度も走らない」と書いてある。
 * 🔴 だから **`history.replaceState` を使っているか / 履歴を積んでいないか**という
 *   #689 案 B のいちばん大事な後条件を、誰も見ていなかった。
 *
 * 🔑 ここで見るのは **user が押した後にアドレス欄と `← 戻る` がどうなるか**である
 *   ── 文字列を組む規則そのものは `tests/features/permalink-view.test.ts`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { windowDeepLinkTarget } from '../../src/adapter/platform/deep-link';

/** ⚠ 前の it が残した住所を持ち越さない(happy-dom の `location` は 1 つである)。 */
beforeEach(() => {
  history.replaceState(null, '', '/pkc/');
});

describe('本物のアドレスへの書き戻し(#689 案 B)', () => {
  it('🔴 住所が、いま見ているノートへ書き換わる', () => {
    history.replaceState(null, '', '/pkc/#pkc?container=c1&entry=e1');
    windowDeepLinkTarget().setEntry('c1', 'e2');
    expect(location.hash, '住所が古いノートを指したまま').toBe('#pkc?container=c1&entry=e2');
  });

  /**
   * 🔴 **`← 戻る` を壊さない**(この直しでいちばん怖いところ)。
   *
   * ⚠ ノートを渡り歩くたびに履歴が積まれると、**10 件読んだ後の `← 戻る` が
   *   10 回押さないと前の頁へ帰れない**形になる。⚠ しかもアドレスは
   *   正しく見えるので、user は「戻るが効かない」としか言えない。
   * 🔑 **観測点を 2 つ置く**:①どの API を呼んだか(`pushState` の spy)
   *   ②user に何が残るか(`history.length`)。⚠ どちらも happy-dom で
   *   **生きていることを実測した**(`pushState` で 1 → 2、`replaceState` では
   *   動かない)── 死んだ計器の 0 件を合格と読まないため。
   */
  it('🔴 履歴を積まない(← 戻るが 1 回で帰れる)', () => {
    history.replaceState(null, '', '/pkc/#pkc?container=c1&entry=e1');
    const push = vi.spyOn(history, 'pushState');
    const before = history.length;
    const t = windowDeepLinkTarget();
    t.setEntry('c1', 'e2');
    t.setEntry('c1', 'e3');
    t.setEntry('c1', 'e4');
    expect(location.hash, '前提が崩れた(そもそも書き換わっていない)').toBe(
      '#pkc?container=c1&entry=e4',
    );
    expect(push, '履歴を積んだ(戻るが 1 回で帰れなくなる)').not.toHaveBeenCalled();
    expect(history.length, '履歴が伸びた').toBe(before);
    push.mockRestore();
  });

  /**
   * ⚠ **同じノートなら 1 バイトも書かない**(対照群)── 選択は「同じ物を選び直す」
   *   経路でも流れてくるので、毎回書くとアドレス欄が絶えず点滅する。
   */
  it('⚠ 同じノートなら、書き戻し自体を呼ばない', () => {
    history.replaceState(null, '', '/pkc/#pkc?container=c1&entry=e1');
    const replace = vi.spyOn(history, 'replaceState');
    windowDeepLinkTarget().setEntry('c1', 'e1');
    expect(replace, '同じ住所で書き戻した').not.toHaveBeenCalled();
    replace.mockRestore();
  });

  /**
   * 🔴 **名乗っていない窓のアドレスは伸びない**(対照群)。
   * ⚠ ここが漏れると、ふつうに開いた全 user のアドレスが操作のたびに伸びる。
   */
  it('🔴 素のアドレスに住所を生やさない', () => {
    history.replaceState(null, '', '/pkc/');
    const replace = vi.spyOn(history, 'replaceState');
    windowDeepLinkTarget().setEntry('c1', 'e2');
    expect(replace, '素のタブで書き戻した').not.toHaveBeenCalled();
    expect(location.hash).toBe('');
    replace.mockRestore();
  });

  /**
   * 🔴 **flag のクエリを巻き込まない** ── `?pkc-flag=…` は起動前に要る値なので、
   *   落とすと**次の読み直しで別の設定のアプリが立ち上がる**。
   */
  it('🔴 `?pkc-flag=…` は残る', () => {
    history.replaceState(null, '', '/pkc/?pkc-flag=x#pkc?container=c1&entry=e1&view=dual');
    windowDeepLinkTarget().setEntry('c1', 'e2');
    expect(location.search, 'flag のクエリを落とした').toBe('?pkc-flag=x');
    expect(location.hash, '面を道連れにした').toBe('#pkc?container=c1&entry=e2&view=dual');
    /**
     * ⚠ **これは対照群ではない**(#689 着地前レビュー ⚠2、実測で判明)。
     *   `replaceState` に渡しているのは**相対 URL** なので、実装から
     *   `${location.pathname}` を丸ごと落としても解決結果は 1 文字も変わらない
     *   (深い path `/pkc/dev/index.html` でも同じ)。
     * 🔑 だから**ここで守れているのは `search` の行だけ**である ──
     *   この行は「読んだ人が path の心配をしなくてよい」ことを示す記録として残す。
     *   ⚠ 「これが無いと壊れる」とは書かない(CLAUDE.md § 1)。
     */
    expect(location.pathname, '前提が崩れた(台が別の場所を見ている)').toBe('/pkc/');
  });
});
