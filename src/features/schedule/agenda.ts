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
import type { TaskCard } from '../kanban/kanban-data';

/** 1 日ぶん(または「日付なし」)の束。 */
export interface AgendaGroup {
  /** `YYYY-MM-DD`。`null` = 日付なし。 */
  readonly date: string | null;
  /** 画面に出す名前(今日 / 明日 / `8/27(木)` / 日付なし)。 */
  readonly label: string;
  /** 🔴 今日より前か。⚠ **落とすのではなく、印を付ける**。 */
  readonly overdue: boolean;
  readonly cards: readonly TaskCard[];
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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  // ⚠ 形が違う値は**そのまま出す**(読めなかったことが見えるほうが良い)
  if (m === null) return date;
  const [, y, mo, d] = m;
  /**
   * 曜日は `Date` で引く。⚠ ここは**実在する日**にしか使わない ── 実在しない
   * 日は `getTime()` が `NaN` になるので、そのときは曜日を出さない。
   */
  const at = new Date(Number(y), Number(mo) - 1, Number(d));
  const same =
    at.getFullYear() === Number(y) &&
    at.getMonth() === Number(mo) - 1 &&
    at.getDate() === Number(d);
  const head = `${Number(mo)}/${Number(d)}`;
  return same ? `${head}(${WEEKDAYS[at.getDay()]})` : head;
}

/** 翌日の `YYYY-MM-DD`。⚠ 月末・年末をまたぐので `Date` に任せる。 */
function nextDay(today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (m === null) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
  cards: readonly TaskCard[],
  today: string,
  withUndated = false,
): AgendaGroup[] {
  const tomorrow = nextDay(today);
  const byDate = new Map<string, TaskCard[]>();
  const undated: TaskCard[] = [];
  for (const c of cards) {
    if (c.date === null) undated.push(c);
    else {
      const list = byDate.get(c.date);
      if (list === undefined) byDate.set(c.date, [c]);
      else list.push(c);
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
function sortByTime(cards: readonly TaskCard[]): TaskCard[] {
  return [...cards].sort((a, b) => {
    if (a.time === b.time) return 0;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return a.time < b.time ? -1 : 1;
  });
}
