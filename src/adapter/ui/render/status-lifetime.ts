/**
 * 🔴 **画面下の知らせの寿命と、進行中の置き場**(#1017 C5。裁定 2026-10-02 22:29Z の Q1 / Q2 / Q3)。
 *
 * ## 何が画面で変わるか
 *
 * 直す前は、画面下の 1 行の知らせ(「コピーしました」等)が**次の知らせが来るまで居座った**。
 * 同じ字はメッセージの一覧へ既に積まれている(`status-notice.ts`)ので、居座らせる理由が無い。
 * いまは種類で寿命を分ける:
 *
 * | 知らせ | 画面下での寿命 | 理由 |
 * |---|---|---|
 * | **結果**(コピーしました / 取り込みました …) | **数秒で消える** | 読み返したければメッセージにある |
 * | **注意・問題**(`caution` / `problem`) | 次の知らせまで残る | 失敗は user が**読むべき字**で、読む前に消えると何も知らないまま進む |
 * | **操作のボタンを持つ知らせ**(そのノートを開く / 移動・追記を元に戻す / ○○のノートを作る) | 次の知らせまで残る | 消すとボタンごと消え、**押す前に機会が無くなる** |
 *
 * 🔴 **全体の処理の進行中**(書き出し・取り込み・切り出し・文字起こし …)は、結果の知らせとは
 * **別の欄**(`progressLine`)に出し、終わりの合図(`notify('')`)**か、結果 / 注意 / 問題の知らせ**で空にする
 * (処理の終わりは結果で告げられる。出す側が空を撃ち忘れても居座らない)。
 * 直す前は結果と同じ欄に出ていたので、①次の知らせに上書きされ ②失敗すると居座った。
 * ⚠ 逆に、進行中が始まっても**知らせは消えない**(別の欄)。
 *
 * ## ⚠ なぜ main.ts に書かないか
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)。出す / 消すの判断は
 * ここへ置き、`main.ts` は配線(描く関数と時計)を渡すだけにする。
 *
 * ## 🔑 設計の要点(覆る条件つき)
 * - **消す時計は 1 本だけ**持つ。新しい知らせが来たら前の時計は捨てる ── 古い時計が
 *   新しい字を消さない(`arrive` が必ず `cancel` を通る)。
 * - **時計は「画面が見えているか」「マウスが乗っているか」に依存しない**。
 *   ⚠ 依存させると、別タブで起きた結果の知らせが**戻ってきた時にまとめて居座る** / hover の
 *   有無で寿命が変わる(test からも時間を進めるだけで見られなくなる)。
 *   覆る条件:「読み終える前に消えた」という報告が実機で出たら、長さを調整する(形は変えない)。
 * - **押す口が引っ込んだ知らせは、そこから数え始める**(`settle`)── 「開く」の知らせは、
 *   そのノートを開いた瞬間に押す口が畳まれる。畳まれた後も居座らせる理由が無い。
 */
import { isCorruptRefusalLine } from '@features/storage/db-corruption';
import { isProgressNotice, type StatusKind, type StatusOptions } from './status-notice';

/**
 * 結果の知らせを画面下に出しておく時間(ミリ秒)。
 *
 * 🔑 **6 秒**:「コピーしました」「3 件取り込みました(うち 1 件に注意)」のような 1〜2 行を
 * **読み終える前に消えない**長さで、次の操作の結果と**混ざらない**(10 秒を超えると、
 * 連続して操作した user の目に前の結果が残る)。実測した値ではなく、読む量から決めた既定である。
 */
export const STATUS_RESULT_VISIBLE_MS = 6000;

/** 進行中の字を、結果として扱うか・進行中として扱うか・進行中の終わりとして扱うか。 */
export type StatusRoute = 'progress' | 'progress-end' | 'notice';

/**
 * 🔴 **`showStatus` に来た字の行き先を決める**。
 *
 * - `…` で終わる字(`isProgressNotice`)= **進行中**(`progressLine` へ)
 * - 空の字 = **進行中の終わり**(`notify('')`。この repo の約束 ── 進行中を消す合図にしか使わない)
 * - それ以外 = 結果 / 注意 / 問題の知らせ
 *
 * ⚠ 判定は `status-notice.ts` の `isProgressNotice` **1 本**(積む / 積まないと同じ関数)。
 */
export function routeStatusText(text: string): StatusRoute {
  if (text === '') return 'progress-end';
  return isProgressNotice(text) ? 'progress' : 'notice';
}

export interface StatusNoticesDeps {
  /** メッセージ一覧へ積む(`createStatusPoster`)。 */
  readonly post: (text: string, opts?: StatusOptions) => void;
  /** 画面下の 1 行を描き直す。 */
  readonly paint: () => void;
  /**
   * 知らせの隣の押す口(開く / 元に戻す / ノートを作る)を描き直し、**いま 1 つでも出ているか**を返す。
   * ⚠ 出す条件は `status-open.ts` の描く関数が持つ ── ここで字を見て判定しない。
   */
  readonly paintActions: () => boolean;
  /** 消えた知らせが state にも載っているなら降ろす(同じ字がもう一度来ても出せるように)。 */
  readonly expire: (text: string) => void;
  /** 既定は `setTimeout`。test が差し替える。 */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly visibleMs?: number;
}

export interface StatusNotices {
  /** 画面下へ出す(進行中 / 進行中の終わり / 知らせの 3 通りを内側で振り分ける)。 */
  show(text: string, opts?: StatusOptions): void;
  /** 状態が動いた後に呼ぶ ── 押す口が引っ込んだ知らせは、そこから数え始める。 */
  settle(): void;
  /** いま画面下に出している知らせの字(空 = 無し)。 */
  noticeLine(): string;
  /** いま画面下に出している進行中の字(空 = 無し)。 */
  progressLine(): string;
}

export function createStatusNotices(deps: StatusNoticesDeps): StatusNotices {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ms = deps.visibleMs ?? STATUS_RESULT_VISIBLE_MS;

  let notice = '';
  let progress = '';
  /** いまの知らせの種類。`null` = 知らせが無い。 */
  let kind: StatusKind | null = null;
  /** 時計は**1 本だけ**。`null` = 動いていない。 */
  let timer: unknown = null;

  const cancel = (): void => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  /** 画面に出ている知らせが「操作のボタンを持つ」か。 */
  const sticky = (actionShown: boolean): boolean => actionShown || isCorruptRefusalLine(notice);

  const arm = (): void => {
    const text = notice;
    // ⚠ 古い時計が新しい字を消さない ── 守っているのは `show` が新しい知らせの前に必ず通す `cancel` だけ
    //   (字の一致で二重に守らない ── 同じ字がもう一度来た回に、古い時計が新しい寿命を縮める)
    timer = setTimer(() => {
      timer = null;
      notice = '';
      kind = null;
      deps.expire(text);
      deps.paint();
      deps.paintActions();
    }, ms);
  };

  /** 消す側に回すか(結果で、押す口が無い)を見て、時計を動かす / 止める。 */
  const apply = (actionShown: boolean): void => {
    const expiring = kind === 'result' && notice !== '' && !sticky(actionShown);
    if (expiring && timer === null) arm();
    else if (!expiring) cancel();
  };

  return {
    show(text, opts) {
      const route = routeStatusText(text);
      if (route === 'progress') {
        // 🔴 進行中の欄に出すだけで、**知らせは触らない**(別の欄なので消す理由が無い)。
        //   ⚠ 直す前は `notice = ''` で消していたので、残るはずの知らせ・「元に戻す」等のボタン・
        //   注意・問題が、**別の処理の進行中が始まっただけで黙って消えた**。⚠ 時計も止めない
        //   (結果の知らせは自分の寿命で消える)。⚠ 積まない(結果ではない)
        progress = text;
        deps.paint();
        deps.paintActions();
        return;
      }
      if (route === 'progress-end') {
        // ⚠ 知らせは**触らない**(直す前は同じ欄を空にしていた ── 別の欄になったので結果を巻き込まない)
        progress = '';
        deps.paint();
        deps.paintActions();
        return;
      }
      deps.post(text, opts);
      // 🔴 **結果 / 注意 / 問題の知らせは、進行中の終わりでもある** ── 1 つの処理の終わりは結果で告げられる
      //   (旧仕様では結果が進行中を置き換えていた。別の欄に分けたとき、この「置き換え」を落としていた)。
      //   出す側が成功の枝で `notify('')` を撃ち忘れても、「…しています…」が結果の隣に居座らない。
      progress = '';
      // 🔑 新しい知らせが来たら、前の時計は必ず捨てる
      cancel();
      notice = text;
      kind = opts?.kind ?? 'result';
      deps.paint();
      apply(deps.paintActions());
    },
    settle() {
      // 押す口の出入りは `paintActions` が描く ── ここは時計だけ
      apply(deps.paintActions());
    },
    noticeLine: () => notice,
    progressLine: () => progress,
  };
}
