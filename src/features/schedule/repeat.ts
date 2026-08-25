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
 *
 * 🔑 **終了条件の記法を新しく作らない。** `..` は既に「開始と終わり」を表しており、
 * そこに刻みが付くだけである。⚠ 刻みの語が無ければこれまでどおり
 * 「その期間ずっと」の意味で、**既存の本文の意味は 1 つも変わらない**。
 *
 * 🔑 **曜日を書かせない。** `毎週月曜` のような語を解くと、日本語・英語・略記の
 * 表が要る ── 開始日が月曜なら「毎週」で足りる。
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

import { addDays } from '@features/datetime/date-math';
import { isScheduleDate } from './schedule-date';
import { storedDateParts } from '@features/datetime/stored-date';
import { pad2 } from '@features/datetime/datetime-format';

/** 刻み。⚠ **並びが画面の並び**(短い順)。 */
export const REPEAT_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];

/**
 * 画面に出す語 ⇄ 刻み。
 * ⚠ **user に `week` と見せない**(`relationLabel` と同じ作法)。
 */
export const REPEAT_WORDS: Readonly<Record<RepeatUnit, string>> = {
  day: '毎日',
  week: '毎週',
  month: '毎月',
  year: '毎年',
};

/**
 * 語から刻みを読む。知らない語なら `null`。
 * 🔑 **表は 1 つ**(`REPEAT_WORDS`)から引く ── 2 つ持つと、片方に足し忘れる。
 */
export function repeatUnitOf(word: string): RepeatUnit | null {
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
const REPEAT_TAIL = /^[ \t]*(毎[日週月年])/;

export interface RepeatTail {
  readonly unit: RepeatUnit;
  /** 語までの長さ(前の空白を含む)。⚠ **記法の範囲を伸ばす**のに使う。 */
  readonly length: number;
}

export function readRepeatTail(rest: string): RepeatTail | null {
  const m = REPEAT_TAIL.exec(rest);
  if (m === null) return null;
  const unit = repeatUnitOf(m[1]!);
  // ⚠ 網に当たったのに表に無い語は**読まない**(表が正本 ── §7)
  return unit === null ? null : { unit, length: m[0].length };
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
export function occurrenceAt(anchor: string, unit: RepeatUnit, n: number): string | null {
  if (n === 0) return isScheduleDate(anchor) ? anchor : null;
  if (unit === 'day') return addDays(anchor, n);
  if (unit === 'week') return addDays(anchor, n * 7);
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
   * ⚠ **窓へ届くまでの空回りにも上限**を掛ける ── `@2020-01-06 毎日` を
   *   2026 年の窓で見ると、届くまでに 2,400 回まわる。
   */
  const spin = max * 8;
  for (let n = 0; n < spin; n += 1) {
    const at = occurrenceAt(anchor, unit, n);
    if (at === null) break;
    if (at > stop) break;
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
  }[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of cards) {
    // ⚠ 繰り返しの行そのものは実体ではない(規則の行である)
    if (c.repeat !== null || c.date === null) continue;
    const key = repeatMateKey(c.lid, c.text);
    const set = out.get(key);
    if (set === undefined) out.set(key, new Set([c.date]));
    else set.add(c.date);
  }
  return out;
}
