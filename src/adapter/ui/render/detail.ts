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
import { renderFenceFromAsset, renderMarkdown } from '@features/markdown/markdown-render';
import {
  frontmatterLineCount,
  bodyBelowFrontmatter,
  frontmatterProblem,
  parseFrontmatter,
  extractVars,
} from '@features/markdown/frontmatter';
import { hydrateMermaid, type MermaidScope } from './mermaid-hydrate';
import { markViewBig } from './view-big';
import { hydrateChart } from './chart-raster';
import { readFenceAssetText } from '@features/asset/fence-asset-read';
import { applyHeadingFold } from './heading-fold';
import { applyPlaceLayout } from './place-board';

/**
 * 🔴 **図とグラフは同じ面に出る**(#188)── 器を埋める呼び出しを 1 つに束ねる。
 * ⚠ 片方だけ呼ぶ面が生まれると、その面でだけグラフが空のままになる
 *   (2026-08 に mermaid で実際に起きた「器が空のまま残る」の再演)。
 */
function hydrateFigures(root: ParentNode | readonly ParentNode[]): MermaidScope[] {
  return [hydrateMermaid(root), hydrateChart(root)];
}
import { applyBlocks, EMPTY_VIEW, type BlockView } from './apply-blocks';
import { RowSwap } from './row-swap';
import { diffCounts, diffRows, type DiffRow } from '@features/revision/diff-view';
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
import {
  EXTERNAL_IMAGE_ATTR,
  sandboxBlockedKind,
  sandboxBlockedNote,
  type SandboxBlockedKind,
} from '@features/markdown/external-images';
import { MarkdownClient } from '@adapter/platform/render/markdown-client';
import {
  extractDocumentGlobals,
  extractHeadingNumberConfig,
  applyDocumentGlobals,
} from '@features/markdown/document-globals';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { isAppMime } from '@features/launcher/tiles';
import { buildOfficeEntry } from './office-entry-view';
import { formatAssetRef, isImageAssetMime } from '@features/asset/asset-ref-format';
import {
  assetPreviewKind,
  canOpenAssetWindow,
  BODY_MEDIA_FIELD,
  BODY_MEDIA_CLASS,
} from '@features/asset/asset-preview-kind';
import type { AppState, AppPhase } from '@adapter/state/app-state';
import { appEditorMode } from './editor-mode';
import { appKeymap, type KeymapStore } from './keymap';
import {
  appExtensionGrants,
  type ExtensionGrants,
} from '@adapter/platform/extension-grants';
import { HINT_BASE, HINT_COMMAND, hintTitle } from './shortcut-hint';
import { humanBytes } from '@features/human-bytes';

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
 * 来歴: `?pkc-live=1`(URL のみ)→ flag `editor.live`(2026-08-07、
 * 「クエリパラメータを抜け穴にしてはいけない」)→ **正規設定 `pkc3.editor-mode`**
 * (2026-08-14。user 裁定 2026-08-08「既定でONかつ設定で2ペイン編集は
 * できるようにする」── #104 第 2 弾)。🔴 **既定は live**。2 ペインは設定から選ぶ。
 * ⚠ 切替が効くのは**次に編集を開いたとき**(編集の面は入りで 1 度だけ組む)。
 */
export function liveEditorEnabled(): boolean {
  return appEditorMode.getMode() === 'live';
}

/**
 * 🔴 **同じ理由は同じ言葉で断る**(4 巡目レビュー R3)。3 か所(Ctrl+A / Ctrl+Z /
 * ボタンの title)が同じ文言を持っており、等値 pin は 2 か所しか突き合わせていなかった
 * ── 3 か所目だけ言い回しを変える変異が生き延びる。**実体を 1 つにして構造で守る。**
 * ⚠ 押した場所が違っても理由が同じなら言い方も同じにする(言い換えると user は
 *   別のものを探す)。
 */
const ALREADY_WHOLE_NOTE = 'すでに原文全体を編集しています';

/**
 * 🔴 **いま開いているコンテナの id を、描画へ渡す**(2026-08-08。Issue #100 段①)。
 *
 * markdown は `pkc://<cid>/entry/<lid>` を **`cid` が自分と一致したときだけ**
 * `navigate-entry-ref` に焼く。渡していなかったので既定 `''` で必ず不一致になり、
 * #97 で戻した受け手が**1 度も呼ばれなかった**(押しても無言 ── 押せない
 * placeholder badge に見えるだけ)。
 *
 * ⚠ **未 boot(`null`)は空文字**へ落とす ── 「分からないなら外と見なす」が
 *   安全側(`markdown-render.ts` の枝と同じ判断)。ここで `'default'` のような
 *   既定値を作らない(嘘の一致を生む)。
 * 🔑 **1 か所で決める** ── 面ごとに `state.cid ?? ''` を書くと、片方だけ
 *   書き換える変異が「もう片方は正しい」ので気づかれにくい。
 */
function selfContainerId(state: AppState): string {
  return state.cid ?? '';
}

/**
 * 🔴 **「この lid の本文が描けた」印**(#517)。本文の器に付く。
 * ⚠ 綴りを写さない ── 待つ側(`binder.ts` の目次)はここを引く(§7)。
 */
export const PAINTED_ATTR = 'data-pkc-painted';

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
    (this.markOn ?? this.region).setAttribute('data-pkc-detail-mode', m);
  }
  private lastSelected: string | null = null;
  /** view で最後に描いた body(null = openBody 不在の loading 表示)。 */
  private lastBody: string | null = null;
  /** phase は toolbar の有無を変える(error では編集ボタンを出さない)。 */
  private lastPhase: AppPhase | null = null;
  /** 履歴 panel の断面(参照比較 ── P5b で view 指紋に加わった次元)。 */
  private lastPanel: AppState['revisionPanel'] = null;
  /** 見ている版(#398 段②)。⚠ **指紋の一部**(上の注記)。 */
  private lastPreview: AppState['revisionPreview'] = null;
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
  /**
   * 借りている ObjectURL。⚠ `key` を持つのは**借り直しを避ける**ため(#250)──
   * 編集中は塊が打鍵ごとに作り直されるので、同じ添付を tick ごとに IDB から
   * 読み直して URL を作り足すことになる(user 指示「効くのは定常」)。
   */
  private readonly lends: Array<{
    key: string | null;
    url: string | null;
    dispose: () => void;
    els: Element[];
  }> = [];
  /** 非同期 hydrate の stale 防止(選択が移ったら結果を捨てて即 dispose)。 */
  private hydrateToken = 0;
  /**
   * 🔴 **囲みが読み込んだ添付の字**(#444 段①)。
   *
   * ⚠ 憶えないと、打鍵のたびに塊が作り直されるので **1 打鍵ごとに IDB を読む**。
   * ⚠ **ノートが変わったら捨てる**(`hydrateToken` を進める所で一緒に消す)──
   *   残すと、別のノートの字を握ったまま常駐する(2026-07-27「速やかな破棄」)。
   */
  private fenceTexts = new Map<string, string>();

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
  /**
   * 🔴 **箱の中で止まった「画像以外」の種別**(#528 段③)。lid ごとに畳む。
   * ⚠ **同意とは別物**(あちらは開けられる / こちらは開けられない)なので、
   *   `externalImages` に混ぜない ── 混ぜると「答えたら消える」形に引き寄せられる。
   */
  private readonly blockedKinds = new Map<string, Set<SandboxBlockedKind>>();
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
  private parkedScroll: { lid: string; top: number; left: number } | null = null;
  /**
   * 骨組みを組み直した直後に戻したい位置。
   * ⚠ **本文を入れてから**戻す ── 空の器に `scrollTop` を代入しても
   * 「まだ scrollHeight が足りない」ので **0 に丸められる**(実際にそう外した)。
   * 🔴 **段組みのときは横**(`left`)である(#505)── 送りの向きが変わるので、
   *   縦だけ覚えていると**段組みで開き直すたびに先頭へ飛ぶ**
   *   (いまの縦送りでは覚えているので、覚えないのは**動線を 1 つ失う**ことになる)。
   */
  private pendingScroll: { top: number; left: number } | null = null;
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
    /**
     * 🔴 **キーの割当**(#256)。この面が名乗る文脈は `live`(全文編集 / 取り消し)。
     * ⚠ 既定はアプリ共有の 1 個 ── test は自分で `new` して渡す。
     */
    private readonly keymap: KeymapStore = appKeymap,
    /**
     * 🔴 **拡張の許可**(#195 / C-5 段①)── 「目次を見せて起動」を出すかどうか。
     * ⚠ 既定はアプリ共有の 1 個 ── test は自分で `new` して渡す。
     */
    private readonly extensionGrants: ExtensionGrants = appExtensionGrants,
    /**
     * 🔴 **留めた枠として描く**(#505 段②)。`null` = 主の枠(これまでどおり)。
     *
     * 立っているとき、この面は:
     * - 出すノートを `state.selectedLid` ではなく**この lid** にする
     * - 本文を `state.splitBodies` から取る(`openBody` は主の枠のものである)
     * - **編集に入らない / 帯も履歴も出さない** ── 読むための枠だからである
     * - 🔴 **`data-pkc-field` の綴りを `detail-` から `split-` へ変える**
     *
     * ⚠ 最後の 1 つが**いちばん大事**である。綴りを変えないと、本文を押したときの
     * 受け手(`binder.ts` の `closest('[data-pkc-field="detail-body"]')` が 4 か所)が
     * **留めた枠の押しを主の枠の押しとして扱う** ── 留めた枠の行番号で
     * **選んでいるノートを書き換える**、という「押した物と効く先が食い違う」事故になる。
     * 🔑 綴りを変える規則は `field()` **1 か所**に置く(呼び側で分岐しない)。
     */
    private readonly pinnedLid: string | null = null,
    /**
     * 🔴 **`data-pkc-detail-mode` を焼く先**(2026-08-29)。既定は自分の器。
     *
     * ⚠ この印は**面の外**から読まれる ── 段組みの `viewPane()` と、
     * `app.css` の `[data-pkc-region='detail'] > [data-pkc-view-pane='detail'][data-pkc-detail-mode='view']`
     * (**直接の子**で当てている)。だから器が 1 段内側へ入ると
     * **両方が当たらなくなる** ── 段組みが永久に切れ、貼り付く帯が外れた
     * (フル smoke が 6 + 3 件で捕まえた)。
     * 🔑 **印は 1 か所で焼き、在り処は配線が決める** ── 主の枠は面へ、
     * 留めた枠は自分の器へ。2 か所で書かない(CLAUDE.md §7)。
     */
    private readonly markOn: HTMLElement | null = null,
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
   * 🔴 **この面が名乗る `data-pkc-field`**(#505 段②)。
   *
   * 主の枠は今までどおり `detail-*`、留めた枠は `split-*`。
   * ⚠ **呼び側で分岐しない** ── 分岐を散らすと、1 か所だけ `detail-` のまま
   * 残った瞬間に上の事故が戻る(しかも押すまで分からない)。
   */
  /** 留めた枠の題名の指紋(#505 段②)。⚠ 主の枠では使わない。 */
  private lastPinnedTitle: string | null = null;

  private field(name: string): string {
    return this.pinnedLid === null ? name : name.replace(/^detail-/, 'split-');
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
    // 🔴 **囲みが読み込んだ字も手放す**(#444 段①)── 別のノートへ移るときに
    //    握ったままだと、その本文が常駐する(2026-07-27「速やかな破棄」)
    this.fenceTexts.clear();
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
    /**
     * 🔴 **留めた枠は、選択にも編集にも関係なく「その 1 件」を出す**(#505 段②)。
     *
     * ⚠ ここを通さずに下の指紋へ落とすと、**一覧を押すたびに留めた枠まで
     * 描き直る** ── user から見れば「横に並べたのに、押したら相手が消えた」。
     * 🔑 指紋は (この lid の本文, 題名) の 2 つだけ ── `selectedLid` も `phase` も
     * この枠には効かない。
     */
    if (this.pinnedLid !== null) {
      const pinned = this.pinnedLid;
      const pinnedBody = state.splitBodies.get(pinned) ?? null;
      const pinnedTitle = state.entryMetas.get(pinned)?.title ?? '';
      if (
        this.lastSelected === pinned &&
        this.lastBody === pinnedBody &&
        this.lastPinnedTitle === pinnedTitle
      )
        return;
      this.lastPinnedTitle = pinnedTitle;
      this.renderView(state, pinnedBody);
      return;
    }
    const editing = state.phase === 'editing' && state.openBody !== null;
    if (editing) {
      // 入力中の再描画はカーソル / IME を壊す ── 同一 entry の編集中は何もしない
      if (this.mode === 'editor' && this.lastSelected === state.openBody!.lid) return;
      this.renderEditor(state);
      return;
    }
    const body = state.openBody?.body ?? null;
    /**
     * 指紋は (selectedLid, body, phase, revisionPanel 参照, **revisionPreview 参照**)。
     * title 次元は含めていない ── title 編集が入る段階で entryMetas 参照を足すこと。
     *
     * 🔴 **`revisionPreview` を足したのは、押しても画面が変わらなかったから**
     * (#398 段②、test が拾った)。⚠ 版を押すと state は変わるが `revisionPanel` の
     * 参照は**同じまま**なので、ここで早期 return して**差分が一度も描かれなかった**
     * ── この repo が何度も踏んでいる型である(「フォルダを移したのに前の居場所を
     * 出したまま」/ `refreshTaskCards` の 3 か所目)。
     * 🔑 **下流(`renderPanel`)にも同じ指紋を置いてある** ── どちらか一方だけでは
     *   止まる(上で止まるか、下で止まるか、が違うだけ)。
     */
    if (
      this.mode !== 'editor' &&
      state.selectedLid === this.lastSelected &&
      body === this.lastBody &&
      state.phase === this.lastPhase &&
      state.revisionPanel === this.lastPanel &&
      state.revisionPreview === this.lastPreview
    )
      return;
    this.renderView(state, body);
  }

  private title(state: AppState, lid: string): HTMLElement {
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', this.field('detail-title'));
    title.textContent = state.entryMetas.get(lid)?.title ?? '';
    return title;
  }

  private renderView(state: AppState, body: string | null): void {
    this.mode = 'view';
    this.lastSelected = this.pinnedLid ?? state.selectedLid;
    this.lastBody = body;
    this.lastPhase = state.phase;
    this.lastPanel = state.revisionPanel;
    this.lastPreview = state.revisionPreview;

    const lid = this.pinnedLid ?? state.selectedLid;
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
      guide.setAttribute('data-pkc-field', this.field('detail-empty'));
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
      this.titleEl.setAttribute('data-pkc-field', this.field('detail-title'));
      this.barSlot = document.createElement('div');
      this.barSlot.setAttribute('data-pkc-field', this.field('detail-bar-slot'));
      this.panelSlot = document.createElement('div');
      this.panelSlot.setAttribute('data-pkc-field', this.field('detail-panel-slot'));
      // ⚠ 確認の帯は**本文の器の外**に置く ── 中に入れると `applyBlocks` の
      //    差分が「知らない子」として消す(そして次の描画で戻るので点滅する)
      this.noticeSlot = document.createElement('div');
      this.noticeSlot.setAttribute('data-pkc-field', this.field('detail-notice-slot'));
      this.bodyHost = document.createElement('div');
      this.bodyHost.setAttribute('data-pkc-field', this.field('detail-body-host'));
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
      this.pendingScroll =
        this.parkedScroll?.lid === lid
          ? { top: this.parkedScroll.top, left: this.parkedScroll.left }
          : { top: 0, left: 0 };
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
        loading.setAttribute('data-pkc-field', this.field('detail-loading'));
        loading.textContent = '読み込んでいます…';
        this.bodyHost!.append(loading);
      }
      return;
    }

    this.renderBar(state, true);
    this.renderPanel(state, lid);

    /**
     * 🔴 **描くのは「物理行だけ落とした本文」**(2026-08-28。着地前レビュー A)。
     *
     * ⚠ `fm.body` を描いてはいけない ── あちらは**閉じの直後の空行を 1 行余分に
     *   食べる**ので、この面が焼く `data-pkc-source-line` と、書き戻す側が使う
     *   `frontmatterLineCount` のずらしが**1 行ずれる**。
     *   実害は 3 つとも無言だった:チェックの印が 1 行上の項目を書き換える /
     *   `Ctrl`+クリックがどの行も開かない / 追記の入り先が 1 つ前の節になる。
     * 🔑 切り方は `bodyBelowFrontmatter` **1 か所**(`frontmatterLineCount` の
     *   注記が指示している形)。
     */
    const shown = bodyBelowFrontmatter(body);
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
      this.renderAttachment(body, shown, lid, selfContainerId(state), meta.title);
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
        this.bodyHost!.setAttribute('data-pkc-field', this.field('detail-body'));
        // 🔑 散文の読み幅を受ける印(2026-08-08 の紙面フォーマット)。
        //    ⚠ 器の名前(field / region)とは別に名乗る ── 同じ印を編集の 2 面と
        //    書き出しの器も付けており、**4 面 + 書き出しが同じ幅で見える**根拠がこれ
        this.bodyHost!.setAttribute('data-pkc-prose', '');
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
        /**
         * 🔴 **いま開いているコンテナの id**(2026-08-08。Issue #100 段①)。
         * これが無いと `pkc://<自分>/entry/<lid>` が**必ず**「別の PKC」の枝
         * (押せない placeholder)へ落ちる ── 受け手(`navigate-entry-ref`)は
         * #97 で戻っているのに、**焼かれないので 1 度も呼ばれなかった**。
         * ⚠ 指紋には足さない ── コンテナが変わる `SYS_BOOTED` は
         *   `selectedLid` / `openBody` を捨てるので、指紋は必ず一緒に動く。
         */
        currentContainerId: selfContainerId(state),
        /**
         * 🔴 **チェックの印を押せるようにする**(#277。2026-08-19)。
         * ⚠ **この面だけ**である ── 書き出した HTML・Viewer・印刷には
         *   受け手(`toggle-task`)が居ないので、押せない形のまま出す
         *   (押せるのに本文が変わらないと「チェックしたのに消えた」になる)。
         */
        interactiveTasks: true,
        /**
         * 🔴 **表のセルを押して打てるようにする**(#418 段①)。
         *
         * > user の物語:「表」を作って A1 に「品名」と打ちたい。押すと
         * > **CSV の原文**が出て、どのカンマが A1 かを目で数えることになっていた。
         *
         * ⚠ **この面だけ**である(理由は上の `interactiveTasks` と同じ)──
         *   書き出した HTML・印刷には受け手(`edit-cell`)が居ない。
         */
        interactiveCells: true,
        /**
         * 🔴 **本文の中のタグを押せるようにする**(#550 段③)。
         *
         * > user の物語:読んでいて `#買い物` が目に入る → 「この仲間を見たい」と
         * > 思う → **押せる**。押せないと、一覧タブへ戻って自分で打ち直すことになる。
         *
         * ⚠ **この面だけ**である(理由は上の 2 つと同じ)── 書き出した HTML には
         *   受け手(`filter-by-tag`)が居ないので、押せない形のまま出す。
         */
        interactiveTags: true,
        /**
         * 🔴 **押した行を原文の行で焼く**(N1)。この面は `fm.body`(frontmatter を
         * 剥がした本文)を描くが、受け手(`body-rewrite.ts`)は**原文**を splice する。
         * ⚠ 渡さないと、**frontmatter の行数だけ上の別の行**が書き換わる ──
         *   押した項目と違う所に印が付く、静かなデータ破壊になる。
         * 🔑 ずらす値は live editor(`startLine + fmLines`)と**同じ 1 つ**。
         */
        taskLineOffset: frontmatterLineCount(body),
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
       * 🔴 **「この lid の本文が描けた」を DOM の印で外へ出す**(#517)。
       *
       * ⚠ 本文の描画は worker の promise 越し(下の `.then(paint)`)なので、
       *   面を切り替えた**直後は見出しがまだ DOM に無い** ── 目次を押しても
       *   「その見出しがまだ出ていません」と断られ、**1 回の押しでは届かない**。
       * 🔑 だから **`binder` へ `DetailRenderer` を渡すのではなく、印を焼く** ──
       *   このリポジトリは既に面の状態を `data-pkc-*` で外へ出す作法を持っている
       *   (`data-pkc-columns-on` / `data-pkc-detail-mode`)。配線を増やさない。
       * ⚠ **描き始める前に外す**(ここ)── 前の lid の印が残っていると、
       *   待つ側が**古い本文を「描けた」と読む**。
       */
      this.bodyHost!.removeAttribute(PAINTED_ATTR);
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
          void this.hydrateAssetRefs(applied.inserted, this.hydrateToken, opts);
          this.mermaidScopes.push(...hydrateFigures(applied.inserted));
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
        /**
         * 🔴 **見出しの畳み**(#396)。⚠ **描画のたびに呼ぶ** ── 塊が差し替わると
         *   押す口が消えるので(`applyBlocks` は描画 HTML どうしを比べるため、
         *   ここで足す口は差分に影響しない)。
         * ⚠ 節点は 1 つも動かさない(入れ子にするとライブエディタが死ぬ)。
         */
        applyHeadingFold(host);
        /**
         * 🔴 **自由配置の板**(#283 P4)── `.pkc-place` の塊を、書いてある位置に置く。
         * ⚠ 描画のたびに呼ぶ(冪等)── 塊が差し替わると掴む口と題名の札が
         *   消えるため(見出しの畳みと同じ理由)。
         */
        applyPlaceLayout(host, (l) => state.entryMetas.get(l)?.title ?? null, frontmatterLineCount(body));
        // ⚠ 帯は**本文が入ってから**組む(数えるものが DOM に無いと 0 件になる)
        this.renderExternalImageBar(lid, host);
        this.restoreScroll();
        /**
         * 🔴 **描けた印**(#517)。⚠ **世代と器の門を通った後**に焼く ──
         *   前に置くと、捨てるはずの古い結果が印を付けてしまう。
         */
        host.setAttribute(PAINTED_ATTR, lid);
      };
      void this.markdown
        .render(shown, opts)
        .then(paint)
        .catch(() => paint(renderMarkdown(shown, opts)));
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
    /**
     * 🔴 **横に並べているときは、枠ごとに送る**(#505 段②)。
     *
     * ⚠ 並べた枠が**外の器 1 本**で送られると、片方を読み進めるだけで
     * もう片方も動く ── 「突き合わせながら読む」が成立しない。
     * 🔑 **主の枠も留めた枠も同じ規則**で書く(`pinnedLid` で分岐しない)──
     * 分岐すると、主の枠だけ外の器を掴んだままになって噛み合わない。
     * ⚠ 並べていないときは `split-frame` の親が居ないので、**今までどおり**外の器。
     */
    return (
      this.region.closest<HTMLElement>('[data-pkc-region="split-frame"]') ??
      this.region.closest<HTMLElement>('[data-pkc-region="detail"]') ??
      this.region
    );
  }

  /** 骨組みを組み直したときの位置戻し。⚠ **本文が入ってから**呼ぶ。 */
  private restoreScroll(): void {
    if (this.pendingScroll === null) return;
    const { top, left } = this.pendingScroll;
    this.pendingScroll = null;
    this.scroller.scrollTop = top;
    if (this.bodyHost !== null) this.bodyHost.scrollLeft = left;
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
    /**
     * 🔴 **留めた枠には出さない**(#505 段②)。
     *
     * ⚠ 出すと「押した物と効く先が食い違う」── 留めた枠の帯の「編集」を押すと、
     * 直るのは**選んでいるノート**(主の枠のほう)である。#426 段② で
     * 本文の右クリックを行の一覧と分けたのと**同じ理由**である。
     */
    if (this.pinnedLid !== null) return;
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
    /**
     * 🔴 **画像以外が止まったことは、同意と関係なく言う**(#528 段③)。
     *
     * ⚠ 外部の JavaScript / CSS / `fetch` は **同意で開けられない** ──
     *   だから「まだ答えていないか」(`unanswered`)で出し分けてはいけない。
     *   1 稿目はこの下の早期 return の後ろに置いてしまい、**一度「読み込まない」を
     *   押した user には二度と出なかった**。
     * 🔑 出すのは**理由と、動かしたいときの道**だけ ── 門は 1 つも開けない。
     */
    const kinds = this.blockedKinds.get(lid);
    if (kinds && kinds.size > 0) {
      const note = document.createElement('p');
      note.setAttribute('data-pkc-field', 'sandbox-blocked-note');
      note.textContent = sandboxBlockedNote([...kinds]);
      slot.append(note);
    }
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
  noteBlockedBox(lid: string, blocked: number, kinds: readonly string[]): void {
    /**
     * ⚠ **画像 0 件でも来る**(#528 段③)── 外部の script だけ止まった箱は
     *   画像の申告を持たない。`noteBlockedBox` は「増えたか」で false を返すので、
     *   **種別のほうを先に畳む**(そこで return すると理由が出ない)。
     */
    let grew = false;
    for (const raw of kinds) {
      const k = sandboxBlockedKind(raw);
      if (k === null) continue;
      const set = this.blockedKinds.get(lid) ?? new Set<SandboxBlockedKind>();
      if (!set.has(k)) grew = true;
      set.add(k);
      this.blockedKinds.set(lid, set);
    }
    const imagesGrew = blocked > 0 && this.externalImages.noteBlockedBox(lid, blocked);
    if (!grew && !imagesGrew) return;
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
    /**
     * 🔴 **留めた枠には出さない**(#505 段②)。
     *
     * ⚠ 出すと「押した物と効く先が食い違う」── 留めた枠の帯の「編集」を押すと、
     * 直るのは**選んでいるノート**(主の枠のほう)である。#426 段② で
     * 本文の右クリックを行の一覧と分けたのと**同じ理由**である。
     */
    if (this.pinnedLid !== null) return;
    const slot = this.panelSlot!;
    const shown =
      state.phase === 'ready' && state.revisionPanel && state.revisionPanel.lid === lid
        ? state.revisionPanel
        : null;
    /**
     * 🔴 **見ている版も指紋に入れる**(#398 段②)。
     *
     * ⚠ `revisionPanel` の参照だけを見ていると、**版を押しても画面が
     *   1 ドットも変わらない** ── 一覧の object は変わらないからである
     *   (「フォルダを移したのに前の居場所を出したまま」と同じ型)。
     */
    const preview =
      shown && state.revisionPreview?.lid === lid ? state.revisionPreview : null;
    if (shown === this.shownPanel && preview === this.shownPreview) return;
    this.shownPanel = shown;
    this.shownPreview = preview;
    slot.textContent = '';
    if (shown) {
      slot.append(
        renderHistoryPanel(shown.items, preview, state.openBody?.persisted ?? null),
      );
    }
  }

  /** いま出している差分(#398 段②)。⚠ 指紋の一部(上の注記)。 */
  private shownPreview: AppState['revisionPreview'] = null;

  private renderEditor(state: AppState): void {
    const open = state.openBody!;
    this.mode = 'editor';
    this.lastSelected = open.lid;
    this.lastBody = null;

    // ⚠ 編集へ入る前の位置を覚える ── 保存して戻ったときに先頭へ飛ばさない
    if (this.skeletonLid !== null)
      this.parkedScroll = {
        lid: this.skeletonLid,
        top: this.scroller.scrollTop,
        // 🔴 段組みでは送りが横 ── ここを落とすと、編集から戻ると先頭へ飛ぶ(#505)
        left: this.bodyHost?.scrollLeft ?? 0,
      };
    this.disposeLends();
    this.region.textContent = '';
    this.dropSkeleton();
    // title は uncontrolled input(commit 時に binder が RENAME を先行 dispatch)
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    /**
     * 🔴 **読み上げから見て無名にしない**(2026-08-19 の全数監査)。
     * ⚠ `data-pkc-field` は**機械の名前**であって、読み上げには届かない ──
     *   `<textarea>` / `<input>` は `<label>` も無いので、直す前は
     *   編集の面が**全部「編集」とだけ読まれる**状態だった。
     */
    titleInput.setAttribute('data-pkc-field', 'editor-title');
    titleInput.setAttribute('aria-label', 'ノートの題名');
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
     * 🔴 **既定は 1 面(ライブ)**(#104 第 2 弾。user 裁定 2026-08-08
     * 「既定でONかつ設定で2ペイン編集はできるようにする」)── 画面は常に
     * 描画済み文書で、クリックした行だけが原文の入力欄になる。
     * 2 列(原文 | プレビュー)は設定 `pkc3.editor-mode` = 'split' で選ぶ。
     * ⚠ flag `editor.live` は設定へ昇格して退役(枠を 1 返した)。
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
      /**
       * 🔴 **コンテナ id も読む面と同じ値**(Issue #100 段①)。渡さないと
       * 書いている最中だけ `pkc://<自分>/…` が押せない placeholder に見える ──
       * 保存した瞬間にリンクへ化ける(面ごとに違う見え方にしない)。
       */
      currentContainerId: selfContainerId(state),
    };
    if (liveEditorEnabled()) {
      this.renderLiveEditor(open.body, previewOpts, state.editOpenAt);
      return;
    }
    const split = document.createElement('div');
    split.setAttribute('data-pkc-region', 'editor-split');
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    ta.setAttribute('aria-label', '本文(原文)');
    ta.value = open.body;
    const preview = document.createElement('div');
    preview.setAttribute('data-pkc-region', 'editor-preview');
    preview.className = 'pkc-md-rendered';
    // 🔑 読む面と**同じ読み幅**にする(2026-08-08 の紙面フォーマット)。
    //    ⚠ 印が無いと、同じ文書が「読む面は 42rem・書いている間は全幅」になり、
    //    書いている最中と保存後で行の折り返しが変わる
    preview.setAttribute('data-pkc-prose', '');
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
        if (applied.inserted.length > 0) {
          // 🔴 **添付の画像もここで差す**(#250 で判明)。⚠ 読む面(`paint`)には
          //    在るのに、**編集中の 2 面と 1 面には無かった** ── 本文に
          //    `![…](asset:…)` を書いても、書いている間は **src の無い `<img>`**
          //    (= 何も出ない枠)のままだった。貼付を足して初めて表に出た症状だが、
          //    原因は貼付ではない ── CLAUDE.md §7「片側を直したら反対側を疑う」。
          void this.hydrateAssetRefs(applied.inserted, this.hydrateToken, previewOpts);
          scopes.push(...hydrateFigures(applied.inserted));
        }
        // 🔴 **積もらせない**(P8 段⑰。レビュー H-5)── 静穏 tick ごとに塊が
        //    増え、画面に無い PNG の URL と観測器が編集中ずっと生きていた
        //    (実測: 5 tick で createObjectURL 5 / revokeObjectURL 0)
        // ⚠ `inserted.length > 0` の**外**で呼ぶ(段㉗)── 図を削る編集では
        //    inserted が空になり、消えた図の URL が返らないまま残る
        pruneScopes(scopes);
        // 🔴 消えた `<img>` のぶんを返す(#250 ── 読む面と同じ規律)
        this.pruneLends();
      },
      (e) => {
        // 🔴 **白紙にしない**。理由を出して原文だけは読めるようにする
        if (!preview.isConnected) return;
        preview.textContent = `プレビューを描けませんでした: ${String(e).slice(0, 120)}`;
      },
    );
    /**
     * ⚠ **ここは `parseFrontmatter` のままでよい**(2026-08-28 に読む面を
     *   `bodyBelowFrontmatter` へ揃えたとき、対称の反対側として検めた)。
     *   2 ペインのプレビューの刻印は**送りの同期**にしか使われず、原文へ書き戻す
     *   側(`taskLineOffset` / `editOpenAt` / 追記の入り先)は 1 つも通らない
     *   ── だから基準がずれても書き換わる行は無い。
     * 🔑 揃えるなら**送りの同期の写像ごと**直す必要があるので、ここでは触らない
     *   (直す理由が出たら、そのときに 1 本の切り方へ寄せる)。
     */
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
    previewOpts: {
      sourceLineAnchors: boolean;
      allowExternalImages: boolean;
      currentContainerId: string;
    },
    /**
     * 🔴 **入った瞬間に開く行**(#395 段③)。`null` = どこも開かない(既定)。
     * ⚠ 座標は frontmatter を外した側(`RowSwap` と同じ基準)。
     */
    openAt: number | null,
  ): void {
    const pane = document.createElement('div');
    pane.setAttribute('data-pkc-region', 'editor-live');
    pane.className = 'pkc-md-rendered';
    // 🔑 読む面と**同じ読み幅**(2026-08-08 の紙面フォーマット)。
    // ⚠ 生になった行(`[data-pkc-row-slot]`)は**一律には入らない** ── 置き換えた
    //    塊が散文だったときだけ `row-swap.ts` が印を付ける(表・コード・図を押した
    //    編集欄まで散文の幅に縮めないため)。
    pane.setAttribute('data-pkc-prose', '');
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
    editAll.setAttribute(HINT_BASE, '本文全体を 1 つの入力欄で編集します');
    editAll.setAttribute(HINT_COMMAND, 'edit-all');
    editAll.title = hintTitle('本文全体を 1 つの入力欄で編集します', 'edit-all');
    tools.append(editAll);
    /**
     * 🔴 **文書の情報(frontmatter)は「札」として上に出す**(#284)。
     *
     * ⚠ 直す前は**生の本文をそのまま描いていた**ので、`---` が水平線、
     *   中の `tags: [...]` が**見出し**として画面に出ていた ── user から見れば
     *   「消してよさそうな謎の行」であり、実際その場で消せた。閉じの `---` が
     *   1 行消えるだけで `parseFrontmatter` が `{}` を返し、**警告 0 件で
     *   タグが全部消える**(#284 の実測)。
     * 🔑 直し方は「隠す」ではなく **名札を付けて、編集の入口を分ける**
     *   ── 記法は減らさない(CLAUDE.md 不可侵「記法を減らすことは
     *   user の動線を減らすこと」)。本文側からは触れないので**事故で消えない**。
     */
    const fmCard = document.createElement('div');
    fmCard.setAttribute('data-pkc-region', 'live-frontmatter');
    this.region.append(tools, fmCard, pane, note);

    let body = initialBody;
    /**
     * 🔴 **描く本文と原文の行番号のずれ**(= frontmatter の行数)。
     * ⚠ 行ごとの編集はこの値だけ足して原文へ書き戻す ── **1 行の取り違えが
     *   「別の行が消える」**になるので、数え方は `frontmatterLineCount` 1 か所。
     */
    let fmLines = frontmatterLineCount(body);
    /** 画面に描く側(= 情報を外した本文)。⚠ 切り方も 1 か所に寄せる。 */
    const docOf = (src: string, n: number): string =>
      n === 0 ? src : src.split('\n').slice(n).join('\n');
    const scopes: MermaidScope[] = [];
    /** 塊を跨ぐ取り消しの履歴(S8)。⚠ 行の配列なので 1 件は小さい。 */
    let journal = EMPTY_JOURNAL;

    /** 情報の札を編集中か。⚠ 描き直しで入力欄を消さないための 1 つの旗。 */
    let fmEditing = false;
    /**
     * 🔴 **情報の札を描く**(#284)。frontmatter が無ければ**何も出さない**
     * (空の枠を置くと、書いていない人の画面に意味の無い箱が出る)。
     *
     * ⚠ **打っている最中は描き直さない** ── 札の入力欄は本文の描き直しと
     *   同じ経路で消えるので、旗が無いと 1 文字ごとに入力が飛ぶ。
     */
    const renderFmCard = (): void => {
      if (fmEditing) return;
      fmCard.textContent = '';
      /**
       * 🔴 **読めていないときは、札が「読めている」顔をしない**(#284 / #318、
       * 着地前レビュー G)。
       *
       * ⚠ 判定を `fmLines === 0` だけにしていたので、**二重 fence のノート**では
       *   `fmLines > 0` になり、札は 1 本目だけを出して「この文書の情報 status: done」
       *   と自信満々に言っていた ── **同じノートで、右の情報ペインは
       *   「読めていません」**と言う。同じ問いに 2 つの答えが在る状態だった(§7)。
       * 🔑 判定は `frontmatterProblem` 1 本へ寄せる。⚠ `fmLines === 0` でも
       *   理由が在るなら**札を出す**(そこが直せる場所なので、黙るほうが害が大きい)。
       */
      const problem = frontmatterProblem(body);
      /**
       * 🔴 **`unreadable` だけが要約を止める**(2 巡目レビュー A-2)。
       * ⚠ 1 稿目は `trailing`(1 組目は完全に読める)でも要約と編集の口を消して
       *   いたので、**健全なノートから唯一の編集導線が消えて**いた。
       */
      const unreadable = problem !== null && problem.kind === 'unreadable';
      if (fmLines === 0 && problem === null) {
        fmCard.removeAttribute('data-pkc-has-frontmatter');
        return;
      }
      fmCard.setAttribute('data-pkc-has-frontmatter', '');
      const label = document.createElement('span');
      label.setAttribute('data-pkc-field', 'fm-label');
      label.textContent = unreadable ? '文書の情報が読めていません' : 'この文書の情報';
      const why = document.createElement('span');
      why.setAttribute('data-pkc-field', 'fm-problem');
      if (problem !== null) why.textContent = problem.detail;
      /**
       * ⚠ **早期 return は `unreadable` のときだけ**(2 巡目レビュー A-2)──
       *   `trailing` は 1 組目が完全に読めるので、**要約も編集の口もそのまま出す**。
       *   1 稿目はここで種別を見ずに返していたので、健全なノートから
       *   唯一の編集導線が消えていた。
       */
      if (unreadable) {
        fmCard.append(label, why);
        /**
         * 🔴 **読めなくても、触れる所は残す**(2 巡目レビュー A-5)。
         *
         * ⚠ 1 稿目は理由を出したら必ず `return` していたので、**cap を超えた
         *   frontmatter は 1 面編集から手が届かなくなっていた** ── `fmLines > 0`
         *   なので `docOf` が本文から隠すのに、`情報を編集` も出ない。逃げ道は
         *   「設定で 2 ペインへ切り替える」だけだった。
         * 🔑 **読めない原文こそ、そこで直させたい場所**である ── 「読めない情報を
         *   編集させない」は、**触れなくすることと引き換えにする理由になっていない**
         *   (CLAUDE.md 不可侵「記法を減らすことは動線を減らすこと」と同じ向き)。
         * ⚠ `fmLines === 0` のときは出さない ── 切り出す行が無いので編集器が空になる。
         *   その形では**壊れた行が本文にそのまま見えている**(`docOf` が隠さない)ので、
         *   本文側で直せる = 動線は失われていない。
         */
        if (fmLines > 0) fmCard.append(fmEditButton());
        return;
      }
      const summary = document.createElement('span');
      summary.setAttribute('data-pkc-field', 'fm-summary');
      const meta = parseFrontmatter(body).meta;
      const keys = Object.keys(meta);
      /**
       * ⚠ **中身を出す**(名前だけにしない)── 「情報がある」とだけ出しても、
       *   何が入っているか分からなければ user は開いて確かめるしかない。
       */
      summary.textContent =
        keys.length === 0
          ? '(空)'
          : keys
              .map((k) => `${k}: ${Array.isArray(meta[k]) ? (meta[k] as unknown[]).join(', ') : String(meta[k])}`)
              .join(' / ');
      // ⚠ `trailing` のときは、読めている要約の**後ろに**理由を添える
      if (problem === null) fmCard.append(label, summary, fmEditButton());
      else fmCard.append(label, summary, fmEditButton(), why);
    };

    /**
     * 情報を編集する口。⚠ **1 か所で作る** ── 読める札と、読めないが触れる札
     * (`fmLines > 0`)の両方が使うので、2 つ作ると片方だけ直る(§7)。
     */
    const fmEditButton = (): HTMLButtonElement => {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.setAttribute('data-pkc-field', 'fm-edit');
      edit.textContent = '情報を編集';
      edit.title = 'タグなど、この文書に付いている情報を編集します';
      edit.addEventListener('click', () => openFmEditor());
      return edit;
    };

    /**
     * 🔴 **情報を編集する口**(#284)。⚠ 本文側から触れなくした代わりに、
     * **ここから必ず触れる**ようにする ── 触れなくしただけなら、それは
     * 動線を 1 つ減らしたことになる(CLAUDE.md 不可侵)。
     */
    const openFmEditor = (): void => {
      fmEditing = true;
      fmCard.textContent = '';
      const ta = document.createElement('textarea');
      ta.setAttribute('data-pkc-field', 'fm-source');
      ta.setAttribute('aria-label', 'この文書の情報(原文)');
      ta.value = body.split('\n').slice(0, fmLines).join('\n');
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.setAttribute('data-pkc-field', 'fm-commit');
      ok.textContent = '確定';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.setAttribute('data-pkc-field', 'fm-cancel');
      cancel.textContent = 'やめる';
      const close = (): void => {
        fmEditing = false;
        renderFmCard();
      };
      cancel.addEventListener('click', close);
      ok.addEventListener('click', () => {
        const before = fmLines;
        const next = spliceLines(body, 0, before - 1, ta.value);
        fmEditing = false;
        journal = record(journal, stepFor(body, 0, before - 1, ta.value));
        setBody(next);
        /**
         * 🔴 **読めなくなったら、そう言う**(#284 の本題)。⚠ 本文は 1 文字も
         *   失われていない(原文に残っている)が、**情報としては読めていない** ──
         *   ここで黙ると、タグが消えたことに user は気づけない。
         */
        /**
         * ⚠ **判定は `frontmatterProblem` 1 本**(着地前レビュー G)── 1 稿目は
         *   `frontmatterLineCount === 0` で見ていたので、**二重 fence にしてしまった
         *   ときや cap を超えたとき**に「更新しました」と言っていた。
         */
        const why = frontmatterProblem(body);
        note.textContent =
          why === null || why.kind === 'trailing'
            ? 'この文書の情報を更新しました'
            : `この文書の情報が読めなくなりました(${why.detail})── 書いた内容は本文に残っています`;
      });
      fmCard.append(ta, ok, cancel);
      ta.focus();
    };

    /**
     * 本文を差し替えて描き直す(外へも知らせる)。⚠ **出口は 1 つ**にする。
     * ⚠ 保存されるのは**原文**(`body`)── 情報を外した側ではない。
     *   ここを取り違えると、編集のたびに frontmatter が落ちる。
     */
    const setBody = (next: string): void => {
      body = next;
      // 🔴 情報の行数は**毎回引き直す**(情報そのものを編集したときに動く)
      fmLines = frontmatterLineCount(body);
      renderFmCard();
      this.onBodyChange?.(next);
      follow.push(docOf(body, fmLines), previewOpts);
      follow.flush(); // 🔑 確定は**待たせない**(打鍵では 1 回も描かない代わり)
    };

    const swap = new RowSwap(pane, {
      commit: (startLine, endLine, text) => {
        /**
         * 🔴 **行番号を原文へ戻す**(#284)── `RowSwap` が見ているのは
         * 情報を外した本文なので、そのまま splice すると **frontmatter の行を
         * 書き潰す**(user から見て「上の数行が消えた」)。
         * ⚠ ずらす値は `fmLines` 1 つ ── ここに 2 本目の計算を置かない。
         */
        const from = startLine + fmLines;
        const to = endLine + fmLines;
        // ⚠ 継ぎ足しの規則は `edit-journal.ts` の 1 か所(取り消しと同じ規則を使う)
        journal = record(journal, stepFor(body, from, to, text));
        // ⚠ 「変わったか」は `RowSwap` が持っている(開いた時の原文と比べる)──
        //    ここに 2 本目の判定を置かない
        setBody(spliceLines(body, from, to, text));
      },
      notify: (message) => {
        note.textContent = message;
      },
      // 🔴 行の開閉で作り直された塊の面倒をみる(#250)── ここを渡さないと、
      //    画像の塊を押して閉じたときに `<img>` が空の枠になる(実測)
      onInserted: (els) => {
        void this.hydrateAssetRefs(els, this.hydrateToken, previewOpts);
        scopes.push(...hydrateFigures(els));
        this.pruneLends();
      },
    });
    /**
     * 🔴 **押した行を開いた状態で編集に入る**(#395 段③)。
     *
     * ⚠ **ここで予約する**(`new RowSwap` の直後・最初の `follow.flush()` の前)──
     *   分割はまだ組まれていないので、開くのは最初の描き直しのときである。
     * ⚠ 行の持ち主が居なければ何も起きない ── 修飾クリックの座標が
     *   刻印の無い所(脚注の区切りなど)だったとき、**別の塊を当てずっぽうで
     *   開かない**ほうが正しい(押した所と違う所が開くと user は混乱する)。
     */
    if (openAt !== null) swap.openAt(openAt);
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
      const cmd = this.keymap.match(ev, 'live');
      if (cmd === null) return;
      /**
       * 🔴 **Ctrl+A で全文を 1 つの入力欄にする**(S6)── これで今日の 2 列の
       * 編集画面が 1 面の**縮退形**になる(別物の画面を 2 つ持たない)。
       * ⚠ 境目は取り消しと**同じ 1 判定**(入力欄に居るかどうか)── 行の中の
       * Ctrl+A はその行を選ぶブラウザ既定のままにする。
       */
      if (cmd === 'edit-all') {
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
          note.textContent = ALREADY_WHOLE_NOTE;
          return;
        }
        if (!swap.activateAll()) note.textContent = 'この本文は全文編集に開けません';
        return;
      }
      const forward = cmd === 'redo';
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
        note.textContent = ALREADY_WHOLE_NOTE;
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
      ta.setAttribute('aria-label', '本文(原文)');
      ta.value = body;
      ta.addEventListener('input', () => {
        // ⚠ 退避先では**描き直さない**(原文をそのまま編集している面なので)
        body = ta.value;
        this.onBodyChange?.(body);
      });
      note.textContent = `この本文は行ごとに編集できません(${reason})── 原文で編集します`;
      /**
       * ⚠ **札を畳む**(#284)── 退避先の入力欄には**原文(情報込み)**が入る。
       *   札を出したままにすると、同じ情報を編集する口が 2 つになり、
       *   どちらの編集が残るか分からなくなる(§7「同じ問いに答える口が 2 つ」)。
       */
      fmCard.textContent = '';
      fmCard.removeAttribute('data-pkc-has-frontmatter');
      pane.append(ta);
      // 退避先は**すでに原文全体**の編集 ── 押せない理由ごと可視にする
      editAll.disabled = true;
      editAll.title = ALREADY_WHOLE_NOTE;
    };

    const follow = this.markdown.follower<RenderedWithRanges>(
      ({ html, ranges }) => {
        if (!pane.isConnected || fellBack) return;
        // ⚠ 渡すのは**情報を外した側**(描いた html と行が一致していないと、
        //    塊と原文の対応が 1 行ずつずれる)
        const r = swap.update(docOf(body, fmLines), html, ranges);
        if (!r.ok) {
          // 🔴 **壊れた分割の上で編集させない**(設計 §7-9)── 今日の編集画面へ退避
          fallBack(r.reason ?? '');
          return;
        }
        // 図の面倒は**新しく入った所だけ**(既存の規律と同じ ── 生きた `<img>` の
        // ObjectURL を revoke しない)
        if (r.inserted.length > 0) {
          // 🔴 添付の画像もここで差す(#250 ── 2 面側と同じ穴が在った)
          void this.hydrateAssetRefs(r.inserted, this.hydrateToken, previewOpts);
          scopes.push(...hydrateFigures(r.inserted));
        }
        pruneScopes(scopes);
        // 🔴 **画面から消えた `<img>` のぶんを返す**(読む面と同じ規律)──
        //    ⚠ `inserted.length > 0` の**外**で呼ぶ(塊が消えるだけのとき
        //    inserted は空で、そこが一番溜まる)
        this.pruneLends();
        // 文書 globals(書字方向・既定の寄せ)── 読む面と同じ見え方にする。
        // ⚠ 材料は**原文**(`body`)── 描いているのは情報を外した側なので、
        //    そちらからでは globals(frontmatter に書く)が 1 つも見えない
        applyDocumentGlobals(pane, extractDocumentGlobals(body));
      },
      (e) => {
        if (!pane.isConnected) return;
        note.textContent = `描けませんでした: ${String(e).slice(0, 120)}`;
      },
      { withRanges: true },
    );

    renderFmCard();
    follow.push(docOf(body, fmLines), previewOpts);
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
    /** ⚠ 同じ理由でコンテナ id も要る(Issue #100 段①)── 説明に書いた
     *  `pkc://<自分>/entry/<lid>` が、ここだけ押せないと一貫性が崩れる。 */
    currentContainerId: string,
    /** ⚠ **ノートの題名**(添付の file 名 `meta.name` とは別物)。改名の欄に出す。 */
    entryTitle: string,
  ): void {
    const host = this.bodyHost ?? this.region;
    const meta = readAttachmentMeta(rawBody);
    const info = document.createElement('div');
    info.setAttribute('data-pkc-field', 'attachment-info');
    const label = document.createElement('span');
    label.textContent = `${meta.name || '(無名)'} — ${meta.mime}${
      meta.size !== null ? ` — ${humanBytes(meta.size)}` : ''
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
      /**
       * 🔴 **画像と PDF は別の窓で見られる**(#192 で画像、2026-08-15 に PDF を追加)
       * ── 添付を見ながら本文を書くため。⚠ 出すのは**別窓に出せるときだけ**
       * (押せない導線を置かない)。
       * ⚠ 判定は `features/asset/asset-preview-kind.ts` の 1 本
       * ── 直す前は画面の preview と別の判定を使っていたので、
       * **画面には出せるのに別窓には出せない PDF** という食い違いが生まれていた。
       * ⚠ ObjectURL の寿命は開いた窓の生死に従う(`platform/asset-window.ts`)。
       */
      if (canOpenAssetWindow(meta.mime)) {
        const pdf = assetPreviewKind(meta.mime) === 'pdf';
        const view = iconButton('view-asset', '別の窓で見る');
        view.setAttribute('data-pkc-asset-key', meta.assetKey);
        view.setAttribute('data-pkc-asset-name', meta.name || (pdf ? 'PDF' : '画像'));
        view.setAttribute('data-pkc-asset-mime', meta.mime);
        view.title = pdf
          ? 'PDF を別の窓で開きます(大きく開くので頁を読めます)'
          : '画像を別の窓で開きます(本文を書きながら見られます)';
        info.append(view);
      }
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
        /**
         * 🔴 **目次を見せて起動**(#195 / C-5 段①)。
         *
         * ⚠ **まだ許していないときだけ出す** ── 許してあれば普通の「起動」で口が
         *   開くので、同じことをする 2 つ目のボタンを残さない(押す場所が定まらなくなる)。
         * 🔑 代わりに、許してあることは**「起動」の説明**で言う ── ボタンが黙って
         *   消えるだけだと、user は口が開いていることを知る手がかりを失う。
         * ⚠ 取り消しは**設定の面**に在る(ここには置かない ── 詳細画面は
         *   「このノートで何ができるか」の場所であって、台帳の管理の場所ではない)。
         */
        if (this.extensionGrants.isGranted(meta.assetKey)) {
          run.title =
            '囲いの中で開きます(PKC3 の中身には触れません)。このアプリにはノートの目次を見せます ── 取り消しは設定から';
        } else {
          const extRun = iconButton(
            'launch-asset-extension',
            '目次を見せて起動',
            'launch-asset-extension',
          );
          extRun.title =
            'ノートの題名・種類・日付の一覧だけを見せて開きます。本文と添付は渡りません';
          info.append(extRun);
        }
      }
      /**
       * 🔴 **Office の入口**(#88 / O3-c)。⚠ 出るのは「押せるボタン」か
       * 「名指しの理由」のどちらかだけ ── どちらを出すかは
       * `features/office/office-entry.ts` が決める(ここは置くだけ)。
       * ⚠ Office の添付でなければ `null` が返る = 何も足さない。
       */
      const office = buildOfficeEntry({
        name: meta.name,
        mime: meta.mime,
        assetKey: meta.assetKey,
        // 🔴 **保存の戻り先**(#205)。⚠ ここを渡し忘れると、Office での上書き保存が
        //    このノートを更新せず、**新しい添付ノートを増やす**
        lid,
      });
      if (office) info.append(office);
    }
    host.append(info);

    // 🔑 **アプリとして登録**(P8 段⑭)。
    //    🔴 PKC3 の中からタイルを作る手段が**1 つも無かった** ── タイルの元データは
    //    この添付の frontmatter に在るのに、書けるのは PKC2 の取込だけだった。
    //    ⚠ 置き場所は「操作は対象の隣」── その添付の画面に置く
    /**
     * 🔴 **名前を、その添付の画面から変える**(#401 ②)。
     *
     * ⚠ 改名の機構は在ったのに(`RENAME_ENTRY_TITLE`)、**ここに口が無かった** ──
     *   一覧へ戻って `F2` を押すか、編集画面を開くしかなく、情報ペインの原則
     *   「**操作は対象の隣**」(`inspector.ts:9-13`)と自己矛盾していた。
     * ⚠ **新しい改名の規則を作らない** ── 既存の action を撃つだけ。
     */
    const rename = document.createElement('input');
    rename.type = 'text';
    rename.setAttribute('data-pkc-action', 'rename-attachment');
    rename.setAttribute('data-pkc-field', 'attachment-rename');
    rename.setAttribute('aria-label', 'この添付の名前');
    rename.value = entryTitle;
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    rename.title = '名前を変えて、この欄の外を押すと変わります';
    host.append(rename);

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
      /**
       * 🔴 **綴りは `field()` から取る**(2026-08-29、着地前レビュー ⚠5)。
       *
       * ⚠ ここだけ**リテラルで `detail-body` を直書き**していた ── 留めた枠は
       *   `detail-` を `split-` へ変えることで「押した物と効く先が食い違う」を
       *   防いでいるのに(この file の `field()` の説明)、**添付の説明だけ
       *   その仕掛けをすり抜けて**いた。
       * ⚠ 実害:添付を横に留めて、その説明の見出しを右クリックすると、
       *   受け手は `root.querySelector('[data-pkc-field="detail-body"]')` で
       *   **主の枠**を掴む(器の並びは主が先)── 右を押したのに左が畳まれる。
       */
      desc.setAttribute('data-pkc-field', this.field('detail-body'));
      // 🔑 添付の説明も本文と同じ読み幅(2026-08-08)。⚠ ここは**別に描く経路**
      //    なので、読む面に印を付けただけでは届かない(CLAUDE.md「経路ごとに pin」)
      desc.setAttribute('data-pkc-prose', '');
      desc.innerHTML = renderMarkdown(description, {
        sourceLineAnchors: true,
        // ⚠ 添付の説明も本文と同じ扱い ── ここだけ素通りすると、説明に書いた
        //    追跡画像が設定を無視して飛ぶ(面ごとに違う扱いにしない)
        allowExternalImages: this.externalImages.allows(lid),
        currentContainerId,
      });
      /**
       * 🔴 文書 globals(書字方向・既定の寄せ)を説明の器にも当てる(#106 /
       * Issue #103 の残面)。書き出し(pkc3-html.ts)は添付 entry にも同じ attrs を
       * 焼いて閲覧側で当てるので、ここだけ素通りすると「align を宣言した添付では、
       * 配った HTML でだけ |> が反対に寄る」── 入れ替え規則は器の doc-align 属性が
       * 無いと発火しない。
       * ⚠ 材料は **rawBody(frontmatter 込み)** ── description(fm.body)からでは
       *   globals が見えない(Split プレビューが ta.value から取るのと同じ注意)。
       */
      applyDocumentGlobals(desc, extractDocumentGlobals(rawBody));
      host.append(desc);
      void this.hydrateAssetRefs(desc, this.hydrateToken, {
        allowExternalImages: this.externalImages.allows(lid),
        currentContainerId,
      });
      // 🔴 添付の説明にも図が書ける(P8 段⑬ review L-3)。かつてここだけ
      //    `hydrateMermaid` を呼んでおらず、**器が空のまま**残っていた ──
      //    「本文なら描けるのに、添付の説明だと描けない」という一貫性の穴
      this.mermaidScopes.push(...hydrateFigures(desc));
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
    /**
     * 🔴 **囲みを描き直すのに要る 2 つ**(#444 段①)。
     *
     * ⚠ **必須にしてある**のは、tsc に**呼んでいる所を全部並べさせる**ためである
     *   ── 面ごとに呼び忘れると「本文なら出るのに、添付の説明だと出ない」という
     *   一貫性の穴になる(この file が mermaid で 1 度踏んだ形)。
     * ⚠ 値は**その面が `renderMarkdown` に渡したのと同じ物**でなければならない
     *   ── 違えると、囲みの中の画像だけが設定と逆に振る舞う。
     */
    env: { readonly allowExternalImages: boolean; readonly currentContainerId: string },
  ): Promise<void> {
    // 🔴 **囲みの中身も添付から来る**(#444 段①)── 同じ lender・同じ世代で埋める
    void this.hydrateFenceAssets(rootEls, token, env);
    // 🔴 **本文に書いた音・動画は、その場で聞ける**(#413 段②)── 同上
    void this.hydrateMediaRefs(rootEls, token);
    if (!this.assets) return;
    const assets = this.assets;
    const roots: readonly Element[] = Array.isArray(rootEls)
      ? (rootEls as readonly Element[])
      : [rootEls as Element];
    /**
     * 🔴 **本文に貼った画像も、押すと別の窓で大きく見られる**(#527、2026-08-28)。
     *
     * ⚠ 図(mermaid)だけ先に着地させたので、**画像は押しても何も起きなかった** ──
     *   user の頼みは「対象は画像だけでなく**レンダリング結果全部**」である。
     * 🔑 **印は差す前に付ける** ── `src` が入るかどうか(添付が見つかるか)と
     *   押し所であることは別の話で、`src` が無い絵は `binder` 側が弾く。
     * ⚠ 判定(読む面か)は `markViewBig` **1 か所**が持つ ── ここに条件を
     *   書き足すと、図と画像で**面ごとに違う動き**になる(§7)。
     * ⚠ **外から取り寄せる画像には付けない** ── あちらは同意の機構が別にあり、
     *   `fetch` し直すと**取り寄せが 1 回増える**(`data-pkc-asset-key` を持つ
     *   = 手元の添付だけを対象にする)。
     */
    for (const r of roots) {
      if (r instanceof HTMLImageElement && r.hasAttribute('data-pkc-asset-key'))
        markViewBig(r);
      for (const img of r.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]'))
        markViewBig(img);
    }
    const byKey = new Map<string, HTMLImageElement[]>();
    const collect = (img: HTMLImageElement): void => {
      // ⚠ **既に差してあるものは借り直さない**(#250)── 同じ `<img>` に 2 回
      //   借りると、1 本目の URL が誰にも返されないまま生き残る(`pruneLends` は
      //   「画面から外れた」ときしか返さない)
      if (img.hasAttribute('src')) return;
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
    /**
     * 🔴 **生きている貸出を使い回す**(2026-08-18、着地前レビュー)。
     *
     * 編集中の面は打鍵のたびに塊を作り直すので、そのたびに借りると
     * **IDB 読み + `createObjectURL` が tick ごと**に走る(`lendObjectUrl` は
     * キャッシュを持たない)。⚠ 使い回した `<img>` を貸出の `els` に**足す**
     * ことが要である ── 足さないと、古い `<img>` が消えた時点で `pruneLends` が
     * 返してしまい、**画面に出ている新しい `<img>` の src が死ぬ**。
     */
    for (const [key, imgs] of [...byKey]) {
      const live = this.lends.find(
        (l) => l.key === key && l.url !== null && l.els.some((e) => e.isConnected),
      );
      if (!live) continue;
      live.els.push(...imgs);
      for (const img of imgs) img.src = live.url!;
      byKey.delete(key);
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
          this.lends.push({ key, url: lent.url, dispose: lent.dispose, els: imgs });
          for (const img of imgs) img.src = lent.url;
        } catch {
          if (token === this.hydrateToken)
            for (const img of imgs) img.setAttribute('data-pkc-asset-missing', '');
        }
      }),
    );
  }

  /**
   * 🔴 **本文に書いた音・動画を、その場で聞ける / 見られるようにする**(#413 段②)。
   *
   * > user 要望 2026-07-16(PKC2 #922):
   * > 「録音と画面収録を**マルチメディアで埋め込め**るようにする」
   *
   * ⚠ **収録に限らない** ── 手で添付した音・動画にも効く(PKC2 のマニュアルも
   *   「手動で添付した音声・動画ファイルも同様に埋め込めます」と書いている)。
   *
   * ## なぜ「リンクの隣」なのか
   *
   * `markdown-render.ts` は `[名前](asset:鍵)` を **`href` を剥がした `<a>`**
   * (保存の導線)にする。⚠ **その `<a>` は残す** ── 器を置き換えると
   * **保存する道が消える**(片道の操作を作らない、user 指示 2026-08-23)。
   * だから**隣に置く**:字は「何のファイルか」、器は「その場で聞く」を持つ。
   *
   * ⚠ **種類は中身の MIME で決める**(名前の拡張子ではない)── 判定は
   *   `assetPreviewKind` の 1 本(添付の面と同じ関数 ── §7)。
   * ⚠ 音・動画**以外**は何もしない(PDF は添付の面で見る / それ以外は保存)。
   * ⚠ 読めない添付でも**黙って壊さない** ── リンクはそのまま残る。
   */
  private async hydrateMediaRefs(
    rootEls: HTMLElement | readonly Element[],
    token: number,
  ): Promise<void> {
    const assets = this.assets;
    if (!assets) return;
    const roots: readonly Element[] = Array.isArray(rootEls)
      ? (rootEls as readonly Element[])
      : [rootEls as Element];
    /** 鍵ごとに集める。⚠ 同じ添付を 2 回書いても、借りるのは 1 本。 */
    const byKey = new Map<string, HTMLAnchorElement[]>();
    const collect = (a: HTMLAnchorElement): void => {
      const key = a.getAttribute('data-pkc-asset-key') ?? '';
      if (key === '') return;
      const group = byKey.get(key);
      if (group) group.push(a);
      else byKey.set(key, [a]);
    };
    for (const r of roots) {
      if (r instanceof HTMLAnchorElement && r.hasAttribute('data-pkc-asset-key')) collect(r);
      for (const a of r.querySelectorAll<HTMLAnchorElement>('a[data-pkc-asset-key]')) collect(a);
    }
    if (byKey.size === 0) return;
    await Promise.all(
      [...byKey].map(async ([key, links]) => {
        try {
          /**
           * ⚠ **先に種類だけ見る** ── `lend` は ObjectURL を作るので、
           *   音・動画でないものにまで作らせない(2026-07-27「即破棄」の向き)。
           */
          const blob = await assets.getBlob(key);
          if (token !== this.hydrateToken) return;
          const kind = assetPreviewKind(blob?.type);
          if (kind !== 'audio' && kind !== 'video') return;
          const lent = await assets.lend(key);
          if (!lent) return;
          // ⚠ 借りている間に別のノートへ移っていたら、**借りた瞬間に返す**
          if (token !== this.hydrateToken) {
            lent.dispose();
            return;
          }
          const placed: Element[] = [];
          for (const a of links) {
            if (!a.isConnected) continue;
            /**
             * ⚠ **同じリンクへ 2 枚目を置かない**。
             * 🔑 これは**将来のための tripwire** である ── いまの呼び側は
             *   **組み立て直した DOM にしか**この関数を通さないので、
             *   **外しても壊れない**(変異試験 R3 が SURVIVED で教えた)。
             *   承知のうえで残す:呼び側が増えて二重に通った日に、
             *   症状は「再生機が 2 枚並ぶ」という**見れば分かる形**ではなく、
             *   **借りた URL が 1 本ずつ迷子になる**形で出るからである。
             */
            if (a.nextElementSibling?.getAttribute('data-pkc-field') === BODY_MEDIA_FIELD) continue;
            const el = document.createElement(kind);
            // ⚠ **印は 2 つ** ── 探すのは `data-pkc-field`、飾るのは class
            el.setAttribute('data-pkc-field', BODY_MEDIA_FIELD);
            el.className = BODY_MEDIA_CLASS;
            el.controls = true;
            /** ⚠ **中身は開くまで読まない**(長い収録を開くたびに丸ごと運ばない)。 */
            el.preload = 'metadata';
            el.src = lent.url;
            a.after(el);
            placed.push(el);
          }
          // ⚠ 1 枚も置けなかった回は**その場で返す**(誰も見ていない URL を残さない)
          if (placed.length === 0) {
            lent.dispose();
            return;
          }
          this.lends.push({ key, url: lent.url, dispose: lent.dispose, els: placed });
        } catch {
          /* 読めない添付 ── リンク(保存の導線)はそのまま残す */
        }
      }),
    );
  }

  /**
   * 🔴 **囲みの中身を添付から取って描く**(#444 段①。user 裁定 2026-08-26)。
   *
   * `markdown-render.ts` は ```` ```csv asset:k ```` を
   * `<div data-pkc-fence-asset-key="k" data-pkc-fence-asset-info="csv">` の
   * **器**にするところまでやる ── 添付は IDB に在り、markdown の描画は同期なので、
   * **埋めるのはここ**である(mermaid と同じ形)。
   *
   * ⚠ **字は憶える**(`fenceTexts`)── この面は打鍵のたびに塊を作り直すので、
   *   憶えないと **1 打鍵ごとに IDB を読む**。⚠ 憶えたものはノートが変われば捨てる
   *   (`hydrateToken` が動く ── 別のノートの字を残さない)。
   * ⚠ **読めなかったら理由を出す**(#264 段② と同じ向き)── 黙って器のままにしない。
   *   囲みに書いてあった控え(`data-pkc-fence-asset-fallback`)は**残す**。
   */
  private async hydrateFenceAssets(
    rootEls: HTMLElement | readonly Element[],
    token: number,
    env: { readonly allowExternalImages: boolean; readonly currentContainerId: string },
  ): Promise<void> {
    const roots: readonly Element[] = Array.isArray(rootEls)
      ? (rootEls as readonly Element[])
      : [rootEls as Element];
    const hosts: HTMLElement[] = [];
    for (const r of roots) {
      if (r instanceof HTMLElement && r.hasAttribute('data-pkc-fence-asset-key')) hosts.push(r);
      for (const el of r.querySelectorAll<HTMLElement>('[data-pkc-fence-asset-key]'))
        hosts.push(el);
    }
    if (hosts.length === 0) return;
    if (token !== this.hydrateToken) return;
    /**
     * 🔴 **この 1 回で 1 つ**(着地前の自己レビューで判明)── `-both` の切替 id は
     *   「同じ(言語, 中身)の中で何番目か」で決まり、その数はこの object が憶える。
     * ⚠ 囲みごとに作り直すと、**同じ囲みを 2 つ書いたときに id が衝突する**
     *   (片方を押すともう片方が開く)。
     */
    const renderEnv: { currentContainerId?: string; allowExternalImages?: boolean } = {
      currentContainerId: env.currentContainerId,
      allowExternalImages: env.allowExternalImages,
    };
    /** ⚠ 世代が変わっていたら捨てる ── 別のノートの器へ書き込まない。 */
    const fail = (host: HTMLElement, why: string): void => {
      const pending = host.querySelector('[data-pkc-fence-asset-pending]');
      if (!pending) return;
      pending.setAttribute('data-pkc-fence-asset-error', '');
      pending.removeAttribute('data-pkc-fence-asset-pending');
      pending.textContent = `この囲みの中身(添付)を読めません: ${why}`;
    };
    const assets = this.assets;
    await Promise.all(
      [...new Set(hosts.map((h) => h.getAttribute('data-pkc-fence-asset-key') ?? ''))].map(
        async (key) => {
          const mine = hosts.filter(
            (h) => (h.getAttribute('data-pkc-fence-asset-key') ?? '') === key,
          );
          let text = this.fenceTexts.get(key);
          if (text === undefined) {
            if (!assets) {
              for (const h of mine) fail(h, '添付を読む口がありません');
              return;
            }
            /**
             * 🔑 **読み方は書き出しと同じ 1 本**(#444 段②で寄せた)──
             *   上限も断り文も `features/asset/fence-asset-read.ts` が持つ。
             * ⚠ 直す前はここに同じ判定が並んでおり、**書き出し側にだけ上限が
             *   無い**という食い違いを作れる形だった(CLAUDE.md §7)。
             */
            const got = await readFenceAssetText((k) => assets.getBlob(k), key);
            // ⚠ 待っている間にノートが変わっていたら**何も触らない**(器も断り文も)
            if (token !== this.hydrateToken) return;
            if (!got.ok) {
              for (const h of mine) fail(h, got.why);
              return;
            }
            text = got.text;
            this.fenceTexts.set(key, text);
          }
          for (const h of mine) {
            const info = h.getAttribute('data-pkc-fence-asset-info') ?? '';
            /**
             * ⚠ **器ごと差し替える** ── `renderFenceFromAsset` が返すのは
             *   `pkc-md-block` を含む**塊そのもの**なので、中へ入れると二重になる。
             * ⚠ 位置の印(`data-pkc-source-line`)は器が持っているので、
             *   差し替えた要素へ**写す**(押した行の対応を失わない)。
             */
            const holder = document.createElement('div');
            holder.innerHTML = renderFenceFromAsset(info, text, renderEnv);
            const next = holder.firstElementChild;
            if (!next) {
              fail(h, '描けませんでした');
              continue;
            }
            for (const name of ['data-pkc-source-line', 'data-pkc-source-end']) {
              const v = h.getAttribute(name);
              if (v !== null) next.setAttribute(name, v);
            }
            h.replaceWith(next);
            // 🔴 **図とグラフはここでも埋める** ── `asset:` で読み込んだ mermaid が
            //    器のまま残らないように(この file が 1 度踏んだ「器が空のまま」)
            this.mermaidScopes.push(...hydrateFigures(next));
          }
        },
      ),
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
      // ⚠ 見せ方の判定は `features/asset/asset-preview-kind.ts` の 1 本だけを使う
      //    (別窓の側と同じ規則 ── 片方だけ PDF を知っている状態を作らない)
      const kind = assetPreviewKind(mime);
      if (kind === 'text') {
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
      this.lends.push({ key: null, url: null, dispose: lent.dispose, els: [host] });
      if (kind === 'image') {
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
        /**
         * 🔴 **PDF はブラウザ内蔵ビューアに委ねる**(依存を足さない)。
         * ⚠ **寸法は CSS で与える**(`app.css` の `object[data-pkc-field=…]`)──
         * `<object>` は固有寸法を持たないので、`img` と規則を共用すると
         * **既定の 300×150** で描かれる。2026-08-15 に user 報告で露見した症状が
         * これで、実測 302×152(器は 925×626 空いていた)。
         * ⚠ **`sandbox` は付けない**(`<object>` は script を実行しない)。
         */
        const obj = document.createElement('object');
        obj.setAttribute('data-pkc-field', 'attachment-media');
        obj.setAttribute('data-pkc-preview', 'pdf');
        obj.type = 'application/pdf';
        obj.data = lent.url;
        /**
         * 🔑 **出せなかったときに空白を残さない**(PKC2 の判断を採る)──
         * `<object>` の fallback 検出はブラウザ差が大きく当てにならないので、
         * **中に断り文を置いて**ブラウザ自身に出させる。
         * ⚠ ダウンロードの導線は上に常に在るので、そこへ案内する。
         */
        /**
         * ⚠ **`attachment-no-preview` と別の名前にする** ── あちらは
         * 「この種類は出せない」、こちらは「出せる種類だが、この browser が
         * 出せない」で**意味が違う**。同じ名前にすると、片方を見る test が
         * もう片方に満たされて空振りする(CLAUDE.md §1)。
         */
        const note = document.createElement('p');
        note.setAttribute('data-pkc-field', 'attachment-pdf-fallback');
        note.textContent =
          'この browser は PDF を画面に出せません。上の「ダウンロード」で保存して開いてください';
        obj.append(note);
        host.append(obj);
      }
    } catch {
      if (token === this.hydrateToken) missing();
    }
  }
}

/**
 * その版と 1 つ新しい版のちがいを短く出す(#398 段①)。
 *
 * > user の物語: 履歴に**同じ題名が 3 つ**並び、日時しか手がかりが無い。
 *
 * ⚠ **数えられない版では何も出さない**(全文で持っている版)── `0` と書くと
 *   「変わっていない」という**嘘**になる。`null` と `0` を潰さない。
 */
function diffBadge(added: number | null, removed: number | null): HTMLElement | null {
  if (added === null || removed === null) return null;
  const span = document.createElement('span');
  span.setAttribute('data-pkc-field', 'revision-delta');
  span.textContent = `+${added} −${removed}`;
  // ⚠ **何との比較かを書く**(数字だけだと、今の本文との差だと読まれる)
  span.title = '1 つ新しい版とくらべて、行がこれだけ増えて / 減っています';
  return span;
}

/** 差分の 1 行(#398 段②)。⚠ **読むだけ**の器 ── 押せる物を置かない。 */
function diffLineEl(row: DiffRow): HTMLElement {
  const li = document.createElement('li');
  li.setAttribute('data-pkc-diff', row.kind);
  if (row.kind === 'gap') {
    li.textContent = `⋯ 変わっていない ${row.skipped ?? 0} 行`;
    return li;
  }
  // ⚠ 印は**字で置く**(色だけにしない ── 色が見えない人に届かない)
  const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  li.textContent = `${mark} ${row.text}`;
  return li;
}

/**
 * 🔴 **戻す前に中身を見る**(#398 段②)。
 *
 * ⚠ **読み取り専用**である ── ここに編集の口を作ると、保存したのがどちらの
 *   本文なのか user から見えなくなる。
 * ⚠ 比べる相手は **disk で確認できている本文**(`persisted`)── 画面の draft と
 *   比べると「保存していない字」がちがいとして出る。
 */
function renderRevisionDiff(revBody: string, currentBody: string): HTMLElement {
  const box = document.createElement('div');
  box.setAttribute('data-pkc-field', 'revision-diff');
  const head = document.createElement('div');
  const counts = diffCounts(revBody, currentBody);
  const label = document.createElement('span');
  label.setAttribute('data-pkc-field', 'revision-diff-summary');
  label.textContent =
    counts.added === 0 && counts.removed === 0
      ? 'いまの本文と同じです'
      : `いまの本文とのちがい: +${counts.added} −${counts.removed}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-action', 'hide-revision-preview');
  close.textContent = '閉じる';
  head.append(label, close);
  box.append(head);
  const list = document.createElement('ul');
  for (const row of diffRows(revBody, currentBody)) list.append(diffLineEl(row));
  box.append(list);
  return box;
}

/** 履歴 panel(P5b)。開いた時点のスナップショット ── 復元・選択遷移で畳まれる。 */
function renderHistoryPanel(
  items: readonly {
    id: string;
    revOrder: number;
    createdAt: string | null;
    title: string | null;
    added: number | null;
    removed: number | null;
  }[],
  /** 開いている版(#398 段②)。⚠ その行の下にだけ差分を置く。 */
  preview: { revId: string; body: string } | null,
  /** 比べる相手 ── **disk で確認できている本文**(draft ではない)。 */
  currentBody: string | null,
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
    /**
     * 🔴 **行そのものを押すと中身が出る**(#398 段②)。
     *
     * ⚠ 復元ボタンとは**別の口**にする ── 同じ物にすると「見るつもりが戻った」
     *   が起きる(戻せはするが、履歴に 1 件積まれて手がかりがさらに埋まる)。
     * ⚠ `<button>` にする ── `<li>` に click を付けると**キーボードで押せない**。
     */
    const open = document.createElement('button');
    open.type = 'button';
    open.setAttribute('data-pkc-action', 'preview-revision');
    open.setAttribute('data-pkc-rev-id', item.id);
    open.setAttribute('data-pkc-field', 'revision-open');
    open.setAttribute(
      'aria-expanded',
      preview?.revId === item.id ? 'true' : 'false',
    );
    open.title = 'この版の中身を、いまの本文とくらべて見ます(戻しません)';
    const text = document.createElement('span');
    text.textContent = `#${item.revOrder} ${item.createdAt ?? ''} ${item.title ?? '(無題)'}`;
    open.append(text);
    const badge = diffBadge(item.added, item.removed);
    if (badge) open.append(badge);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.setAttribute('data-pkc-action', 'restore-revision');
    restore.setAttribute('data-pkc-rev-id', item.id);
    restore.textContent = '復元';
    li.append(open, restore);
    // ⚠ **その行の下に置く** ── 一覧の外に出すと、どの版の差分か分からなくなる
    if (preview?.revId === item.id && currentBody !== null) {
      li.append(renderRevisionDiff(preview.body, currentBody));
    }
    list.append(li);
  }
  panel.append(list);
  return panel;
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
