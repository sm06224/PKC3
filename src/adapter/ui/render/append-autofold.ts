/**
 * 🔴 **低い窓では、追記欄を最初から畳んで開く**(#701。user 裁定 2026-09-04 案 A)。
 *
 * ## 物語
 *
 * スマホを横に倒す(844×390)。⚠ 直す前は本文の器が **230px** しか無く(追記欄が 107px、
 * ページの帯が 36px)、本文は 7〜8 行しか読めなかった ── 追記欄を畳めば 300px を超えるのに、
 * 畳む取っ手は 8px でスマホの ⋯ にも「追記欄を畳む」は無かった(= 畳めることを誰も知らない)。
 *
 * 🔑 **窓の高さが足りないあいだは、こちらが追記欄を畳む**。畳んだ所には
 *   「ここに追記する」の帯が 1 行残り(CSS: `data-pkc-append-autofold`)、押すと欄が出る。
 *   送ったら元どおり畳む ── `peek` / `unpeek`(#655 ①)と**同じ機構**である。
 * ⚠ **user の畳みの記録(`pkc3.panes`)には 1 byte も書かない** ── 窓を高くすれば
 *   (または PC で開けば)何も無かったように追記欄が出る。書くと、スマホを横に倒した 1 回が
 *   PC の見え方まで変える。
 *
 * ## 数字は 1 か所
 *
 * 高さの境目は `features/pane-visibility.ts` の `APPEND_AUTOFOLD_MAX_HEIGHT_PX` で、
 * 読むのはここの `matchMedia` **1 本**だけ ── CSS は `data-pkc-append-autofold` の
 * 属性を読むだけで、数字を持たない(`phone-layout.ts` と同じ規律)。
 *
 * ⚠ 「本文の器が 300px を切ったら」という**実寸**では判定しない ── 畳むと器が伸びて
 *   条件が外れ、外れると戻して縮む(振動する)。窓の高さは畳んでも変わらない。
 */
import { APPEND_AUTOFOLD_MAX_HEIGHT_PX } from '@features/pane-visibility';
import { appPanes, applyPaneVisibility } from './pane-visibility';

type MediaLike = {
  readonly matches: boolean;
  addEventListener?: (t: 'change', fn: () => void) => void;
  removeEventListener?: (t: 'change', fn: () => void) => void;
};

/**
 * 高さの見張りを張る。⚠ 戻り値で外せる(unit が 1 件ずつ独立に張る)。
 * @param mm 差し替え口(unit / 別の窓)。既定は window の `matchMedia`。
 */
export function installAppendAutofold(
  root: HTMLElement,
  mm?: (q: string) => MediaLike | undefined,
): () => void {
  const make =
    mm ?? ((q: string) => (globalThis as { matchMedia?: (q: string) => MediaLike }).matchMedia?.(q));
  const media = make(`(max-height: ${APPEND_AUTOFOLD_MAX_HEIGHT_PX}px)`) ?? null;
  /**
   * 判定と適用は `appPanes` / `applyPaneVisibility` の 1 組 ── ここは繋ぐだけ。
   * ⚠ 畳みの台帳を 2 本にしない(`toggle-pane` / `peek` と同じ器に書く)。
   */
  const paint = (): void => {
    appPanes.setAutoFold(media?.matches === true ? 'append' : null);
    applyPaneVisibility(root, appPanes.getHidden());
  };
  if (media?.addEventListener) media.addEventListener('change', paint);
  paint();
  return () => {
    if (media?.removeEventListener) media.removeEventListener('change', paint);
  };
}
