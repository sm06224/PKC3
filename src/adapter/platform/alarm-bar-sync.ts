/**
 * 🔴 **予定の知らせの帯を、開いている全部のウィンドウに出す**(#1163 の依頼 347 案 A。Gemini の裁定:推薦どおり)。
 *
 * ## 何が起きていたか
 *
 * 時刻つきの予定の知らせは、書き込みの本体(holder)のタブでだけ鳴り、画面の下の帯もそこにだけ出ていた。
 * 本体のタブが裏や最小化されていると、いま見ているタブには何も出ない。
 *
 * ## 作り
 *
 * - **音は本体だけ**(これまでどおり ── 重なって鳴らない)。
 * - **帯は全部のウィンドウに出す**。本体が「いま鳴っている一覧」を放送し、ほかのウィンドウは受けて描く。
 * - どこで閉じても全部で消える。ほかのウィンドウで閉じたら本体へ「閉じて」と頼み、本体が片付けて一覧を放送し直す
 *   (片付けの規則を 2 つ持たない ── 正本は本体の `alarm.ts`)。
 * - 新しく開いたウィンドウは「いまの一覧をください」と頼む(鳴ってから開いたウィンドウにも帯が出る)。
 *
 * ⚠ 放送路は他の台帳・store とは**別の名前**(混ぜない)。可搬単一 HTML はバンドルごとに切る(`main.ts`)。
 * ⚠ 一覧の中身は予定の字を含むが、同じ origin の自分のウィンドウにしか届かない(外へは出ない)。
 */
import type { AlarmDue } from '@features/alarm/alarm-due';
import type { Broadcaster } from './storage/store-proxy';

export const ALARM_BAR_CHANNEL = 'pkc3-alarm-bar';

export const ALARM_BAR_STATE = 'alarm-bar-state';
export const ALARM_BAR_DISMISS = 'alarm-bar-dismiss';
export const ALARM_BAR_DISMISS_ALL = 'alarm-bar-dismiss-all';
export const ALARM_BAR_HELLO = 'alarm-bar-hello';

interface Wire {
  readonly tag: string;
  readonly from: string;
  readonly due?: readonly AlarmDue[];
  readonly key?: string;
}

export interface AlarmBarSyncDeps {
  /** 放送路。⚠ `null` なら何も送らない・受けない(この窓の帯は、これまでどおり本体の分だけ)。 */
  readonly channel: Broadcaster | null;
  /** この窓の id(自分の放送を数えない)。 */
  readonly id: string;
  /** この窓が鳴らす役(本体)か。⚠ 読むたびに引く(昇格で変わる)。 */
  readonly isRinger: () => boolean;
  /** 本体の、いま鳴っている一覧。 */
  readonly ringing: () => readonly AlarmDue[];
  /** 本体で 1 件を片付ける(`alarmService.dismiss`)。 */
  readonly dismiss: (key: string) => void;
  /** 本体で全部を片付ける(`alarmService.dismissAll`)。 */
  readonly dismissAll: () => void;
  /** ほかのウィンドウの帯を描く(本体でない窓だけが呼ぶ)。 */
  readonly paint: (due: readonly AlarmDue[]) => void;
}

export interface AlarmBarSync {
  /** 本体が、鳴っている一覧が変わったときに呼ぶ。 */
  publish(due: readonly AlarmDue[]): void;
  /**
   * 帯の「閉じる」「開く」で 1 件片付ける。本体はそのまま片付ける。
   * ほかのウィンドウは、その場で帯から外し、本体へ頼む。
   */
  dismiss(key: string): void;
  /** 全部片付ける(知らせを切ったとき)。 */
  dismissAll(): void;
}

export function createAlarmBarSync(deps: AlarmBarSyncDeps): AlarmBarSync {
  /** 本体でない窓が、最後に受けた一覧。 */
  let remote: readonly AlarmDue[] = [];
  const send = (w: Omit<Wire, 'from'>): void => {
    deps.channel?.postMessage({ ...w, from: deps.id } satisfies Wire);
  };
  if (deps.channel !== null) {
    deps.channel.onmessage = (ev: MessageEvent): void => {
      const w = ev.data as Wire | null;
      if (w === null || typeof w !== 'object' || w.from === deps.id) return;
      const ringer = deps.isRinger();
      switch (w.tag) {
        case ALARM_BAR_STATE:
          // ⚠ 本体は自分の一覧が正本 ── ほかの窓の放送では描き直さない
          if (ringer || !Array.isArray(w.due)) return;
          remote = w.due;
          deps.paint(remote);
          return;
        case ALARM_BAR_DISMISS:
          if (ringer && typeof w.key === 'string') deps.dismiss(w.key);
          return;
        case ALARM_BAR_DISMISS_ALL:
          if (ringer) deps.dismissAll();
          return;
        case ALARM_BAR_HELLO:
          if (ringer) send({ tag: ALARM_BAR_STATE, due: deps.ringing() });
          return;
        default:
      }
    };
    // 新しく開いた窓は、いま鳴っている一覧を頼む
    send({ tag: ALARM_BAR_HELLO });
  }
  return {
    publish(due) {
      send({ tag: ALARM_BAR_STATE, due });
    },
    dismiss(key) {
      if (deps.isRinger()) {
        deps.dismiss(key);
        return;
      }
      remote = remote.filter((d) => d.key !== key);
      deps.paint(remote);
      send({ tag: ALARM_BAR_DISMISS, key });
    },
    dismissAll() {
      if (deps.isRinger()) {
        deps.dismissAll();
        return;
      }
      remote = [];
      deps.paint(remote);
      send({ tag: ALARM_BAR_DISMISS_ALL });
    },
  };
}
