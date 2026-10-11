/**
 * 🔴 **予定を動かした直後の「元に戻す」の材料**(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 6)。
 *
 * 札を日へ落とす / 目盛りで時刻を動かす / 下の縁を引く、のあとに 1 行
 * 「10/5(月) 16:00〜17:00 へ動かしました [元に戻す]」を出す(出す所と押した後は
 * `ui/render/schedule-undo.ts`)。ここは **画面に触らない純粋な部分**だけを持つ:
 *
 * - 何を言うか(`moveMessage`)
 * - 押したとき、いまの本文がまだ「動かした直後」かの判定(`undoVerdict`)
 *
 * 🔑 戻すのは**逆向きの書換を 1 手撃つ**形(新しい書込経路を作らない ── `SET_TASK_DATE` /
 *   `SET_ENTRY_DATE` が戻し先を受ける)。`UNDO_MOVE`(塊の移動の取り消し)は行の並びを戻す物で、
 *   日付の書き換えは戻せないので使わない。
 */
import { weekColumnLabel } from './day-layout';
import { stripLineDate } from './line-date';
import { formatTimeSpan } from './schedule-date';

/** 札 1 枚の「いつ」(動かす前 / 動かした後)。`date: null` = 日付なし。 */
export interface Slot {
  readonly date: string | null;
  readonly time: string | null;
  readonly timeEnd: string | null;
  readonly until: string | null;
  /**
   * 🔴 **行の中身の指紋**(日付の字を除いた本文。空白は 1 つに畳む)。⚠ 日付・時刻だけの比べでは、
   *   別の窓が行を差し込んで「N 行目が別の予定になり、たまたま同じ日・同じ時刻」の場面で、
   *   戻す手が**別の予定**を書き換える。中身まで比べて、違えば戻さない。ノート 1 件の予定は `''`。
   */
  readonly text: string;
}

/** 札(走査の 1 件)から、動かす前 / 後の姿を作る。⚠ 指紋は日付の字を除くので、動かしても変わらない。 */
export function slotOfCard(c: {
  readonly date: string | null;
  readonly time: string | null;
  readonly timeEnd: string | null;
  readonly until: string | null;
  readonly text: string;
}): Slot {
  return {
    date: c.date,
    time: c.time,
    timeEnd: c.timeEnd,
    until: c.until,
    text: stripLineDate(c.text).replace(/\s+/g, ' ').trim(),
  };
}

/** 知らせを出しておく長さ(ms)。⚠ 画面の下の知らせの寿命(`STATUS_RESULT_VISIBLE_MS` = 6 秒)より少し長く ── 先に降りるのは知らせのほう。 */
export const MOVE_OFFER_MS = 7000;

/**
 * 画面に出す 1 行(「元に戻す」ボタンの前)。
 * - 日付なしへ外した → 「予定から外しました」
 * - 日が付いている → 「10/5(月) 16:00〜17:00 へ動かしました」(時刻が無ければ日だけ)
 * `verb` は縁を引いて終わりだけを変えたとき `'changed'`(「に変えました」)。
 */
export function moveMessage(after: Slot, verb: 'moved' | 'changed' = 'moved'): string {
  if (after.date === null) return '予定から外しました';
  const label = weekColumnLabel(after.date);
  const day = label.weekday === '' ? label.date : `${label.date}(${label.weekday})`;
  const when = after.time === null ? day : `${day} ${formatTimeSpan(after.time, after.timeEnd)}`;
  return `${when} ${verb === 'moved' ? 'へ動かしました' : 'に変えました'}`;
}

/** 2 つの姿が同じか(日・時刻・幅・期間・中身の指紋のすべて)。 */
export function sameSlot(a: Slot, b: Slot): boolean {
  return (
    a.date === b.date && a.time === b.time && a.timeEnd === b.timeEnd && a.until === b.until && a.text === b.text
  );
}

/**
 * 「元に戻す」を押したとき、戻してよいか。
 *
 * - `current` = いま走査で見えている同じ行(行が無い / 走査が済んでいない = `undefined`)
 * - 動かした直後の姿(`after`)か、まだ書き換わっていない姿(`before`。書込と走査の間に押した)なら `'revert'`
 * - どちらでもない = 動かした後に本文が変わった。戻すと**行番号の違う別の行 / 後から直した字**を壊すので `'changed'`
 * - 走査が済んでいないとき(`current` が `undefined` かつ `scanned: false`)は確かめようが無いので `'revert'`
 */
export function undoVerdict(
  current: Slot | undefined,
  scanned: boolean,
  before: Slot,
  after: Slot,
): 'revert' | 'changed' {
  if (current === undefined) return scanned ? 'changed' : 'revert';
  return sameSlot(current, after) || sameSlot(current, before) ? 'revert' : 'changed';
}
