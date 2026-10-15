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
import { DIAGRAM_EXPORT_FAIL_HEAD } from '../error-text';
import { CORRUPT_REFUSAL } from '../storage/db-corruption';
import { quotaBootNotice, type QuotaEstimate } from '../storage/quota-watch';
import { WRITE_QUOTA_REFUSAL } from '../storage/write-quota';
import type { MessageKind } from './message-log';

/**
 * 編集に入ろうとして、別のタブ・ウィンドウが握っていたときの断り文。
 * ⚠ 画面に出る字の**正本はここ 1 か所**(`binder.ts` が `OP_FAILED` に載せ、
 *   `messageKindForOpError` が同じ値で「注意」かを見分ける ── 2 か所に書くと
 *   片方だけ直した日に「注意」から外れる)。
 */
export const EDIT_ELSEWHERE_ERROR =
  'このノートは別のタブまたはウィンドウで編集中です(そちらを閉じるか保存してください。そのタブがもう無いときは、数分たつと編集できます)';

/**
 * `OP_FAILED` の文を、積むときの種類へ。
 * ⚠ 既定は「問題」。「注意」になるのは `EDIT_ELSEWHERE_ERROR` だけ
 *   (user が別のタブで保存すれば済む ── 操作が壊れたのではない)。
 */
export function messageKindForOpError(error: string): MessageKind {
  return error === EDIT_ELSEWHERE_ERROR ? 'caution' : 'problem';
}

/**
 * 🔴 **アプリが書いた固定の文の頭**(#1087)── `sanitizeMessageText` の `fixedHead` へ渡す。
 * 先頭が一致するあいだは括弧の潰しも 80 字の切りも掛けない(案内のボタン名と「次にすること」を残す)。
 * ⚠ 一致しない文(生の例外が前に付く・他の断り)は今までどおり潰して切る。
 * ⚠ `CORRUPT_REFUSAL` は後ろに `(op で検出: 生の例外)` が続きうる ── 続きの側は潰す・切るが効く。
 */
export function fixedHeadOfOpError(error: string): string {
  for (const head of [EDIT_ELSEWHERE_ERROR, WRITE_QUOTA_REFUSAL, CORRUPT_REFUSAL, DIAGRAM_EXPORT_FAIL_HEAD]) {
    if (error.startsWith(head)) return head;
  }
  return '';
}

/**
 * 🔴 **メッセージへ積む字**(#1087)。画面の 1 行(`state.error`)はそのままでよいが、集積地には
 * 図の書き出しの失敗の**原文を積まない**(mermaid の構文エラーは図の原文の一部を引用する)── 固定の先頭だけにする。
 */
export function messageTextOfOpError(error: string): string {
  return error.startsWith(DIAGRAM_EXPORT_FAIL_HEAD) ? DIAGRAM_EXPORT_FAIL_HEAD : error;
}

/** 積む 1 件(`MessagePost.post` へそのまま渡せる形)。 */
export interface CautionPost {
  readonly kind: 'caution';
  /** 出所(固定の機能名。user の入力は含めない)。 */
  readonly source: string;
  readonly text: string;
  /** 固定の文なので、全文を括弧の潰し・字数の切りから外す。 */
  readonly fixedHead: string;
}

/**
 * 保存先の空きが少ないとき(危ない段のときだけ)、積む 1 件を返す。
 * ⚠ **画面下の 1 行と同じ字**にする(2 本の文を持たない)。ok / 読めない端末は
 *   `null`(黙る ── 嘘の警告を積まない)。
 */
export function quotaCaution(est: QuotaEstimate): CautionPost | null {
  const text = quotaBootNotice(est);
  return text === '' ? null : { kind: 'caution', source: 'quota', text, fixedHead: text };
}

/**
 * 🔴 **書込の途中でタブが閉じても元へ戻す仕組みが、働いていない**(#1218 F1)。
 *
 * 保存先(OPFS)の接続で `xCheckReservedLock` の差し替え(`reserved-lock.ts`)が
 * 当たらなかったとき、大きな書込の途中でタブが殺されると**次に開けなくなりうる**。
 * ⚠ **黙って素通りさせない** ── 備えが効いていないことを user が知らないと、
 *   「大きな取り込みの最中にタブを閉じない」という自衛の手がかりが無い。
 *
 * ⚠ 言うのは **OPFS で開けた回の、差し替えが当たらず、上流も直っていない**ときだけ。
 *   `:memory:`(持ち歩ける 1 枚の HTML / 退避した回)は巻き戻しの話が無いので黙る
 *   (退避した回は別の 1 行が既に言っている)。
 */
export const RESERVED_LOCK_CAUTION_TEXT =
  '書き込みの途中でタブが閉じたときに元へ戻す仕組みが、このブラウザでは働いていません。大きな取り込みや索引の整理の最中は、タブを閉じないでください';

export function reservedLockCaution(init: {
  vfs: 'opfs-sahpool' | 'memory';
  reservedLockPatched: boolean;
  reservedLockUpstreamFixed: boolean;
}): CautionPost | null {
  if (init.vfs !== 'opfs-sahpool') return null;
  if (init.reservedLockPatched || init.reservedLockUpstreamFixed) return null;
  return { kind: 'caution', source: 'storage', text: RESERVED_LOCK_CAUTION_TEXT, fixedHead: RESERVED_LOCK_CAUTION_TEXT };
}
