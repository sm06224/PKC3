/**
 * 🔴 **メッセージの種類「注意」として積む出来事**(設計 doc `ui-total-design-2026-09.md` §7、
 * #1017。種類の定義は「注意 = user がすることがある」)。
 *
 * 型(`MessageKind` の `caution`)は段②a から在ったが、**積む出来事が 0 件**だった。
 * 次の 2 つを「注意」にする(画面下の 1 行は今までどおり出す ── 積む先を足すだけ):
 *
 * 1. **保存先の空きが少ない**(起動のとき 1 度だけ言う。`quota-watch.ts`)
 * 2. **別のタブ・ウィンドウが同じノートを編集中**(編集を始めようとして断られた)
 *
 * ⚠ **pure module**(browser API を持たない)。判断(どの出来事が「注意」か)をここに
 *   寄せる ── `main.ts` はどの test からも実行されないので、そこに判断を書かない
 *   (CLAUDE.md §2「どの test からも実行されない file に判断を書かない」)。
 * ⚠ 「問題」(操作が通らなかった)との境は **この 2 件だけ**を名指しする。
 *   他の `OP_FAILED` は今までどおり「問題」のまま。
 */
import { quotaBootNotice, type QuotaEstimate } from '../storage/quota-watch';
import type { MessageKind } from './message-log';

/**
 * 編集に入ろうとして、別のタブ・ウィンドウが握っていたときの断り文。
 * ⚠ 画面に出る字の**正本はここ 1 か所**(`binder.ts` が `OP_FAILED` に載せ、
 *   `messageKindForOpError` が同じ値で「注意」かを見分ける ── 2 か所に書くと
 *   片方だけ直した日に「注意」から外れる)。
 */
export const EDIT_ELSEWHERE_ERROR =
  'このノートは別のタブかウィンドウで編集中です(そちらを閉じるか保存してください)';

/**
 * `OP_FAILED` の文を、積むときの種類へ。
 * ⚠ 既定は「問題」。「注意」になるのは `EDIT_ELSEWHERE_ERROR` だけ
 *   (user が別のタブで保存すれば済む ── 操作が壊れたのではない)。
 */
export function messageKindForOpError(error: string): MessageKind {
  return error === EDIT_ELSEWHERE_ERROR ? 'caution' : 'problem';
}

/** 積む 1 件(`MessagePost.post` へそのまま渡せる形)。 */
export interface CautionPost {
  readonly kind: 'caution';
  /** 出所(固定の機能名。user の入力は含めない)。 */
  readonly source: string;
  readonly text: string;
}

/**
 * 保存先の空きが少ないとき(危ない段のときだけ)、積む 1 件を返す。
 * ⚠ **画面下の 1 行と同じ字**にする(2 本の文を持たない)。ok / 読めない端末は
 *   `null`(黙る ── 嘘の警告を積まない)。
 */
export function quotaCaution(est: QuotaEstimate): CautionPost | null {
  const text = quotaBootNotice(est);
  return text === '' ? null : { kind: 'caution', source: 'quota', text };
}
