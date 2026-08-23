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
 * - ⚠ **期間(`start` / `end`)・繰り返し(`repeat`)はまだ無い。**
 *   ⚠ 「無い」ことをここに書き残すのは、**次に読む人が探さなくて済むように**
 *     である ── 入れるには entries 表に列が要る(schema の変更)。
 *   ⚠ 「本文を走査して期間を出す」で代用してはいけない ── それが #212 の穴。
 * - `status` は**列名そのもの**(`open` / `done` に限らない)。
 *   ⚠ 正規化(`'done' 以外は open`)は **todo フレーバーの都合**であって、
 *     普通のノートには当てはめない ── 当てはめると、`status` を書いていない
 *     全ノートが「未完了」としてカンバンに出る。
 */
import { parseFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { isScheduleDate } from './schedule-date';

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
  return typeof v === 'string' && isScheduleDate(v) ? v : null;
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
