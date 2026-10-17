/**
 * 🔴 **メッセージ・処理の記録のノートを読むときの、本文の上の帯**(台帳 #1852 束 L1。依頼 80-3 / 266)。
 *
 * ## 何が変わるか
 *
 * 直す前は、画面下の「未読のメッセージ N 件」から開いたメッセージのノートには、書き出す口もコピーする口も無く、
 * 種類(結果・注意・問題・配信)で絞る方法も無かった(種類は各行のラベルとして出ているだけ)。
 * いまは本文の上に帯を置く:
 *   - **メッセージ**: 種類のボタン(すべて / 問題 / 注意 / 結果 / 配信)と「メッセージを書き出す」
 *   - **処理の記録**: 「処理の記録を書き出す」(種類は 1 つだけなので絞りは出さない)
 *
 * ⚠ **新しい操作を作らない**。書き出しは `export-messages`(システムの節のボタン・「操作を探す」と同じ受け手)、
 *   絞りは `set-message-filter` 1 つ。絞りは画面に出す物を絞るだけで、disk の本文も書き出しも変えない。
 * ⚠ 編集・追記・削除・改名・履歴は system のノートでは出さない(設計 doc §7)── この帯にも置かない。
 */
import {
  MESSAGE_KIND_LABEL,
  SYSTEM_JOB_LID,
  titleForMessageLid,
  type MessageKind,
} from '@features/message/message-log';
import { buildPressedButton } from './choice-buttons';

/** 絞りの並び(「すべて」が先頭。困ったときにまず見る「問題」を次に置く)。 */
export const MESSAGE_FILTER_KINDS: readonly MessageKind[] = ['problem', 'caution', 'result', 'delivery'];

const FILTER_FIELD = 'message-filter';
const FILTER_ATTR = 'data-pkc-message-filter';

/** 帯を組む。⚠ 押されている印は `syncMessageBar` が当てる(器は 1 度だけ組む)。 */
export function buildMessageBar(lid: string): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-pkc-field', 'detail-toolbar');
  bar.setAttribute('data-pkc-message-bar', lid);

  if (lid !== SYSTEM_JOB_LID) {
    const row = document.createElement('div');
    row.setAttribute('data-pkc-field', FILTER_FIELD);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'メッセージの種類で絞る');
    const choices: ReadonlyArray<{ value: string; label: string }> = [
      { value: '', label: 'すべて' },
      ...MESSAGE_FILTER_KINDS.map((k) => ({ value: k, label: MESSAGE_KIND_LABEL[k] })),
    ];
    for (const c of choices) {
      row.append(
        buildPressedButton({
          action: 'set-message-filter',
          dataAttr: FILTER_ATTR,
          value: c.value,
          label: c.label,
          pressed: c.value === '',
        }),
      );
    }
    bar.append(row);
  }

  const exp = document.createElement('button');
  exp.type = 'button';
  exp.setAttribute('data-pkc-action', 'export-messages');
  exp.setAttribute('data-pkc-message-lid', lid);
  exp.textContent = `${titleForMessageLid(lid)}を書き出す`;
  exp.title = 'ノートの中身・題名・添付名は書き込まれません。バグ報告に貼れます。絞っていても、全部を書き出します';
  bar.append(exp);
  return bar;
}

/** いま絞っている種類を押された印に映す(`null` = すべて)。 */
export function syncMessageBar(bar: ParentNode, filter: MessageKind | null): void {
  const want = filter ?? '';
  for (const btn of bar.querySelectorAll<HTMLButtonElement>(`[data-pkc-field="${FILTER_FIELD}"] button`)) {
    const pressed = (btn.getAttribute(FILTER_ATTR) ?? '') === want ? 'true' : 'false';
    if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
  }
}

/** 値(`''` = すべて)を種類へ。知らない値は `null`(すべて)。 */
export function messageFilterOfAttr(raw: string | null): MessageKind | null {
  return MESSAGE_FILTER_KINDS.find((k) => k === raw) ?? null;
}
