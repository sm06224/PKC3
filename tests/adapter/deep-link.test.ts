/**
 * 🔴 **`#pkc?view=…` で開く面を指す**(#300 段②、2026-08-22)。
 *
 * ## user から見た物語
 *
 * 別窓でカレンダーを開きたい。窓へ「どの面を出すか」を伝える口が要る。
 * ⚠ それを**クエリパラメータの切替**にしてはいけない(user 指示 2026-08-07、不可侵)
 * ── だから**ディープリンク**として足す。
 *
 * ## この test が守る主張
 *
 * ① 面の名前が読めたら、その面で開く
 * ② 🔴 **読んだら断片を消す** ── 消さないと、更新の適用や昇格で読み直しが
 *    起きた瞬間に「さっきまでやっていたこと」がその面へ飛ばされる
 * ③ 🔴 **知らない名前を黙って捨てない** ── user は「開かなかった」ことに
 *    気づけない。理由を出す
 * ④ ⚠ **対照群** ── 断片が無い / `view` が無いふつうの起動では**何も撃たない**
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyViewDeepLink,
  takeViewDeepLink,
  type DeepLinkAction,
  type DeepLinkTarget,
} from '../../src/adapter/platform/deep-link';
import { VIEW_MODES } from '../../src/adapter/state/app-state';

/** 的を作る。⚠ `clearHash` が呼ばれたかを数える(②の観測点)。 */
function target(hash: string): DeepLinkTarget & { cleared: () => number } {
  let cleared = 0;
  return {
    hash,
    clearHash: () => {
      cleared += 1;
    },
    cleared: () => cleared,
  };
}

function run(hash: string): { actions: DeepLinkAction[]; cleared: number } {
  const t = target(hash);
  const actions: DeepLinkAction[] = [];
  applyViewDeepLink((a) => actions.push(a), t);
  return { actions, cleared: t.cleared() };
}

describe('起動時のディープリンク(#300 段②)', () => {
  it('🔴 `#pkc?view=calendar` でカレンダーの面が開く', () => {
    const { actions } = run('#pkc?view=calendar');
    expect(actions, 'その面で開いていない').toEqual([
      { type: 'SET_VIEW_MODE', mode: 'calendar' },
    ]);
  });

  /**
   * 🔴 **面の全数を当てる**(組み合わせが有限なら全部当てる ── CLAUDE.md)。
   * ⚠ 面を足したときに「ディープリンクからは開けない面」が黙って生まれるのを止める。
   */
  it('🔴 いまある面は全部ディープリンクで開ける', () => {
    for (const mode of VIEW_MODES) {
      const { actions } = run(`#pkc?view=${mode}`);
      expect(actions, `${mode} が開けない`).toEqual([{ type: 'SET_VIEW_MODE', mode }]);
    }
  });

  it('🔴 読んだら断片を消す(読み直しで同じ面へ飛ばされない)', () => {
    const { cleared } = run('#pkc?view=kanban');
    expect(cleared, '断片が残る ── 読み直すたびに同じ面へ飛ぶ').toBe(1);
  });

  it('🔴 知らない面の名前は、黙って捨てず理由を出す', () => {
    const { actions, cleared } = run('#pkc?view=nonsense');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type, '面を開こうとした(型に無い値が state に入る)').toBe('OP_FAILED');
    const error = (actions[0] as { error: string }).error;
    expect(error, '理由になっていない').toContain('ありません');
    // ⚠ **打ち間違いの綴りをそのまま画面へ通さない**(状態の行に外来の字を出さない)
    expect(error, '外から来た綴りをそのまま出している').not.toContain('nonsense');
    // 🔑 代わりに**実在する面の呼び名**を出す(次に何を打てばよいか分かる)
    expect(error, '開ける面の呼び名が出ていない').toContain('カレンダー');
    // ⚠ 知らない名前でも断片は消す(残すと読み直しのたびに同じ断り文が出る)
    expect(cleared, '断り文が読み直しのたびに出る').toBe(1);
  });

  it('⚠ 対照群 ── ふつうの起動では何も撃たず、断片も触らない', () => {
    for (const hash of ['', '#', '#pkc?container=c1&entry=e1', '#other?view=calendar']) {
      const { actions, cleared } = run(hash);
      expect(actions, `${JSON.stringify(hash)} で面を動かした`).toEqual([]);
      expect(cleared, `${JSON.stringify(hash)} で断片を消した`).toBe(0);
    }
  });

  /** ⚠ 他の key と併記できる(将来「このノートを 2 ペインで」を組めるように)。 */
  it('⚠ 他の key と併記しても view が読める', () => {
    const { actions } = run('#pkc?container=c1&entry=e1&view=dual');
    expect(actions).toEqual([{ type: 'SET_VIEW_MODE', mode: 'dual' }]);
  });

  /**
   * ⚠ **空振り防止** ── `takeViewDeepLink` が常に `null` を返す実装でも、
   *   上の対照群だけは通る。**読めた側**を直に見る。
   */
  it('⚠ takeViewDeepLink は読めた面をそのまま返す', () => {
    expect(takeViewDeepLink(target('#pkc?view=help'))).toEqual({ view: 'help' });
    expect(takeViewDeepLink(target('#pkc?view=zzz'))).toEqual({ unknown: 'zzz' });
    expect(takeViewDeepLink(target('#pkc?entry=e1'))).toBeNull();
  });

  /** ⚠ 撃つ先を広げていないこと(`dispatch` は 1 回だけ呼ばれる)。 */
  it('⚠ dispatch は 1 回だけ呼ぶ', () => {
    const dispatch = vi.fn();
    applyViewDeepLink(dispatch, target('#pkc?view=query'));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
