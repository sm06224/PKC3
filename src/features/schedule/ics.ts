/**
 * 🔴 **予定を iCalendar(`.ics`、RFC 5545)に書く**(#855 段 D の書き出し側)。
 *
 * 出口は「Outlook / Google カレンダー / OS のカレンダーに渡す」ことである
 * (設計 `docs/development/schedule-outlook-2026-09.md` §3・§4)。⚠ 取り込む側は
 * 厳しく、**黙って時刻をずらす・予定を落とす**。その落とし穴を 1 つずつ門にしてある:
 *
 * | 落とし穴 | ここでの扱い |
 * |---|---|
 * | 改行は **CRLF** | 全行を `\r\n` で繋ぐ(末尾も) |
 * | **75 バイト**で折る(日本語は 25 字で溢れる) | UTF-8 の**バイト**で数え、字の途中では折らない(`foldLine`) |
 * | `\` `;` `,` 改行のエスケープ | `escapeText` |
 * | 同じ予定は**同じ UID** | `lid` と行の位置から作る(書き出し直しても変わらない) |
 * | 終日の終わりは **+1 日**(排他) | `DTEND;VALUE=DATE` |
 * | 時刻は **VTIMEZONE を同梱**(浮動時刻だと Outlook がずらす) | 下の「時刻帯の決め」 |
 * | 繰り返しの終わりは **UTC** | 時刻つきは `UNTIL=…Z`(終日は RFC どおり DATE) |
 * | 例外日は時刻と TZ が**完全一致** | `EXDATE` は `DTSTART` と同じ書き方で出す |
 *
 * ## 時刻帯の決め(「時刻つき」の書き方)
 *
 * 本文の `14:00` は**壁時計**で、時刻帯を持たない。⚠ 浮動時刻(`DTSTART:20260825T140000`)で
 * 渡すと Outlook は受け取り側の時刻帯で読み、**ずれる**。だから:
 *
 * - 端末の時刻帯が **Asia/Tokyo**(+09:00 固定・夏時間なし)→ `TZID=Asia/Tokyo` と
 *   **VTIMEZONE を 1 つ同梱**(壁時計のまま渡せる)
 * - それ以外 → VTIMEZONE を一般には作らず、**UTC(`…Z`)に直して**出す。壁時計 → UTC は
 *   呼び側が渡す `offsetMinutes`(その日その時刻の端末の UTC との差)で引く。
 *   ⚠ 繰り返しを夏時間のある時刻帯で UTC にすると、**夏時間をまたいだ回が 1 時間ずれる**
 *   (既知の限界。Asia/Tokyo では起きない)
 *
 * ## 🔴 pure module ── 時計も DOM も持たない
 *
 * 「いま」は `stamp` で呼び側が渡す(読むと test が実行した日で変わる)。
 */
import { addDays, daysBetween } from '../datetime/date-math';
import { storedDateParts } from '../datetime/stored-date';
import { isRealCalendarDate } from './schedule-date';
import {
  repeatMateKey,
  weekdaysOf,
  type BaseRepeatUnit,
  type RepeatUnit,
} from './repeat';
import type { AgendaItem } from './agenda';

/** 行の長さの上限(**オクテット**、改行を除く)。RFC 5545 §3.1。 */
export const ICS_FOLD_OCTETS = 75;

const enc = new TextEncoder();

/**
 * 🔴 **75 オクテットで折る**。⚠ 字数ではなく **UTF-8 のバイト数**で数える
 * (日本語 1 字 = 3 バイトなので、25 字で溢れる)。⚠ **字の途中では折らない**
 * (折った先が文字化けする)。折り目は `CRLF + 空白 1 つ`で、続きの行は
 * その空白も 1 バイトに数えるので中身は 74 バイトまで。
 */
export function foldLine(line: string): string {
  if (enc.encode(line).length <= ICS_FOLD_OCTETS) return line;
  const out: string[] = [];
  let cur = '';
  let used = 0;
  // 先頭行は 75、続きの行は空白ぶん 1 少ない
  let limit = ICS_FOLD_OCTETS;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (used + n > limit) {
      out.push(cur);
      cur = '';
      used = 0;
      limit = ICS_FOLD_OCTETS - 1;
    }
    cur += ch;
    used += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** TEXT 値のエスケープ(`\` `;` `,` と改行)。⚠ `\` を**最初に**(後ろの変換が作る `\` を二重にしない)。 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** 端末の時刻帯の扱い。 */
export type IcsZone =
  | { readonly kind: 'tokyo' }
  | {
      readonly kind: 'utc';
      /** その壁時計(`YYYY-MM-DD` `HH:MM`)での、端末の UTC との差(分。東が正)。 */
      readonly offsetMinutes: (date: string, time: string) => number;
    };

/**
 * 端末の時刻帯の名前から決める。`Asia/Tokyo`(と旧名 `Japan`)だけ VTIMEZONE を同梱する。
 * 🔑 名前は呼び側が `Intl.DateTimeFormat().resolvedOptions().timeZone` から渡す。
 */
export function resolveIcsZone(
  tzName: string | undefined,
  offsetMinutes: (date: string, time: string) => number,
): IcsZone {
  return tzName === 'Asia/Tokyo' || tzName === 'Japan'
    ? { kind: 'tokyo' }
    : { kind: 'utc', offsetMinutes };
}

const TOKYO_TZID = 'Asia/Tokyo';
const TOKYO_OFFSET = 9 * 60;

const VTIMEZONE_TOKYO = [
  'BEGIN:VTIMEZONE',
  `TZID:${TOKYO_TZID}`,
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0900',
  'TZOFFSETTO:+0900',
  'TZNAME:JST',
  'END:STANDARD',
  'END:VTIMEZONE',
];

function compactDate(date: string): string {
  return date.replace(/-/g, '');
}
function compactTime(time: string): string {
  return `${time.slice(0, 2)}${time.slice(3, 5)}00`;
}

function validTime(t: string | null): t is string {
  if (t === null || !/^\d{2}:\d{2}$/.test(t)) return false;
  return Number(t.slice(0, 2)) < 24 && Number(t.slice(3, 5)) < 60;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** `Date` → `YYYYMMDDTHHMMSSZ`(UTC)。 */
function utcStamp(d: Date): string {
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** 壁時計 → UTC の `YYYYMMDDTHHMMSSZ`。`Date.UTC` で組む(端末の時刻帯に依らない)。 */
function wallToUtc(date: string, time: string, offsetMin: number): string {
  const p = storedDateParts(date)!;
  // 🔑 差は「分」に引く(`Date.UTC` は分の桁あふれを繰り上げ・繰り下げる)── ミリ秒へ直さない
  const ms = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(time.slice(0, 2)),
    Number(time.slice(3, 5)) - offsetMin,
  );
  return utcStamp(new Date(ms));
}

/** 壁時計 → UTC の日付(`YYYY-MM-DD`)。日またぎを見るのに使う。 */
function wallToUtcDate(date: string, time: string, offsetMin: number): string {
  const z = wallToUtc(date, time, offsetMin); // YYYYMMDDTHHMMSSZ
  return `${z.slice(0, 4)}-${z.slice(4, 6)}-${z.slice(6, 8)}`;
}

const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

/** 曜日(月=1 … 日=7)。実在する日だけに使う。 */
function weekdayOf(date: string): number {
  const p = storedDateParts(date)!;
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * 刻み → RRULE の頭(`FREQ=…`)。
 *
 * @param start 開始日(曜日の列は寄せたあと)。月末の寄せに使う
 * @param shift UTC に直したとき日付が動く日数(-1 / 0 / +1)。🔴 UTC で書く予定の BYDAY は
 *   **UTC の曜日**で評価されるので、曜日の列は同じ日数だけずらす(ずらさないと別の曜日に出る)
 */
function freqOf(unit: RepeatUnit, start: string, shift: number): string {
  const days = weekdaysOf(unit);
  if (days !== null) {
    const names = days.map((d) => BYDAY[(((d - 1 + shift) % 7) + 7) % 7]!);
    return `FREQ=WEEKLY;BYDAY=${names.join(',')}`;
  }
  const p = storedDateParts(start)!;
  const day = Number(p.day);
  // 🔴 月末の寄せ(app は 31 日の予定を 2 月の末日に出す = その月の min(日, 末日))。
  //   RFC の既定は「その日が無い月を飛ばす」。28..日 の中で**最も大きい実在の日**を選ぶと同じになる。
  //   ⚠ UTC で日付が動くときは月末の寄せを書かない(動いた日で数え直すと意味が変わる)
  if (unit === 'month' && day >= 29 && shift === 0) {
    const set = Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',');
    return `FREQ=MONTHLY;BYMONTHDAY=${set};BYSETPOS=-1`;
  }
  if (unit === 'year' && p.month === '02' && day === 29 && shift === 0) {
    return 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1';
  }
  const base: Record<BaseRepeatUnit, string> = {
    day: 'FREQ=DAILY',
    week: 'FREQ=WEEKLY',
    // 🔑 隔週は独立した頻度ではなく、毎週の間隔 2
    biweek: 'FREQ=WEEKLY;INTERVAL=2',
    month: 'FREQ=MONTHLY',
    year: 'FREQ=YEARLY',
  };
  return base[unit as BaseRepeatUnit];
}

/**
 * 🔴 **期間・繰り返しの終わりが暦に無い日でも、アプリの読みに合わせて終わらせる**。
 * アプリは日付を**文字列で比べて**「終わりより後なら止める」(`expandRepeat` の `at > stop`)ので、
 * `2026-02-30` は 2 月の末日までが入る。同じになるよう**その月の末日に寄せる**
 * (月が 13 以上ならその年の末日、日が 00 なら前の月の末日)。形が読めなければ `null`。
 */
export function clampUntil(until: string): string | null {
  const p = storedDateParts(until);
  if (p === null) return null;
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  if (m > 12) return `${p.year}-12-31`;
  if (m < 1) return null;
  const lastOf = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > lastOf) return `${p.year}-${p.month}-${pad(lastOf)}`;
  if (d < 1) return addDays(`${p.year}-${p.month}-01`, -1);
  return until;
}

export interface IcsOptions {
  /** DTSTAMP に使う「いま」。⚠ 呼び側が渡す。 */
  readonly stamp: Date;
  readonly zone: IcsZone;
  /** 行の予定の DESCRIPTION に添える、載っているノートの題名。 */
  readonly noteTitle?: (lid: string) => string | undefined;
  /**
   * 済んだ回の実体(`materializedDates`)。🔑 繰り返しの規則から**その日を外す**(EXDATE)。
   * 渡さないと、済ませた回が外の予定表にもう一度出る。
   */
  readonly skip?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface IcsResult {
  readonly text: string;
  /** 書いた予定(VEVENT)の数。 */
  readonly count: number;
  /** 日付・時刻が読めず、書けなかった予定の数。 */
  readonly skipped: number;
}

/** UID。🔑 `lid` と行の位置(ノート丸ごとの予定は `note`)── 日付を直しても変わらない。 */
export function icsUid(item: Pick<AgendaItem, 'lid' | 'line'>): string {
  const safe = item.lid.replace(/[^A-Za-z0-9_-]/g, '_');
  return `pkc3-${safe}-${item.line === null ? 'note' : `L${item.line}`}@pkc3`;
}

/**
 * 予定の一覧 → VCALENDAR。🔑 **日付のない予定は書かない**(外の予定表に置き場が無い)。
 * 繰り返しは**規則のまま**(RRULE)書く ── 展開した窓の分だけ書かない。
 */
export function buildIcs(items: readonly AgendaItem[], opts: IcsOptions): IcsResult {
  const { zone } = opts;
  const lines: string[] = [];
  let count = 0;
  let skipped = 0;
  let usesTokyo = false;
  const stamp = utcStamp(opts.stamp);
  const offsetAt = (date: string, time: string): number =>
    zone.kind === 'tokyo' ? TOKYO_OFFSET : zone.offsetMinutes(date, time);

  for (const it of items) {
    if (it.date === null) continue;
    if (!isRealCalendarDate(it.date)) {
      skipped += 1;
      continue;
    }
    // 🔴 読めない時刻(`25:99`)は書かない ── 終日にすると別の予定になる。数えて知らせる
    if (it.time !== null && !validTime(it.time)) {
      skipped += 1;
      continue;
    }
    const timed = it.time !== null;
    const timeEnd = timed && validTime(it.timeEnd) && it.timeEnd >= it.time! ? it.timeEnd : null;
    let until: string | null = null;
    if (it.until !== null) {
      until = clampUntil(it.until);
      if (until === null || until < it.date) {
        skipped += 1;
        continue;
      }
    }

    // 曜日の列は、開始日がその曜日でなくても始まりを**最初に当たる日**へ寄せる
    // (RFC では DTSTART が必ず 1 回目に数えられるので、寄せないと本文に無い日が出る)
    let start = it.date;
    const wd = it.repeat === null ? null : weekdaysOf(it.repeat);
    if (wd !== null) {
      for (let i = 0; i < 7 && !wd.includes(weekdayOf(start)); i += 1) start = addDays(start, 1)!;
      if (until !== null && start > until) {
        skipped += 1;
        continue;
      }
    }

    // 🔴 UTC で書くときの差は**開始の回のもの 1 つ**に揃える(DTSTART / DTEND / UNTIL / EXDATE が同じ差)。
    //   例外日だけ日付ごとの差で書くと、規則が作る回(開始の差で出る)と 1 時間ずれて外れない
    const off = timed ? offsetAt(start, it.time!) : 0;
    const startUtc = timed && zone.kind === 'utc' ? wallToUtcDate(start, it.time!, off) : start;
    const shift = timed && zone.kind === 'utc' ? daysBetween(start, startUtc) ?? 0 : 0;

    const ev: string[] = ['BEGIN:VEVENT', `UID:${icsUid(it)}`, `DTSTAMP:${stamp}`];
    // 時刻つきの値(開始 / 終わり / 例外日)をゾーンに合わせて 1 か所で書く
    const dt = (name: string, date: string, time: string): string =>
      zone.kind === 'tokyo'
        ? `${name};TZID=${TOKYO_TZID}:${compactDate(date)}T${compactTime(time)}`
        : `${name}:${wallToUtc(date, time, off)}`;
    const exdates: string[] = [];
    const skipSet = it.repeat === null ? undefined : opts.skip?.get(repeatMateKey(it.lid, it.text));
    if (skipSet !== undefined) {
      for (const d of [...skipSet].sort()) {
        if (d >= start && (until === null || d <= until) && isRealCalendarDate(d)) exdates.push(d);
      }
    }

    if (timed) {
      const time = it.time!;
      ev.push(dt('DTSTART', start, time));
      if (timeEnd !== null) ev.push(dt('DTEND', start, timeEnd));
      if (zone.kind === 'tokyo') usesTokyo = true;
      if (it.repeat !== null) {
        // 🔴 終わりは UTC(開始の時刻で数える ── 最終日の回を含める)
        const untilPart = until === null ? '' : `;UNTIL=${wallToUtc(until, time, off)}`;
        ev.push(`RRULE:${freqOf(it.repeat, start, shift)}${untilPart}`);
        if (exdates.length > 0) {
          const vals = exdates.map((d) => dt('EXDATE', d, time));
          // 同じ書き方の行を 1 本にまとめる(`EXDATE;TZID=…:a,b`)
          const head = vals[0]!.slice(0, vals[0]!.indexOf(':') + 1);
          ev.push(`${head}${vals.map((v) => v.slice(v.indexOf(':') + 1)).join(',')}`);
        }
      }
    } else {
      ev.push(`DTSTART;VALUE=DATE:${compactDate(start)}`);
      // 🔴 終日の終わりは**排他**(+1 日)。期間の繰り返しは「1 回ぶんの長さ」ではなく終わりの日
      const last = it.repeat === null && until !== null ? until : start;
      ev.push(`DTEND;VALUE=DATE:${compactDate(addDays(last, 1)!)}`);
      if (it.repeat !== null) {
        // ⚠ DTSTART が日付のとき UNTIL も日付(RFC 5545 §3.3.10)
        ev.push(`RRULE:${freqOf(it.repeat, start, 0)}${until === null ? '' : `;UNTIL=${compactDate(until)}`}`);
        if (exdates.length > 0)
          ev.push(`EXDATE;VALUE=DATE:${exdates.map(compactDate).join(',')}`);
      }
    }

    ev.push(`SUMMARY:${escapeText(it.text.trim() === '' ? '(題名なし)' : it.text)}`);
    const title = it.line === null ? undefined : opts.noteTitle?.(it.lid);
    if (title !== undefined && title !== '') ev.push(`DESCRIPTION:${escapeText(`ノート: ${title}`)}`);
    ev.push('END:VEVENT');
    lines.push(...ev);
    count += 1;
  }

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PKC3//Schedule//JA',
    'CALSCALE:GREGORIAN',
    ...(usesTokyo ? VTIMEZONE_TOKYO : []),
  ];
  const all = [...head, ...lines, 'END:VCALENDAR'];
  return { text: all.map(foldLine).join('\r\n') + '\r\n', count, skipped };
}
