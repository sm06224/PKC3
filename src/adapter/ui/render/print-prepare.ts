/**
 * 🔴 **刷る前の用意 ── 折りたたみを開き、図を明るい配色で描き切る**(#1163 依頼 232 / 234 / 349)。
 *
 * ## 画面の物語
 *
 * - **折りたたんだ部分**(`:::details`)の中の図は、閉じている間は描かれない(見えない器は描かない)ので、
 *   そのまま刷ると図の書き方の字が紙に出ることがあった。Gemini の裁定(案 B):**刷る間だけ全部開いてから**図を描いて紙に出す。
 *   刷り終えたら、開けた物だけ元の閉じた状態へ戻す(最初から開いていた物には触らない)。
 * - **ダークの配色**のまま刷ると図が暗い地の四角で紙に出ていた。刷る間だけ図を明るい配色で描き直す(`diagram-print.ts`)。
 *
 * ⚠ 順番は「開く → 描く」。閉じたままだと器が見えず、描く側が飛ばす。
 * ⚠ 後始末は 1 つの関数にまとめて返す。**呼ばれないまま画面が開きっぱなし / 明るいまま**にならないよう、
 *   用意が刷りの上限時間(`print-note.ts` の待ち)を超えて終わった回は、**終わった瞬間に自分で戻す**(`current` が偽)。
 */
import { foldSpans } from '@features/markdown/heading-fold';
import { headingLevel } from './heading-fold';
import { bodyBlocks } from './log-days';
import { renderDiagramsLightForPrint } from './mermaid-hydrate';

/** 閉じている `<details>` と見出し・日の畳みを開き、**開けた物だけ**を戻す関数を返す。 */
export function openFoldsForPrint(root: ParentNode): () => void {
  const closed = [...root.querySelectorAll<HTMLDetailsElement>('details:not([open])')];
  for (const d of closed) d.open = true;
  const hiddenBlocks: HTMLElement[] = [];
  const hosts = new Set<HTMLElement>();
  for (const h of root.querySelectorAll('[data-pkc-folded], [data-pkc-day-folded]')) {
    if (h.parentElement !== null) hosts.add(h.parentElement);
  }
  for (const host of hosts) {
    const blocks = bodyBlocks(host);
    const hasDayFold = host.querySelector('[data-pkc-day-folded]') !== null;
    if (hasDayFold) {
      for (const el of blocks) {
        if (el instanceof HTMLElement && el.hidden) {
          el.hidden = false;
          hiddenBlocks.push(el);
        }
      }
    } else {
      for (const s of foldSpans(blocks.map(headingLevel))) {
        for (let i = s.from; i < s.to; i += 1) {
          const el = blocks[i];
          if (el instanceof HTMLElement && el.hidden) {
            el.hidden = false;
            hiddenBlocks.push(el);
          }
        }
      }
    }
  }
  return () => {
    for (const d of closed) if (d.isConnected) d.open = false;
    for (const el of hiddenBlocks) if (el.isConnected) el.hidden = true;
  };
}

/**
 * 本文の根を、刷れる形にして待つ。戻す関数を返す。
 * @param current まだ「この回の刷り」か。偽なら(上限を超えて終わった)すぐ戻す。
 */
export async function preparePrintBody(
  root: ParentNode,
  current: () => boolean = () => true,
): Promise<() => void> {
  const closeFolds = openFoldsForPrint(root);
  let lightOff: () => void = () => undefined;
  try {
    lightOff = await renderDiagramsLightForPrint(root);
  } catch {
    // 描き直しに失敗しても刷る(固まらない)── 失敗した図は原文のまま紙に出る
  }
  const restore = (): void => {
    lightOff();
    closeFolds();
  };
  if (!current()) restore();
  return restore;
}
