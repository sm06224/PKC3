/**
 * detail region の最小描画(P3-2 の暫定)。フレーバー presenter と editor は
 * P3-4 / P3-5 で本実装 ── ここでは選択と openBody の疎通を可視化するだけ。
 * openBody の参照が変わったときだけ描き直す(差分規律は最初から)。
 */
import type { AppState, OpenBody } from '@adapter/state/app-state';

export class DetailRenderer {
  private readonly region: HTMLElement;
  private lastSelected: string | null = null;
  private lastOpenBody: OpenBody | null = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  render(state: AppState): void {
    if (
      state.selectedLid === this.lastSelected &&
      state.openBody === this.lastOpenBody
    )
      return;
    this.lastSelected = state.selectedLid;
    this.lastOpenBody = state.openBody;

    this.region.textContent = '';
    if (!state.selectedLid) return;
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'detail-title');
    title.textContent = state.entryMetas.get(state.selectedLid)?.title ?? '';
    const body = document.createElement('pre');
    body.setAttribute('data-pkc-field', 'detail-body');
    body.textContent = state.openBody?.body ?? '(loading…)';
    this.region.append(title, body);
  }
}
