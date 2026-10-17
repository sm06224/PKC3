/**
 * 🔴 **メッセージのノートを、どの種類で絞って見せているか**(台帳 #1852 束 L1。依頼 266)。
 *
 * ⚠ **この画面を開いている間だけ**の見せ方(保存しない)── 開き直すと「すべて」に戻る。disk の本文も書き出しも変えない。
 * 絞った本文は `store-effects.ts` が本文を読む口(`REQUEST_MESSAGES_BODY`)で作り、画面は普通のノートと同じ道で描く。
 */
import type { MessageKind } from '@features/message/message-log';

let current: MessageKind | null = null;

/** いまの絞り(`null` = すべて)。 */
export function messageKindFilter(): MessageKind | null {
  return current;
}

export function setMessageKindFilter(kind: MessageKind | null): void {
  current = kind;
}
