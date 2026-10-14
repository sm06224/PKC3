/**
 * 🔴 **ノートの末尾へ書き足し、disk に着いたかまで待つ**(#275 段① → #1407 段④ で取り出した)。
 *
 * 🔑 **書くのは既存の追記(`APPEND_TO_ENTRY`)** ── 新しい書込経路を作らない。錠(`writeLock`)・
 *   編集中の門・別の窓との衝突の足し直しは、全部あちらが持つ(ここで数え直さない。§7)。
 * 🔴 **「書けた」は disk に着いてから言う** ── 錠が動いた時点ではまだ着いていない
 *   (実書込は `REQUEST_APPEND` の非同期)。**`APPEND_SETTLED`(`ENTRY_APPENDED` / `APPEND_FAILED` の結末)を待つ**。
 * ⚠ 結末が来ない回(強制解放・本体の入れ替わり)は**時間切れ**で返す(呼び手を待たせ続けない)。
 *
 * 呼び手は 2 つ:PDF の窓の「ノートへ引く」(`quote-into-note.ts`)/ ブラウザの AI の書き足し(`webmcp-tools.ts`)。
 * ⚠ 字(断り文)は呼び手が持つ ── ここは結末の**種類**と reducer の理由だけを返す。
 */
import type { Dispatcher } from './dispatcher';
import type { DomainEvent } from './app-state';

export interface AppendTimers {
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
}

export const REAL_APPEND_TIMERS: AppendTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as number),
};

/**
 * 書き足しの結末。
 * - `refused`: reducer が受けなかった(編集中・書込中など。錠が動かなかった)── `error` は reducer の理由
 * - `failed`: 受けたが disk に書けなかった ── `error` は ack の理由
 * - `timeout`: 結末が来なかった(⚠ 着いたかもしれない ──「書けなかった」とは言い切らない)
 */
export type AppendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'refused' | 'failed' | 'timeout'; readonly error: string | null };

/**
 * 🔴 **追記を投げて、reducer が受けたかを返す**(#1087 の見直し)── 錠(`writeLock`)が動いたら受けた。
 * ⚠ 断る経路は 2 つ:理由を `error` に立てる回(編集中・書込中)と、**理由を立てずに捨てる回**
 *   (書き先のノートが消えていた)。後者は呼び手が言わないと**黙って「足しました」になる**。
 * 🔑 戻り値 `'gone'` = ノートが見つからなかった(呼び手が字を出す)/ `'refused'` = reducer が理由を出した。
 */
export function dispatchAppend(
  dispatcher: Dispatcher,
  action: Extract<Parameters<Dispatcher['dispatch']>[0], { type: 'APPEND_TO_ENTRY' }>,
): 'accepted' | 'refused' | 'gone' {
  const lockBefore = dispatcher.getState().writeLock;
  dispatcher.dispatch(action);
  const after = dispatcher.getState();
  if (after.writeLock !== lockBefore) return 'accepted';
  return after.entryMetas.has(action.lid) ? 'refused' : 'gone';
}

export function appendAndSettle(
  dispatcher: Dispatcher,
  lid: string,
  text: string,
  /** 節の見出し(ログは日時 = `appendHeadingFor`)。`null` = 付けない(PDF の引用は末尾に足すだけ)。 */
  heading: string | null,
  timeoutMs: number,
  timers: AppendTimers = REAL_APPEND_TIMERS,
): Promise<AppendOutcome> {
  const st = dispatcher.getState();
  // 🔑 通ったかは reducer が錠を掛けたかで見る(断った回は錠が動かない。予定の面の追記と同じ)
  const lockBefore = st.writeLock;
  const gen = st.lockGen;
  // ⚠ 断られた理由は「この dispatch で立った」字だけを返す ── 前から残っている字を理由として返さない
  //   (ノートが消えていた回など、reducer が理由を付けずに断る経路がある)
  return new Promise<AppendOutcome>((resolve) => {
    let handle: unknown = null;
    let done = false;
    // ⚠ dispatch の**前**に張る(同期に結末が出る経路があっても取りこぼさない)
    const off = dispatcher.onEvent((ev: DomainEvent) => {
      if (ev.type !== 'APPEND_SETTLED' || ev.lid !== lid || ev.gen !== gen) return;
      settle(ev.ok ? { ok: true } : { ok: false, reason: 'failed', error: ev.error });
    });
    const settle = (r: AppendOutcome): void => {
      if (done) return;
      done = true;
      off();
      if (handle !== null) timers.clearTimer(handle);
      resolve(r);
    };
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid,
      text,
      heading,
      // ⚠ 末尾へ足す(追記先の選択は本文の画面の話 ── ここでは選ばせない)
      target: null,
    });
    if (done) return;
    const after = dispatcher.getState();
    if (after.writeLock === lockBefore) {
      /**
       * ⚠ 理由は「字が変わったか」ではなく「**この dispatch で state が作り直されたか**」で見る ──
       *   同じ理由で 2 度断られると字は前と同じなので、字の比較では 2 度目が理由なしになっていた。
       *   理由を立てずに捨てる回(ノートが消えていた)は state をそのまま返す。
       */
      settle({ ok: false, reason: 'refused', error: after === st || after.error === null ? null : after.error });
      return;
    }
    handle = timers.setTimer(() => settle({ ok: false, reason: 'timeout', error: null }), timeoutMs);
  });
}
