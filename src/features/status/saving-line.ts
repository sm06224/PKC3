/**
 * 🔴 **「保存中…」を、いつ出すか**(#828 ①。user 推薦の実装)。
 *
 * ## なぜ要るか(user の物語)
 *
 * 題名を直して「保存」を押した**直後**に読み込み直す(または タブを閉じる)と、
 * **題名だけが元に戻る**ことがある ── 画面は先に書き換わり、disk は後だからである
 * (混んでいるとき 8 回中 4 回で再現した)。⚠ **本文とノートは残る**ので、
 * user は「直したはずの題名が、次に見ると元のまま」という形でしか気づけない。
 *
 * 🔑 だから **書いている間だけ、画面の下に「保存中…」と出す** ── 消えたら
 * 書き終わりである。⚠ 押した後の操作は今までどおりできる(止めない)。
 *
 * ## ⚠ すぐには出さない
 *
 * 書込は**打鍵の確定ごと**に飛ぶので、素直に出すと**帯が点滅する**
 * (ふつうの保存は数ミリ秒で終わる)。⚠ それは「知らせ」ではなく雑音である。
 * 🔑 だから **`SAVING_DELAY_MS` だけ続いたときにだけ**出す ──
 * 出るのは「読み直すと題名が戻る」ほど**実際に遅れている回**だけになる。
 *
 * ⚠ 判断をここへ置くのは、`main.ts` が**どの test からも実行されない**からである
 * (CLAUDE.md §2)── あちらは**渡すだけ**にする。
 */

/**
 * 出すまでの待ち。⚠ **実測で決める値ではなく、雑音の閾値**である ──
 * ふつうの保存(数ミリ秒)を隠し、遅れている回だけ見せる長さ。
 * ⚠ これより短くすると帯が点滅し、長くすると「押しても何も出ない」に戻る。
 */
export const SAVING_DELAY_MS = 400;

/** 画面に出す字。⚠ **1 か所**(帯とマニュアルで綴りを分けない)。 */
export const SAVING_LINE = '⏳ 保存中…';

/** 時計と予約の口(test から差せるようにする)。 */
export interface SavingTimers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (id: unknown) => void;
}

/**
 * 書込の出入りを受けて、帯に出す字を決める。
 *
 * 🔑 **状態は 1 つ**(いま出しているか)── 呼び側は `line()` を読むだけでよい。
 * ⚠ **予約は必ず 1 本**にする(二重に張ると、止めても消えない帯が残る)。
 */
export class SavingIndicator {
  private timer: unknown = null;
  private shown = false;

  constructor(
    private readonly onChange: () => void,
    private readonly timers: SavingTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
    private readonly delayMs: number = SAVING_DELAY_MS,
  ) {}

  /** 帯に載せる字(出していなければ空)。 */
  line(): string {
    return this.shown ? SAVING_LINE : '';
  }

  /**
   * 書込が始まった / 終わった。
   *
   * ⚠ **終わったら即座に消す**(待たない)── 「消えたら書き終わり」が
   *   この帯の約束なので、遅れて消すとその約束が嘘になる。
   */
  setWriting(writing: boolean): void {
    this.cancel();
    if (!writing) {
      if (!this.shown) return;
      this.shown = false;
      this.onChange();
      return;
    }
    // ⚠ 既に出しているなら張り直さない(飛んでいる書込が続いているだけ)
    if (this.shown) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.shown = true;
      this.onChange();
    }, this.delayMs);
  }

  /** 予約を捨てる。⚠ **出している状態は触らない**(消すのは呼び側の判断)。 */
  private cancel(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
