/**
 * 🔴 **今日のノート**(#348、user 裁定 2026-08-23「推奨で OK」)。
 *
 * ⚠ ここが見るのは**規則**(題名の作り方 / 何を「今日のノート」と見なすか)。
 * 繋がり(押すと開く・無ければ作る)は `tests/adapter/today-note-binder.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { findTodayNote, todayNoteTitle } from '../../src/features/schedule/today-note';
import { shortcutDate } from '../../src/features/schedule/date-shortcuts';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(over: Partial<EntryMeta>): EntryMeta {
  return {
    lid: 'a',
    title: '2026-08-23',
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
    ...over,
  };
}

describe('todayNoteTitle(#348)', () => {
  it('🔴 題名は今日の `YYYY-MM-DD`', () => {
    expect(todayNoteTitle(new Date(2026, 7, 23, 15, 4))).toBe('2026-08-23');
  });

  /**
   * 🔴 **日付の作り方を 2 か所に持たない**(CLAUDE.md §7)── 別々に桁を詰めると、
   * 月末や 1 桁の月で**同じ日が別の字**になる。
   */
  it('🔴 日付の近道(`today`)と 1 バイトも違わない', () => {
    for (const d of [
      new Date(2026, 0, 1),
      new Date(2026, 8, 9),
      new Date(2026, 11, 31, 23, 59),
      new Date(2024, 1, 29), // 閏日
    ]) {
      expect(todayNoteTitle(d), `${d.toISOString()} でずれた`).toBe(shortcutDate('today', d));
    }
  });
});

describe('findTodayNote(#348)', () => {
  it('🔴 題名が一致するノートを返す', () => {
    const found = findTodayNote([meta({ lid: 'x', title: 'ほか' }), meta({ lid: 'y' })], '2026-08-23');
    expect(found?.lid).toBe('y');
  });

  it('⚠ 無ければ null(呼び側が作る)', () => {
    expect(findTodayNote([meta({ title: 'ほか' })], '2026-08-23')).toBeNull();
  });

  /**
   * 🔴 **ゴミ箱の中は拾わない** ── 拾うと「開いたのに一覧に無い」になり、
   * user から見ると壊れている。捨てたなら新しく作るのが素直である。
   */
  it('🔴 ゴミ箱の中は拾わない', () => {
    expect(findTodayNote([meta({ archived: true })], '2026-08-23')).toBeNull();
  });

  /**
   * 🔴 **同じ題名が複数在ったら、先に作られたほう** ── 押すたびに違うノートが
   * 開くと、user は「どっちが本物か」を追えなくなる。
   */
  it('🔴 同じ題名が複数あっても、いつも同じ 1 件を返す', () => {
    const rows = [meta({ lid: 'late', entryOrder: 9 }), meta({ lid: 'early', entryOrder: 2 })];
    expect(findTodayNote(rows, '2026-08-23')?.lid).toBe('early');
    // ⚠ 並び順を変えても同じ(入力の順に依存していない)
    expect(findTodayNote([...rows].reverse(), '2026-08-23')?.lid).toBe('early');
  });

  /** ⚠ 種類は問わない ── user がその日の入れ物を変えたなら、それが user の決め方。 */
  it('⚠ 種類は問わない', () => {
    expect(findTodayNote([meta({ archetype: 'textlog' })], '2026-08-23')?.archetype).toBe('textlog');
  });
});
