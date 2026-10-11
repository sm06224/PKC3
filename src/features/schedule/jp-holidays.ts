/**
 * 🔴 **日本の祝日**(#855。Gemini 裁定 = #1163 の依頼 10)── 網には繋がず、規則から計算する。
 *
 * 予定の小さな月・「週」の列の見出し・「日」の見出しが、祝日の日付の数字を赤くして、名前を
 * `title` に出す(`schedule.ts` / `schedule-week.ts` / `schedule-day.ts`)。
 *
 * ## 何を数えるか(いまの法律の規則)
 *
 * - **日付が決まっている祝日**: 元日 / 建国記念の日 / 天皇誕生日 / 昭和の日 / 憲法記念日 / みどりの日 /
 *   こどもの日 / 山の日 / 文化の日 / 勤労感謝の日(それぞれ制定された年から。名前と日付が変わった年も追う)
 * - **月曜に動く祝日(ハッピーマンデー)**: 成人の日 / 海の日 / 敬老の日 / スポーツの日(体育の日)
 * - **春分の日 / 秋分の日**: 天文計算の近似式(1980〜2099 年で使える標準の式)
 * - **振替休日**: 祝日が日曜に当たったら、次の「祝日でない日」(2007 年から。それ以前は翌日)
 * - **国民の休日**: 前日も翌日も祝日で、自分は日曜でも祝日でもない日
 * - **一度きりの祝日**(皇室の行事)と、2020・2021 年の東京大会に合わせた海の日・スポーツの日・山の日の移動
 *
 * ## ⚠ 前提(分からないことは分からないと書く)
 *
 * - **範囲は 1980〜2099 年**。それ以外の年は「祝日なし」を返す(式が当たる範囲の外を推測で埋めない)。
 * - **2026 年 10 月時点の法律**で数える。これ以後に祝日法が変わっても、この表は知らない
 *   (春分・秋分の日は毎年 2 月に官報で正式に決まる ── 近似式は 2099 年までの現行の暦に合わせた近似である)。
 * - 内閣府の一覧と 2024〜2027 年を `tests/features/jp-holidays.test.ts` で突き合わせてある。
 *
 * 🔑 pure module。時計もブラウザも読まない。日付は `YYYY-MM-DD`(端末の暦日)。
 */
import { storedDateParts } from '@features/datetime/stored-date';

/** 規則で数える範囲(両端を含む)。 */
export const HOLIDAY_FIRST_YEAR = 1980;
export const HOLIDAY_LAST_YEAR = 2099;

/** `year` 年 `month` 月の第 `nth` 月曜の日にち。 */
function nthMonday(year: number, month: number, nth: number): number {
  const firstDow = new Date(year, month - 1, 1).getDay(); // 0 = 日
  const firstMonday = 1 + ((8 - firstDow) % 7);
  return firstMonday + (nth - 1) * 7;
}

/** 春分の日(3 月)の日にち。1980〜2099 年の標準の近似式。 */
function springEquinox(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 秋分の日(9 月)の日にち。1980〜2099 年の標準の近似式。 */
function autumnEquinox(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function key(year: number, month: number, day: number): string {
  return `${year}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

/** 祝日法の規則そのもの(振替・国民の休日の前)。年ごとに 1 度だけ作る。 */
function baseHolidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const put = (month: number, day: number, name: string): void => {
    out.set(key(year, month, day), name);
  };
  put(1, 1, '元日');
  // 成人の日: 1999 年までは 1/15、2000 年から 1 月の第 2 月曜
  if (year >= 2000) put(1, nthMonday(year, 1, 2), '成人の日');
  else put(1, 15, '成人の日');
  put(2, 11, '建国記念の日'); // 1967 年から(範囲は 1980 年から)
  // 天皇誕生日: 1988 年までは 4/29、1989〜2018 年は 12/23、2020 年から 2/23(2019 年は無い)
  if (year <= 1988) put(4, 29, '天皇誕生日');
  else if (year <= 2018) put(12, 23, '天皇誕生日');
  else if (year >= 2020) put(2, 23, '天皇誕生日');
  put(3, springEquinox(year), '春分の日');
  // 4/29: 〜1988 は天皇誕生日(上)、1989〜2006 はみどりの日、2007 から昭和の日
  if (year >= 2007) put(4, 29, '昭和の日');
  else if (year >= 1989) put(4, 29, 'みどりの日');
  put(5, 3, '憲法記念日');
  if (year >= 2007) put(5, 4, 'みどりの日'); // 1986〜2006 年の 5/4 は国民の休日(下の規則で出る)
  put(5, 5, 'こどもの日');
  // 海の日: 1995 年までは無い、1996〜2002 年は 7/20、2003 年から 7 月の第 3 月曜(2020・2021 年は大会に合わせて動いた)
  if (year === 2020) put(7, 23, '海の日');
  else if (year === 2021) put(7, 22, '海の日');
  else if (year >= 2003) put(7, nthMonday(year, 7, 3), '海の日');
  else if (year >= 1996) put(7, 20, '海の日');
  // 山の日: 2016 年から 8/11(2020 年は 8/10、2021 年は 8/8)
  if (year === 2020) put(8, 10, '山の日');
  else if (year === 2021) put(8, 8, '山の日');
  else if (year >= 2016) put(8, 11, '山の日');
  // 敬老の日: 2002 年までは 9/15、2003 年から 9 月の第 3 月曜
  if (year >= 2003) put(9, nthMonday(year, 9, 3), '敬老の日');
  else put(9, 15, '敬老の日');
  put(9, autumnEquinox(year), '秋分の日');
  // 体育の日 → スポーツの日: 1999 年までは 10/10、2000 年から 10 月の第 2 月曜(2020 年は 7/24、2021 年は 7/23)
  if (year === 2020) put(7, 24, 'スポーツの日');
  else if (year === 2021) put(7, 23, 'スポーツの日');
  else if (year >= 2020) put(10, nthMonday(year, 10, 2), 'スポーツの日');
  else if (year >= 2000) put(10, nthMonday(year, 10, 2), '体育の日');
  else put(10, 10, '体育の日');
  put(11, 3, '文化の日');
  put(11, 23, '勤労感謝の日');
  // 一度きりの祝日(皇室の行事)
  if (year === 1989) put(2, 24, '昭和天皇の大喪の礼');
  if (year === 1990) put(11, 12, '即位礼正殿の儀');
  if (year === 1993) put(6, 9, '皇太子徳仁親王の結婚の儀');
  if (year === 2019) {
    put(5, 1, '天皇の即位の日');
    put(10, 22, '即位礼正殿の儀');
  }
  return out;
}

const cache = new Map<number, ReadonlyMap<string, string>>();

/** `year` 年の祝日(日付 → 名前)。範囲外の年は空。 */
export function holidaysOfYear(year: number): ReadonlyMap<string, string> {
  if (!Number.isInteger(year) || year < HOLIDAY_FIRST_YEAR || year > HOLIDAY_LAST_YEAR) return new Map();
  const hit = cache.get(year);
  if (hit !== undefined) return hit;
  const all = baseHolidays(year);
  const base = new Set(all.keys());
  const isHoliday = (y: number, m: number, d: number): boolean => {
    const k = key(y, m, d);
    return base.has(k) || all.has(k);
  };
  // 国民の休日(1986 年から): 前日も翌日も祝日で、日曜でも祝日でもない日。
  // ⚠ 数えるのは**祝日法の祝日**だけ(振替休日は祝日ではない)
  for (let m = 1; m <= 12; m += 1) {
    const last = new Date(year, m, 0).getDate();
    for (let d = 1; d <= last; d += 1) {
      const k = key(year, m, d);
      if (base.has(k)) continue;
      if (new Date(year, m - 1, d).getDay() === 0) continue;
      const prev = new Date(year, m - 1, d - 1);
      const next = new Date(year, m - 1, d + 1);
      if (
        base.has(key(prev.getFullYear(), prev.getMonth() + 1, prev.getDate())) &&
        base.has(key(next.getFullYear(), next.getMonth() + 1, next.getDate())) &&
        year >= 1986
      )
        all.set(k, '国民の休日');
    }
  }
  // 振替休日(1973 年から): 祝日が日曜なら、次の「祝日でない日」。
  // ⚠ 2006 年までは「翌日」だけ(翌日が祝日になる並びは当時無い)。2007 年から「祝日が続く間は先へ送る」
  const sundays = [...base].filter((k) => {
    const [y, m, d] = k.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d).getDay() === 0;
  });
  for (const k of sundays.sort()) {
    const [y, m, d] = k.split('-').map(Number) as [number, number, number];
    let at = new Date(y, m - 1, d + 1);
    if (year >= 2007) {
      while (isHoliday(at.getFullYear(), at.getMonth() + 1, at.getDate()))
        at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
    }
    if (at.getFullYear() !== year) continue; // 12/31 が日曜の祝日は無い。年をまたぐ送りは数えない
    all.set(key(at.getFullYear(), at.getMonth() + 1, at.getDate()), '振替休日');
  }
  cache.set(year, all);
  return all;
}

/** その日が祝日ならその名前、そうでなければ `null`。形が読めない字・範囲外の年も `null`。 */
export function holidayName(date: string): string | null {
  // ⚠ 日付の切り方は stored-date の 1 か所(全数検査がある)。形は `YYYY-MM-DD` ちょうどだけを受ける
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parts = storedDateParts(date);
  if (parts === null) return null;
  return holidaysOfYear(Number(parts.year)).get(date) ?? null;
}
