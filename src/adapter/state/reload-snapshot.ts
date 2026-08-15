/**
 * 取込のあとに一覧を入れ替える(P8 段㉕ に `main.ts` から切り出し)。
 *
 * 🔴 切り出した理由は**測れるようにするため** ── `main.ts` の closure に居た
 * ときは誰も test できず、「案内は出すが実行しない」という嘘が残っていた
 * (この file の test がそれを落とす)。段㉔ の `window-close.ts` と同じ理由。
 */
import type { Dispatcher } from './dispatcher';
import { whenPhaseReady } from './wait-for-ready';
import type { EntryMeta, Relation } from '@core/model/entry-meta';

export interface Snapshot {
  metas: EntryMeta[];
  relations: Relation[];
}

/** 編集中に取込が終わったときに出す案内。⚠ **実行する内容と一致させる**。 */
export const DEFERRED_RELOAD_NOTICE = '取込は完了しました。編集を終了すると一覧に反映されます';

/**
 * 一覧を入れ替える。編集中なら**編集が終わるまで待ってから**入れ替える。
 *
 * 🔴 取込の門は開始時の 1 回だけなので、長い await の間に user は編集を
 * 始められる。`SYS_BOOTED` は `openBody` / `selectedLid` をリセットするので、
 * そのまま流すと**打ちかけの本文が無警告で消える**(review H-4、実証済み)。
 *
 * 🔴 直す前は案内を出すだけで**予約する仕組みが無かった** ── 編集を終えても
 * 一覧に 1 件も出ず、user は「取り込めなかった」と判断して同じファイルを
 * 取り込み直す。lid は振り直されるので、**二重取込が実データとして残る**。
 *
 * ⚠ 一覧は**そのとき**取り直す ── 待つ前に取った snapshot を使うと、
 * 待っている間に保存された編集が載っておらず、**古い一覧で上書き**してしまう。
 */
export function reloadSnapshot(
  dispatcher: Dispatcher,
  cid: string,
  loadSnapshot: () => Promise<Snapshot>,
  opts?: {
    /**
     * 編集中で先送りするときに出す案内。省略 = 取込の文言(従来)。
     * `null` = 黙って先送り(#177 のタブ間同期 ── 別タブの保存のたびに
     * 「取込は完了しました」と出すのは嘘になるし、編集の邪魔でしかない)。
     */
    deferNotice?: string | null;
  },
): Promise<void> {
  const boot = async (): Promise<void> => {
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid, ...(await loadSnapshot()) });
  };
  if (dispatcher.getState().phase === 'ready') return boot();
  const notice = opts?.deferNotice === undefined ? DEFERRED_RELOAD_NOTICE : opts.deferNotice;
  if (notice !== null) dispatcher.dispatch({ type: 'OP_FAILED', error: notice });
  void whenPhaseReady(dispatcher).then(boot);
  return Promise.resolve();
}
