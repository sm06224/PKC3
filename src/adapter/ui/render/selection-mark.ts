/**
 * 🔴 **複数選択の行の印(見た目 + 読み上げ)を反映する**(#1064)。
 *
 * 背景色(`data-pkc-marked`)だけでなく、読み上げ(`aria-selected="true"`)にも
 * 選択状態を伝える(色だけで伝えない WAI-ARIA 設計)。
 *
 * ⚠ **描き手が 3 つある(sidebar / filer / dual-filer)ので、ここで束ねる**
 * (1 つだけ直すと残り 2 つが取り残される ── CLAUDE.md §7)。
 */
export function paintRowMark(el: HTMLElement, isMarked: boolean): void {
  if (isMarked) {
    el.setAttribute('data-pkc-marked', '');
    el.setAttribute('aria-selected', 'true');
  } else {
    el.removeAttribute('data-pkc-marked');
    el.removeAttribute('aria-selected');
  }
}
