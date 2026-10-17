/** @vitest-environment node */
/**
 * 🔴 `.ics` 書き出しの落とし穴(#855 段 D。設計 `schedule-outlook-2026-09.md` §4)を 1 つずつ pin する。
 *
 * ⚠ 読み戻しは**この file 自身の `unfold`**(実装の `foldLine` を呼ばない)で行う ──
 *   実装の折り方と同じ盲点を共有しないため(期待値は別の観測から作る)。
 */
import { describe, it, expect } from 'vitest';
import {
  buildIcs,
  clampUntil,
  escapeText,
  foldLine,
  icsUid,
  resolveIcsZone,
  type IcsZone,
} from '@features/schedule/ics';
import type { AgendaItem } from '@features/schedule/agenda';
import { expandRepeat, occurrenceAt, type RepeatUnit } from '@features/schedule/repeat';

const TOKYO: IcsZone = { kind: 'tokyo' };
// 東京以外の例(+05:30 固定。夏時間は扱わない)
const UTC_PLUS_530: IcsZone = { kind: 'utc', offsetMinutes: () => 330 };
const STAMP = new Date(Date.UTC(2026, 9, 11, 3, 4, 5));

function item(over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    key: 'k',
    lid: 'n1',
    line: 3,
    text: '見積を送る',
    done: false,
    date: '2026-08-25',
    time: null,
    timeEnd: null,
    until: null,
    repeat: null,
    ...over,
  };
}

/** 独立の読み戻し:CRLF で割り、`CRLF + 空白` を繋ぎ直す。 */
function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, '').split('\r\n');
}
function ics(items: AgendaItem[], zone: IcsZone = TOKYO, extra: object = {}): string {
  return buildIcs(items, { stamp: STAMP, zone, ...extra }).text;
}
function lines(items: AgendaItem[], zone: IcsZone = TOKYO, extra: object = {}): string[] {
  return unfold(ics(items, zone, extra));
}
const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('改行と折り返し', () => {
  it('🔴 改行はすべて CRLF で、末尾も CRLF。素の LF / CR は 1 つも無い', () => {
    const t = ics([item(), item({ line: 4, text: 'a\nb' })]);
    expect(t.endsWith('\r\n')).toBe(true);
    expect(t.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(t.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(t.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('🔴 日本語は 25 字で溢れる ── 物理行は 75 バイト以内、繋ぎ直すと原文に戻り、字の途中では折らない', () => {
    const summary = '見積書を作成して取引先に送付する'.repeat(5); // 80 字 = 240 バイト超
    const t = ics([item({ text: summary })]);
    const physical = t.split('\r\n').slice(0, -1);
    for (const l of physical) expect(bytes(l), l).toBeLessThanOrEqual(75);
    // 折れていること(空振り防止):SUMMARY は複数の物理行になる
    expect(physical.filter((l) => l.startsWith(' ')).length).toBeGreaterThanOrEqual(3);
    // 各物理行が単独で正しい UTF-8 として読める = 字の途中で折っていない
    const dec = new TextDecoder('utf-8', { fatal: true });
    for (const l of physical) expect(() => dec.decode(new TextEncoder().encode(l))).not.toThrow();
    expect(lines([item({ text: summary })])).toContain(`SUMMARY:${summary}`);
  });

  it('75 バイトちょうどは折らない / 76 バイトは折る / 続きは空白も 1 バイトに数える / 4 バイトの字も割らない', () => {
    const exact = 'X'.repeat(75);
    expect(foldLine(exact)).toBe(exact);
    expect(foldLine('X'.repeat(76))).toBe(`${'X'.repeat(75)}\r\n X`);
    const folded = foldLine('X'.repeat(200)).split('\r\n');
    expect(folded.map(bytes)).toEqual([75, 75, 1 + 200 - 75 - 74]);
    const emoji = 'あ'.repeat(24) + '😀'.repeat(3); // 72 + 12 バイト
    for (const l of foldLine(emoji).split('\r\n')) expect(bytes(l)).toBeLessThanOrEqual(75);
    expect(foldLine(emoji).replace(/\r\n /g, '')).toBe(emoji);
  });
});

describe('エスケープ', () => {
  it('🔴 バックスラッシュ・セミコロン・カンマ・改行(LF / CRLF / CR)', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng');
  });
  it('SUMMARY と DESCRIPTION に効く(読み戻して原文が出る)', () => {
    const l = lines([item({ text: '会議; 資料,確認\\' })], TOKYO, { noteTitle: () => '週次;メモ' });
    expect(l).toContain('SUMMARY:会議\\; 資料\\,確認\\\\');
    expect(l).toContain('DESCRIPTION:ノート: 週次\\;メモ');
  });
});

describe('UID と DTSTAMP', () => {
  it('🔴 UID は lid と行の位置だけで決まる ── 日付・時刻・書き出す時刻が変わっても同じ', () => {
    const a = lines([item()], TOKYO);
    const b = unfold(
      buildIcs([item({ date: '2026-09-30', time: '10:00', text: '直した' })], {
        stamp: new Date(Date.UTC(2027, 0, 1)),
        zone: TOKYO,
      }).text,
    );
    const uidOf = (l: string[]): string => l.find((x) => x.startsWith('UID:'))!;
    expect(uidOf(a)).toBe(uidOf(b));
    expect(uidOf(a)).toBe('UID:pkc3-n1-L3@pkc3');
  });
  it('lid か行が違えば UID は違う / ノート丸ごとの予定は note / 変な字は _ に畳む', () => {
    const ids = new Set([
      icsUid({ lid: 'n1', line: 3 }),
      icsUid({ lid: 'n1', line: 4 }),
      icsUid({ lid: 'n2', line: 3 }),
      icsUid({ lid: 'n1', line: null }),
    ]);
    expect(ids.size).toBe(4);
    expect(icsUid({ lid: 'a b:c', line: null })).toBe('pkc3-a_b_c-note@pkc3');
  });
  it('DTSTAMP は渡した時刻の UTC', () => {
    expect(lines([item()])).toContain('DTSTAMP:20261011T030405Z');
  });
});

describe('終日と期間', () => {
  it('🔴 終日は VALUE=DATE で、DTEND は +1 日(排他)', () => {
    const l = lines([item()]);
    expect(l).toContain('DTSTART;VALUE=DATE:20260825');
    expect(l).toContain('DTEND;VALUE=DATE:20260826');
  });
  it('+1 日は月末・年末をまたぐ', () => {
    expect(lines([item({ date: '2026-12-31' })])).toContain('DTEND;VALUE=DATE:20270101');
    expect(lines([item({ date: '2028-02-28' })])).toContain('DTEND;VALUE=DATE:20280229');
  });
  it('期間(..)は最後の日の翌日が DTEND', () => {
    const l = lines([item({ date: '2026-08-25', until: '2026-08-28' })]);
    expect(l).toContain('DTSTART;VALUE=DATE:20260825');
    expect(l).toContain('DTEND;VALUE=DATE:20260829');
  });
});

describe('時刻つき ── 時刻帯', () => {
  it('🔴 Asia/Tokyo: TZID つきで書き、VTIMEZONE を同梱する(浮動時刻にしない)', () => {
    const l = lines([item({ time: '14:00', timeEnd: '15:30' })]);
    expect(l).toContain('DTSTART;TZID=Asia/Tokyo:20260825T140000');
    expect(l).toContain('DTEND;TZID=Asia/Tokyo:20260825T153000');
    const i = l.indexOf('BEGIN:VTIMEZONE');
    expect(i).toBeGreaterThan(-1);
    expect(l.indexOf('TZID:Asia/Tokyo')).toBe(i + 1);
    expect(l.slice(i, l.indexOf('END:VTIMEZONE') + 1)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Tokyo',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0900',
      'TZOFFSETTO:+0900',
      'TZNAME:JST',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]);
    // 使う前に定義されている(最初の VEVENT より前)
    expect(l.indexOf('END:VTIMEZONE')).toBeLessThan(l.indexOf('BEGIN:VEVENT'));
    // 浮動時刻(Z も TZID も無い)の DTSTART は 1 本も無い
    // (VTIMEZONE 自身の DTSTART は浮動でよい ── 見るのは予定の中だけ)
    for (const x of l.slice(l.indexOf('BEGIN:VEVENT')).filter((y) => y.startsWith('DTSTART')))
      expect(x).toMatch(/TZID=|VALUE=DATE|Z$/);
  });
  it('🔴 終わりが 24:00(目盛りで下端まで引いた予定)は、翌日の 00:00 を DTEND にする(#1087)', () => {
    // 直す前は 24 時を読めない時刻として DTEND を黙って落とし、長さ 0 の予定として渡していた
    const l = lines([item({ date: '2026-08-31', time: '22:00', timeEnd: '24:00' })]);
    expect(l).toContain('DTSTART;TZID=Asia/Tokyo:20260831T220000');
    expect(l, '月末の翌日へ繰り上がっていない').toContain('DTEND;TZID=Asia/Tokyo:20260901T000000');
    // UTC で書くときも同じ(+05:30 の 22:00 → 16:30Z、24:00 → 翌日 18:30Z)
    const u = lines([item({ date: '2026-08-31', time: '22:00', timeEnd: '24:00' })], UTC_PLUS_530);
    expect(u).toContain('DTEND:20260831T183000Z');
  });

  it('時刻の幅が無ければ DTEND は書かない', () => {
    expect(lines([item({ time: '14:00' })]).some((x) => x.startsWith('DTEND'))).toBe(false);
  });
  it('終日だけなら VTIMEZONE は付けない', () => {
    expect(ics([item()])).not.toContain('VTIMEZONE');
  });
  it('🔴 東京以外: 端末との差で UTC(Z)に直す。浮動時刻も TZID も使わない', () => {
    const t = ics([item({ time: '14:00', timeEnd: '15:00' })], UTC_PLUS_530);
    const l = unfold(t);
    // 14:00(+05:30) = 08:30Z
    expect(l).toContain('DTSTART:20260825T083000Z');
    expect(l).toContain('DTEND:20260825T093000Z');
    expect(t).not.toContain('VTIMEZONE');
    expect(t).not.toContain('TZID');
  });
  it('UTC 化は日をまたぐ(00:30 +09:00 → 前日 15:30Z)', () => {
    expect(lines([item({ time: '00:30' })])).toContain('DTSTART;TZID=Asia/Tokyo:20260825T003000');
    const z: IcsZone = { kind: 'utc', offsetMinutes: () => 540 };
    expect(lines([item({ time: '00:30' })], z)).toContain('DTSTART:20260824T153000Z');
  });
  it('resolveIcsZone: Asia/Tokyo だけ VTIMEZONE 側', () => {
    const off = (): number => 0;
    expect(resolveIcsZone('Asia/Tokyo', off).kind).toBe('tokyo');
    expect(resolveIcsZone('America/New_York', off).kind).toBe('utc');
    expect(resolveIcsZone(undefined, off).kind).toBe('utc');
  });
});

describe('繰り返し(RRULE)', () => {
  const rule = (unit: RepeatUnit, over: Partial<AgendaItem> = {}, zone: IcsZone = TOKYO): string =>
    lines([item({ repeat: unit, ...over })], zone).find((x) => x.startsWith('RRULE:'))!;

  it('🔴 毎日 / 毎週 / 隔週(INTERVAL=2)/ 毎月 / 毎年', () => {
    expect(rule('day')).toBe('RRULE:FREQ=DAILY');
    expect(rule('week')).toBe('RRULE:FREQ=WEEKLY');
    expect(rule('biweek')).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2');
    expect(rule('month')).toBe('RRULE:FREQ=MONTHLY');
    expect(rule('year')).toBe('RRULE:FREQ=YEARLY');
  });
  it('🔴 曜日の列は BYDAY', () => {
    // 2026-08-24 は月曜
    expect(rule('days:135', { date: '2026-08-24' })).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(rule('days:67', { date: '2026-08-22' })).toBe('RRULE:FREQ=WEEKLY;BYDAY=SA,SU');
  });
  it('🔴 曜日の列で開始日が列に無い曜日なら、始まりを最初に当たる日へ寄せる(本文に無い日を出さない)', () => {
    // 2026-08-25 は火曜 → 月水金なら 8/26(水)が最初
    const l = lines([item({ repeat: 'days:135', date: '2026-08-25' })]);
    expect(l).toContain('DTSTART;VALUE=DATE:20260826');
    expect(l).toContain('DTEND;VALUE=DATE:20260827');
  });
  it('曜日の列で終わりまでに当たる日が無ければ書かない(skipped に数える)', () => {
    const r = buildIcs([item({ repeat: 'days:135', date: '2026-08-25', until: '2026-08-25' })], {
      stamp: STAMP,
      zone: TOKYO,
    });
    expect(r.count).toBe(0);
    expect(r.skipped).toBe(1);
  });
  it('🔴 終わり(..)の UNTIL: 時刻つきは UTC の Z(東京 10:00 → 同日 01:00Z)', () => {
    expect(rule('week', { time: '10:00', until: '2026-12-31' })).toBe(
      'RRULE:FREQ=WEEKLY;UNTIL=20261231T010000Z',
    );
    // 東京以外でも UTC(+05:30: 10:00 → 04:30Z)
    expect(rule('week', { time: '10:00', until: '2026-12-31' }, UTC_PLUS_530)).toBe(
      'RRULE:FREQ=WEEKLY;UNTIL=20261231T043000Z',
    );
  });
  it('UNTIL: 終日は DATE(DTSTART が日付のとき UNTIL も日付 ── RFC 5545 §3.3.10)。DTEND は 1 回ぶんの翌日', () => {
    const l = lines([item({ repeat: 'week', until: '2026-12-31' })]);
    expect(l).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261231');
    expect(l).toContain('DTEND;VALUE=DATE:20260826');
  });
  it('終わりが無ければ UNTIL は付けない / 繰り返しでなければ RRULE が無い', () => {
    expect(rule('week')).not.toContain('UNTIL');
    expect(lines([item()]).some((x) => x.startsWith('RRULE'))).toBe(false);
  });
  it('時刻つきの繰り返しの DTEND は開始と同じ日(幅)', () => {
    const l = lines([item({ repeat: 'day', time: '09:00', timeEnd: '10:00', until: '2026-09-01' })]);
    expect(l).toContain('DTEND;TZID=Asia/Tokyo:20260825T100000');
  });
});

describe('例外日(EXDATE)', () => {
  const key = 'n1\n見積を送る';
  it('🔴 済んだ回は DTSTART と同じ書き方(TZID と時刻)で外す', () => {
    const skip = new Map([[key, new Set(['2026-09-01', '2026-09-08'])]]);
    const l = lines([item({ repeat: 'week', time: '10:00' })], TOKYO, { skip });
    expect(l).toContain('EXDATE;TZID=Asia/Tokyo:20260901T100000,20260908T100000');
    const u = lines([item({ repeat: 'week', time: '10:00' })], UTC_PLUS_530, { skip });
    expect(u).toContain('EXDATE:20260901T043000Z,20260908T043000Z');
  });
  it('終日は VALUE=DATE。開始より前・終わりより後の日は出さない', () => {
    const skip = new Map([[key, new Set(['2026-08-01', '2026-09-01', '2027-01-01'])]]);
    const l = lines([item({ repeat: 'week', until: '2026-12-31' })], TOKYO, { skip });
    expect(l).toContain('EXDATE;VALUE=DATE:20260901');
  });
  it('字の違う別の予定の済みは混ざらない / 繰り返しでない予定には付けない', () => {
    const skip = new Map([['n1\n別の字', new Set(['2026-09-01'])]]);
    expect(lines([item({ repeat: 'week' })], TOKYO, { skip }).some((x) => x.startsWith('EXDATE'))).toBe(false);
    const own = new Map([[key, new Set(['2026-09-01'])]]);
    expect(lines([item()], TOKYO, { skip: own }).some((x) => x.startsWith('EXDATE'))).toBe(false);
  });
});

describe('何を書くか', () => {
  it('日付のない予定は書かない(数にも skipped にも入らない)', () => {
    const r = buildIcs([item({ date: null })], { stamp: STAMP, zone: TOKYO });
    expect(r.count).toBe(0);
    expect(r.skipped).toBe(0);
  });
  it('🔴 実在しない日・読めない時刻(25:99)は書かず skipped に数える(終日に化けさせない)。壊れた時刻の幅は幅だけ捨てる', () => {
    const r = buildIcs(
      [
        item({ date: '2026-02-30' }),
        item({ line: 5, time: '25:99' }),
        item({ line: 6, time: '10:00', timeEnd: '09:00' }),
      ],
      { stamp: STAMP, zone: TOKYO },
    );
    expect(r.skipped).toBe(2);
    expect(r.count).toBe(1);
    const l = unfold(r.text);
    expect(l.filter((x) => x.startsWith('DTEND;TZID')).length).toBe(0);
    expect(l.some((x) => x === 'DTSTART;VALUE=DATE:20260825')).toBe(false);
    expect(l).toContain('DTSTART;TZID=Asia/Tokyo:20260825T100000');
  });
  it('時刻の幅: 開始と同じ時刻(14:00..14:00)は DTEND を書き、終わりが前なら書かない', () => {
    expect(lines([item({ time: '14:00', timeEnd: '14:00' })])).toContain('DTEND;TZID=Asia/Tokyo:20260825T140000');
    expect(lines([item({ time: '14:00', timeEnd: '13:59' })]).some((x) => x.startsWith('DTEND'))).toBe(false);
  });
  it('複数の予定: VEVENT は BEGIN / END が揃う', () => {
    const r = buildIcs([item(), item({ line: 4 }), item({ line: null, lid: 'n2', text: 'ノート丸ごと' })], {
      stamp: STAMP,
      zone: TOKYO,
    });
    const l = unfold(r.text);
    expect(r.count).toBe(3);
    expect(l.filter((x) => x === 'BEGIN:VEVENT').length).toBe(3);
    expect(l.filter((x) => x === 'END:VEVENT').length).toBe(3);
  });
  it('行の予定にだけ載っているノートの題名を添える(ノート丸ごとの予定は題名が SUMMARY なので添えない)', () => {
    const noteTitle = (lid: string): string => (lid === 'n1' ? '週次' : 'ほか');
    const l = lines([item(), item({ line: null, lid: 'n2', text: '出張' })], TOKYO, { noteTitle });
    expect(l).toContain('SUMMARY:見積を送る');
    expect(l).toContain('DESCRIPTION:ノート: 週次');
    expect(l.filter((x) => x.startsWith('DESCRIPTION')).length).toBe(1);
  });
  it('空の字は (題名なし)', () => {
    expect(lines([item({ text: '  ' })])).toContain('SUMMARY:(題名なし)');
  });
  it('枠: VERSION / PRODID / CALSCALE。METHOD は書かない(ファイルで渡す)', () => {
    const l = lines([item()]);
    expect(l.slice(0, 4)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PKC3//Schedule//JA',
      'CALSCALE:GREGORIAN',
    ]);
    expect(l.some((x) => x.startsWith('METHOD'))).toBe(false);
  });
});

describe('🔴 UTC に直すと日付が動くとき、曜日の列(BYDAY)も同じだけ動かす', () => {
  const SEOUL: IcsZone = { kind: 'utc', offsetMinutes: () => 540 };
  const LA: IcsZone = { kind: 'utc', offsetMinutes: () => -420 };
  const get = (zone: IcsZone, over: Partial<AgendaItem>): string[] =>
    lines([item({ repeat: 'days:13', ...over })], zone);

  it('+09:00 の朝 07:00 は前日 22:00Z ── 月水は UTC では日・火', () => {
    // 2026-08-24 は月曜
    const l = get(SEOUL, { date: '2026-08-24', time: '07:00' });
    expect(l).toContain('DTSTART:20260823T220000Z');
    expect(l).toContain('RRULE:FREQ=WEEKLY;BYDAY=SU,TU');
  });
  it('-07:00 の夜 20:00 は翌日 03:00Z ── 月水は UTC では火・木', () => {
    const l = get(LA, { date: '2026-08-24', time: '20:00' });
    expect(l).toContain('DTSTART:20260825T030000Z');
    expect(l).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU,TH');
  });
  it('日曜(7)は +1 で月曜へ、月曜(1)は -1 で日曜へ(週をまたぐ)', () => {
    expect(get(LA, { repeat: 'days:67', date: '2026-08-22', time: '20:00' })).toContain(
      'RRULE:FREQ=WEEKLY;BYDAY=SU,MO',
    );
    expect(get(SEOUL, { repeat: 'days:17', date: '2026-08-24', time: '07:00' })).toContain(
      'RRULE:FREQ=WEEKLY;BYDAY=SU,SA',
    );
  });
  it('日付が動かない時刻(正午)や Tokyo は BYDAY をそのまま', () => {
    expect(get(SEOUL, { date: '2026-08-24', time: '12:00' })).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE');
    expect(get(TOKYO, { date: '2026-08-24', time: '07:00' })).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE');
  });
});

describe('例外日と夏時間の差', () => {
  it('🔴 EXDATE は DTSTART と同じ差で書く(その日の差で書くと、規則が作る回と 1 時間ずれて外れない)', () => {
    // 3/29 から夏時間(+120)、それまでは +60 の想定。開始は冬(+60)
    const dst: IcsZone = { kind: 'utc', offsetMinutes: (d) => (d >= '2026-03-29' ? 120 : 60) };
    const skip = new Map([['n1\n見積を送る', new Set(['2026-04-05'])]]);
    const l = lines([item({ date: '2026-03-01', time: '10:00', repeat: 'week' })], dst, { skip });
    expect(l).toContain('DTSTART:20260301T090000Z');
    expect(l).toContain('EXDATE:20260405T090000Z');
  });
  it('UNTIL も開始の差で書く', () => {
    const dst: IcsZone = { kind: 'utc', offsetMinutes: (d) => (d >= '2026-03-29' ? 120 : 60) };
    const l = lines([item({ date: '2026-03-01', time: '10:00', repeat: 'week', until: '2026-06-01' })], dst);
    expect(l).toContain('RRULE:FREQ=WEEKLY;UNTIL=20260601T090000Z');
  });
});

describe('終わりの日が暦に無いとき(clampUntil)', () => {
  it('その月の末日に寄せる / 月が 13 以上はその年の末日 / 日が 00 は前の月の末日 / 読めなければ null', () => {
    expect(clampUntil('2026-02-30')).toBe('2026-02-28');
    expect(clampUntil('2028-02-31')).toBe('2028-02-29');
    expect(clampUntil('2026-04-31')).toBe('2026-04-30');
    expect(clampUntil('2026-13-05')).toBe('2026-12-31');
    expect(clampUntil('2026-03-00')).toBe('2026-02-28');
    expect(clampUntil('2026-00-10')).toBeNull();
    expect(clampUntil('2026-02-14')).toBe('2026-02-14');
  });
  it('🔴 アプリの展開(expandRepeat)が最後に出す日と同じ日で止まる', () => {
    for (const until of ['2026-02-30', '2026-04-31', '2026-13-05']) {
      const days = expandRepeat({ anchor: '2026-01-01', unit: 'day', until, from: '2026-01-01', to: '2027-12-31', max: 1000 }).days;
      expect(days[days.length - 1], until).toBe(clampUntil(until));
    }
  });
  it('繰り返しの UNTIL と期間の DTEND に効く(無制限の繰り返しにならない)', () => {
    expect(lines([item({ date: '2026-02-01', repeat: 'week', until: '2026-02-30' })])).toContain(
      'RRULE:FREQ=WEEKLY;UNTIL=20260228',
    );
    const r = lines([item({ date: '2026-02-26', until: '2026-02-30' })]);
    expect(r).toContain('DTEND;VALUE=DATE:20260301');
  });
  it('寄せても開始より前なら書かず skipped に数える', () => {
    const r = buildIcs([item({ date: '2026-03-02', repeat: 'week', until: '2026-03-00' })], {
      stamp: STAMP,
      zone: TOKYO,
    });
    expect(r.count).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

describe('月末の寄せ(29〜31 日の毎月 / 2/29 の毎年)', () => {
  const rule = (date: string, unit: RepeatUnit, zone: IcsZone = TOKYO, time: string | null = null): string =>
    lines([item({ date, repeat: unit, time })], zone).find((x) => x.startsWith('RRULE:'))!;
  it('🔴 日が 29 以上の毎月は 28..日 の中で最も大きい実在の日', () => {
    expect(rule('2026-01-31', 'month')).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
    expect(rule('2026-01-30', 'month')).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1');
    expect(rule('2026-01-29', 'month')).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29;BYSETPOS=-1');
    expect(rule('2026-01-28', 'month')).toBe('RRULE:FREQ=MONTHLY');
  });
  it('🔴 その規則が選ぶ日は、アプリの occurrenceAt と 24 か月ぶん一致する', () => {
    for (const d of [29, 30, 31]) {
      const anchor = `2027-01-${d}`;
      const set = Array.from({ length: d - 27 }, (_, i) => 28 + i);
      for (let n = 0; n < 24; n += 1) {
        const app = occurrenceAt(anchor, 'month', n)!;
        const [y, m] = [Number(app.slice(0, 4)), Number(app.slice(5, 7))];
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const rrule = Math.max(...set.filter((x) => x <= last));
        expect(Number(app.slice(8, 10)), `${anchor} +${n}`).toBe(rrule);
      }
    }
  });
  it('2/29 の毎年は 2/28 か 2/29 の大きいほう。2/28 の毎年は素のまま', () => {
    expect(rule('2028-02-29', 'year')).toBe('RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1');
    expect(rule('2028-02-28', 'year')).toBe('RRULE:FREQ=YEARLY');
    expect(rule('2028-03-29', 'year')).toBe('RRULE:FREQ=YEARLY');
  });
  it('UTC で日付が動く時刻のとき(#1087 で変更)は、UTC の日で回さず浮動時刻で書き、月末の寄せも書く', () => {
    // 動いた事実:直す前は UTC の DTSTART(前日 22:00Z)に素の `FREQ=MONTHLY` を付けていて、
    //   「毎月 31 日」が「毎月 UTC の 30 日」になっていた
    const seoul: IcsZone = { kind: 'utc', offsetMinutes: () => 540 };
    expect(rule('2026-01-31', 'month', seoul, '07:00')).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
    const l = lines([item({ date: '2026-01-31', time: '07:00', repeat: 'month' })], seoul);
    expect(l).toContain('DTSTART:20260131T070000');
  });
});
