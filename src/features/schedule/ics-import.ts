/**
 * 🔴 **カレンダー形式(`.ics`、RFC 5545)を読んで、予定の行にする**(#855 段 D の取り込み側)。
 *
 * 書き出し(`ics.ts`)の**逆向き**である。出口は「Outlook / Google カレンダーから出した予定を
 * PKC3 の予定表に入れる」こと。⚠ 取り込みは**読めない物を黙って落とさない**のが要で、
 * 読めなかった物は**種類ごとに数えて**呼び側が user に言う。
 *
 * ## 作られる物 ── 新しい記法は作らない
 *
 * 1 つの file から、チェック項目の並びを 1 本(`- [ ] @2026-08-31 14:00..15:00 毎週 会議`)。
 * ⚠ 予定表の札の正体は**チェック項目**(`task-cards.ts`)なので、`- ` だけの箇条書きにすると
 * **予定表に出ない**。場所とメモは**字下げした補足の行**(`  - 場所: …`)にする
 * (チェック項目ではないので札にならず、予定の行の下に読める形で残る)。
 *
 * ## 読み替え(書き出しの逆)
 *
 * | カレンダー形式 | PKC3 の記法 |
 * |---|---|
 * | `DTSTART;VALUE=DATE` | `@日付`(終日) |
 * | `DTEND;VALUE=DATE`(**排他**) | 1 日引いた日を終わりにして `@開始..終わり`(1 日だけなら単日) |
 * | `DTSTART`(UTC `Z` / `TZID` / 浮動) | **端末の壁時計**に直して `@日付 HH:mm`(`DTEND` が同じ日なら `..HH:mm`) |
 * | `RRULE:FREQ=DAILY/WEEKLY/MONTHLY/YEARLY` | `毎日` `毎週` `毎月` `毎年` |
 * | `FREQ=WEEKLY;INTERVAL=2` | `隔週` |
 * | `FREQ=WEEKLY;BYDAY=MO,WE,FR` | `毎週 月水金` |
 * | `UNTIL` | 終わりの日(`@開始..終わり 毎週`)── ⚠ **終日の予定だけ**(下) |
 *
 * ## 🔴 読めない形は「1 回目だけ」入れる
 *
 * `COUNT` / `EXDATE` / `RDATE` / 刻みの間隔(2 週以外)/ 位置指定(月末の形以外)/ 日の列 /
 * 時・分の繰り返し … は PKC3 の記法で言えない。**1 回目の予定は入れ**、繰り返しを読めなかった数に数える
 * (繰り返しを黙って付けたり、予定ごと落としたりしない)。
 *
 * ⚠ **時刻つきの繰り返しの `UNTIL` も言えない**: 終わりは `..` で書くが、日付の期間には時刻を付けない
 * (`line-date.ts`)ので、`@開始..終わり 14:00 毎週` は時刻が落ちる。終わりを無視して無限に繰り返すより
 * 安全な「1 回目だけ」へ倒す。
 *
 * ## 🔴 pure module ── DOM も時計も持たない
 *
 * 端末の時刻帯は `localZone`(IANA 名)で呼び側が渡せる(渡さなければ `Intl` の既定)。
 * 変換は `Intl.DateTimeFormat` で行い、`Date` の端末依存の getter に頼らない。
 */
import { addDays, daysBetween } from '../datetime/date-math';
import { storedDateParts } from '../datetime/stored-date';
import { formatLineDate, readLineDate } from './line-date';
import { isScheduleTimeRange } from './schedule-date';
import type { RepeatUnit } from './repeat';

/** 取り込む file の大きさの上限(バイト)。普通のカレンダーは数百 KB。 */
export const ICS_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
/** 1 つの file から作る予定の上限。超えたら**file ごと断る**(途中までは入れない)。 */
export const ICS_IMPORT_MAX_EVENTS = 5000;

/** 取込の振り分けが見る拡張子(`isVcfFileName` と同じ作法 ── 中身では決めない)。 */
export function isIcsFileName(name: string): boolean {
  return /\.(ics|ical|icalendar)$/i.test(name);
}

/** 取り込んだノートの題名。 */
export function icsNoteTitle(fileName: string): string {
  return `取り込んだ予定 ${fileName}`;
}

/** 読み取れた予定 1 件。 */
export interface IcsEvent {
  /** `YYYY-MM-DD`(端末の壁時計)。 */
  readonly date: string;
  readonly time: string | null;
  readonly timeEnd: string | null;
  /** 終日の期間の終わり、または繰り返しの終わり。 */
  readonly until: string | null;
  readonly repeat: RepeatUnit | null;
  readonly summary: string;
  readonly location: string;
  readonly description: string;
}

/** 読めなかった物の数。⚠ **全部を user に言う**(黙って落とさない)。 */
export interface IcsCounts {
  /** `STATUS:CANCELLED` で入れなかった数。 */
  readonly cancelled: number;
  /** 繰り返しを読めず、1 回目だけ入れた数。 */
  readonly repeatUnread: number;
  /** 日付を読めず、入れられなかった数。 */
  readonly invalid: number;
  /** 知らない時刻帯の名前で、時刻をそのまま(端末の時刻として)入れた数。 */
  readonly zoneUnknown: number;
  /** 日をまたぐ時刻つきの予定で、終わりを入れず開始だけ入れた数。 */
  readonly spansDays: number;
  /** 繰り返しの 1 回だけを書き換えた予定(`RECURRENCE-ID`)を、単独の予定として入れた数。 */
  readonly overrides: number;
  /** 夏時間のあるタイムゾーンをまたぐ繰り返しの数(季節をまたぐと 1 時間ずれうる)。 */
  readonly zoneRepeat: number;
}

export interface IcsParse {
  readonly events: readonly IcsEvent[];
  readonly counts: IcsCounts;
  /** 予定が `maxEvents` を超えた(読むのを途中で止めた。呼び側は file ごと断る)。 */
  readonly overLimit: boolean;
}

export interface IcsParseOptions {
  /** 端末の時刻帯(IANA 名)。無ければ `Intl` の既定。 */
  readonly localZone?: string;
  /** 読む予定の上限(既定 `ICS_IMPORT_MAX_EVENTS`)。超えたら読むのをやめる。 */
  readonly maxEvents?: number;
}

// ── 行の読み ──────────────────────────────────────────────

/**
 * 折り返しをほどく(CRLF / LF / CR、続きの行は空白かタブで始まる)。
 * ⚠ 続きの行の**先頭の 1 字だけ**を捨てる(それ以上の空白は中身)。
 */
export function unfoldIcs(text: string): string[] {
  const raw = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** TEXT 値のエスケープを戻す(`\n` `\,` `\;` `\\`)。 */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

interface Prop {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
}

/** `NAME;P=v;P2="a;b":value` を分ける。`:` が無い行は `null`。 */
function parseProp(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = '';
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const params = new Map<string, string>();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, ''));
  }
  return { name: parts[0]!.toUpperCase(), params, value };
}

// ── 時刻帯 ───────────────────────────────────────────────

/** Outlook が使う Windows の時刻帯名 → IANA(よく出る物だけ。無ければ知らない時刻帯として数える)。 */
export const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Singapore Standard Time': 'Asia/Singapore',
  'India Standard Time': 'Asia/Kolkata',
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();
function formatterOf(tz: string): Intl.DateTimeFormat | null {
  let f = fmtCache.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      f = null;
    }
    // 🔴 上限つき(1 file に別々の TZID が何千とあっても、表が育ち続けない)
    if (fmtCache.size >= 64) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  return f;
}

/** IANA 名(または Windows 名)を、`Intl` が知る名前へ。知らなければ `null`。 */
function resolveZone(tzid: string): string | null {
  const name = WINDOWS_ZONES[tzid] ?? tzid;
  return formatterOf(name) === null ? null : name;
}

interface Wall {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
}

/** ある瞬間(UTC ミリ秒)の、その時刻帯の壁時計。 */
function wallAt(tz: string, ms: number): Wall {
  const parts = formatterOf(tz)!.formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
}

function offsetMinutesAt(tz: string, ms: number): number {
  const w = wallAt(tz, ms);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60000) * 60000) / 60000);
}

/** その時刻帯の壁時計 → UTC ミリ秒(夏時間の境目は 2 回で収束させる)。 */
function wallToMs(tz: string, w: Wall): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const first = guess - offsetMinutesAt(tz, guess) * 60000;
  const second = guess - offsetMinutesAt(tz, first) * 60000;
  return second;
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const wallDate = (w: Wall): string => `${String(w.y).padStart(4, '0')}-${p2(w.mo)}-${p2(w.d)}`;
const wallTime = (w: Wall): string => p2(w.h) + ':' + p2(w.mi);

// ── 日付・時刻の値 ─────────────────────────────────────────

type Parsed =
  | { readonly kind: 'date'; readonly date: string }
  | {
      readonly kind: 'time';
      readonly date: string;
      readonly time: string;
      /** 元の値を言い表した壁時計。 */
      readonly wall: Wall;
      /** `Z`(UTC) */
      readonly utc: boolean;
      /** 読めた時刻帯の名前。浮動なら `null`。 */
      readonly tz: string | null;
      /** 時刻帯の名前が付いていたが `Intl` が知らない。 */
      readonly unknownZone: boolean;
    };

function validYmd(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function parseValue(prop: Prop): Parsed | null {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(v);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!validYmd(y, mo, d)) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined || prop.params.get('VALUE') === 'DATE') return { kind: 'date', date };
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59) return null;
  const utc = m[7] !== undefined;
  const tzid = prop.params.get('TZID');
  const tz = utc ? 'UTC' : tzid === undefined ? null : resolveZone(tzid);
  return {
    kind: 'time',
    date,
    time: p2(h) + ':' + p2(mi),
    wall: { y, mo, d, h, mi },
    utc,
    tz,
    unknownZone: !utc && tzid !== undefined && tz === null,
  };
}

/** 端末の壁時計へ。浮動(時刻帯なし)と端末と同じ時刻帯は**そのまま**(境目の揺れを避ける)。 */
function toLocal(p: Extract<Parsed, { kind: 'time' }>, localZone: string): { date: string; time: string } {
  if (p.tz === null || p.tz === localZone) return { date: p.date, time: p.time };
  const w = wallAt(localZone, wallToMs(p.tz, p.wall));
  return { date: wallDate(w), time: wallTime(w) };
}

/** 予定の長さとして読む上限(日)。 */
const DURATION_MAX_DAYS = 36500;

/** `P1D` / `PT1H30M` / `P1W` → 分と日。読めなければ・大きすぎれば `null`。 */
function parseDuration(value: string): { days: number; minutes: number } | null {
  // 🔴 大きさは下の上限で切る(`P99999999999999999999D` が NaN の日付や RangeError になり、file 全体が落ちた)
  const m = /^[+]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    value.trim(),
  );
  if (m === null || value.trim().replace(/^[+]?P/i, '') === '') return null;
  const n = (s: string | undefined): number => (s === undefined ? 0 : Number(s));
  const days = n(m[1]) * 7 + n(m[2]);
  const minutes = n(m[3]) * 60 + n(m[4]);
  // 100 年を超える長さは予定の長さとして読まない(無視 = 長さの無い予定)
  if (days > DURATION_MAX_DAYS || minutes > DURATION_MAX_DAYS * 1440) return null;
  return { days, minutes };
}

// ── 繰り返し ──────────────────────────────────────────────

const BYDAY_NUM: Readonly<Record<string, number>> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function weekdayOf(date: string): number {
  const p = storedDateParts(date)!;
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  return d === 0 ? 7 : d;
}

interface RuleResult {
  /** `null` = 言えない形(1 回目だけ入れる)。 */
  readonly repeat: RepeatUnit | null;
  readonly until: string | null;
}

/**
 * RRULE → 刻みと終わり。⚠ **読めたと言える形だけ**通す(推測で近い形に寄せない)。
 *
 * @param start 端末の壁時計の開始日
 * @param shift 元の時刻帯の日付から端末の日付へ動いた日数(BYDAY の曜日を同じだけずらす)
 */
function readRule(
  rule: string,
  start: string,
  shift: number,
  timed: boolean,
  localZone: string,
  /** 終日の期間(`@開始..終わり`)か。 */
  spans: boolean,
): RuleResult | null {
  const kv = new Map<string, string>();
  for (const part of rule.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    kv.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1).toUpperCase());
  }
  const known = new Set(['FREQ', 'INTERVAL', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST']);
  for (const k of kv.keys()) if (!known.has(k)) return null; // COUNT / BYHOUR / BYWEEKNO …
  const freq = kv.get('FREQ');
  const interval = kv.has('INTERVAL') ? Number(kv.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  if (spans) return null; // 期間の繰り返しは言えない(`@開始..終わり` の `..` は繰り返しの終わりと兼ねる)

  // 終わり
  let until: string | null = null;
  const rawUntil = kv.get('UNTIL');
  if (rawUntil !== undefined) {
    if (timed) return null; // 時刻つきの繰り返しの終わりは言えない(上の注記)
    const u = parseValue({ name: 'UNTIL', params: new Map(), value: rawUntil });
    if (u === null) return null;
    until = u.kind === 'date' ? u.date : toLocal(u, localZone).date;
    if (until < start) return null;
  }

  const byday = kv.get('BYDAY');
  const days: number[] = [];
  if (byday !== undefined) {
    for (const code of byday.split(',')) {
      const n = BYDAY_NUM[code.toUpperCase()];
      if (n === undefined) return null; // `1MO`(第 1 月曜)など
      days.push((((n - 1 + shift) % 7) + 7) % 7 + 1);
    }
  }
  const bymonthday = kv.get('BYMONTHDAY');
  const bymonth = kv.get('BYMONTH');
  const bysetpos = kv.get('BYSETPOS');
  const sp = storedDateParts(start)!;
  const day = Number(sp.day);
  const wd = weekdayOf(start);

  if (freq === 'DAILY') {
    if (interval !== 1 || byday || bymonthday || bymonth || bysetpos) return null;
    return { repeat: 'day', until };
  }
  if (freq === 'WEEKLY') {
    if (bymonthday || bymonth || bysetpos) return null;
    const uniq = [...new Set(days)].sort((a, b) => a - b);
    if (uniq.length >= 2) {
      if (interval !== 1 || !uniq.includes(wd)) return null;
      return { repeat: `days:${uniq.join('')}` as RepeatUnit, until };
    }
    if (uniq.length === 1 && uniq[0] !== wd) return null;
    if (interval === 1) return { repeat: 'week', until };
    if (interval === 2) return { repeat: 'biweek', until };
    return null;
  }
  if (freq === 'MONTHLY') {
    // 🔴 タイムゾーンの変換で日付が動いたら、月の日(1 日 → 前月末日)の意味が変わる
    if (interval !== 1 || byday || bymonth || shift !== 0) return null;
    if (bymonthday === undefined && bysetpos === undefined) {
      // 29〜31 日は、無い月を RFC は飛ばし PKC3 は月末へ寄せる ── 同じと言えない
      return day >= 29 ? null : { repeat: 'month', until };
    }
    if (shift !== 0 || bymonthday === undefined) return null;
    const set = bymonthday.split(',').map(Number);
    if (bysetpos === '-1') {
      // 書き出しの月末の形(28..k の最後)
      const k = set[set.length - 1]!;
      const consecutive = set.every((n, i) => n === 28 + i);
      return consecutive && set.length >= 2 && k === day ? { repeat: 'month', until } : null;
    }
    if (bysetpos === undefined && set.length === 1 && set[0] === day && day <= 28)
      return { repeat: 'month', until };
    return null;
  }
  if (freq === 'YEARLY') {
    if (interval !== 1 || byday || shift !== 0) return null;
    const month = Number(sp.month);
    if (bysetpos === '-1') {
      if (shift === 0 && bymonth === '2' && bymonthday === '28,29' && month === 2 && day === 29)
        return { repeat: 'year', until };
      return null;
    }
    if (bysetpos !== undefined) return null;
    if (bymonth !== undefined && (shift !== 0 || Number(bymonth) !== month)) return null;
    if (bymonthday !== undefined && (shift !== 0 || Number(bymonthday) !== day)) return null;
    if (month === 2 && day === 29) return null; // 閏日は RFC は飛ばし PKC3 は 2/28 へ寄せる
    return { repeat: 'year', until };
  }
  return null;
}

// ── 全体 ─────────────────────────────────────────────────

function defaultZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 題名・場所の長さの上限(字)。 */
const TEXT_MAX = 500;
const cap = (s: string): string => {
  const cs = Array.from(s);
  return cs.length <= TEXT_MAX ? s : cs.slice(0, TEXT_MAX).join('') + '…';
};

/** 冬と夏で UTC との差が違う時刻帯か(夏時間がある)。 */
function observesDst(tz: string): boolean {
  return offsetMinutesAt(tz, Date.UTC(2026, 0, 1)) !== offsetMinutesAt(tz, Date.UTC(2026, 6, 1));
}

const clean = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();

/** カレンダー形式の本文を読む。壊れた入力でも例外を投げない(読めた分だけ返す)。 */
export function parseIcs(text: string, opts: IcsParseOptions = {}): IcsParse {
  const localZone = opts.localZone ?? defaultZone();
  const events: IcsEvent[] = [];
  const c = { cancelled: 0, repeatUnread: 0, invalid: 0, zoneUnknown: 0, spansDays: 0, overrides: 0, zoneRepeat: 0 };

  let inEvent = false;
  /** VEVENT の中の入れ子(VALARM など)の深さ。⚠ 中の行は予定の物ではない。 */
  let nested = 0;
  let props: Prop[] = [];

  const finishInner = (): void => {
    const first = (name: string): Prop | undefined => props.find((p) => p.name === name);
    const status = first('STATUS')?.value.trim().toUpperCase();
    if (status === 'CANCELLED') {
      c.cancelled += 1;
      return;
    }
    const dtstartProp = first('DTSTART');
    const start = dtstartProp === undefined ? null : parseValue(dtstartProp);
    if (start === null) {
      c.invalid += 1;
      return;
    }
    const isOverride = first('RECURRENCE-ID') !== undefined;
    let unreadable = false;
    let date: string;
    let time: string | null = null;
    let timeEnd: string | null = null;
    let until: string | null = null;
    let shift = 0;
    let spans = false;
    let startTz: string | null = null;
    const endProp = first('DTEND');
    const endVal = endProp === undefined ? null : parseValue(endProp);
    const durProp = first('DURATION');
    const dur = durProp === undefined ? null : parseDuration(durProp.value);

    if (start.kind === 'date') {
      date = start.date;
      let lastDay: string | null = null;
      if (endVal !== null && endVal.kind === 'date') lastDay = addDays(endVal.date, -1);
      else if (endVal !== null && endVal.kind === 'time') lastDay = endVal.date;
      else if (dur !== null) lastDay = addDays(date, Math.max(dur.days - 1, 0));
      // 🔴 形が日付でなければ(桁あふれ等)単日にする
      if (lastDay !== null && /^\d{4}-\d{2}-\d{2}$/.test(lastDay) && lastDay > date) {
        until = lastDay;
        spans = true;
      }
    } else {
      if (start.unknownZone) c.zoneUnknown += 1;
      startTz = start.tz;
      const local = toLocal(start, localZone);
      date = local.date;
      time = local.time;
      shift = daysBetween(start.date, local.date) ?? 0;
      let endLocal: { date: string; time: string } | null = null;
      if (endVal !== null && endVal.kind === 'time') {
        endLocal = toLocal(endVal, localZone);
      } else if (endVal === null && dur !== null) {
        const w = wallToMs(localZone, {
          y: Number(date.slice(0, 4)),
          mo: Number(date.slice(5, 7)),
          d: Number(date.slice(8, 10)),
          h: Number(time.slice(0, 2)),
          mi: Number(time.slice(3, 5)),
        });
        const e = wallAt(localZone, w + (dur.days * 1440 + dur.minutes) * 60000);
        endLocal = { date: wallDate(e), time: wallTime(e) };
      }
      if (endLocal !== null && endLocal.date === date && isScheduleTimeRange(time, endLocal.time)) {
        // 開始と同じ時刻(長さ 0)は幅にしない
        if (endLocal.time !== time) timeEnd = endLocal.time;
      } else if (endLocal !== null && endLocal.date !== date) {
        c.spansDays += 1;
      }
    }

    let repeat: RepeatUnit | null = null;
    const rrule = first('RRULE');
    const hasUnsayable = props.some((p) => p.name === 'EXDATE' || p.name === 'RDATE' || p.name === 'EXRULE');
    if (rrule !== undefined || hasUnsayable) {
      const res =
        rrule === undefined || hasUnsayable || props.filter((p) => p.name === 'RRULE').length > 1
          ? null
          : readRule(rrule.value, date, shift, time !== null, localZone, spans);
      if (res === null) {
        unreadable = true;
      } else {
        repeat = res.repeat;
        until = res.until;
      }
    }
    if (unreadable) c.repeatUnread += 1;
    else if (repeat !== null && startTz !== null && startTz !== localZone && (observesDst(startTz) || observesDst(localZone)))
      c.zoneRepeat += 1;
    if (isOverride) c.overrides += 1;

    const textOf = (n: string): string => {
      const p = first(n);
      return p === undefined ? '' : unescapeText(p.value);
    };
    const summary = cap(clean(textOf('SUMMARY')));
    events.push({
      date,
      time,
      timeEnd,
      until,
      repeat,
      summary: summary === '' ? '(題名なし)' : summary,
      location: cap(clean(textOf('LOCATION'))),
      description: cap(clean(textOf('DESCRIPTION'))),
    });
  };

  /** 🔴 1 件が落ちても file 全体は落とさない。落ちた件は日付を読めなかった数に入れる。 */
  const finish = (): void => {
    const before = { ...c };
    const n = events.length;
    try {
      finishInner();
    } catch {
      Object.assign(c, before);
      events.length = n;
      c.invalid += 1;
    }
  };
  const maxEvents = opts.maxEvents ?? ICS_IMPORT_MAX_EVENTS;
  let overLimit = false;

  for (const line of unfoldIcs(text)) {
    const up = line.toUpperCase();
    if (!inEvent) {
      if (up === 'BEGIN:VEVENT') {
        inEvent = true;
        nested = 0;
        props = [];
      }
      continue;
    }
    if (up === 'BEGIN:VEVENT') {
      // 🔴 閉じずに次の VEVENT が始まった: 前の予定は数えて捨て、新しい予定を始める
      c.invalid += 1;
      nested = 0;
      props = [];
      continue;
    }
    if (up.startsWith('BEGIN:')) {
      nested += 1;
      continue;
    }
    if (up.startsWith('END:')) {
      if (nested > 0) nested -= 1;
      else if (up === 'END:VEVENT') {
        inEvent = false;
        finish();
        if (events.length > maxEvents) {
          overLimit = true;
          break;
        }
      }
      continue;
    }
    if (nested > 0) continue;
    const prop = parseProp(line);
    if (prop !== null) props.push(prop);
  }
  // 閉じていない VEVENT は読まない(途中で切れた file の半端な予定を作らない)
  if (inEvent) c.invalid += 1;
  return { events, counts: c, overLimit };
}

// ── 本文にする ────────────────────────────────────────────

const DESCRIPTION_MAX = 300;

/** 予定 1 件 → チェック項目の 1 行。⚠ 読み戻して食い違えば、題名を「」で囲んで記法と切り離す。 */
function lineOf(e: IcsEvent): string {
  const head = formatLineDate(e.date, e.time, e.until, e.repeat, undefined, e.timeEnd);
  const attempt = (summary: string): string => `- [ ] ${head} ${summary}`;
  const same = (line: string): boolean => {
    const r = readLineDate(line.slice('- [ ] '.length));
    return (
      r !== null &&
      r.date === e.date &&
      r.time === e.time &&
      r.timeEnd === e.timeEnd &&
      r.until === e.until &&
      r.repeat === e.repeat
    );
  };
  const plain = attempt(e.summary);
  return same(plain) ? plain : attempt(`「${e.summary}」`);
}

/** 予定の並び → ノートの本文。 */
export function icsNoteBody(events: readonly IcsEvent[]): string {
  const out: string[] = [];
  for (const e of events) {
    out.push(lineOf(e));
    if (e.location !== '') out.push(`  - 場所: ${e.location}`);
    if (e.description !== '') {
      const d =
        e.description.length > DESCRIPTION_MAX ? `${e.description.slice(0, DESCRIPTION_MAX)}…` : e.description;
      out.push(`  - メモ: ${d}`);
    }
  }
  return out.join('\n') + '\n';
}

/** 読めなかった数を、user に言う文にする(0 の項目は言わない)。 */
export function icsCountNotes(c: IcsCounts): string[] {
  const out: string[] = [];
  if (c.repeatUnread > 0) out.push(`${c.repeatUnread} 件は繰り返しを読めず 1 回目だけ入れました`);
  if (c.spansDays > 0) out.push(`${c.spansDays} 件は日をまたぐため開始の時刻だけ入れました`);
  if (c.zoneUnknown > 0) out.push(`${c.zoneUnknown} 件はタイムゾーンを読めず、書かれた時刻のまま入れました`);
  if (c.zoneRepeat > 0)
    out.push(`${c.zoneRepeat} 件は別のタイムゾーンの繰り返しで、夏時間をまたぐと 1 時間ずれることがあります`);
  if (c.overrides > 0) out.push(`${c.overrides} 件は繰り返しの 1 回だけを変えた予定で、元の繰り返しと別に入れました`);
  if (c.cancelled > 0) out.push(`${c.cancelled} 件は取り消された予定なので入れていません`);
  if (c.invalid > 0) out.push(`${c.invalid} 件は日付を読めず入れていません`);
  return out;
}
