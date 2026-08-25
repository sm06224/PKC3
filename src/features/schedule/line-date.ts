/**
 * 🔴 **本文の行に書く日付**(`@2026-08-25` / `@2026-08-25 14:00`)。
 * #292 の裁定(user 指示 2026-08-23)。
 *
 * > 「**日付を入れたチェックリスト、これが予定として機能する。この発想はいいと思う。
 * > 日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
 * > ついてくるツールとか用意されてもいいかも**」
 *
 * ```markdown
 * - [ ] 見積を送る @2026-08-25
 * - [ ] 打ち合わせ @2026-08-25 14:00
 * - [ ] これは体裁のチェックリスト(日付が無いので予定ではない)
 * ```
 *
 * ## 🔴 なぜ「広く拾ってから捨てる」形なのか
 *
 * 走査は **`@` の後ろの数字と記号の連なりを、行けるところまで取ってから**
 * `isScheduleDate` に当てる。⚠ **わざと取りすぎている** ──
 *
 * | 書いたもの | 取るもの | 判定 |
 * |---|---|---|
 * | `@2026-08-25` | `2026-08-25` | ✅ |
 * | `@2026-8-5` | `2026-8-5` | ❌ 桁が足りない |
 * | `@2026-08-251` | `2026-08-251` | ❌ ── 🔑 **取りすぎるから弾ける** |
 * | `@1,500`(単価) | `1` | ❌ |
 * | `@3`(個数) | `3` | ❌ |
 * | `@[card](entry:…)` | ── | 一致しない(`[` は数字ではない) |
 *
 * 🔑 **`@2026-08-251` が効く理由がここにある。** 貪欲に取らずに
 * 「先頭 10 字が日付なら採用」と書くと、**`@2026-08-251` の前半だけを日付と読む**
 * ── user は 1 つの語を書いたのに、こちらが勝手に切って読むことになる。
 *
 * ## 🔴 刻み(`毎週`)は**尻から別に読む**(#344 段②)
 *
 * `@2026-08-31 毎週` / `@2026-08-31..2026-12-31 毎週` / `@2026-08-31 14:00 毎週`。
 * ⚠ **走査の網を広げていない** ── 日付・期間・時刻の読み方は 1 バイトも変えず、
 * **読み終わった直後の字**だけを `readRepeatTail` に当てる(`repeat.ts`)。
 * 🔑 そのぶん「網を広げたせいで既存の本文の読みが変わる」経路が無い。
 *
 * ## ⚠ 形を決めるのはこの file ではない
 *
 * 「日付とは何か」は `schedule-date.ts` の `isScheduleDate` 1 つである
 * (frontmatter の `date:` と**同じ規則**でなければならない ── CLAUDE.md §7)。
 * ここが持つのは「**行のどこに在るか**」だけ。
 *
 * ## ⚠ `@` の前に境目を求めない
 *
 * `会議@2026-08-25` は通る。⚠ わざとである ── 日本語には語の切れ目に空白が無いので、
 * 境目を求めると**日本語で書いた人だけ書けない**。
 * 🔑 誤って拾う心配は**形の厳しさ**が受け持っている(`@1,500` は上の表のとおり落ちる)。
 *
 * 🔑 **pure module**。DOM も DB も知らない。
 */
import { isScheduleDate, isScheduleRange, isScheduleTime } from './schedule-date';
import { REPEAT_WORDS, readRepeatTail, type RepeatUnit } from './repeat';

/**
 * 走査の網。⚠ **判定はしない**(取るだけ)── 判定は `isScheduleDate` /
 * `isScheduleRange` / `isScheduleTime` が持つ。
 * ⚠ 時刻の区切りは**空白か `T`**(`2026-08-25T14:00` と書く人が居るため)。
 *
 * 🔴 **期間の区切りは 3 綴りを受ける**(#344 段①)── `..` と `〜`(波ダッシュ)と
 * `～`(全角チルダ)。⚠ **書くのは `..` 1 つだけ**(`formatLineDate`)。
 *
 * 🔑 **読みを 3 綴りにする理由は、今日の実測にある** ── 直す前の網は
 * `@2026-08-25..2026-08-28` を **`2026-08-25` だけ**読み、`..2026-08-28` を
 * 札の字に残していた(`〜` も同じ)。つまり期間は「書けない」のではなく
 * **黙って半分だけ読まれていた**。⚠ 日本語で書く人は反射で `〜` を打つので、
 * そこを落とすと**いちばん自然な書き方がいちばん静かに壊れる**。
 *
 * ⚠ **区切りを `[\d-]` の網に入れない** ── `.` を素で入れると
 * `@2026-08-25.`(英語の文末)が `2026-08-25.` になって**日付ごと落ちる**。
 * だから `\.\.` と 2 つ揃ったときだけ拾う。
 */
const AT_DATE = /@([\d-]+)(?:(?:\.\.|[〜～])([\d-]*))?(?:[ T]([\d:]+))?/g;

/** 行に書かれた 1 つの日付。 */
export interface LineDate {
  /** `YYYY-MM-DD`。⚠ 実在しない日も通る(`schedule-date.ts` の頭を参照)。期間なら**開始**。 */
  readonly date: string;
  /**
   * 🔴 **期間の終わり**(`@2026-08-25..2026-08-28` の `2026-08-28`)。単日なら `null`。
   *
   * ⚠ 名前が `end` でないのは、**この interface の `end` が既に「記法の文字位置」**
   *   だからである ── 同じ名前で 2 つの意味を持たせると、呼び側が
   *   **数と日付を取り違えても tsc が黙る**場面が出る(どちらも `number | string` を
   *   受ける所へ渡ると気づけない)。
   * ⚠ **開始と同じ日でもよい**(`..` を書いた事実は残す ── 消すと、user が
   *   期間のつもりで書いたのか単日なのかが往復で失われる)。
   */
  readonly until: string | null;
  /**
   * `HH:MM`。書いていなければ `null`。
   * 🔴 **期間には時刻を付けない**(#344 段①)── 期間の札は**複数の日に出る**ので、
   * 「その時刻」がどの日のものか決まらない。⚠ だから期間の後ろに時刻を書いても
   * **記法として食べない** ── その字は札にそのまま残る(黙って捨てない)。
   */
  readonly time: string | null;
  /**
   * 🔴 **刻み**(`@2026-08-31 毎週` の `毎週`)。繰り返しでなければ `null`(#344 段②)。
   *
   * ⚠ **終わりは `until` が兼ねる** ── 終了条件の記法を新しく作らない
   *   (`repeat.ts` の頭)。つまり `@2026-08-31..2026-12-31 毎週` は
   *   「8/31 から 12/31 まで、毎週」であって **4 か月の予定ではない**。
   * ⚠ 時刻は**持てる**(`@2026-08-31 14:00 毎週`)── 毎週の会議はいちばん自然な形で、
   *   期間と違って「その時刻がどの日のものか」が回ごとに決まる。
   */
  readonly repeat: RepeatUnit | null;
  /** 記法そのものの範囲(`@` から)。⚠ **時刻が読めなかったときは日付までで終わる**。 */
  readonly start: number;
  readonly end: number;
}

/**
 * 行から日付を読む。無ければ `null`。
 *
 * 🔴 **見つけるのは最初の 1 つだけ。** ⚠ 1 行に 2 つ書かれていたら、後ろは無視する
 * ── 「その行の予定はいつか」に答えが 2 つあってはならない
 * (2 つ返すと、並べる側・画面に出す側が**それぞれ好きなほうを選ぶ**)。
 */
export function readLineDate(line: string): LineDate | null {
  AT_DATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_DATE.exec(line)) !== null) {
    const date = m[1]!;
    if (!isScheduleDate(date)) continue;
    const start = m.index;
    const rawUntil = m[2];
    /**
     * 🔴 **区切りが在ったなら、期間として成立しなければ丸ごと捨てる**(#344 段①)。
     * ⚠ 「開始だけ活かす」に**倒さない** ── `@2026-08-28..2026-08-25`(逆順)や
     *   `@2026-08-25..`(書きかけ)で開始だけ拾うと、user が**書いたつもりの期間とは
     *   違う予定**が静かに立つ。🔑 捨てれば字がそのまま画面に残るので、見て直せる
     *   (この file の頭「わざと取りすぎている」の続きである)。
     */
    if (rawUntil !== undefined) {
      if (!isScheduleRange(date, rawUntil)) continue;
      /**
       * ⚠ 区切りは 1 文字(`〜` / `～`)か 2 文字(`..`)── **原文で数える**。
       * ⚠ **`indexOf` で探さない**(1 稿目はそうしていた)── 見つからなければ
       *   `-1` が返り、**範囲が 1 文字ずれた記法**として本文を splice する形になる。
       *   位置は計算で決まるのだから、探す必要が無い(探すと失敗しうる口が増える)。
       */
      const sepAt = start + 1 + date.length;
      const sepLen = line.startsWith('..', sepAt) ? 2 : 1;
      const base = sepAt + sepLen + rawUntil.length;
      const tail = readRepeatTail(line.slice(base));
      return {
        date,
        until: rawUntil,
        // 🔴 期間に時刻は付けない(上の docstring)── 後ろの字は食べずに残す
        time: null,
        repeat: tail === null ? null : tail.unit,
        start,
        end: tail === null ? base : base + tail.length,
      };
    }
    const rawTime = m[3];
    // ⚠ 時刻だけ読めないときは**日付を活かす** ── `@2026-08-25 10:000円` の
    //    `10:000円` は時刻ではないが、日付は user がちゃんと書いている
    const time = rawTime !== undefined && isScheduleTime(rawTime) ? rawTime : null;
    const afterDate = start + 1 + date.length;
    /**
     * ⚠ 刻みは**日付(と時刻)の直後**からだけ拾う ── 行のどこかに「毎週」と
     *   書いてあるだけでは拾わない(散文を記法に取り込まない)。
     * ⚠ 時刻が**読めなかった**とき(`@2026-08-25 10:000円 毎週`)は、その字が
     *   間に挟まるので刻みは付かない ── わざとである(間の字を勝手に飛ばして
     *   繰り返しにすると、user が書いていない予定が毎週立つ)。
     */
    const base = time === null ? afterDate : afterDate + 1 + time.length;
    const tail = readRepeatTail(line.slice(base));
    return {
      date,
      until: null,
      time,
      repeat: tail === null ? null : tail.unit,
      start,
      end: tail === null ? base : base + tail.length,
    };
  }
  return null;
}

/**
 * 記法を取り除いた**表示用**の字。
 *
 * ⚠ **本文を書き換えるのに使わない。** 継ぎ目の空白を畳むので、
 *   user が置いた空白と 1 対 1 で戻らない ── 画面に出す字を作るためだけの関数である
 *   (本文を書き換えるなら `start` / `end` で原文を splice すること)。
 */
export function stripLineDate(line: string): string {
  const found = readLineDate(line);
  if (found === null) return line;
  const before = line.slice(0, found.start).replace(/[ \t]+$/, '');
  const after = line.slice(found.end).replace(/^[ \t]+/, '');
  return (before === '' || after === '' ? before + after : `${before} ${after}`).trim();
}

/**
 * 記法を組み立てる。🔴 **書きはこの 1 本だけ**(読みは上のとおり少し広い)。
 * ⚠ 呼び側が字を組み立てないこと ── 組み立てが 2 か所に散ると、
 *   片方が区切りを `T` にした日に**読める形と書く形が食い違う**。
 *
 * 🔴 **期間を渡したら、区切りは `..` 1 綴りだけ**(読みは `〜` `～` も受ける)。
 * ⚠ 期間のときは**時刻を書かない** ── 読む側が食べないので、書いても往復で消える。
 *   だから**ここで落とす**(往復しない字を出力しない)。
 */
export function formatLineDate(
  date: string,
  time?: string | null,
  until?: string | null,
  repeat?: RepeatUnit | null,
): string {
  const head =
    until !== undefined && until !== null && until !== ''
      ? `@${date}..${until}`
      : time !== undefined && time !== null && time !== ''
        ? `@${date} ${time}`
        : `@${date}`;
  /**
   * 🔴 **刻みは尻に付ける**(#344 段②)。⚠ 空白を 1 つ空ける ── 読みは
   *   詰めても通る(`repeat.ts` の `REPEAT_TAIL`)が、**書きは整える**
   *   (この file の頭「読みは緩く、書きは整える」)。
   */
  return repeat === undefined || repeat === null ? head : `${head} ${REPEAT_WORDS[repeat]}`;
}

/**
 * 🔴 **本文へ挿す形**(道具から入れるとき)。
 *
 * ⚠ `formatLineDate` との違いは**区切りの空白 1 つ**だけである ── caret の直前が
 * 字なら足す。足さないと `見積を送る@2026-08-25` になり、**読めはするが読みにくい**。
 * 🔑 「読める」と「読みやすい」は別なので、**読みは緩く、書きは整える**
 * (走査が `@` の前に境目を求めないのは、日本語で書く人のためである ── 上の docstring)。
 *
 * @param before caret より前の本文(行頭からでなくてよい ── 末尾しか見ない)
 */
export function insertionForLineDate(
  before: string,
  date: string,
  time?: string | null,
  until?: string | null,
  repeat?: RepeatUnit | null,
): string {
  const text = formatLineDate(date, time, until, repeat);
  return /\S$/.test(before) ? ` ${text}` : text;
}
