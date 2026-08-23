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
import { pad2 } from '../datetime/datetime-format';

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
  /** 描画の再利用と、掴んだときの荷物の鍵。⚠ **行まで含める**(1 ノートに複数在る)。 */
  readonly key: string;
  readonly lid: string;
  /** 原文の行番号。`null` = ノート 1 件が丸ごと予定。 */
  readonly line: number | null;
  readonly text: string;
  /** ⚠ ノート 1 件の予定に印は無い(チェックする「行」が無い)。 */
  readonly done: boolean;
  readonly date: string | null;
  readonly time: string | null;
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

/** 翌日の `YYYY-MM-DD`。⚠ 月末・年末をまたぐので `Date` に任せる。 */
function nextDay(today: string): string {
  const p = storedDateParts(today);
  if (p === null) return '';
  const d = new Date(Number(p.year), Number(p.month) - 1, Number(p.day) + 1);
  // ⚠ 桁の詰め方は `pad2` 1 か所(面ごとに書くと月末で字が食い違う)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
  const tomorrow = nextDay(today);
  const byDate = new Map<string, AgendaItem[]>();
  const undated: AgendaItem[] = [];
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
function sortByTime(cards: readonly AgendaItem[]): AgendaItem[] {
  return [...cards].sort((a, b) => {
    if (a.time === b.time) return 0;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return a.time < b.time ? -1 : 1;
  });
}
