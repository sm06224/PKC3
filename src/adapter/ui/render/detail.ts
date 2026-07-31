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
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import type { AppState, AppPhase } from '@adapter/state/app-state';

/** 添付表示のための asset 面(main が AssetBlobStore を cid 束縛で注入)。 */
export interface AssetLender {
  lend(assetKey: string): Promise<{ url: string; dispose: () => void } | null>;
  getBlob(assetKey: string): Promise<Blob | null>;
}

type Mode = 'empty' | 'view' | 'editor';

export class DetailRenderer {
  private readonly region: HTMLElement;
  private readonly assets: AssetLender | null;
  private mode: Mode = 'empty';
  private lastSelected: string | null = null;
  /** view で最後に描いた body(null = openBody 不在の loading 表示)。 */
  private lastBody: string | null = null;
  /** phase は toolbar の有無を変える(error では編集ボタンを出さない)。 */
  private lastPhase: AppPhase | null = null;
  /** この render pass が貸し出した ObjectURL の dispose 群。**表示の寿命の
   *  終わり(次の render / 選択遷移)で必ず全部呼ぶ**(生成物のライフサイクル
   *  終端での即破棄 ── user 指示 2026-07-27 不可侵)。 */
  private readonly lends: Array<() => void> = [];
  /** 非同期 hydrate の stale 防止(選択が移ったら結果を捨てて即 dispose)。 */
  private hydrateToken = 0;

  constructor(region: HTMLElement, assets: AssetLender | null = null) {
    this.region = region;
    this.assets = assets;
  }

  private disposeLends(): void {
    for (const d of this.lends.splice(0)) d();
    this.hydrateToken += 1;
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
    // 指紋は (selectedLid, body, phase)。title 次元は含めていない ──
    // title 編集が入る段階で entryMetas 参照を指紋に足すこと(現状到達不能)
    if (
      this.mode !== 'editor' &&
      state.selectedLid === this.lastSelected &&
      body === this.lastBody &&
      state.phase === this.lastPhase
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
    this.lastPhase = state.phase;

    this.disposeLends(); // 前の表示が借りた URL はここで寿命終端
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

    // error phase では「編集」を出さない ── START_EDIT は ready 限定なので、
    // 出したまま無言 no-op にしない(review B-1 原則: 無言の操作拒否を作らない)
    if (state.phase === 'ready') {
      const bar = document.createElement('div');
      bar.setAttribute('data-pkc-field', 'detail-toolbar');
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.setAttribute('data-pkc-action', 'start-edit');
      edit.textContent = '編集';
      // ⚠ data-pkc-entry は「entry を表す要素」(行 / カード)専用の意味論 ──
      // ボタンには付けない(binder は selectedLid に fallback する)
      const del = document.createElement('button');
      del.type = 'button';
      del.setAttribute('data-pkc-action', 'delete-entry');
      del.textContent = '削除';
      bar.append(edit, del);
      this.region.append(bar);
    } else if (
      // ⚠ この条件は baseline / persisted / diskAhead に依存するが、view の
      // skip 指紋は (lid, body, phase) のみ ── 「条件が変わる遷移は必ず phase か
      // body も変わる」ことに依存している(P3-6b review #8 で全遷移を確認)。
      // openBody の指紋次元を増やす変更をするときはここを再点検すること
      state.phase === 'error' &&
      state.openBody &&
      state.openBody.baseline !== state.openBody.persisted &&
      !state.openBody.diskAhead
    ) {
      // 保存失敗からの復帰導線: baseline ≠ persisted =「disk に未達の commit が
      // ある」証拠(P3-5 の分離の回収点)。黙って死なせず再送を提示する
      const bar = document.createElement('div');
      bar.setAttribute('data-pkc-field', 'detail-toolbar');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.setAttribute('data-pkc-action', 'retry-persist');
      retry.textContent = '再保存';
      bar.append(retry);
      this.region.append(bar);
    }

    const fm = parseFrontmatter(body);
    const meta = state.selectedLid ? state.entryMetas.get(state.selectedLid) : null;
    if (meta?.archetype === 'attachment') {
      this.renderAttachment(body, fm.body);
      return;
    }
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

    this.disposeLends();
    this.region.textContent = '';
    // title は uncontrolled input(commit 時に binder が RENAME を先行 dispatch)
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.setAttribute('data-pkc-field', 'editor-title');
    titleInput.value = state.entryMetas.get(open.lid)?.title ?? '';
    this.region.append(titleInput);

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

  /** attachment フレーバーの view(P4a): メタ + preview + 説明 markdown。 */
  private renderAttachment(rawBody: string, description: string): void {
    const meta = readAttachmentMeta(rawBody);
    const info = document.createElement('div');
    info.setAttribute('data-pkc-field', 'attachment-info');
    const label = document.createElement('span');
    label.textContent = `${meta.name || '(無名)'} — ${meta.mime}${
      meta.size !== null ? ` — ${formatSize(meta.size)}` : ''
    }`;
    info.append(label);
    if (meta.assetKey) {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.setAttribute('data-pkc-action', 'download-asset');
      dl.setAttribute('data-pkc-asset-key', meta.assetKey);
      dl.setAttribute('data-pkc-asset-name', meta.name || 'download');
      dl.textContent = 'ダウンロード';
      info.append(dl);
    }
    this.region.append(info);

    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'attachment-preview');
    this.region.append(host);
    if (this.assets && meta.assetKey) {
      void this.hydratePreview(host, meta.assetKey, meta.mime, this.hydrateToken);
    }

    if (description.trim() !== '') {
      const desc = document.createElement('div');
      desc.className = 'pkc-md-rendered';
      desc.setAttribute('data-pkc-field', 'detail-body');
      desc.innerHTML = renderMarkdown(description, { sourceLineAnchors: true });
      this.region.append(desc);
    }
  }

  /**
   * preview の非同期注入。ObjectURL は lends に登録し、次 render で必ず dispose
   * (表示中だけ生きる ── 即破棄規律)。選択が移っていたら結果を捨てて即 dispose。
   */
  private async hydratePreview(
    host: HTMLElement,
    assetKey: string,
    mime: string,
    token: number,
  ): Promise<void> {
    const assets = this.assets!;
    const missing = (): void => {
      const p = document.createElement('p');
      p.setAttribute('data-pkc-asset-missing', '');
      p.textContent = '(asset が見つかりません)';
      host.append(p);
    };
    try {
      if (mime.startsWith('text/') || mime === 'application/json') {
        const blob = await assets.getBlob(assetKey);
        if (token !== this.hydrateToken) return; // stale ── DOM は既に破棄済み
        if (!blob) return missing();
        // 全量を heap に読まない ── preview に要る分だけ slice して decode
        // (multibyte の端欠けは preview 用途で許容。review #2)
        const truncated = blob.size > 200_000;
        const text = await blob.slice(0, 200_000).text();
        if (token !== this.hydrateToken) return;
        const pre = document.createElement('pre');
        pre.setAttribute('data-pkc-field', 'attachment-text');
        pre.textContent = truncated ? `${text}\n…(先頭 200KB のみ表示)` : text;
        host.append(pre);
        return;
      }
      const kind = mime.startsWith('image/')
        ? 'img'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : mime === 'application/pdf'
              ? 'pdf'
              : null;
      if (!kind) return; // preview 無し(ダウンロードのみ)
      const lent = await assets.lend(assetKey);
      if (token !== this.hydrateToken) {
        lent?.dispose(); // stale ── 借りた瞬間に返す
        return;
      }
      if (!lent) return missing();
      this.lends.push(lent.dispose);
      if (kind === 'img') {
        const img = document.createElement('img');
        img.setAttribute('data-pkc-field', 'attachment-media');
        img.src = lent.url;
        host.append(img);
      } else if (kind === 'video' || kind === 'audio') {
        const media = document.createElement(kind);
        media.setAttribute('data-pkc-field', 'attachment-media');
        media.controls = true;
        media.src = lent.url;
        host.append(media);
      } else {
        const obj = document.createElement('object');
        obj.setAttribute('data-pkc-field', 'attachment-media');
        obj.type = 'application/pdf';
        obj.data = lent.url;
        host.append(obj);
      }
    } catch {
      if (token === this.hydrateToken) missing();
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
