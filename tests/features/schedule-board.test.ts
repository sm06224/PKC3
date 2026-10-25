/**
 * 🔴 **予定表のカンバンの札の選び方・並び**(#277)。
 * user が不合格にしたのは「全部のチェックリストが札になる」こと(2026-08-23)── だから見るのは
 * ①日付なしは札にしない ②ノート 1 件の予定・繰り返しの規則は札にしない ③未完了は期限の近い順・完了は新しい順
 * ④上限で切ったら数を返す(黙って切らない)。
 */
import { describe, expect, it } from 'vitest';
import { BOARD_COLUMN_MAX, buildBoard, isBoardCard } from '../../src/features/schedule/board';
import type { AgendaItem } from '../../src/features/schedule/agenda';

const item = (over: Partial<AgendaItem> & { lid: string }): AgendaItem => ({
  key: `${over.lid} ${over.line ?? 'note'}`,
  line: 0,
  text: 't',
  done: false,
  date: '2026-08-23',
  time: null,
  timeEnd: null,
  until: null,
  repeat: null,
  ...over,
});

describe('カンバンの札', () => {
  it('日付付きのチェック項目だけが札になる(日付なし・ノート丸ごと・繰り返しは外れる)', () => {
    const b = buildBoard([
      item({ lid: 'a' }),
      item({ lid: 'b', date: null }),
      item({ lid: 'c', line: null }),
      item({ lid: 'd', repeat: 'week' }),
      item({ lid: 'e', done: true }),
    ]);
    expect(b.open.map((i) => i.lid)).toEqual(['a']);
    expect(b.done.map((i) => i.lid)).toEqual(['e']);
    expect(b.skipped, '繰り返しの数を言えない').toBe(1);
    expect(isBoardCard(item({ lid: 'x' }))).toBe(true);
    expect(isBoardCard(item({ lid: 'x', date: null }))).toBe(false);
  });

  it('未完了は日付・時刻の古い順、完了は新しい順', () => {
    const b = buildBoard([
      item({ lid: 'a', date: '2026-08-25' }),
      item({ lid: 'b', date: '2026-08-20' }),
      item({ lid: 'c', date: '2026-08-25', time: '09:00' }),
      item({ lid: 'x', date: '2026-08-01', done: true }),
      item({ lid: 'y', date: '2026-08-10', done: true }),
    ]);
    expect(b.open.map((i) => i.lid)).toEqual(['b', 'a', 'c']);
    expect(b.done.map((i) => i.lid)).toEqual(['y', 'x']);
  });

  it('上限で切ったら、切った数を返す(列ごと)', () => {
    const many = Array.from({ length: BOARD_COLUMN_MAX + 7 }, (_, i) =>
      item({ lid: `n${String(i).padStart(4, '0')}` }),
    );
    const b = buildBoard(many);
    expect(b.open).toHaveLength(BOARD_COLUMN_MAX);
    expect(b.openMore).toBe(7);
    expect(b.doneMore).toBe(0);
    expect(buildBoard([]).open).toEqual([]);
  });
});
