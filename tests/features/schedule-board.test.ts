/**
 * 🔴 **予定表のカンバンの札の選び方・並び**(#277)。
 * user が不合格にしたのは「全部のチェックリストが札になる」こと(2026-08-23)── だから見るのは
 * ①日付なしは札にしない ②ノート 1 件の予定・繰り返しの規則は札にしない ③未完了は期限の近い順・完了は新しい順
 * ④上限で切ったら数を返す(黙って切らない)。
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_COLUMN_MAX,
  buildBoard,
  buildSignalBoard,
  isBoardCard,
  signalOf,
  signalTagOf,
} from '../../src/features/schedule/board';
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

describe('信号機の列(#1457)', () => {
  const TODAY = '2026-08-23';
  it('🔴 期限切れは赤 / 今日から 3 日以内は黄 / それ以降は緑(境目を両側から見る)', () => {
    const sig = (date: string) => signalOf(item({ lid: 'a', date }), TODAY);
    expect(sig('2026-08-22'), '昨日が赤でない').toBe('red');
    expect(sig('2026-08-23'), '今日が黄でない').toBe('yellow');
    expect(sig('2026-08-26'), '3 日後が黄でない(境目の内側)').toBe('yellow');
    expect(sig('2026-08-27'), '4 日後が緑でない(境目の外側)').toBe('green');
    // 月をまたぐ日付計算(文字列の足し算で 8/31 → 9/1 を間違えない)
    expect(signalOf(item({ lid: 'a', date: '2026-09-02' }), '2026-08-30')).toBe('yellow');
    expect(signalOf(item({ lid: 'a', date: '2026-09-04' }), '2026-08-30')).toBe('green');
  });

  it('🔴 行に信号のタグがあれば期日より優先(#赤 #黄 #緑 / #red / #status/green。大小・全角は無視)', () => {
    expect(signalTagOf('やること #赤')).toBe('red');
    expect(signalTagOf('x #Yellow y')).toBe('yellow');
    expect(signalTagOf('x #status/緑')).toBe('green');
    expect(signalTagOf('x #ＲＥＤ')).toBe('red');
    expect(signalTagOf('x #仕事')).toBeNull();
    expect(signalTagOf('C# の話 / https://a.test/#red')).toBeNull();
    // 遠い期日でも、赤のタグなら赤
    expect(signalOf(item({ lid: 'a', date: '2026-12-31', text: '急ぎ #赤' }), TODAY)).toBe('red');
    // 期限切れでも、緑のタグなら緑(user が決めた)
    expect(signalOf(item({ lid: 'a', date: '2026-01-01', text: '保留 #緑' }), TODAY)).toBe('green');
  });

  it('🔴 完了は常に完了の列(タグや期限に関わらず)/ 札の定義は状態のカンバンと同じ / 並びは期日順', () => {
    const b = buildSignalBoard(
      [
        item({ lid: 'a', date: '2026-08-20' }),
        item({ lid: 'b', date: '2026-08-10' }),
        item({ lid: 'c', date: '2026-08-23' }),
        item({ lid: 'd', date: '2026-10-01' }),
        item({ lid: 'e', date: '2026-08-01', done: true, text: '#赤' }),
        item({ lid: 'f', date: null }),
        item({ lid: 'g', line: null }),
        item({ lid: 'h', repeat: 'week' }),
      ],
      TODAY,
    );
    expect(b.red.map((i) => i.lid), '期限の近い順でない').toEqual(['b', 'a']);
    expect(b.yellow.map((i) => i.lid)).toEqual(['c']);
    expect(b.green.map((i) => i.lid)).toEqual(['d']);
    expect(b.done.map((i) => i.lid), '赤のタグの済みが完了に居ない').toEqual(['e']);
    expect(b.skipped).toBe(1);
  });

  it('上限で切ったら数を返す(列ごと)', () => {
    const many = Array.from({ length: 3 }, (_, i) => item({ lid: `r${i}`, date: '2026-08-01' }));
    const b = buildSignalBoard(many, TODAY, 2);
    expect(b.red).toHaveLength(2);
    expect(b.more.red).toBe(1);
    expect(b.more.green).toBe(0);
  });
});
