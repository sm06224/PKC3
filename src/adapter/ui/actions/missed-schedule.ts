/**
 * 🔴 **次に開いたとき、見逃した予定を 1 行で知らせる**(#855 20-C。Gemini 裁定 = #1163 の依頼 20-C「両方」)。
 *
 * 手順は 4 つ(順番が効く):
 * 1. **前に開いていた時刻を読む**(このコレクション・この端末の分)── ⚠ 進める**前**に読む
 * 2. **いま開いていることを憶える**(以後も刻みで進める ── 閉じた時刻の近似)
 * 3. 前の時刻が無い(この端末でこのコレクションの予定表を使ったことが無い)/ 設定が切 → **何もしない**(走査も頼まない)
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
 *   チェック項目を持つノートだけに絞られる(`task-cards.ts`)。**予定表を使ったことが無い端末・設定が切の端末では頼まない**。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { silencedLidsOf } from '@features/alarm/alarm-due';
import {
  localDateOfMs,
  missedItems,
  missedLabel,
  upcomingCounts,
  upcomingLabel,
} from '@features/schedule/schedule-notify';
import type { ScheduleNotifyStore } from '../render/schedule-notify';

/** 開いている間、時刻を進める間隔。⚠ 短いほど「閉じた時刻」に近い(閉じる直前の予定を見逃しに数えない)。 */
export const LAST_OPEN_TICK_MS = 15_000;

/** 起動時に予定を数えられなかったとき。⚠ 黙ると「見逃した予定は無かった」と読まれる。 */
export const MISSED_SCAN_FAILED_TEXT = '予定を数えられなかったので、見逃した予定をお知らせできません';

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
  /**
   * 🔴 **このタブが知らせる役か**(#1087)── 開いているタブの数だけ同じ「見逃した予定」が出るのを防ぐ。
   * 本体(holder)のタブだけが**前の時刻を進め、数え、言う**。省略 = 常に役(test)。
   * ⚠ 役でないタブも**刻みで時刻は進める**(本体が閉じたあと、残ったタブが開いている間を
   *   次の起動で「見逃した」と数えないため)。⚠ 起動時の時刻の書込は本体だけ ── 役でないタブが先に書くと、
   *   本体が読む前に「前に開いていた時刻」が消える。
   */
  readonly isRinger?: () => boolean;
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

  const ringer = deps.isRinger === undefined ? true : deps.isRinger();
  const lastOpen = deps.store.lastOpen(deps.cid); // ⚠ 進める前に読む
  const startedAt = now();
  let untick: (() => void) | null = null;
  let unsub: (() => void) | null = null;
  let unsubUse: (() => void) | null = null;
  const done = (): void => {
    unsub?.();
    unsub = null;
  };
  /** 刻みを張る(時刻を進め続ける ── 見逃しの区間と開いている間の知らせが重ならない根拠)。 */
  const beat = (): void => {
    if (untick !== null) return;
    untick = tick(() => deps.store.stampOpen(deps.cid, now()));
  };

  if (lastOpen === null) {
    /**
     * 🔴 **このコレクションで予定表を使ったことが無い端末は、何も払わない**(予定を使わない人に全走査を負わせない
     * ── `app-state.ts` の方針)。記録が無い = 使っていない。時刻も書かず、走査も頼まない。
     * 予定の走査が頼まれた(= 予定表が開かれた)最初の時点から記録を始める。次の起動から見逃しを数える。
     */
    unsubUse = deps.dispatcher.onEvent((e) => {
      if (e.type !== 'REQUEST_TASK_SCAN') return;
      deps.store.stampOpen(deps.cid, now());
      beat();
      unsubUse?.();
      unsubUse = null;
    });
  } else if (!ringer) {
    // 🔴 役でないタブ ── 起動時の書込も数えも言いもしない(本体が 1 回だけ言う)。刻みは張る(時刻の進みは止めない)
    beat();
  } else {
    deps.store.stampOpen(deps.cid, startedAt);
    beat();
    if (deps.store.missedOn()) {
      const check = (): boolean => {
        const st = deps.dispatcher.getState();
        if (st.taskScanFailed) {
          // 🔴 集められなかった ── 数えられていないことを言う(「見逃しは無い」と読まれない)
          deps.post(MISSED_SCAN_FAILED_TEXT);
          return true;
        }
        if (st.taskScan === null) return false;
        const silenced = silencedLidsOf(st.entryMetas, st.scheduleHiddenNotes);
        const n = missedItems(st.taskScan.cards, lastOpen, startedAt, silenced).length;
        if (n > 0) {
          deps.paint(n);
          deps.post(missedLabel(n));
        }
        /**
         * 🔴 **今日と明日の予定を 1 行で言う**(台帳 #1852 束 E1、依頼 57 の 1)── 日付だけの予定は音も見逃しも出ないので、
         *   開いたとき 1 度だけ件数を言う。⚠ 見逃しと同じ口・同じ設定(「見逃した予定をお知らせする」)に乗せる。
         */
        const next = upcomingLabel(upcomingCounts(st.taskScan.cards, localDateOfMs(startedAt), silenced));
        if (next !== null) deps.post(next);
        return true;
      };
      unsub = deps.dispatcher.onState(() => {
        if (check()) done();
      });
      deps.dispatcher.dispatch({ type: 'REFRESH_TASK_SCAN' });
      // 既に集まっていた場合(onState は次の変化まで来ない)
      if (check()) done();
    }
  }

  return {
    stop(): void {
      untick?.();
      unsubUse?.();
      unsubUse = null;
      done();
    },
  };
}
