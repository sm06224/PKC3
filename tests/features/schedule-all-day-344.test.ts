/** @vitest-environment node */
/**
 * 🔴 **終日と時刻未定の区別**(台帳 #344 の残り。鍵の表の `all_day`)── 行の予定。
 *
 * 書き方: `- [ ] 休み @2026-10-20 終日`。時刻を書かなかっただけの予定(時刻未定)とは別物として扱う。
 *
 * 守る主張:
 * ① 読み ── 日付の直後の `終日` だけを記法として食べる(散文の `終日の休み` は食べない / 時刻・期間とは同時に立たない / 刻みと並べられる)
 * ② 書き ── `formatLineDate` は読まれる形のときだけ `終日` を書く(往復する)。日を動かしても `終日` は残る
 * ③ 並び ── 終日は期間と同じ「その日の先頭」。時刻未定は後ろのまま
 * ④ 取り込み ── `.ics` の日付だけの予定は終日になる
 */
import { describe, expect, it } from 'vitest';
import { formatLineDate, readLineDate, stripLineDate } from '../../src/features/schedule/line-date';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { buildAgenda, itemOfCard } from '../../src/features/schedule/agenda';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { icsNoteBody, parseIcs } from '../../src/features/schedule/ics-import';

describe('読み: 日付の直後の「終日」', () => {
  it('🔴 終日と書いた行は allDay、書かない行は時刻未定のまま(区別する)', () => {
    expect(readLineDate('- [ ] 休み @2026-10-20 終日')?.allDay).toBe(true);
    expect(readLineDate('- [ ] 休み @2026-10-20')?.allDay).toBe(false);
  });

  it('記法として食べた字は札の字から外れる', () => {
    expect(stripLineDate('- [ ] 休み @2026-10-20 終日')).toBe('- [ ] 休み');
    expect(stripLineDate('- [ ] @2026-10-20 終日 休み')).toBe('- [ ] 休み');
  });

  it('🔴 散文は食べない(直後が字のとき)── 既に書かれた本文の意味を変えない', () => {
    const r = readLineDate('- [ ] @2026-10-20 終日の休み');
    expect(r?.allDay).toBe(false);
    expect(stripLineDate('- [ ] @2026-10-20 終日の休み')).toBe('- [ ] 終日の休み');
    expect(readLineDate('- [ ] @2026-10-20 終日休み')?.allDay).toBe(false);
  });

  it('時刻と同時には立たない / 期間は元から終日なので付けない', () => {
    const t = readLineDate('- [ ] 会議 @2026-10-20 14:00 終日');
    expect(t?.time).toBe('14:00');
    expect(t?.allDay).toBe(false);
    const p = readLineDate('- [ ] 出張 @2026-10-20..2026-10-22 終日');
    expect(p?.until).toBe('2026-10-22');
    expect(p?.allDay).toBe(false);
  });

  it('刻みと並べられる(終日 → 毎週の順)。詰めて書いても読む', () => {
    const a = readLineDate('- [ ] 定休 @2026-10-20 終日 毎週');
    expect(a).toMatchObject({ allDay: true, repeat: 'week' });
    const b = readLineDate('- [ ] 定休 @2026-10-20終日毎週');
    expect(b).toMatchObject({ allDay: true, repeat: 'week' });
    // 記法の範囲は刻みまで
    expect('- [ ] 定休 @2026-10-20 終日 毎週'.slice(a!.start, a!.end)).toBe('@2026-10-20 終日 毎週');
  });
});

describe('書き: formatLineDate は読まれる形のときだけ 終日 を書く', () => {
  it('単日・時刻なし → 終日。時刻あり / 期間あり → 書かない(往復で食い違う字を出さない)', () => {
    expect(formatLineDate('2026-10-20', null, null, null, undefined, null, true)).toBe('@2026-10-20 終日');
    expect(formatLineDate('2026-10-20', '14:00', null, null, undefined, null, true)).toBe('@2026-10-20 14:00');
    expect(formatLineDate('2026-10-20', null, '2026-10-22', null, undefined, null, true)).toBe('@2026-10-20..2026-10-22');
    expect(formatLineDate('2026-10-20', null, null, 'week', undefined, null, true)).toBe('@2026-10-20 終日 毎週');
    expect(formatLineDate('2026-10-20')).toBe('@2026-10-20');
  });

  it('🔴 往復する(書いた形を読み戻すと同じ)', () => {
    for (const w of [
      formatLineDate('2026-10-20', null, null, null, undefined, null, true),
      formatLineDate('2026-10-20', null, null, 'month', undefined, null, true),
      formatLineDate('2026-10-20', null, null, null, '2026-10-13', null, true),
    ]) {
      const r = readLineDate(`- [ ] x ${w}`);
      expect(r?.allDay, w).toBe(true);
      expect(`- [ ] x ${w}`.slice(r!.start, r!.end), w).toBe(w);
    }
  });
});

describe('札と束 (#344 の残り)', () => {
  it('taskCardsOf: allDay の札は字に「終日」を残さない', () => {
    const [c] = taskCardsOf('n1', '- [ ] 休み @2026-10-20 終日\n');
    expect(c).toMatchObject({ text: '休み', date: '2026-10-20', time: null, allDay: true });
    const [d] = taskCardsOf('n1', '- [ ] 休み @2026-10-20\n');
    expect(d!.allDay).toBe(false);
  });

  it('🔴 並び: 終日(と期間)がその日の先頭 → 時刻つき → 時刻未定', () => {
    const cards = taskCardsOf(
      'n1',
      ['- [ ] 未定 @2026-10-20', '- [ ] 会議 @2026-10-20 10:00', '- [ ] 休み @2026-10-20 終日'].join('\n'),
    ).map(itemOfCard);
    const g = buildAgenda(cards, '2026-10-20');
    expect(g[0]!.cards.map((c) => c.text)).toEqual(['休み', '会議', '未定']);
  });
});

describe('動かしても 終日 は残る (#344 の残り)', () => {
  const body = '- [ ] 休み @2026-10-20 終日\n';

  it('🔴 日付を替えても、終日の字が消えない', () => {
    const next = applyBodyRewrite(body, {
      kind: 'line-date',
      line: 0,
      openLine: '- [ ] 休み @2026-10-20 終日',
      date: '2026-10-23',
      time: null,
    });
    expect(next).toBe('- [ ] 休み @2026-10-23 終日\n');
  });

  it('時刻を付けると 終日 は外れる(時刻と同時には書かない)', () => {
    const next = applyBodyRewrite(body, {
      kind: 'line-date',
      line: 0,
      openLine: '- [ ] 休み @2026-10-20 終日',
      date: '2026-10-20',
      time: '09:00',
    });
    expect(next).toBe('- [ ] 休み @2026-10-20 09:00\n');
  });

  it('刻みを付け替えても 終日 は残る', () => {
    const next = applyBodyRewrite(body, {
      kind: 'line-date',
      line: 0,
      openLine: '- [ ] 休み @2026-10-20 終日',
      repeat: 'week',
    });
    expect(next).toBe('- [ ] 休み @2026-10-20 終日 毎週\n');
  });

  it('🔴 繰り返しの回を実体の行にしても、終日が付いてくる', () => {
    const next = applyBodyRewrite('- [ ] 定休 @2026-10-19 終日 毎週\n', {
      kind: 'repeat-done',
      line: 0,
      openLine: '- [ ] 定休 @2026-10-19 終日 毎週',
      date: '2026-10-26',
    });
    expect(next).toContain('- [x] 定休 @2026-10-26 終日');
  });
});

describe('.ics の取り込み (#344 の残り)', () => {
  it('🔴 日付だけの予定(DTSTART;VALUE=DATE)は 終日 になり、時刻つきは付かない', () => {
    const lines = icsNoteBody(
      parseIcs(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:1',
        'DTSTART;VALUE=DATE:20261020',
        'SUMMARY:休み',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:2',
        'DTSTART:20261020T140000',
        'SUMMARY:会議',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
      { localZone: 'Asia/Tokyo' },
      ).events,
    );
    expect(lines).toContain('- [ ] @2026-10-20 終日 休み');
    expect(lines).toContain('- [ ] @2026-10-20 14:00 会議');
  });
});
