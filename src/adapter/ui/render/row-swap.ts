/**
 * 🔴 **行の入れ替え(row swap)**(2026-08-05。ライブエディタ S5 / S5b / S5c。
 * 設計 doc `docs/development/live-editor-design-2026-08.md`)。
 *
 * > user 指示「typora風の日本語対応の確定行の即時レンダリング差分反映」
 * > user 提案「行確定まで待てよ / auto pair と開放終端を検知したら、一旦
 * > レンダリングは生の文字のままにして、行を色変え、閉じ終端がついた時点でレンダリング」
 *
 * ## 作り
 * 画面は**常に描画済みの文書**。クリックした所を含む**最小の刻印要素**
 * (表の行 / 箇条書きの項目 / それ以外は塊)だけを原文の `<textarea>` に差し替え、
 * そこから出た瞬間(= 確定)に `commit(range, text)` を 1 回呼ぶ。
 * **打鍵ではレンダリングを 1 回も起こさない。**
 *
 * ## 🔴 日本語入力の契約(実測に基づく。設計 §5)
 * - `input` を `isComposing` で **return しない** ── 確定の瞬間の `input` も
 *   `isComposing === true` で、その後に `input` は来ない(実測)
 * - `compositionend` は「確定」ではない ── 変換の取り消しでも出る(実測)
 * - 封印中は textarea のノードを**動かさない / value に代入しない / focus を撃たない**
 *   (属性 ── `rows` / `data-pkc-open-end` ── は触ってよい。ノードが変わらない)
 * - `blur` が変換中に来たら**同期で確定しない**(`pendingCommit`)
 * - **安全弁**: 変換中なのに `activeElement` が外れたら封印を解く(永久固着の防止)
 *
 * ## 🔴 閉じないまま画面へ戻ったとき(S5b の残り)
 * いまは**確定して、理由を出す**。`` ``` `` が閉じていなければ描画は下を飲むが、
 * 原文は user の打ったとおりで、開き直して閉じれば直る。
 * ⚠ 「閉じるまで確定させない」にはしない ── **移動できない罠**になる。
 * 「閉じるまでその塊だけ生のまま見せ、他は描く」(= 仮の閉じを足して描く)は
 * S5b で入れる(設計 §6)。
 *
 * ⚠ ここは adapter 層。DOM を持つが **state は持たない** ── 本文の正本は
 * `AppState.openBody.body` で、こちらは「窓」に過ぎない。
 */
import { applyBlocks, EMPTY_VIEW, type BlockView } from './apply-blocks';
import { splitTopLevelBlocks } from '@features/markdown/html-blocks';
import {
  buildBlockPartition,
  mapVisibleToSource,
  type SourceRange,
} from '@features/markdown/source-ranges';
import { findOpenEnds, scanContainers } from '@features/markdown/source-blocks';
import { autoPairFor } from '@features/markdown/text-ops';
// ⚠ 継ぎ足しの規則は **1 本**(`detail.ts` の commit と同じ関数を使う)
import { spliceLines } from '@features/markdown/edit-journal';
import { appKeymap, type KeymapStore } from './keymap';

/** 活性塊の代わりに置く定数。⚠ **中身が固定**なので差分の対象から自然に外れる。 */
const SLOT_HTML = '<div data-pkc-row-slot="1"></div>';

/**
 * スロットに**読み幅の上限を掛ける**印(`app.css` と 1 対 1)。
 * ⚠ SLOT_HTML には焼き込まない ── 付けるかどうかは置き換える塊で決まる
 * (`proseSpan`)。定数側に入れると表・コードの編集欄まで散文の幅になる。
 */
const PROSE_ROW_ATTR = 'data-pkc-row-prose';

/**
 * 入力欄の高さの上限(行)。⚠ 全文差し替え(`Ctrl+A`)で 5000 行の箱を作らない。
 * 上限に当たったら箱の中で scroll する(= 今日の編集画面と同じ見え方)。
 */
const ROWS_CAP = 40;

/**
 * 🔴 **折り返しで増えた視覚の行を数える**(2026-08-15、user 報告)。
 *
 * `rows` を改行の数に合わせた**直後**に呼ぶ ── そのとき溢れている高さが、
 * そのまま「折り返しで足りない行数」である。
 *
 * ⚠ **版面を持たない環境では 0 を返す**(happy-dom は `scrollHeight` も
 * `line-height` も持たない)。⚠ そこを「折り返し無し」と読んではいけない ──
 * **測れなかった**だけである。だから unit は改行の側だけを守り、折り返しの側は
 * 値を差して**分岐を実際に走らせる** test と、実ブラウザの smoke で守る
 * (「分岐を書いたら、分岐の数だけ実際に走らせた記録を持つ」)。
 */
function wrappedExtraRows(ta: HTMLTextAreaElement): number {
  const view = ta.ownerDocument.defaultView;
  if (view === null) return 0;
  // 行の高さ。⚠ `normal` / 空(= 測れない)は NaN になるので、そこで降りる
  const lineHeight = Number.parseFloat(view.getComputedStyle(ta).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 0;
  // どちらも padding を含むので、差は**中身の溢れ**そのものになる
  const overflow = ta.scrollHeight - ta.clientHeight;
  if (!Number.isFinite(overflow) || overflow <= 0) return 0;
  return Math.ceil(overflow / lineHeight);
}

/** 入れ子の要素で、行ごとの刻印を持つもの(先に書いた方を優先して探す)。 */
const SUB_UNITS: readonly { selector: string; type: string }[] = [
  { selector: 'tr', type: 'tr_open' },
  { selector: 'li', type: 'list_item_open' },
];

export interface RowSwapCallbacks {
  /**
   * 確定。原文の `[startLine, endLine]`(両端含む)を `text` で置き換える。
   * ⚠ **本文書込の唯一の口**(設計 §10 ── 4 本目の柱の書込契約もここへ畳む)。
   */
  commit(startLine: number, endLine: number, text: string): void;
  /** 可視のお知らせ(無言で断らない)。 */
  notify?(message: string): void;
  /**
   * 🔴 **`update()` を経ずに DOM へ入った要素**(#250)。
   *
   * ⚠ `update()` の返り(`inserted`)は呼び側が面倒をみているが、**行を開く /
   * 閉じる**ときの当て直しはここで完結していたので、**誰も面倒をみていなかった** ──
   * 画像の塊を押して開き、閉じると `<img>` が原文の HTML から**作り直され**、
   * `src` の無い空の枠になる(実測。本文が変わらないので follower も来ない)。
   * 🔑 入った要素を外へ渡して、貸し出し(`asset:`)と図を差し直させる。
   *
   * ⚠ **optional にしない**(CLAUDE.md §7)── 配線を落としても tsc が黙ると、
   * 戻ってくる症状は「画像が消えたまま気づけない」といういちばん静かな形になる。
   */
  onInserted(els: readonly Element[]): void;
}

/** `update()` の返り。⚠ `ok: false` は**行の差し替えを開かない**という意味。 */
export interface RowSwapUpdate {
  ok: boolean;
  reason?: string;
  /** 新しく DOM に入った要素(呼び側が図の面倒を見る対象)。 */
  inserted: Element[];
}

/**
 * 描き直しの着弾後に開く予約(2026-08-08)。行数が変わる確定の直後は
 * `body` / `starts` / `ends` が古い座標なので、そのまま開かずにここへ積む。
 */
type PendingOpen =
  | { kind: 'line'; line: number; caret: 'start' | 'end' }
  | { kind: 'append' }
  | { kind: 'all' };

interface Active {
  /** 塊の添字(`view.blocks` の中)。⚠ 描き直しのたびに引き直す。 */
  blockIndex: number;
  /**
   * 差し替えている塊の数(S6 の範囲差し替え)。ふつうは 1、`Ctrl+A` では全部。
   * ⚠ **本文が同一のときしか描き直しを受けない**(上のガード)ので、開いた時の
   * 数がそのまま使える ── 塊数が変わる描き直しはここへ来ない。
   */
  blockCount: number;
  startLine: number;
  endLine: number;
  /** 開いた時の原文。⚠ **変わったかの判定はここ 1 か所**(呼び側で二重に見ない)。 */
  source: string;
  /** 差し替える前の塊の HTML。**閉じるときに必ず戻す**(穴を残さない)。
   *  末尾に足した行では `''`(戻すときは消す)。 */
  originalHtml: string;
  slot: HTMLElement;
  /** 置き換えた塊が**読み幅の上限を持っていたか**(`proseSpan`)。描き直しで
   *  スロットが作り直されたときに付け直す。 */
  prose: boolean;
  textarea: HTMLTextAreaElement;
  /** 変換中(封印中)か。⚠ **boolean 1 個**(深さを数えない ── 設計 §5 契約 1)。 */
  composing: boolean;
  /** 変換中に確定を頼まれた(`compositionend` の後に実行する)。 */
  pendingCommit: boolean;
  /** 封印中に届いたパッチ(latest-wins で 1 件だけ持つ)。 */
  held: { body: string; html: string; ranges: readonly SourceRange[] } | null;
}

export class RowSwap {
  private view: BlockView = EMPTY_VIEW;
  private body = '';
  private ranges: readonly SourceRange[] = [];
  /** 塊 i の原文範囲。導出物は -1。 */
  private starts: readonly number[] = [];
  private ends: readonly number[] = [];
  private active: Active | null = null;
  /**
   * 🔴 **確定を外へ渡して、その結果の描き直しをまだ受けていない**。
   *
   * ⚠ これが要るのは `mousedown → blur(= 確定) → click` の順序のため。余白の
   * クリックで「書き足す行」を開く導線が在るので、確定のための 1 クリックが
   * **そのまま新しい行を開いてしまう**(しかも `this.body` は古いので、直後に
   * 届く描き直しが「外から変わった」と見て閉じる = 開いて即閉じる)。
   * ⚠ 時間で判定しない ── 「変わったから描き直しが来る」ことが確実な場合だけ立てる。
   */
  private awaitingUpdate = false;
  /**
   * 🔴 **行数が変わる確定の直後**(2026-08-08)。確定が行数を `delta` 動かしたのに、
   * `this.body` / `starts` / `ends` は描き直しが着弾するまで**古い座標**のまま
   * (行数が変わらない確定だけを楽観反映する ── `commitActive` の注記)。
   * この窓で開く操作は、古い座標のまま開くと**閉じ際の確定が無関係な行を潰す**
   * (S3 型のデータ破壊。着弾が先なら `closeQuietly` が守るが、確定が先なら守れない)
   * ので、行番号を新座標へ写像して `pendingOpen` に**予約**し、着弾後に開く。
   * ⚠ `update()` の「外から本文が変わったら閉じる」ガードは**緩めない** ──
   * これは「ガードに当たる状況を内側から作らない」側の修理である。
   */
  private staleAfter: { end: number; delta: number } | null = null;
  /** 予約(上記)。**開く操作が 1 つでも通ったら捨てる**(`open()` が消す)。 */
  private pendingOpen: PendingOpen | null = null;
  private readonly onClick: (ev: Event) => void;
  private readonly onDown: (ev: Event) => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: RowSwapCallbacks,
    /**
     * 🔴 **キーの割当**(#256)。⚠ **判定はここに書かない** ── 割当の正本は
     * `features/keymap.ts` の表で、この面は「自分は `row` の文脈だ」と名乗るだけ。
     * ⚠ test は自分で `new KeymapStore(...)` を渡す(共有の 1 個を汚さない)。
     */
    private readonly keymap: KeymapStore = appKeymap,
  ) {
    this.onClick = (ev: Event) => this.handleClick(ev as MouseEvent);
    this.onDown = (ev: Event) => this.handleDown(ev as MouseEvent);
    // ⚠ バブリング段で聴く(アプリ内のリンク・トグルの既定を先に奪わない)
    this.host.addEventListener('click', this.onClick, false);
    /**
     * 🔴 **範囲を広げるのは `mousedown` で受ける**(2026-08-05、実機の smoke で判明)。
     *
     * `click` まで待つと**間に合わない** ── `mousedown` の既定動作が入力欄の焦点を
     * 外し、`blur` が確定を走らせて活性が消えるので、`click` の時点では
     * 「広げる元」が居ない(実際に Shift+クリックが**ただの単独クリック**になっていた)。
     * ⚠ happy-dom は dispatch で `blur` を飛ばさないので、**unit では緑のまま壊れる**。
     */
    this.host.addEventListener('mousedown', this.onDown, false);
  }

  dispose(): void {
    this.host.removeEventListener('click', this.onClick, false);
    this.host.removeEventListener('mousedown', this.onDown, false);
    this.active?.textarea.remove();
    this.active = null;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  get isComposing(): boolean {
    return this.active?.composing === true;
  }

  /** いま編集している原文の範囲(test / 計測の観測点)。 */
  get activeRange(): { start: number; end: number } | null {
    return this.active ? { start: this.active.startLine, end: this.active.endLine } : null;
  }

  /**
   * 描画結果を面へ当てる。**分割の検証もここで持つ**(規則を 2 か所に書かない)。
   *
   * ⚠ **封印中(変換中)は当てない** ── ノードが差し替わると composition が
   * 例外もイベントも出さずに死ぬ。1 件だけ保留して `compositionend` の後に流す。
   */
  update(body: string, html: string, ranges: readonly SourceRange[]): RowSwapUpdate {
    if (this.active?.composing === true) {
      this.active.held = { body, html, ranges };
      return { ok: true, inserted: [] };
    }
    this.awaitingUpdate = false;
    // 描き直しが届いた = 座標は組み直される ── 古い座標の窓はここで閉じる
    this.staleAfter = null;
    const blocks = splitTopLevelBlocks(html);
    const part = buildBlockPartition(blocks, ranges, body.split('\n').length, scanContainers(body));
    if (!part.ok) {
      // 🔴 **壊れた分割の上で編集させない**(設計 §7-9)── 呼び側が原文編集へ退避
      return { ok: false, reason: part.reason, inserted: [] };
    }
    /**
     * 🔴 **外から本文が差し替わったら、編集中の行を閉じる**。
     *
     * 打っていた文字は**活性化した時点の行番号**を指している ── 行がずれた本文へ
     * 継ぎ足すと、無関係な行を潰す(= 静かなデータ破壊)。無言で閉じずに理由を出す。
     * ⚠ 通常の編集ではここへ来ない(確定は必ず活性を閉じてから本文を変える)。
     */
    if (this.active !== null && body !== this.body) {
      this.closeQuietly('外から本文が変わったので、編集していた行を閉じました');
    }
    this.body = body;
    this.ranges = ranges;
    this.starts = part.starts;
    this.ends = part.ends;

    const a = this.active;
    if (a === null) {
      const r = applyBlocks(this.host, html, this.view, []);
      this.view = r.view;
      this.markOpenEnds();
      // 🔴 予約(行数が変わる確定の直後の開き直し)は、分割を組み直した後に果たす
      this.openPending();
      return { ok: true, inserted: r.inserted };
    }
    /**
     * 🔑 **活性塊の添字は覚えた数字ではなく、編集している行から引き直す**
     * ── 塊の並びは描画のたびに組み直されるので、数字を信じると
     * **触っていない塊が入力欄に化ける**。
     * ⚠ ここへ来る時点で本文は活性化した時と同一(上のガード)なので、
     * 持ち主は必ず居る ── 引けなかった場合の分岐は置かない(死んだ判定になる)。
     */
    const idx = this.blockIndexForLine(a.startLine) ?? a.blockIndex;
    a.blockIndex = idx;
    // ⚠ 範囲(S6)では**まとめて 1 つの文字列**で覚える ── 1 塊ぶんだけ覚えると
    //    閉じたときに残りの塊が戻らない(本文が画面から消える)
    a.originalHtml = blocks.slice(idx, idx + a.blockCount).join('') || a.originalHtml;
    const withSlot = [...blocks];
    withSlot.splice(idx, a.blockCount, SLOT_HTML);
    /**
     * 🔴 **pin で守って当てる**(S4)。
     *
     * ⚠ **いまの配線ではここが仕事をしない**(2026-08-05 の変異試験で確認)──
     * 上のガードが「本文が同一のときだけここへ来る」を保証するので、届く HTML は
     * 前回と同じで、差分が空になる。つまり pin 無しでも textarea は生き残る。
     * それでも `[idx]` を渡すのは、**pin を落とすと S6(範囲の差し替え)と
     * 4 本目の柱(常時ライブな部品が N 個)で、生きた textarea が黙って消える**から。
     * 守り自体は `tests/adapter/apply-blocks.test.ts` が直接 pin している。
     */
    const r = applyBlocks(this.host, withSlot.join(''), this.view, [idx]);
    this.view = r.view;
    // SLOT が作り直されていたら textarea を入れ直す(pin が効いていれば起きない)
    const slot = this.host.querySelector<HTMLElement>('[data-pkc-row-slot]');
    if (slot !== null && slot !== a.slot) {
      a.slot = slot;
      // ⚠ 幅の印も**付け直す** ── 作り直したスロットは素の `<div>` なので、
      //   忘れると描き直しのたびに**段落を押した行だけ全幅へ跳ねる**
      //   (表は元から付かないので、失敗の向きはこちら)
      if (a.prose) slot.setAttribute(PROSE_ROW_ATTR, '');
      slot.append(a.textarea);
    }
    this.markOpenEnds();
    return { ok: true, inserted: r.inserted };
  }

  /**
   * 🔴 **開放終端の行に印を付ける**(S5b。user 提案)。
   *
   * ⚠ 属性を足すだけ ── ノードの数は変えないので `intact()` は崩れない。
   * ⚠ 行内とブロックで意味が違うので、種類ごとの値にする(色を分けられる)。
   */
  private markOpenEnds(): void {
    for (const el of this.host.querySelectorAll('[data-pkc-open-end]')) {
      el.removeAttribute('data-pkc-open-end');
    }
    for (const o of findOpenEnds(this.body)) {
      const i = this.blockIndexForLine(o.line);
      if (i === null) continue;
      const el = this.view.nodes[i]?.find((n): n is Element => n instanceof Element);
      if (el) el.setAttribute('data-pkc-open-end', o.kind);
    }
  }

  /**
   * 活性を畳む(描画は戻さない ── 呼び側がこの直後に全部当て直す)。
   * ⚠ **無言で閉じない**(user から見ると入力欄が消えるので、理由が要る)。
   */
  private closeQuietly(reason: string): void {
    const a = this.active;
    if (a === null) return;
    // ⚠ **先に活性を落とす**(理由は `restoreActive` と同じ ── 再入の防止)
    this.active = null;
    a.textarea.remove();
    this.cb.notify?.(reason);
  }

  private blockIndexForLine(line: number): number | null {
    for (let i = 0; i < this.starts.length; i += 1) {
      if (this.starts[i]! < 0) continue;
      if (line >= this.starts[i]! && line <= this.ends[i]!) return i;
    }
    return null;
  }

  /**
   * その y 座標は「**本文の下の余白**」か。
   *
   * 🔑 判定を 1 か所に置く(呼び手は余白クリックの 1 か所だけ)。
   * ⚠ 塊が 1 つも無いとき(空のノート)は**必ず真** ── そこが唯一の入口なので、
   *   ここを塞ぐと 1 文字も打てなくなる(`live-editor.smoke.spec.ts` の入口が依存)。
   * ⚠ 最後の**非導出**塊の下端で切る ── 脚注の区切りのような導出物は原文の行を
   *   持たないので、そこを基準にすると「余白ではない所」を余白と読む。
   * ⚠ 座標が取れない環境(happy-dom は rect が全部 0)では**真**に倒す ── 空のノートの
   *   入口を落とすより、余白の判定が緩いほうが害が小さい(選択の事故は実機の話である)。
   */
  private belowLastBlock(clientY: number): boolean {
    let last: Element | null = null;
    for (let i = this.view.nodes.length - 1; i >= 0; i -= 1) {
      if (this.starts[i] !== undefined && this.starts[i]! < 0) continue;
      const el = this.unitElement(i);
      if (el !== null) {
        last = el;
        break;
      }
    }
    if (last === null) return true; // 塊が無い = 空のノート
    const bottom = last.getBoundingClientRect().bottom;
    if (bottom === 0) return true; // rect が取れない(unit 環境)
    return clientY > bottom;
  }

  /** クリックされたノードから、それを含む塊の添字を引く。 */
  private blockIndexForNode(node: Node): number | null {
    let cur: Node | null = node;
    while (cur !== null && cur.parentNode !== this.host) cur = cur.parentNode;
    if (cur === null) return null;
    for (let i = 0; i < this.view.nodes.length; i += 1) {
      if (this.view.nodes[i]!.includes(cur)) return i;
    }
    return null;
  }

  private handleClick(ev: MouseEvent): void {
    if (ev.defaultPrevented || ev.button !== 0) return;
    // ⚠ Shift だけは受ける(S6 の範囲選択)── 他の修飾キーはアプリの操作
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    if (!(target instanceof Node)) return;
    // Shift は `mousedown` で処理済み(ここで二度やらない)
    if (ev.shiftKey) return;
    // 既に活性なら、その中のクリックは素通り(textarea 自身の操作)
    if (this.active?.slot.contains(target) === true) return;
    // ⚠ リンク・トグル・コピーボタンは奪わない(押せるものは押せたまま)
    if (target instanceof Element && target.closest('a,button,input,summary,label') !== null) return;
    const blockIndex = this.blockIndexForNode(target);
    if (blockIndex === null) {
      /**
       * 🔴 **本文の下の余白を押したら、末尾に書き足す**。
       *
       * ⚠ これが無いと**空のノートに 1 文字も打てない**(描画済み文書に押す所が
       * 無いので、行を開けない)── 実機の smoke を書いたときに気づいた。
       * ⚠ 確定の直後(`mousedown → blur → click`)には開かない ── その 1 クリックは
       * 「閉じるため」のものである。
       *
       * 🔴 **余白かどうかは「座標」で決める。DOM の同一性では決めない**
       * (2026-08-06。user 報告「編集しようとして選択すると勝手にスクロールして
       * フォーカスが外れる / スクロールが発生するくらい長くて複雑なものだけ」)。
       *
       * 直す前は `target === this.host` で判定していた。ところが **`click` の
       * target は mousedown と mouseup の共通祖先**なので、**塊を跨いでドラッグ選択
       * すると target が host 自身になる** ── 余白判定が真になり、`appendRow()` が
       * **文末**に空の入力欄を開いて `ta.focus()` が版面を文末まで引っぱっていた。
       * 実測(60 節・長文): `scrollTop` 1214 → **2457(+1243px)** / 開いた入力欄は
       * **空**(= 文末)/ **選択が消滅** / 焦点がその空欄へ移動。
       * ⚠ **文末が画面内に在る短い文書では 0px しか動かない** ── だから user の
       *   「長くて複雑なものだけ」と一致する。短い fixture では**永久に見えない**。
       * 🔑 座標で決めれば、跨ぐ選択は**何も起こさない**(選択が残る)。
       */
      if (this.belowLastBlock(ev.clientY) && !this.awaitingUpdate) this.appendRow();
      return;
    }
    if (this.starts[blockIndex] === undefined || this.starts[blockIndex]! < 0) {
      // 導出物(脚注の区切りなど)── 原文の行が無いので開かない
      this.cb.notify?.('ここは自動で作られる部分なので、直接は編集できません');
      return;
    }
    this.activate(blockIndex, target, ev.clientX, ev.clientY);
  }

  /**
   * Shift+押下 = **範囲を広げる**(S6)。⚠ 既定を止めて焦点を入力欄に残す
   * ── 止めないと `blur` が走って「広げる元」が消える。
   */
  private handleDown(ev: MouseEvent): void {
    if (ev.button !== 0 || !ev.shiftKey) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (this.active === null) return; // 開いていないなら普通の範囲選択に任せる
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (this.active.slot.contains(target)) return; // 入力欄の中の Shift は選択
    const to = this.blockIndexForNode(target);
    if (to === null) return;
    ev.preventDefault();
    this.extendTo(to);
  }

  /**
   * 予約を果たす(描き直しの着弾後)。⚠ **先に読んでから消す** ── 中で呼ぶ
   * `activateLine` / `appendRow` は `open()` 経由でもう一度消しに来る(無害)。
   */
  private openPending(): void {
    const p = this.pendingOpen;
    if (p === null) return;
    this.pendingOpen = null;
    if (p.kind === 'append') {
      this.appendRow();
      return;
    }
    if (p.kind === 'all') {
      this.activateAll();
      return;
    }
    const idx = this.blockIndexForLine(p.line);
    // 予約した行の持ち主が消えた(確定で塊が合体した等)── それ以上は追わない
    if (idx !== null) this.activateLine(idx, p.caret);
  }

  /**
   * 🔴 **開いた瞬間に、その行の塊を活性にする**(#395 段③)。
   *
   * > user の物語: 読んでいる本文の「この行」を直したい。
   *
   * ⚠ **すぐには開かない** ── 呼ばれる時点ではまだ分割が組まれていない
   *   (`update` が来ていない)。既にある予約の仕組みに載せて、**最初の描き直しで
   *   果たす**(`openPending`)。⚠ 行の持ち主が居なければ何も起きない
   *   ── そこは正しい(当てずっぽうで別の塊を開かない)。
   * @param line 原文の行(0 始まり・**frontmatter を外した側**の座標)
   */
  openAt(line: number): void {
    this.pendingOpen = { kind: 'line', line, caret: 'end' };
  }

  /** 添字の塊を、caret を端に置いて開く(矢印キーと予約の共通口)。 */
  private activateLine(blockIndex: number, caretAt: 'start' | 'end'): boolean {
    return this.activate(blockIndex, this.unitElement(blockIndex) ?? this.host, 0, 0, caretAt);
  }

  /**
   * 活性化。**最小の刻印要素**(表の行 / 箇条書きの項目 / それ以外は塊)を狙う。
   * @param caretAt 座標の無い開き方(矢印キー / 予約)の caret。`'end'` だけが
   *   意味を持つ ── `'start'` は座標なしの `caretOffset` と同じ 0 に落ちる。
   */
  activate(
    blockIndex: number,
    target: Node,
    clientX = 0,
    clientY = 0,
    caretAt?: 'start' | 'end',
  ): boolean {
    if (this.active !== null && !this.commitActive()) return false;
    const blockStart = this.starts[blockIndex];
    const blockEnd = this.ends[blockIndex];
    if (blockStart === undefined || blockEnd === undefined || blockStart < 0) return false;
    if (this.staleAfter !== null) {
      /**
       * 🔴 座標が古い窓(行数が変わる確定の直後)── **開かずに予約する**。
       * 直す前は古い座標のまま開いていた: 着弾が先なら `closeQuietly` が閉じて
       * 「外から本文が変わった」という**嘘の理由**が出るだけだが、確定が先なら
       * **古い行番号の splice が無関係な行を潰す**。編集の後ろの塊は `delta` だけ
       * ずれている(前の塊はずれない)ので、写像してから積む。
       */
      const line =
        blockStart + (blockStart > this.staleAfter.end ? this.staleAfter.delta : 0);
      this.pendingOpen = { kind: 'line', line, caret: caretAt ?? 'start' };
      return true;
    }

    const sub = this.resolveSubUnit(blockIndex, blockStart, blockEnd, target);
    const startLine = sub?.start ?? blockStart;
    /**
     * 🔑 **末尾の空行は編集範囲に入れない**(2026-08-05 に実測でつかんだ)。
     * 箇条書きや引用の token 範囲は**後ろの空行まで含む**(`bullet_list_open` の
     * map が [9, 12) など)ので、そのままだと入力欄に空行がぶら下がって見え、
     * user が消すと**塊の切れ目が消えて後続と合体する**。
     * ⚠ 縮めるのは**編集範囲だけ** ── 分割表(`ends`)は触らない(全域性の検証と
     * 開放終端の持ち主判定がそこに乗っている)。
     */
    const endLine = shrinkTrailingBlank(this.body, startLine, sub?.end ?? blockEnd);
    const source = this.body.split('\n').slice(startLine, endLine + 1).join('\n');
    /**
     * 🔑 **列は差し替える前に測る**(2026-08-05 に外した)── `applyBlocks` を
     * 通した後の要素は DOM から外れていて、座標から caret が引けない。
     */
    const caret =
      caretAt === 'end'
        ? source.length
        : this.caretOffset(sub?.element ?? this.unitElement(blockIndex), source, clientX, clientY);

    const withSlot = [...this.view.blocks];
    withSlot[blockIndex] = SLOT_HTML;
    return this.open({
      blockIndex,
      blockCount: 1,
      startLine,
      endLine,
      source,
      originalHtml: this.view.blocks[blockIndex] ?? '',
      withSlot,
      caret,
      prose: this.proseSpan(blockIndex, blockIndex),
    });
  }

  /**
   * 🔴 **末尾に新しい行を開く**(空のノート / 余白を押して書き足す)。
   *
   * ⚠ **差し替えではなく挿入**なので、範囲は `[行数, 行数 - 1]`(空区間)にする
   * ── `commit` の継ぎ足し規則(`slice(0,start) + text + slice(end+1)`)が
   * そのまま「末尾に足す」になる。規則を 2 つ書かない。
   * ⚠ ただし**本文が空白だけ**のときは範囲を全体にする(先頭に空行を作らない)。
   */
  appendRow(): boolean {
    if (this.active !== null && !this.commitActive()) return false;
    if (this.staleAfter !== null) {
      // 🔴 座標が古い窓 ── 古い body で末尾を数えない(着弾後に開く。`activate` と同じ)
      this.pendingOpen = { kind: 'append' };
      return true;
    }
    const lines = this.body.split('\n');
    const blank = this.body.trim() === '';
    const startLine = blank ? 0 : lines.length;
    const endLine = lines.length - 1;
    // 末尾に SLOT を 1 つ足す(戻すときは `originalHtml: ''` = 消える)
    return this.open({
      blockIndex: this.view.blocks.length,
      blockCount: 1,
      startLine,
      endLine,
      source: '',
      originalHtml: '',
      withSlot: [...this.view.blocks, SLOT_HTML],
      caret: 0,
      /**
       * 🔴 **末尾に足す行は「直前の塊」に揃える**(2026-08-08 の 2 巡目レビュー)。
       *
       * 置き換える塊が無いので、一度は「掛けない側へ倒す」と書いたが、それだと
       * **余白を押して書き始めた瞬間だけ全幅**になり、確定した途端に段落として
       * 42rem へ組み直される ── 打っている間と確定後で折り返しが変わる。
       * 余白クリックと最終行の ↓ は**散文の続きを書く一番普通の導線**なので、
       * 直前の塊に合わせるのが「同じ紙の上で 1 行だけ生になる」と釣り合う。
       * ⚠ 空のノート(塊 0 件)は散文として開く ── 最初に書くのはほぼ散文である。
       */
      prose:
        this.view.blocks.length === 0
          ? true
          : this.proseSpan(this.view.blocks.length - 1, this.view.blocks.length - 1),
    });
  }

  /**
   * 🔴 **全文を 1 つの入力欄にする**(S6。`Ctrl+A`)。
   *
   * これが入ると **今日の 2 列の編集画面が 1 面の縮退形になる** ── 「行ごとに
   * 編集する画面」と「全文を編集する画面」が別物ではなく、同じ機構の両端になる
   * (設計 §6 S6)。長い本文を丸ごと直したいときの逃げ道でもある。
   *
   * ⚠ 範囲は**本文の全部**(先頭の空行も含む)── 「全選択」の意味を曲げない。
   */
  activateAll(): boolean {
    if (this.active !== null && !this.commitActive()) return false;
    /**
     * 🔴 座標が古い窓では**開かずに予約する**(`activate` / `appendRow` と同じ)。
     * ⚠ 2026-08-08 の 2 巡目レビューで見つけた **データ破壊**の口である ──
     * ここだけ守りが無く、`openSpan` が**進んでいない古い `this.body`** を読んでいた。
     * 実測(再現 test): `A\n\nB\n\nC` の `A` を `A1\nA2` に打ち替えて確定した直後に
     * これを撃つと、入力欄には**打つ前の姿**が出る。そこで 1 文字足して確定すると
     * `cb.commit(0, 4, …)` が新しい本文へ**古い行番号で**当たり、
     * `A\n\nB\n\nCX\nC` ── **打ち替えが消え、末尾行が複製される**。無言で起きる。
     * ⚠ 「片側を直したら対称の反対側を疑う」── 3 つの入口のうち 2 つだけ直っていた。
     */
    if (this.staleAfter !== null) {
      this.pendingOpen = { kind: 'all' };
      return true;
    }
    if (this.view.blocks.length === 0) return this.appendRow();
    const lines = this.body.split('\n');
    return this.openSpan(0, this.view.blocks.length - 1, 0, shrinkTrailingBlank(this.body, 0, lines.length - 1));
  }

  /**
   * 🔴 **範囲差し替え**(S6。Shift+クリック)。クリックした塊まで広げる。
   *
   * ⚠ **打ち替えた後は広げない** ── 広げるには一度確定する必要があり、確定の
   * 結果の描き直しは**非同期で届く**ので、その前に広げると古い行番号で範囲を
   * 作ってしまう(S5 で `awaitingUpdate` を置いたのと同じ罠)。
   * 打ち替えてあるときは確定だけして、理由を出す。
   */
  extendTo(blockIndex: number): boolean {
    const a = this.active;
    if (a === null) return false;
    if (a.textarea.value !== a.source) {
      this.commitActive();
      this.cb.notify?.('確定しました ── もう一度 Shift+クリックで範囲を選べます');
      return false;
    }
    const from = Math.min(a.blockIndex, blockIndex);
    const to = Math.max(a.blockIndex + a.blockCount - 1, blockIndex);
    // 打ち替えていないので、そのまま閉じて広げ直せる(本文は動いていない)
    this.restoreActive();
    return this.openSpan(from, to);
  }

  /**
   * 塊 `[from, to]` を 1 つの入力欄にする。
   * ⚠ 行の範囲は**範囲内の塊が持つ実際の行**から出す(導出物 = -1 は数えない)。
   */
  private openSpan(from: number, to: number, forceStart?: number, forceEnd?: number): boolean {
    // ⚠ 空の範囲は開かない ── 通すと `blockCount: 0` の活性ができ、次の描き直しで
    //    SLOT が 1 つずつ増える(2026-08-05 の変異試験で露見した抜け)
    if (to < from) return false;
    let startLine = forceStart ?? Number.POSITIVE_INFINITY;
    let endLine = forceEnd ?? -1;
    if (forceStart === undefined || forceEnd === undefined) {
      for (let i = from; i <= to; i += 1) {
        const s = this.starts[i];
        const e = this.ends[i];
        if (s === undefined || s < 0 || e === undefined) continue;
        if (forceStart === undefined && s < startLine) startLine = s;
        if (forceEnd === undefined && e > endLine) endLine = e;
      }
    }
    if (!Number.isFinite(startLine) || endLine < startLine) return false;
    const end = shrinkTrailingBlank(this.body, startLine, endLine);
    const source = this.body.split('\n').slice(startLine, end + 1).join('\n');
    const withSlot = [...this.view.blocks];
    const replaced = withSlot.splice(from, to - from + 1, SLOT_HTML);
    return this.open({
      blockIndex: from,
      blockCount: to - from + 1,
      startLine,
      endLine: end,
      source,
      // ⚠ 戻すときは**まとめて 1 つの文字列**で置く(`applyBlocks` が再分割する)
      originalHtml: replaced.join(''),
      withSlot,
      caret: 0,
      prose: this.proseSpan(from, to),
    });
  }

  /**
   * 🔴 **スロットの幅は「置き換えた塊が持っていた上限」に揃える**(2026-08-08)。
   *
   * 読み幅(紙面フォーマット)は**散文だけ**に掛かる allow-list である。
   * スロットを一律に散文の幅にすると、**表を押した瞬間に編集欄が縮む**
   * ── 実測(1600px の窓): 表 1036px → 編集欄 **672px**、`| 第 1 列 | …` の
   * 106 字が 2 行に折り返した。逆に一律で外すと、段落を押した行だけ全幅へ跳ねる。
   *
   * 🔑 **CSS の allow-list を JS に写さない** ── allow-list の規則が自分で立てる印
   *    (`--pkc-prose-block: 1`)を読む。判定の正本は `app.css` の 1 か所のまま。
   * 🔴 **`max-width` の有無で代用してはいけない**(2026-08-08 の 2 巡目レビューで
   *    実証)── 読み幅と無関係な `max-width` が在る(`[data-pkc-mermaid-src]` の
   *    `100%`)ので、「上限が在るか」で見ると**図を押した編集欄まで散文の幅に縮む**。
   *    表とコードでだけ直って図で残る、という取りこぼしを実際にやった。
   *    ⚠ **代替物で満たせる条件をガードにしない**(CLAUDE.md の反復する型)。
   * ⚠ 範囲(S6 の `Ctrl+A` / Shift+クリック)は**1 つでも全幅の塊が居れば外す**
   *    ── allow-list が「掛からない側へ倒れる」のと同じ安全な向き。
   * ⚠ **測るのは差し替える前**(`applyBlocks` を通した後の要素は DOM の外)。
   * ⚠ 印は**塊の要素そのもの**でだけ見る ── カスタムプロパティは下へ継承するので、
   *    子孫で読むと散文の中の表まで「散文」になる。
   */
  private proseSpan(from: number, to: number): boolean {
    let seen = false;
    for (let i = from; i <= to; i += 1) {
      const el = this.view.nodes[i]?.find((n): n is Element => n instanceof Element);
      if (el === undefined) continue;
      seen = true;
      if (getComputedStyle(el).getPropertyValue('--pkc-prose-block').trim() !== '1') return false;
    }
    /**
     * ⚠ **`seen === false`(要素を 1 つも持たない塊)には、どの test も到達しない**
     * ── 2026-08-08 に `throw` を置いて確かめた(全 2519 件で 1 度も発火せず)。
     * 塊は必ず要素から始まる HTML を parse して作るので、実際には起きない。
     * だから `return true` へ書き換える変異は**構造上殺せない**。
     * 🔑 それでも `seen` を残すのは、起きたときに**掛けない側へ倒れる**ため
     *   (allow-list と同じ安全な向き)。**守られていない枝だと自覚して使う**。
     */
    return seen;
  }

  /** 差し替え / 挿入の共通部分(入力欄を出して契約を張る)。 */
  private open(o: {
    blockIndex: number;
    blockCount: number;
    startLine: number;
    endLine: number;
    source: string;
    originalHtml: string;
    withSlot: readonly string[];
    caret: number;
    /** 置き換えた塊に読み幅の上限が在ったか(`proseSpan`)。 */
    prose: boolean;
  }): boolean {
    // 実際に開けたなら予約は用済み(古い予約が後から焦点を奪わないように)
    this.pendingOpen = null;
    const r = applyBlocks(this.host, o.withSlot.join(''), this.view, [o.blockIndex]);
    this.view = r.view;
    if (r.inserted.length > 0) this.cb.onInserted(r.inserted);
    const slot = this.host.querySelector<HTMLElement>('[data-pkc-row-slot]');
    if (slot === null) return false;
    if (o.prose) slot.setAttribute(PROSE_ROW_ATTR, '');

    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'row-source');
    // ⚠ 読み上げから見て無名にしない(2026-08-19 の全数監査)── 1 面編集は
    //    「いま開いている行」を編むので、本文全体と**別の名前**にする
    ta.setAttribute('aria-label', 'この行の原文');
    ta.value = o.source;
    slot.append(ta);

    this.active = {
      blockIndex: o.blockIndex,
      blockCount: o.blockCount,
      startLine: o.startLine,
      endLine: o.endLine,
      source: o.source,
      originalHtml: o.originalHtml,
      slot,
      prose: o.prose,
      textarea: ta,
      composing: false,
      pendingCommit: false,
      held: null,
    };
    this.wire(ta);
    // ⚠ 高さは `syncActiveBox` が 1 か所で決める(上限つき ── S6 の全文差し替えで
    //    5000 行の箱を作らない)。ここで別に代入しない
    this.syncActiveBox();
    ta.focus();
    ta.setSelectionRange(o.caret, o.caret);
    return true;
  }

  /** 塊を作っている最初の要素。 */
  private unitElement(blockIndex: number): Element | null {
    return this.view.nodes[blockIndex]?.find((n): n is Element => n instanceof Element) ?? null;
  }

  /**
   * 表の行 / 箇条書きの項目まで降りる。⚠ **同じ塊の中で何番目か**で対応させる
   * (刻印を DOM に焼かないので、順番で結ぶ)。
   */
  private resolveSubUnit(
    blockIndex: number,
    blockStart: number,
    blockEnd: number,
    target: Node,
  ): { start: number; end: number; element: Element } | null {
    const root = this.unitElement(blockIndex);
    if (root === null) return null;
    const el = target instanceof Element ? target : target.parentElement;
    if (el === null) return null;
    for (const u of SUB_UNITS) {
      const hit = el.closest(u.selector);
      if (hit === null || !root.contains(hit)) continue;
      const all = [...root.querySelectorAll(u.selector)];
      const k = all.indexOf(hit);
      if (k < 0) continue;
      // 同じ塊の範囲に入る、その型の範囲を**文書順**に並べる(DOM の順と揃う)
      const within = this.ranges.filter(
        (r) => r.type === u.type && r.start >= blockStart && r.end <= blockEnd,
      );
      const r = within[k];
      if (r === undefined) continue;
      return { start: r.start, end: r.end, element: hit };
    }
    return null;
  }

  /** クリック座標 → 原文の文字位置。求まらなければ 0(= その行の先頭)。 */
  private caretOffset(el: Element | null, source: string, x: number, y: number): number {
    if (el === null || (x === 0 && y === 0)) return 0;
    const doc = el.ownerDocument as Document & {
      caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (px: number, py: number) => Range | null;
    };
    let node: Node | null = null;
    let offset = 0;
    const cp = doc.caretPositionFromPoint?.(x, y);
    if (cp) {
      node = cp.offsetNode;
      offset = cp.offset;
    } else {
      const range = doc.caretRangeFromPoint?.(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
    if (node === null || !el.contains(node)) return 0;
    // 要素の描画テキストの中で何文字目か
    let seen = 0;
    const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
    let n: Node | null = walker.nextNode();
    while (n !== null) {
      if (n === node) {
        seen += offset;
        break;
      }
      seen += (n.textContent ?? '').length;
      n = walker.nextNode();
    }
    return mapVisibleToSource(source, el.textContent ?? '', seen).offset;
  }

  /** textarea に契約を張る(IME / 確定の引き金 / auto pair)。 */
  private wire(ta: HTMLTextAreaElement): void {
    ta.addEventListener('compositionstart', () => {
      const a = this.active;
      if (a) a.composing = true;
    });
    ta.addEventListener('compositionend', () => {
      const a = this.active;
      if (!a) return;
      // ⚠ 意味は「**封印が解けた**」だけ ── 確定の引き金にしない(実測 2)
      a.composing = false;
      const held = a.held;
      a.held = null;
      if (held) this.update(held.body, held.html, held.ranges);
      if (a.pendingCommit) {
        a.pendingCommit = false;
        this.commitActive();
      }
    });
    /**
     * 🔴 **`isComposing` で return しない**(実測: 確定を運ぶ `input` 自身が
     * `isComposing === true` で、その後に `input` は来ない)。ここでやるのは
     * **属性だけ**(高さと色)なので、封印中に呼ばれても composition は壊れない。
     */
    ta.addEventListener('input', () => {
      this.syncActiveBox();
    });
    ta.addEventListener('keydown', (ev) => {
      const ke = ev as KeyboardEvent;
      // ⚠ 変換中のキーは**全部** IME のもの(実測: Enter / Tab / Escape すべて isComposing)
      if (ke.isComposing) return;
      const cmd = this.keymap.match(ke, 'row');
      if (cmd === 'row-cancel') {
        ev.preventDefault();
        this.cancelActive();
        return;
      }
      if (cmd === 'row-commit') {
        ev.preventDefault();
        this.commitActive();
        return;
      }
      /**
       * 🔴 **`Ctrl/Cmd+S` も「行の確定」**(2026-08-08)── ここで受けないと
       * **ブラウザの保存ダイアログが開く**(binder の門は `editor-body` /
       * `editor-title` だけを見るので、行の入力欄には届かない)。
       * ⚠ 意味は Tab と同じ「行の確定」で、編集の面は続く。`COMMIT_EDIT` は
       * 撃たない(それは編集の面ごと閉じる別の操作である)。
       * 🔑 いまは `row-commit` の別名として **1 か所(keymap の表)**に在る。
       */
      if (cmd === 'row-next' || cmd === 'row-prev') {
        this.arrowMove(ev as KeyboardEvent, cmd === 'row-next');
        return;
      }
      this.autoPair(ke);
    });
    /**
     * ⚠ 変換中の `blur` を**ここで判定しない** ── `commitActive()` が
     * 「変換中なら `pendingCommit` に回して確定しない」を持っている(実測の順序は
     * blur → compositionend)。2026-08-05 の変異試験で**同じ判定が 2 か所**に
     * 在ることが露見した(片方を壊しても誰も気づかない = どちらが効いているか
     * 分からない)ので、規則は `commitActive()` の 1 か所に寄せる。
     */
    ta.addEventListener('blur', () => {
      this.commitActive();
    });
    /**
     * 🔴 **安全弁**(設計 §5 契約 7)。変換中なのに焦点が外れていたら封印を解く
     * ── DOM を触られると `compositionend` が来ないことがあり、待つ実装は永久に固まる。
     */
    ta.addEventListener('focusout', () => {
      const a = this.active;
      if (a && a.composing && a.textarea.ownerDocument.activeElement !== a.textarea) {
        a.composing = false;
      }
    });
  }

  /**
   * 🔴 **打っている最中の開放終端**(S5b。user 提案「行を色変え」)。
   *
   * ⚠ 描画は 1 回も起こさない ── 見ているのは**活性 textarea の中身だけ**で、
   * 付けるのも SLOT の属性 1 個である(封印中に呼ばれても安全)。
   */
  private syncActiveBox(): void {
    const a = this.active;
    if (!a) return;
    /**
     * 高さは中身に合わせる(属性だけ ── 封印中に呼ばれても composition は壊れない)。
     * ⚠ **上限を置く**(S6)── `Ctrl+A` の全文差し替えでは 5000 行の箱ができて
     * しまい、面の scroll が二重になる。上限に当たったら箱の中で scroll させる。
     */
    const logical = Math.max(1, a.textarea.value.split('\n').length);
    a.textarea.rows = Math.min(logical, ROWS_CAP);
    /**
     * 🔴 **折り返した先も数える**(2026-08-15、user 報告「1 行の選択をすると
     * 表示が適切なサイズのテキストブロックにならないため編集しにくい」)。
     *
     * ⚠ 改行の数だけで高さを決めていたので、**長い 1 段落は必ず `rows=1`** になり、
     * CSS が `overflow: hidden` なので**末尾しか見えない 1 行の窓**に押し込まれていた
     * (画面には文の途中から出る)。原文は折り返して表示されるのだから、
     * 数えるべきは改行ではなく**視覚の行**である。
     * 🔑 測るのは**上限に届いていないときだけ** ── 届いていれば箱の中で scroll させる
     * ので、それ以上の測定は要らない(打鍵ごとの reflow を増やさない)。
     */
    const wanted = logical < ROWS_CAP ? logical + wrappedExtraRows(a.textarea) : logical;
    if (wanted !== logical) a.textarea.rows = Math.min(wanted, ROWS_CAP);
    if (wanted > ROWS_CAP) a.textarea.setAttribute('data-pkc-scroll', '1');
    else a.textarea.removeAttribute('data-pkc-scroll');
    const open = findOpenEnds(a.textarea.value);
    const block = open.find((o) => o.kind !== 'inline') ?? open[0];
    if (block === undefined) a.slot.removeAttribute('data-pkc-open-end');
    else a.slot.setAttribute('data-pkc-open-end', block.kind);
  }

  /**
   * 🔴 **Alt+カーソルキーで隣の塊へ**(2026-08-15。user 指示「上下方向キー押下で
   * 次のブロックに飛んでしまうため、Alt+方向キーのように操作の暴発を防ぐ動線が欲しい」)。
   *
   * ⚠ **2026-08-08 の「カーソルキーで下に行く」を、user の再裁定で置き換えた。**
   * 旧実装は「改行が無い側に居るか」で端を判定していたが、原文は**折り返して**
   * 表示されるので、長い 1 段落は**箱のどこに居ても端**だった ── 素の ↓ が
   * 必ず隣へ飛ぶ(= user の言う暴発)。⚠ 高さを直しても**この判定は直らない**
   * (視覚の端と改行の端が別物である以上、素のキーで両立できない)。
   * 🔑 だから**修飾キーで意図を明示させる**:素の ↑↓ は箱の中だけを動き、
   * `Alt+↑↓` が塊の移動になる ── 選択の戻る進む(`Alt+←→`)と同じ流儀に揃う。
   *
   * ⚠ Alt が付いている以上、**箱の中の位置は問わない**(端に居なくても移る)。
   * Shift / Ctrl / Meta との併せ押しは奪わない(選択の拡張・OS の割り当て)。
   * 確定してから隣の**編集できる塊**(導出物 = `starts < 0` は飛ばす)を開く:
   * ↓ は次の塊の先頭へ、↑ は前の塊の末尾へ。末尾の塊で ↓ は末尾に書き足す
   * (余白クリックと同じ意味論 = `appendRow`)。
   * ⚠ 行数が変わる確定の座標ずれは `activate` / `appendRow` の予約が持つ ──
   * ここに 2 本目の座標計算を書かない。
   */
  private arrowMove(ke: KeyboardEvent, down: boolean): void {
    const a = this.active;
    if (a === null) return;
    const ta = a.textarea;
    let next: number | null = null;
    if (down) {
      for (let i = a.blockIndex + a.blockCount; i < this.starts.length; i += 1) {
        if (this.starts[i]! >= 0) {
          next = i;
          break;
        }
      }
    } else {
      for (let i = Math.min(a.blockIndex, this.starts.length) - 1; i >= 0; i -= 1) {
        if (this.starts[i]! >= 0) {
          next = i;
          break;
        }
      }
    }
    // 先頭より上には行けない ── 既定(その行の先頭へ動くだけ)に任せる
    if (!down && next === null) return;
    // 何も打っていない書き足し行(範囲が空)で ↓ ── 開き直しても同じ行なので何もしない
    if (down && next === null && a.endLine < a.startLine && ta.value === a.source) return;
    ke.preventDefault();
    if (next === null) this.appendRow();
    else this.activateLine(next, down ? 'start' : 'end');
  }

  /**
   * 🔴 **auto pair**(S5c。user 提案「開放終端をそもそも作りにくくする機構」)。
   *
   * ⚠ **規則は持たない** ── 何を補うかは `features/markdown/text-ops.ts` の
   * `autoPairFor`(pure)が決める。ここは「挿して caret を置く」だけ
   * (規則を DOM 側に 2 本目書かない ── 設計 §5.6 ②)。
   * ⚠ **変換中は撃たない**。判定は**呼び側の `ke.isComposing` 1 か所**
   * (2026-08-05 の変異試験:ここに `a.composing` を重ねると、片方を壊しても
   * 誰も気づかない状態になっていた。実測が支えているのは `ke.isComposing`)。
   * ⚠ 挿入は `execCommand('insertText')` ── **undo に載る**
   * (`value` 直代入は Ctrl+Z で戻せない)。
   */
  private autoPair(ke: KeyboardEvent): void {
    const a = this.active;
    if (!a) return;
    const ta = a.textarea;
    const pair = autoPairFor({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, ke.key);
    if (pair === null) return;
    ke.preventDefault();
    /**
     * ⚠ **通り抜けは「挿さない」** ── caret を動かすだけ。
     *   空文字を `execCommand('insertText')` で撃つと **undo の粒度が変わる**
     *   ので、ここで分ける(規則は `text-ops.ts` 側が決める。ここは挿す係)。
     */
    if (pair.kind === 'insert') insertText(ta, pair.insert);
    ta.setSelectionRange(pair.start, pair.end);
    this.syncActiveBox();
  }

  /** 確定して閉じる。⚠ 変換中は確定しない(`pendingCommit` に回す)。 */
  commitActive(): boolean {
    const a = this.active;
    if (a === null) return true;
    if (a.composing) {
      a.pendingCommit = true;
      return false;
    }
    const text = a.textarea.value;
    const start = a.startLine;
    const end = a.endLine;
    /**
     * 🔑 **変わったかの判定はここ 1 か所**(開いた時の原文と比べる)。
     * ⚠ 呼び側(`detail.ts`)にも同じ判定を置かない ── 同じ規則が 2 か所に
     * 生えると、片方を壊しても誰も気づかない(2026-08-05 の変異試験の教訓)。
     */
    const changed = text !== a.source;
    /**
     * 🔴 **閉じていないまま戻ったら、理由を出す**(S5b の残り)。確定は止めない
     * ── 止めると移動できない罠になる。
     */
    const stillOpen = findOpenEnds(text).find((o) => o.kind !== 'inline');
    this.restoreActive();
    if (stillOpen !== undefined) {
      this.cb.notify?.(
        `${stillOpen.what} が閉じていないので、ここから下がまとめて表示されます`,
      );
    }
    if (!changed) return true;
    /**
     * 🔴 **自分の確定は自分で反映する**(楽観更新。2026-08-06)。
     *
     * 直す前は `this.body` を古いまま置いて外へ投げていた。すると:
     *
     * ① **打った文字が黙って消える**(実測)── Tab を押さずに次の塊を直接押すと、
     *    `mousedown → blur(確定) → click(次を開く・focus)` の後に **worker の
     *    描き直しが着弾**し、`body !== this.body` を見て `closeQuietly()` が
     *    **開いたばかりの入力欄を remove** する。打ちかけは `commit` を通らないので
     *    消える(実測: 入力欄 0 件 / 焦点 `BODY` / 打った "ZZ" は行方不明)。
     *    IME なら**確定済みの日本語**が同じ枝で消える。
     * ② 🔴 **原文が静かに壊れる** ── `activate()` は `this.body` / `starts` を
     *    **古い座標**で読む。行数が変わる確定の直後に 2 回クリックすると、
     *    2 度目の `commit` が**古い座標**で新しい本文へ継ぎ足され、**無関係な行を潰す**。
     *    例外も notify も出ない。
     *
     * 🔑 だから `closeQuietly` のガードは**緩めない** ── 代わりに「通常の編集では
     * ここへ来ない」という上のコメントを**真にする**。自分の確定ぶんを先に反映すれば
     * 着弾時に `body === this.body` になり、ガードは「本当に外から変わった時」だけ鳴る。
     * ⚠ 継ぎ足しの規則は `edit-journal` の 1 本を使う(`detail.ts` と同じ関数)──
     *   ここに 2 本目の文字列操作を書かない。
     * ⚠ `follower` は latest-wins で途中の 1 件を捨てるので、**積み上げる形**
     *   (`this.body` を毎回進める)でなければ連続確定に合わない。
     */
    /**
     * 🔑 **行数が変わらない確定だけ**を自分で反映する。
     *
     * ⚠ 行数が変わると、後続の塊の原文座標が全部ずれる ── その窓の間の
     *   開く操作は `staleAfter` が予約に写像する(2026-08-08。かつてここに
     *   在った「open() が slot === null で false を返して次の塊が開けない」の
     *   記録は不正確だった ── 実際は**古い座標のまま開いて**、着弾の
     *   `closeQuietly` に嘘の理由(「外から本文が変わった」)で閉じられていた。
     *   着弾より先に確定されると古い行番号の splice が無関係な行を潰す)。
     * ⚠ delta ≠ 0 では `this.body` を**進めない** ── 平行移動の算術で user の
     *   原文を書き換えるより、着弾の組み直しに任せるほうが安全である。
     * 🔑 実際の編集はほとんど行数が変わらない(1 行の言い直し・語句の直し)。
     */
    if (text.split('\n').length === end - start + 1) {
      this.body = spliceLines(this.body, start, end, text);
    } else {
      // 🔴 古い座標の窓が開いた ── 着弾(`update()`)まで、開く操作は予約になる
      this.staleAfter = { end, delta: text.split('\n').length - (end - start + 1) };
    }
    // 描き直しが必ず来る ── その 1 件を受けるまで、余白のクリックで行を開かない
    this.awaitingUpdate = true;
    this.cb.commit(start, end, text);
    return true;
  }


  /** 捨てて閉じる(原文は変えない)。 */
  cancelActive(): void {
    const a = this.active;
    if (a === null) return;
    if (a.composing) {
      // ⚠ 変換中の取り消しは IME のものなので、こちらは何もしない
      return;
    }
    this.restoreActive();
  }

  /**
   * 活性を畳んで、**差し替える前の描画へ戻す**。
   *
   * ⚠ SLOT を空のまま残さない ── 確定でも取り消しでも、まず画面を正しい形に
   * 戻してから外へ知らせる(`commit` が「変わっていない」で描き直さない場合が在る)。
   */
  private restoreActive(): void {
    const a = this.active;
    if (a === null) return;
    /**
     * 🔴 **DOM を触る前に活性を落とす**(2026-08-05、実機の smoke で捕まえた)。
     *
     * 焦点のある `<textarea>` を DOM から外すと、Chromium は **同期で `blur` を
     * 飛ばす**。`blur` の handler は `commitActive()` を呼ぶので、活性が残っていると
     * ① **二重に確定する**(同じ編集が 2 回 `commit` される)
     * ② 内側の `restoreActive` が view を組み直した後、外側が**古い添字**で
     *    もう一度当てて `NotFoundError` で落ちる(実際に pageerror が出た)
     * ⚠ happy-dom は `remove()` で `blur` を飛ばさないので、unit だけでは出ない。
     */
    this.active = null;
    a.textarea.remove();
    const blocks = [...this.view.blocks];
    blocks[a.blockIndex] = a.originalHtml;
    const r = applyBlocks(this.host, blocks.join(''), this.view, []);
    this.view = r.view;
    // 🔴 **閉じると塊は作り直される** ── 貸していた `<img>` の `src` はここで
    //    失われるので、入った要素を外へ渡して差し直させる(#250)
    if (r.inserted.length > 0) this.cb.onInserted(r.inserted);
    this.markOpenEnds();
  }
}

/**
 * 末尾の空行を落とした終了行を返す(`start` より前には縮めない)。
 * ⚠ 空白だけの行も空行として扱う(markdown の段落の切れ目は空白行でも成立する)。
 */
function shrinkTrailingBlank(body: string, start: number, end: number): number {
  const lines = body.split('\n');
  let e = end;
  while (e > start && (lines[e] ?? '').trim() === '') e -= 1;
  return e;
}

/** undo に載る形で挿す。⚠ `value` 直代入は取り消せない飾りになる。 */
export function insertText(ta: HTMLTextAreaElement, text: string): void {
  const doc = ta.ownerDocument as Document & {
    execCommand?: (cmd: string, ui?: boolean, value?: string) => boolean;
  };
  const ok = doc.execCommand?.('insertText', false, text) ?? false;
  if (ok) return;
  /**
   * fallback(happy-dom など `execCommand` が無い環境 / ブラウザが断った場合)。
   *
   * 🔴 **本物の意味論を真似る**(2026-08-18、着地前レビュー)── ここが
   * `execCommand` と違う振る舞いをすると、**unit はこちらしか通らない**ので
   * 差が test から見えなくなる(CLAUDE.md §3「stub は本物の意味論を真似る」)。
   * ⚠ 揃えるのは 2 つ:
   * ① **caret を進める** ── 進めないと 2 枚目が 1 枚目の**前**に入る(逆順になる)
   * ② **`input` を撃つ** ── 撃たないと `UPDATE_OPEN_BODY` が走らず、
   *   **画面には見えているのに保存された本文には無い**(2 列の保存は state を書く)
   */
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const at = (s ?? value.length) + text.length;
  ta.value = value.slice(0, s ?? value.length) + text + value.slice(e ?? s ?? value.length);
  ta.selectionStart = at;
  ta.selectionEnd = at;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
