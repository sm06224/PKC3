/**
 * 🔴 `.ics` の取り込み(#855 段 D の読み側)を 1 つずつ pin する。
 *
 * ⚠ 入力はこの file が**手で組んだ文字列**(書き出し側 `buildIcs` の出力を期待値に流用しない)。
 *   往復の test だけが `buildIcs` を通す ── 書き出し側の対(逆写像)であることを見るため。
 * ⚠ 端末の時刻帯は毎回 `localZone` で渡す(実行する機械の時刻帯で結果が変わらないように)。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ICS_IMPORT_MAX_BYTES,
  icsCountNotes,
  icsNoteBody,
  icsNoteTitle,
  isIcsFileName,
  parseIcs,
  unescapeText,
  WINDOWS_ZONES,
  unfoldIcs,
  type IcsEvent,
} from '@features/schedule/ics-import';
import { buildIcs, type IcsZone } from '@features/schedule/ics';
import type { AgendaItem } from '@features/schedule/agenda';
import { taskCardsOf } from '@features/schedule/task-cards';

const TOKYO = 'Asia/Tokyo';

function cal(...events: string[][]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
}
function one(props: string[], zone = TOKYO) {
  return parseIcs(cal(props), { localZone: zone });
}
function first(props: string[], zone = TOKYO): IcsEvent {
  const r = one(props, zone);
  expect(r.events).toHaveLength(1);
  return r.events[0]!;
}

describe('折り返しとエスケープ', () => {
  it('🔴 CRLF / LF / CR のどれでも、空白・タブで始まる行を前の行へ繋ぐ(先頭の 1 字だけ捨てる)', () => {
    for (const nl of ['\r\n', '\n', '\r']) {
      expect(unfoldIcs(`SUMMARY:ab${nl} cd${nl}\tef${nl}X:1`)).toEqual(['SUMMARY:abcdef', 'X:1']);
    }
    // 2 字目以降の空白は中身
    expect(unfoldIcs('A:x\r\n  y')).toEqual(['A:x y']);
  });

  it('🔴 日本語を 75 バイトで折った書き出し(字の途中では折らない)を、題名に戻せる', () => {
    const summary = '見積書を作成して取引先に送付する'.repeat(5);
    const items: AgendaItem[] = [
      {
        key: 'k', lid: 'n1', line: 1, text: summary, done: false,
        date: '2026-08-25', time: null, timeEnd: null, until: null, repeat: null,
      },
    ];
    const t = buildIcs(items, { stamp: new Date(0), zone: { kind: 'tokyo' } }).text;
    expect(t.includes('\r\n ')).toBe(true); // 折れていること(空振り防止)
    expect(parseIcs(t, { localZone: TOKYO }).events[0]!.summary).toBe(summary);
  });

  it('エスケープ(\\n \\, \\; \\\\)を戻す。題名の改行は空白に畳む(記法を差し込ませない)', () => {
    expect(unescapeText('a\\,b\\;c\\\\d\\ne\\Nf')).toBe('a,b;c\\d\ne\nf');
    const e = first(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:一行目\\n- [ ] @2026-01-01 二行目\\, 三']);
    expect(e.summary).toBe('一行目 - [ ] @2026-01-01 二行目, 三');
    expect(icsNoteBody([e]).split('\n').filter((l) => l.startsWith('- [ ]'))).toHaveLength(1);
  });

  it('引用符の中の : ; を壊さない(パラメータ値)', () => {
    const e = first(['DTSTART;TZID="Asia/Tokyo";X-A="a;b:c":20260825T100000', 'SUMMARY:q']);
    expect(e.time).toBe('10:00');
  });

  it('BOM つきでも読める', () => {
    const r = parseIcs('\uFEFF' + cal(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:bom']), { localZone: TOKYO });
    expect(r.events).toHaveLength(1);
  });
});

describe('日付・時刻・時刻帯', () => {
  it('終日:DTEND は排他。1 日だけなら単日、複数日なら 1 日引いた日までの期間', () => {
    expect(first(['DTSTART;VALUE=DATE:20260825', 'DTEND;VALUE=DATE:20260826', 'SUMMARY:a'])).toMatchObject({
      date: '2026-08-25', until: null, time: null,
    });
    expect(first(['DTSTART;VALUE=DATE:20260825', 'DTEND;VALUE=DATE:20260828', 'SUMMARY:a'])).toMatchObject({
      date: '2026-08-25', until: '2026-08-27',
    });
    // DTEND なし
    expect(first(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:a']).until).toBeNull();
    // 月をまたぐ
    expect(first(['DTSTART;VALUE=DATE:20260830', 'DTEND;VALUE=DATE:20260902', 'SUMMARY:a']).until).toBe('2026-09-01');
    // DURATION
    expect(first(['DTSTART;VALUE=DATE:20260825', 'DURATION:P3D', 'SUMMARY:a']).until).toBe('2026-08-27');
  });

  it('UTC(Z)を端末の壁時計へ:東京なら +9、日付も繰り上がる', () => {
    expect(first(['DTSTART:20260825T050000Z', 'DTEND:20260825T060000Z', 'SUMMARY:a'])).toMatchObject({
      date: '2026-08-25', time: '14:00', timeEnd: '15:00',
    });
    expect(first(['DTSTART:20260825T160000Z', 'SUMMARY:a'])).toMatchObject({ date: '2026-08-26', time: '01:00' });
  });

  it('TZID:東京・ニューヨーク(夏時間)・端末と同じ時刻帯はそのまま', () => {
    expect(first(['DTSTART;TZID=Asia/Tokyo:20260825T140000', 'SUMMARY:a'])).toMatchObject({ date: '2026-08-25', time: '14:00' });
    // NY 10:00 EDT(UTC-4)= 東京 23:00
    expect(first(['DTSTART;TZID=America/New_York:20260825T100000', 'SUMMARY:a'])).toMatchObject({ date: '2026-08-25', time: '23:00' });
    // 冬は UTC-5 = 東京 翌日 00:00
    expect(first(['DTSTART;TZID=America/New_York:20261225T100000', 'SUMMARY:a'])).toMatchObject({ date: '2026-12-26', time: '00:00' });
    // 端末がニューヨークのとき、東京 14:00 → 前日 01:00(夏)
    expect(first(['DTSTART;TZID=Asia/Tokyo:20260825T140000', 'SUMMARY:a'], 'America/New_York')).toMatchObject({
      date: '2026-08-25', time: '01:00',
    });
    // Windows の名前(Outlook)
    expect(first(['DTSTART;TZID=Tokyo Standard Time:20260825T140000', 'SUMMARY:a'], 'Asia/Kolkata')).toMatchObject({
      date: '2026-08-25', time: '10:30',
    });
  });

  it('知らない TZID:書かれた時刻のまま入れ、数える', () => {
    const r = one(['DTSTART;TZID=Mars/Olympus:20260825T140000', 'SUMMARY:a']);
    expect(r.events[0]).toMatchObject({ date: '2026-08-25', time: '14:00' });
    expect(r.counts.zoneUnknown).toBe(1);
    // 浮動(時刻帯なし)は数えない
    expect(one(['DTSTART:20260825T140000', 'SUMMARY:a']).counts.zoneUnknown).toBe(0);
  });

  it('時刻の幅:同じ日の終わりだけ。長さ 0・逆順は幅にしない。日をまたぐなら開始だけ入れて数える', () => {
    expect(first(['DTSTART:20260825T050000Z', 'DTEND:20260825T050000Z', 'SUMMARY:a']).timeEnd).toBeNull();
    expect(first(['DTSTART:20260825T050000Z', 'DTEND:20260825T040000Z', 'SUMMARY:a']).timeEnd).toBeNull();
    const r = one(['DTSTART:20260825T050000Z', 'DTEND:20260826T050000Z', 'SUMMARY:a']);
    expect(r.events[0]).toMatchObject({ time: '14:00', timeEnd: null });
    expect(r.counts.spansDays).toBe(1);
    expect(first(['DTSTART:20260825T050000Z', 'DURATION:PT1H30M', 'SUMMARY:a']).timeEnd).toBe('15:30');
  });

  it('VALARM の中の行を予定の物にしない(TRIGGER / SUMMARY / DESCRIPTION)', () => {
    const e = first([
      'DTSTART;VALUE=DATE:20260825', 'SUMMARY:本物', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'SUMMARY:偽', 'DESCRIPTION:偽の説明',
      'TRIGGER:-PT10M', 'END:VALARM', 'LOCATION:会議室',
    ]);
    expect(e).toMatchObject({ summary: '本物', location: '会議室', description: '' });
  });
});

describe('繰り返し', () => {
  const allDay = (rrule: string, start = '20260831', extra: string[] = []) =>
    one([`DTSTART;VALUE=DATE:${start}`, `RRULE:${rrule}`, 'SUMMARY:r', ...extra]);

  it('毎日 / 毎週 / 毎月 / 毎年 / 隔週', () => {
    expect(allDay('FREQ=DAILY').events[0]!.repeat).toBe('day');
    expect(allDay('FREQ=WEEKLY').events[0]!.repeat).toBe('week');
    expect(allDay('FREQ=MONTHLY', '20260815').events[0]!.repeat).toBe('month');
    expect(allDay('FREQ=YEARLY', '20260815').events[0]!.repeat).toBe('year');
    expect(allDay('FREQ=WEEKLY;INTERVAL=2').events[0]!.repeat).toBe('biweek');
    // Google が付ける冗長な形
    expect(allDay('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO').events[0]!.repeat).toBe('biweek'); // 8/31 は月曜
    expect(allDay('FREQ=WEEKLY;BYDAY=MO').events[0]!.repeat).toBe('week');
    expect(allDay('FREQ=MONTHLY;BYMONTHDAY=15', '20260815').events[0]!.repeat).toBe('month');
    expect(allDay('FREQ=DAILY;INTERVAL=1;WKST=SU').events[0]!.repeat).toBe('day');
  });

  it('曜日の列:月水金。開始日がその列に無ければ言えない', () => {
    expect(allDay('FREQ=WEEKLY;BYDAY=FR,MO,WE').events[0]!.repeat).toBe('days:135');
    const r = allDay('FREQ=WEEKLY;BYDAY=TU,TH'); // 8/31 は月曜
    expect(r.events[0]!.repeat).toBeNull();
    expect(r.counts.repeatUnread).toBe(1);
  });

  it('UNTIL → 終わりの日(終日は DATE、Z は端末の日付に直す)', () => {
    expect(allDay('FREQ=WEEKLY;UNTIL=20261231').events[0]).toMatchObject({ repeat: 'week', until: '2026-12-31' });
    expect(allDay('FREQ=WEEKLY;UNTIL=20261231T150000Z').events[0]!.until).toBe('2027-01-01'); // 東京で翌日 0 時
  });

  it('書き出しの月末の形(BYMONTHDAY=28..31;BYSETPOS=-1)と 2/29 の形を読む', () => {
    expect(allDay('FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1', '20260131').events[0]!.repeat).toBe('month');
    expect(allDay('FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1', '20260130').events[0]!.repeat).toBe('month');
    expect(allDay('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1', '20240229').events[0]!.repeat).toBe('year');
    // 開始日と合わない月末の形は言えない
    expect(allDay('FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1', '20260115').counts.repeatUnread).toBe(1);
  });

  it('🔴 言えない形は 1 回目だけ入れ、繰り返しを読めなかった数に数える(予定は落とさない)', () => {
    const cases = [
      'FREQ=DAILY;COUNT=5',
      'FREQ=DAILY;INTERVAL=3',
      'FREQ=WEEKLY;INTERVAL=3',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=MONTHLY;BYMONTHDAY=1,15',
      'FREQ=MONTHLY;BYMONTHDAY=-1',
      'FREQ=MONTHLY;BYSETPOS=2;BYDAY=TU',
      'FREQ=YEARLY;INTERVAL=2',
      'FREQ=HOURLY',
      'FREQ=SECONDLY',
      'FREQ=DAILY;BYHOUR=9',
      'FREQ=WEEKLY;BYDAY=1MO,3MO',
      'NOT A RULE',
      'FREQ=WEEKLY;UNTIL=20200101', // 開始より前
    ];
    for (const rule of cases) {
      const r = allDay(rule);
      expect(r.events, rule).toHaveLength(1);
      expect(r.events[0], rule).toMatchObject({ repeat: null, until: null, date: '2026-08-31' });
      expect(r.counts.repeatUnread, rule).toBe(1);
    }
    // EXDATE / RDATE があれば規則が読めても言えない(除外・追加を黙って捨てない)
    for (const extra of ['EXDATE;VALUE=DATE:20260907', 'RDATE;VALUE=DATE:20260905']) {
      const r = allDay('FREQ=WEEKLY', '20260831', [extra]);
      expect(r.events[0]!.repeat, extra).toBeNull();
      expect(r.counts.repeatUnread, extra).toBe(1);
    }
  });

  it('月の 29〜31 日・閏日は、無い月の扱いが RFC と違うので言えない', () => {
    expect(allDay('FREQ=MONTHLY', '20260131').counts.repeatUnread).toBe(1);
    expect(allDay('FREQ=MONTHLY;BYMONTHDAY=31', '20260131').counts.repeatUnread).toBe(1);
    expect(allDay('FREQ=YEARLY', '20240229').counts.repeatUnread).toBe(1);
  });

  it('時刻つきの繰り返し:UNTIL は言えない(1 回目だけ)。UNTIL なしは言える', () => {
    const t = (rule: string) => one(['DTSTART;TZID=Asia/Tokyo:20260831T140000', `RRULE:${rule}`, 'SUMMARY:m']);
    expect(t('FREQ=WEEKLY').events[0]).toMatchObject({ repeat: 'week', time: '14:00' });
    const u = t('FREQ=WEEKLY;UNTIL=20261231T050000Z');
    expect(u.events[0]).toMatchObject({ repeat: null, until: null });
    expect(u.counts.repeatUnread).toBe(1);
  });

  it('終日の期間と繰り返しの併用は言えない(期間の ..  は繰り返しの終わりと兼ねる)', () => {
    const r = one(['DTSTART;VALUE=DATE:20260831', 'DTEND;VALUE=DATE:20260902', 'RRULE:FREQ=WEEKLY', 'SUMMARY:x']);
    expect(r.events[0]).toMatchObject({ date: '2026-08-31', until: '2026-09-01', repeat: null });
    expect(r.counts.repeatUnread).toBe(1);
  });

  it('時刻帯をまたいで日付が動くとき、曜日の列も同じ日数ずらす', () => {
    // UTC の日曜 20:30 = 東京の月曜 05:30。SU,TU,TH(UTC)= 月,水,金(東京)
    const e = first(['DTSTART:20260830T203000Z', 'RRULE:FREQ=WEEKLY;BYDAY=SU,TU,TH', 'SUMMARY:w']);
    expect(e).toMatchObject({ date: '2026-08-31', time: '05:30', repeat: 'days:135' });
  });
});

describe('取り消し・壊れた入力', () => {
  it('STATUS:CANCELLED は入れず、数える', () => {
    const r = parseIcs(
      cal(
        ['DTSTART;VALUE=DATE:20260825', 'SUMMARY:消えた', 'STATUS:CANCELLED'],
        ['DTSTART;VALUE=DATE:20260826', 'SUMMARY:残る', 'STATUS:CONFIRMED'],
      ),
      { localZone: TOKYO },
    );
    expect(r.events.map((e) => e.summary)).toEqual(['残る']);
    expect(r.counts.cancelled).toBe(1);
  });

  it('日付を読めない・無い予定は入れず、数える。閉じていない VEVENT も数える', () => {
    const r = parseIcs(
      cal(['SUMMARY:日付なし'], ['DTSTART:garbage', 'SUMMARY:x'], ['DTSTART;VALUE=DATE:20260230', 'SUMMARY:実在しない日']),
      { localZone: TOKYO },
    );
    expect(r.events).toHaveLength(0);
    expect(r.counts.invalid).toBe(3);
    const cut = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260825\r\nSUMMARY:途中', { localZone: TOKYO });
    expect(cut.events).toHaveLength(0);
    expect(cut.counts.invalid).toBe(1);
  });

  it('予定ではない入力・空・バイナリのような文字列でも例外を投げず、0 件', () => {
    for (const s of ['', 'hello', '\u0000\u0001\u0002', 'BEGIN:VEVENT', 'END:VEVENT\r\nEND:VEVENT', ':::;;;', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR']) {
      expect(() => parseIcs(s, { localZone: TOKYO }), JSON.stringify(s)).not.toThrow();
      expect(parseIcs(s, { localZone: TOKYO }).events, JSON.stringify(s)).toHaveLength(0);
    }
  });

  it('題名が無ければ「(題名なし)」。繰り返しの 1 回だけの変更(RECURRENCE-ID)は別に入れて数える', () => {
    expect(first(['DTSTART;VALUE=DATE:20260825']).summary).toBe('(題名なし)');
    const r = one(['DTSTART;VALUE=DATE:20260825', 'RECURRENCE-ID;VALUE=DATE:20260825', 'SUMMARY:変更']);
    expect(r.events).toHaveLength(1);
    expect(r.counts.overrides).toBe(1);
  });
});

describe('ノートの本文', () => {
  const ev = (over: Partial<IcsEvent>): IcsEvent => ({
    date: '2026-08-25', time: null, timeEnd: null, until: null, repeat: null,
    summary: 's', location: '', description: '', ...over,
  });

  it('チェック項目の 1 行 + 場所・メモの補足行。補足はチェック項目ではない(札にならない)', () => {
    const body = icsNoteBody([
      ev({ time: '14:00', timeEnd: '15:00', summary: '定例', location: '会議室 A', description: 'ご持参ください' }),
    ]);
    expect(body).toBe('- [ ] @2026-08-25 14:00..15:00 定例\n  - 場所: 会議室 A\n  - メモ: ご持参ください\n');
    expect(taskCardsOf('n', body)).toHaveLength(1);
  });

  it('🔴 途中までにした予定は数えて言う(黙って切らない)', () => {
    const long = one(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:A', `DESCRIPTION:${'あ'.repeat(500)}`]);
    expect(long.counts.shortened).toBe(1);
    expect(icsCountNotes(long.counts).join('')).toContain('途中までを入れました');
    // 題名・場所の枝も 1 つずつ(片方の枝を消すと、もう片方が救わないように別の予定で見る)
    expect(one(['DTSTART;VALUE=DATE:20260825', `SUMMARY:${'い'.repeat(501)}`]).counts.shortened).toBe(1);
    expect(one(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:A', `LOCATION:${'う'.repeat(501)}`]).counts.shortened).toBe(1);
    // 境界:ちょうど上限は切らないので数えない
    expect(one(['DTSTART;VALUE=DATE:20260825', `SUMMARY:${'い'.repeat(500)}`]).counts.shortened).toBe(0);
    expect(one(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:A', `DESCRIPTION:${'え'.repeat(300)}`]).counts.shortened).toBe(0);
    expect(one(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:A', `DESCRIPTION:${'え'.repeat(301)}`]).counts.shortened).toBe(1);
    // 対照群:短い説明は数えない
    const short = one(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:A', 'DESCRIPTION:短い']);
    expect(short.counts.shortened).toBe(0);
    expect(icsCountNotes(short.counts).join('')).not.toContain('途中まで');
  });

  it('長いメモは 300 字で丸める', () => {
    const body = icsNoteBody([ev({ description: 'あ'.repeat(500) })]);
    expect(body).toContain(`  - メモ: ${'あ'.repeat(300)}…`);
  });

  it('🔴 題名が記法と食い違う読まれ方をするとき(終日なのに題名が時刻で始まる / 刻みの後に曜日)は「」で囲む', () => {
    const a = icsNoteBody([ev({ summary: '10:00 に集合' })]);
    expect(a).toBe('- [ ] @2026-08-25 「10:00 に集合」\n');
    const c = taskCardsOf('n', a)[0]!;
    expect(c).toMatchObject({ date: '2026-08-25', time: null });
    const b = icsNoteBody([ev({ repeat: 'week', summary: '月火の勉強会' })]);
    expect(taskCardsOf('n', b)[0]).toMatchObject({ repeat: 'week' });
  });

  it('🔴 題名の中の「振替2026-01-01」を行の振替と読んで題名から外さない(#1087)', () => {
    // 直す前: 読み戻しの突き合わせが振替を見ず、題名の「振替2026-01-01」が消えて「 の件」だけが残った
    const body = icsNoteBody([ev({ summary: '振替2026-01-01 の件' })]);
    expect(body).toBe('- [ ] @2026-08-25 「振替2026-01-01 の件」\n');
    const c = taskCardsOf('n', body)[0]!;
    expect(c.substitutes).toBeNull();
    expect(c.text).toContain('振替2026-01-01 の件');
    // 対照群: 振替でない題名は囲まない
    expect(icsNoteBody([ev({ summary: '振替の件' })])).toBe('- [ ] @2026-08-25 振替の件\n');
  });

  it('題名・拡張子', () => {
    expect(icsNoteTitle('work.ics')).toBe('取り込んだ予定 work.ics');
    for (const n of ['a.ics', 'A.ICS', 'a.ical', 'x.icalendar']) expect(isIcsFileName(n), n).toBe(true);
    for (const n of ['a.ics.txt', 'a.vcf', 'ics', 'a.md']) expect(isIcsFileName(n), n).toBe(false);
  });

  it('読めなかった数の文:0 の項目は言わない', () => {
    const z = { cancelled: 0, repeatUnread: 0, invalid: 0, zoneUnknown: 0, spansDays: 0, overrides: 0, zoneRepeat: 0, shortened: 0 };
    expect(icsCountNotes(z)).toEqual([]);
    expect(icsCountNotes({ ...z, repeatUnread: 2 })).toEqual(['2 件は繰り返しを読めず 1 回目だけ入れました']);
    expect(icsCountNotes({ ...z, cancelled: 1, invalid: 3 })).toHaveLength(2);
  });

  it('大きさの上限は 1 MB より大きい(普通のカレンダーを断らない)', () => {
    expect(ICS_IMPORT_MAX_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe('🔴 往復:書き出し(buildIcs)→ 取り込み → 予定の行を読み戻すと、元の予定と同じ', () => {
  const base: AgendaItem = {
    key: 'k', lid: 'n1', line: 1, text: '予定', done: false,
    date: '2026-08-31', time: null, timeEnd: null, until: null, repeat: null,
  };
  const cases: Partial<AgendaItem>[] = [
    {},
    { time: '14:00' },
    { time: '14:00', timeEnd: '15:30' },
    { until: '2026-09-02' },
    { repeat: 'day' },
    { repeat: 'week', until: '2026-12-28' },
    { repeat: 'biweek' },
    { repeat: 'biweek', until: '2026-12-28' },
    { repeat: 'month', date: '2026-08-15' },
    { repeat: 'month', date: '2026-01-31' }, // 月末の形
    { repeat: 'year', date: '2026-08-15', until: '2030-08-15' },
    { repeat: 'year', date: '2024-02-29' }, // 閏日の形
    { repeat: 'days:135' },
    { repeat: 'days:135', until: '2026-12-28' },
    { repeat: 'week', time: '14:00', timeEnd: '15:00' },
    { repeat: 'days:135', time: '09:30' },
    { repeat: 'month', date: '2026-08-15', time: '23:30' },
    { text: '会議, 資料; 持参\\' },
    { text: '見積書を作成して取引先に送付する'.repeat(5), time: '10:00' },
  ];
  const zones: { name: string; zone: IcsZone; tz: string }[] = [
    { name: '東京(VTIMEZONE)', zone: { kind: 'tokyo' }, tz: 'Asia/Tokyo' },
    // 東京以外:UTC に直して書く。端末は +05:30 固定のインド
    { name: 'インド(UTC に直す)', zone: { kind: 'utc', offsetMinutes: () => 330 }, tz: 'Asia/Kolkata' },
  ];

  for (const z of zones) {
    for (const c of cases) {
      const it0 = { ...base, ...c };
      it(`${z.name}: ${JSON.stringify(c).slice(0, 80)}`, () => {
        const out = buildIcs([it0], { stamp: new Date(0), zone: z.zone });
        expect(out.count).toBe(1);
        const parsed = parseIcs(out.text, { localZone: z.tz });
        expect(parsed.counts.repeatUnread).toBe(0);
        const body = icsNoteBody(parsed.events);
        const cards = taskCardsOf('n', body);
        expect(cards).toHaveLength(1);
        // 時刻つき + 終わり + 繰り返しは書き出しが UNTIL を UTC で書く = 取り込みは言えない形ではない(この表には無い)
        expect(cards[0]).toMatchObject({
          text: it0.text.replace(/[\r\n]+/g, ' '),
          date: it0.date,
          time: it0.time,
          timeEnd: it0.timeEnd,
          until: it0.until,
          repeat: it0.repeat,
        });
      });
    }
  }

  it('🔴 日付が UTC でずれる時刻(インド 02:00 = 前日 20:30Z)の曜日の列も往復する', () => {
    const it0 = { ...base, repeat: 'days:135' as const, time: '02:00' }; // 8/31(月)
    const out = buildIcs([it0], { stamp: new Date(0), zone: { kind: 'utc', offsetMinutes: () => 330 } });
    expect(out.text).toContain('BYDAY=SU,TU,TH'); // 書き出しが UTC の曜日にずらしていること(空振り防止)
    const cards = taskCardsOf('n', icsNoteBody(parseIcs(out.text, { localZone: 'Asia/Kolkata' }).events));
    expect(cards[0]).toMatchObject({ date: '2026-08-31', time: '02:00', repeat: 'days:135' });
  });
});

describe('🔴 壊れた・極端な入力でも parseIcs は投げない / 1 件が全体を落とさない', () => {
  const dateEv = (extra: string[]) => ['DTSTART;VALUE=DATE:20260825', 'SUMMARY:d', ...extra];

  it('巨大な DURATION は無視して単日(NaN の日付を作らない)', () => {
    const r = one(dateEv(['DURATION:P99999999999999999999D']));
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ date: '2026-08-25', until: null });
    expect(r.counts.invalid).toBe(0);
    // 桁は通るが 100 年を超える
    expect(first(dateEv(['DURATION:P100000000D'])).until).toBeNull();
    expect(first(dateEv(['DURATION:P36501D'])).until).toBeNull();
  });

  it('巨大な DURATION を時刻つきに付けても file ごと落ちない(RangeError)', () => {
    const r = parseIcs(
      cal(['DTSTART:20260825T100000', 'DURATION:P100000000D', 'SUMMARY:t'], ['DTSTART;VALUE=DATE:20260826', 'SUMMARY:次']),
      { localZone: TOKYO },
    );
    expect(r.events.map((e) => e.summary)).toEqual(['t', '次']);
    expect(r.events[0]!.timeEnd).toBeNull();
    expect(r.counts.invalid).toBe(0);
  });

  it('DURATION の枝: 終日 P1D=単日 / P2D=翌日まで / P1W=7 日 / 時刻つき PT0S=幅なし / P1W=日またぎ / 読めない字は無視', () => {
    expect(first(dateEv(['DURATION:P1D'])).until).toBeNull();
    expect(first(dateEv(['DURATION:P2D'])).until).toBe('2026-08-26');
    expect(first(dateEv(['DURATION:P1W'])).until).toBe('2026-08-31');
    expect(first(['DTSTART:20260825T100000', 'DURATION:PT0S', 'SUMMARY:t']).timeEnd).toBeNull();
    expect(first(['DTSTART:20260825T100000', 'DURATION:PT2H', 'SUMMARY:t']).timeEnd).toBe('12:00');
    const w = one(['DTSTART:20260825T100000', 'DURATION:P1W', 'SUMMARY:t']);
    expect(w.events[0]!.timeEnd).toBeNull();
    expect(w.counts.spansDays).toBe(1);
    expect(first(dateEv(['DURATION:garbage'])).until).toBeNull();
    expect(first(dateEv(['DURATION:P'])).until).toBeNull();
  });

  it('処理の途中で 1 件が例外になっても、その件だけ数えて先へ進む', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementationOnce(() => {
      throw new Error('注入');
    });
    try {
      const r = parseIcs(
        cal(
          ['DTSTART;TZID=America/New_York:20260825T100000', 'SUMMARY:落ちる'],
          ['DTSTART;VALUE=DATE:20260826', 'SUMMARY:残る'],
        ),
        { localZone: TOKYO },
      );
      expect(r.events.map((e) => e.summary)).toEqual(['残る']);
      expect(r.counts.invalid).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('年が 9999 の終日予定に DURATION を足して 5 桁の年になっても、壊れた日付を作らない', () => {
    const e = first(['DTSTART;VALUE=DATE:99991231', 'DURATION:P2D', 'SUMMARY:end']);
    expect(e.until, '5 桁の年の日付が入った').toBeNull();
    expect(e.date).toBe('9999-12-31');
  });

  it('例外になった件の数え(タイムゾーン不明など)は残さない', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementationOnce(() => {
      throw new Error('注入');
    });
    try {
      const r = one([
        'DTSTART;TZID=Mars/Olympus:20260825T100000',
        'DTEND;TZID=America/New_York:20260825T110000',
        'SUMMARY:x',
      ]);
      expect(r.events).toHaveLength(0);
      expect(r.counts.invalid).toBe(1);
      expect(r.counts.zoneUnknown, '落ちた件の数えが残っている').toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('閉じずに次の VEVENT が始まったら、前の予定は数えて捨て、次を読む', () => {
    const t = [
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260825', 'SUMMARY:A',
      'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260826', 'SUMMARY:B', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const r = parseIcs(t, { localZone: TOKYO });
    expect(r.events.map((e) => e.summary)).toEqual(['B']);
    expect(r.counts.invalid).toBe(1);
  });

  it('題名・場所は 500 字で切る', () => {
    const e = first(['DTSTART;VALUE=DATE:20260825', `SUMMARY:${'あ'.repeat(600)}`, `LOCATION:${'い'.repeat(600)}`]);
    expect(Array.from(e.summary)).toHaveLength(501);
    expect(e.summary.endsWith('…')).toBe(true);
    expect(Array.from(e.location)).toHaveLength(501);
    expect(first(['DTSTART;VALUE=DATE:20260825', `SUMMARY:${'あ'.repeat(500)}`]).summary).toBe('あ'.repeat(500));
  });

  it('上限は parseIcs の中で守る: 超えたら途中で読むのをやめて overLimit', () => {
    const ev = ['DTSTART;VALUE=DATE:20260825', 'SUMMARY:x'];
    const text = cal(...Array.from({ length: 10 }, () => ev));
    const over = parseIcs(text, { localZone: TOKYO, maxEvents: 2 });
    expect(over.overLimit).toBe(true);
    expect(over.events.length).toBeLessThanOrEqual(3);
    const ok = parseIcs(text, { localZone: TOKYO, maxEvents: 10 });
    expect(ok.overLimit).toBe(false);
    expect(ok.events).toHaveLength(10);
  });
});

describe('繰り返し ── 追加の門', () => {
  it('🔴 毎月・毎年は、タイムゾーンの変換で日付が動いたら言えない(1 回目だけ)', () => {
    // 東京 3/1 08:00 = ニューヨーク 2/28 18:00(日付が動く)
    const m = one(['DTSTART;TZID=Asia/Tokyo:20260301T080000', 'RRULE:FREQ=MONTHLY', 'SUMMARY:m'], 'America/New_York');
    expect(m.events[0]).toMatchObject({ date: '2026-02-28', repeat: null });
    expect(m.counts.repeatUnread).toBe(1);
    const y = one(['DTSTART;TZID=Asia/Tokyo:20260301T080000', 'RRULE:FREQ=YEARLY', 'SUMMARY:y'], 'America/New_York');
    expect(y.events[0]!.repeat).toBeNull();
    // 対照: 日付が動かなければ言える
    expect(one(['DTSTART;TZID=Asia/Tokyo:20260301T080000', 'RRULE:FREQ=MONTHLY', 'SUMMARY:m'], TOKYO).events[0]!.repeat).toBe('month');
    expect(one(['DTSTART;TZID=Asia/Tokyo:20260301T080000', 'RRULE:FREQ=YEARLY', 'SUMMARY:y'], TOKYO).events[0]!.repeat).toBe('year');
  });

  it('RRULE の値は大文字小文字を問わない', () => {
    expect(first(['DTSTART;VALUE=DATE:20260831', 'RRULE:freq=weekly;byday=mo,we', 'SUMMARY:l']).repeat).toBe('days:13');
    expect(first(['DTSTART;VALUE=DATE:20260831', 'RRULE:FREQ=weekly;UNTIL=20261231', 'SUMMARY:l'])).toMatchObject({
      repeat: 'week', until: '2026-12-31',
    });
  });

  it('RRULE が 2 本・EXRULE があれば 1 回目だけ(どちらを採るか決められない / 除外を捨てない)', () => {
    const two = one(['DTSTART;VALUE=DATE:20260831', 'RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY', 'SUMMARY:x']);
    expect(two.events[0]!.repeat).toBeNull();
    expect(two.counts.repeatUnread).toBe(1);
    const ex = one(['DTSTART;VALUE=DATE:20260831', 'RRULE:FREQ=DAILY', 'EXRULE:FREQ=WEEKLY', 'SUMMARY:x']);
    expect(ex.events[0]!.repeat).toBeNull();
    expect(ex.counts.repeatUnread).toBe(1);
  });

  it('🔴 夏時間のあるタイムゾーンをまたぐ繰り返しは数えて言う(夏時間の無い組み合わせは数えない)', () => {
    const ny = one(['DTSTART;TZID=America/New_York:20260831T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:w'], TOKYO);
    expect(ny.counts.zoneRepeat).toBe(1);
    expect(icsCountNotes(ny.counts).join('')).toContain('夏時間をまたぐと 1 時間ずれる');
    // 端末のほうが夏時間のある地域でも同じ
    expect(one(['DTSTART;TZID=Asia/Tokyo:20260831T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:w'], 'America/New_York').counts.zoneRepeat).toBe(1);
    // 対照群: 夏時間が両方に無い / 同じタイムゾーン / 浮動 / 繰り返しでない
    expect(one(['DTSTART;TZID=Asia/Tokyo:20260831T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:w'], 'Asia/Kolkata').counts.zoneRepeat).toBe(0);
    expect(one(['DTSTART;TZID=America/New_York:20260831T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:w'], 'America/New_York').counts.zoneRepeat).toBe(0);
    expect(one(['DTSTART:20260831T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:w'], 'America/New_York').counts.zoneRepeat).toBe(0);
    expect(one(['DTSTART;TZID=America/New_York:20260831T100000', 'SUMMARY:w'], TOKYO).counts.zoneRepeat).toBe(0);
  });
});

describe('Windows の時刻帯名', () => {
  it('表の値は全部 Intl が知っている(綴りの間違いを入れない)', () => {
    expect(Object.keys(WINDOWS_ZONES).length).toBeGreaterThanOrEqual(10);
    for (const [win, iana] of Object.entries(WINDOWS_ZONES)) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: iana }), `${win} → ${iana}`).not.toThrow();
    }
  });

  it('主な写像を実際の時刻で確かめる(夏の 10:00 → 東京)', () => {
    const at = (tz: string) => first([`DTSTART;TZID=${tz}:20260825T100000`, 'SUMMARY:z']);
    expect(at('Pacific Standard Time')).toMatchObject({ date: '2026-08-26', time: '02:00' }); // PDT = UTC-7
    expect(at('Eastern Standard Time')).toMatchObject({ date: '2026-08-25', time: '23:00' }); // EDT = UTC-4
    expect(at('GMT Standard Time')).toMatchObject({ date: '2026-08-25', time: '18:00' }); // BST = UTC+1
    expect(at('China Standard Time')).toMatchObject({ date: '2026-08-25', time: '11:00' });
    expect(at('UTC')).toMatchObject({ date: '2026-08-25', time: '19:00' });
  });
});

describe('🔴 #1087 の往復の直し', () => {
  it('24:00 まで ── 翌日 00:00 の DTEND は「日をまたぐ」ではなく timeEnd=24:00(往復しても幅が残る)', () => {
    const r = one(['DTSTART;TZID=Asia/Tokyo:20260825T220000', 'DTEND;TZID=Asia/Tokyo:20260826T000000', 'SUMMARY:夜']);
    expect(r.events[0]).toMatchObject({ date: '2026-08-25', time: '22:00', timeEnd: '24:00' });
    expect(r.counts.spansDays, '24:00 までを日またぎに数えている').toBe(0);
    expect(icsCountNotes(r.counts).join()).not.toContain('日をまたぐ');
    // 対照群:翌日 00:30 までは本当に日をまたぐ
    const over = one(['DTSTART;TZID=Asia/Tokyo:20260825T220000', 'DTEND;TZID=Asia/Tokyo:20260826T003000', 'SUMMARY:夜']);
    expect(over.events[0]!.timeEnd).toBeNull();
    expect(over.counts.spansDays).toBe(1);
    // 本文に書くと札として読み戻せる
    const cards = taskCardsOf('n', icsNoteBody(r.events));
    expect(cards[0]).toMatchObject({ time: '22:00', timeEnd: '24:00' });
  });

  it('24:00 まで ── 書き出し(東京 / UTC)→ 取り込みで timeEnd が残る', () => {
    const base: AgendaItem = {
      key: 'k', lid: 'n1', line: 1, text: '予定', done: false,
      date: '2026-08-31', time: '22:00', timeEnd: '24:00', until: null, repeat: null,
    };
    for (const [zone, tz] of [
      [{ kind: 'tokyo' }, 'Asia/Tokyo'],
      [{ kind: 'utc', offsetMinutes: () => 330 }, 'Asia/Kolkata'],
    ] as [IcsZone, string][]) {
      const out = buildIcs([base], { stamp: new Date(0), zone });
      const p = parseIcs(out.text, { localZone: tz });
      expect(p.events[0], tz).toMatchObject({ date: '2026-08-31', time: '22:00', timeEnd: '24:00' });
      expect(p.counts.spansDays, tz).toBe(0);
    }
  });

  it('説明文を切るとき、絵文字(サロゲートペア)の途中で割らない / 数える字も同じ', () => {
    const emoji = '😀';
    const ev = (d: string): IcsEvent => ({
      date: '2026-08-25', time: null, timeEnd: null, until: null, repeat: null,
      summary: 's', location: '', description: d,
    });
    const body = icsNoteBody([ev(emoji.repeat(301))]);
    const memo = body.split('\n').find((l) => l.startsWith('  - メモ: '))!.slice('  - メモ: '.length);
    expect(Array.from(memo).length, '300 字 + …').toBe(301);
    expect(memo.endsWith(`${emoji}…`)).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(memo), '孤立したサロゲート').toBe(false);
    // 数え方:300 字ちょうど(UTF-16 では 600)は切らず、「途中までを入れました」にも数えない
    const exact = one(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:A', `DESCRIPTION:${emoji.repeat(300)}`]);
    expect(exact.counts.shortened).toBe(0);
    expect(icsNoteBody(exact.events)).toContain(emoji.repeat(300));
    expect(icsNoteBody(exact.events)).not.toContain('…');
    const over = one(['DTSTART;VALUE=DATE:20260825', 'SUMMARY:A', `DESCRIPTION:${emoji.repeat(301)}`]);
    expect(over.counts.shortened).toBe(1);
  });

  it('🔴 毎月・毎年で UTC に直すと日付が動くとき(ベルリン 毎月 1 日 00:30)は浮動時刻で書く ── 30 日の月を飛ばさない', () => {
    // 1 月 = +01:00 / 夏 = +02:00。00:30 はどちらでも UTC では前日になる
    const berlin: IcsZone = { kind: 'utc', offsetMinutes: (d) => (Number(d.slice(5, 7)) >= 4 && Number(d.slice(5, 7)) <= 10 ? 120 : 60) };
    const mk = (over: Partial<AgendaItem>): AgendaItem => ({
      key: 'k', lid: 'n1', line: 1, text: '家賃', done: false,
      date: '2026-01-01', time: '00:30', timeEnd: '01:30', until: null, repeat: 'month', ...over,
    });
    const text = buildIcs([mk({})], { stamp: new Date(0), zone: berlin }).text;
    const lines = text.split('\r\n');
    expect(lines).toContain('DTSTART:20260101T003000');
    expect(lines).toContain('DTEND:20260101T013000');
    expect(lines).toContain('RRULE:FREQ=MONTHLY');
    expect(text, 'UTC(Z)で書いている').not.toMatch(/DT(START|END):\d{8}T\d{6}Z/);
    expect(text).not.toContain('TZID');
    // 月末の寄せは shift 0 と同じ書き方になる
    const eom = buildIcs([mk({ date: '2026-01-31' })], { stamp: new Date(0), zone: berlin }).text;
    expect(eom).toContain('RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
    // UNTIL も同じ浮動時刻
    const un = buildIcs([mk({ until: '2026-06-01' })], { stamp: new Date(0), zone: berlin }).text;
    expect(un).toContain('UNTIL=20260601T003000');
    expect(un).not.toMatch(/UNTIL=\d{8}T\d{6}Z/);
    // 毎年も同じ
    const yr = buildIcs([mk({ repeat: 'year' })], { stamp: new Date(0), zone: berlin }).text;
    expect(yr).toContain('DTSTART:20260101T003000');
    // 往復:取り込むとベルリンの毎月 1 日 00:30 のまま
    const back = parseIcs(text, { localZone: 'Europe/Berlin' });
    expect(back.counts.repeatUnread).toBe(0);
    expect(back.events[0]).toMatchObject({ date: '2026-01-01', time: '00:30', repeat: 'month' });
  });

  it('対照群:日付が動かない UTC / 週の繰り返し / 東京は今までの書き方のまま', () => {
    const plus1: IcsZone = { kind: 'utc', offsetMinutes: () => 60 }; // 12:00 は同じ日
    const mk = (over: Partial<AgendaItem>): AgendaItem => ({
      key: 'k', lid: 'n1', line: 1, text: '家賃', done: false,
      date: '2026-01-01', time: '12:00', timeEnd: null, until: null, repeat: 'month', ...over,
    });
    expect(buildIcs([mk({})], { stamp: new Date(0), zone: plus1 }).text).toContain('DTSTART:20260101T110000Z');
    const wk = buildIcs([mk({ time: '00:30', repeat: 'week' })], { stamp: new Date(0), zone: { kind: 'utc', offsetMinutes: () => 60 } }).text;
    expect(wk, '週は今までどおり UTC').toMatch(/DTSTART:20251231T233000Z/);
    expect(wk).toContain('RRULE:FREQ=WEEKLY');
  });
});
