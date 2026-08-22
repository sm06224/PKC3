/**
 * 🔴 **封印中の面は、アドレスからも開けない**(#300 段②、2026-08-22)。
 *
 * ## なぜ file を分けたか
 *
 * ⚠ `SEALED_VIEWS` は**いま空**である。だから本体の test で
 * 「封印は除いている」を書いても、`!isSealedView(name)` を落とす変異は
 * **SURVIVED になる** ── 弱いのではなく「**その次元を 1 度も通っていない**」
 * (CLAUDE.md §2 / 「fixture のゼロ件の次元は測っていない次元」)。
 * 🔑 だから**封印が 1 件ある世界**を作って通す。`vi.mock` は file 単位なので、
 * この 1 主張のためだけに file を分ける。
 *
 * 🔑 守る実害: 封印は「**うっかり復活しないこと**」を目的にした仕掛けである。
 * ボタンを畳んだのにアドレスからは開ける、では向きが逆になる。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/features/sealed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/sealed')>();
  return {
    ...actual,
    // ⚠ 実在する面を 1 つだけ封印したことにする
    isSealedView: (view: string) => view === 'kanban',
  };
});

const { openableViewNames, readViewDeepLink } = await import(
  '../../src/adapter/platform/deep-link'
);

describe('封印中の面(#300 段②)', () => {
  it('🔴 封印された面は、開ける名前の一覧に出ない', () => {
    const names = openableViewNames();
    expect(names, '封印した面が一覧に残っている').not.toContain('kanban');
    // ⚠ 空振り防止 ── 封印していない面はちゃんと残っている
    expect(names, '一覧が丸ごと空になっている').toContain('calendar');
  });

  it('🔴 封印された面は、アドレスからも開けない(理由を出して断る)', () => {
    const target = { hash: '#pkc?view=kanban', clearHash: () => {}, dropToken: () => {} };
    expect(readViewDeepLink(target), '封印した面がアドレスから開ける').toEqual({
      unusable: true,
    });
    // ⚠ 対照群 ── 封印していない面は今までどおり開ける
    expect(readViewDeepLink({ hash: '#pkc?view=calendar', clearHash: () => {}, dropToken: () => {} })).toEqual({
      view: 'calendar',
    });
  });
});
