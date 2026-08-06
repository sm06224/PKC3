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

/** 活性塊の代わりに置く定数。⚠ **中身が固定**なので差分の対象から自然に外れる。 */
const SLOT_HTML = '<div data-pkc-row-slot="1"></div>';

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
}

/** `update()` の返り。⚠ `ok: false` は**行の差し替えを開かない**という意味。 */
export interface RowSwapUpdate {
  ok: boolean;
  reason?: string;
  /** 新しく DOM に入った要素(呼び側が図の面倒を見る対象)。 */
  inserted: Element[];
}

interface Active {
  /** 塊の添字(`view.blocks` の中)。⚠ 描き直しのたびに引き直す。 */
  blockIndex: number;
  startLine: number;
  endLine: number;
  /** 開いた時の原文。⚠ **変わったかの判定はここ 1 か所**(呼び側で二重に見ない)。 */
  source: string;
  /** 差し替える前の塊の HTML。**閉じるときに必ず戻す**(穴を残さない)。
   *  末尾に足した行では `''`(戻すときは消す)。 */
  originalHtml: string;
  slot: HTMLElement;
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
  private readonly onClick: (ev: Event) => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: RowSwapCallbacks,
  ) {
    this.onClick = (ev: Event) => this.handleClick(ev as MouseEvent);
    // ⚠ バブリング段で聴く(アプリ内のリンク・トグルの既定を先に奪わない)
    this.host.addEventListener('click', this.onClick, false);
  }

  dispose(): void {
    this.host.removeEventListener('click', this.onClick, false);
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
    a.originalHtml = blocks[idx] ?? a.originalHtml;
    const withSlot = [...blocks];
    withSlot[idx] = SLOT_HTML;
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
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const target = ev.target;
    if (!(target instanceof Node)) return;
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
       */
      if (target === this.host && !this.awaitingUpdate) this.appendRow();
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
   * 活性化。**最小の刻印要素**(表の行 / 箇条書きの項目 / それ以外は塊)を狙う。
   */
  activate(blockIndex: number, target: Node, clientX = 0, clientY = 0): boolean {
    if (this.active !== null && !this.commitActive()) return false;
    const blockStart = this.starts[blockIndex];
    const blockEnd = this.ends[blockIndex];
    if (blockStart === undefined || blockEnd === undefined || blockStart < 0) return false;

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
    const caret = this.caretOffset(
      sub?.element ?? this.unitElement(blockIndex),
      source,
      clientX,
      clientY,
    );

    const withSlot = [...this.view.blocks];
    withSlot[blockIndex] = SLOT_HTML;
    return this.open({
      blockIndex,
      startLine,
      endLine,
      source,
      originalHtml: this.view.blocks[blockIndex] ?? '',
      withSlot,
      caret,
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
    const lines = this.body.split('\n');
    const blank = this.body.trim() === '';
    const startLine = blank ? 0 : lines.length;
    const endLine = lines.length - 1;
    // 末尾に SLOT を 1 つ足す(戻すときは `originalHtml: ''` = 消える)
    return this.open({
      blockIndex: this.view.blocks.length,
      startLine,
      endLine,
      source: '',
      originalHtml: '',
      withSlot: [...this.view.blocks, SLOT_HTML],
      caret: 0,
    });
  }

  /** 差し替え / 挿入の共通部分(入力欄を出して契約を張る)。 */
  private open(o: {
    blockIndex: number;
    startLine: number;
    endLine: number;
    source: string;
    originalHtml: string;
    withSlot: readonly string[];
    caret: number;
  }): boolean {
    const r = applyBlocks(this.host, o.withSlot.join(''), this.view, [o.blockIndex]);
    this.view = r.view;
    const slot = this.host.querySelector<HTMLElement>('[data-pkc-row-slot]');
    if (slot === null) return false;

    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'row-source');
    ta.value = o.source;
    // ⚠ 高さは中身に合わせる(1 行の編集で 10 行ぶんの箱が出ない)
    ta.rows = Math.max(1, o.source.split('\n').length);
    slot.append(ta);

    this.active = {
      blockIndex: o.blockIndex,
      startLine: o.startLine,
      endLine: o.endLine,
      source: o.source,
      originalHtml: o.originalHtml,
      slot,
      textarea: ta,
      composing: false,
      pendingCommit: false,
      held: null,
    };
    this.wire(ta);
    ta.focus();
    ta.setSelectionRange(o.caret, o.caret);
    this.syncActiveBox();
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
      if (ke.key === 'Escape') {
        ev.preventDefault();
        this.cancelActive();
        return;
      }
      if (ke.key === 'Tab' || (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey))) {
        ev.preventDefault();
        this.commitActive();
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
    // 高さは中身に合わせる(属性だけ ── 封印中に呼ばれても composition は壊れない)
    a.textarea.rows = Math.max(1, a.textarea.value.split('\n').length);
    const open = findOpenEnds(a.textarea.value);
    const block = open.find((o) => o.kind !== 'inline') ?? open[0];
    if (block === undefined) a.slot.removeAttribute('data-pkc-open-end');
    else a.slot.setAttribute('data-pkc-open-end', block.kind);
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
    insertText(ta, pair.insert);
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
function insertText(ta: HTMLTextAreaElement, text: string): void {
  const doc = ta.ownerDocument as Document & {
    execCommand?: (cmd: string, ui?: boolean, value?: string) => boolean;
  };
  const ok = doc.execCommand?.('insertText', false, text) ?? false;
  if (ok) return;
  // fallback(happy-dom など execCommand が無い環境)。⚠ 挙動を合わせるだけ
  const { selectionStart: s, selectionEnd: e, value } = ta;
  ta.value = value.slice(0, s ?? 0) + text + value.slice(e ?? 0);
}
