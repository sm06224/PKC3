/**
 * 🔴 **アラートの段取り**(#280。user 指示 2026-08-19
 * 「…連絡先、タイマー、**アラート**は組み込みアプリでリリースしたい」)。
 *
 * 本文の行に書いた時刻(`- [ ] 打ち合わせ @2026-08-27 14:00`)が来たら、
 * **音を鳴らして、画面の下に帯を出す**。押すとその行へ飛ぶ。
 *
 * ## 🔴 「開いている間だけ鳴る」── これは手抜きではない
 *
 * #280 の本文がそう書いているとおり、**タブが 1 枚も無い状態での定刻起動は
 * Web では保証されない**(`Notification` の許可を取っても、Service Worker を
 * 置いても)。🔑 だから**できると読ませない**:設定にもマニュアルにも
 * 「開いている間だけ鳴ります」と書く ── ⚠ 曖昧にすると、user は
 * **鳴る前提で予定を任せて失う**。
 *
 * ## ⚠ 通知の許可は求めない
 *
 * `Notification` が覆えるのは「**タブが背面に在るが開いている**」場合だけで、
 * それは**音 + 帯 + タブの題名**でも覆える。🔑 覆えないのは「閉じている間」で、
 * それは**どちらの作りでも鳴らない** ── ならば許可を求めないほうが正直である。
 *
 * ## ⚠ 見に行くのは「区間」であって「いまの分」ではない
 *
 * 背面のタブでは刻みが間引かれる。「いまと同じ分か」で採ると、
 * **間引かれた回はまるごと鳴らない** ── だから `(前回見た時刻, いま]` で採る
 * (`features/alarm/alarm-due.ts`)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { dueAlarms, type AlarmDue } from '@features/alarm/alarm-due';
import type { Chime } from '@adapter/platform/chime';

export interface AlarmServiceDeps {
  readonly dispatcher: Dispatcher;
  /** 帯を描き直す合図。⚠ 空 = 鳴っているものが無い(帯を畳む)。 */
  readonly onChange: (due: readonly AlarmDue[]) => void;
  /** 鳴らす口。⚠ test はここを差し替える。 */
  readonly chime: Chime;
  /** いまの時刻。⚠ `features/` と同じ約束で**外から渡す**。 */
  readonly now?: () => number;
  /** 刻みを張る口。返り値は**外す関数**。⚠ test は手で撃つ。 */
  readonly tick?: (fn: () => void) => () => void;
  /** 知らせるか(設定)。⚠ **読むたびに引く** ── 途中で切られたら止まる。 */
  readonly enabled: () => boolean;
}

export interface AlarmService {
  /** 見張りを始める(設定が入のときだけ実際に刻む)。 */
  start(): void;
  /** 見張りを畳む。⚠ **必ず呼べる形にする**(張りっぱなしを作らない)。 */
  stop(): void;
  /** 1 件を片付ける(押した / 閉じた)。 */
  dismiss(key: string): void;
  /** 全部片付ける。 */
  dismissAll(): void;
  /** 鳴っているもの(帯が読む)。 */
  ringing(): readonly AlarmDue[];
}

/**
 * 既定の刻み。⚠ **30 秒**にするのは、1 分の刻みだと**分の境目をまたぐ回が
 * 前後にぶれる**ため(区間で採っているので取りこぼしはしないが、
 * 最悪 1 分近く遅れて鳴る)。
 */
export const ALARM_TICK_MS = 30_000;

function intervalTick(fn: () => void): () => void {
  const id = setInterval(fn, ALARM_TICK_MS);
  return () => clearInterval(id);
}

export function createAlarmService(deps: AlarmServiceDeps): AlarmService {
  const now = deps.now ?? ((): number => Date.now());
  const tick = deps.tick ?? intervalTick;

  /** 鳴って、まだ片付けられていないもの。 */
  const ringing = new Map<string, AlarmDue>();
  /**
   * 🔴 **もう鳴らした回**。⚠ 片付けても消さない ── 消すと、
   *   次の刻みで**同じ回がまた鳴る**(区間の左端は前回の右端なので普通は来ないが、
   *   時計が戻った端末では来る)。
   */
  const rang = new Set<string>();
  let untick: (() => void) | null = null;
  /** 前回どこまで見たか。⚠ `null` = まだ 1 度も見ていない。 */
  let seenTo: number | null = null;

  const paint = (): void => deps.onChange([...ringing.values()]);

  const sweep = (): void => {
    if (!deps.enabled()) return;
    const t = now();
    /**
     * 🔴 **初回は「いま」までを見たことにする**(鳴らさない)。
     *
     * ⚠ こうしないと、**起動した瞬間に今日の過ぎた予定が全部鳴る** ──
     *   朝の予定を 5 件書いてある人が、夕方にアプリを開くと 5 件鳴ることになる。
     * 🔑 知らせは「**その時刻になった**」ことであって「過ぎている」ことではない。
     */
    if (seenTo === null) {
      seenTo = t;
      return;
    }
    /**
     * ⚠ 時計が戻った(手動調整 / 休止からの復帰)── 見た位置を寄せ直すだけ。
     *
     * 🔑 **これは早期の脱出であって、門ではない**(変異試験 A10 で確かめた)──
     *   外しても逆向きの区間(`from > to`)は 0 件を返すので、**振る舞いは同じ**。
     * ⚠ だから **test を足して「殺した」ことにしない**(#445 と同じ作法)。
     *   残しているのは、戻った回に**走査そのものをしない**ぶん安いのと、
     *   「時計は戻ることがある」と次に読む人へ伝わるからである。
     * 🔑 **2 度鳴らさない**ほうを守っているのは `rang`(下)であって、ここではない。
     */
    if (t <= seenTo) {
      seenTo = t;
      return;
    }
    const scan = deps.dispatcher.getState().taskScan;
    const from = seenTo;
    seenTo = t;
    if (scan === null) return;
    const due = dueAlarms(scan.cards, from, t).filter((d) => !rang.has(d.key));
    if (due.length === 0) return;
    for (const d of due) {
      rang.add(d.key);
      ringing.set(d.key, d);
    }
    paint();
    // ⚠ **音は 1 回**(3 件来ても 3 回鳴らさない ── 連打は知らせにならない)
    void deps.chime.play();
  };

  return {
    ringing: () => [...ringing.values()],

    start() {
      if (untick !== null) return;
      untick = tick(sweep);
      // ⚠ **張った直後に 1 度見る** ── 見ないと、最初の刻みまで
      //    `seenTo` が決まらず、その間に来た予定を取りこぼす
      sweep();
    },

    stop() {
      untick?.();
      untick = null;
    },

    dismiss(key) {
      if (!ringing.delete(key)) return;
      paint();
    },

    dismissAll() {
      if (ringing.size === 0) return;
      ringing.clear();
      paint();
    },
  };
}
