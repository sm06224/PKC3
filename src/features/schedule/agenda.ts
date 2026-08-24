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
  /**
   * 🔴 **期間の終わり**(`@2026-08-25..2026-08-28`)。期間でなければ `null`(#344 段①)。
   * ⚠ **`date` から `until` まで、すべての日の束に出る** ── 1 点として置くと
   *   途中の日に出ず、「予定を見に来たのに載っていない」になる。
   * ⚠ **ノート 1 件の予定(frontmatter の `date:`)には期間が無い** ── そちらは
   *   `end:` を持てる場所が無い(抽出列を増やす = schema の移行)ので**段②**にした。
   *   非対称であることを承知で切っている(#344 に書いてある)。
   */
  readonly until: string | null;
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
    until: card.until,
  };
}

/**
 * ノート 1 件を予定にする(frontmatter の `date:`)。
 * ⚠ 鍵は `line` の代わりに `note` ── 行の札と**衝突しない**形にする。
 */
export function itemOfNote(meta: EntryMeta): AgendaItem {
  return {
    key: `${meta.lid} note`,
    lid: meta.lid,
    line: null,
    text: meta.title,
    done: false,
    date: meta.date,
    time: null,
    // ⚠ frontmatter には期間の置き場が無い(#344 段②)── 常に `null`
    until: null,
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
 * 札を日ごとの束にする。
 *
 * 🔑 **並びは「日付の昇順、日付なしは最後」**。⚠ 期限切れは昇順の自然な結果として
 *   先頭に来る ── 別扱いで並べ替えない(規則を 2 つ持たない)。
 * ⚠ 束の中は **時刻の昇順、時刻なしは後**。同じ時刻は**渡された順**を保つ
 *   (呼び側が「ノートの並び → 行番号」で渡す)。
 *
 * @param today `YYYY-MM-DD`。⚠ 呼び側が渡す(この module は時計を読まない)。
 * @param withUndated 日付なしの束を出すか(既定 `false` = 出さない)。
 */
export function buildAgenda(
  cards: readonly AgendaItem[],
  today: string,
  withUndated = false,
): AgendaGroup[] {
  const tomorrow = addDays(today, 1) ?? '';
  const byDate = new Map<string, AgendaItem[]>();
  const undated: AgendaItem[] = [];
  for (const c of cards) {
    if (c.date === null) {
      undated.push(c);
      continue;
    }
    /**
     * 🔴 **期間は「出る日」ぜんぶに置く**(#344 段①)。
     * ⚠ 鍵に**その日**を足す ── 足さないと、描画側の再利用表が同じ鍵を
     *   見つけて **1 枚の DOM を日から日へ動かし、最後の日にしか出ない**。
     */
    const days = c.until === null ? [c.date] : daysOfRange(c.date, c.until);
    for (const day of days) {
      const at: AgendaItem = days.length === 1 ? c : { ...c, key: `${c.key} ${day}` };
      const list = byDate.get(day);
      if (list === undefined) byDate.set(day, [at]);
      else list.push(at);
    }
  }
  const groups: AgendaGroup[] = [...byDate.keys()]
    .sort()
    .map((date) => ({
      date,
      label: labelOf(date, today, tomorrow),
      // ⚠ 文字列で比べる(`YYYY-MM-DD` は辞書順 = 日付順)
      overdue: date < today,
      cards: sortByTime(byDate.get(date)!),
    }));
  if (withUndated && undated.length > 0)
    groups.push({ date: null, label: '日付なし', overdue: false, cards: undated });
  return groups;
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
    const rank = (c: AgendaItem): number => (c.until !== null ? 0 : c.time === null ? 2 : 1);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.time === b.time || a.time === null || b.time === null) return 0;
    return a.time < b.time ? -1 : 1;
  });
}
