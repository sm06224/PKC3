/**
 * 🔴 **繰り返しの展開**(#344 段②)。
 *
 * ⚠ 見るのは 4 つ:① **anchor から数える**(寄った日が固定されない)
 * ② **窓の外は出さない** ③ **済んだ回は出さない**(例外日の記法を作らない代わり)
 * ④ **切ったら言う**。
 */
import { describe, expect, it } from 'vitest';
import {
  expandRepeat,
  materializedDates,
  occurrenceAt,
  readRepeatTail,
  REPEAT_MAX_OCCURRENCES,
  repeatMateKey,
  repeatUnitOf,
} from '../../src/features/schedule/repeat';

describe('語から刻みを読む', () => {
  it('4 つの語が読める', () => {
    expect(repeatUnitOf('毎日')).toBe('day');
    expect(repeatUnitOf('毎週')).toBe('week');
    expect(repeatUnitOf('毎月')).toBe('month');
    expect(repeatUnitOf('毎年')).toBe('year');
  });

  it('知らない語は読まない(黙って毎日にしない)', () => {
    expect(repeatUnitOf('毎')).toBe(null);
    expect(repeatUnitOf('毎週月曜')).toBe(null);
    expect(repeatUnitOf('')).toBe(null);
  });
});

describe('n 回目の日', () => {
  it('日と週は素直に進む', () => {
    expect(occurrenceAt('2026-08-31', 'day', 3)).toBe('2026-09-03');
    expect(occurrenceAt('2026-08-31', 'week', 2)).toBe('2026-09-14');
  });

  it('0 回目は開始日そのもの', () => {
    expect(occurrenceAt('2026-08-31', 'week', 0)).toBe('2026-08-31');
  });

  /**
   * 🔴 **月末が「寄ったまま固定」されない**(anchor から数える効き目)。
   * ⚠ 前の回から 1 つ進める作りだと 1/31 → 2/28 → **3/28** となり、
   *   user が書いた「31 日」が 2 月をまたいだ瞬間に永久に失われる。
   */
  it('🔴 月末は寄せるが、次の月では戻る', () => {
    expect(occurrenceAt('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(occurrenceAt('2026-01-31', 'month', 2)).toBe('2026-03-31');
    expect(occurrenceAt('2026-01-31', 'month', 3)).toBe('2026-04-30');
  });

  /** ⚠ `Date` に任せると 2/31 は **3/3 へ流れる** ── その月の末日で止める。 */
  it('🔴 翌月へ流さない(2 月 31 日を 3 月 3 日にしない)', () => {
    expect(occurrenceAt('2026-01-31', 'month', 1)).not.toBe('2026-03-03');
  });

  it('閏年をまたぐ毎年は 2/29 → 2/28 で止まり、次の閏年で戻る', () => {
    expect(occurrenceAt('2024-02-29', 'year', 1)).toBe('2025-02-28');
    expect(occurrenceAt('2024-02-29', 'year', 4)).toBe('2028-02-29');
  });

  it('年をまたぐ毎月が繰り上がる', () => {
    expect(occurrenceAt('2026-11-15', 'month', 3)).toBe('2027-02-15');
  });

  it('読めない字なら null(寄った日を作らない)', () => {
    expect(occurrenceAt('2026-8-1', 'week', 1)).toBe(null);
    expect(occurrenceAt('', 'day', 1)).toBe(null);
  });
});

describe('窓の中へ展開する', () => {
  const win = { from: '2026-09-01', to: '2026-09-30' };

  it('🔴 毎週が窓の中の日だけ出る', () => {
    const r = expandRepeat({ anchor: '2026-08-31', unit: 'week', until: null, ...win });
    expect(r.days).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(r.truncated).toBe(false);
  });

  /** ⚠ 開始日が窓の中なら、その日も出る(1 回目を落とさない)。 */
  it('開始日が窓の中なら、その日も出る', () => {
    const r = expandRepeat({ anchor: '2026-09-02', unit: 'week', until: null, ...win });
    expect(r.days[0]).toBe('2026-09-02');
  });

  /** 🔑 終わりは既存の `..` を使い回す ── そこで止まる。 */
  it('🔴 until で止まる(窓の端より手前でも)', () => {
    const r = expandRepeat({
      anchor: '2026-08-31',
      unit: 'week',
      until: '2026-09-15',
      ...win,
    });
    expect(r.days).toEqual(['2026-09-07', '2026-09-14']);
  });

  /**
   * 🔑 **済んだ回は出さない** ── 例外日の記法を作らない代わりに、
   * 実体の行の日付が `skip` として渡ってくる。
   */
  it('🔴 済んだ回(skip)は出さない', () => {
    const r = expandRepeat({
      anchor: '2026-08-31',
      unit: 'week',
      until: null,
      ...win,
      skip: new Set(['2026-09-14']),
    });
    expect(r.days).toEqual(['2026-09-07', '2026-09-21', '2026-09-28']);
  });

  /**
   * 🔴 **窓へ届くまで空回りできる**(古い anchor)。
   * ⚠ ここが効かないと `@2020-01-06 毎週` は 1 件も出ない(または回り続ける)。
   */
  it('🔴 ずっと前から始まっていても、窓の分だけ出る', () => {
    const r = expandRepeat({ anchor: '2020-01-06', unit: 'week', until: null, ...win });
    expect(r.days.length).toBeGreaterThan(0);
    for (const d of r.days) {
      expect(d >= win.from && d <= win.to, `${d} が窓の外`).toBe(true);
    }
    // ⚠ 2020-01-06 は月曜 ── 窓の中の月曜だけが出る
    expect(r.days).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  });

  it('🔴 上限で切ったら、そう言う', () => {
    const r = expandRepeat({
      anchor: '2026-09-01',
      unit: 'day',
      until: null,
      from: '2026-09-01',
      to: '2030-09-01',
      max: 5,
    });
    expect(r.days).toHaveLength(5);
    expect(r.truncated, '切ったのに言わない').toBe(true);
  });

  /** ⚠ **対照群** ── 収まるなら切ったと言わない(「常に true」の実装を許さない)。 */
  it('⚠ 収まるときは切ったと言わない', () => {
    const r = expandRepeat({ anchor: '2026-09-01', unit: 'week', until: null, ...win });
    expect(r.truncated).toBe(false);
    expect(r.days.length).toBeGreaterThan(0);
  });

  it('窓が逆順なら空(黙って全部出さない)', () => {
    const r = expandRepeat({
      anchor: '2026-09-01',
      unit: 'day',
      until: null,
      from: '2026-09-30',
      to: '2026-09-01',
    });
    expect(r.days).toEqual([]);
  });

  it('開始の形が壊れていたら何も出さない', () => {
    const r = expandRepeat({ anchor: '2026-9-1', unit: 'day', until: null, ...win });
    expect(r.days).toEqual([]);
  });

  /**
   * 🔴 **窓の形が壊れていたら何も出さない**(2026-08-25、変異試験 R8 が
   * SURVIVED で教えた ── 開始日の形しか試していなかった)。
   *
   * ⚠ 窓の門を外すと、`to` が `2026-9-30`(桁が詰まっていない)のとき
   *   **文字列比較が効かず、上限まで 200 日出る** ── 「予定が 200 件増えた」
   *   という、user がいちばん驚く形になる。
   */
  it('🔴 窓の終わりの形が壊れていたら何も出さない(200 日出さない)', () => {
    const r = expandRepeat({
      anchor: '2026-09-01',
      unit: 'day',
      until: null,
      from: '2026-09-01',
      to: '2026-9-30',
    });
    expect(r.days, '窓の形を見ていない(桁の詰まっていない字で暴れる)').toEqual([]);
  });

  it('窓の始まりの形が壊れていても何も出さない', () => {
    const r = expandRepeat({
      anchor: '2026-09-01',
      unit: 'day',
      until: null,
      from: '2026-9-1',
      to: '2026-09-30',
    });
    expect(r.days).toEqual([]);
  });

  /** ⚠ 既定の上限が効いていること(呼び側が渡さなくても暴れない)。 */
  it('既定の上限が効く', () => {
    const r = expandRepeat({
      anchor: '2026-01-01',
      unit: 'day',
      until: null,
      from: '2026-01-01',
      to: '2030-01-01',
    });
    expect(r.days).toHaveLength(REPEAT_MAX_OCCURRENCES);
    expect(r.truncated).toBe(true);
  });
});

/**
 * 🔴 **記法の尻の語を読む**(#344 段②)。
 *
 * ⚠ ここが見るのは「**日付の走査を広げていない**」ことでもある ── 尻だけ別に
 *   読むので、日付・期間・時刻の読み方は 1 バイトも変わっていない
 *   (それを確かめるのは `line-date.test.ts` の対照群)。
 */
describe('尻の刻みを読む(readRepeatTail)', () => {
  it('空白ありでも無しでも読む(日本語には語の切れ目が無い)', () => {
    expect(readRepeatTail(' 毎週')).toEqual({ unit: 'week', length: 3 });
    expect(readRepeatTail('毎週')).toEqual({ unit: 'week', length: 2 });
    expect(readRepeatTail('\t毎日')).toEqual({ unit: 'day', length: 3 });
  });

  it('先頭に無ければ読まない(散文の「毎週」を記法にしない)', () => {
    expect(readRepeatTail(' の資料を毎週送る')).toBe(null);
    expect(readRepeatTail('')).toBe(null);
  });

  it('知らない語は読まない(網に当たっても表が正本)', () => {
    expect(readRepeatTail(' 毎時')).toBe(null);
  });
});

/**
 * 🔴 **済んだ回の実体を束ねる**(#344 段②)。
 *
 * ⚠ ここを外すと **済ませた回がもう一度出る**(押しても「同じ行が既に在る」で
 *   何も起きないので、user からは壊れて見える)。
 */
describe('済んだ回の実体(materializedDates)', () => {
  const card = (
    lid: string,
    text: string,
    date: string | null,
    repeat: 'week' | null = null,
  ) => ({ lid, text, date, repeat });

  it('同じノートの同じ字の、繰り返しでない行が実体になる', () => {
    const m = materializedDates([
      card('a', 'ゴミ出し', '2026-08-31', 'week'),
      card('a', 'ゴミ出し', '2026-08-31'),
      card('a', 'ゴミ出し', '2026-09-07'),
    ]);
    expect([...(m.get(repeatMateKey('a', 'ゴミ出し')) ?? [])].sort()).toEqual([
      '2026-08-31',
      '2026-09-07',
    ]);
  });

  it('🔴 字が違えば別物(隣の項目の実体を横取りしない)', () => {
    const m = materializedDates([card('a', '掃除', '2026-08-31')]);
    expect(m.get(repeatMateKey('a', 'ゴミ出し'))).toBeUndefined();
  });

  it('🔴 ノートが違えば別物(別のノートの実体を横取りしない)', () => {
    const m = materializedDates([card('b', 'ゴミ出し', '2026-08-31')]);
    expect(m.get(repeatMateKey('a', 'ゴミ出し'))).toBeUndefined();
  });

  it('⚠ 規則の行そのものは実体ではない(自分で自分を消さない)', () => {
    const m = materializedDates([card('a', 'ゴミ出し', '2026-08-31', 'week')]);
    expect(m.get(repeatMateKey('a', 'ゴミ出し'))).toBeUndefined();
  });

  it('日付の無い行は数えない', () => {
    const m = materializedDates([card('a', 'ゴミ出し', null)]);
    expect(m.get(repeatMateKey('a', 'ゴミ出し'))).toBeUndefined();
  });
});
