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
  /** run を排他実行する。実行中なら**走らせずに**可視で断る(user 操作用)。 */
  (run: () => Promise<void>): Promise<void>;
  /**
   * run を排他実行する。実行中なら**断らずに順番待ちする**。
   *
   * 🔴 **選び直せない経路のために在る**(P7 段③ review H2)。OS からの
   * `launchQueue` は一発限りで、断っても user には picker が出ない ──
   * 「完了してから、もう一度選び直してください」と言われた時点でファイルは失われる。
   * ⚠ user のクリック起点の操作には**使わない**(断る側が正しい ── 待たされるより
   * 「いま整理中です」と言われた方が分かる)。
   */
  queued(run: () => Promise<void>): Promise<void>;
  /** 実行中かどうか(観測用)。 */
  readonly busy: boolean;
}

export function createAssetGate(dispatcher: Dispatcher): AssetGate {
  let busy = false;
  /**
   * 鎖に並んでいて**まだ終わっていない**数。⚠ `busy` だけを見てはいけない ──
   * `busy` が立つのは鎖の中(microtask のあと)なので、**同じ tick で 2 回**
   * 呼ばれると 2 本とも「空いている」と見えて、断るはずの側が並んでしまう
   * (P7 段③ で実際に踏んだ:断る test が timeout した)
   */
  let outstanding = 0;
  /** 直列化の尾。⚠ 断る側も待つ側も**同じ鎖**に並ぶ(2 本あると排他が崩れる)。 */
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (run: () => Promise<void>): Promise<void> => {
    outstanding++;
    const next = tail.then(async () => {
      busy = true;
      try {
        await run();
      } finally {
        busy = false;
        outstanding--;
      }
    });
    // ⚠ 失敗を鎖に残さない(1 件の失敗で以降が全部落ちる)
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const gate = async (run: () => Promise<void>): Promise<void> => {
    if (outstanding > 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          '添付の取込 / 整理が実行中です。完了してから、もう一度選び直してください',
      });
      return;
    }
    await enqueue(run);
  };
  Object.defineProperty(gate, 'busy', { get: () => busy });
  Object.defineProperty(gate, 'queued', { value: enqueue });
  return gate as AssetGate;
}
