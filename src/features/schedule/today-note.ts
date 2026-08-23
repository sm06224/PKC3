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
