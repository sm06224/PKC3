/**
 * 🔴 **繰り返しの予定を、日の並びへ展開する**(#344 段②)。
 *
 * ## 記法 ── 終わりは既存の期間を使い回す
 *
 * | 書き方 | 意味 |
 * |---|---|
 * | `@2026-08-31 毎週` | 8/31(月)から**毎週月曜**。⚠ 曜日は**開始日から取る** |
 * | `@2026-08-31..2026-12-31 毎週` | 🔑 終わりは**既存の `..`** ── 「8/31 から 12/31 まで、毎週」 |
 * | `毎日` / `毎月` / `毎年` | 同じ形 |
| `@2026-08-31 隔週` | 🔑 **2 週ごと**(8/31 → 9/14 → 9/28 …)。起点は**開始日**(`毎週` と同じ) |
| `@2026-08-31 毎週 月水金` | 🔑 **曜日の列**。月・水・金に出る(2 つ以上書いたときだけ。区切りは `、` `,` `，` `・` も可) |
 *
 * 🔑 **終了条件の記法を新しく作らない。** `..` は既に「開始と終わり」を表しており、
 * そこに刻みが付くだけである。⚠ 刻みの語が無ければこれまでどおり
 * 「その期間ずっと」の意味で、**既存の本文の意味は 1 つも変わらない**。
 *
 * 🔑 **曜日は書かなくてよい**(開始日から取る)。書くなら `毎週火曜` と 1 つ(依頼 186。書いたとおりの曜日に出る ──
 * 始まりの日の曜日と違ってもよい)。それ以外の言い方(英語・略記)は解かない
 * (日本語・英語・略記の表が要る)。複数の曜日だけ、`毎週 月水金` と 1 字ずつ書ける
 * (#855。⚠ 直後が字のとき ── `毎週 日報` ── は曜日として読まない)。
 *
 * ## 🔴 pure module ── 時計も DOM も持たない
 *
 * 「いま画面が見せている窓」は**呼び側が渡す**。⚠ 渡さないと
 * `@2020-01-06 毎週` が**今日に着くまでに 300 回以上**出る。
 *
 * ## ⚠ この module は「出す日」を決めるだけ
 *
 * 押せるか(チェック)・掴めるか(移動)は別の段である。
 * 🔑 済んだ回は**その日の実体の行**になり、`skip` として渡ってくる ──
 * だから**例外日の記法を別に作らなくてよい**。
 */

import { addDays, daysBetween } from '@features/datetime/date-math';
import { isScheduleDate } from './schedule-date';
import { storedDateParts } from '@features/datetime/stored-date';
import { pad2 } from '@features/datetime/datetime-format';

/** 刻み。⚠ **並びが画面の並び**(短い順)。 */
export const REPEAT_UNITS = ['day', 'week', 'biweek', 'month', 'year'] as const;
export type BaseRepeatUnit = (typeof REPEAT_UNITS)[number];

/**
 * 🔴 **曜日の列**(`毎週 月水金`)。綴りは `days:135`(月=1 … 日=7 を昇順で並べた数字)。
 * 🔑 刻みを 1 つの文字列に収める ── 札の属性(`data-pkc-task-repeat`)・書き換えの受け渡しが
 *   すべて `RepeatUnit` 1 本で通っているので、**型を増やさずに**載せる。
 */
export type WeekdaysUnit = `days:${string}`;
export type RepeatUnit = BaseRepeatUnit | WeekdaysUnit;

/**
 * 画面に出す語 ⇄ 刻み。
 * ⚠ **user に `week` と見せない**(`relationLabel` と同じ作法)。
 */
export const REPEAT_WORDS: Readonly<Record<BaseRepeatUnit, string>> = {
  day: '毎日',
  week: '毎週',
  biweek: '隔週',
  month: '毎月',
  year: '毎年',
};

/** 曜日の字 ⇄ 数字(月=1 … 日=7)。⚠ 並びが書きの並び(月から)。 */
const WEEKDAY_CHARS = '月火水木金土日';

const WEEKDAYS_PREFIX = 'days:';

/** 曜日の列の中身(`days:135` → [1,3,5])。列でなければ `null`。 */
export function weekdaysOf(unit: RepeatUnit): readonly number[] | null {
  if (!unit.startsWith(WEEKDAYS_PREFIX)) return null;
  const digits = unit.slice(WEEKDAYS_PREFIX.length);
  // 🔴 1 つでもよい(`毎週火曜` ── 台帳 #1852 束 E1、依頼 186)。⚠ 表に無い綴り(`days:` だけ・8 など)は列ではない
  return /^[1-7]{1,7}$/.test(digits) ? [...digits].map(Number) : null;
}

/**
 * 🔴 **画面と本文に出す語**(`毎週 月水金` もここ 1 本)。
 * ⚠ 呼び側が `REPEAT_WORDS[unit]` を引かない ── 曜日の列は表に無い。
 */
export function repeatWord(unit: RepeatUnit): string {
  const days = weekdaysOf(unit);
  if (days === null) return REPEAT_WORDS[unit as BaseRepeatUnit];
  // 🔑 1 つだけのときは `曜` を付ける ── 読む側(`readRepeatTail`)が `毎週 火` の 1 字は読まないので、往復で消えない形にする
  if (days.length === 1) return `${REPEAT_WORDS.week} ${WEEKDAY_CHARS[days[0]! - 1]}曜`;
  return `${REPEAT_WORDS.week} ${days.map((d) => WEEKDAY_CHARS[d - 1]).join('')}`;
}

/**
 * 🔴 **曜日の列を、日数ぶん回す**(#1087。「全部動かす」で開始日と一緒に曜日の列も動かす)。
 *
 * `days:135`(月水金)を +1 日 → `days:246`(火木土)、+2 日 → `days:357`。
 * 負の差・7 日を超える差も受ける(7 で割った余り)。⚠ 曜日の列でない刻み(`week` / `biweek` …)は
 * **そのまま返す** ── 隔週や毎週は開始日だけで曜日が決まるので、列は無い。
 */
export function shiftWeekdaysUnit(unit: RepeatUnit, days: number): RepeatUnit {
  const set = weekdaysOf(unit);
  if (set === null || !Number.isInteger(days)) return unit;
  const shifted = new Set(set.map((d) => ((((d - 1 + days) % 7) + 7) % 7) + 1));
  return `${WEEKDAYS_PREFIX}${[...shifted].sort((a, b) => a - b).join('')}` as WeekdaysUnit;
}

/**
 * 語から刻みを読む。知らない語なら `null`。
 * 🔑 **表は 1 つ**(`REPEAT_WORDS`)から引く ── 2 つ持つと、片方に足し忘れる。
 */
/**
 * 🔴 **内部の綴り(`week`)が刻みか**(#855 段 0 の 3 つ目、2026-09-13)。
 *
 * ⚠ 上の `repeatUnitOf` は**画面の語**(`毎週`)を読む ── こちらは
 *   **札に焼いた属性**(`data-pkc-task-repeat="week"`)を読み戻すためのもので、
 *   見ている物が違う。🔑 どちらも表は `REPEAT_UNITS` / `REPEAT_WORDS` の 1 つから引く。
 * ⚠ `null`(属性が無い)も受けて `false` を返す ── 呼び側に 2 段の判定を書かせない。
 */
export function isRepeatUnit(raw: string | null): raw is RepeatUnit {
  if (raw === null) return false;
  if ((REPEAT_UNITS as readonly string[]).includes(raw)) return true;
  return weekdaysOf(raw as RepeatUnit) !== null;
}

export function repeatUnitOf(word: string): BaseRepeatUnit | null {
  for (const u of REPEAT_UNITS) if (REPEAT_WORDS[u] === word) return u;
  return null;
}

/**
 * 🔴 **記法の尻に付く刻みの語を読む**(#344 段②)。
 *
 * ⚠ **走査の網(`AT_DATE`)を広げない。** 網を広げると、いま通っている
 *   日付・期間・時刻の読み方まで一緒に変わる ── 変えたのは尻だけなので、
 *   **尻だけを別に見る**(read は増やすが、既存の読みは 1 バイトも動かない)。
 * ⚠ 空白は**無くてもよい**(`@2026-08-31毎週`)── 日本語には語の切れ目に
 *   空白が無いので、求めると**日本語で書く人だけ書けない**(`line-date.ts` の
 *   「`@` の前に境目を求めない」と同じ理由)。
 *
 * @param rest 日付(期間・時刻を含む)の**直後**から行末まで
 */
const REPEAT_TAIL = /^[ \t\u3000]*(毎[日週月年]|隔週)/;

/**
 * 🔴 **`毎週` の直後の曜日の列**(`毎週 月水金` / `毎週 月、水、金`)。
 *
 * ⚠ **読み始める条件を絞る 3 つの門**(`毎週 日報` `毎週 月曜` のような普通の文を食べないため):
 *  ① **2 つ以上**の曜日が要る ── `毎週 月` 1 つなら、これまでどおり「毎週 + 字」
 *  ② 列の**直後が字でない**(末尾・空白・句読点・括弧)── `毎週 日報` `毎週 月曜` の
 *     「日」「月」は曜日として食べない。🔑 **列は短く切らない**: 区切りの直後に曜日が続く形は
 *     列全体で判定し、直後が字なら列としては読まない(`毎週 月、水、金曜に` を月水へ縮めて
 *     金を黙って落とさない)。末尾の読点(`毎週 月水、会議`)は区切りではなく句読点なので、月水
 *  ③ 重複を畳んで 2 つ未満なら読まない(`月月`)
 * 区切りは `、` `,` `，` `・` `､` `･`(日本語入力のまま打った形)と空白。
 *
 * ⚠ **意味が変わる本文は在る**(正直に):これまで「毎週 + 字」だった `毎週 土日` /
 *   `毎週 月・水 打合せ` / `毎週 月 水 会議` は、今回から曜日の列として読む。
 *   `隔週の定例` のように「隔週」で始まる字も、今回から隔週の繰り返しとして読む。
 */
const WEEKDAY_TAIL =
  /^[ \t\u3000]*([月火水木金土日](?:[ \t\u3000]*[,、，・､･][ \t\u3000]*[月火水木金土日]|[ \t\u3000]*[月火水木金土日])+)(?:曜日?)?(?![ \t\u3000]*[,、，・､･]?[ \t\u3000]*[月火水木金土日])(?=$|[\s。、，,.．:：;；!！?？)）\]」』】］(（[［「『【])/;

/**
 * 🔴 **`毎週` の直後の曜日 1 つ**(`毎週火曜` / `毎週 火曜日`。台帳 #1852 束 E1、Gemini 裁定 = #1163 の依頼 186 の A)。
 *
 * 書いたとおりに出す:`@2026-10-19 毎週火曜`(10/19 は月曜)は**火曜**に出る(始まりの日の曜日に引きずられない)。
 * ⚠ **`曜` を書いたときだけ**読む ── `毎週 日報` `毎週 月` の 1 字は、これまでどおり「毎週 + 字」(題名に残る)。
 */
const SINGLE_WEEKDAY_TAIL = /^[ \t\u3000]*([月火水木金土日])曜日?/;

/**
 * 🔴 **振替の記法**(#855 決4。user 裁定 2026-09-13「1 回か全部か選択する」)。
 *
 * `- [ ] 定例会 @2026-09-22 振替2026-09-20`
 * = 「この行は **9/20 の回の代わり**です」。
 *
 * ## なぜ規則の行に「除く」を足さないか
 *
 * 素直な形は規則の行へ `除く2026-09-20` を足すことだが、**採らない** ──
 * 🔴 **動かした行を消したときに、元の回が戻ってこない**(規則に「除く」だけが残り、
 *   その回は静かに消えたままになる = **片道の操作**。user 裁定 2026-08-23)。
 * 🔑 **動かした行のほうに書く**と、行を消せば元の回がそのまま戻る ──
 *   取り消しのための仕掛けが要らない。
 *
 * ## 🔑 展開の側に新しい分岐は要らない
 *
 * 済んだ回の実体が `skip` として渡る仕掛け(`materializedDates`)が既に在るので、
 * **その集合に「元の日」を足すだけ**である。
 *
 * ⚠ **繰り返しの行には付けない** ── 規則の行が同時に「誰かの代わり」であることは
 *   意味を成さない(`line-date.ts` が `repeat === null` のときだけ読む)。
 */
const SUBSTITUTE_TAIL = /^[ \t\u3000]*振替(\d{4}-\d{2}-\d{2})/;

/** 画面と本文に出る語。⚠ 表は 1 つ(綴りを 2 か所に書かない ── CLAUDE.md §7)。 */
export const SUBSTITUTE_WORD = '振替';

export interface SubstituteTail {
  /** 代わりになっている**元の回の日**。 */
  readonly date: string;
  /** 語までの長さ(前の空白を含む)。⚠ **記法の範囲を伸ばす**のに使う。 */
  readonly length: number;
}

/**
 * 日付(と時刻)の直後から「振替<日>」を読む。読めなければ `null`。
 *
 * ⚠ **見るのは「形」だけ**である(`isScheduleDate`)── `2026-13-45` は**通る**。
 *   🔑 これは `schedule-date.ts` の方針どおりで、実在しない日を弾くと
 *   **user が書いた字が黙って消える**(見て直せなくなる)。
 * ⚠ 通しても害は無い ── 塞ぐ日の集合に入るだけで、**その日には回が落ちない**ので
 *   何も起きない。⚠ 1 稿目はここに「実在しない日は読まない」と**書いていたが嘘**で、
 *   test が落ちて分かった(CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
 */
export function readSubstituteTail(rest: string): SubstituteTail | null {
  const m = SUBSTITUTE_TAIL.exec(rest);
  if (m === null) return null;
  const date = m[1]!;
  return isScheduleDate(date) ? { date, length: m[0].length } : null;
}

export interface RepeatTail {
  readonly unit: RepeatUnit;
  /** 語までの長さ(前の空白を含む)。⚠ **記法の範囲を伸ばす**のに使う。 */
  readonly length: number;
}

/** `毎月` の直後に付く、対応していない言い方(第N◯曜・月末)。 */
const UNSUPPORTED_MONTH_TAIL = /^[ \t]*(?:第[\d０-９一二三四五]|末)/;

export function readRepeatTail(rest: string): RepeatTail | null {
  const m = REPEAT_TAIL.exec(rest);
  if (m === null) return null;
  const unit = repeatUnitOf(m[1]!);
  // ⚠ 網に当たったのに表に無い語は**読まない**(表が正本 ── §7)
  if (unit === null) return null;
  /**
   * 🔴 **「第N◯曜」「月末」は刻みとして読まない**(#1087)。⚠ この記法は対応していない ──
   *   `毎月第2火曜` を `毎月`(開始日の日)として読むと、**20 日の予定が毎月立ち**、
   *   `第2火曜` が札の字に残る(書いた意味と違う予定が静かに立つ)。読まなければ
   *   全体が字のまま残り、見て直せる。
   */
  if (unit === 'month' && UNSUPPORTED_MONTH_TAIL.test(rest.slice(m[0].length))) return null;
  /**
   * 🔴 **語の一部なら刻みではない**(台帳 #1852 束 E1、依頼 130 の A)。`毎日新聞を読む` `毎年恒例の行事` `毎月勤労統計` の
   *   「毎日」「毎年」「毎月」は普通の言葉で、1 回きりの予定が毎日・毎年立っていた。
   * 🔑 読むのは、直後が**空白・句読点・括弧・行の終わり**(= 字でも数字でもない)のときと、`毎週` の直後の**曜日**(`毎週木曜に`)。
   * ⚠ `隔週` は今までどおり(`隔週の定例` を読めなくしない ── 動線を減らさない)。
   */
  if (unit !== 'biweek') {
    const next = rest.slice(m[0].length)[0];
    const isWordChar = next !== undefined && /^[\p{L}\p{N}]/u.test(next);
    if (isWordChar && !(unit === 'week' && WEEKDAY_CHARS.includes(next))) return null;
  }
  if (unit === 'week') {
    const after = rest.slice(m[0].length);
    const w = WEEKDAY_TAIL.exec(after);
    if (w !== null) {
      const set = new Set<number>();
      for (const ch of w[1]!) {
        const at = WEEKDAY_CHARS.indexOf(ch);
        if (at >= 0) set.add(at + 1);
      }
      if (set.size >= 2) {
        const digits = [...set].sort((a, b) => a - b).join('');
        return { unit: `${WEEKDAYS_PREFIX}${digits}` as WeekdaysUnit, length: m[0].length + w[0].length };
      }
    }
    const one = SINGLE_WEEKDAY_TAIL.exec(after);
    if (one !== null) {
      const at = WEEKDAY_CHARS.indexOf(one[1]!) + 1;
      return { unit: `${WEEKDAYS_PREFIX}${at}` as WeekdaysUnit, length: m[0].length + one[0].length };
    }
  }
  return { unit, length: m[0].length };
}

/**
 * 展開の上限。⚠ **これ以上は読めない**(束が増えすぎて面が固まる)。
 * 🔑 数で持つ ── 「多すぎたら間引く」を散文の規律にしない。
 */
export const REPEAT_MAX_OCCURRENCES = 200;

/**
 * `anchor` から `n` 回ぶん進めた日。読めない字なら `null`。
 *
 * 🔴 **毎回 anchor から数える**(前の回から 1 つ進めない)。
 * ⚠ 月の刻みで iterative にすると **1/31 → 2/28 → 3/28** と**寄った日が固定**され、
 *   user が書いた「31 日」が 2 月をまたいだ瞬間に永久に失われる。
 *   anchor から数えれば **1/31 → 2/28 → 3/31** と戻る。
 * ⚠ 月末の寄せは `Date` に任せない ── `new Date(2026, 1, 31)` は **3/3** へ流れる
 *   (「翌月の 3 日」は user が書いた意味と違う)。**その月の末日で止める**。
 */
export function occurrenceAt(anchor: string, unit: BaseRepeatUnit, n: number): string | null {
  if (n === 0) return isScheduleDate(anchor) ? anchor : null;
  if (unit === 'day') return addDays(anchor, n);
  if (unit === 'week') return addDays(anchor, n * 7);
  if (unit === 'biweek') return addDays(anchor, n * 14);
  const p = storedDateParts(anchor);
  if (p === null) return null;
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  const months = unit === 'month' ? n : n * 12;
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  // ⚠ その月の末日で止める(流さない)。`new Date(y, m, 0)` が「前月の末日」
  const last = new Date(ny, nm, 0).getDate();
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, last))}`;
}

/**
 * 🔴 **窓の先頭に当たる回の番号を、数えて出す**(1 回ずつ近づかない)。
 *
 * 🔴 直す前は anchor から 1 回ずつ回して窓へ近づいており、空回りの上限
 * (`max * 8` = 1600)を超えると **1 件も出ないのに `truncated` も立たない** ──
 * つまり**画面に何も出ない**。実測(2026-09-12):`@2020-01-06 毎日` は今日との差が
 * **2,441 日**で、**札が 0 枚**だった(この module の docstring が例に挙げている字である)。
 * ⚠ test はこの次元を持っていなかった ── 該当の test は `週`(348 週 < 1600)で
 * 書かれており、**`日` の古い開始だけが落ちる**形だった。
 *
 * 🔑 見積もりは刻みごとの算術で出し、**両側へ少しだけ直す** ── 月末の寄せ
 * (1/31 → 2/28)や端数で **±1 ずれる**ことがあるため。
 */
function firstIndexFrom(anchor: string, unit: BaseRepeatUnit, from: string): number {
  let n = 0;
  if (unit === 'day' || unit === 'week' || unit === 'biweek') {
    const gap = daysBetween(anchor, from);
    if (gap !== null && gap > 0) n = Math.ceil(gap / (unit === 'week' ? 7 : unit === 'biweek' ? 14 : 1));
  } else {
    const a = storedDateParts(anchor);
    const f = storedDateParts(from);
    if (a !== null && f !== null) {
      const months =
        (Number(f.year) - Number(a.year)) * 12 + (Number(f.month) - Number(a.month));
      const step = unit === 'month' ? months : Math.floor(months / 12);
      if (step > 0) n = step;
    }
  }
  for (let i = 0; i < 4 && n > 0; i += 1) {
    const prev = occurrenceAt(anchor, unit, n - 1);
    if (prev === null || prev < from) break;
    n -= 1;
  }
  for (let i = 0; i < 4; i += 1) {
    const at = occurrenceAt(anchor, unit, n);
    if (at === null || at >= from) break;
    n += 1;
  }
  return n;
}

/** 曜日(月=1 … 日=7)。形が壊れていたら 0(どの列にも入らない)。 */
function weekdayOf(date: string): number {
  const p = storedDateParts(date);
  if (p === null) return 0;
  const d = new Date(Number(p.year), Number(p.month) - 1, Number(p.day)).getDay();
  return d === 0 ? 7 : d;
}

export interface RepeatExpansion {
  /** 出す日(昇順・重複なし)。 */
  readonly days: readonly string[];
  /**
   * 🔴 **上限で切ったか**。⚠ 黙って切らない ── 呼び側が「ここまでです」と出す。
   */
  readonly truncated: boolean;
}

/**
 * 繰り返しを、**窓の中の日**へ展開する。
 *
 * @param anchor  開始日(`YYYY-MM-DD`)。⚠ **窓の外でもよい**(ここから数える)
 * @param until   繰り返しの終わり。`null` なら窓の端まで
 * @param from    窓の始まり(この日より前は出さない)
 * @param to      窓の終わり(この日より後は出さない)
 * @param skip    出さない日 ── 🔑 **済んだ回の実体**がここへ来る(例外日の記法は要らない)
 */
export function expandRepeat(input: {
  readonly anchor: string;
  readonly unit: RepeatUnit;
  readonly until: string | null;
  readonly from: string;
  readonly to: string;
  readonly skip?: ReadonlySet<string>;
  readonly max?: number;
}): RepeatExpansion {
  const { anchor, unit, until, from, to } = input;
  const skip = input.skip ?? new Set<string>();
  const max = input.max ?? REPEAT_MAX_OCCURRENCES;
  // ⚠ 形が壊れていたら**何も出さない**(寄った日を並べない ── user が見て直せる
  //    のは本文の字であって、こちらが作った別の日ではない)
  if (!isScheduleDate(anchor) || !isScheduleDate(from) || !isScheduleDate(to)) {
    return { days: [], truncated: false };
  }
  /**
   * ⚠ **窓が逆順のときの門は書かない**(2026-08-25、変異試験 R7 が SURVIVED で教えた)。
   * 下の 2 つの篩(`at > stop` で止め、`at < from` で飛ばす)は
   * **`from > to` のとき必ず空集合**になるので、明示の門は **no-op** だった。
   * 🔑 CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」──
   *   見たら壊れなかったので書かない(test は結果のほうを pin している)。
   */
  const stop = until !== null && isScheduleDate(until) && until < to ? until : to;
  const days: string[] = [];
  let truncated = false;
  /**
   * ⚠ **回数で回す**(日付で回さない)── `occurrenceAt` は anchor から数えるので、
   *   ここで前の回を持ち回ると上の「寄った日が固定される」を再現してしまう。
   * 🔑 **窓の先頭から回す**(`firstIndexFrom`)── 空回りが無くなったので、
   *   回す数は「出す数 + 飛ばす数」で足りる(直す前は 1600 回で打ち切っていた)。
   */
  const spin = max + skip.size + 8;
  const weekdays = weekdaysOf(unit);
  if (weekdays !== null) {
    /**
     * 🔴 **曜日の列は日で回す**(回数では数えられない)。開始日より前は出さない。
     * 回す日数は「出す数 + 飛ばす数」の 7 倍までで足りる(1 週に最低 2 日出る)。
     */
    let at: string | null = from < anchor ? anchor : from;
    for (let i = 0; i < spin * 4 && at !== null; i += 1) {
      if (at > stop) break;
      if (!skip.has(at) && weekdays.includes(weekdayOf(at))) {
        if (days.length >= max) {
          truncated = true;
          break;
        }
        days.push(at);
      }
      at = addDays(at, 1);
    }
    return { days, truncated };
  }
  const base = unit as BaseRepeatUnit;
  const start = firstIndexFrom(anchor, base, from);
  for (let i = 0; i < spin; i += 1) {
    const at = occurrenceAt(anchor, base, start + i);
    if (at === null) break;
    if (at > stop) break;
    // ⚠ 保険 ── `firstIndexFrom` の直しが 4 回で届かなかったときだけ通る
    //    (届いていることは test が「先頭の日 = 窓の始まり」で pin している)
    if (at < from) continue;
    if (skip.has(at)) continue;
    if (days.length >= max) {
      truncated = true;
      break;
    }
    days.push(at);
  }
  return { days, truncated };
}

/**
 * 🔴 **繰り返しの行と「済んだ回の実体」を結ぶ鍵**(#344 段②)。
 *
 * ⚠ 済んだ回は**同じノートの、同じ字の、繰り返しでない行**として本文に増える
 *   (`- [x] ゴミ出し @2026-08-31`)。だから結び目は **lid と字**である。
 * 🔑 **鍵の作り方をここ 1 か所に置く**(CLAUDE.md §7)── 束ねる側
 *   (`agenda.ts`)と作る側で別々に組むと、片方だけ字の正規化を変えた日に
 *   **済んだはずの回がもう一度出る**(しかも原因が結果から遠い)。
 * ⚠ 区切りは改行 ── lid にも字にも現れない(字は行 1 本ぶんなので)。
 */
export function repeatMateKey(lid: string, text: string): string {
  return `${lid}\n${text}`;
}

/** `repeatMateKey` → その字で**実体になっている日**の集合。 */
export function materializedDates(
  cards: readonly {
    readonly lid: string;
    readonly text: string;
    readonly date: string | null;
    readonly repeat: RepeatUnit | null;
    /**
     * 🔴 **その行が代わりになっている、元の回の日**(#855 決4)。
     * ⚠ optional にしてある ── 呼び側(`alarm-due.ts` / `schedule.ts`)が
     *   別々の形の札を渡すためで、**持たない側は今までどおり**動く。
     */
    readonly substitutes?: string | null;
  }[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, day: string): void => {
    const set = out.get(key);
    if (set === undefined) out.set(key, new Set([day]));
    else set.add(day);
  };
  for (const c of cards) {
    // ⚠ 繰り返しの行そのものは実体ではない(規則の行である)
    if (c.repeat !== null || c.date === null) continue;
    const key = repeatMateKey(c.lid, c.text);
    add(key, c.date);
    /**
     * 🔴 **振替は「元の日」も塞ぐ**(#855 決4)── これが無いと、動かした先と
     *   元の日の**両方に札が出る**(user から見れば予定が 1 つ増えている)。
     * 🔑 塞ぐ理由は済んだ回と同じ ── 「その日はこの行が引き受けた」である。
     */
    const from = c.substitutes ?? null;
    if (from !== null && from !== c.date) add(key, from);
  }
  return out;
}
