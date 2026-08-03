/**
 * 「アプリが受け取れる状態になるまで待つ」(P7 段③ review H2)。
 *
 * 🔴 **断れない経路のために在る**。OS からの `launchQueue` は一発限りで、
 * 断っても user には picker が出ない ── 編集中に md をダブルクリックすると
 * 「編集を終了してから取り込んでください」と言われて**ファイルが失われる**。
 * user のクリック起点の操作は今までどおり断る(そちらは選び直せる)。
 */
import type { Dispatcher } from './dispatcher';

/**
 * `phase === 'ready'` になるまで待つ。すでに ready なら即座に解決。
 *
 * @param onWait 待ちに入るときに 1 度だけ呼ぶ(user に「保留した」と伝えるため)。
 *   ⚠ 無言で待つと「md を開いたのに何も起きない」に見える
 */
export function whenPhaseReady(dispatcher: Dispatcher, onWait?: () => void): Promise<void> {
  if (dispatcher.getState().phase === 'ready') return Promise.resolve();
  onWait?.();
  return new Promise((resolve) => {
    // ⚠ 購読は必ず解く(`onState` は unsubscribe を返す ── 短命購読の規約)
    const off = dispatcher.onState((state) => {
      if (state.phase !== 'ready') return;
      off();
      resolve();
    });
  });
}
