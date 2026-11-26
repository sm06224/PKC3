/**
 * 🔴 **リッチ編集セル**(v4.0 Phase 1 / PR-05。ビジョン 4-A。フラグ `editor.rich`)。
 *
 * 1 画面編集(`row-swap.ts`)で押したブロックが**安全な単純ブロック**なら、原文の `<textarea>` の代わりに
 * 記号を隠した `contenteditable` を置く。保存の正本は**プレーンな PKC-Markdown のまま** ──
 * 確定のたびに `serializeRichBlock`(`features/markdown/rich-block.ts`)で綴り直し、行の範囲だけを書き戻す。
 *
 * ## 🔴 原本不変(最優先)
 * - 開けるのは「本物の描き手で描く → 綴り直す」が**原文と 1 バイトも違わない**ブロックだけ(`prepareRichBlock`)。
 * - 何も変えずに閉じたら(`dirty === false`)原文をそのまま返す ── 綴り直さない(呼び側は `commit` を呼ばない)。
 * - 表せない操作(揃え・表・コード …)は**原文の編集へ切り替えて**適用する(壊さない)。
 *
 * ## 🔴 日本語入力の契約(`row-swap.ts` 冒頭の契約をそのまま継ぐ)
 * - `compositionstart` 〜 `compositionend` の間は、DOM の置き換え・正規化・綴り直し・焦点の移動を**一切しない**。
 *   封印の旗は `RowSwap` の活性(`Active.composing`)が 1 つだけ持つ(2 か所に置かない)。
 * - 変換中の `blur` は同期で確定しない(`RowSwap.commitActive` が `pendingCommit` に回す)。
 * - 安全弁: 変換中なのに焦点が外れたら封印を解く(`focusout`)。
 * - キー(Enter / Escape / Tab …)は `isComposing` / `keyCode 229` の間は何もしない(全部 IME のもの)。
 *
 * ⚠ ここは adapter 層。セルは**窓**に過ぎず、本文の正本は `AppState.openBody.body`。
 */
import { renderMarkdown } from '@features/markdown/markdown-render';
import {
  prepareRichBlock,
  richContentStart,
  serializeRichBlockWithPoints,
  serializeRichInline,
  type RichBlockMeta,
  type RichPoint,
} from '@features/markdown/rich-block';
import type { TextSelection } from '@features/markdown/text-ops';
import type { KeymapStore } from './keymap';
import { contextMenuOpen } from './context-menu';

/** セルの印(`data-pkc-field`)。⚠ 控える側(`main.ts`)・書式の帯(`binder.ts`)と同じ字を使う(§7)。 */
export const RICH_CELL_FIELD = 'rich-cell';
/** 「原文」ボタンの印(binder の `data-pkc-action` を持たない ── セルの持ち主がその場で受ける)。 */
export const RICH_SOURCE_BUTTON_ATTR = 'data-pkc-rich-source';
/** チェックリストの印の箱(セルの外。押すと印が切り替わる)。 */
export const RICH_CHECK_ATTR = 'data-pkc-rich-check';

/** 本物の描き手(セルに入れる木はこれで作る ── 自前の構文解析を持たない)。 */
export function richRenderHtml(md: string): string {
  return renderMarkdown(md, {});
}

/** HTML → 木(同じ文書の `<template>` で読む。スクリプトは走らない)。 */
export function richParseDom(doc: Document): (html: string) => Element {
  return (html: string) => {
    const t = doc.createElement('template');
    t.innerHTML = html;
    const div = doc.createElement('div');
    div.append(t.content);
    return div;
  };
}

/** Enter で割った結果(caret の前と後ろ。どちらも行内の Markdown)。 */
export interface RichSplit {
  readonly head: string;
  readonly tail: string;
}

/** セルの持ち主(`RowSwap`)へ渡す口。⚠ 確定・封印・切替の規則は持ち主の 1 か所にある。 */
export interface RichCellHooks {
  compositionStart(): void;
  compositionEnd(): void;
  isComposing(): boolean;
  /** 確定して閉じる(blur / Escape / Tab)。`save` は Ctrl+S / Ctrl+Enter(ノートも保存)。 */
  commit(save: boolean): void;
  /** Enter。caret の前後で割ったもの。 */
  enter(split: RichSplit): void;
  /** 原文の `<textarea>` へ切り替える(`text` はブロックの原文、`start`/`end` は選択)。 */
  toSource(text: string, start: number, end: number): void;
  /** ↑ / ↓ の既定が動いた後、端に居たか。 */
  boundary(dir: 'up' | 'down', atEdge: boolean): void;
  /** 安全弁(変換中なのに焦点が外れた)。 */
  unseal(): void;
  /** 押せない・表せないときの知らせ。 */
  notify(message: string): void;
  readonly keymap: KeymapStore;
}

/** セル → 持ち主(binder が書式の帯から引く)。 */
const CELLS = new WeakMap<Element, RichCell>();

/** その要素(セル自身か中の子)が属するリッチ編集セル。 */
export function richCellOf(el: unknown): RichCell | null {
  if (!(el instanceof Element)) return null;
  const cell = el.closest(`[data-pkc-field="${RICH_CELL_FIELD}"]`);
  return cell === null ? null : (CELLS.get(cell) ?? null);
}

/** 面の中で開いているリッチ編集セル(書式の帯の書き込む先)。 */
export function activeRichCell(root: ParentNode): RichCell | null {
  const cell = root.querySelector(`[data-pkc-region="detail"] [data-pkc-field="${RICH_CELL_FIELD}"]`);
  return cell === null ? null : (CELLS.get(cell) ?? null);
}

const KIND_LABEL: Readonly<Record<RichBlockMeta['kind'], string>> = {
  paragraph: 'この段落',
  heading: 'この見出し',
  quote: 'この引用',
  'list-item': 'この項目',
};

export class RichCell {
  /** セルを包む要素(スロットに入るのはこれ)。 */
  readonly wrap: HTMLElement;
  /** `contenteditable` の本体。 */
  cell: HTMLElement;
  meta: RichBlockMeta;
  /** 開いた時のブロックの原文(LF)。 */
  readonly source: string;
  /** 打った・書式を当てた(= 綴り直す必要がある)。⚠ false のあいだは原文を 1 バイトも変えない。 */
  dirty = false;
  private disposed = false;
  /** 枠を組み直している最中(外したセルの blur を確定に数えない)。 */
  private rebuilding = false;
  private readonly doc: Document;

  private constructor(doc: Document, source: string, meta: RichBlockMeta, nodes: DocumentFragment, private readonly hooks: RichCellHooks) {
    this.doc = doc;
    this.source = source;
    this.meta = meta;
    this.wrap = doc.createElement('div');
    this.wrap.setAttribute('data-pkc-rich-wrap', '');
    this.cell = this.build(nodes);
  }

  /**
   * 開けるなら作る(開けなければ `null` = 原文の `<textarea>` で開く)。
   * ⚠ 判定は `prepareRichBlock` の 1 本(形 + 本物の描き手での往復の一致)。
   */
  static create(doc: Document, source: string, hooks: RichCellHooks): RichCell | null {
    const p = prepareRichBlock(source, richRenderHtml, richParseDom(doc));
    if (p === null) return null;
    const rc = new RichCell(doc, source, p.meta, p.nodes, hooks);
    return rc;
  }

  /** 枠(種類ごとの入れ物)とセルを組む。⚠ 開く時と、書式で種類が変わった時だけ呼ぶ(変換中は呼ばない)。 */
  private build(nodes: DocumentFragment): HTMLElement {
    const doc = this.doc;
    const meta = this.meta;
    // ⚠ 焦点のあるセルを外すと同期で blur が来る ── 組み直しの間は確定に数えない
    this.rebuilding = true;
    try {
      this.wrap.textContent = '';
    } finally {
      this.rebuilding = false;
    }
    this.wrap.setAttribute('data-pkc-rich-kind', meta.kind);
    if (meta.kind === 'heading') this.wrap.setAttribute('data-pkc-rich-level', String(meta.level));
    else this.wrap.removeAttribute('data-pkc-rich-level');
    // 見出しは見出しの要素で組む(本文の見出しと同じ字の大きさで編集できる)
    const cell = doc.createElement(meta.kind === 'heading' ? `h${meta.level}` : 'div');
    cell.setAttribute('contenteditable', 'true');
    cell.setAttribute('data-pkc-field', RICH_CELL_FIELD);
    cell.setAttribute('role', 'textbox');
    cell.setAttribute('aria-multiline', meta.kind === 'heading' ? 'false' : 'true');
    cell.setAttribute('aria-label', `${KIND_LABEL[meta.kind]}を編集(記号を隠して表示)`);
    cell.setAttribute('spellcheck', 'false');
    cell.append(nodes);
    // 末尾が <br> なら番兵を足す(最後の空の行に caret を置けるように ── 綴り直しでは落ちる)
    if (cell.lastChild?.nodeName === 'BR') cell.append(doc.createElement('br'));
    if (meta.checked !== null) {
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = meta.checked !== ' ';
      box.setAttribute(RICH_CHECK_ATTR, '');
      box.setAttribute('aria-label', '完了のチェック');
      box.addEventListener('mousedown', (ev) => ev.preventDefault());
      box.addEventListener('change', () => {
        if (this.disposed) return;
        this.meta = { ...this.meta, checked: box.checked ? 'x' : ' ' };
        this.dirty = true;
        this.cell.focus();
      });
      this.wrap.append(box);
    }
    if (meta.kind === 'quote') {
      const bq = doc.createElement('blockquote');
      bq.append(cell);
      this.wrap.append(bq);
    } else {
      this.wrap.append(cell);
    }
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.setAttribute(RICH_SOURCE_BUTTON_ATTR, '');
    btn.textContent = '原文';
    btn.title = 'このブロックを Markdown の原文で編集する(Alt+M)';
    // ⚠ 押しても焦点を奪わない(奪うと blur が確定して閉じ、切り替える相手が消える)
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.toSource();
    });
    this.wrap.append(btn);
    CELLS.set(cell, this);
    this.wire(cell);
    this.cell = cell;
    return cell;
  }

  /** 後片付け(聞き耳を止める)。⚠ 外す前に呼ぶ ── 焦点のあるセルを外すと同期で blur が来る。 */
  dispose(): void {
    this.disposed = true;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 焦点を置く(caret は末尾 or 先頭)。 */
  focus(at: 'start' | 'end' | number = 'end'): void {
    this.cell.focus();
    if (typeof at === 'number') this.setSourceSelection(at, at);
    else this.placeCaret(at);
  }

  /** いまの中身のブロックの原文。⚠ 変えていなければ開いた時の原文そのもの(綴り直さない)。 */
  currentSource(): string {
    if (!this.dirty) return this.source;
    return serializeRichBlockWithPoints(this.meta, this.cell, []).text;
  }

  /** 選択の端 → ブロックの原文の位置(選択がセルの外なら末尾)。 */
  sourceSelection(): { text: string; start: number; end: number } {
    const pts = this.selectionPoints();
    const r = serializeRichBlockWithPoints(this.meta, this.cell, pts ?? []);
    const text = this.dirty ? r.text : this.source;
    if (pts === null) return { text, start: text.length, end: text.length };
    // ⚠ 変えていないなら原文と綴りは同じ(開く条件)── 位置はそのまま使える
    return { text, start: r.offsets[0]!, end: r.offsets[1]! };
  }

  private selectionPoints(): RichPoint[] | null {
    const sel = this.doc.getSelection();
    if (sel === null || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!this.cell.contains(r.startContainer) || !this.cell.contains(r.endContainer)) return null;
    return [
      { node: r.startContainer, offset: r.startOffset },
      { node: r.endContainer, offset: r.endOffset },
    ];
  }

  /**
   * 🔴 **書式の帯・鍵の書式を当てる**(太字・見出し・文字色 …)。
   *
   * 「綴り直す → 既存の規則(`applyFormat` / `applyTextColor` の 1 本)を当てる → 描き直す」。
   * ⚠ 規則を DOM 側に 2 本目書かない(既に太字なら外れる、などのトグルも規則の側が持つ)。
   * ⚠ 当てた結果をリッチで表せない(揃え・表・コードブロック …)なら、**原文の編集へ切り替えて**結果を渡す。
   * ⚠ 変換中は何もしない(DOM を置き換えると変換が壊れる)。
   */
  applyEdit(fn: (sel: TextSelection) => TextSelection): void {
    if (this.disposed || this.hooks.isComposing()) return;
    const cur = this.sourceSelection();
    const next = fn(cur);
    if (next.text === cur.text) {
      // 断った・変わらない ── 選択だけ戻す
      this.cell.focus();
      this.setSourceSelection(next.start, next.end);
      return;
    }
    this.reload(next.text, next.start, next.end);
  }

  /**
   * ブロックの原文を入れ直す(表せなければ原文の編集へ)。
   * @returns リッチのまま入れ直せたか
   */
  reload(text: string, start: number, end: number): boolean {
    const p = prepareRichBlock(text, richRenderHtml, richParseDom(this.doc));
    if (p === null) {
      this.hooks.toSource(text, start, end);
      return false;
    }
    const kindChanged = p.meta.kind !== this.meta.kind || p.meta.level !== this.meta.level || (p.meta.checked === null) !== (this.meta.checked === null);
    this.meta = p.meta;
    this.dirty = text !== this.source;
    if (kindChanged) {
      // 種類が変わった(見出し ↔ 段落など)── 枠ごと組み直す
      CELLS.delete(this.cell);
      this.build(p.nodes);
    } else {
      this.cell.textContent = '';
      this.cell.append(p.nodes);
      if (this.cell.lastChild?.nodeName === 'BR') this.cell.append(this.doc.createElement('br'));
      const box = this.wrap.querySelector<HTMLInputElement>(`[${RICH_CHECK_ATTR}]`);
      if (box !== null && p.meta.checked !== null) box.checked = p.meta.checked !== ' ';
    }
    this.cell.focus();
    this.setSourceSelection(start, end);
    return true;
  }

  /** 原文の位置 → セルの中の点(中身の字だけを数える。記号の中の位置は近い字へ寄せる)。 */
  private setSourceSelection(start: number, end: number): void {
    const a = this.pointForSource(start);
    const b = this.pointForSource(end);
    const sel = this.doc.getSelection();
    if (sel === null || a === null || b === null) return;
    const r = this.doc.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /**
   * ブロックの原文の位置に当たる DOM の点。全部の字の切れ目を綴り直して位置を比べる
   * (セルの中身は 1 ブロックぶんなので数は小さい)。⚠ 記号の内側の位置は、その後ろの最初の字の切れ目へ寄せる。
   */
  private pointForSource(at: number): RichPoint | null {
    const cands: RichPoint[] = [];
    const walk = (n: Node): void => {
      if (n.nodeType === 3) {
        const len = (n.nodeValue ?? '').length;
        for (let i = 0; i <= len; i += 1) cands.push({ node: n, offset: i });
        return;
      }
      for (let i = 0; i < n.childNodes.length; i += 1) {
        if (n.childNodes[i]!.nodeType !== 3) cands.push({ node: n, offset: i });
        walk(n.childNodes[i]!);
      }
      if (n.childNodes.length === 0 || n.lastChild?.nodeType !== 3) cands.push({ node: n, offset: n.childNodes.length });
    };
    walk(this.cell);
    if (cands.length === 0) return { node: this.cell, offset: 0 };
    const offs = serializeRichBlockWithPoints(this.meta, this.cell, cands).offsets;
    const floor = richContentStart(this.meta);
    const target = Math.max(at, floor);
    let best = -1;
    for (let i = 0; i < cands.length; i += 1) {
      if (offs[i]! >= target && (best === -1 || offs[i]! < offs[best]!)) best = i;
    }
    if (best === -1) {
      for (let i = 0; i < cands.length; i += 1) if (best === -1 || offs[i]! >= offs[best]!) best = i;
    }
    return cands[best] ?? null;
  }

  private placeCaret(at: 'start' | 'end'): void {
    const sel = this.doc.getSelection();
    if (sel === null) return;
    const r = this.doc.createRange();
    r.selectNodeContents(this.cell);
    r.collapse(at === 'start');
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 原文の `<textarea>` へ切り替える(打った内容と caret を持って行く)。⚠ 変換中は何もしない。 */
  toSource(): void {
    if (this.disposed || this.hooks.isComposing()) return;
    const s = this.sourceSelection();
    this.hooks.toSource(s.text, s.start, s.end);
  }

  /** caret の前後で割る(選んでいれば、選んだ字は捨てる)。⚠ DOM は変えない(写しを読むだけ)。 */
  private split(): RichSplit {
    const sel = this.doc.getSelection();
    const all = this.doc.createRange();
    all.selectNodeContents(this.cell);
    let startNode: Node = this.cell;
    let startOff = this.cell.childNodes.length;
    let endNode: Node = this.cell;
    let endOff = this.cell.childNodes.length;
    if (sel !== null && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (this.cell.contains(r.startContainer) && this.cell.contains(r.endContainer)) {
        startNode = r.startContainer;
        startOff = r.startOffset;
        endNode = r.endContainer;
        endOff = r.endOffset;
      }
    }
    const headR = this.doc.createRange();
    headR.setStart(this.cell, 0);
    headR.setEnd(startNode, startOff);
    const tailR = this.doc.createRange();
    tailR.setStart(endNode, endOff);
    tailR.setEnd(this.cell, this.cell.childNodes.length);
    const opts = { listContent: this.meta.kind === 'list-item', heading: this.meta.kind === 'heading' };
    return {
      head: serializeRichInline(headR.cloneContents(), [], opts).text,
      tail: serializeRichInline(tailR.cloneContents(), [], { listContent: false, heading: false }).text,
    };
  }

  /** caret の位置に、字と改行(`<br>`)を入れる(貼り付け・Shift+Enter)。⚠ 素の字だけ ── 外の HTML は入れない。 */
  private insertPlain(text: string): void {
    const sel = this.doc.getSelection();
    if (sel === null || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!this.cell.contains(r.startContainer)) return;
    r.deleteContents();
    const frag = this.doc.createDocumentFragment();
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    // ⚠ 見出しは 1 行(改行は空白にする)
    const lines = this.meta.kind === 'heading' ? [parts.join(' ')] : parts;
    let last: Node | null = null;
    lines.forEach((line, i) => {
      if (i > 0) {
        last = this.doc.createElement('br');
        frag.append(last);
      }
      if (line !== '') {
        last = this.doc.createTextNode(line);
        frag.append(last);
      }
    });
    if (last === null) return;
    const lastNode: Node = last;
    r.insertNode(frag);
    // 最後が <br> で、その後ろに何も無ければ番兵を足す(新しい行に caret を置けるように)
    if (lastNode.nodeName === 'BR' && lastNode.nextSibling === null) lastNode.parentNode?.appendChild(this.doc.createElement('br'));
    const after = this.doc.createRange();
    if (lastNode.nodeType === 3) after.setStart(lastNode, (lastNode.nodeValue ?? '').length);
    else after.setStartAfter(lastNode);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    this.dirty = true;
  }

  /** caret が端に居るか(↑ は先頭、↓ は末尾)。 */
  private atEdge(dir: 'up' | 'down'): boolean {
    const sel = this.doc.getSelection();
    if (sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!this.cell.contains(r.startContainer)) return false;
    const probe = this.doc.createRange();
    if (dir === 'up') {
      probe.setStart(this.cell, 0);
      probe.setEnd(r.startContainer, r.startOffset);
    } else {
      probe.setStart(r.startContainer, r.startOffset);
      probe.setEnd(this.cell, this.cell.childNodes.length);
    }
    return probe.toString().replace(/[\u200b\n]/g, '') === '';
  }

  /** セルに契約を張る(IME / 確定 / Enter / 貼り付け)。 */
  private wire(cell: HTMLElement): void {
    const h = this.hooks;
    const live = (): boolean => !this.disposed && !this.rebuilding && this.cell === cell;
    cell.addEventListener('compositionstart', () => {
      if (live()) h.compositionStart();
    });
    cell.addEventListener('compositionend', () => {
      if (live()) h.compositionEnd();
    });
    // ⚠ 打っただけでは DOM に触らない(旗を立てるだけ ── 変換中に来ても壊れない)
    cell.addEventListener('input', () => {
      if (live()) this.dirty = true;
    });
    /**
     * 🔴 **ブラウザ自前の書式(Ctrl+B の既定など)と、段落の自動挿入を止める**。
     * ⚠ 書式は帯・鍵の 1 本(`applyEdit`)を通す ── ブラウザの `<b>` や `<div>` が混ざると綴りが揺れる。
     * ⚠ 変換中の入力は止めない(`isComposing`)。
     */
    cell.addEventListener('beforeinput', (ev) => {
      if (!live()) return;
      const ie = ev as InputEvent;
      if (ie.isComposing || h.isComposing()) return;
      const t = ie.inputType;
      if (t.startsWith('format') || t === 'insertFromDrop' || t === 'insertFromPaste') {
        ev.preventDefault();
        return;
      }
      if (t === 'insertParagraph') {
        // 鍵の Enter を経ずに来る段落の挿入(ソフトキーボードなど)は Enter と同じ
        ev.preventDefault();
        h.enter(this.split());
        return;
      }
      if (t === 'insertLineBreak') {
        ev.preventDefault();
        if (this.meta.kind !== 'heading') this.insertPlain('\n');
      }
    });
    cell.addEventListener('keydown', (ev) => {
      if (!live()) return;
      const ke = ev as KeyboardEvent;
      // ⚠ 変換中のキーは全部 IME のもの(Chrome は確定直後の keydown を keyCode 229 で送る)
      if (ke.isComposing || ke.keyCode === 229 || h.isComposing()) return;
      const plain = !ke.ctrlKey && !ke.metaKey && !ke.altKey;
      if (ke.key === 'Enter' && plain && !ke.shiftKey) {
        ev.preventDefault();
        h.enter(this.split());
        return;
      }
      if (ke.key === 'Enter' && plain && ke.shiftKey) {
        ev.preventDefault();
        // ブロックの中の改行(見出しは 1 行なので入れない)
        if (this.meta.kind !== 'heading') this.insertPlain('\n');
        return;
      }
      if (ke.key === 'Escape' && plain && !ke.shiftKey) {
        // 一覧(「その他 ▾」など)が出ている間の Esc は一覧を閉じるだけ(1 回の Esc で 1 段)
        const appRoot = cell.closest<HTMLElement>('[data-pkc-slot="root"]');
        if (appRoot !== null && contextMenuOpen(appRoot)) return;
        ev.preventDefault();
        h.commit(false);
        return;
      }
      const cmd = h.keymap.match(ke, 'row');
      if (cmd === 'row-rich-source') {
        ev.preventDefault();
        this.toSource();
        return;
      }
      if (cmd === 'row-commit') {
        ev.preventDefault();
        h.commit(ke.ctrlKey || ke.metaKey);
        return;
      }
      if ((ke.key === 'ArrowUp' || ke.key === 'ArrowDown') && plain && !ke.shiftKey) {
        const dir = ke.key === 'ArrowUp' ? 'up' : 'down';
        // ⚠ 既定を動かした後で端に居たかを見る(折り返しの行でも正しく分かる。row-swap と同じ見方)
        setTimeout(() => {
          if (live()) h.boundary(dir, this.atEdge(dir));
        }, 0);
      }
    });
    /**
     * 🔴 **貼り付けは素の字だけ**(外の HTML・CSS・`<script>` を入れない)。
     */
    cell.addEventListener('paste', (ev) => {
      if (!live()) return;
      ev.preventDefault();
      const text = (ev as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      if (text !== '') this.insertPlain(text);
    });
    cell.addEventListener('drop', (ev) => {
      if (live()) ev.preventDefault();
    });
    // セルの中のリンクは編集の対象 ── 押してもノートへ飛ばない
    cell.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t instanceof Element && t.closest('a') !== null) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    cell.addEventListener('blur', () => {
      if (!live()) return;
      // ウィンドウを離れただけなら閉じない(row-swap と同じ見分け方)
      const doc = cell.ownerDocument;
      if (doc.activeElement === cell && !doc.hasFocus()) return;
      h.commit(false);
    });
    cell.addEventListener('focusout', () => {
      if (live() && h.isComposing() && cell.ownerDocument.activeElement !== cell) h.unseal();
    });
  }
}
