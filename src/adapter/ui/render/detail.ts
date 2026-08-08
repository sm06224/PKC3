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
import { renderMarkdown } from '@features/markdown/markdown-render';
import { parseFrontmatter, extractVars } from '@features/markdown/frontmatter';
import { hydrateMermaid, type MermaidScope } from './mermaid-hydrate';
import { applyBlocks, EMPTY_VIEW, type BlockView } from './apply-blocks';
import { RowSwap } from './row-swap';
import type { RenderedWithRanges } from '@adapter/platform/render/markdown-client';
import {
  EMPTY_JOURNAL,
  record,
  redo,
  spliceLines,
  stepFor,
  undo,
} from '@features/markdown/edit-journal';
import { iconButton } from './icons';
import { buildFormatBar } from './format-bar';
import { hasSourceSelection } from '../actions/copy-source';
import {
  appExternalImages,
  buildExternalImageBar,
  ExternalImagePolicy,
} from './external-images';
import { EXTERNAL_IMAGE_ATTR } from '@features/markdown/external-images';
import { MarkdownClient } from '@adapter/platform/render/markdown-client';
import {
  extractDocumentGlobals,
  extractHeadingNumberConfig,
  applyDocumentGlobals,
} from '@features/markdown/document-globals';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { isAppMime } from '@features/launcher/tiles';
import { formatAssetRef, isImageAssetMime } from '@features/asset/asset-ref-format';
import type { AppState, AppPhase } from '@adapter/state/app-state';
import { appFlags } from '@adapter/platform/flag-store';
import { FLAG_LIVE_EDITOR } from '@features/flags';

/** 添付表示のための asset 面(main が AssetBlobStore を cid 束縛で注入)。 */
export interface AssetLender {
  lend(assetKey: string): Promise<{ url: string; dispose: () => void } | null>;
  getBlob(assetKey: string): Promise<Blob | null>;
}

type Mode = 'empty' | 'view' | 'editor';

/** 本文の上の操作の**形**。形が変わるときだけ器を組み直す(`renderBar`)。 */
type BarShape = 'edit' | 'retry' | 'none';

/**
 * 🔴 **ライブエディタの口**。1 面に畳む(2026-08-05)。
 *
 * ⚠ **2026-08-07 に flag へ昇格した**(user 指示。不可侵)。かつてここは
 * 「URL だけ・保存しない・一覧に出さない」で、理由を「計測用の逃がし口を正規 flag に
 * すると上限 15 と宣言義務を計測器が食う」としていた ── **それが抜け穴だった**。
 * user 指示「**URL クエリパラメータ切り替えはフラグ扱いである / クエリパラメータを
 * 抜け穴にしてはいけない**」により、いまは `editor.live` として宣言され、
 * 予算に数えられ、フラグ画面に出る。
 * ⚠ 既定 OFF(設計 §9 論点 C ── 塊を跨ぐ Ctrl+Z が入るまで既定にしない)。
 */
export function liveEditorEnabled(): boolean {
  return appFlags.isOn(FLAG_LIVE_EDITOR.name);
}

export class DetailRenderer {
  private readonly region: HTMLElement;
  private readonly assets: AssetLender | null;
  private _mode: Mode = 'empty';
  /**
   * 🔴 **いまの面を DOM にも書く**(2026-08-08)。CSS が読む ──
   * 読む面は「中身の高さまで伸ばす」(貼り付いた操作の帯が外れないように)、
   * 編集の面は「スクロール箱の高さで止める」(プレビューが自分で送れるように)。
   * ⚠ 2 つは**逆向きの要求**なので、面を見分けずに片方へ寄せると必ずもう片方が
   *   壊れる(実際、伸ばす側だけ当ててプレビューが送れなくなった)。
   */
  private get mode(): Mode {
    return this._mode;
  }
  private set mode(m: Mode) {
    this._mode = m;
    this.region.setAttribute('data-pkc-detail-mode', m);
  }
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
  /**
   * 借りている ObjectURL(と返し方)。
   *
   * 🔴 **どの要素のために借りたか**を一緒に持つ(P8 段⑲)。持っていないと
   * 「画面から消えた要素ぶんだけ返す」ができず、**同じノートを開いたまま**
   * 本文が差し替わるたびに溜まる ── 実測: 履歴復元を 5 回で
   * **lend 6 回 / dispose 0 回、画面の `<img>` は 1 枚**。
   * 骨組みを使い回す(段⑪)以上、`disposeLends()` は選択が動いたときしか
   * 走らないので、差分描画の側にも返す道が要る(図の `pruneScopes` と同じ形)。
   */
  private readonly lends: Array<{ dispose: () => void; els: Element[] }> = [];
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
  /**
   * 操作の器の**形**(2026-08-07)。形が同じなら node を使い回す ──
   * 詳細は `renderBar` の注記。⚠ 骨組みを作り直したら `null` へ戻す
   * (古い node を指したまま「形は同じ」と判断すると、外れた node を patch する)。
   */
  private barShape: BarShape | null = null;
  private barButton: HTMLButtonElement | null = null;
  /**
   * 読む面のコピー(2026-08-08。user 裁定「markdown のテキストとしてのコピーと
   * HTML 書式ありのコピーの両方」)。⚠ 器と同じ寿命 ── `dropBarState` で忘れる。
   */
  private barCopy: {
    md: HTMLButtonElement;
    rich: HTMLButtonElement;
    sel: HTMLButtonElement;
  } | null = null;
  private panelSlot: HTMLElement | null = null;
  /** いま出している履歴パネル(参照で比べる ── 同じなら触らない)。 */
  private shownPanel: AppState['revisionPanel'] = null;
  /** 外部画像の確認の帯(2026-08-06)。⚠ 本文の器の**外**。 */
  private noticeSlot: HTMLElement | null = null;
  private bodyHost: HTMLElement | null = null;
  /**
   * 本文の出し方(markdown / 添付)。変わったら器ごと作り直す。
   * ⚠ かつて `'plain'`(記法が無い本文を `<pre>` で出す)が在ったが、
   *   **面ごとに見え方が違う**原因だったので落とした(2026-08-06。user 報告 2-6)。
   */
  private bodyKind: 'md' | 'attachment' | 'loading' | null = null;
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
  /**
   * 読む面の描画の世代(2026-08-06。user 報告 2-8)。ワーカーへ逃がしたので
   * **古い結果を載せない**ための弁別が要る(選択を素早く動かすと逆順で届く)。
   */
  private viewToken = 0;

  /** markdown を描く口(既定は自前。⚠ **要るまで worker は作らない**)。 */
  private readonly markdown: MarkdownClient;

  constructor(
    region: HTMLElement,
    assets: AssetLender | null = null,
    markdown: MarkdownClient = new MarkdownClient(),
    /**
     * 🔴 **本文が変わったことを外へ知らせる**(2026-08-05。ライブエディタ S5)。
     *
     * ⚠ renderer は dispatch しない(層規約)── 「変わった」を渡すだけで、
     * `UPDATE_OPEN_BODY` を投げるのは配線側(`main.ts`)の仕事。
     * ⚠ 原文の**継ぎ足しはこちらが 1 か所で**やる(規則を 2 つ書かない)。
     */
    private readonly onBodyChange: ((body: string) => void) | null = null,
    /**
     * 外部画像の設定と、このノートの同意(2026-08-06、user 裁定)。
     * ⚠ 既定はアプリ共有の 1 個 ── test は自分で `new` して渡す。
     */
    private readonly externalImages: ExternalImagePolicy = appExternalImages,
  ) {
    this.region = region;
    this.assets = assets;
    this.markdown = markdown;
    /**
     * 選択範囲コピーの活性は selection で決まる(state に無い)。
     * ⚠ renderer はアプリと同寿命なので外さない ── handler は器が外れていれば
     * 何もしない(test が renderer を作り捨てても積み害は無い)。
     */
    region.ownerDocument.addEventListener('selectionchange', () => this.syncCopySelection());
  }

  /**
   * 外部画像の答えが変わった ── **次の `render()` で必ず描き直す**。
   *
   * 🔴 指紋(`lastBody` 等)は state しか見ていないので、state が動かない
   * 同意の変化では**早期 return で何も起きない**。だから指紋を 1 つ崩す。
   * ⚠ 骨組みは残す(`skeletonLid` を触らない)── スクロール位置と図が生き残る。
   */
  invalidate(): void {
    this.lastBody = null;
  }

  /** 編集プレビューの予約を捨てる(編集を抜けるとき)。 */
  private cancelPreview: (() => void) | null = null;
  /** 図の後始末(ObjectURL の revoke と観測の解除)。 */
  private disposeMermaid: (() => void) | null = null;

  private disposeLends(): void {
    for (const l of this.lends.splice(0)) l.dispose();
    this.hydrateToken += 1;
    this.cancelPreview?.();
    this.cancelPreview = null;
    this.disposeMermaid?.();
    this.disposeMermaid = null;
    for (const sc of this.mermaidScopes.splice(0)) sc.dispose();
  }

  /**
   * 画面から消えた要素のぶんだけ返す(図の `pruneScopes` と同じ形)。
   * ⚠ **1 つでも生きていれば残す** ── 同じ key を複数の塊が参照しているとき、
   * 片方が消えただけで返すと生きている `<img>` の src が死ぬ。
   */
  private pruneLends(): void {
    for (let i = this.lends.length - 1; i >= 0; i--) {
      const l = this.lends[i]!;
      if (l.els.some((e) => e.isConnected)) continue;
      l.dispose();
      this.lends.splice(i, 1);
    }
  }

  /** 骨組みを捨てる(次の描画で組み直す)。 */
  private dropSkeleton(): void {
    this.skeletonLid = null;
    this.titleEl = null;
    this.barSlot = null;
    this.panelSlot = null;
    this.noticeSlot = null;
    this.bodyHost = null;
    this.bodyKind = null;
    this.bodyView = EMPTY_VIEW;
    this.dropBarState();
  }

  /**
   * ⚠ **器を作り直したら「いま出している形」も忘れる**(2026-08-07)。
   * 忘れないと、外れた古い node を「形は同じ」と見て patch し続ける ──
   * 画面には何も出ないのに test は通る、いちばん質の悪い形になる。
   */
  private dropBarState(): void {
    this.barShape = null;
    this.barButton = null;
    this.barCopy = null;
    this.shownPanel = null;
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
      /**
       * 🔑 **何も選んでいないときに案内を出す**(P9 段③)。
       *
       * 前はここが `textContent = ''` だけで、初回起動の中央が
       * **1190×1000px の白紙**だった(実測)── 右の列だけが「左の一覧から選ぶと」と
       * 言っていて、中央は何も言わない。初めて開いた人には**次にどこを押すか**が無い。
       * ⚠ **ボタンを置かない** ── 新規 / 取り込む は左の列が持っている
       *   (「同じものは 1 か所」の規則)。ここは**場所を教える文だけ**にする。
       */
      const guide = document.createElement('p');
      guide.setAttribute('data-pkc-field', 'detail-empty');
      // ⚠ **実際のボタンの文言を指す** ── P10 で「新規」は「+ ノート」になった。
      //    案内が画面と食い違うと、探しても見つからない
      guide.textContent =
        '左の一覧から選ぶと、ここに本文が出ます。まだ何も無いときは、左上の「+ ノート」で作るか、左下の「取り込む」で読み込みます。';
      this.region.append(guide);
      return;
    }

    // 🔴 骨組みは**同じノートを見ている間は作り直さない**(scroll を殺さない)
    const fresh = this.skeletonLid !== lid || !this.bodyHost?.isConnected;
    if (fresh) {
      this.disposeLends(); // 前の表示が借りた URL はここで寿命終端
      this.region.textContent = '';
      this.dropBarState(); // ⚠ slot ごと作り直すので、いま出している形も忘れる
      this.titleEl = document.createElement('h2');
      this.titleEl.setAttribute('data-pkc-field', 'detail-title');
      this.barSlot = document.createElement('div');
      this.barSlot.setAttribute('data-pkc-field', 'detail-bar-slot');
      this.panelSlot = document.createElement('div');
      this.panelSlot.setAttribute('data-pkc-field', 'detail-panel-slot');
      // ⚠ 確認の帯は**本文の器の外**に置く ── 中に入れると `applyBlocks` の
      //    差分が「知らない子」として消す(そして次の描画で戻るので点滅する)
      this.noticeSlot = document.createElement('div');
      this.noticeSlot.setAttribute('data-pkc-field', 'detail-notice-slot');
      this.bodyHost = document.createElement('div');
      this.bodyHost.setAttribute('data-pkc-field', 'detail-body-host');
      this.region.append(
        this.titleEl,
        this.barSlot,
        this.panelSlot,
        this.noticeSlot,
        this.bodyHost,
      );
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
      /**
       * 🔴 **器は残す**(2026-08-07)。ここで空にしていたので、ノートを選んだ直後
       * ── 本文が worker から届くまでのあいだ ── 「編集」が**DOM に存在しない**
       * 窓が空いていた。押しても binder が黙って捨てるので、user から見ると
       * 「クリックが効かない」。いまは器を残して押せない状態にする。
       */
      this.renderBar(state, false);
      this.renderPanel(state, lid);
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

    this.renderBar(state, true);
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
      this.renderAttachment(body, fm.body, lid);
      this.restoreScroll();
      return;
    }
    /**
     * 🔴 **面ごとに違う見え方にしない**(2026-08-06。user 報告 2-6)。
     *
     * 直す前はここだけ `hasMarkdownSyntax` で門を作り、記法を 1 つも含まない本文を
     * `<pre>` 等幅に落としていた ── **編集プレビューと書き出しは markdown で描く**
     * ので、同じ本文が面によって別物に見えた(しかも `<pre>` は折り返さないので
     * **横にはみ出す**)。PKC3 の founding は「**全 body = PKC-Markdown**」なので、
     * 記法が無い本文も markdown として描くのが正しい。
     * ⚠ 改行は失われない ── `markdown-it` を `breaks: true` で使っているので
     *   1 個の改行が `<br>` になる(実測で確認)。
     * ⚠ `hasMarkdownSyntax` 自体は残す(golden の契約 ── 判定を消したのではなく、
     *   **描き方を分けるのに使わなくした**)。
     */
    {
      if (this.bodyKind !== 'md') {
        this.bodyKind = 'md';
        this.bodyView = EMPTY_VIEW;
        this.bodyHost!.textContent = '';
        this.bodyHost!.className = 'pkc-md-rendered';
        this.bodyHost!.setAttribute('data-pkc-field', 'detail-body');
      }
      const opts = {
        vars: extractVars(body),
        sourceLineAnchors: true,
        // heading-number は text レベル前処理(LineMap 不変)── 全文 body から抽出
        headingNumber: extractHeadingNumberConfig(body),
        /**
         * 外部画像(2026-08-06、user 裁定)。⚠ **ノートごと**に決まる ──
         * 「常に確認」で押した同意はこのノートにだけ効く。
         * ⚠ 本文の画像と箱の CSP は**同じ値**で動く(片方だけ開けない)。
         */
        allowExternalImages: this.externalImages.allows(lid),
      };
      /**
       * 🔴 **読む面もワーカーで描く**(2026-08-06。user 報告 2-8)。
       *
       * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください」
       *
       * 直す前はここが**メインスレッドで同期**に描いていた ── 300 節のノートで
       * long task **181〜190ms**(実測)。編集プレビューだけワーカーに逃がしていて、
       * **いちばん長く見ている面**が残っていた。
       * ⚠ **最新だけ載せる**(選択が動いたら古い結果は捨てる)── `viewToken` で弁別。
       * ⚠ 失敗したら**その場で描く**(ワーカーは速さの話であって正しさの話ではない)。
       * ⚠ 前の本文は**消さない**まま待つ ── `applyBlocks` は結果が来てから当てるので、
       *   選択の瞬間に白くならない。
       */
      const token = ++this.viewToken;
      /**
       * ⚠ 当てていいかの判定は **世代 + 器の同一性**の 2 つ。
       * `isConnected` は使わない ── 器が document に繋がる前に描く経路
       * (骨組みを組んでから親へ入れる / test)を黙って落とす。
       */
      const host = this.bodyHost!;
      const paint = (html: string): void => {
        if (token !== this.viewToken) return; // もっと新しい選択が来ている
        // ⚠ `bodyKind` の側は**等価な変異**(器を捨てるときは `bodyHost` も null に
        //    なるので、同一性の門だけで全部止まる)。読みやすさのために残している
        //    ── test で殺せないことを承知の上(変異試験 R16)
        if (this.bodyKind !== 'md' || this.bodyHost !== host) return; // 器が作り直された
        // 🔑 **変わった塊だけ**当てる(P8 段⑩⑪)── scroll も図も生き残る
        const applied = applyBlocks(host, html, this.bodyView);
        this.bodyView = applied.view;
        // writing / direction / align / layout の属性契約(dir 込みで 1 箇所)
        applyDocumentGlobals(host, extractDocumentGlobals(body));
        // ⚠ 面倒を見るのは**新しく入った所だけ**(全体に掛け直すと、生きている
        //    `<img>` の ObjectURL を revoke してしまう)
        if (applied.inserted.length > 0) {
          void this.hydrateAssetRefs(applied.inserted, this.hydrateToken);
          this.mermaidScopes.push(hydrateMermaid(applied.inserted));
        }
        // 🔴 **差し替えで画面から消えた `<img>` のぶんを返す**(P8 段⑲)。
        //    ⚠ `inserted.length > 0` の中に入れてはいけない ── 塊が**消えるだけ**
        //    (差し替えではなく削除)のときは inserted が空で、そこが一番溜まる
        // 🔴 図の側も同じ(P8 段㉗)── 段⑲ で `pruneLends` をここへ出しておきながら、
        //    **1 行上の `pruneScopes` は `if` の中に残していた**。図の塊を消すだけの
        //    編集(図を削る)では inserted が空なので、その図の ObjectURL は
        //    次に何かが挿入されるまで返らない。同じ穴を隣同士で片方だけ塞いでいた。
        pruneScopes(this.mermaidScopes);
        this.pruneLends();
        // ⚠ 帯は**本文が入ってから**組む(数えるものが DOM に無いと 0 件になる)
        this.renderExternalImageBar(lid, host);
        this.restoreScroll();
      };
      void this.markdown
        .render(fm.body, opts)
        .then(paint)
        .catch(() => paint(renderMarkdown(fm.body, opts)));
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

  /**
   * 本文の上の操作。
   *
   * 🔴 **器を捨てない。値だけ差し替える**(2026-08-07)。
   *
   * 直す前はここが毎回 `slot.textContent = ''` から組み直していた ──
   * `inspector.ts` が 2026-08-06 に直したのと**同じ罠の、対称の反対側**である
   * (CLAUDE.md「片側を直したら対称の反対側を必ず疑う」)。実害:
   *
   * - 保存すると storage worker の ack が遅れて届き、`REVISION_LIST_LOADED` /
   *   `ENTRY_RESTORED` が非同期に `renderView` を呼ぶ
   * - その瞬間「編集」が**別の node** になる。描いている絵は 1 ドットも変わらない
   *   (`iconButton('start-edit','編集')` は定数)
   * - binder は `root.contains(el)` を通らない target を黙って捨てるので、
   *   保存直後に押すと **無言の dead click**
   *
   * ⚠ **本文待ちのあいだも器を残す**。かつては `body === null` の枝で
   * `barSlot.textContent=''` していたので、ノートを選んだ直後は「編集」が
   * **DOM に存在しない**窓が空いていた(遅い機械 / 大きい本文ほど広い)。
   * いまは器を残して `disabled` にする ── **無言の操作拒否を作らない**ので、
   * 押せない理由は `title` に書く。
   *
   * 🔑 器を組み直すのは**形が変わるときだけ**(編集 / 再保存 / 無し の 3 形)。
   */
  private renderBar(state: AppState, bodyReady: boolean): void {
    const slot = this.barSlot!;
    // error phase では「編集」を出さない ── START_EDIT は ready 限定なので、
    // 出したまま無言 no-op にしない(review B-1 原則: 無言の操作拒否を作らない)
    const shape: BarShape =
      state.phase === 'ready'
        ? 'edit'
        : state.phase === 'error' &&
            state.openBody &&
            state.openBody.baseline !== state.openBody.persisted &&
            !state.openBody.diskAhead
          ? 'retry'
          : 'none';
    if (shape !== this.barShape) {
      this.barShape = shape;
      this.barButton = null;
      slot.textContent = '';
      if (shape !== 'none') {
        const bar = document.createElement('div');
        bar.setAttribute('data-pkc-field', 'detail-toolbar');
        if (shape === 'edit') {
          // 🔑 **ここには「編集」とコピーだけ**(P8 / 2026-08-08)。書き出す / 履歴 /
          // 削除は右の情報ペインが持つ ── 同じボタンを 2 か所に出すと、押す場所が
          // 定まらない(コピーはここ**だけ**に在る)。
          // 🔑 **追記もここに無い**(P8 段⑧)── 編集画面を通らない別の器が持つ
          this.barButton = iconButton('start-edit', '編集');
          /**
           * 🔴 **コピーの 2 系統 + 選択範囲**(2026-08-08。user 裁定「markdown の
           * テキストとしてのコピーと HTML 書式ありのコピーの両方」)。
           * 受け手は binder(`copy-note-md` / `copy-note-rich` / `copy-selection-md`)。
           * ⚠ 選択範囲は**選択があるときだけ活性**── 選択は state に無い
           * (DOM の selection)ので、`selectionchange` が `syncCopySelection` で
           * 同期する(render の指紋は選択では動かない)。
           */
          const md = iconButton('copy-note-md', 'Markdown をコピー');
          md.title = '本文の原文(Markdown)をそのままコピーします';
          const rich = iconButton('copy-note-rich', '書式付きでコピー');
          rich.title = '見た目(HTML 書式)ごとコピーします。Word などに貼れます';
          const sel = iconButton('copy-selection-md', '選択範囲をコピー');
          sel.title = '本文の中を選択すると押せます(選択した範囲を Markdown の原文でコピー)';
          sel.disabled = true;
          this.barCopy = { md, rich, sel };
          bar.append(this.barButton, md, rich, sel);
        } else {
          // 保存失敗からの復帰導線: baseline ≠ persisted =「disk に未達の commit が
          // ある」証拠(P3-5 の分離の回収点)。黙って死なせず再送を提示する
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.setAttribute('data-pkc-action', 'retry-persist');
          retry.textContent = '再保存';
          this.barButton = retry;
          bar.append(this.barButton);
        }
        slot.append(bar);
      }
    }
    // ⚠ 形が同じなら node は使い回し、**状態だけ**当てる
    if (this.barShape === 'edit' && this.barButton) {
      this.barButton.disabled = !bodyReady;
      this.barButton.title = bodyReady ? '' : '本文を読み込んでいます…';
    }
    if (this.barShape === 'edit' && this.barCopy) {
      this.barCopy.md.disabled = !bodyReady;
      this.barCopy.rich.disabled = !bodyReady;
      this.syncCopySelection();
    }
  }

  /**
   * 選択範囲コピーの活性(2026-08-08)。選択は state に無いので、
   * `selectionchange`(constructor で document に 1 本)とバーの描き直しの
   * 両方からここへ来る。⚠ **判定は `hasSourceSelection` の 1 本** ──
   * binder 側の `selectedMarkdown` と同じ端点の規則を使う(規則を 2 つ書かない)。
   */
  private syncCopySelection(): void {
    const btn = this.barCopy?.sel;
    if (!btn || !btn.isConnected) return;
    const usable =
      this.mode === 'view' &&
      this.lastBody !== null &&
      this.bodyHost !== null &&
      hasSourceSelection(this.bodyHost);
    btn.disabled = !usable;
  }

  /**
   * 外部画像の確認の帯(2026-08-06、user 裁定)。
   *
   * 出す条件は **「設定が『常に確認』」+「このノートはまだ答えていない」+
   * 「実際に止まっているものが 1 件以上」** の 3 つ。
   * ⚠ 3 つ目が要る ── 外部画像を 1 枚も持たないノートで帯を出すと、
   *   ほぼ全部のノートで出ることになり、user は中身を読まずに押すようになる。
   * ⚠ 本文の画像は DOM から数える(描いた結果が正)。箱の中は静的に読めないので
   *   **箱からの申告**を使う(`noteBlockedBox`)。
   */
  private renderExternalImageBar(lid: string, host: HTMLElement): void {
    const slot = this.noticeSlot;
    if (!slot) return;
    slot.textContent = '';
    if (!this.externalImages.unanswered(lid)) return;
    const images = host.querySelectorAll(`[${EXTERNAL_IMAGE_ATTR}]`).length;
    const boxes = this.externalImages.blockedBoxCount(lid);
    if (images === 0 && boxes === 0) return;
    slot.append(buildExternalImageBar(images, boxes));
  }

  /**
   * 箱が「画像を止めた」と申告してきた ── 帯を出し直す。
   * ⚠ **描き直さない**(帯だけ組む)── 箱を作り直すと中身が一度消える。
   */
  noteBlockedBox(lid: string, blocked: number): void {
    if (!this.externalImages.noteBlockedBox(lid, blocked)) return;
    if (this.mode !== 'view' || this.skeletonLid !== lid || !this.bodyHost) return;
    this.renderExternalImageBar(lid, this.bodyHost);
  }

  /**
   * 履歴のパネル。
   *
   * 🔴 **中身が同じなら触らない**(2026-08-07)。直す前は `renderView` が走るたび
   * 無条件に `slot.textContent = ''` していたので、**履歴を開いている最中に
   * 無関係な再描画が 1 回でも入ると「この版に戻す」が全部別の node になっていた**
   * ── そこは user がまさに押そうとしている場所である。
   * ⚠ `revisionPanel` は state が差し替わっても**参照が同じなら中身も同じ**
   * (`app-state.ts` は作り直すときだけ新しい object を置く)。
   */
  private renderPanel(state: AppState, lid: string): void {
    const slot = this.panelSlot!;
    const shown =
      state.phase === 'ready' && state.revisionPanel && state.revisionPanel.lid === lid
        ? state.revisionPanel
        : null;
    if (shown === this.shownPanel) return;
    this.shownPanel = shown;
    slot.textContent = '';
    if (shown) slot.append(renderHistoryPanel(shown.items));
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
    /**
     * 🔴 **ライブエディタ(行の入れ替え)**(2026-08-05。ライブエディタ S5。
     * 設計 doc `live-editor-design-2026-08.md`)。
     *
     * 既定は今日の 2 列(原文 | プレビュー)。flag `editor.live` で**1 面**に畳む
     * ── 画面は常に描画済み文書で、クリックした行だけが原文の入力欄になる。
     * ⚠ 既定 OFF は user 裁定(設計 §9 論点 C ── 塊を跨ぐ Ctrl+Z が入るまで開けない)。
     * 🔴 **flag である**(2026-08-07 に `?pkc-live=1` から昇格。user 指示
     *   「URL クエリパラメータ切り替えはフラグ扱いである / クエリパラメータを
     *   抜け穴にしてはいけない」)── 15 枠に数え、`foldWhen` を宣言し、
     *   フラグ画面に出る。⚠ 「計測用だから枠を食わない」は禁じ手である。
     */
    /**
     * プレビューに渡す既定(2026-08-06)。
     * ⚠ **外部画像の許可は読む面と同じ値**(`allows(lid)`)── 編集中だけ
     *   開いたり閉じたりすると、書いている最中と保存後で見え方が食い違う。
     * ⚠ このノートの分だけ。編集セッション中は変わらない(設定変更は同意を捨てる)。
     */
    const previewOpts = {
      sourceLineAnchors: false,
      allowExternalImages: this.externalImages.allows(open.lid),
    };
    if (liveEditorEnabled()) {
      this.renderLiveEditor(open.body, previewOpts);
      return;
    }
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
        /**
         * 🔴 **プレビューにも文書 globals を当てる**(2026-08-06)。
         * 直す前は `applyDocumentGlobals` の呼び出しが読む面の 1 か所だけで、
         * ここと live editor には `dir` も `data-pkc-doc-align` も付かなかった ──
         * `align: right` / `writing: vertical` / `direction: rtl` を書いた文書で
         * **編集中と保存後の見え方が食い違う**(書いている最中は効いていない)。
         * ⚠ 材料は **`ta.value`(frontmatter 込み)** ── 描くのに渡しているのは
         *   frontmatter を剥がした側なので、そちらからでは globals が見えない。
         */
        applyDocumentGlobals(preview, extractDocumentGlobals(ta.value));
        // 🔑 **新しく入った所だけ**図を面倒みる(触っていない図はそのまま)
        if (applied.inserted.length > 0) scopes.push(hydrateMermaid(applied.inserted));
        // 🔴 **積もらせない**(P8 段⑰。レビュー H-5)── 静穏 tick ごとに塊が
        //    増え、画面に無い PNG の URL と観測器が編集中ずっと生きていた
        //    (実測: 5 tick で createObjectURL 5 / revokeObjectURL 0)
        // ⚠ `inserted.length > 0` の**外**で呼ぶ(段㉗)── 図を削る編集では
        //    inserted が空になり、消えた図の URL が返らないまま残る
        pruneScopes(scopes);
      },
      (e) => {
        // 🔴 **白紙にしない**。理由を出して原文だけは読めるようにする
        if (!preview.isConnected) return;
        preview.textContent = `プレビューを描けませんでした: ${String(e).slice(0, 120)}`;
      },
    );
    // 編集に入った直後は待たせない(**その場で 1 回**)
    follow.push(parseFrontmatter(ta.value).body, previewOpts);
    follow.flush();
    ta.addEventListener('input', () => {
      // ⚠ rAF で畳まない ── 畳み込みは follower(静穏 + 上限)が持つ。
      //    2 か所で畳むと、どちらが効いているか分からなくなる
      follow.push(parseFrontmatter(ta.value).body, previewOpts);
    });
    // ⚠ 編集を抜けるときに予約と図を畳む(detached なノードへ描かない)
    this.cancelPreview = () => {
      follow.dispose();
      for (const sc of scopes.splice(0)) sc.dispose();
    };
    ta.focus();
  }

  /**
   * 🔴 **1 面のライブエディタ**(S5)。
   *
   * - 画面は**常に描画済み文書**。クリックした所を含む最小の刻印要素だけが
   *   原文の入力欄になる(`RowSwap`)
   * - **打鍵ではレンダリングを 1 回も起こさない**。確定(その行から出た瞬間)に
   *   1 回だけ描いて、その塊にパッチを当てる
   * - 描くのは**ワーカー**(不可侵指示)。行の対応表も一緒に受ける
   *
   * ⚠ 原文の正本は `AppState.openBody.body`。ここが持つのは「窓」で、
   * 継ぎ足した本文は `onBodyChange` で外へ返す(dispatch はしない ── 層規約)。
   */
  private renderLiveEditor(
    initialBody: string,
    /** ⚠ 読む面と同じ値を渡す(`renderEditor` が 1 か所で決める)。 */
    previewOpts: { sourceLineAnchors: boolean; allowExternalImages: boolean },
  ): void {
    const pane = document.createElement('div');
    pane.setAttribute('data-pkc-region', 'editor-live');
    pane.className = 'pkc-md-rendered';
    /** お知らせの行。⚠ **参照で持つ**(querySelector で探すと、退避で作り直した
     *  ときに別のものを掴む ── 実際にそう外した)。 */
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'row-note');
    /**
     * 🔴 **全文編集の可視の導線**(2026-08-08。user 裁定「一旦全てプレーン
     * テキストにして編集」)。機構は S6 の `Ctrl+A` と**同じ口**(`activateAll`)──
     * キーを知らない人にもマウスだけで届くようにする(業務画面の作法)。
     * ⚠ binder を通さず直接配線する ── この面の中の口(`RowSwap`)を呼ぶだけで、
     * dispatch する action が無い。
     */
    const tools = document.createElement('div');
    tools.setAttribute('data-pkc-field', 'live-tools');
    const editAll = document.createElement('button');
    editAll.type = 'button';
    editAll.setAttribute('data-pkc-field', 'edit-all');
    editAll.textContent = '全文を編集';
    editAll.title = '本文全体を 1 つの入力欄で編集します(Ctrl+A と同じ)';
    tools.append(editAll);
    this.region.append(tools, pane, note);

    let body = initialBody;
    const scopes: MermaidScope[] = [];
    /** 塊を跨ぐ取り消しの履歴(S8)。⚠ 行の配列なので 1 件は小さい。 */
    let journal = EMPTY_JOURNAL;

    /** 本文を差し替えて描き直す(外へも知らせる)。⚠ **出口は 1 つ**にする。 */
    const setBody = (next: string): void => {
      body = next;
      this.onBodyChange?.(next);
      follow.push(body, previewOpts);
      follow.flush(); // 🔑 確定は**待たせない**(打鍵では 1 回も描かない代わり)
    };

    const swap = new RowSwap(pane, {
      commit: (startLine, endLine, text) => {
        // ⚠ 継ぎ足しの規則は `edit-journal.ts` の 1 か所(取り消しと同じ規則を使う)
        journal = record(journal, stepFor(body, startLine, endLine, text));
        // ⚠ 「変わったか」は `RowSwap` が持っている(開いた時の原文と比べる)──
        //    ここに 2 本目の判定を置かない
        setBody(spliceLines(body, startLine, endLine, text));
      },
      notify: (message) => {
        note.textContent = message;
      },
    });
    editAll.addEventListener('click', () => {
      if (!swap.activateAll()) note.textContent = 'この本文は全文編集に開けません';
    });

    /**
     * 🔴 **塊を跨ぐ Ctrl+Z / Ctrl+Shift+Z(Ctrl+Y)**(S8。設計 §9 論点 C の
     * 「既定 ON の条件」)。
     *
     * ⚠ **行の中では奪わない** ── 入力欄が焦点を持っている間はブラウザ自前の
     * 取り消し(打鍵 1 つずつ)が正しい。境目は「入力欄に居るかどうか」1 つだけ。
     * ⚠ 焦点が本文の外(`<body>`)に在る状態で来るので、`document` で聴く。
     *   面を畳むときに必ず外す(`cancelPreview`)。
     * ⚠ 戻せないときは**無言で無視しない**(押したのに何も起きない理由を出す)。
     */
    /**
     * 分割が組めない本文で編集させないための退避(1 回だけ作る)。
     * ⚠ 宣言が `onKey` より前に在るのは、`Ctrl+A` の側でも見るため(下記)。
     */
    let fellBack = false;
    const onKey = (ev: KeyboardEvent): void => {
      if (!pane.isConnected) return;
      const t = ev.target;
      if (t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      /**
       * ⚠ **この面のための打鍵か**を確かめる。`document` で聴いているので、
       * 左の列のボタンに焦点が在るときの `Ctrl+A` / `Ctrl+Z` まで奪ってしまう
       * ── 確定の直後は焦点が `<body>` に戻っているので、そこと面の中だけを見る。
       */
      if (!(t === document.body || (t instanceof Node && pane.contains(t)))) return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const key = ev.key.toLowerCase();
      /**
       * 🔴 **Ctrl+A で全文を 1 つの入力欄にする**(S6)── これで今日の 2 列の
       * 編集画面が 1 面の**縮退形**になる(別物の画面を 2 つ持たない)。
       * ⚠ 境目は取り消しと**同じ 1 判定**(入力欄に居るかどうか)── 行の中の
       * Ctrl+A はその行を選ぶブラウザ既定のままにする。
       */
      if (key === 'a') {
        ev.preventDefault();
        /**
         * ⚠ **退避したら Ctrl+A も塞ぐ**(2026-08-08 の 2 巡目レビュー)。
         * ボタン(`editAll.disabled`)だけ塞いで**同じことをする双子**を塞いで
         * いなかった ── `swap.dispose()` は listener と active を落とすだけで
         * `view` / `body` を残すので `activateAll()` は**まだ呼べてしまい**、
         * 退避用の入力欄が入っている pane を上書きする。
         * 🔑 断り文は**ボタンに書いたものと同じ言葉**にする(押した場所が違っても
         * 同じ理由なら同じ言い方 ── 言い換えると user は別のものを探す)。
         */
        if (fellBack) {
          note.textContent = 'すでに原文全体を編集しています';
          return;
        }
        if (!swap.activateAll()) note.textContent = 'この本文は全文編集に開けません';
        return;
      }
      const forward = key === 'y' || (key === 'z' && ev.shiftKey);
      if (key !== 'z' && key !== 'y') return;
      ev.preventDefault();
      /**
       * 🔴 **退避したら取り消しも塞ぐ**(2026-08-08 の 3 巡目レビュー。**4 件目の双子**)。
       * ⚠ ここは Ctrl+A より**実害が大きい** ── 退避先は原文をそのまま編集する面で、
       *   follower が `fellBack` で描き直さない。そこで journal を当てると
       *   **`body`(= 保存される値)だけが動いて、画面の入力欄は前のまま**になる。
       *   そのまま保存すると **user が見ていない本文が保存される**(1 文字打てば
       *   `body = ta.value` で戻るが、打たずに保存すると気づけない)。
       * 🔑 退避先の取り消しは**ブラウザ自前**(textarea の履歴)に任せる ── 面が
       *   1 つの入力欄なので、それで筋が通る。
       */
      if (fellBack) {
        note.textContent = 'すでに原文全体を編集しています';
        return;
      }
      const moved = forward ? redo(journal, body) : undo(journal, body);
      if (moved === null) {
        note.textContent = forward ? 'やり直せる編集はありません' : '取り消せる編集はありません';
        return;
      }
      journal = moved.journal;
      setBody(moved.text);
      note.textContent = forward ? '1 つやり直しました' : '1 つ取り消しました';
    };
    document.addEventListener('keydown', onKey);

    const fallBack = (reason: string): void => {
      if (fellBack) return;
      fellBack = true;
      swap.dispose();
      pane.textContent = '';
      const ta = document.createElement('textarea');
      ta.setAttribute('data-pkc-field', 'editor-body');
      ta.value = body;
      ta.addEventListener('input', () => {
        // ⚠ 退避先では**描き直さない**(原文をそのまま編集している面なので)
        body = ta.value;
        this.onBodyChange?.(body);
      });
      note.textContent = `この本文は行ごとに編集できません(${reason})── 原文で編集します`;
      pane.append(ta);
      // 退避先は**すでに原文全体**の編集 ── 押せない理由ごと可視にする
      editAll.disabled = true;
      editAll.title = 'すでに原文全体を編集しています';
    };

    const follow = this.markdown.follower<RenderedWithRanges>(
      ({ html, ranges }) => {
        if (!pane.isConnected || fellBack) return;
        const r = swap.update(body, html, ranges);
        if (!r.ok) {
          // 🔴 **壊れた分割の上で編集させない**(設計 §7-9)── 今日の編集画面へ退避
          fallBack(r.reason ?? '');
          return;
        }
        // 図の面倒は**新しく入った所だけ**(既存の規律と同じ ── 生きた `<img>` の
        // ObjectURL を revoke しない)
        if (r.inserted.length > 0) scopes.push(hydrateMermaid(r.inserted));
        pruneScopes(scopes);
        // 文書 globals(書字方向・既定の寄せ)── 読む面と同じ見え方にする。
        // ⚠ この面は本文をそのまま(frontmatter 込みで)描くので `body` から取る
        applyDocumentGlobals(pane, extractDocumentGlobals(body));
      },
      (e) => {
        if (!pane.isConnected) return;
        note.textContent = `描けませんでした: ${String(e).slice(0, 120)}`;
      },
      { withRanges: true },
    );

    follow.push(body, previewOpts);
    follow.flush();

    this.cancelPreview = () => {
      document.removeEventListener('keydown', onKey);
      follow.dispose();
      swap.dispose();
      for (const sc of scopes.splice(0)) sc.dispose();
    };
  }

  /** attachment フレーバーの view(P4a): メタ + preview + 説明 markdown。 */
  private renderAttachment(
    rawBody: string,
    description: string,
    /** ⚠ **説明文も本文** ── 外部画像の扱いを本文と揃えるのに要る(2026-08-06)。 */
    lid: string,
  ): void {
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
      // 🔴 **本文から参照するための導線**(P8 段⑱。レビュー H)。
      //    マニュアル §3 は `asset:<key>` を「書ける形式」として説明しているのに、
      //    **本文へ入れる経路も key を見る経路も無かった** ── 書けるのに書けない、
      //    という状態だった。ここでコピーして貼れるようにする。
      //    ⚠ 渡すのは**貼れる 1 行そのもの**(裸の `asset:<key>` ではない)──
      //    裸の key は markdown としてはただの文字列で、貼っても何も出ない。
      //    組み立ては `features/asset/asset-ref-format.ts` の 1 本(書出しと同規則)
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.setAttribute('data-pkc-action', 'copy-asset-ref');
      copy.setAttribute('data-pkc-field', 'copy-asset-ref');
      copy.setAttribute('data-pkc-asset-key', meta.assetKey);
      copy.setAttribute(
        'data-pkc-asset-ref',
        formatAssetRef(meta.name || '', `asset:${meta.assetKey}`, isImageAssetMime(meta.mime)),
      );
      copy.title = '本文に貼ると、この添付がそこに出ます';
      copy.textContent = '参照をコピー';
      info.append(copy);
      /**
       * 🔴 **詳細画面から起動する**(P10、user 指示 2026-08-05
       * 「HTML アセットの詳細画面から起動できない」)。
       *
       * 直す前は添付の詳細に起動の導線が**1 つも無かった**(ダウンロード /
       * 参照をコピー / アプリとして登録 だけ)。`text/html` は preview も
       * 「preview 無し」に落ちるので、**詳細から中身に触る方法が無かった**。
       * ⚠ 「アプリとして登録」は**要らない** ── 登録はランチャーに並べる設定で、
       *   開けることとは別である。
       */
      if (isAppMime(meta.mime)) {
        const run = iconButton('launch-asset', '起動', 'launch-asset');
        run.title = '囲いの中で開きます(PKC3 の中身には触れません)';
        info.append(run);
        /**
         * 🔴 **素のまま(同一オリジン)で開く**(P10)。ここだけに置く ──
         * タイルは一覧から 1 クリックで押せる場所なので、素のままの判断は
         * **対象の素性が見えている画面**からだけ入れる。
         * ⚠ 押すと確認が出る。許可は**保存しない**(素のままのアプリは
         *   保存領域に手が届くので、自分の許可記録を自分で書ける)。
         * 設計: `docs/development/p10-launcher-same-origin-2026-08.md`
         */
        const rawRun = iconButton('launch-asset-raw', '素のまま起動', 'launch-asset-raw');
        rawRun.title =
          'PKC3 と同じ場所で開きます。IndexedDB や cookie を使うアプリが動きますが、このアプリは PKC3 の中身にも手が届きます';
        info.append(rawRun);
      }
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
      desc.innerHTML = renderMarkdown(description, {
        sourceLineAnchors: true,
        // ⚠ 添付の説明も本文と同じ扱い ── ここだけ素通りすると、説明に書いた
        //    追跡画像が設定を無視して飛ぶ(面ごとに違う扱いにしない)
        allowExternalImages: this.externalImages.allows(lid),
      });
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
          this.lends.push({ dispose: lent.dispose, els: imgs });
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
      if (!kind) {
        /**
         * 🔴 **出せないことを言う**(2026-08-06。user 報告 minor
         * 「preview を持たない添付は何も出ない」)。
         *
         * 直す前はここが黙って `return` で、器が**空のまま**残っていた ──
         * 画面には題名と操作だけが並び、**中身が空なのか出せないのかが
         * 区別できなかった**(「壊れている」と読まれる)。
         * ⚠ 次にどうすればよいかを書く ── この種類は上の**ダウンロード**で開く。
         * ⚠ `isAppMime`(HTML)はここへ来る ── そちらは**起動**があるので言い方を分ける。
         */
        const p = document.createElement('p');
        p.setAttribute('data-pkc-field', 'attachment-no-preview');
        p.textContent = isAppMime(mime)
          ? 'この種類は画面に出せません。上の「起動」で開けます(ダウンロードしても開けます)'
          : 'この種類は画面に出せません。上の「ダウンロード」で保存して開いてください';
        host.append(p);
        return;
      }
      const lent = await assets.lend(assetKey);
      if (token !== this.hydrateToken) {
        lent?.dispose(); // stale ── 借りた瞬間に返す
        return;
      }
      if (!lent) return missing();
      // 添付の preview は器ごと作り直す(`disposeLends()` が先に走る)ので、
      // 器そのものを持たせておけば「器が外れたら返す」で同じ規則に乗る
      this.lends.push({ dispose: lent.dispose, els: [host] });
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
