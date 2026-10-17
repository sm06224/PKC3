/**
 * 🔴 **今日のノートを開く**(#348、user 裁定 2026-08-23「推奨で OK」)。
 *
 * ## user の物語
 *
 * 思いついたことをすぐ書きたいのに、**まず「どこに書くか」を決めさせられる** ──
 * 新規を押し、題名を考え、そのうちどこへ書いたか分からなくなる。
 * 🔑 **その日の入れ物が 1 つ決まっていれば、迷いが消える**。
 *
 * ## 決めたこと(裁定「新しいアーキタイプは作らない」)
 *
 * - 実体は**ただの `text` ノート**である。フレーバーも列も足さない
 *   (3 系統目の束ね方を作らない ── CLAUDE.md §7)
 * - 見分けは **題名が今日の日付**(`YYYY-MM-DD`)であること。
 *   🔑 **名前で見分ける**のは、この repo が 2026-08-19 に出した裁定と同じ向きである
 *   ── id を本文に書くと、復元が body を書き換えない既知の穴を踏む
 * - ⚠ 日付の作り方は `shortcutDate('today')` **1 本**にする ── 別々に桁を詰めると、
 *   月末や 1 桁の月で**同じ日が別の字**になる(CLAUDE.md §7)
 *
 * ## ⚠ frontmatter の `date` は書かない
 *
 * 書くと**予定の面に並ぶ** ── 「今日書いたこと」は予定ではないので、
 * 板と日別の一覧が日記で埋まる。⚠ user が自分で書けば、もちろん並んでよい。
 */
import { shortcutDate } from './date-shortcuts';
import { isRealCalendarDate } from './schedule-date';
import type { EntryMeta } from '@core/model/entry-meta';

/** 今日の入れ物の題名(`YYYY-MM-DD`)。 */
export function todayNoteTitle(now: Date): string {
  return shortcutDate('today', now);
}

/**
 * 今日のノートを探す。
 *
 * ⚠ **ゴミ箱の中は拾わない** ── 拾うと「開いたのに一覧に無い」になる
 *   (user から見ると壊れている)。捨てたなら**新しく作る**のが素直である。
 * ⚠ 種類は問わない ── user がその日の入れ物を別の種類に変えていたら、
 *   それは**その user の決め方**であって、こちらが上書きするものではない。
 * 🔑 同じ題名が複数在ったら**先に作られたほう**(`entryOrder` が小さいほう)を返す
 *   ── 押すたびに違うノートが開くと、user は「どっちが本物か」を追えなくなる。
 */
export function findTodayNote(metas: Iterable<EntryMeta>, title: string): EntryMeta | null {
  let best: EntryMeta | null = null;
  for (const m of metas) {
    if (m.title !== title || m.archived) continue;
    if (best === null || m.entryOrder < best.entryOrder) best = m;
  }
  return best;
}

/** 題名が `YYYY-MM-DD` の実在する日付か(`2026-13-45` は日付ではない)。 */
export function isDateTitle(title: string): boolean {
  // 🔑 形と月日の範囲は `isRealCalendarDate` 1 本(日付を切る規則を 2 本目にしない ── CLAUDE.md §7)
  return isRealCalendarDate(title);
}

/**
 * 🔴 **前の日・次の日のノートを探す**(#1640 ②。依頼 58 の答え = 「操作を探す」に名前で呼べる口を足す)。
 *
 * 🔑 **ノートがある日だけ飛ぶ**(無い日は飛ばす ── 開くだけでノートが勝手に増えない)。
 * ⚠ ゴミ箱の中は拾わない(`findTodayNote` と同じ)。同じ題名が複数在れば先に作られたほう。
 * ⚠ 題名の並びは文字列順 ── `YYYY-MM-DD` は桁が揃っているので日付順と一致する。
 * @returns 無ければ `null`(いちばん古い日の「前」/ いちばん新しい日の「次」)
 */
export function adjacentDateNote(
  metas: Iterable<EntryMeta>,
  currentTitle: string,
  dir: 'prev' | 'next',
): EntryMeta | null {
  let best: EntryMeta | null = null;
  for (const m of metas) {
    if (m.archived || !isDateTitle(m.title)) continue;
    const ok = dir === 'prev' ? m.title < currentTitle : m.title > currentTitle;
    if (!ok) continue;
    if (best === null) {
      best = m;
      continue;
    }
    const nearer = dir === 'prev' ? m.title > best.title : m.title < best.title;
    if (nearer || (m.title === best.title && m.entryOrder < best.entryOrder)) best = m;
  }
  return best;
}

/**
 * 🔴 **本文の `@2026-10-15` を押したが、その日のノートが無かったとき**の字(#1169)。
 *
 * 🔑 **知らせの字と押し口の字を 1 か所で持つ** ── 出し入れ(`status-open.ts`)と
 *   出す側(`binder.ts` の受け手)が別々に綴ると、片方だけ変えた日に
 *   「押し口が出ない」が静かに起きる(CLAUDE.md §7)。
 * ⚠ 作るのは**押し口を押したとき**で、日付を押した時点では作らない
 *   (打ち間違いの日付でノートが増えない)。
 */
export function dateNoteMissingNotice(date: string): string {
  return `${date} のノートはまだありません`;
}

/** その押し口の字。 */
export function dateNoteCreateLabel(date: string): string {
  return `${date} のノートを作る`;
}
