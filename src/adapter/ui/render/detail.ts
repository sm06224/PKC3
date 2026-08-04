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
import { hydrateMermaid, type MermaidScope } from './mermaid-hydrate';
import { applyBlocks, EMPTY_VIEW, type BlockView } from './apply-blocks';
import { iconButton } from './icons';
import { buildFormatBar } from './format-bar';
import { MarkdownClient } from '@adapter/platform/render/markdown-client';
import {
  extractDocumentGlobals,
  extractHeadingNumberConfig,
  applyDocumentGlobals,
} from '@features/markdown/document-globals';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { isAppMime } from '@features/launcher/tiles';
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
  /** 履歴 panel の断面(参照比較 ── P5b で view 指紋に加わった次元)。 */
  private lastPanel: AppState['revisionPanel'] = null;
  /** この render pass が貸し出した ObjectURL の dispose 群。**表示の寿命の
   *  終わり(次の render / 選択遷移)で必ず全部呼ぶ**(生成物のライフサイクル
   *  終端での即破棄 ── user 指示 2026-07-27 不可侵)。 */
  private readonly lends: Array<() => void> = [];
  /** 非同期 hydrate の stale 防止(選択が移ったら結果を捨てて即 dispose)。 */
  private hydrateToken = 0;

  /**
   * 🔴 **骨組みは使い回す**(P8 段⑪。user 指示 2026-08-03
   * 「レンダリングした後にスクロールがトップに戻る no-op も塞いでね」)。
   *
   * かつて view の描画は毎回 `region.textContent = ''` から始めていた。本文が
   * 変わるたび(追記 / 保存 / トグルの ack)に DOM が全部作り直され、
   * **読んでいた位置が先頭へ飛んでいた** ── 長いログでは追記した先が見えなくなる。
   * いまは題名・操作・本文の器を残し、**本文だけ差分で**当てる。
   */
  private skeletonLid: string | null = null;
  private titleEl: HTMLElement | null = null;
  private barSlot: HTMLElement | null = null;
  private panelSlot: HTMLElement | null = null;
  private bodyHost: HTMLElement | null = null;
  /** 本文の出し方(markdown / 素のまま / 添付)。変わったら器ごと作り直す。 */
  private bodyKind: 'md' | 'plain' | 'attachment' | 'loading' | null = null;
  private bodyView: BlockView = EMPTY_VIEW;
  /**
   * 図の面倒を**塊ごと**に持つ(全体に掛け直すと生きている `<img>` を壊す)。
   * ⚠ 新しい塊を作る前に `prune()` して、**器が全部外れた塊は畳む**
   * (P8 段⑰。レビュー H-5 ── 積もると PNG の URL と観測器が残り続ける)。
   */
  private readonly mermaidScopes: MermaidScope[] = [];
  /**
   * 編集へ入る直前の scroll。⚠ 編集の面は別物なので骨組みごと作り直すが、
   * **戻ってきたら元の位置へ戻す** ── 保存しただけで先頭へ飛ぶのも同じ no-op。
   */
  private parkedScroll: { lid: string; top: number } | null = null;
  /**
   * 骨組みを組み直した直後に戻したい位置。
   * ⚠ **本文を入れてから**戻す ── 空の器に `scrollTop` を代入しても
   * 「まだ scrollHeight が足りない」ので **0 に丸められる**(実際にそう外した)。
   */
  private pendingScroll: number | null = null;

  /** markdown を描く口(既定は自前。⚠ **要るまで worker は作らない**)。 */
  private readonly markdown: MarkdownClient;

  constructor(
    region: HTMLElement,
    assets: AssetLender | null = null,
    markdown: MarkdownClient = new MarkdownClient(),
  ) {
    this.region = region;
    this.assets = assets;
    this.markdown = markdown;
  }

  /** 編集プレビューの予約を捨てる(編集を抜けるとき)。 */
  private cancelPreview: (() => void) | null = null;
  /** 図の後始末(ObjectURL の revoke と観測の解除)。 */
  private disposeMermaid: (() => void) | null = null;

  private disposeLends(): void {
    for (const d of this.lends.splice(0)) d();
    this.hydrateToken += 1;
    this.cancelPreview?.();
    this.cancelPreview = null;
    this.disposeMermaid?.();
    this.disposeMermaid = null;
    for (const sc of this.mermaidScopes.splice(0)) sc.dispose();
  }

  /** 骨組みを捨てる(次の描画で組み直す)。 */
  private dropSkeleton(): void {
    this.skeletonLid = null;
    this.titleEl = null;
    this.barSlot = null;
    this.panelSlot = null;
    this.bodyHost = null;
    this.bodyKind = null;
    this.bodyView = EMPTY_VIEW;
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
    // 指紋は (selectedLid, body, phase, revisionPanel 参照)。title 次元は
    // 含めていない ── title 編集が入る段階で entryMetas 参照を指紋に足すこと
    if (
      this.mode !== 'editor' &&
      state.selectedLid === this.lastSelected &&
      body === this.lastBody &&
      state.phase === this.lastPhase &&
      state.revisionPanel === this.lastPanel
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
    this.lastPanel = state.revisionPanel;

    const lid = state.selectedLid;
    if (!lid) {
      this.disposeLends();
      this.region.textContent = '';
      this.dropSkeleton();
      this.mode = 'empty';
      return;
    }

    // 🔴 骨組みは**同じノートを見ている間は作り直さない**(scroll を殺さない)
    const fresh = this.skeletonLid !== lid || !this.bodyHost?.isConnected;
    if (fresh) {
      this.disposeLends(); // 前の表示が借りた URL はここで寿命終端
      this.region.textContent = '';
      this.titleEl = document.createElement('h2');
      this.titleEl.setAttribute('data-pkc-field', 'detail-title');
      this.barSlot = document.createElement('div');
      this.barSlot.setAttribute('data-pkc-field', 'detail-bar-slot');
      this.panelSlot = document.createElement('div');
      this.panelSlot.setAttribute('data-pkc-field', 'detail-panel-slot');
      this.bodyHost = document.createElement('div');
      this.bodyHost.setAttribute('data-pkc-field', 'detail-body-host');
      this.region.append(this.titleEl, this.barSlot, this.panelSlot, this.bodyHost);
      this.skeletonLid = lid;
      this.bodyKind = null;
      this.bodyView = EMPTY_VIEW;
      // ⚠ 別のノートへ移ったときだけ先頭から(そこは飛んで正しい)。
      //    編集から戻ったときは**元の位置へ**。実際に戻すのは本文を入れた後
      this.pendingScroll = this.parkedScroll?.lid === lid ? this.parkedScroll.top : 0;
      this.parkedScroll = null;
    }
    this.titleEl!.textContent = state.entryMetas.get(lid)?.title ?? '';

    if (body === null) {
      this.barSlot!.textContent = '';
      this.panelSlot!.textContent = '';
      if (this.bodyKind !== 'loading') {
        this.bodyKind = 'loading';
        this.bodyView = EMPTY_VIEW;
        this.bodyHost!.textContent = '';
        const loading = document.createElement('p');
        loading.setAttribute('data-pkc-field', 'detail-loading');
        loading.textContent = '読み込んでいます…';
        this.bodyHost!.append(loading);
      }
      return;
    }

    this.renderBar(state);
    this.renderPanel(state, lid);

    const fm = parseFrontmatter(body);
    const meta = state.entryMetas.get(lid);
    if (meta?.archetype === 'attachment') {
      // 添付は器ごと作り直す(preview / blob の貸し借りが絡むので差分にしない)
      // 🔴 **作り直す前に、借りていたものを返す**(P8 段⑰。レビュー H-4)。
      //    骨組みを使い回すようになった段⑪ 以降、`fresh` でない再描画では
      //    `disposeLends()` が走らないのに `textContent=''` で `<img>` だけ消えて
      //    いた ── 実測: 同じノートのまま履歴の開閉を 3 往復すると
      //    **lend 7 回 / dispose 0 回**、画面の `<img>` は 1 枚。
      //    ⚠ `hydrateToken` も進むので、飛んでいる hydratePreview が stale と
      //    判定されて detached な器へ描かなくなる(こちらも同じ穴だった)
      this.disposeLends();
      this.bodyKind = 'attachment';
      this.bodyView = EMPTY_VIEW;
      this.bodyHost!.textContent = '';
      this.renderAttachment(body, fm.body);
      this.restoreScroll();
      return;
    }
    if (hasMarkdownSyntax(fm.body)) {
      if (this.bodyKind !== 'md') {
        this.bodyKind = 'md';
        this.bodyView = EMPTY_VIEW;
        this.bodyHost!.textContent = '';
        this.bodyHost!.className = 'pkc-md-rendered';
        this.bodyHost!.setAttribute('data-pkc-field', 'detail-body');
      }
      const html = renderMarkdown(fm.body, {
        vars: extractVars(body),
        sourceLineAnchors: true,
        // heading-number は text レベル前処理(LineMap 不変)── 全文 body から抽出
        headingNumber: extractHeadingNumberConfig(body),
      });
      // 🔑 **変わった塊だけ**当てる(P8 段⑩⑪)── scroll も図も生き残る
      const applied = applyBlocks(this.bodyHost!, html, this.bodyView);
      this.bodyView = applied.view;
      // writing / direction / align / layout の属性契約(dir 込みで 1 箇所)
      applyDocumentGlobals(this.bodyHost!, extractDocumentGlobals(body));
      // ⚠ 面倒を見るのは**新しく入った所だけ**(全体に掛け直すと、生きている
      //    `<img>` の ObjectURL を revoke してしまう)
      if (applied.inserted.length > 0) {
        void this.hydrateAssetRefs(applied.inserted, this.hydrateToken);
        this.mermaidScopes.push(hydrateMermaid(applied.inserted));
        pruneScopes(this.mermaidScopes);
      }
      this.restoreScroll();
    } else {
      // 方言判定 false は plain text 扱い(PKC2 と同じゲート)
      if (this.bodyKind !== 'plain') {
        this.bodyKind = 'plain';
        this.bodyView = EMPTY_VIEW;
        this.bodyHost!.textContent = '';
        this.bodyHost!.className = '';
        this.bodyHost!.removeAttribute('data-pkc-field');
        const pre = document.createElement('pre');
        pre.setAttribute('data-pkc-field', 'detail-body');
        this.bodyHost!.append(pre);
      }
      // ⚠ `textContent` の代入は中身が同じなら DOM を作り直さない(scroll も動かない)
      const pre = this.bodyHost!.firstElementChild as HTMLElement;
      if (pre.textContent !== fm.body) pre.textContent = fm.body;
      this.restoreScroll();
    }
  }

  /**
   * 実際にスクロールする器。
   * ⚠ **`this.region` ではない** ── ここは `CenterRouter` が作った pane で、
   * `overflow: auto` を持つのは 1 つ外の `[data-pkc-region="detail"]` である
   * (pane の `scrollTop` を読み書きしても常に 0 で、位置戻しが黙って効かない ──
   *  実際にそう外した)。
   */
  private get scroller(): HTMLElement {
    return this.region.closest<HTMLElement>('[data-pkc-region="detail"]') ?? this.region;
  }

  /** 骨組みを組み直したときの位置戻し。⚠ **本文が入ってから**呼ぶ。 */
  private restoreScroll(): void {
    if (this.pendingScroll === null) return;
    this.scroller.scrollTop = this.pendingScroll;
    this.pendingScroll = null;
  }

  /** 本文の上の操作(小さいので毎回組み直す ── 出入りは phase が変わったときだけ)。 */
  private renderBar(state: AppState): void {
    const slot = this.barSlot!;
    slot.textContent = '';
    // error phase では「編集」を出さない ── START_EDIT は ready 限定なので、
    // 出したまま無言 no-op にしない(review B-1 原則: 無言の操作拒否を作らない)
    if (state.phase === 'ready') {
      const bar = document.createElement('div');
      bar.setAttribute('data-pkc-field', 'detail-toolbar');
      // 🔑 **ここには「編集」だけ**(P8)。書き出す / 履歴 / 削除は右の情報ペインが
      // 持つ ── 同じボタンを 2 か所に出すと、押す場所が定まらない。
      // 🔑 **追記もここに無い**(P8 段⑧)── 編集画面を通らない別の器が持つ
      bar.append(iconButton('start-edit', '編集'));
      slot.append(bar);
    } else if (
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
      slot.append(bar);
    }
  }

  private renderPanel(state: AppState, lid: string): void {
    const slot = this.panelSlot!;
    slot.textContent = '';
    if (state.phase === 'ready' && state.revisionPanel && state.revisionPanel.lid === lid) {
      slot.append(renderHistoryPanel(state.revisionPanel.items));
    }
  }

  private renderEditor(state: AppState): void {
    const open = state.openBody!;
    this.mode = 'editor';
    this.lastSelected = open.lid;
    this.lastBody = null;

    // ⚠ 編集へ入る前の位置を覚える ── 保存して戻ったときに先頭へ飛ばさない
    if (this.skeletonLid !== null)
      this.parkedScroll = { lid: this.skeletonLid, top: this.scroller.scrollTop };
    this.disposeLends();
    this.region.textContent = '';
    this.dropSkeleton();
    // title は uncontrolled input(commit 時に binder が RENAME を先行 dispatch)
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.setAttribute('data-pkc-field', 'editor-title');
    titleInput.value = state.entryMetas.get(open.lid)?.title ?? '';
    this.region.append(titleInput);

    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'detail-toolbar');
    const commit = iconButton('commit-edit', '保存');
    const cancel = iconButton('cancel-edit', 'キャンセル');
    bar.append(commit, cancel);
    this.region.append(bar);
    // 🔑 **書式パネル**(P8 段⑥)。編集欄のすぐ上 ── 押す物と効く先を離さない
    this.region.append(buildFormatBar());

    /**
     * 🔑 **書きながら見える**(P8 段②)。3 列にしたので、中央を 2 分割すれば
     * プレビューは「新機能」ではなく**配置の片側**として入る。
     *
     * ⚠ 更新は state ではなく **textarea の `input`** で駆動する ── `render()` は
     * 編集中の同一 entry では早期 return する(カーソルと IME を壊さないため)ので、
     * state 経由では届かない。
     * ⚠ 1 打鍵ごとに描かない。**rAF で 1 フレームに畳む** ── 連打すると
     * markdown の描画が打鍵に追いつかず「もっさり」になる。
     */
    const split = document.createElement('div');
    split.setAttribute('data-pkc-region', 'editor-split');
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    ta.value = open.body;
    const preview = document.createElement('div');
    preview.setAttribute('data-pkc-region', 'editor-preview');
    preview.className = 'pkc-md-rendered';
    split.append(ta, preview);
    this.region.append(split);

    /**
     * 🔑 **描くのはワーカー**(P8 段⑨。user 指示 2026-08-03「基本的に重い処理は
     * ワーカーにしてください」)── markdown の tokenize / render は 1 打鍵ごとに
     * 走る、いちばん定常に効く仕事である。`follower` が
     * 「飛ばすのは 1 件、その間の変更は最後の 1 つに畳む」を持つ。
     * ⚠ HTML の parse(`innerHTML`)はメインに残る ── そこは DOM なので動かせない。
     */
    let shown: BlockView = EMPTY_VIEW;
    /** 図の面倒は**塊ごと**に持つ ── 全体に掛け直すと、生きている `<img>` の
     *  ObjectURL を revoke してしまい、触っていない図が消える。
     *  ⚠ 差し替えで外れた器を持つ塊は `prune()` で畳む(段⑰) */
    const scopes: MermaidScope[] = [];
    const follow = this.markdown.follower(
      (html) => {
        // ⚠ 外された後に描かない(編集を抜けた瞬間の結果で無駄な仕事をしない)
        if (!preview.isConnected) return;
        const applied = applyBlocks(preview, html, shown);
        shown = applied.view;
        // 🔑 **新しく入った所だけ**図を面倒みる(触っていない図はそのまま)
        if (applied.inserted.length > 0) {
          scopes.push(hydrateMermaid(applied.inserted));
          // 🔴 **積もらせない**(P8 段⑰。レビュー H-5)── 静穏 tick ごとに塊が
          //    増え、画面に無い PNG の URL と観測器が編集中ずっと生きていた
          //    (実測: 5 tick で createObjectURL 5 / revokeObjectURL 0)
          pruneScopes(scopes);
        }
      },
      (e) => {
        // 🔴 **白紙にしない**。理由を出して原文だけは読めるようにする
        if (!preview.isConnected) return;
        preview.textContent = `プレビューを描けませんでした: ${String(e).slice(0, 120)}`;
      },
    );
    // 編集に入った直後は待たせない(**その場で 1 回**)
    follow.push(parseFrontmatter(ta.value).body, { sourceLineAnchors: false });
    follow.flush();
    ta.addEventListener('input', () => {
      // ⚠ rAF で畳まない ── 畳み込みは follower(静穏 + 上限)が持つ。
      //    2 か所で畳むと、どちらが効いているか分からなくなる
      follow.push(parseFrontmatter(ta.value).body, { sourceLineAnchors: false });
    });
    // ⚠ 編集を抜けるときに予約と図を畳む(detached なノードへ描かない)
    this.cancelPreview = () => {
      follow.dispose();
      for (const sc of scopes.splice(0)) sc.dispose();
    };
    ta.focus();
  }

  /** attachment フレーバーの view(P4a): メタ + preview + 説明 markdown。 */
  private renderAttachment(rawBody: string, description: string): void {
    const host = this.bodyHost ?? this.region;
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
    host.append(info);

    // 🔑 **アプリとして登録**(P8 段⑭)。
    //    🔴 PKC3 の中からタイルを作る手段が**1 つも無かった** ── タイルの元データは
    //    この添付の frontmatter に在るのに、書けるのは PKC2 の取込だけだった。
    //    ⚠ 置き場所は「操作は対象の隣」── その添付の画面に置く
    if (isAppMime(meta.mime)) host.append(appTileControls(rawBody));

    const previewHost = document.createElement('div');
    previewHost.setAttribute('data-pkc-field', 'attachment-preview');
    host.append(previewHost);
    if (this.assets && meta.assetKey) {
      void this.hydratePreview(previewHost, meta.assetKey, meta.mime, this.hydrateToken);
    }

    if (description.trim() !== '') {
      const desc = document.createElement('div');
      desc.className = 'pkc-md-rendered';
      desc.setAttribute('data-pkc-field', 'detail-body');
      desc.innerHTML = renderMarkdown(description, { sourceLineAnchors: true });
      host.append(desc);
      void this.hydrateAssetRefs(desc, this.hydrateToken);
      // 🔴 添付の説明にも図が書ける(P8 段⑬ review L-3)。かつてここだけ
      //    `hydrateMermaid` を呼んでおらず、**器が空のまま**残っていた ──
      //    「本文なら描けるのに、添付の説明だと描けない」という一貫性の穴
      this.mermaidScopes.push(hydrateMermaid(desc));
    }
  }

  /**
   * 本文 markdown 内の `asset:` 参照(P4b): markdown-render が出した
   * `img[data-pkc-asset-key]`(src 無し placeholder)に blob: URL を差す。
   * - **同一 key は 1 回だけ lend**(同じ asset を N 回参照しても URL は 1 本)
   * - URL は lends に登録し、次 render / 選択遷移で必ず dispose(即破棄規律)
   * - 選択が移っていたら(token 不一致)結果を捨てて即 dispose
   * - 見つからない key は `data-pkc-asset-missing` を立てる(alt が可視 fallback)
   */
  private async hydrateAssetRefs(
    /** ⚠ **まとめて渡す**(P8 段⑪)── 1 根ずつ呼ぶと、同じ key を別の塊から
     *  参照しているとき **2 回借りて ObjectURL が 2 本**になる(実際に退行した)。 */
    rootEls: HTMLElement | readonly Element[],
    token: number,
  ): Promise<void> {
    if (!this.assets) return;
    const assets = this.assets;
    const roots: readonly Element[] = Array.isArray(rootEls)
      ? (rootEls as readonly Element[])
      : [rootEls as Element];
    const byKey = new Map<string, HTMLImageElement[]>();
    const collect = (img: HTMLImageElement): void => {
      const key = img.getAttribute('data-pkc-asset-key') ?? '';
      const group = byKey.get(key);
      if (group) group.push(img);
      else byKey.set(key, [img]);
    };
    for (const r of roots) {
      if (r instanceof HTMLImageElement && r.hasAttribute('data-pkc-asset-key')) collect(r);
      for (const img of r.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]'))
        collect(img);
    }
    if (byKey.size === 0) return;
    await Promise.all(
      [...byKey].map(async ([key, imgs]) => {
        try {
          const lent = await assets.lend(key);
          if (token !== this.hydrateToken) {
            lent?.dispose(); // stale ── 借りた瞬間に返す(DOM は破棄済み)
            return;
          }
          if (!lent) {
            for (const img of imgs) img.setAttribute('data-pkc-asset-missing', '');
            return;
          }
          this.lends.push(lent.dispose);
          for (const img of imgs) img.src = lent.url;
        } catch {
          if (token === this.hydrateToken)
            for (const img of imgs) img.setAttribute('data-pkc-asset-missing', '');
        }
      }),
    );
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
      p.textContent = '添付の中身が見つかりません';
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

/** 履歴 panel(P5b)。開いた時点のスナップショット ── 復元・選択遷移で畳まれる。 */
function renderHistoryPanel(
  items: readonly { id: string; revOrder: number; createdAt: string | null; title: string | null }[],
): HTMLElement {
  const panel = document.createElement('div');
  panel.setAttribute('data-pkc-field', 'history-panel');
  const head = document.createElement('div');
  const label = document.createElement('span');
  label.textContent = items.length === 0 ? '履歴はありません' : `履歴 ${items.length} 件`;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-action', 'hide-history');
  close.textContent = '閉じる';
  head.append(label, close);
  panel.append(head);
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-rev-order', String(item.revOrder));
    const text = document.createElement('span');
    text.textContent = `#${item.revOrder} ${item.createdAt ?? ''} ${item.title ?? '(無題)'}`;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.setAttribute('data-pkc-action', 'restore-revision');
    restore.setAttribute('data-pkc-rev-id', item.id);
    restore.textContent = '復元';
    li.append(text, restore);
    list.append(li);
  }
  panel.append(list);
  return panel;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


/**
 * ランチャーのタイル設定(P8 段⑭)。
 *
 * 🔴 **PKC3 の中からタイルを作れなかった**のを塞ぐ。元データは添付の
 * frontmatter(`registered_as_app` / `app_group` / `app_icon`)に在るのに、
 * 書く導線が PKC2 の取込しか無かった ── PKC3 だけの user は、HTML を添付しても
 * ランチャーに 1 枚も並べられない。
 *
 * ⚠ **汎用の frontmatter エディタは作らない**。ここに要るのは 3 つだけで、
 * 汎用にすると「何を書いていいか分からない欄」になる。
 */
function appTileControls(rawBody: string): HTMLElement {
  const fm = parseFrontmatter(rawBody).meta;
  const box = document.createElement('div');
  box.setAttribute('data-pkc-field', 'app-tile-controls');

  const label = document.createElement('label');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.setAttribute('data-pkc-action', 'toggle-app-tile');
  check.setAttribute('data-pkc-field', 'app-register');
  check.checked = fm['attachment.registered_as_app'] === true;
  const text = document.createElement('span');
  text.textContent = 'アプリとして登録';
  label.append(check, text);
  box.append(label);

  // ⚠ 登録していないときは中の設定を出さない(押せない欄を並べない)
  if (!check.checked) return box;

  const field = (
    name: string,
    action: string,
    placeholder: string,
    value: unknown,
    size: number,
  ): void => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pkc-action', action);
    input.setAttribute('data-pkc-field', name);
    input.placeholder = placeholder;
    input.size = size;
    input.value = typeof value === 'string' ? value : '';
    box.append(input);
  };
  // ⚠ グループ名は**並び順そのもの**(名前順に並ぶ)── placeholder でそう言う
  field('app-group', 'set-app-group', 'グループ(名前順に並びます)', fm['attachment.app_group'], 16);
  field('app-icon', 'set-app-icon', '目印', fm['attachment.app_icon'], 3);
  return box;
}

/**
 * 器が全部 DOM から外れた塊を畳む(P8 段⑰)。
 * ⚠ **その場で配列を縮める** ── 畳んだ塊を残すと、次の tick でまた数えることになる。
 */
function pruneScopes(scopes: MermaidScope[]): void {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i]!.prune() === 0) {
      scopes[i]!.dispose();
      scopes.splice(i, 1);
    }
  }
}
