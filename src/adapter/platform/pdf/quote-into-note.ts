/**
 * 窓で選んだ字を、ノートへ**引く**(#275 段①)── 本体側の判断。
 *
 * 🔑 **書くのは既存の追記(`APPEND_TO_ENTRY`)** ── 新しい書込経路を作らない。錠(`writeLock`)・
 *   編集中の門・別の窓との衝突の足し直しは、全部あちらが持つ(ここで数え直さない。§7)。
 * ⚠ 窓は text と頁番号を**放送で送るだけ**で、どのノートへ書くかは**ここで解く**
 *   (窓の言い分を信じて lid を受け取らない ── 窓は同一 origin の別 realm である)。
 *
 * 🔴 **「引きました」は、disk に着いてから言う**(#275 着地後レビュー)。⚠ 直す前は錠(`writeLock`)が
 *   動いた時点で `ok: true` を返していたが、実書込は `REQUEST_APPEND` の非同期で、
 *   ノートが無い / 別の窓と衝突 / 保存の例外(`APPEND_FAILED`)でも窓は成功のまま「引きました」と
 *   言っていた。いまは **`APPEND_SETTLED`(`ENTRY_APPENDED` / `APPEND_FAILED` の結末)を待つ**。
 *   ⚠ 結末が来ない回(強制解放・本体の入れ替わり)は**時間切れ**で断る(窓を待たせ続けない)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { DomainEvent } from '@adapter/state/app-state';
import { formatPdfQuote, resolveQuoteTarget } from '@features/pdf/pdf-quote';
import type { PdfQuoteResult, PdfSession } from './pdf-window';

/**
 * 結末を待つ上限(ms)。⚠ 窓の「返事を待つ」上限(`public/pdf/reader-wire.js` の `QUOTE_TIMEOUT_MS`、
 * 10 秒)より**短く**する ── 本体が先に理由つきで断れば、窓は自分の時間切れを言わなくて済む。
 */
export const QUOTE_SETTLE_TIMEOUT_MS = 8000;

/** 結末が来なかったときの断り。⚠ 「引けなかった」とは言い切らない(着いたかもしれない)。 */
export const QUOTE_SETTLE_TIMEOUT_MESSAGE =
  'ノートに入ったか確かめられませんでした。ノートを開いて確かめてください';

export interface QuoteTimers {
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
}

const REAL_TIMERS: QuoteTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as number),
};

export function quoteIntoNote(
  dispatcher: Dispatcher,
  session: PdfSession,
  text: string,
  page: number,
  /** 本体の状態の行へ出す口(**disk に着いたときだけ**呼ぶ)。 */
  note: (text: string) => void,
  timers: QuoteTimers = REAL_TIMERS,
): Promise<PdfQuoteResult> {
  const st = dispatcher.getState();
  if (session.lid === null) return Promise.resolve({ ok: false, message: '引く先のノートが分かりません' });
  const target = resolveQuoteTarget(session.lid, st.entryMetas, st.relations);
  const meta = st.entryMetas.get(target);
  if (meta === undefined) return Promise.resolve({ ok: false, message: '引く先のノートが見つかりません' });
  const block = formatPdfQuote(text, page, session.name);
  if (block === null) return Promise.resolve({ ok: false, message: '引く字が選ばれていません' });
  // 🔑 通ったかは reducer が錠を掛けたかで見る(断った回は錠が動かない。予定の面の追記と同じ)
  const lockBefore = st.writeLock;
  const gen = st.lockGen;
  return new Promise<PdfQuoteResult>((resolve) => {
    let handle: unknown = null;
    // ⚠ dispatch の**前**に張る(同期に結末が出る経路があっても取りこぼさない)
    const off = dispatcher.onEvent((ev: DomainEvent) => {
      if (ev.type !== 'APPEND_SETTLED' || ev.lid !== target || ev.gen !== gen) return;
      settle(
        ev.ok
          ? { ok: true, message: `「${meta.title}」の末尾へ引きました(${String(Math.floor(page))} 頁)` }
          : { ok: false, message: ev.error ?? '引けませんでした' },
      );
    });
    let done = false;
    const settle = (r: PdfQuoteResult): void => {
      if (done) return;
      done = true;
      off();
      if (handle !== null) timers.clearTimer(handle);
      // 🔑 言うのは、disk に着いてから(窓にも状態の行にも同じ字)
      if (r.ok) note(r.message);
      resolve(r);
    };
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid: target,
      text: block,
      heading: null,
      // ⚠ 末尾へ足す(入り先の選択は本文の面の話 ── ここでは選ばせない)
      target: null,
    });
    const after = dispatcher.getState();
    if (after.writeLock === lockBefore) {
      settle({
        ok: false,
        message: after.error ?? 'いまは引けません。少し待ってから、もう一度押してください',
      });
      return;
    }
    handle = timers.setTimer(
      () => settle({ ok: false, message: QUOTE_SETTLE_TIMEOUT_MESSAGE }),
      QUOTE_SETTLE_TIMEOUT_MS,
    );
  });
}
