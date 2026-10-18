/** @vitest-environment node */
/**
 * 🔴 **ノート 1 件の予定の時刻**(前書きの `date: 2026-10-20 14:00`。台帳 #1852 / 依頼 192 / 284。Gemini 回答 = 時刻も読む)。
 *
 * 見るのは 5 つ:
 * ① 読み方(日付・時刻・区切りの割り)② 走査が運ぶ物(`noteTimeOf` / `noteTimeFor` / 引き直し)
 * ③ 予定の 1 件にする(`itemOfNote`)④ 書き換え(日だけ動かすと時刻が残る)
 * ⑤ 🔴 **互換**:前の版の読み方を再現して、時刻つきで書いたノートを前の版で開いても中身が消えないこと。
 */
import { describe, expect, it } from 'vitest';
import {
  parseFrontmatterWhen,
  dateOfFrontmatterText,
  foldWideDateChars,
  withFrontmatterDate,
  isScheduleDate,
} from '../../src/features/schedule/schedule-date';
import { readScheduleDate, readScheduleTime } from '../../src/features/schedule/schedule-keys';
import {
  noteTimeCards,
  noteTimeFor,
  noteTimeOf,
  replaceNoteTime,
  type NoteTime,
} from '../../src/features/schedule/task-cards';
import { itemOfNote } from '../../src/features/schedule/agenda';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import { dueAlarms, silencedLidsOf } from '../../src/features/alarm/alarm-due';
import { missedItems } from '../../src/features/schedule/schedule-notify';
import { buildIcs } from '../../src/features/schedule/ics';
import type { EntryMeta } from '../../src/core/model/entry-meta';

describe('読み方(parseFrontmatterWhen)', () => {
  it.each([
    ['2026-10-20 14:00', '2026-10-20', '14:00', ' '],
    ['2026-10-20T10:00', '2026-10-20', '10:00', 'T'],
    ['2026-10-20T10:00:30', '2026-10-20', '10:00', 'T'],
    ['2026-10-20 9:05', '2026-10-20', '09:05', ' '],
    ['２０２６-１０-２０ １４：００', '2026-10-20', '14:00', ' '],
    ['2026/10/20 7:30', '2026-10-20', '07:30', ' '],
  ])('%j → 日付 %s・時刻 %s', (raw, date, time, sep) => {
    expect(parseFrontmatterWhen(raw)).toEqual({ date, time, sep });
  });

  it('日付だけ・時刻が読めない / 時差つきは、日付だけ読んで時刻は null(今までの動き)', () => {
    expect(parseFrontmatterWhen('2026-10-20')).toEqual({ date: '2026-10-20', time: null, sep: ' ' });
    for (const raw of ['2026-10-20T10:00:00Z', '2026-10-20 10:00+09:00', '2026-10-20 25:00', '2026-10-20 10:61']) {
      const w = parseFrontmatterWhen(raw);
      expect(w?.date, raw).toBe('2026-10-20');
      expect(w?.time, raw).toBeNull();
    }
  });

  it('日付として読めない値は null(今までどおり。時刻の後ろに字が付く値も)', () => {
    for (const raw of ['', '来週', '2026-10-20 14:00 頃', '2026-10-20 午後', 'x2026-10-20']) {
      expect(parseFrontmatterWhen(raw), raw).toBeNull();
    }
  });

  it('日付だけを取り出す口は、時刻つきでも同じ日付(抽出列は日付だけ)', () => {
    expect(dateOfFrontmatterText('2026-10-20 14:00')).toBe('2026-10-20');
    expect(readScheduleDate({ date: '2026-10-20 14:00' })).toBe('2026-10-20');
    expect(readScheduleTime({ date: '2026-10-20 14:00' })).toBe('14:00');
    expect(readScheduleTime({ date: '2026-10-20' })).toBeNull();
    expect(readScheduleTime({ date: 5 as unknown as string })).toBeNull();
    expect(readScheduleTime({})).toBeNull();
  });

  it('日付だけを替える: 時刻は綴りごと残る。time を渡すと替わり、null で外れる', () => {
    expect(withFrontmatterDate('2026-10-20 14:00', '2026-10-21')).toBe('2026-10-21 14:00');
    expect(withFrontmatterDate('2026-10-20T9:05', '2026-10-21')).toBe('2026-10-21T09:05');
    expect(withFrontmatterDate('2026-10-20', '2026-10-21')).toBe('2026-10-21');
    expect(withFrontmatterDate('2026-10-20 14:00', '2026-10-21', '16:30')).toBe('2026-10-21 16:30');
    expect(withFrontmatterDate('2026-10-20 14:00', '2026-10-21', null)).toBe('2026-10-21');
    expect(withFrontmatterDate('2026-10-20', '2026-10-21', '08:00')).toBe('2026-10-21 08:00');
    expect(withFrontmatterDate('', '2026-10-21', '08:00')).toBe('2026-10-21 08:00');
  });
});

describe('走査が運ぶ物', () => {
  const body = '---\ndate: 2026-10-20 14:00\nstatus: open\n---\n本文\n';
  it('noteTimeOf: 時刻つきだけ。日付だけ・前書きなし・読めない時刻は null', () => {
    expect(noteTimeOf('a', body)).toEqual({ lid: 'a', date: '2026-10-20', time: '14:00' });
    expect(noteTimeOf('a', '---\ndate: 2026-10-20\n---\n')).toBeNull();
    expect(noteTimeOf('a', '本文だけ')).toBeNull();
    expect(noteTimeOf('a', '---\ndate: 2026-10-20 25:00\n---\n')).toBeNull();
  });

  it('replaceNoteTime: 足す / 替える / 外す。変わらない回は同じ配列(描画の指紋を壊さない)', () => {
    const none = replaceNoteTime(undefined, 'a', '本文');
    expect(none).toBeUndefined();
    const added = replaceNoteTime(undefined, 'a', body)!;
    expect(added).toEqual([{ lid: 'a', date: '2026-10-20', time: '14:00' }]);
    expect(replaceNoteTime(added, 'a', body), '変わらないのに新しい配列').toBe(added);
    const moved = replaceNoteTime(added, 'a', '---\ndate: 2026-10-21 16:00\n---\n')!;
    expect(moved).toEqual([{ lid: 'a', date: '2026-10-21', time: '16:00' }]);
    expect(replaceNoteTime(moved, 'a', '---\ndate: 2026-10-21\n---\n')).toEqual([]);
    // 他のノートは触らない
    const two = replaceNoteTime(added, 'b', body.replace('14:00', '09:00'))!;
    expect(two.map((n) => n.lid).sort()).toEqual(['a', 'b']);
  });

  it('noteTimeFor: 抽出列の日付と食い違う組(日付だけ別の窓・旧ビルドが書き換えた)は使わない', () => {
    const scan = { noteTimes: [{ lid: 'a', date: '2026-10-20', time: '14:00' }] as NoteTime[] };
    expect(noteTimeFor(scan, 'a', '2026-10-20')).toBe('14:00');
    expect(noteTimeFor(scan, 'a', '2026-10-21'), '古い時刻を新しい日付に付けた').toBeNull();
    expect(noteTimeFor(scan, 'b', '2026-10-20')).toBeNull();
    expect(noteTimeFor(scan, 'a', null)).toBeNull();
    expect(noteTimeFor(null, 'a', '2026-10-20')).toBeNull();
    // 旧ビルドのタブが運んだ走査(noteTimes なし)も受ける
    expect(noteTimeFor({}, 'a', '2026-10-20')).toBeNull();
  });
});

const meta = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'a',
  title: '歯医者',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: '2026-10-20',
  archived: false,
  bodyChars: null,
  ...over,
});

describe('予定の 1 件にする', () => {
  it('時刻を渡すと予定の時刻になる(終わりは書けないので幅は無い)。渡さなければ終日', () => {
    const t = itemOfNote(meta(), '14:00');
    expect([t.time, t.timeEnd, t.line]).toEqual(['14:00', null, null]);
    expect(itemOfNote(meta()).time).toBeNull();
  });

  it('アラーム / 見逃しの数え方に渡せる札になる(済み・食い違いは別)', () => {
    const scan = { noteTimes: [{ lid: 'a', date: '2026-10-20', time: '14:00' }] };
    const metas = new Map([['a', meta()]]);
    const cards = noteTimeCards(scan, metas);
    expect(cards).toHaveLength(1);
    const at = (h: number, m: number): number => new Date(2026, 9, 20, h, m).getTime();
    // 14:00 を跨ぐ窓で鳴る。対照群: 跨がない窓では鳴らない
    expect(dueAlarms(cards, at(13, 59), at(14, 0))).toHaveLength(1);
    expect(dueAlarms(cards, at(14, 1), at(14, 2))).toEqual([]);
    expect(missedItems(cards, at(13, 0), at(15, 0))).toHaveLength(1);
    // 「出すもの」で外したノートは鳴らさない
    expect(dueAlarms(cards, at(13, 59), at(14, 0), silencedLidsOf(new Map([['a', { archived: false }]]), ['a']))).toEqual([]);
    // 済みのノートは数えない
    expect(noteTimeCards(scan, new Map([['a', meta({ status: 'done' })]]))[0]!.done).toBe(true);
    expect(dueAlarms(noteTimeCards(scan, new Map([['a', meta({ status: 'done' })]])), at(13, 59), at(14, 0))).toEqual([]);
    // 日付が食い違えば札にしない
    expect(noteTimeCards(scan, new Map([['a', meta({ date: '2026-10-21' })]]))).toEqual([]);
  });
});

describe('書き出し(.ics)', () => {
  it('🔴 時刻つきのノート 1 件の予定は時刻つきの予定として書き出す。対照群: 時刻の無いノートは終日', () => {
    const opts = { stamp: new Date(0), zone: { kind: 'tokyo' } } as const;
    const timed = buildIcs([itemOfNote(meta(), '14:00')], opts).text;
    expect(timed).toMatch(/DTSTART;TZID=Asia\/Tokyo:20261020T140000/);
    const allDay = buildIcs([itemOfNote(meta())], opts).text;
    expect(allDay).toMatch(/DTSTART;VALUE=DATE:20261020/);
  });
});

describe('書き換え(entry-date)', () => {
  const body = '---\ndate: 2026-10-20 14:00\nstatus: open\n---\n本文\n';
  const date = (b: string | null): unknown => (b === null ? null : parseFrontmatter(b).meta['date']);

  it('日だけ動かすと、書かれた時刻は残る', () => {
    const next = applyBodyRewrite(body, { kind: 'entry-date', date: '2026-10-25' });
    expect(date(next)).toBe('2026-10-25 14:00');
    expect(next).toContain('\n本文\n');
  });

  it('time を渡すと時刻も替わる。null で時刻だけ外れる', () => {
    expect(date(applyBodyRewrite(body, { kind: 'entry-date', date: '2026-10-25', time: '09:30' }))).toBe('2026-10-25 09:30');
    expect(date(applyBodyRewrite(body, { kind: 'entry-date', date: '2026-10-20', time: null }))).toBe('2026-10-20');
  });

  it('日付を外すと、日付ごと(時刻も)消える', () => {
    const next = applyBodyRewrite(body, { kind: 'entry-date', date: null })!;
    expect(next).not.toContain('date:');
    expect(next).toContain('status: open');
  });

  it('時刻の無いノートは、これまでと同じ書き方(引用符なしの日付だけ)', () => {
    const b = '---\ndate: 2026-10-20\n---\n本文';
    const next = applyBodyRewrite(b, { kind: 'entry-date', date: '2026-10-21' })!;
    expect(next).toBe('---\ndate: 2026-10-21\n---\n本文');
  });

  it('変わらない回は同じ本文を返す(null = 断る、ではない)', () => {
    expect(applyBodyRewrite(body, { kind: 'entry-date', date: '2026-10-20' })).toBe(body);
  });
});

describe('🔴 互換:前の版の読み方で、時刻つきのノートを開く', () => {
  /**
   * 直前のビルド(5f378957、束 E1 の後・時刻を読む前)の `dateOfFrontmatterText` をそのまま写したもの。
   * 前書きの `date:` の **日付の部分だけを読み、時刻は捨てる**(時刻つきでも日付として読む)。
   * 守る主張: 新しい版が時刻つきで書いた前書きを、前の版は壊れずに **日付だけ**読む(予定表には終日で出る)。
   * ⚠ 期待値を新しい版の関数で作らない(同じ盲点を持つ)── 旧の正規表現を写して使う。
   */
  const oldReadDate = (body: string): string | null => {
    const v = parseFrontmatter(body).meta['date'];
    if (typeof v !== 'string') return null;
    const m = /^(\S+?)(?:[ T\u3000](\S+))?$/.exec(foldWideDateChars(v.trim()));
    if (m === null) return null;
    const date = m[1]!.replace(/\//g, '-');
    if (!isScheduleDate(date)) return null;
    if (m[2] !== undefined && !/^\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(m[2])) return null;
    return date;
  };

  it('新しい版が時刻つきで書いた前書きを、前の版は日付だけ読み、時刻は捨てる ── 壊れず、中身は全部残る', () => {
    const written = applyBodyRewrite(
      '---\ndate: 2026-10-20\nstatus: open\n---\n本文\n',
      { kind: 'entry-date', date: '2026-10-22', time: '10:15' },
    )!;
    expect(oldReadDate(written), '前の版が日付を読めない(壊れた)').toBe('2026-10-22');
    const kept = parseFrontmatter(written);
    expect(kept.meta['date']).toBe('2026-10-22 10:15');
    expect(kept.meta['status']).toBe('open');
    expect(kept.body.trim()).toBe('本文');
  });

  it('時刻を付けていないノートの書き方は、前の版と 1 バイトも変わらない(日だけ動かしても前の版が読める)', () => {
    const before = '---\ndate: 2026-10-20\nstatus: open\n---\n本文\n';
    const written = applyBodyRewrite(before, { kind: 'entry-date', date: '2026-10-22' })!;
    expect(oldReadDate(written)).toBe('2026-10-22');
    expect(written).toBe(before.replace('2026-10-20', '2026-10-22'));
  });

  it('新しい版は、前の版が日付だけで書いたノートを今までどおり読む(時刻なし = 終日)', () => {
    const old = '---\ndate: 2026-10-20\n---\n';
    expect(noteTimeOf('a', old)).toBeNull();
    expect(readScheduleDate(parseFrontmatter(old).meta)).toBe('2026-10-20');
  });
});
