/**
 * 🔴 **長い仕事の「やめる」ボタンの出し入れ**(台帳 #1852 束 F2 / 依頼 253 ── 大きいバックアップの取り込み・書き出しを途中でやめる)。
 *
 * 取り込み・書き出しは `start()` で印(`CancelToken`)を受け取り、区切りごとに印を見る。ボタンは**少し待っても終わらない仕事にだけ**
 * 出す(`delayMs`。一瞬で終わる仕事に出して点滅させない)。押すと印が立ち、仕事が区切りで抜ける。
 * 判断(いつ出すか・どの仕事の印か)はここ、見た目は `ui` が持つ(`main.ts` は配線だけ ── どの test からも実行されない層に判断を置かない)。
 *
 * ⚠ 仕事は同時に 1 つ(取り込みも書き出しも入口が直列)。後から始まった仕事があれば、先の仕事の `finish` は何もしない。
 */
import { createCancelToken, type CancelToken } from '@features/job-cancel';

export type JobKind = 'import' | 'export';

/** 画面に出す字。 */
export const JOB_PANEL: Readonly<Record<JobKind, { title: string; cancel: string; hint: string }>> = {
  import: {
    title: '取り込み中',
    cancel: '取り込みをやめる',
    hint: '取り込みを途中でやめます。ここまでに入れたノートはゴミ箱へ移します(ゴミ箱から戻せます)',
  },
  export: {
    title: '書き出し中',
    cancel: '書き出しをやめる',
    hint: '書き出しを途中でやめます。ファイルは作りません',
  },
};

/** やめる印を立てた後の題(ボタンは消える)。 */
export const JOB_CANCELLING_TITLE = 'やめています…';

export interface JobPanelUi {
  /** 「やめる」ボタンつきの欄を出す。`cancel` が `null` ならボタンなし(やめている最中)。 */
  show(panel: { title: string; cancel: string | null; hint: string }): void;
  /**
   * 欄を片づける。⚠ 欄が**まだこの欄のとき**だけ消す ── 仕事の結果(注意の欄)がもう出ていたら、それを消さない。
   */
  hide(): void;
}

export interface JobControl {
  /** 仕事を始める。受け取った印を、区切りごとに見る。 */
  start(kind: JobKind): CancelToken;
  /** 仕事の出口で必ず呼ぶ(成功・失敗・やめた、どれでも)。 */
  finish(token: CancelToken): void;
  /** 「やめる」ボタンが押された。いまの仕事の印を立てる(仕事が無ければ何もしない)。 */
  cancelCurrent(): boolean;
}

export function createJobControl(
  ui: JobPanelUi,
  opts: {
    /** ボタンを出すまでの待ち。 */
    delayMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
  } = {},
): JobControl {
  const delayMs = opts.delayMs ?? 800;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let current: { token: CancelToken; kind: JobKind; timer: unknown; shown: boolean } | null = null;
  return {
    start(kind) {
      if (current !== null) clearTimer(current.timer);
      const token = createCancelToken();
      const job = { token, kind, timer: null as unknown, shown: false };
      job.timer = setTimer(() => {
        if (current !== job || token.cancelled) return;
        job.shown = true;
        ui.show({ title: JOB_PANEL[kind].title, cancel: JOB_PANEL[kind].cancel, hint: JOB_PANEL[kind].hint });
      }, delayMs);
      current = job;
      return token;
    },
    finish(token) {
      const job = current;
      if (job === null || job.token !== token) return;
      clearTimer(job.timer);
      current = null;
      if (job.shown) ui.hide();
    },
    cancelCurrent() {
      const job = current;
      if (job === null || job.token.cancelled) return false;
      job.token.cancel();
      // ボタンが出ていたら、押した直後に「やめています…」へ替える(待たされている間、押せるままにしない)
      if (job.shown) ui.show({ title: JOB_CANCELLING_TITLE, cancel: null, hint: JOB_PANEL[job.kind].hint });
      return true;
    },
  };
}
