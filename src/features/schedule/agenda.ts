/**
 * 🔴 **予定を日ごとに束ねる**(#292 段③。user 指示 2026-08-23)。
 *
 * > 「**カレンダーは挙動の意味がわからなさすぎる / ちゃんとした導線に作り直しなさい**」
 * > 「**なんで双方向にする発想がでねぇんだよ!**」
 *
 * ## なぜ「今日 / 明日 / 今週」ではなく **日ごと**に束ねるか
 *
 * 束ねる単位は**落とし先の単位**でもある(双方向 ── 掴んだ札を束の見出しへ落とすと
 * その日になる)。⚠ 「今週」で束ねると、**落としたときにどの日か決まらない**
 * ── 束ね方が操作を決めてしまう。
 * 🔑 だから束は**日**にして、**名前のほうを人の言葉にする**(今日 / 明日 / 8/27(木))。
 *
 * ## 🔴 期限切れは捨てない。**上に出す**
 *
 * ⚠ 別の面へ追い出すと「見なくてよいもの」に見える。⚠ 今日へ混ぜると、
 * **いつのものか分からなくなる**(Apple の Today は混ぜるが、あれは日付を出す面が
 * 別に在るから成り立つ)。🔑 **その日の束のまま、いちばん上に置いて印を付ける。**
 *
 * 🔑 **pure module**。⚠ `new Date()` を読まない ── 「今日」は呼び側が渡す
 * (読むと test が実行した日で変わる)。
 */
import type { TaskCard } from './task-cards';
import type { EntryMeta } from '../../core/model/entry-meta';
/**
 * ⚠ **日付の切り方は `stored-date.ts` 1 か所**(`tests/features/stored-date.test.ts`
 *   が src 全体を走査して pin している)。⚠ ここで自前の正規表現を書いた 1 稿目は
 *   その全数検査に落ちた ── **規則が 2 か所に生えた瞬間に鳴る**ようにしてある。
 */
import { storedDateParts } from '../datetime/stored-date';
import { addDays } from '../datetime/date-math';
import { expandRepeat, repeatMateKey, type RepeatUnit } from './repeat';

/**
 * 🔴 **予定 1 件**。⚠ **単位は 2 つある**(2026-08-23、段④)──
 *
 * | `line` | 何か | どこに日付が書いてある |
 * |---|---|---|
 * | 数 | **本文の 1 行**(チェック項目) | 行の `@2026-08-25` |
 * | `null` | 🔴 **ノート 1 件が丸ごと予定** | frontmatter の `date:` |
 *
 * ⚠ **2 つ目を落とすと動線が 1 つ消える** ── 中央のカレンダー(段⑤ で落とす)が
 *   `date:` を出す唯一の面だったので、ここが受けないと**書いたのに どこにも出ない**
 *   frontmatter ができる(CLAUDE.md「捨てるものの表は、行ごとに『代わりに何が
 *   できるようになるか』を書く」)。
 */
export interface AgendaItem {
  /**
   * **その予定を指す鍵**。⚠ **行まで含める**(1 ノートに複数在る)。
   *
   * 🔴 **束に入った札の鍵は、これに「どの日の分か」が付く**(#344 段①)──
   *   期間の札は**複数の日に出る**ので、鍵が同じだと描画側の再利用表
   *   (`schedule.ts` の `this.cards`)が **1 枚の DOM を日から日へ動かし、
   *   結局 1 日にしか出ない**。⚠ 掴んだときの荷物には**使われていない**
   *   (荷物は札自身の `data-pkc-*` から組む)ので、伸ばしても落とす側は壊れない。
   */
  readonly key: string;
  readonly lid: string;
  /** 原文の行番号。`null` = ノート 1 件が丸ごと予定。 */
  readonly line: number | null;
  readonly text: string;
  /** ⚠ ノート 1 件の予定に印は無い(チェックする「行」が無い)。 */
  readonly done: boolean;
  /** 期間なら**開始**の日。 */
  readonly date: string | null;
  readonly time: string | null;
  /** 🔴 **時刻の終わり**(`14:00..15:00` の `15:00`)。幅でなければ `null`(#855 段 C′)。 */
  readonly timeEnd: string | null;
  /**
   * 🔴 **期間の終わり**(`@2026-08-25..2026-08-28`)。期間でなければ `null`(#344 段①)。
   * ⚠ **`date` から `until` まで、すべての日の束に出る** ── 1 点として置くと
   *   途中の日に出ず、「予定を見に来たのに載っていない」になる。
   * ⚠ **ノート 1 件の予定(frontmatter の `date:`)には期間が無い** ── そちらは
   *   `end:` を持てる場所が無い(抽出列を増やす = schema の移行)ので**段②**にした。
   *   非対称であることを承知で切っている(#344 に書いてある)。
   */
  readonly until: string | null;
  /**
   * 🔴 **終日**(`@2026-08-25 終日` / 前書きの `date: 2026-08-25 終日`。台帳 #344 の残り)。
   * ⚠ 時刻を書いていないだけの予定は `false`(**時刻未定**。区別する ── 札には「終日」と出さない)。省略 = `false`。
   */
  readonly allDay?: boolean;
  /**
   * 🔴 **刻み**(`@2026-08-31 毎週`)。繰り返しでなければ `null`(#344 段②)。
   *
   * ⚠ **束に入った札の `repeat` も `null` にならない** ── 出た 1 枚が
   *   「規則から出た回」であることは、押したとき(実体の行を作る)と
   *   掴んだとき(断る)に要る。🔑 代わりに**その回の `until` は `null`** にする
   *   ── 束に入った時点で「その日 1 日ぶん」であって、期間ではないからである。
   */
  readonly repeat: RepeatUnit | null;
}

/** 行の札を予定にする。 */
export function itemOfCard(card: TaskCard): AgendaItem {
  return {
    key: `${card.lid} ${card.line}`,
    lid: card.lid,
    line: card.line,
    text: card.text,
    done: card.done,
    date: card.date,
    time: card.time,
    timeEnd: card.timeEnd,
    until: card.until,
    allDay: card.allDay === true,
    repeat: card.repeat,
  };
}

/**
 * ノート 1 件を予定にする(frontmatter の `date:`)。`time` = 前書きに書いた時刻(`HH:MM`。無ければ `null` = 終日)。
 * ⚠ 鍵は `line` の代わりに `note` ── 行の札と**衝突しない**形にする。
 */
export function itemOfNote(
  meta: EntryMeta,
  time: string | null = null,
  /** 🔴 前書きの `date:` の期間の終わり・刻み・終日(台帳 #344 の残り)。省けば全部「無し」(これまでどおり)。 */
  extra: { readonly until?: string | null; readonly repeat?: RepeatUnit | null; readonly allDay?: boolean } = {},
): AgendaItem {
  return {
    key: `${meta.lid} note`,
    lid: meta.lid,
    line: null,
    // 🔑 取り込んだ ToDo(frontmatter `status: done`)は済み ── 情報ペインの「完了」と揃える
    text: meta.title,
    done: meta.status === 'done',
    date: meta.date,
    // 🔴 前書きの `date: 2026-10-20 14:00` の時刻(依頼 192 / 284)。呼び側が走査の `noteTimes` から渡す。無ければ終日
    time,
    // ⚠ 前書きには時刻の終わりの置き場が無いので、幅は無い
    timeEnd: null,
    // 🔴 前書きの `date: 2026-10-20..2026-10-22`(台帳 #344 の残り。行の `@a..b` と同じ文法 ── `schedule-when.ts`)
    until: extra.until ?? null,
    allDay: extra.allDay === true,
    // 🔴 前書きの `date: 2026-10-20 毎週`。ノート 1 件の繰り返しは**チェックする行が無い**ので、各回はただ載る
    repeat: extra.repeat ?? null,
  };
}

/** 1 日ぶん(または「日付なし」)の束。 */
export interface AgendaGroup {
  /** `YYYY-MM-DD`。`null` = 日付なし。 */
  readonly date: string | null;
  /** 画面に出す名前(今日 / 明日 / `8/27(木)` / 日付なし)。 */
  readonly label: string;
  /** 🔴 今日より前か。⚠ **落とすのではなく、印を付ける**。 */
  readonly overdue: boolean;
  readonly cards: readonly AgendaItem[];
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/**
 * 日付の字を人の言葉にする。
 * ⚠ `Date` に通さない ── `2026-02-30` のような実在しない日を渡されると
 *   **黙って 3/2 へ寄る**(user が書いた字と違う日が出る)。文字列のまま比べる。
 */
function labelOf(date: string, today: string, tomorrow: string): string {
  if (date === today) return '今日';
  if (date === tomorrow) return '明日';
  const p = storedDateParts(date);
  // ⚠ 形が違う値は**そのまま出す**(読めなかったことが見えるほうが良い)
  if (p === null) return date;
  /**
   * 曜日は `Date` で引く。⚠ **実在する日にしか使わない** ── `2026-02-30` を
   *   `Date` に通すと 3/2 へ黙って寄るので、**戻して同じ日か**を確かめてから出す。
   */
  const at = new Date(Number(p.year), Number(p.month) - 1, Number(p.day));
  const same =
    at.getFullYear() === Number(p.year) &&
    at.getMonth() === Number(p.month) - 1 &&
    at.getDate() === Number(p.day);
  const head = `${Number(p.month)}/${Number(p.day)}`;
  return same ? `${head}(${WEEKDAYS[at.getDay()]})` : head;
}

/**
 * 🔴 **期間を何日ぶんまで束へ展開するか**(#344 段①)。
 *
 * ⚠ 上限が無いと、打ち間違い 1 つ(`@2026-08-25..2999-01-01`)で
 *   **束が 35 万個**できて面が固まる ── しかも原因は本文の 1 行なので、
 *   user には何が起きたか分からない。
 * 🔑 切ったことは**札に出る** ── 札は期間の終わり(`〜1/1`)を出すので、
 *   束が途中で切れていても「そこまでの予定だ」と読める。
 */
export const AGENDA_RANGE_MAX_DAYS = 366;

/**
 * 期間を日の並びにする。⚠ **上限で切る**(上の定数)。
 * ⚠ `until` が読めない字なら**開始の 1 日だけ** ── 落とすと予定が黙って消える。
 */
function daysOfRange(from: string, until: string): string[] {
  const out: string[] = [from];
  let at = from;
  while (at < until && out.length < AGENDA_RANGE_MAX_DAYS) {
    const next = addDays(at, 1);
    if (next === null) break;
    at = next;
    out.push(at);
  }
  return out;
}

/**
 * 🔴 **繰り返しを先まで出す日数**(#344 段②)。
 *
 * ⚠ 窓が無いと `毎日` が**永久に**束を作る。⚠ 逆に短すぎると、小さな月を
 *   翌月へ送ったときに**点が消える**(下の一覧と食い違って見える)── だから
 *   **2 か月ぶん**にして、月を 1 つ送っても必ず届くようにしてある。
 * 🔑 これで `毎日` でも 1 本の行が作る札は 63 枚までで、
 *   `REPEAT_MAX_OCCURRENCES`(200)には**構造上とどかない**
 *   (= 上限で切ったことを画面に出す口は要らない)。
 */
export const AGENDA_REPEAT_HORIZON_DAYS = 62;

/**
 * 札を日ごとの束にする。
 *
 * 🔑 **並びは「日付の昇順、日付なしは最後」**。⚠ 期限切れは昇順の自然な結果として
 *   先頭に来る ── 別扱いで並べ替えない(規則を 2 つ持たない)。
 * ⚠ 束の中は **時刻の昇順、時刻なしは後**。同じ時刻は**渡された順**を保つ
 *   (呼び側が「ノートの並び → 行番号」で渡す)。
 *
 * @param today `YYYY-MM-DD`。⚠ 呼び側が渡す(この module は時計を読まない)。
 * @param withUndated 日付なしの束を出すか(既定 `false` = 出さない)。
 * @param repeat 繰り返しの展開に要るもの(#344 段②)。
 *   `skip` は 🔴 **済んだ回の実体**(`materializedDates`)── ⚠ **絞り込みで
 *   消えた札からも作る**こと(既定では済んだ札を隠すので、隠れた実体を
 *   渡し忘れると**済ませた回がもう一度出る**)。
 */
export function buildAgenda(
  cards: readonly AgendaItem[],
  today: string,
  withUndated = false,
  repeat?: {
    readonly skip?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly horizonDays?: number;
  },
): AgendaGroup[] {
  const tomorrow = addDays(today, 1) ?? '';
  const byDate = new Map<string, AgendaItem[]>();
  const undated: AgendaItem[] = [];
  const horizon = addDays(today, repeat?.horizonDays ?? AGENDA_REPEAT_HORIZON_DAYS) ?? today;
  const put = (day: string, item: AgendaItem): void => {
    const list = byDate.get(day);
    if (list === undefined) byDate.set(day, [item]);
    else list.push(item);
  };
  for (const c of cards) {
    if (c.date === null) {
      undated.push(c);
      continue;
    }
    /**
     * 🔴 **繰り返しは「今日から先」に出す**(#344 段②)。
     *
     * ⚠ 過ぎた回は出さない ── 出すと `@2020-01-06 毎週` が
     *   **期限切れを 340 個**並べる。🔑 過ぎた回で残っているのは
     *   「押した回 = 本文の実体の行」だけで、それは**普通の札**として出る。
     * ⚠ 窓の端は**開始の回まで必ず伸ばす** ── 伸ばさないと
     *   `@2027-06-01 毎年` が**画面から消える**(繰り返しにした瞬間に
     *   見えなくなる = 動線を 1 つ削る)。
     * ⚠ 回の札は**いつも未チェック**にする ── 済んだかどうかは**その回**の
     *   属性であって、規則の行の印ではない(規則の行に印を付けたら、それは
     *   「この繰り返しはもう終わり」であって「今日のぶんが済んだ」ではない)。
     */
    if (c.repeat !== null) {
      const ex = expandRepeat({
        anchor: c.date,
        unit: c.repeat,
        until: c.until,
        from: today,
        to: horizon < c.date ? c.date : horizon,
        skip: repeat?.skip?.get(repeatMateKey(c.lid, c.text)),
      });
      for (const day of ex.days)
        put(day, { ...c, key: `${c.key} ${day}`, date: day, until: null, done: false });
      continue;
    }
    /**
     * 🔴 **期間は「出る日」ぜんぶに置く**(#344 段①)。
     * ⚠ 鍵に**その日**を足す ── 足さないと、描画側の再利用表が同じ鍵を
     *   見つけて **1 枚の DOM を日から日へ動かし、最後の日にしか出ない**。
     */
    const days = c.until === null ? [c.date] : daysOfRange(c.date, c.until);
    for (const day of days) put(day, days.length === 1 ? c : { ...c, key: `${c.key} ${day}` });
  }
  const groups: AgendaGroup[] = [...byDate.keys()]
    .sort()
    .map((date) => ({
      date,
      label: labelOf(date, today, tomorrow),
      /**
       * 🔴 **期限切れ = その日に「済んでいなくて、終わりが今日より前」の予定が在る**(#1087)。
       * ⚠ 直す前は `date < today` だけだった ── ① 済んだ項目しかない過去の日(「済み」を出したとき)
       *   ② **続いている期間の途中の日**(8/21〜8/25 を 8/23 に見ると 8/21・8/22 が赤い)が、
       *   どちらも期限を過ぎていないのに赤くなった。
       * 🔑 期間の札は全部の日に同じ `until` で載る ── 終わりが今日以降なら、過ぎた日も赤くしない。
       * ⚠ 文字列で比べる(`YYYY-MM-DD` は辞書順 = 日付順)。
       */
      overdue:
        date < today &&
        byDate.get(date)!.some((c) => !c.done && (c.until ?? c.date ?? date) < today),
      cards: sortByTime(byDate.get(date)!),
    }));
  if (withUndated && undated.length > 0)
    groups.push({ date: null, label: '日付なし', overdue: false, cards: undated });
  return groups;
}

/**
 * 🔴 **「今日」の見出しを、予定が 0 件でも出す**(Gemini 裁定 = #1163 の依頼 34 の Q2、#1626)。
 *
 * ⚠ 直す前は今日の項目が 1 件以上ある日にしか見出しが出ず、まっさらな朝は、昨日の項目を掴んでも**落とす先が無かった**。
 * 🔑 一覧に出す束だけに使う。⚠ 小さな月の点・「予定がありません」の判定・束の数は、**この関数を通す前**の束で数える
 *   (今日に予定が無いのに点が付いたり、空の一覧に見えなくなったりしない)。
 */
export function withTodayGroup(groups: readonly AgendaGroup[], today: string): AgendaGroup[] {
  if (groups.some((g) => g.date === today)) return [...groups];
  const empty: AgendaGroup = { date: today, label: '今日', overdue: false, cards: [] };
  const at = groups.findIndex((g) => g.date === null || g.date > today);
  if (at < 0) return [...groups, empty];
  return [...groups.slice(0, at), empty, ...groups.slice(at)];
}

/**
 * 時刻の昇順。⚠ **時刻なしは後ろ** ── 「いつか今日やる」は「10:00 の予定」より後。
 * ⚠ **安定** に並べる(同じ時刻は渡された順)── `sort` は安定なので、
 *   同値で `0` を返せばよい。
 */
function sortByTime(cards: readonly AgendaItem[]): AgendaItem[] {
  return [...cards].sort((a, b) => {
    /**
     * 🔴 **期間(= 終日)はその日の先頭**(#344 段①)。
     * ⚠ 期間の札は `time` を持たないので、直す前の規則では**いちばん後ろ**へ行った
     *   ── 「この日は出張中」は、その日の 10:00 の予定より**前提**である
     *   (だから上に出す)。⚠ 「いつか今日やる」を後ろへ置く理由とは向きが逆になるが、
     *   同じ理由で決まっている:**その日の読み方に効く順**に並べる。
     */
    // 🔴 終日と明示した予定(台帳 #344 の残り)も期間と同じ先頭 ── 「この日は休み」は 10:00 の予定より前提。時刻未定は後ろのまま
    const rank = (c: AgendaItem): number => (c.until !== null || c.allDay === true ? 0 : c.time === null ? 2 : 1);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.time === b.time || a.time === null || b.time === null) return 0;
    return a.time < b.time ? -1 : 1;
  });
}
