import { describe, expect, it } from 'vitest';
import {
  HOLIDAY_FIRST_YEAR,
  HOLIDAY_LAST_YEAR,
  holidayName,
  holidaysOfYear,
} from '../../src/features/schedule/jp-holidays';

/**
 * 🔴 日本の祝日(#855)。期待値は**内閣府の「国民の祝日について」の一覧を手で書き写した物**で、
 * 実装(規則)を一切参照しない ── 実装と同じ盲点を共有しない(検証の規律 §1.10)。
 * 範囲は 2024〜2027 年の全部。
 */
const CABINET_OFFICE: Record<number, ReadonlyArray<readonly [string, string]>> = {
  2024: [
    ['01-01', '元日'],
    ['01-08', '成人の日'],
    ['02-11', '建国記念の日'],
    ['02-12', '振替休日'],
    ['02-23', '天皇誕生日'],
    ['03-20', '春分の日'],
    ['04-29', '昭和の日'],
    ['05-03', '憲法記念日'],
    ['05-04', 'みどりの日'],
    ['05-05', 'こどもの日'],
    ['05-06', '振替休日'],
    ['07-15', '海の日'],
    ['08-11', '山の日'],
    ['08-12', '振替休日'],
    ['09-16', '敬老の日'],
    ['09-22', '秋分の日'],
    ['09-23', '振替休日'],
    ['10-14', 'スポーツの日'],
    ['11-03', '文化の日'],
    ['11-04', '振替休日'],
    ['11-23', '勤労感謝の日'],
  ],
  2025: [
    ['01-01', '元日'],
    ['01-13', '成人の日'],
    ['02-11', '建国記念の日'],
    ['02-23', '天皇誕生日'],
    ['02-24', '振替休日'],
    ['03-20', '春分の日'],
    ['04-29', '昭和の日'],
    ['05-03', '憲法記念日'],
    ['05-04', 'みどりの日'],
    ['05-05', 'こどもの日'],
    ['05-06', '振替休日'],
    ['07-21', '海の日'],
    ['08-11', '山の日'],
    ['09-15', '敬老の日'],
    ['09-23', '秋分の日'],
    ['10-13', 'スポーツの日'],
    ['11-03', '文化の日'],
    ['11-23', '勤労感謝の日'],
    ['11-24', '振替休日'],
  ],
  2026: [
    ['01-01', '元日'],
    ['01-12', '成人の日'],
    ['02-11', '建国記念の日'],
    ['02-23', '天皇誕生日'],
    ['03-20', '春分の日'],
    ['04-29', '昭和の日'],
    ['05-03', '憲法記念日'],
    ['05-04', 'みどりの日'],
    ['05-05', 'こどもの日'],
    ['05-06', '振替休日'],
    ['07-20', '海の日'],
    ['08-11', '山の日'],
    ['09-21', '敬老の日'],
    ['09-22', '国民の休日'],
    ['09-23', '秋分の日'],
    ['10-12', 'スポーツの日'],
    ['11-03', '文化の日'],
    ['11-23', '勤労感謝の日'],
  ],
  2027: [
    ['01-01', '元日'],
    ['01-11', '成人の日'],
    ['02-11', '建国記念の日'],
    ['02-23', '天皇誕生日'],
    ['03-21', '春分の日'],
    ['03-22', '振替休日'],
    ['04-29', '昭和の日'],
    ['05-03', '憲法記念日'],
    ['05-04', 'みどりの日'],
    ['05-05', 'こどもの日'],
    ['07-19', '海の日'],
    ['08-11', '山の日'],
    ['09-20', '敬老の日'],
    ['09-23', '秋分の日'],
    ['10-11', 'スポーツの日'],
    ['11-03', '文化の日'],
    ['11-23', '勤労感謝の日'],
  ],
};

describe('日本の祝日(jp-holidays)', () => {
  it('2024〜2027 年は内閣府の一覧と 1 日も違わない(日付も名前も)', () => {
    // 空振り防止:4 年とも、書き写した件数が 17 件以上ある
    expect(Object.keys(CABINET_OFFICE)).toHaveLength(4);
    for (const [year, list] of Object.entries(CABINET_OFFICE)) {
      expect(list.length, `${year} 年の一覧が短い(書き写しが欠けている)`).toBeGreaterThanOrEqual(17);
      const want = new Map(list.map(([md, name]) => [`${year}-${md}`, name]));
      const got = holidaysOfYear(Number(year));
      expect([...got.entries()].sort(), `${year} 年`).toEqual([...want.entries()].sort());
    }
  });

  it('振替休日:日曜の祝日の次の「祝日でない日」(2024-11-04 / 2025-02-24 / 2025-05-06 / 2026-05-06)', () => {
    expect(holidayName('2024-11-04')).toBe('振替休日'); // 11/3(日)文化の日
    expect(holidayName('2025-02-24')).toBe('振替休日'); // 2/23(日)天皇誕生日
    // 対照群:日曜でなければ振替は無い(2025-11-03 は月曜の文化の日そのもの)
    expect(holidayName('2025-11-03')).toBe('文化の日');
    expect(holidayName('2025-11-04')).toBeNull();
    // 連休の中へ送る:5/3(日)憲法記念日 → 5/4・5/5 も祝日 → 5/6
    expect(holidayName('2026-05-06')).toBe('振替休日');
    expect(holidayName('2026-05-07')).toBeNull();
  });

  it('国民の休日:前日も翌日も祝日の平日(2026-09-22 / 2009-09-22)。日曜と祝日自身は対象外', () => {
    expect(holidayName('2026-09-22')).toBe('国民の休日');
    expect(holidayName('2009-09-22')).toBe('国民の休日');
    // 対照群:2025 年の 9/16 は敬老の日(祝日そのもの)、2025-09-22 は前日が日曜なだけで挟まれていない
    expect(holidayName('2025-09-22')).toBeNull();
    // 2019 年の 4/30 と 5/2 は、即位の日(5/1)に挟まれた平日 → 国民の休日
    expect(holidayName('2019-04-30')).toBe('国民の休日');
    expect(holidayName('2019-05-01')).toBe('天皇の即位の日');
    expect(holidayName('2019-05-02')).toBe('国民の休日');
    // 日曜は挟まれても国民の休日にならない:1997-05-03(土)と 5/5(月)の間の 5/4 は日曜
    expect(holidayName('1997-05-03')).toBe('憲法記念日');
    expect(holidayName('1997-05-04')).toBeNull();
    expect(holidayName('1997-05-05')).toBe('こどもの日');
  });

  it('春分の日・秋分の日:式の出す日が内閣府の公表と合う(2000・2020・2030・2050)', () => {
    // 内閣府の公表(暦要項)に基づく既知の日。2030 以降は式の近似で、官報の確定ではない
    expect(holidayName('2000-03-20')).toBe('春分の日');
    expect(holidayName('2000-09-23')).toBe('秋分の日');
    expect(holidayName('2020-03-20')).toBe('春分の日');
    expect(holidayName('2020-09-22')).toBe('秋分の日');
    expect(holidayName('2030-03-20')).toBe('春分の日');
    expect(holidayName('2030-09-23')).toBe('秋分の日');
    // 1 日ずれの境界(閏年の前後で式が 1 日動く)
    expect(holidayName('2012-03-20')).toBe('春分の日');
    expect(holidayName('2013-03-20')).toBe('春分の日');
    expect(holidayName('2011-03-21')).toBe('春分の日');
  });

  it('ハッピーマンデー:第 N 月曜の境界(1 日が月曜 / 日曜の月)', () => {
    // 2024-01-01 は月曜 → 第 2 月曜は 1/8。2023-01-01 は日曜 → 第 2 月曜は 1/9
    expect(holidayName('2024-01-08')).toBe('成人の日');
    expect(holidayName('2023-01-09')).toBe('成人の日');
    // 第 3 月曜(海の日 / 敬老の日)
    expect(holidayName('2024-07-15')).toBe('海の日');
    expect(holidayName('2023-07-17')).toBe('海の日');
    expect(holidayName('2024-09-16')).toBe('敬老の日');
  });

  it('制度が替わった年の境界:天皇誕生日 / みどりの日 / 昭和の日 / 体育の日', () => {
    expect(holidayName('1988-04-29')).toBe('天皇誕生日');
    expect(holidayName('1989-04-29')).toBe('みどりの日');
    expect(holidayName('1989-12-23')).toBe('天皇誕生日');
    expect(holidayName('2018-12-23')).toBe('天皇誕生日');
    expect(holidayName('2019-12-23')).toBeNull(); // 2019 年は天皇誕生日が無い
    expect(holidayName('2020-02-23')).toBe('天皇誕生日');
    expect(holidayName('2007-04-29')).toBe('昭和の日');
    expect(holidayName('2007-05-04')).toBe('みどりの日');
    expect(holidayName('2006-05-04')).toBe('国民の休日'); // 〜2006 年の 5/4 は挟まれた平日
    expect(holidayName('1999-10-10')).toBe('体育の日');
    expect(holidayName('2000-10-09')).toBe('体育の日');
    expect(holidayName('2020-10-12')).toBeNull(); // 2020 年のスポーツの日は 7/24 へ動いた
  });

  it('2020・2021 年の東京大会に合わせた移動(海の日・スポーツの日・山の日)', () => {
    expect(holidayName('2020-07-23')).toBe('海の日');
    expect(holidayName('2020-07-24')).toBe('スポーツの日');
    expect(holidayName('2020-08-10')).toBe('山の日');
    expect(holidayName('2021-07-22')).toBe('海の日');
    expect(holidayName('2021-07-23')).toBe('スポーツの日');
    expect(holidayName('2021-08-08')).toBe('山の日');
    expect(holidayName('2021-08-09')).toBe('振替休日'); // 8/8(日)の山の日
    expect(holidayName('2020-07-20')).toBeNull();
  });

  it('範囲:1980〜2099 年だけを規則で数える。外・読めない字は祝日なし', () => {
    expect(HOLIDAY_FIRST_YEAR).toBe(1980);
    expect(HOLIDAY_LAST_YEAR).toBe(2099);
    expect(holidayName('1979-01-01')).toBeNull();
    expect(holidayName('1980-01-01')).toBe('元日');
    expect(holidayName('2099-01-01')).toBe('元日');
    expect(holidayName('2100-01-01')).toBeNull();
    expect(holidayName('')).toBeNull();
    expect(holidayName('2026-1-1')).toBeNull();
    expect(holidayName('令和8年1月1日')).toBeNull();
    // 全年で 1 年あたり 12〜23 件(2019 年は即位の行事で 22)(元日〜勤労感謝の日 + 振替 + 国民の休日)に収まる(式の暴走の検知)
    for (let y = HOLIDAY_FIRST_YEAR; y <= HOLIDAY_LAST_YEAR; y += 1) {
      const n = holidaysOfYear(y).size;
      expect(n, `${y} 年の祝日の数`).toBeGreaterThanOrEqual(12);
      expect(n, `${y} 年の祝日の数`).toBeLessThanOrEqual(23);
    }
  });
});
