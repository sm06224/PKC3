/**
 * 🔴 **引っ越しの表は `isOpenable` より先に見る**(#292 段⑤、2026-08-23)。
 *
 * ## なぜ file を分けたか
 *
 * ⚠ **いま `MOVED_VIEWS` の名前は `VIEW_MODES` に 1 つも無い**(`calendar` /
 * `kanban` は同じ段で消した)。だから本体の test で順番を pin しようとしても、
 * どちらの順でも `isOpenable` が false を返すので **変異が SURVIVED する**
 * ── 弱いのではなく「**その次元を 1 度も通っていない**」
 * (CLAUDE.md §2 /「fixture のゼロ件の次元は測っていない次元」)。
 * 実際、段⑤ の変異試験 N4 がそう出た。
 *
 * 🔑 だから**両方の表に載っている世界**を作って通す。`vi.mock` は file 単位なので、
 * この 1 主張のためだけに file を分ける(`deep-link-sealed.test.ts` と同じ作法)。
 *
 * ## 🔑 守る実害
 *
 * 面を引っ越すとき、`MOVED_VIEWS` に足してから `VIEW_MODES` から消すまでの間、
 * 順番が逆だと **引っ越しが黙って起きない**(中央の面がそのまま開く)。
 * ⚠ そのとき落ちる test は 1 つも無く、user から見ると
 * 「更新したのに、前と同じように本文が消える」である。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/adapter/state/app-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapter/state/app-state')>();
  return {
    ...actual,
    // ⚠ **引っ越し済みの名前が、まだ開ける面としても生きている**世界
    //    (引っ越し作業の途中がまさにこの形である)
    // 🔑 **表と判定の両方を差す** ── `isViewMode` だけ差しても
    //   `openableViewNames` は `VIEW_MODES` を読むので前提が立たない
    //   (1 稿目はそれで、下の「前提」の it が落ちて教えてくれた)
    VIEW_MODES: [...actual.VIEW_MODES, 'calendar'],
    isViewMode: (v: string) => v === 'calendar' || actual.isViewMode(v),
  };
});

const { readViewDeepLink, openableViewNames } = await import(
  '../../src/adapter/platform/deep-link'
);

const target = (hash: string) => ({
  hash,
  clearHash: () => {},
  dropToken: () => {},
  setEntry: () => {},
  restoreHash: () => {},
});

describe('引っ越しの表と、開ける面の表が両方当たるとき', () => {
  /**
   * ⚠ **前提を先に検める**(CLAUDE.md「一致を主張する検査は、前提を検算してから」)
   * ── mock が効いていなければ、下の主張は**引っ越しが効いただけ**で通ってしまう。
   */
  it('⚠ 前提: この world では calendar が「開ける面」として生きている', () => {
    expect(openableViewNames(), 'mock が効いていない(この file は何も検めていない)').toContain(
      'calendar',
    );
  });

  it('🔴 引っ越しが勝つ(中央の面をそのまま開かない)', () => {
    expect(
      readViewDeepLink(target('#pkc?view=calendar')),
      '順番が逆 ── 引っ越しが黙って起きず、中央の面が開く',
    ).toEqual({ moved: 'schedule' });
  });

  /** ⚠ 空振り防止 ── 引っ越していない面は今までどおり中央で開く。 */
  it('⚠ 対照群 ── 引っ越していない面はそのまま開く', () => {
    expect(readViewDeepLink(target('#pkc?view=query'))).toEqual({ view: 'query' });
  });
});
