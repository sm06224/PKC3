/**
 * asset を触る操作(添付取込 / PKC2 取込 / 未参照の整理)の**相互排他**。
 *
 * なぜ必要か(P4b review F1、実証済みのデータ消失): 取込は putBlob → entry 書込の
 * 間に「bytes はあるが参照が無い」窓を持つ。その窓で整理(未参照 GC)が走ると、
 * **取込中の bytes を未参照と判定して消す**。同時実行は可視で拒否する。
 *
 * main.ts の中に閉じ込めていたので test から触れず、mutation(gate 無効化)が
 * 269 件を素通りしていた(review M22)── ここに出して pin する。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

export interface AssetGate {
  /** run を排他実行する。実行中なら**走らせずに**可視で断る。 */
  (run: () => Promise<void>): Promise<void>;
  /** 実行中かどうか(観測用)。 */
  readonly busy: boolean;
}

export function createAssetGate(dispatcher: Dispatcher): AssetGate {
  let busy = false;
  const gate = async (run: () => Promise<void>): Promise<void> => {
    if (busy) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          '添付の取込 / 整理が実行中です。完了してから、もう一度選び直してください',
      });
      return;
    }
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
  };
  Object.defineProperty(gate, 'busy', { get: () => busy });
  return gate as AssetGate;
}
