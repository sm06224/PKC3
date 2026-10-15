/**
 * 🔴 **予定の札を落として動かす書込の門**(#1087)。
 *
 * 落とす経路(`schedule-drag.ts` / `schedule-grid-drag.ts` / 「元に戻す」)は `binder.ts` の
 * `run()` を通らない ── だから ①書出し / 取込の実行中の断り(`refuseWhileBusy`)②別のタブ・窓が
 * 編集中のノートへの断り(`actUnlessEditedElsewhere`)が **どちらも素通り**だった。
 *
 * 🔑 門の中身は `binder.ts` が持つ(`services` はそこにしか無い)。ここは**入れ物だけ**:
 *   binder が dispatcher ごとに登録し、落とす側が撃つ前にここを通す。
 * ⚠ 登録が無い環境(binder を立てない unit)は素通し ── 門を確かめる test は本物の binder を立てる。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

/** 書込を撃つ前の門。断ったときは理由を出して `act` を呼ばない。 */
export type ScheduleWriteGate = (
  lids: readonly string[],
  /** 別のタブの編集を確かめられなかったときの字(次にすることを言う)。 */
  failed: string,
  act: () => void,
) => void;

const gates = new WeakMap<Dispatcher, ScheduleWriteGate>();

export function setScheduleWriteGate(dispatcher: Dispatcher, gate: ScheduleWriteGate | null): void {
  if (gate === null) gates.delete(dispatcher);
  else gates.set(dispatcher, gate);
}

/** 落として書く前に通す。門が無ければそのまま撃つ。 */
export function gatedScheduleWrite(
  dispatcher: Dispatcher,
  lids: readonly string[],
  failed: string,
  act: () => void,
): void {
  const gate = gates.get(dispatcher);
  if (gate === undefined) act();
  else gate(lids, failed, act);
}

export const SCHEDULE_DROP_FAILED =
  '予定を動かせませんでした(別のタブの編集を確かめられませんでした)。もう一度動かしてください';
