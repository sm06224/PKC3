/**
 * 🔴 **ログの日の束ね**(#1441 案 b)── 規則(pure)。器への当て方は `tests/adapter/log-days.test.ts`。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatLogDay, logDayOfHeading, logDayRuns } from '../../src/features/textlog/log-days';

describe('時刻見出しの日', () => {
  it('追記が書く形(秒つき / 秒なし / ★つき)から日を取る', () => {
    expect(logDayOfHeading('2026-10-10 14:30:05')).toBe('2026-10-10');
    expect(logDayOfHeading('2026-10-10 14:30')).toBe('2026-10-10');
    expect(logDayOfHeading('2026-10-10 14:30:05 ★')).toBe('2026-10-10');
  });
  it('時刻見出しでない字 / 実在しない日は null(当てずっぽうで日を作らない)', () => {
    expect(logDayOfHeading('付録')).toBeNull();
    expect(logDayOfHeading('2026-10-10 の覚え書き')).toBeNull();
    expect(logDayOfHeading('2026-02-30 10:00:00')).toBeNull();
  });
  it('⚠ 端末の暦日のまま読む(UTC の瞬間として日をずらさない)', () => {
    // 日本の 0 時台に書いた見出しが前日にならない ── 見出しは既にローカル時刻で焼かれている
    expect(logDayOfHeading('2026-10-10 00:05:00')).toBe('2026-10-10');
    expect(logDayOfHeading('2026-10-10 23:59:59')).toBe('2026-10-10');
  });
  describe('時差のある端末でも日が動かない', () => {
    const tz = process.env.TZ;
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    for (const zone of ['America/New_York', 'Asia/Tokyo', 'Pacific/Auckland']) {
      it(zone, () => {
        process.env.TZ = zone;
        // 日付+時刻を UTC の瞬間と読むと、西の端末では前日・東の端末では翌日にずれる
        expect(logDayOfHeading('2026-10-10 00:05:00')).toBe('2026-10-10');
        expect(logDayOfHeading('2026-10-10 23:55:00')).toBe('2026-10-10');
        expect(formatLogDay('2026-10-10')).toBe('2026-10-10(土)');
      });
    }
  });
  it('行の字は曜日つき', () => {
    expect(formatLogDay('2026-10-10')).toBe('2026-10-10(土)');
    expect(formatLogDay('2026-10-11')).toBe('2026-10-11(日)');
  });
});

describe('日の連なり', () => {
  const H = 2;
  it('日が変わる所ごとに 1 つ(最初の日も)', () => {
    const levels = [H, 0, H, 0, H, 0, H, 0];
    const days = ['a', null, 'a', null, 'b', null, 'b', null];
    expect(logDayRuns(levels, days)).toEqual([
      { day: 'a', start: 0, end: 4 },
      { day: 'b', start: 4, end: 8 },
    ]);
  });
  it('同じ日が続く間は 1 つ。1 件しか無い日も 1 つ', () => {
    expect(logDayRuns([H, H, H], ['a', 'a', 'a'])).toEqual([{ day: 'a', start: 0, end: 3 }]);
    expect(logDayRuns([H], ['a'])).toEqual([{ day: 'a', start: 0, end: 1 }]);
  });
  it('時刻見出しが 1 つも無ければ連なりは無い(ログでない書き方のノートに行を出さない)', () => {
    expect(logDayRuns([1, 0, H, 0], [null, null, null, null])).toEqual([]);
  });
  it('時刻でない `##` が挟まると連なりは切れ、その節は日の外', () => {
    const levels = [H, 0, H, 0, H, 0];
    const days = ['a', null, null, null, 'a', null];
    expect(logDayRuns(levels, days)).toEqual([
      { day: 'a', start: 0, end: 2 },
      { day: 'a', start: 4, end: 6 },
    ]);
  });
  it('入れ子の `###` は 1 件の中身(連なりを切らない)。`#` は日を閉じる', () => {
    expect(logDayRuns([H, 3, 0, H, 0], ['a', null, null, 'a', null])).toEqual([
      { day: 'a', start: 0, end: 5 },
    ]);
    expect(logDayRuns([H, 0, 1, 0], ['a', null, null, null])).toEqual([{ day: 'a', start: 0, end: 2 }]);
  });
  it('段 3 以下の時刻見出しは数えない', () => {
    expect(logDayRuns([3, 0], ['a', null])).toEqual([]);
  });
});
