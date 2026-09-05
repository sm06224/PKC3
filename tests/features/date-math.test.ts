import { describe, it, expect } from 'vitest';
import { addDays, dayStamp, daysBetween } from '../../src/features/datetime/date-math';

/**
 * 🔴 **日付の加減算を 1 か所に寄せた**(#344 段①)。
 *
 * ⚠ ここが狂うと、期間の展開(束ねる側)と期間のずらし(落とす側)が
 *   **同時に**狂う ── しかも症状は「予定が 1 日ずれる」なので、
 *   user は「アプリが間違えた」ではなく「自分が書き間違えた」と読む。
 */
describe('addDays ── 暦の繰り上がり', () => {
  it.each([
    ['2026-08-25', 3, '2026-08-28'],
    ['2026-08-31', 1, '2026-09-01'], // 月末
    ['2026-12-31', 1, '2027-01-01'], // 年末
    ['2026-03-01', -1, '2026-02-28'], // 平年の 2 月
    ['2028-03-01', -1, '2028-02-29'], // 🔑 閏年 ── 自前で桁を繰り上げると必ずここで落ちる
    ['2026-08-25', 0, '2026-08-25'],
  ])('%s の %s 日後は %s', (from, days, want) => {
    expect(addDays(from, days)).toBe(want);
  });

  it('読めない字は null(⚠ 当てずっぽうの日付を返さない)', () => {
    expect(addDays('', 1)).toBeNull();
    expect(addDays('2026-8-5', 1)).toBeNull();
  });

  /**
   * 🔑 `schedule-date.ts` の裁定(実在しない日は形として通す)の**帰結**を pin する。
   * ⚠ 「弾いて `null`」にすると、user が打ち間違えた予定が束から**黙って消える**。
   */
  it('実在しない日は弾かず、暦へ寄せる(消さない)', () => {
    expect(addDays('2026-02-30', 1)).toBe('2026-03-03');
  });
});

describe('daysBetween ── 日そのものを数える', () => {
  it.each([
    ['2026-08-25', '2026-08-28', 3],
    ['2026-08-28', '2026-08-25', -3],
    ['2026-08-25', '2026-08-25', 0],
    ['2026-12-31', '2027-01-01', 1],
    ['2028-02-28', '2028-03-01', 2], // 閏日をまたぐ
  ])('%s → %s は %s 日', (from, to, want) => {
    expect(daysBetween(from, to)).toBe(want);
  });

  /**
   * 🔴 **TZ を変えても答えが変わらない**(#344 段①)。
   *
   * ⚠ **主張を弱めてある。** 初稿は「夏時間の境目では local 実装が落ちる」と書いたが、
   *   実測すると**落ちない** ── ずれは区間の長さに関わらず最大 1 時間なので、
   *   `Math.round` が吸ってしまう(`TZ=America/New_York` で 3/7→3/9 の local 差は
   *   **47 時間** = 丸めて 2 日)。つまり「UTC でなければ壊れる」検査は**書けない**。
   * 🔑 だから書けることを書く ── **箱の TZ に答えが依存しない**こと。
   *   この箱は UTC なので、切り替えないと**夏時間の行を 1 度も通らない**
   *   (CLAUDE.md §2「経路が一度も通っていない」)。
   *
   * 🔑 **空振りでないことを変異で確かめてある**(2026-08-24)── `dayStamp()` を
   *   `at.toISOString().slice(0, 10)` に替える(**ありがちな書き方**)と、
   *   `TZ=Asia/Tokyo` で **3 件が落ちる**(local の 0 時が前日の 15:00Z になるため)。
   * ⚠ 逆に「UTC で組むこと」自体を殺す変異は**書けない**(上のとおり丸めが吸う)──
   *   この検査が守っているのは **TZ 非依存**であって、UTC の実装そのものではない。
   */
  describe('TZ を変えても同じ', () => {
    const CASES: [string, string, number][] = [
      ['2026-03-07', '2026-03-09', 2], // 米国の夏時間開始をまたぐ
      ['2026-10-31', '2026-11-02', 2], // 終了をまたぐ
      ['2026-01-01', '2026-12-31', 364],
    ];

    it('⚠ 対照群 ── 切り替えが実際に効いていること(効いていなければ以下は空振り)', () => {
      const before = process.env.TZ;
      try {
        process.env.TZ = 'America/New_York';
        // 🔑 夏時間の境目をまたぐ 2 日は、local では **47 時間**である
        const span = new Date(2026, 2, 9).getTime() - new Date(2026, 2, 7).getTime();
        expect(span / 3600000, 'TZ の切り替えが効いていない ── 以下の検査は無意味').toBe(47);
      } finally {
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    });

    it.each(CASES)('%s → %s は、どの TZ でも %s 日', (from, to, want) => {
      const before = process.env.TZ;
      try {
        for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Australia/Lord_Howe']) {
          process.env.TZ = tz;
          expect(daysBetween(from, to), `TZ=${tz} で答えが変わった`).toBe(want);
          expect(addDays(from, want), `TZ=${tz} で答えが変わった`).toBe(to);
        }
      } finally {
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    });
  });

  it('読めない字は null', () => {
    expect(daysBetween('2026-08-25', 'x')).toBeNull();
    expect(daysBetween('x', '2026-08-25')).toBeNull();
  });
});

/**
 * 🔴 **`dayStamp` は端末の暦日**(#709)。書き出す file 名の「今日」がここ 1 本に
 *   寄ったので、UTC で組む書き方(`toISOString().slice(0, 10)`)に戻ると
 *   **JST の 0 時〜9 時に落とした file が前日の名前になる**。
 * 🔑 同じ瞬間を UTC と JST で見て、答えが分かれることを pin する。
 */
describe('dayStamp ── 端末の暦日', () => {
  const AT = new Date('2026-08-04T23:30:00Z'); // JST では 8/5 08:30

  const withTZ = <T,>(tz: string, fn: () => T): T => {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  };

  it('🔴 UTC の深夜は JST では翌日(UTC のままなら前日の名前になる)', () => {
    expect(withTZ('Asia/Tokyo', () => dayStamp(AT))).toBe('2026-08-05');
    expect(withTZ('UTC', () => dayStamp(AT))).toBe('2026-08-04');
  });

  it('区切りは引数(file 名は空)、桁は 2 桁に詰める', () => {
    withTZ('UTC', () => {
      expect(dayStamp(AT, '')).toBe('20260804');
      expect(dayStamp(new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
      expect(dayStamp(new Date('2026-01-05T12:00:00Z'), '/')).toBe('2026/01/05');
    });
  });
});
