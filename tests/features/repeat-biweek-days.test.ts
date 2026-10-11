/**
 * 🔴 **隔週と曜日の列**(#855)。
 *
 * 見るのは 4 つ:① **隔週は 2 週ごと**(間隔・起点・`..` の終わり)② **曜日の列を読む**
 * (全角の読点・中黒も)③ 🔴 **既存の記法の読みが 1 バイトも変わらない**
 * (`毎週 日報` `毎週 月曜` のような、曜日の字で始まる普通の文を食べない)
 * ④ 書いて読み戻して同じ。
 */
import { describe, expect, it } from 'vitest';
import { expandRepeat, readRepeatTail, repeatWord } from '../../src/features/schedule/repeat';
import { formatLineDate, readLineDate, stripLineDate } from '../../src/features/schedule/line-date';
import { buildAgenda, itemOfCard } from '../../src/features/schedule/agenda';

const win = { from: '2026-09-01', to: '2026-10-15' };

describe('隔週', () => {
  it('🔴 2 週ごと(起点は開始日)', () => {
    const r = expandRepeat({ anchor: '2026-08-31', unit: 'biweek', until: null, ...win });
    expect(r.days).toEqual(['2026-09-14', '2026-09-28', '2026-10-12']);
  });

  it('開始日が窓の中なら、その日から数える(毎週の起点と同じ)', () => {
    const r = expandRepeat({ anchor: '2026-09-02', unit: 'biweek', until: null, ...win });
    expect(r.days).toEqual(['2026-09-02', '2026-09-16', '2026-09-30', '2026-10-14']);
  });

  it('窓が開始日より遠くても、2 週の位相が保たれる', () => {
    const r = expandRepeat({ anchor: '2026-01-05', unit: 'biweek', until: null, ...win });
    // 1/5 から 14 日ごと: 9/7 は 245 日後(14 の倍数でない)→ 9/14(252 日後)が最初
    expect(r.days[0]).toBe('2026-09-14');
  });

  it('🔴 `..` の終わりで止まる', () => {
    const r = expandRepeat({ anchor: '2026-08-31', unit: 'biweek', until: '2026-09-20', ...win });
    expect(r.days).toEqual(['2026-09-14']);
  });

  it('書き: `隔週` と読んで `隔週` と書く', () => {
    expect(readLineDate('定例 @2026-08-31 隔週')?.repeat).toBe('biweek');
    expect(readLineDate('定例 @2026-08-31..2026-12-31 隔週')).toMatchObject({
      repeat: 'biweek',
      until: '2026-12-31',
    });
    expect(readLineDate('定例 @2026-08-31 09:30 隔週')).toMatchObject({
      repeat: 'biweek',
      time: '09:30',
    });
    expect(formatLineDate('2026-08-31', null, null, 'biweek')).toBe('@2026-08-31 隔週');
    expect(stripLineDate('定例 @2026-08-31 隔週')).toBe('定例');
  });
});

describe('曜日の列', () => {
  it('🔴 読める綴り(全角の読点・中黒・半角の読点・空白あり)', () => {
    for (const tail of [
      ' 毎週 月水金',
      ' 毎週月水金',
      ' 毎週 月,水,金',
      ' 毎週 月、水、金',
      ' 毎週 月，水，金',
      ' 毎週 月・水・金',
      ' 毎週 月､水･金',
      ' 毎週 月 水 金',
      ' 毎週 金水月',
    ]) {
      expect(readRepeatTail(tail), tail).toMatchObject({ unit: 'days:135', length: tail.length });
    }
  });

  it('列の後ろの句読点・空白・文は残る(記法の範囲は列まで)', () => {
    expect(readLineDate('x @2026-08-31 毎週 月水金 ジム')).toMatchObject({ repeat: 'days:135' });
    expect(stripLineDate('ジム @2026-08-31 毎週 月水金')).toBe('ジム');
    expect(stripLineDate('@2026-08-31 毎週 月水金 ジム')).toBe('ジム');
    expect(readRepeatTail(' 毎週 月水、会議')).toMatchObject({
      unit: 'days:13',
      length: ' 毎週 月水'.length,
    });
  });

  it('🔴 月・水・金に出る(開始日より前は出ない)', () => {
    const r = expandRepeat({
      anchor: '2026-09-02', // 水
      unit: 'days:135',
      until: null,
      from: '2026-08-31',
      to: '2026-09-13',
    });
    expect(r.days).toEqual(['2026-09-02', '2026-09-04', '2026-09-07', '2026-09-09', '2026-09-11']);
  });

  it('開始日の曜日が列に無くても、列の曜日に出る', () => {
    const r = expandRepeat({
      anchor: '2026-09-01', // 火
      unit: 'days:15',
      until: null,
      from: '2026-09-01',
      to: '2026-09-14',
    });
    expect(r.days).toEqual(['2026-09-04', '2026-09-07', '2026-09-11', '2026-09-14']);
  });

  it('🔴 `..` の終わりで止まる / 済んだ回は飛ばす / 上限で切ったら言う', () => {
    const base = { anchor: '2026-09-01', unit: 'days:15', from: '2026-09-01', to: '2026-12-31' } as const;
    expect(expandRepeat({ ...base, until: '2026-09-07' }).days).toEqual(['2026-09-04', '2026-09-07']);
    expect(
      expandRepeat({ ...base, until: '2026-09-11', skip: new Set(['2026-09-07']) }).days,
    ).toEqual(['2026-09-04', '2026-09-11']);
    const cut = expandRepeat({ ...base, until: null, max: 3 });
    expect(cut.days).toHaveLength(3);
    expect(cut.truncated).toBe(true);
  });

  it('書いて読み戻して同じ(曜日は月から並べ直して書く)', () => {
    const line = formatLineDate('2026-08-31', '09:30', null, 'days:135');
    expect(line).toBe('@2026-08-31 09:30 毎週 月水金');
    expect(readLineDate(line)).toMatchObject({ repeat: 'days:135', time: '09:30' });
    expect(repeatWord('days:1357')).toBe('毎週 月水金日');
    expect(readLineDate('@2026-08-31 毎週 日月')?.repeat).toBe('days:17');
  });

  /**
   * 🔴 **既存の本文の意味は変わらない**。曜日の字で始まる普通の文・1 つだけの曜日・
   * 重複は、これまでどおり「毎週 + 字」と読む(前後で `repeat` も記法の範囲も同じ)。
   */
  /**
   * 🔴 **列は短く切らない**(着地前レビュー)。区切りの直後に曜日が続く形は列全体で判定し、
   * 直後が字なら列にしない(月水へ縮めて金を黙って落とさない)。
   */
  it('🔴 読点で区切った列は途中で切らない', () => {
    for (const rest of [' 毎週 月、水、金曜に', ' 毎週 月,水,金曜', ' 毎週 月，水，金曜', ' 毎週 月 水 金曜'])
      expect(readRepeatTail(rest), rest).toEqual({ unit: 'week', length: ' 毎週'.length });
    for (const rest of [' 毎週 月、水、金 会議', ' 毎週 月、水、金。', ' 毎週 月,水,金,'])
      expect(readRepeatTail(rest), rest).toMatchObject({ unit: 'days:135' });
    // 末尾の読点は区切りではなく句読点 ── 今の判断どおり月水
    expect(readRepeatTail(' 毎週 月水、会議')).toMatchObject({ unit: 'days:13' });
  });

  it('括弧: 開いた括弧の前でも列になる / 閉じた括弧の後ろも', () => {
    expect(readRepeatTail(' 毎週 火木（午前）')).toMatchObject({ unit: 'days:24' });
    expect(readRepeatTail(' 毎週 月水金（午前）')).toMatchObject({ unit: 'days:135' });
    expect(readRepeatTail(' 毎週 月水金[午前]')).toMatchObject({ unit: 'days:135' });
    expect(readRepeatTail(' 毎週 火木「午前」')).toMatchObject({ unit: 'days:24' });
    // 閉じ括弧の側: (毎週 月水) のように列の直後に閉じ括弧
    expect(readRepeatTail(' 毎週 月水)')).toMatchObject({ unit: 'days:13' });
    expect(readRepeatTail(' 毎週 月水」')).toMatchObject({ unit: 'days:13' });
  });

  /** 意味が変わる本文(意図した変化)── 正直に pin する。 */
  it('意図した変化: 隔週で始まる字も、曜日を並べた字も、今回から繰り返しになる', () => {
    expect(readLineDate('x @2026-08-31 隔週の定例')?.repeat).toBe('biweek');
    expect(readLineDate('x @2026-08-31 隔週ミーティング')?.repeat).toBe('biweek');
    expect(readLineDate('x @2026-08-31 毎週 土日')?.repeat).toBe('days:67');
    expect(readLineDate('x @2026-08-31 毎週 月・水 打合せ')?.repeat).toBe('days:13');
    expect(readLineDate('x @2026-08-31 毎週 月 水 会議')?.repeat).toBe('days:13');
  });

  it('🔴 既存の読みを変えない(曜日の字で始まる文は曜日にしない)', () => {
    for (const rest of [
      ' 毎週 日報を書く',
      ' 毎週 月曜',
      ' 毎週 月曜日に実施',
      ' 毎週 月水金曜',
      ' 毎週 月',
      ' 毎週 月月',
      ' 毎週 月、日報',
      ' 毎週 土日出勤',
      ' 毎週 金額の確認',
      ' 毎週 火曜と木曜',
    ]) {
      expect(readRepeatTail(rest), rest).toEqual({ unit: 'week', length: ' 毎週'.length });
    }
    expect(readRepeatTail('')).toBe(null);
  });

  it('🔴 既存の全形(毎日 / 毎週 / 毎月 / 毎年 × 時刻 × 期間)の解釈が変わらない', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['x @2026-08-31 毎日', { repeat: 'day', until: null, time: null }],
      ['x @2026-08-31 毎週', { repeat: 'week', until: null, time: null }],
      ['x @2026-08-31 毎月', { repeat: 'month', until: null, time: null }],
      ['x @2026-08-31 毎年', { repeat: 'year', until: null, time: null }],
      ['x @2026-08-31毎週', { repeat: 'week' }],
      ['x @2026-08-31 09:30 毎週', { repeat: 'week', time: '09:30' }],
      ['x @2026-08-31 09:30..10:30 毎週', { repeat: 'week', timeEnd: '10:30' }],
      ['x @2026-08-31..2026-12-31 毎週', { repeat: 'week', until: '2026-12-31' }],
      ['x @2026-08-31 毎週 日報', { repeat: 'week' }],
      ['x @2026-08-31 毎週 月曜の朝会', { repeat: 'week' }],
    ];
    for (const [line, want] of cases) expect(readLineDate(line), line).toMatchObject(want);
    // 記法の範囲(end)も同じ ── 後ろの字が記法に食われない
    expect(readLineDate('x @2026-08-31 毎週 日報')?.end).toBe('x @2026-08-31 毎週'.length);
    expect(stripLineDate('x @2026-08-31 毎週 月曜の朝会')).toBe('x 月曜の朝会');
    // 展開結果も毎週のまま
    expect(
      expandRepeat({ anchor: '2026-08-31', unit: 'week', until: null, ...win }).days.slice(0, 3),
    ).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
  });
});

describe('一覧(agenda)に出る', () => {
  const TODAY = '2026-08-23';
  const mk = (date: string, unit: 'biweek' | 'days:135', text: string) =>
    itemOfCard({
      lid: 'a',
      line: 0,
      text,
      done: false,
      date,
      time: null,
      until: null,
      repeat: unit,
      timeEnd: null,
      substitutes: null,
    });

  it('隔週は 2 週おき', () => {
    const g = buildAgenda([mk('2026-08-24', 'biweek', '定例')], TODAY, false, { horizonDays: 35 });
    expect(g.map((x) => x.date)).toEqual(['2026-08-24', '2026-09-07', '2026-09-21']);
  });

  it('曜日の列は列の曜日に出る', () => {
    const g = buildAgenda([mk('2026-08-24', 'days:135', 'ジム')], TODAY, false, { horizonDays: 8 });
    expect(g.map((x) => x.date)).toEqual(['2026-08-24', '2026-08-26', '2026-08-28', '2026-08-31']);
  });
});
