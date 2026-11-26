/**
 * 🔴 **リッチ編集セル**(v4.0 Phase 1 / PR-05・PR-06。ビジョン 4-A / 4-B。設定「編集の仕方」= リッチ編集)。
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
import { createRichHistory, pushRich, redoRich, undoRich, type RichHistory, type RichSnap } from '@features/markdown/rich-history';
import {
  applyRichInsert,
  filterRichInsert,
  RICH_INSERT_ITEMS,
  slashQueryOf,
  type RichInsertId,
  type RichInsertItem,
} from '@features/markdown/rich-insert';
import type { KeymapStore } from './keymap';
import { attachKeepFocusNav, closeContextMenu, contextMenuOpen, menuNavItems, openContextMenu, type MenuItem } from './context-menu';

/** セルの印(`data-pkc-field`)。⚠ 控える側(`main.ts`)・書式の帯(`binder.ts`)と同じ字を使う(§7)。 */
export const RICH_CELL_FIELD = 'rich-cell';
/** 「原文」ボタンの印(binder の `data-pkc-action` を持たない ── セルの持ち主がその場で受ける)。 */
export const RICH_SOURCE_BUTTON_ATTR = 'data-pkc-rich-source';
/** チェックリストの印の箱(セルの外。押すと印が切り替わる)。 */
export const RICH_CHECK_ATTR = 'data-pkc-rich-check';
/** 「+」(ブロックの挿入の一覧を開く)ボタンの印。 */
export const RICH_INSERT_BUTTON_ATTR = 'data-pkc-rich-insert-open';
/**
 * 挿入の一覧の項目の押し所(`data-pkc-action`)。⚠ 受け手は binder の 1 本(`ACTIONS`)── 一覧の側に実行の口を作らない。
 * 項目の id は {@link RICH_INSERT_ID_ATTR}、`/` で開いたかは {@link RICH_INSERT_SLASH_ATTR} が運ぶ。
 */
export const RICH_INSERT_ACTION = 'rich-insert-block';
export const RICH_INSERT_ID_ATTR = 'data-pkc-rich-insert';
export const RICH_INSERT_SLASH_ATTR = 'data-pkc-rich-slash';
/** 打った字を 1 手にまとめる間(打つ手がこの時間止まったら 1 件記録する)。 */
const TYPING_CHUNK_MS = 600;

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
  /** 🔴 ブロックを上下のブロックと入れ替える(`Alt+↑` / `Alt+↓`。PR-06)。 */
  moveBlock(dir: -1 | 1): void;
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
  /** 🔴 セルの中の取り消し / やり直しの履歴(PR-06。規則は `rich-history.ts`)。 */
  private history: RichHistory;
  /** 打った字をまとめている間の timer(止まったら 1 件記録)。 */
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  /** 🔴 挿入の一覧が開いているか(`slash` = `/` で開いた ── 打った字で絞り込み、選ぶと `/…` を消す)。 */
  private insertMenu: { slash: boolean; el: HTMLElement; detach: () => void } | null = null;

  private constructor(doc: Document, source: string, meta: RichBlockMeta, nodes: DocumentFragment, private readonly hooks: RichCellHooks) {
    this.doc = doc;
    this.source = source;
    this.meta = meta;
    this.wrap = doc.createElement('div');
    this.wrap.setAttribute('data-pkc-rich-wrap', '');
    this.cell = this.build(nodes);
    this.history = createRichHistory({ markdown: source, start: source.length, end: source.length });
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
    /**
     * 🔴 **「+」── ブロックの挿入の一覧**(PR-06)。`/` を打たなくても同じ一覧が出る(マウスだけで完結)。
     * ⚠ 押しても焦点を奪わない(奪うとセルが確定して閉じ、当てる先が消える)。
     */
    const plus = doc.createElement('button');
    plus.type = 'button';
    plus.setAttribute(RICH_INSERT_BUTTON_ATTR, '');
    plus.textContent = '+';
    plus.title = 'ブロックを挿入する(見出し・リスト・表・コードブロックなど。空の段落で / を打っても開きます)';
    plus.setAttribute('aria-label', 'ブロックを挿入する');
    plus.addEventListener('mousedown', (ev) => ev.preventDefault());
    plus.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (this.insertMenu !== null) this.closeInsertMenu();
      else this.openInsertMenu(false, RICH_INSERT_ITEMS);
    });
    this.wrap.append(plus);
    CELLS.set(cell, this);
    this.wire(cell);
    this.cell = cell;
    return cell;
  }

  /** 後片付け(聞き耳を止める)。⚠ 外す前に呼ぶ ── 焦点のあるセルを外すと同期で blur が来る。 */
  dispose(): void {
    this.disposed = true;
    if (this.typingTimer !== null) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    this.closeInsertMenu();
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
    // 🔴 当てる前の形を 1 件にする(打ちかけの字もここで区切る ── 書式の直後の Ctrl+Z で、当てる前へ戻る)
    this.recordNow();
    const cur = this.sourceSelection();
    const next = fn(cur);
    if (next.text === cur.text) {
      // 断った・変わらない ── 選択だけ戻す
      this.cell.focus();
      this.setSourceSelection(next.start, next.end);
      return;
    }
    // 🔴 当てた後の形も 1 件(やり直しの行き先)。⚠ 原文の編集へ移ったら記録しない(セルは閉じた)
    if (this.reload(next.text, next.start, next.end)) this.record({ markdown: next.text, start: next.start, end: next.end });
  }

  // ── 🔴 セルの中の取り消し / やり直し(PR-06) ─────────────────────────

  /** 1 件記録する(履歴の規則は `pushRich` の 1 本)。 */
  private record(snap: RichSnap): void {
    this.history = pushRich(this.history, snap);
  }

  /**
   * いまの形を 1 件記録する(打ちかけの字を区切る)。⚠ 変換中は**何もしない**(DOM も読まない ── 契約)。
   */
  private recordNow(): void {
    if (this.typingTimer !== null) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.disposed || this.hooks.isComposing()) return;
    const s = this.sourceSelection();
    this.record({ markdown: s.text, start: s.start, end: s.end });
  }

  /** 打った字 ── 打つ手が止まったら 1 件にまとめる。 */
  private scheduleTyping(): void {
    if (this.typingTimer !== null) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      if (!this.disposed) this.recordNow();
    }, TYPING_CHUNK_MS);
  }

  /** 履歴の 1 件をセルへ戻す(DOM と caret を組み直す)。 */
  private restoreSnap(snap: RichSnap): void {
    this.reload(snap.markdown, snap.start, snap.end);
  }

  /**
   * 🔴 **セルの中で 1 つ取り消す**。
   * @returns 取り消せたか。⚠ `false`(セルの履歴の先頭)なら、呼び側はブロックを跨ぐ取り消しへ譲る
   */
  undo(): boolean {
    if (this.disposed || this.hooks.isComposing()) return false;
    this.recordNow();
    const r = undoRich(this.history);
    if (r === null) return false;
    this.history = r.history;
    this.restoreSnap(r.snap);
    return true;
  }

  /** 🔴 セルの中で 1 つやり直す。@returns やり直せたか */
  redo(): boolean {
    if (this.disposed || this.hooks.isComposing()) return false;
    this.recordNow();
    const r = redoRich(this.history);
    if (r === null) return false;
    this.history = r.history;
    this.restoreSnap(r.snap);
    return true;
  }

  /** test 用: 履歴の件数(戻せる手 / やり直せる手)。 */
  historyDepth(): { past: number; future: number } {
    return { past: this.history.past.length, future: this.history.future.length };
  }

  // ── 🔴 ブロックの挿入(`/` と「+」。PR-06) ───────────────────────────

  /** 挿入の一覧が開いているか。 */
  get insertMenuOpen(): boolean {
    return this.insertMenu !== null && this.insertMenu.el.isConnected;
  }

  /**
   * 一覧を開く(開いていれば項目を差し替える)。⚠ 焦点はセルに残す(`keepFocus`)──
   * ↑ ↓ で項目を選び Enter で押せる(`attachKeepFocusNav`)。Esc は一覧だけを閉じる(binder の `onMenuKey`)。
   */
  openInsertMenu(slash: boolean, items: readonly RichInsertItem[]): void {
    const root = this.cell.closest<HTMLElement>('[data-pkc-slot="root"]');
    if (root === null || this.disposed) return;
    if (items.length === 0) {
      this.closeInsertMenu();
      return;
    }
    this.insertMenu?.detach();
    const menuItems: MenuItem[] = items.map((it) => ({
      action: RICH_INSERT_ACTION,
      label: it.label,
      hint: it.hint,
      attrs: { [RICH_INSERT_ID_ATTR]: it.id, [RICH_INSERT_SLASH_ATTR]: slash ? '1' : '0' },
    }));
    const r = this.cell.getBoundingClientRect();
    const opened = openContextMenu(root, { x: r.left, y: r.bottom }, menuItems, this.cell, {}, { keepFocus: true });
    if (opened === null) {
      this.insertMenu = null;
      return;
    }
    opened.el.setAttribute('data-pkc-rich-insert-menu', slash ? 'slash' : 'button');
    this.insertMenu = { slash, el: opened.el, detach: attachKeepFocusNav(root, opened.el, this.cell) };
  }

  /** 一覧を閉じる(自分が開いた一覧が残っているときだけ)。 */
  closeInsertMenu(): void {
    const m = this.insertMenu;
    if (m === null) return;
    this.insertMenu = null;
    m.detach();
    if (m.el.isConnected) {
      const root = m.el.parentElement;
      if (root !== null) closeContextMenu(root);
    }
  }

  /**
   * `/` の一覧を開く・絞る・閉じる(打った字が確定したあとに呼ぶ)。
   * ⚠ 変換中は呼ばれない(`input` の `isComposing` と封印で止める)── 確定してから見る。
   */
  private syncSlash(): void {
    if (this.disposed || this.hooks.isComposing()) return;
    const text = (this.cell.textContent ?? '').replace(/\u200b/g, '');
    const q = this.meta.kind === 'paragraph' ? slashQueryOf(text) : null;
    if (this.insertMenu !== null && !this.insertMenu.el.isConnected) this.closeInsertMenu();
    if (q === null) {
      if (this.insertMenu?.slash === true) this.closeInsertMenu();
      return;
    }
    // ⚠ 開くのは「空の段落で / を打った」ときだけ(`/` 1 字)。一覧が出ている間は打った字で絞る
    if (this.insertMenu === null && q !== '') return;
    if (this.insertMenu !== null && !this.insertMenu.slash) return;
    this.openInsertMenu(true, filterRichInsert(q));
  }

  /**
   * 🔴 **一覧の項目を当てる**(binder の `rich-insert-block` から)。
   * - 種類を変える項目 → いまのセルの枠を変えてリッチ編集を続ける。
   * - 差し込む項目 → テンプレートを入れて原文の編集へ移る(リッチでは表せない)。
   */
  insertBlock(id: RichInsertId, slash: boolean): void {
    if (this.disposed || this.hooks.isComposing()) return;
    this.closeInsertMenu();
    this.recordNow();
    const cur = this.sourceSelection();
    const res = applyRichInsert(id, cur.text, slash);
    // ⚠ 当てたのに変わらない形にはしない ── 綴り直しを要する
    this.dirty = true;
    if (res.mode === 'source') {
      this.hooks.toSource(res.text, res.start, res.end);
      return;
    }
    if (this.reload(res.text, res.start, res.end)) this.record({ markdown: res.text, start: res.start, end: res.end });
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
      if (!live()) return;
      h.compositionEnd();
      // 🔴 変換の確定を 1 手として記録し、`／` の確定なら一覧を開く(封印が解けた後だけ ── 変換中は何も読まない)
      if (!h.isComposing()) {
        this.recordNow();
        this.syncSlash();
      }
    });
    // ⚠ 打っただけでは DOM に触らない(旗を立てるだけ ── 変換中に来ても壊れない)
    cell.addEventListener('input', (ev) => {
      if (!live()) return;
      this.dirty = true;
      // 🔴 変換中は記録も一覧も触らない(確定は compositionend で拾う)
      if ((ev as InputEvent).isComposing || h.isComposing()) return;
      this.scheduleTyping();
      this.syncSlash();
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
      // 🔴 メニューの「元に戻す / やり直し」なども自前の履歴へ(ブラウザの履歴は組み直しで切れている)
      if (t === 'historyUndo' || t === 'historyRedo') {
        ev.preventDefault();
        if (t === 'historyUndo') this.undo();
        else this.redo();
        return;
      }
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
      /**
       * 🔴 **セルの中の取り消し / やり直し**(PR-06)。鍵は 1 画面の取り消しと同じ表(`live` の `undo` / `redo`)。
       * セルの履歴で戻せたら、ここで止める(ブロックを跨ぐ取り消しへ流さない)。先頭まで戻り切ったら
       * 素通しする ── 文書の聞き手(`detail.ts`)がブロックを跨ぐ取り消し(`edit-journal`)を当てる。
       */
      const liveCmd = h.keymap.match(ke, 'live');
      if (liveCmd === 'undo' || liveCmd === 'redo') {
        if (liveCmd === 'undo' ? this.undo() : this.redo()) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        return;
      }
      if (ke.key === 'Enter' && plain && !ke.shiftKey) {
        ev.preventDefault();
        // 🔴 挿入の一覧が出ていて強調が無いときの Enter は先頭の項目を押す(強調があれば `attachKeepFocusNav` が先に押す)
        if (this.insertMenuOpen) {
          menuNavItems(this.insertMenu!.el)[0]?.click();
          return;
        }
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
      // 🔴 ブロックを上下のブロックと入れ替える(行の欄の「行を上へ / 下へ動かす」と同じ鍵。セルの 1 行 = 1 ブロック)
      if (cmd === 'move-line-up' || cmd === 'move-line-down') {
        ev.preventDefault();
        this.recordNow();
        h.moveBlock(cmd === 'move-line-up' ? -1 : 1);
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
