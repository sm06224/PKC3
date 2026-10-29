/**
 * 🔴 **長い仕事を途中でやめる印**(台帳 #1852 束 F2 / 依頼 253 ── 大きいバックアップの取り込み・書き出し)。
 *
 * 仕事(取り込み・書き出し)は区切りごとに `throwIfCancelled()` を呼び、やめる印が立っていれば `OperationCancelled` を投げて抜ける。
 * 区切りの間(1 回の保存領域への書き込み、1 本の zip の読み出し)は割り込まない ── 半端な書き込みを作らないため。
 * ⚠ 純粋な値(browser API を持たない)。ボタンと画面は `adapter/ui/actions/job-control.ts`。
 */

/** やめる印が立っていて、仕事が区切りで抜けたことを表す例外。⚠ 失敗ではない(呼び側は「やめました」と言う)。 */
export class OperationCancelled extends Error {
  constructor() {
    super('操作を途中でやめました');
    this.name = 'OperationCancelled';
  }
}

export function isOperationCancelled(e: unknown): boolean {
  return e instanceof OperationCancelled;
}

export interface CancelToken {
  /** やめる印が立っているか。 */
  readonly cancelled: boolean;
  /** 印を立てる(2 度押しても同じ)。 */
  cancel(): void;
  /** 区切りで呼ぶ。立っていれば `OperationCancelled` を投げる。 */
  throwIfCancelled(): void;
  /**
   * 印が立ったときに 1 度だけ呼ぶ(すでに立っていれば、その場で呼ぶ)。⚠ 区切りで見られない長い待ち
   * (取得・別のスレッドの計算)を、外からやめさせるため ── 取得の中断や、ワーカーへの「やめる」の合図を繋ぐ。
   */
  onCancel(fn: () => void): void;
}

export function createCancelToken(): CancelToken {
  let cancelled = false;
  const listeners: Array<() => void> = [];
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const fn of listeners.splice(0)) fn();
    },
    onCancel(fn) {
      if (cancelled) fn();
      else listeners.push(fn);
    },
    throwIfCancelled() {
      if (cancelled) throw new OperationCancelled();
    },
  };
}
