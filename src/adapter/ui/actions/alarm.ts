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
import { dueAlarms, silencedLidsOf, type AlarmDue } from '@features/alarm/alarm-due';
import type { Chime } from '@adapter/platform/chime';
import { missedItems, missedLabel } from '@features/schedule/schedule-notify';
import { noteTimeCards, type TaskCard } from '@features/schedule/task-cards';

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
  /**
   * 🔴 **このタブが鳴らす役か**(#1087)。⚠ 開いているタブの数だけ同じ予定が鳴るのを防ぐ ──
   *   鳴らすのは**書き込みの本体(holder)のタブだけ**(`main.ts` が `writerHolder` を渡す)。
   *   本体が移ったら、**読むたびに**新しい本体が真になって引き継ぐ。省略 = 常に鳴らす(test)。
   */
  readonly isRinger?: () => boolean;
  /** メッセージの集積地へ積む口(中身は件数と固定の字だけ ── 予定の字は書かない)。省略可。 */
  readonly post?: (text: string) => void;
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
  /**
   * 🔴 **いま 1 度見る**(#1087)。⚠ 設定を入にした直後に呼ぶ ── 呼ばないと、入にした時刻が
   *   次の刻み(最大 30 秒)まで決まらず、その間に来た予定を取りこぼす。
   */
  check(): void;
}

/**
 * 🔴 **この間隔を超えて空いたら、鳴らさない**(#1087)。
 * 根拠:背面のタブの刻みは 1 分に 1 回まで間引かれる(Chrome の仕様)ので、ふだんの空きは最大 1 分強。
 *   その倍の 2 分を超えたのは、端末が眠っていた・タブが凍っていたとき ── 復帰した瞬間に
 *   眠っていた間の予定がまとめて鳴るのを防ぐ(代わりに「見逃した予定」として 1 件積む)。
 */
export const ALARM_MAX_GAP_MS = 120_000;

/** 集計に失敗している間の知らせ。⚠ 鳴らない事実を黙らない。 */
export const ALARM_SCAN_FAILED_TEXT = '予定を数えられなかったので、時間になってもお知らせできません';

/** 走査の上限(`TASK_LIMITS.notes`)で後ろのノートを数えていない間の知らせ。⚠ 鳴らない事実を黙らない。 */
export const ALARM_SCAN_TRUNCATED_TEXT =
  'チェック項目のあるノートが多いため、後ろのノートの時刻つきの予定は鳴らないことがあります';

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
  /** 集計の失敗を言ったか(立っている間に 1 回だけ言う)。 */
  let failedTold = false;
  /** 走査が上限で切れたことを言ったか(切れている間に 1 回だけ言う)。 */
  let truncatedTold = false;

  const paint = (): void => deps.onChange([...ringing.values()]);

  const sweep = (): void => {
    /**
     * 🔴 **切っている間は「見ていない」に戻す**(#1087 の見直し 2026-10-13)。
     * ⚠ 直す前は `seenTo` を残したまま返していたので、数時間切ってから入れ直すと、
     *   最初の確認が `(切る前の時刻, いま]` を見て、**切っていた間に過ぎた予定がまとめて鳴った**。
     * 🔑 入れ直した時は起動と同じ扱い(下の「初回は『いま』までを見たことにする」)にする。
     */
    if (!deps.enabled()) {
      seenTo = null;
      return;
    }
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
     * 🔴 **鳴らす役でないタブは鳴らさない**(#1087)── ただし**見た位置は進めておく**。
     * ⚠ 1 刻み(30 秒)ぶん手前に寄せておくのは、本体が閉じて**このタブが引き継いだ回に、
     *   本体が最後に見てから閉じるまでの予定を取りこぼさない**ため(どのタブも鳴らさない窓を作らない)。
     *   代わりに引き継いだ直前の 1 刻み以内の予定は、本体も鳴らしていれば 2 度鳴りうる。
     */
    if (deps.isRinger !== undefined && !deps.isRinger()) {
      seenTo = Math.max(seenTo, t - ALARM_TICK_MS);
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
    const st = deps.dispatcher.getState();
    const scan = st.taskScan;
    const from = seenTo;
    /**
     * 🔴 **数えられていないことを黙らない**(#1087)── 失敗が立っている間は時間になっても鳴らない。
     *   user は「鳴る前提で予定を任せて失う」ので、立っている間に 1 回だけ集積地へ言う。
     */
    if (st.taskScanFailed) {
      if (!failedTold) {
        failedTold = true;
        deps.post?.(ALARM_SCAN_FAILED_TEXT);
      }
    } else {
      failedTold = false;
    }
    /**
     * 🔴 **上限で切れて、後ろのノートを数えていないことも黙らない** ── 切れた先の予定は鳴らない。
     *   切れている間に 1 回だけ言う(直ったら、また切れたときに言い直す)。数え直し中(scan が null)は判断しない。
     */
    if (scan !== null) {
      if (scan.truncated) {
        if (!truncatedTold) {
          truncatedTold = true;
          deps.post?.(ALARM_SCAN_TRUNCATED_TEXT);
        }
      } else {
        truncatedTold = false;
      }
    }
    /**
     * 🔴 **数え直し中(scan が null)の回は、見た位置を進めない** ── 進めると、その区間の予定が
     *   二度と走査されず、鳴らないまま消える(別タブの保存で数え直しが入る窓)。
     */
    if (scan === null) return;
    seenTo = t;
    // 🔴 行の予定に、前書きに時刻を書いたノート 1 件の予定(依頼 192 / 284)を足して数える
    const cardsOf = (): readonly TaskCard[] => {
      const notes = noteTimeCards(scan, st.entryMetas);
      return notes.length === 0 ? scan.cards : [...scan.cards, ...notes];
    };
    /**
     * 🔴 **長く空いたら鳴らさず、見逃した予定として 1 件積む**(#1087)── 眠っていた端末の復帰で、
     *   過ぎた予定がまとめて鳴るのを防ぐ。字と口は次に開いたときの見逃しの知らせと同じ。
     */
    if (t - from > ALARM_MAX_GAP_MS) {
      const n = missedItems(cardsOf(), from, t, silencedLidsOf(st.entryMetas, st.scheduleHiddenNotes)).length;
      if (n > 0) deps.post?.(missedLabel(n));
      return;
    }
    const due = dueAlarms(cardsOf(), from, t, silencedLidsOf(st.entryMetas, st.scheduleHiddenNotes)).filter((d) => !rang.has(d.key));
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

    check: sweep,

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
