/**
 * 窓で選んだ字を、ノートへ**引く**(#275 段①)── 本体側の判断。
 *
 * 🔑 **書くのは既存の追記(`APPEND_TO_ENTRY`)** ── 新しい書込経路を作らない。錠(`writeLock`)・
 *   編集中の門・別の窓との衝突の足し直しは、全部あちらが持つ(ここで数え直さない。§7)。
 * ⚠ 窓は text と頁番号を**放送で送るだけ**で、どのノートへ書くかは**ここで解く**
 *   (窓の言い分を信じて lid を受け取らない ── 窓は同一 origin の別 realm である)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { formatPdfQuote, resolveQuoteTarget } from '@features/pdf/pdf-quote';
import type { PdfQuoteResult, PdfSession } from './pdf-window';

export function quoteIntoNote(
  dispatcher: Dispatcher,
  session: PdfSession,
  text: string,
  page: number,
  /** 本体の状態の行へ出す口(通ったときだけ呼ぶ)。 */
  note: (text: string) => void,
): PdfQuoteResult {
  const st = dispatcher.getState();
  if (session.lid === null) return { ok: false, message: '引く先のノートが分かりません' };
  const target = resolveQuoteTarget(session.lid, st.entryMetas, st.relations);
  const meta = st.entryMetas.get(target);
  if (meta === undefined) return { ok: false, message: '引く先のノートが見つかりません' };
  const block = formatPdfQuote(text, page, session.name);
  if (block === null) return { ok: false, message: '引く字が選ばれていません' };
  // 🔑 通ったかは reducer が錠を掛けたかで見る(断った回は錠が動かない。予定の面の追記と同じ)
  const lockBefore = st.writeLock;
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
    return {
      ok: false,
      message: after.error ?? 'いまは引けません。少し待ってから、もう一度押してください',
    };
  }
  const done = `「${meta.title}」の末尾へ引きました(${String(Math.floor(page))} 頁)`;
  note(done);
  return { ok: true, message: done };
}
