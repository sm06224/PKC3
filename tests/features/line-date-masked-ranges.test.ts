/**
 * 🔴 **日付の読み取り 3 件**(#1087)。
 *
 * - S2:ノートに日付として見えない所(インラインコード・`%%…%%`・リンクの宛先)を読まない
 * - S4:空白や ASCII `~` を挟んだ期間・時間の幅を、半分だけ読まずに全部読む
 * - S3:`毎月第2火曜` / `毎月末` は刻みとして読まない(対応していない言い方を別の予定にしない)
 */
import { describe, expect, it } from 'vitest';
import { allDateTokens, readLineDate, stripLineDate } from '../../src/features/schedule/line-date';
import { readRepeatTail } from '../../src/features/schedule/repeat';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { applyOpened } from '../helpers/open-line';

describe('S2:見えない所の日付は読まない', () => {
  it('インラインコードの中の日付ではなく、外の日付を読む(位置は原文のまま)', () => {
    const line = '- [ ] see `a @2026-10-20` then @2026-10-25';
    const r = readLineDate(line)!;
    expect(r.date).toBe('2026-10-25');
    expect(line.slice(r.start, r.end)).toBe('@2026-10-25');
  });

  it('コードの中にしか日付が無い行は予定ではない', () => {
    expect(readLineDate('- [ ] `@2026-10-20` だけ')).toBeNull();
    expect(allDateTokens('`@2026-10-20`')).toEqual([]);
  });

  it('隠しメモ %%…%% の中の日付は読まない', () => {
    const line = '- [ ] 会議 %%メモ @2026-10-20%% @2026-10-22';
    expect(readLineDate(line)!.date).toBe('2026-10-22');
    expect(readLineDate('- [ ] 会議 %%@2026-10-20%%')).toBeNull();
  });

  it('リンクの宛先の日付は読まない(リンクの字の日付は読む)', () => {
    expect(readLineDate('- [ ] [資料](http://x/@2026-10-21) @2026-10-20')!.date).toBe('2026-10-20');
    expect(readLineDate('- [ ] [資料](http://x/@2026-10-21)')).toBeNull();
    expect(readLineDate('- [ ] [@2026-10-21](entry:abc)')!.date).toBe('2026-10-21');
  });

  it('動かすと、バッククォートの中ではなく外の日付を書き換える', () => {
    const body = '- [ ] see `a @2026-10-20` then @2026-10-25\n';
    expect(applyOpened(body, { kind: 'line-date', line: 0, date: '2026-10-30' })).toBe(
      '- [ ] see `a @2026-10-20` then @2026-10-30\n',
    );
  });

  it('札の字に、隠しメモの字を出さない(コードの中の %% は残す)', () => {
    expect(stripLineDate('会議 %%内緒%% @2026-10-20 準備')).toBe('会議 準備');
    expect(stripLineDate('会議 @2026-10-20 %%内緒%%')).toBe('会議');
    expect(stripLineDate('`%%x%%` @2026-10-20')).toBe('`%%x%%`');
    const card = taskCardsOf('L', '- [ ] 会議 %%内緒%% @2026-10-20\n')[0]!;
    expect(card.text).toBe('会議');
  });

  it('対照:隠れていない日付は今までどおり', () => {
    expect(readLineDate('- [ ] 見積 @2026-10-20')!.date).toBe('2026-10-20');
    expect(allDateTokens('a @2026-10-20 b @2026-10-21').map((t) => t.date)).toEqual(['2026-10-20', '2026-10-21']);
  });
});

describe('S4:空白・ASCII ~ を挟んだ幅', () => {
  const dateRanges = [
    '出張 @2026-10-20 〜 2026-10-22',
    '出張 @2026-10-20 ~ 2026-10-22',
    '出張 @2026-10-20~2026-10-22',
    '出張 @2026-10-20 ～ 2026-10-22',
    '出張 @2026-10-20.. 2026-10-22',
  ];
  for (const line of dateRanges) {
    it(`日付の期間:${line}`, () => {
      const r = readLineDate(line)!;
      expect(r.date).toBe('2026-10-20');
      expect(r.until).toBe('2026-10-22');
      // 記法の範囲は終わりの日付まで(残りの字が札の字に出ない)
      expect(stripLineDate(line)).toBe('出張');
    });
  }

  const timeRanges = [
    '会議 @2026-10-20 14:00 - 15:00',
    '会議 @2026-10-20 14:00 〜 15:00',
    '会議 @2026-10-20 14:00~15:00',
    '会議 @2026-10-20 14:00 ~ 15:00',
    '会議 @2026-10-20 14:00 ～ 15:00',
    '会議 @2026-10-20 14:00- 15:00',
  ];
  for (const line of timeRanges) {
    it(`時間の幅:${line}`, () => {
      const r = readLineDate(line)!;
      expect(r.time).toBe('14:00');
      expect(r.timeEnd).toBe('15:00');
      expect(r.strayEnd).toBe(0);
      expect(stripLineDate(line)).toBe('会議');
    });
  }

  it('幅のあとの刻みも読める', () => {
    const r = readLineDate('会議 @2026-10-20 14:00 - 15:00 毎週')!;
    expect(r.timeEnd).toBe('15:00');
    expect(r.repeat).toBe('week');
  });

  it('動かすと、空白つきの幅も丸ごと差し替える(終わりの字が残らない)', () => {
    const body = '- [ ] 出張 @2026-10-20 〜 2026-10-22\n';
    expect(applyOpened(body, { kind: 'line-date', line: 0, date: '2026-10-21', until: '2026-10-23' })).toBe(
      '- [ ] 出張 @2026-10-21..2026-10-23\n',
    );
  });

  describe('対照:幅として成り立たない形は、今までどおり日付 / 時刻だけ読む', () => {
    it('14:00 - 会議(ハイフンの後が時刻ではない)', () => {
      const r = readLineDate('@2026-10-20 14:00 - 会議')!;
      expect(r.time).toBe('14:00');
      expect(r.timeEnd).toBeNull();
      expect(stripLineDate('@2026-10-20 14:00 - 会議')).toBe('- 会議');
    });
    it('逆順の幅は幅にしない', () => {
      const r = readLineDate('@2026-10-20 15:00 - 14:00')!;
      expect(r.timeEnd).toBeNull();
      expect(r.time).toBe('15:00');
    });
    it('日付のあとの 〜 の後ろが日付でなければ、日付だけを読む(落とさない)', () => {
      const r = readLineDate('@2026-10-20 〜 会議')!;
      expect(r.date).toBe('2026-10-20');
      expect(r.until).toBeNull();
      expect(readLineDate('@2026-10-20 〜 14:00')!.until).toBeNull();
    });
    it('逆順の期間(空白つき)は今までの隣接の逆順と同じに読まない', () => {
      expect(readLineDate('@2026-10-22 〜 2026-10-20')!.until).toBeNull();
    });
    it('隣接の書きかけ(@d〜 のあとに日付が無い)は、今までどおり落とす', () => {
      expect(readLineDate('@2026-10-20〜 会議')).toBeNull();
    });
    it('隣接の期間は今までどおり', () => {
      expect(readLineDate('@2026-10-20〜2026-10-22')!.until).toBe('2026-10-22');
      expect(readLineDate('@2026-10-20 14:00-15:00')!.timeEnd).toBe('15:00');
    });
  });
});

describe('S3:毎月第N◯曜 / 毎月末 は刻みとして読まない', () => {
  for (const tail of ['毎月第2火曜', '毎月 第2火曜', '毎月第二火曜', '毎月末', '毎月 末日']) {
    it(`${tail}`, () => {
      expect(readRepeatTail(tail)).toBeNull();
      const line = `定例 @2026-10-20 ${tail}`;
      const r = readLineDate(line)!;
      expect(r.repeat).toBeNull();
      // 全体が字のまま札に残る(20 日の毎月の予定にしない)
      expect(stripLineDate(line)).toBe(`定例 ${tail}`);
    });
  }

  it('期間の後ろでも同じ', () => {
    const r = readLineDate('定例 @2026-10-20..2026-12-31 毎月末')!;
    expect(r.repeat).toBeNull();
  });

  it('対照:毎月・毎週・毎日・毎年・隔週は今までどおり', () => {
    expect(readRepeatTail('毎月')!.unit).toBe('month');
    expect(readRepeatTail(' 毎月 定例')!.unit).toBe('month');
    expect(readRepeatTail('毎日')!.unit).toBe('day');
    expect(readRepeatTail('毎週')!.unit).toBe('week');
    expect(readRepeatTail('毎年')!.unit).toBe('year');
    expect(readRepeatTail('隔週')!.unit).toBe('biweek');
  });
});
