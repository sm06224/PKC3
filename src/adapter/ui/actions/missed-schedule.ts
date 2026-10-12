/**
 * 🔴 **次に開いたとき、見逃した予定を 1 行で知らせる**(#855 20-C。Gemini 裁定 = #1163 の依頼 20-C「両方」)。
 *
 * 手順は 4 つ(順番が効く):
 * 1. **前に開いていた時刻を読む**(このコレクション・この端末の分)── ⚠ 進める**前**に読む
 * 2. **いま開いていることを憶える**(以後も刻みで進める ── 閉じた時刻の近似)
 * 3. 前の時刻が無い(この端末で初めて)/ 設定が切 → **何もしない**
 * 4. 予定の札が集まったら `missedItems` で数え、1 件以上なら**帯の 1 行 + メッセージ**で言う
 *
 * ## ⚠ 二重に知らせない
 *
 * 開いている間の知らせ(`alarm.ts`、30 秒の刻み、既定は切)は**その間に来た予定**を鳴らす。
 * ここが数えるのは**閉じていた間**(`(前に開いていた時刻, いま]`)なので、区間が重ならない。
 * 🔑 重ならないのは「開いている間は時刻を進め続ける」からである ── 刻みを止めると、
 *   開いていた間の予定を「見逃した」と数える。
 *
 * ⚠ **予定を数えるために全走査を頼む**(`REFRESH_TASK_SCAN`)。走査は storage worker の中で、
 *   チェック項目を持つノートだけに絞られる(`task-cards.ts`)。**初めて開いた端末・設定が切の端末では頼まない**。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { missedItems, missedLabel } from '@features/schedule/schedule-notify';
import type { ScheduleNotifyStore } from '../render/schedule-notify';

/** 開いている間、時刻を進める間隔。⚠ 短いほど「閉じた時刻」に近い(閉じる直前の予定を見逃しに数えない)。 */
export const LAST_OPEN_TICK_MS = 15_000;

export interface MissedWatchDeps {
  readonly dispatcher: Dispatcher;
  readonly store: ScheduleNotifyStore;
  readonly cid: string;
  readonly now?: () => number;
  /** 件数を帯に出す(0 = 畳む)。 */
  readonly paint: (count: number) => void;
  /** メッセージの集積地に積む(中身は件数だけ ── 予定の字は書かない)。 */
  readonly post: (text: string) => void;
  /** 刻みを張る口。返り値は外す関数。 */
  readonly tick?: (fn: () => void) => () => void;
}

export interface MissedWatch {
  /** 刻みを外す(test と畳むとき)。 */
  stop(): void;
}

export function startMissedWatch(deps: MissedWatchDeps): MissedWatch {
  const now = deps.now ?? ((): number => Date.now());
  const tick =
    deps.tick ??
    ((fn: () => void): (() => void) => {
      const id = setInterval(fn, LAST_OPEN_TICK_MS);
      return () => clearInterval(id);
    });

  const lastOpen = deps.store.lastOpen(deps.cid); // ⚠ 進める前に読む
  const startedAt = now();
  deps.store.stampOpen(deps.cid, startedAt);
  const untick = tick(() => deps.store.stampOpen(deps.cid, now()));

  let unsub: (() => void) | null = null;
  const done = (): void => {
    unsub?.();
    unsub = null;
  };

  if (lastOpen !== null && deps.store.missedOn()) {
    const check = (): boolean => {
      const st = deps.dispatcher.getState();
      if (st.taskScanFailed) return true; // 集められなかった ── 黙って終える
      if (st.taskScan === null) return false;
      const n = missedItems(st.taskScan.cards, lastOpen, startedAt).length;
      if (n > 0) {
        deps.paint(n);
        deps.post(missedLabel(n));
      }
      return true;
    };
    unsub = deps.dispatcher.onState(() => {
      if (check()) done();
    });
    deps.dispatcher.dispatch({ type: 'REFRESH_TASK_SCAN' });
    // 既に集まっていた場合(onState は次の変化まで来ない)
    if (check()) done();
  }

  return {
    stop(): void {
      untick();
      done();
    },
  };
}
