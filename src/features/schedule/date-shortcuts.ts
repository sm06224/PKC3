/**
 * 🔴 **「今日 / 明日 / 今週末 / 来週」を日付にする**(user 指示 2026-08-23)。
 *
 * > 「**日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
 * > ついてくるツールとか用意されてもいいかも**」
 *
 * 予定に付ける日付は**ほとんどが数日以内**なので、格子から選ばせる前に
 * **名前で選ばせる**。⚠ 「めんどくさい」の中身は「数字を打つこと」なので、
 * ここが効かないと道具を足した意味が無い。
 *
 * ## ⚠ 語の意味を、ここで**決めて書き残す**
 *
 * 「今週末」「来週」は人によって指す日が違う。⚠ **決めずに実装すると、
 * 実装した本人しか知らない規則が画面に出る**ので、ここに明記して test で pin する。
 *
 * | 語 | 決めた意味 | 迷いどころ |
 * |---|---|---|
 * | 今日 | その日 | ── |
 * | 明日 | 翌日 | ── |
 * | **今週末** | **次に来る土曜**(土曜なら当日) | ⚠ 日曜に押すと **6 日後**(次の土曜)。過去は返さない |
 * | **来週** | **次に来る月曜**(月曜なら 7 日後) | ⚠ 「来週」は必ず**今週より後** ── 月曜に押して当日を返すと「来週」ではない |
 *
 * 🔑 **どれも今日より前を返さない。** 予定を過去に置く近道は要らない
 * (過去に置きたい人は日付欄に打つ)。
 *
 * 🔑 **pure module**。⚠ `new Date()` を内部で読まない ── 呼び側が渡す
 * (読むと test が「実行した日」で変わる。CLAUDE.md「『今年』は引数で渡す」)。
 */
import { dateKey } from './month-grid';

/** 近道の並び。⚠ **画面の並び順そのもの**(近い順)。 */
export const DATE_SHORTCUTS = [
  { id: 'today', label: '今日' },
  { id: 'tomorrow', label: '明日' },
  { id: 'weekend', label: '今週末' },
  { id: 'next-week', label: '来週' },
] as const;

export type DateShortcut = (typeof DATE_SHORTCUTS)[number]['id'];

export function isDateShortcut(v: string): v is DateShortcut {
  return DATE_SHORTCUTS.some((s) => s.id === v);
}

/** 何日先か。⚠ 規則はここ 1 か所(表と実装を別々に書かない)。 */
function daysAhead(id: DateShortcut, dow: number): number {
  switch (id) {
    case 'today':
      return 0;
    case 'tomorrow':
      return 1;
    /**
     * 次に来る土曜(`dow === 6`)。⚠ 土曜なら **0**(当日)。
     *
     * ⚠ **`% 7` は書かない**(2026-08-23 の変異試験 T9 が教えた)── 1 稿目は
     *   `(6 - dow + 7) % 7` と書き、「日曜で 6 になるから要る」と**注釈まで付けた**が、
     *   `dow` は 0〜6 なので `6 - dow` は**もともと 0〜6** ── 剰余は 1 度も効かない。
     * 🔑 CLAUDE.md「**『これが無いと壊れる』と書く前に、外して壊れるのを見る**」
     *   ── 見ないなら書かない(no-op は必ず SURVIVED になる)。
     */
    case 'weekend':
      return 6 - dow;
    /**
     * 次に来る月曜(`dow === 1`)。🔴 **月曜なら 7**(当日ではない)──
     * 「来週」は必ず今週より後である。
     * ⚠ `(1 - dow + 7) % 7` は月曜で 0 になるので、そこだけ 7 へ持ち上げる。
     */
    case 'next-week': {
      const d = (1 - dow + 7) % 7;
      return d === 0 ? 7 : d;
    }
  }
}

/**
 * 近道を `YYYY-MM-DD` にする。
 *
 * ⚠ **`Date` の日付だけを動かす**(時・分・秒には触らない)── 触ると
 *   夏時間の切り替わり日に 1 日ずれる箱がある。
 * 🔑 組み立ては `dateKey` 1 本(カレンダーの升目と**同じ関数**)── 別々に
 *   桁を詰めると、月末や 1 桁の月で**同じ日が別の字**になる(CLAUDE.md §7)。
 */
export function shortcutDate(id: DateShortcut, now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + daysAhead(id, now.getDay()));
  return dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
