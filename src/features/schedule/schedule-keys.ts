/**
 * 🔴 **予定の鍵の表**(#276 / #277。user 指示 2026-08-19
 * 「発想を変え、frontmatter でのカレンダー情報付与や
 * チェックリストを含む場合の自動生成でカンバンとカレンダーを復活させるのです」)。
 *
 * ## なぜ表を 1 つにするか
 *
 * カレンダー(#276)・カンバン(#277)・アラート(#280)は**同じ情報**を読む。
 * ⚠ 面ごとに鍵の名前を決めると、**同じ問いに答える口が 3 つ**になり、
 *   1 つ直しても他が古いまま残る(CLAUDE.md §7)。だから読む側も書く側も
 *   **この表だけ**を見る。
 *
 * ## いま決めていること / まだ決めていないこと
 *
 * - 🔴 **`date`(単日)だけを列にする** ── 抽出列は保存時に 1 度だけ書かれ、
 *   面を開くたびの全文走査を作らない(#212 と同じ穴を掘らないため)。
 * - 🔴 **「期間・繰り返しはまだ無い」と書いてあったが、それは frontmatter の話**
 *   である(2026-08-27 に訂正)。⚠ **本文の行**には既に全部書ける:
 *   `@2026-08-25 09:30`(時刻)/ `@2026-08-25..2026-08-28`(期間、#344 段①)/
 *   日付の直後の刻み(繰り返し、#344 段②)── 形の正本は `schedule-date.ts`、
 *   読むのは `line-date.ts` である。
 *   ⚠ **この古い記述で実際に誤りが 1 件出た**(#280 に「時刻はどこにも書けない」と
 *     書いた)── 「無い」は「在る」より強い主張なので、次に読む人は**確かめない**。
 *   ⚠ **frontmatter の側に無い**のは変わらない ── あちらは「ノート 1 件が丸ごと
 *     その日」という意味で、時刻・期間の置き場が無い(入れるなら抽出列 = schema の変更)。
 *   ⚠ 「本文を走査して期間を出す」で代用してはいけない ── それが #212 の穴。
 * - `status` は**列名そのもの**(`open` / `done` に限らない)。
 *   ⚠ 正規化(`'done' 以外は open`)は **todo フレーバーの都合**であって、
 *     普通のノートには当てはめない ── 当てはめると、`status` を書いていない
 *     全ノートが「未完了」としてカンバンに出る。
 */
import { parseFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { dateOfScheduleWhen, parseScheduleWhen, type ScheduleWhen } from './schedule-when';

/**
 * frontmatter に書く鍵。⚠ **文字列を直接書かない**(綴り間違いが静かに効く)。
 */
export const SCHEDULE_KEYS = {
  /** 日付(`YYYY-MM-DD`)。カレンダーはこれだけを見る。 */
  date: 'date',
  /** 状態(任意の語)。カンバンの列になる。 */
  status: 'status',
  /** 片付いた印。⚠ 列に写すのは todo だけ(下の `extractSchedule` を参照)。 */
  archived: 'archived',
  /**
   * 🔴 **担当**(#283。タスクとして扱う ── 状態・期日の次の 1 つ)。字で書く名前 1 つ。
   * ⚠ **列にしない**(保存の形を変えない)── 本文の前書きから読み、予定の走査が運ぶ(`noteTimeOf`)。
   *   連絡先のノートの題名と一致すれば、情報ペインで押せるリンクになる(無くても書ける)。
   */
  owner: 'owner',
} as const;

/**
 * 日付を読む。読めない形は `null`(本文はそのまま残る)。
 *
 * 🔴 **形を決めるのはここではない**(2026-08-23)── `features/schedule/schedule-date.ts`
 * の `isScheduleDate` 1 つである。⚠ 直す前はこの file が自前の正規表現を持っており、
 * **本文の行に書く `@2026-08-25`**(#292 の裁定 2026-08-23)を足すと
 * **「日付とは何か」に答える口が 2 つ**になるところだった(CLAUDE.md §7)。
 * ⚠ 食い違うと、user から見て「**frontmatter では書けるのに行では書けない日付**」が
 *   でき、しかも**理由が画面のどこにも出ない**(どちらも「日付を書いた」つもりなので)。
 * ⚠ 「読めなかった日付」は**捨てずに落とす**(列に入らないだけで、本文には残る)。
 */
export function readScheduleDate(meta: Record<string, FrontmatterValue>): string | null {
  const v = meta[SCHEDULE_KEYS.date];
  // 🔴 時刻つき・全角・`/` 区切りも日付の部分だけ読む(台帳 #1852 束 E1 ── 依頼 188 / 192 / 284)
  // 🔴 期間・繰り返し・終日つきの値も開始の日を読む(台帳 #344 の残り。文法は `schedule-when.ts` の 1 本)
  return typeof v === 'string' ? dateOfScheduleWhen(v) : null;
}

/**
 * 🔴 **ノート 1 件の予定の時刻を読む**(台帳 #1852 / 依頼 192 / 284。Gemini 回答 = 時刻も読む)。
 *
 * `date: 2026-10-20 14:00` / `date: 2026-10-20T14:00` の `14:00`。日付だけ・読めない時刻・時差つきは `null`。
 * ⚠ 抽出列(`entries.date`)には**日付だけ**を置く(保存の形は変えない)。時刻は本文から読み、予定表の走査が運ぶ
 *   (`task-cards.ts` の `noteTimeOf`)。前の版で書いたノートも、前の版が時刻を読まないだけで本文は 1 バイトも変わらない。
 */
export function readScheduleTime(meta: Record<string, FrontmatterValue>): string | null {
  const v = meta[SCHEDULE_KEYS.date];
  return typeof v === 'string' ? (parseScheduleWhen(v)?.time ?? null) : null;
}

/**
 * 🔴 **ノート 1 件の予定の「いつ」を全部読む**(台帳 #344 の残り ── 期間・繰り返し・終日)。読めなければ `null`。
 * ⚠ 抽出列には開始の日だけ(保存の形は変えない)。残りは本文から読み、予定表の走査が運ぶ(`noteTimeOf`)。
 */
export function readScheduleWhen(meta: Record<string, FrontmatterValue>): ScheduleWhen | null {
  const v = meta[SCHEDULE_KEYS.date];
  return typeof v === 'string' ? parseScheduleWhen(v) : null;
}

/**
 * 担当を読む(#283)。⚠ 書いていなければ `null`(既定値を作らない)。前後の空白は落とす。
 */
export function readScheduleOwner(meta: Record<string, FrontmatterValue>): string | null {
  const v = meta[SCHEDULE_KEYS.owner];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 状態を読む。⚠ **書いていなければ `null`** ── 既定値を作らない
 * (作ると、状態を書いていない全ノートがカンバンの 1 列目に並ぶ)。
 */
export function readScheduleStatus(meta: Record<string, FrontmatterValue>): string | null {
  const v = meta[SCHEDULE_KEYS.status];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 🔴 **普通のノートの抽出**(#276)。
 *
 * ⚠ **`archived` は写さない。** todo は「片付いた todo を一覧から外す」ために
 *   この列を使うが、普通のノートで同じことをすると **`archived: true` と書いた
 *   だけでノートが一覧から消える** ── 書いた本人にも消えた理由が分からない。
 *   カレンダーの「片付いたものも出す」は todo のためのものである。
 */
export function extractSchedule(body: string): { status: string | null; date: string | null } {
  const { meta } = parseFrontmatter(body);
  return { status: readScheduleStatus(meta), date: readScheduleDate(meta) };
}
