/**
 * 🔴 **「日付とは何か」を 1 か所で決める**(CLAUDE.md §7「同じ判定が 2 か所にある」)。
 *
 * 予定の日付は **2 か所**に書ける ──
 *
 * | 書く場所 | 形 | 単位 |
 * |---|---|---|
 * | frontmatter の `date:` | `2026-08-25` | **ノート 1 件**が丸ごと予定 |
 * | 本文の行 | `- [ ] 見積を送る @2026-08-25` | **その行**が予定 |
 *
 * ⚠ **同じ形でなければならない。** 別々に決めると「frontmatter では書けるのに
 * 行では書けない日付」ができ、しかも**書いた本人には理由が分からない**
 * (どちらも「日付を書いた」つもりなので)。
 *
 * 🔑 だから**判定はこの file の 2 つの述語だけ**。呼ぶ側(frontmatter の読み /
 * 行の走査)は、**自分では形を決めない**。
 *
 * ## 🔴 なぜ「実在しない日」を通すのか
 *
 * `2026-02-30` / `2026-13-01` は形としては通る。⚠ **わざと通している** ──
 *
 * - 弾くと、user から見て**書いたのに何も起きない**(打ち間違いに気づけない)
 * - 通すと、**予定の並びにそのまま出る**ので、user が見て直せる
 *
 * 🔑 CLAUDE.md の「誤差の向きを決める」── ここは **user の意図を読む**側なので、
 * **広く拾う**ほうへ倒す(狭く取ると user の書いたものが黙って消える)。
 * ⚠ ただし**並べる側**は文字列で比較すること ── `Date` に通すと `2026-02-30` が
 * 3 月 2 日へ黙って寄り、**user が書いた字と違う日**に出る。
 */

/**
 * 日付の形か。🔴 **厳密に `YYYY-MM-DD`**(桁を詰める)。
 *
 * ⚠ ここが緩いと**並びも比較も壊れる** ── `2026-8-1` と `2026-08-01` は
 *   文字列として別物なので、同じ日が 2 つの束になる。
 * ⚠ 実在しない日は通す(この file の頭を参照)。
 */
export function isScheduleDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 🔴 **暦に実在する日か**(#1169)。⚠ `isScheduleDate` とは**別の問い**である ──
 * あちらは「形」(`2026-02-31` も通す。この file の頭の裁定)、こちらは
 * 「**押して開く先がある日か**」。
 *
 * 🔑 本文の `@2026-02-31` を**押せる字にしない**ための門である。押せるのに押すと
 *   存在しない日の題名でノートが作られてしまう ── 通せば「打ち間違いが見える形で残る」
 *   (この file の頭)側の利点も消える(押せる字になると、間違いに見えない)。
 * ⚠ 形の判定は `isScheduleDate` を**通す**(2 本目の形を書かない ── CLAUDE.md §7)。
 *   ここが足すのは月・日の範囲だけ。閏年は `Date` に頼らず自前で数える
 *   (`Date` に通すと `2026-02-30` が 3 月 2 日へ寄って**真になる**)。
 */
export function isRealCalendarDate(value: string): boolean {
  if (!isScheduleDate(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = m === 2 ? (leap ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
  return d <= last;
}

/**
 * 時刻の形か。🔴 **厳密に `HH:MM`**(桁を詰める)。
 *
 * ⚠ `3:00` を通さないのは、行の走査で**本文の数字を時刻と読み違えない**ため
 *   (`@2026-08-25 3:00 の予算` の `3:00` は時刻ではないことが多い)。
 * ⚠ `25:99` は通す ── 日付と同じ理由(user が見て直せる形で出す)。
 *   並びは文字列比較なので、`25:99` は同じ日の末尾に来るだけで壊れない。
 */
export function isScheduleTime(value: string): boolean {
  return /^\d{2}:\d{2}$/.test(value);
}

/**
 * 🔴 **期間の形か**(#344 段①)。`start` と `end` が両方**日付の形**で、
 * かつ **`start` が `end` より後でない**こと。
 *
 * ⚠ **逆順(`@2026-08-28..2026-08-25`)は通さない。** 通すと展開が 0 日になり、
 *   **予定が束から黙って消える** ── いちばん気づけない形である。
 * 🔑 通さないほうを選ぶと、この file の頭の裁定どおり
 *   「記法として読まれず、user が書いた字がそのまま画面に残る」ので、**見て直せる**。
 *
 * ⚠ **実在しない日は通す**(`2026-02-30..2026-03-05`)── 日付 1 つのときと同じ向き。
 *   比較は**文字列**なので、実在しなくても順序は決まる(`YYYY-MM-DD` は辞書順 = 日付順)。
 */
export function isScheduleRange(start: string, end: string): boolean {
  return isScheduleDate(start) && isScheduleDate(end) && start <= end;
}

/**
 * 🔴 **時刻の幅の形か**(#855 段 C′)。`start` と `end` が両方**時刻の形**で、
 * かつ **`start` が `end` より後でない**こと(`14:00..15:00`)。
 *
 * ⚠ **逆順(`15:00..14:00`)は通さない。** 通すと「終わりが始まりより前の予定」が
 *   立つ ── 日付の期間(`isScheduleRange`)と同じ理由で、読まなければ
 *   **書いた字がそのまま札に残り、見て直せる**。
 * ⚠ **同じ時刻(`14:00..14:00`)は通す**(日付の期間が「開始と同じ日でもよい」のと同じ ──
 *   user が幅のつもりで書いたことを消さない)。
 * ⚠ `25:99` は通す(`isScheduleTime` と同じ向き)。比較は**文字列**(`HH:MM` は辞書順 = 時刻順)。
 */
export function isScheduleTimeRange(start: string, end: string): boolean {
  return isScheduleTime(start) && isScheduleTime(end) && start <= end;
}

/**
 * 🔴 **夜をまたぐ幅か**(`22:00..02:00`。#1163 の依頼 190。Gemini の裁定:書けるようにする)。
 *
 * 両方が時刻の形で、**終わりが始まりより前**のもの。終わりは**翌日**の時刻として読む。
 * ⚠ 直す前は逆順を幅として読まず、`..02:00` が札の字に残った(夜勤・夜行の予定が書けなかった)。
 * ⚠ 日付の期間(`isScheduleRange`)の逆順は、今までどおり通さない(0 日になって予定が消えるため ── 時刻の幅と事情が違う)。
 * ⚠ 同じ時刻(`14:00..14:00`)は夜をまたぐとは読まない(`isScheduleTimeRange` が通す)。
 */
export function isOvernightSpan(start: string, end: string): boolean {
  return isScheduleTime(start) && isScheduleTime(end) && end < start;
}

/** 幅として読める形か(同じ日の幅 または 夜をまたぐ幅)。⚠ 読む側と書く側の**同じ 1 本**(往復しない字を出力しない)。 */
export function isScheduleTimeSpan(start: string, end: string): boolean {
  return isScheduleTimeRange(start, end) || isOvernightSpan(start, end);
}

/**
 * 🔴 **札に出す時刻の字**(`14:00` / `14:00〜15:00`)。
 *
 * 🔑 札の字の組み立てはここ 1 本(CLAUDE.md §7)── 面ごとに `〜` を足すと、
 *   同じ幅が場所によって違う字で出る。⚠ **本文へ書く綴りは `..`** であって、
 *   これは**画面に出す字**である(日付の期間の札の「〜08/28」と同じ向き)。
 */
export function formatTimeSpan(time: string, timeEnd: string | null): string {
  // 🔴 夜をまたぐ幅は「翌」を添える(`22:00〜翌02:00`)── 添えないと終わりが始まりより前に見える(#1163 の依頼 190)
  return timeEnd === null ? time : isOvernightSpan(time, timeEnd) ? `${time}〜翌${timeEnd}` : `${time}〜${timeEnd}`;
}

/**
 * 🔴 **日付の区切りとして読む全角のハイフン**(`２０２６－１０－２０` の `－` U+FF0D。台帳 #1852 束 E1 の取りこぼし)。
 *
 * ⚠ 受けるのは **U+FF0D(全角ハイフンマイナス)と U+2010 / U+2011(ハイフン / 改行しないハイフン)だけ**。
 *   `ー`(長音記号)・`―`(ダッシュ)・`−`(U+2212)は**入れない** ── 長音記号は日本語の語に出る
 *   (`ミーティング` など)ので、日付の隣の語を日付の一部と読み違える元になる。
 * ⚠ **位置も縛る** ── 「4 桁の直後」か「4 桁・区切り・2 桁の直後」で、しかも**次が数字**のときだけ。
 *   `@2026-10-20－会議` のように日付の後ろへ付いた `－` を `-` に倒すと、今まで日付だけ読めていた行が
 *   `2026-10-20-` になって日付ごと落ちる(今読めている形を読めなくしない)。時刻の幅(`14:00－15:00`)にも触れない。
 */
const WIDE_DATE_HYPHEN =
  /(?<=[0-9０-９]{4}|[0-9０-９]{4}[-－‐‑][0-9０-９]{2})[－‐‑](?=[0-9０-９])/g;

/**
 * 🔴 **全角の数字・コロン・スラッシュを半角に揃える**(台帳 #1852 束 E1。Gemini 裁定 = #1163 の依頼 188)。
 *
 * ⚠ **字の数を変えない**(1 字を 1 字に写す)── 呼び側は原文の位置(`start` / `end`)を
 *   この写しの上で数えて、原文へ splice するので、ずれたら別の字を壊す。
 * ⚠ 受けるのは**数字・`：`・`／`と、日付の区切りの全角ハイフン**(`WIDE_DATE_HYPHEN`)だけ(`＠` は受けない ──
 *   「無理のない範囲」。283 の裁定:読めない形は読まずに「日付として読めません」と言う)。
 */
export function foldWideDateChars(text: string): string {
  if (!/[０-９：／－‐‑]/.test(text)) return text;
  return text
    .replace(/[０-９：／]/g, (c) =>
      c === '：' ? ':' : c === '／' ? '/' : String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(WIDE_DATE_HYPHEN, '-');
}

/**
 * 🔴 **1 桁の時(`9:00`)を `09:00` に直す**(依頼 189)。読めない形はそのまま返す。
 * ⚠ 呼び側は「日付の直後に書いた時刻」にだけ使う(`3:00の予算` のような文中の数字を
 *   時刻と読み違えないため ── `isScheduleTime` が厳密な `HH:MM` のままなのも同じ理由)。
 */
export function padClockHour(raw: string): string {
  return /^\d:\d{2}$/.test(raw) ? `0${raw}` : raw;
}

/**
 * 🔴 **frontmatter の `date:` の値を、日付・時刻・区切りに割る**(依頼 188 / 192 / 284)。
 *
 * `2026-10-20` はもちろん、`2026-10-20 14:00` / `2026-10-20T10:00` / `２０２６/１０/２０` も
 * 日付 `2026-10-20` として読む。読めなければ `null`。
 * - `time`: 書かれた時刻(`HH:MM`。1 桁の時は 0 を補う)。**書かれていない・読めない時刻・時差つき(`Z` / `+09:00`)は `null`**
 *   (時差つきの時刻は、この端末の時刻へ直さないと別の時刻になる ── 日付だけ読む今までの動きのまま)。
 * - `sep`: 日付と時刻の間の字(` ` / `T` / 全角空白)。書き換えるとき同じ綴りで返すために持つ。時刻が無ければ `' '`。
 * 🔑 形の判定は `isScheduleDate` 1 本に通す(ここで 2 本目の形を書かない)。
 */
export function parseFrontmatterWhen(
  raw: string,
): { readonly date: string; readonly time: string | null; readonly sep: string } | null {
  const m = /^(\S+?)(?:([ T\u3000])(\S+))?$/.exec(foldWideDateChars(raw.trim()));
  if (m === null) return null;
  const date = m[1]!.replace(/\//g, '-');
  if (!isScheduleDate(date)) return null;
  if (m[3] === undefined) return { date, time: null, sep: ' ' };
  const t = /^(\d{1,2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})?$/.exec(m[3]);
  if (t === null) return null;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const ok = t[3] === undefined && hour < 24 && minute < 60;
  return { date, time: ok ? padClockHour(`${t[1]}:${t[2]}`) : null, sep: m[2] === '\u3000' ? ' ' : m[2]! };
}

/**
 * 🔴 **frontmatter の `date:` の値から、日付の部分を取り出す**(依頼 188 / 192 / 284)。
 * ⚠ 時刻は `parseFrontmatterWhen` が別に返す(抽出列には日付だけを置く ── 時刻は本文から読む)。
 */
export function dateOfFrontmatterText(raw: string): string | null {
  return parseFrontmatterWhen(raw)?.date ?? null;
}

/**
 * 🔴 **`date:` の値の日付だけを替える**(予定表でノートを別の日へ動かす)。**書かれた時刻は残す**(綴りも同じ)。
 * `time` を渡すと時刻も替える(`null` で時刻を外す)。読めない値(日付でない)には `newDate` だけを返す。
 */
export function withFrontmatterDate(raw: string, newDate: string, time?: string | null): string {
  const when = parseFrontmatterWhen(raw);
  const keep = time === undefined ? (when?.time ?? null) : time;
  return keep === null ? newDate : `${newDate}${when?.sep ?? ' '}${keep}`;
}
