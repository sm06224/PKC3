/**
 * detail region の描画(P3-3: text presenter の最小結線)。
 * openBody の参照が変わったときだけ描き直す(差分規律)。
 * フレーバー presenter 分岐と editor は P3-4 / P3-5 で本実装。
 *
 * innerHTML への流し込みは markdown-render が `html: false`(生 HTML 不通過)で
 * 生成した出力に限る(PKC2 と同じ安全前提)。
 */
import {
  renderMarkdown,
  hasMarkdownSyntax,
} from '@features/markdown/markdown-render';
import { parseFrontmatter, extractVars } from '@features/markdown/frontmatter';
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
    this.region.append(title);

    if (!state.openBody) {
      const loading = document.createElement('p');
      loading.setAttribute('data-pkc-field', 'detail-loading');
      loading.textContent = '(loading…)';
      this.region.append(loading);
      return;
    }

    const raw = state.openBody.body;
    const fm = parseFrontmatter(raw);
    if (hasMarkdownSyntax(fm.body)) {
      const rendered = document.createElement('div');
      rendered.className = 'pkc-md-rendered';
      rendered.setAttribute('data-pkc-field', 'detail-body');
      rendered.innerHTML = renderMarkdown(fm.body, {
        vars: extractVars(raw),
        sourceLineAnchors: true,
      });
      this.region.append(rendered);
    } else {
      // 方言判定 false は plain text 扱い(PKC2 と同じゲート)
      const pre = document.createElement('pre');
      pre.setAttribute('data-pkc-field', 'detail-body');
      pre.textContent = fm.body;
      this.region.append(pre);
    }
  }
}
