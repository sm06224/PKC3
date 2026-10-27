/**
 * 🔴 **左のペインの「手書き」タブ**(#1448。CLAUDE.md §2-10「補助的な物は中央の本文を奪わない ── 別ウィンドウが塞がれたときの
 * 退避先は中央ではなく左のタブ」)。
 *
 * 「画像に描き込む」「手書きして置く…」は別ウィンドウで描く。ブラウザがポップアップを止めたとき(または窓を開けない端末)は、
 * **同じ道具**(`buildImageDraw`)を、この面に出す。
 *
 * - タブは**描いている間だけ**出る(普段は隠れている)── 開くと「手書き」が選ばれ、閉じると**前に見ていたタブへ戻る**。
 * - 面は 1 つ ⇒ 同時に描けるのは 1 枚(2 枚目は呼び側が断る)。
 * - ⚠ タブの選び方・畳み方は `setBrowse`(探し方の切替の唯一の口)を通す ── ここで面の hidden を直に動かさない。
 * - ⚠ このタブの選択は憶えない(`main.ts` の `setBrowse` が `draw` を保存しない)── 次の起動で空の面を開かない。
 */
import type { DrawPane } from '@adapter/platform/image-draw-window';
import type { BrowseMode } from './browse-mode';

export interface DrawPaneDeps {
  /** 道具と台を組む器(`BrowseRouter.drawPaneRoot()`)。 */
  readonly root: HTMLElement;
  /** タブを出す / 畳む(`BrowseRouter.setDrawTab`)。 */
  setTab(visible: boolean): void;
  /** いま選んでいる探し方。 */
  current(): BrowseMode;
  /** 探し方を切り替える(`setBrowse`)。 */
  select(mode: BrowseMode): void;
}

export function createDrawPane(deps: DrawPaneDeps): DrawPane {
  /** 開く前に見ていたタブ。 */
  let before: BrowseMode | null = null;
  return {
    root: deps.root,
    enter(): void {
      const now = deps.current();
      if (now !== 'draw') before = now;
      deps.setTab(true);
      if (now !== 'draw') deps.select('draw');
    },
    leave(): void {
      deps.setTab(false);
      // 手書きを見ているときだけ戻す(別のタブへ移っていたら、そのまま)
      if (deps.current() === 'draw') deps.select(before ?? 'filer');
      before = null;
    },
  };
}
