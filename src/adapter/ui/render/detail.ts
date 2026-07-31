/**
 * detail region の描画(P3-5: view + editor)。
 *
 * 差分規律:
 * - view は (selectedLid, openBody の有無, body 文字列) が変わったときだけ描き直す
 *   (BODY_PERSISTED の ack で openBody 参照が変わっても body が同じなら再描画しない)
 * - **編集中は DOM を一切触らない**(1 打鍵ごとの UPDATE_OPEN_BODY で state は
 *   変わるが、textarea が入力の場なのでカーソル・IME を壊さない ── PKC2 renderer の
 *   編集中ガードと同じ規約)
 *
 * innerHTML への流し込みは markdown-render が `html: false`(生 HTML 不通過)で
 * 生成した出力に限る(PKC2 と同じ安全前提)。
 */
import {
  renderMarkdown,
  hasMarkdownSyntax,
} from '@features/markdown/markdown-render';
import { parseFrontmatter, extractVars } from '@features/markdown/frontmatter';
import {
  extractDocumentGlobals,
  extractHeadingNumberConfig,
  applyDocumentGlobals,
} from '@features/markdown/document-globals';
import type { AppState } from '@adapter/state/app-state';

type Mode = 'empty' | 'view' | 'editor';

export class DetailRenderer {
  private readonly region: HTMLElement;
  private mode: Mode = 'empty';
  private lastSelected: string | null = null;
  /** view で最後に描いた body(null = openBody 不在の loading 表示)。 */
  private lastBody: string | null = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  render(state: AppState): void {
    const editing = state.phase === 'editing' && state.openBody !== null;
    if (editing) {
      // 入力中の再描画はカーソル / IME を壊す ── 同一 entry の編集中は何もしない
      if (this.mode === 'editor' && this.lastSelected === state.openBody!.lid) return;
      this.renderEditor(state);
      return;
    }
    const body = state.openBody?.body ?? null;
    if (
      this.mode !== 'editor' &&
      state.selectedLid === this.lastSelected &&
      body === this.lastBody
    )
      return;
    this.renderView(state, body);
  }

  private title(state: AppState, lid: string): HTMLElement {
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'detail-title');
    title.textContent = state.entryMetas.get(lid)?.title ?? '';
    return title;
  }

  private renderView(state: AppState, body: string | null): void {
    this.mode = 'view';
    this.lastSelected = state.selectedLid;
    this.lastBody = body;

    this.region.textContent = '';
    if (!state.selectedLid) {
      this.mode = 'empty';
      return;
    }
    this.region.append(this.title(state, state.selectedLid));

    if (body === null) {
      const loading = document.createElement('p');
      loading.setAttribute('data-pkc-field', 'detail-loading');
      loading.textContent = '(loading…)';
      this.region.append(loading);
      return;
    }

    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'detail-toolbar');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.setAttribute('data-pkc-action', 'start-edit');
    edit.textContent = '編集';
    bar.append(edit);
    this.region.append(bar);

    const fm = parseFrontmatter(body);
    if (hasMarkdownSyntax(fm.body)) {
      const rendered = document.createElement('div');
      rendered.className = 'pkc-md-rendered';
      rendered.setAttribute('data-pkc-field', 'detail-body');
      rendered.innerHTML = renderMarkdown(fm.body, {
        vars: extractVars(body),
        sourceLineAnchors: true,
        // heading-number は text レベル前処理(LineMap 不変)── 全文 body から抽出
        headingNumber: extractHeadingNumberConfig(body),
      });
      // writing / direction / align / layout の属性契約(dir 込みで 1 箇所)
      applyDocumentGlobals(rendered, extractDocumentGlobals(body));
      this.region.append(rendered);
    } else {
      // 方言判定 false は plain text 扱い(PKC2 と同じゲート)
      const pre = document.createElement('pre');
      pre.setAttribute('data-pkc-field', 'detail-body');
      pre.textContent = fm.body;
      this.region.append(pre);
    }
  }

  private renderEditor(state: AppState): void {
    const open = state.openBody!;
    this.mode = 'editor';
    this.lastSelected = open.lid;
    this.lastBody = null;

    this.region.textContent = '';
    this.region.append(this.title(state, open.lid));

    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'detail-toolbar');
    const commit = document.createElement('button');
    commit.type = 'button';
    commit.setAttribute('data-pkc-action', 'commit-edit');
    commit.textContent = '保存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.setAttribute('data-pkc-action', 'cancel-edit');
    cancel.textContent = 'キャンセル';
    bar.append(commit, cancel);
    this.region.append(bar);

    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    ta.value = open.body;
    this.region.append(ta);
    ta.focus();
  }
}
